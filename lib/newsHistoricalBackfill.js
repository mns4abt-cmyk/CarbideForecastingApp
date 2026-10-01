"use strict";

const crypto = require("crypto");
const { NewsEventStore } = require("./newsEventStore");
const { fetchConfiguredNewsSources } = require("./newsSources");
const { filterArticlesByRelevance } = require("./newsRelevance");
const { classifySequentialBatches, selectArticlesForClassification } = require("./newsClassifierProviders");
const { applyNewsClassification } = require("./newsClassificationApplication");
const { deduplicateEvents } = require("./newsEventDedup");
const { buildEventEvidence } = require("./newsEventEvidence");
const { persistValidatedEvents } = require("./newsEventPersistence");

const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoDate(pubDate) {
  const date = new Date(pubDate);
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function inWindow(article, { days, referenceTime }) {
  const timestamp = new Date(article.publishedAt).getTime();
  return Number.isNaN(timestamp) || timestamp >= new Date(referenceTime).getTime() - days * DAY_MS;
}

// This identity is intentionally independent of the model/cache schema. It
// identifies a source article that already passed validation and persistence.
function articleFingerprint(article) {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: article?.title || "", snippet: article?.snippet || "", source: article?.source || "",
    sourceId: article?.sourceId || "", publishedAt: article?.publishedAt || article?.date || "",
  })).digest("hex");
}

function stableBackfillEventId(article) {
  return `event-${articleFingerprint(article).slice(0, 24)}`;
}

function storedArticleCandidate(event) {
  return {
    id: `stored-${event.eventKey || event.eventId}`,
    eventKey: event.eventKey,
    eventId: event.eventId,
    date: event.publishedAt || event.firstSeenAt,
    publishedAt: event.publishedAt || event.firstSeenAt,
    title: event.title,
    source: event.provenance?.source || "",
    sourceId: event.provenance?.sourceId || "",
    eventStage: event.eventStage,
    duplicateCount: event.duplicateCount || 1,
    relevanceScore: -1,
    persisted: true,
    articleFingerprints: event.provenance?.articleFingerprints || [],
  };
}

function loadPersistedCandidates({ databasePath, createStore = (options) => new NewsEventStore(options), logger = console } = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    return store.getAllEvents().map(storedArticleCandidate);
  } catch (error) {
    logger.warn("[NewsBackfill] Could not read stored event progress; continuing without durable skip:", error.message);
    return [];
  } finally {
    try { store?.close(); } catch { /* isolated cleanup */ }
  }
}

// Keep the production relevance/recency selection policy; historical mode
// simply visits each resulting selection window rather than stopping at 12.
function selectAllInRefreshWindows(items, maxPerRefresh) {
  const remaining = [...items];
  const selected = [];
  while (remaining.length) {
    const window = selectArticlesForClassification(remaining, maxPerRefresh);
    if (!window.length) break;
    selected.push(...window);
    const selectedIds = new Set(window.map((article) => article.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selectedIds.has(remaining[index].id)) remaining.splice(index, 1);
    }
  }
  return selected;
}

function emitProgress(callback, progress, article, status) {
  callback?.({ ...progress, status, article: { title: article.title, source: article.source, publishedAt: article.date } });
}

async function runHistoricalNewsBackfill({
  config,
  dependencies,
  provider,
  classificationCache,
  classifierVersion = "causal-v3",
  databasePath,
  days = 30,
  sourceLimit = 1000,
  maxPerRefresh = 12,
  batchSize = 1,
  maxArticles = null,
  referenceTime = new Date().toISOString(),
  fetchSources = fetchConfiguredNewsSources,
  relevanceFilter = filterArticlesByRelevance,
  classifyBatches = classifySequentialBatches,
  applyClassification = applyNewsClassification,
  deduplicate = deduplicateEvents,
  buildEvidence = buildEventEvidence,
  persist = persistValidatedEvents,
  loadPersisted = loadPersistedCandidates,
  onProgress,
  logger = console,
} = {}) {
  if (!config || !dependencies || !provider) throw new TypeError("config, dependencies, and provider are required");
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be a positive integer");
  if (!Number.isInteger(maxPerRefresh) || maxPerRefresh < 1) throw new RangeError("maxPerRefresh must be a positive integer");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("batchSize must be a positive integer");
  if (maxArticles !== null && (!Number.isInteger(maxArticles) || maxArticles < 1)) throw new RangeError("maxArticles must be a positive integer or null");

  const { articles, health } = await fetchSources(config, dependencies, { limit: sourceLimit });
  const filtered = relevanceFilter(articles);
  const relevantInWindow = filtered.accepted.filter((article) => inWindow(article, { days, referenceTime }));
  const normalized = relevantInWindow.map((article, index) => ({
    id: `backfill-${index + 1}`,
    date: toIsoDate(article.publishedAt),
    publishedAt: article.publishedAt,
    title: article.title,
    snippet: article.snippet,
    source: article.source,
    sourceId: article.sourceId,
    link: article.url,
    real: true,
    relevanceScore: article.relevance.score,
    relevanceReasons: article.relevance.reasons,
    matchedTerms: article.relevance.matchedTerms,
    matchedThemes: article.relevance.matchedThemes,
  }));
  const allSelected = selectAllInRefreshWindows(normalized, maxPerRefresh);
  const selected = maxArticles === null ? allSelected : allSelected.slice(0, maxArticles);
  const healthResult = await provider.health();
  const persistedCandidates = loadPersisted({ databasePath, logger });
  const persistedFingerprints = new Set(persistedCandidates.flatMap((event) => event.articleFingerprints || []));
  const progress = { processed: 0, classified: 0, cached: 0, skippedPersisted: 0, persisted: 0, inserted: 0, updated: 0, failures: 0, remaining: selected.length };
  const failureDetails = [];
  const classificationDurationsMs = [];
  const duplicateClusters = [];

  for (const article of selected) {
    progress.processed += 1;
    progress.remaining = selected.length - progress.processed;
    article.articleFingerprint = articleFingerprint(article);
    if (persistedFingerprints.has(article.articleFingerprint)) {
      progress.skippedPersisted += 1;
      emitProgress(onProgress, progress, article, "already_persisted");
      continue;
    }

    let rawClassification = classificationCache?.get(article) || null;
    let classificationDurationMs = null;
    if (rawClassification) {
      progress.cached += 1;
    } else if (healthResult.available) {
      const startedAt = Date.now();
      const result = await classifyBatches(provider, [article], batchSize);
      classificationDurationMs = Date.now() - startedAt;
      if (result.classifications.has(article.id)) {
        rawClassification = result.classifications.get(article.id);
        classificationDurationsMs.push(classificationDurationMs);
        progress.classified += 1;
        classificationCache?.set(article, rawClassification);
      } else {
        progress.failures += 1;
        failureDetails.push(...result.failedBatchDetails.map((failure) => ({ articleId: article.id, title: article.title, ...failure })));
        emitProgress(onProgress, progress, article, "classification_failed");
        continue;
      }
    } else {
      progress.failures += 1;
      failureDetails.push({ articleId: article.id, title: article.title, error: { type: "provider", code: "PROVIDER_UNAVAILABLE" } });
      emitProgress(onProgress, progress, article, "provider_unavailable");
      continue;
    }

    // Cached output is still put through the same deterministic validation.
    applyClassification(article, rawClassification);
    article.classifierModel = provider.model || null;
    article.classifierVersion = classifierVersion;

    // Compare the completed article with durable representatives before its
    // upsert. This preserves conservative same-event merging across reruns.
    // deduplicateEvents assigns display ids to representatives as part of the
    // live-refresh response shape. Preserve durable ids on its read-only
    // candidates before using a group for an incremental upsert.
    const durableEventIds = new Map(persistedCandidates.map((candidate) => [candidate, candidate.eventId]));
    const deduplication = deduplicate([...persistedCandidates, article]);
    durableEventIds.forEach((eventId, candidate) => { candidate.eventId = eventId; });
    const groupIndex = deduplication.groups.findIndex((group) => group.includes(article));
    const group = deduplication.groups[groupIndex];
    const representative = deduplication.representatives[groupIndex];
    const existing = group.find((candidate) => candidate.persisted);
    representative.eventId = existing?.eventId || stableBackfillEventId(article);
    if (existing?.eventKey) representative.eventKey = existing.eventKey;
    representative.duplicateCount = Math.max(
      representative.duplicateCount || 1,
      ...group.filter((candidate) => candidate.persisted).map((candidate) => candidate.duplicateCount || 1),
    );
    representative.duplicateSources = [...new Set(group.map((candidate) => candidate.source).filter(Boolean))];
    representative.duplicateTitles = [...new Set(group.map((candidate) => candidate.title).filter(Boolean))];
    const persistence = persist(buildEvidence([representative]), [representative], { databasePath, logger });
    if (!persistence.ok) {
      progress.failures += 1;
      failureDetails.push({ articleId: article.id, title: article.title, error: { type: "persistence", code: "PERSISTENCE_FAILED" } });
      emitProgress(onProgress, progress, article, "persistence_failed");
      continue;
    }

    progress.persisted += 1;
    progress.inserted += persistence.eventsWritten;
    progress.updated += persistence.eventsUpdated;
    if (group.length > 1) duplicateClusters.push(group.map((candidate) => ({ title: candidate.title, source: candidate.source, publishedAt: candidate.date })));
    const nextCandidate = {
      ...representative,
      persisted: true,
      articleFingerprints: [...new Set([...(existing?.articleFingerprints || []), article.articleFingerprint])],
    };
    const storedIndex = persistedCandidates.findIndex((candidate) => candidate.eventId === representative.eventId);
    if (storedIndex >= 0) persistedCandidates.splice(storedIndex, 1, nextCandidate);
    else persistedCandidates.push(nextCandidate);
    persistedFingerprints.add(article.articleFingerprint);
    emitProgress(onProgress, progress, article, classificationDurationMs === null ? "cached_persisted" : "classified_persisted");
  }

  return {
    referenceTime,
    windowDays: days,
    sourceHealth: health,
    fetchedArticleCount: articles.length,
    relevantArticleCount: filtered.accepted.length,
    relevantInWindowCount: relevantInWindow.length,
    rejectedArticleCount: filtered.rejected.length,
    availableSelectedArticleCount: allSelected.length,
    selectedArticleCount: selected.length,
    provider: healthResult,
    ...progress,
    failureDetails,
    duplicateClusters,
    averageClassificationMs: classificationDurationsMs.length
      ? classificationDurationsMs.reduce((sum, duration) => sum + duration, 0) / classificationDurationsMs.length
      : null,
  };
}

module.exports = { DAY_MS, articleFingerprint, inWindow, loadPersistedCandidates, runHistoricalNewsBackfill, selectAllInRefreshWindows, stableBackfillEventId, toIsoDate };

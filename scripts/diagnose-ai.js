"use strict";

// Read-only local diagnostic. Mirrors the news retrieval, deterministic ranking,
// Ollama batch call, and server-side validation path without starting Express,
// forecasting, or writing state.
const fs = require("fs");
const path = require("path");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch { /* dependencies may not be installed yet */ }
const { GoogleNewsSource, DirectFeedSource, mergeArticles } = require("../lib/newsSources");
const { filterArticlesByRelevance } = require("../lib/newsRelevance");
const { classifySequentialBatches, OllamaProvider, selectArticlesForClassification } = require("../lib/newsClassifierProviders");
const { validateNewsClassification } = require("../lib/newsClassificationValidation");
const { normalizeCausalClassification, normalizeGlobalRelevance } = require("../lib/newsCausality");
const { NewsClassificationCache } = require("../lib/newsClassificationCache");
const { deduplicateEvents } = require("../lib/newsEventDedup");
const { buildEventEvidence } = require("../lib/newsEventEvidence");

const appDir = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(appDir, "config", "news-sources.json"), "utf8"));
const maxArticles = Math.min(12, Math.max(1, Number(process.env.MAX_LLM_ARTICLES) || 12));
const batchSize = Math.min(12, Math.max(1, Number(process.env.OLLAMA_BATCH_SIZE) || 3));
const timeoutMs = Math.max(1000, Number(process.env.OLLAMA_TIMEOUT_MS) || 75000);

function instantiate(entry) {
  if (entry.kind === "google-news") return new GoogleNewsSource({ fetch: globalThis.fetch, enabled: entry.enabled !== false });
  if (entry.kind === "rss" || entry.kind === "atom") return new DirectFeedSource(entry, { fetch: globalThis.fetch });
  return null;
}

function toNewsItem(article, index) {
  return {
    id: `diagnostic-${index + 1}`,
    title: article.title,
    snippet: article.snippet,
    source: article.source,
    date: article.publishedAt,
    relevanceScore: article.relevance.score,
  };
}

function classifiedView(article, raw) {
  const classification = validateNewsClassification(raw, article.title);
  const causal = normalizeCausalClassification(classification, article);
  const globalRelevance = normalizeGlobalRelevance(classification.globalRelevance, classification.confidence, causal, article);
  return {
    title: article.title,
    source: article.source,
    publicationDate: article.date,
    relevanceScore: article.relevanceScore,
    category: classification.category,
    llmDirection: classification.direction,
    direction: causal.direction,
    supplyEffect: causal.supplyEffect,
    demandEffect: causal.demandEffect,
    eventStage: causal.eventStage,
    evidenceMaturity: causal.evidenceMaturity,
    causalExtractionCorrected: causal.causalExtractionCorrected,
    causalConsistencyCorrected: causal.causalConsistencyCorrected,
    severity: classification.severity,
    confidence: classification.confidence,
    globalRelevance: globalRelevance.globalRelevance,
    globalRelevanceCorrected: globalRelevance.globalRelevanceCorrected,
    chinaRelevance: classification.chinaRelevance,
    euRelevance: classification.euRelevance,
    horizonWeeks: classification.horizonWeeks,
    summary: classification.summary,
    llmImpactExplanation: classification.impactExplanation,
    impactExplanation: causal.impactExplanation,
  };
}

async function main() {
  const sources = config.sources.filter((entry) => entry.enabled !== false).map(instantiate).filter(Boolean);
  const results = await Promise.all(sources.map((source) => source.fetch({ timeoutMs: 15000, limit: 50 })));
  const merged = mergeArticles(results, 200);
  const filtered = filterArticlesByRelevance(merged);
  const relevant = filtered.accepted.map(toNewsItem);
  const selected = selectArticlesForClassification(relevant, maxArticles);
  const provider = new OllamaProvider({
    fetch: globalThis.fetch,
    baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL || "qwen3:4b",
    timeoutMs,
  });
  const cache = new NewsClassificationCache({ directory: path.join(appDir, ".cache"), model: provider.model, schemaVersion: "causal-v3" });
  const health = await provider.health();
  const started = performance.now();
  let classifications = new Map();
  let failedBatches = [];
  const fresh = [];
  let classifiedFromCache = 0;
  selected.forEach((article) => {
    const cached = cache.get(article);
    if (cached) { classifications.set(article.id, cached); classifiedFromCache++; }
    else fresh.push(article);
  });
  let classificationError = null;
  if (health.available && fresh.length) {
    try {
      const result = await classifySequentialBatches(provider, fresh, batchSize);
      failedBatches = result.failedBatches;
      result.classifications.forEach((classification, id) => {
        classifications.set(id, classification);
        const article = fresh.find((candidate) => candidate.id === id);
        if (article) cache.set(article, classification);
      });
    }
    catch (error) { classificationError = "classification unavailable"; }
  } else if (fresh.length) classificationError = "classification unavailable";
  const durationMs = Math.round(performance.now() - started);
  const classified = selected.filter((article) => classifications.has(article.id));
  const classifiedArticles = classified.map((article) => ({ ...article, ...classifiedView(article, classifications.get(article.id)) }));
  const eventDeduplication = deduplicateEvents(classifiedArticles);
  const events = buildEventEvidence(eventDeduplication.representatives);

  console.log(JSON.stringify({
    ollama: { ...health, classificationDurationMs: durationMs },
    batching: { batchSize, failedBatches },
    counts: {
      fetched: results.reduce((sum, result) => sum + result.articles.length, 0),
      deduplicated: merged.length,
      relevant: relevant.length,
      selectedForLlm: selected.length,
      selectedArticles: selected.length,
      uniqueEvents: events.length,
      successfullyClassified: classified.length,
      failedClassification: selected.length - classified.length,
      classifiedFresh: classified.length - classifiedFromCache,
      classifiedFromCache,
    },
    classificationError,
    highestScoringRejected: [...filtered.rejected]
      .sort((a, b) => b.relevance.score - a.relevance.score)
      .slice(0, 10)
      .map((article) => ({ title: article.title, source: article.source, relevanceScore: article.relevance.score, reasons: article.relevance.reasons, relevanceDisambiguated: article.relevance.relevanceDisambiguated })),
    articles: classifiedArticles,
    events,
  }, null, 2));
}

main().catch((error) => {
  console.error("AI diagnostic failed:", error?.message || "request failed");
  process.exitCode = 1;
});

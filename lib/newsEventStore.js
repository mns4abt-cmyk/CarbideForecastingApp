"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { eventFeatures, normalizedTitle } = require("./newsEventDedup");
const { aggregateNewsLageSentiment } = require("./newsEventSentiment");
const { eventWeightComponents } = require("./newsEventWeight");

const DEFAULT_DATABASE_PATH = path.join(__dirname, "..", "data", "news-events.db");
const PRICE_OUTCOME_STATUSES = new Set(["available", "pending", "unavailable"]);

function toIsoDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function toIsoDay(value) {
  const timestamp = toIsoDate(value);
  return timestamp ? timestamp.slice(0, 10) : null;
}

function parseProvenance(value) {
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function mergeProvenance(previousJson, incomingJson) {
  const previous = parseProvenance(previousJson);
  const incoming = parseProvenance(incomingJson);
  return JSON.stringify({
    representativeArticleId: incoming.representativeArticleId || previous.representativeArticleId || null,
    source: incoming.source || previous.source || null,
    sourceId: incoming.sourceId || previous.sourceId || null,
    representativeArticleIds: uniqueStrings([
      ...(previous.representativeArticleIds || []), previous.representativeArticleId,
      ...(incoming.representativeArticleIds || []), incoming.representativeArticleId,
    ]),
    sourceIds: uniqueStrings([
      ...(previous.sourceIds || []), previous.sourceId,
      ...(incoming.sourceIds || []), incoming.sourceId,
    ]),
    duplicateSources: uniqueStrings([
      ...(previous.duplicateSources || []), previous.source,
      ...(incoming.duplicateSources || []), incoming.source,
    ]),
    duplicateTitles: uniqueStrings([
      ...(previous.duplicateTitles || []),
      ...(incoming.duplicateTitles || []),
    ]),
    classifierModel: incoming.classifierModel || previous.classifierModel || null,
    classifierVersion: incoming.classifierVersion || previous.classifierVersion || null,
    classifierModels: uniqueStrings([
      ...(previous.classifierModels || []), previous.classifierModel,
      ...(incoming.classifierModels || []), incoming.classifierModel,
    ]),
    classifierVersions: uniqueStrings([
      ...(previous.classifierVersions || []), previous.classifierVersion,
      ...(incoming.classifierVersions || []), incoming.classifierVersion,
    ]),
    articleFingerprints: uniqueStrings([
      ...(previous.articleFingerprints || []), previous.articleFingerprint,
      ...(incoming.articleFingerprints || []), incoming.articleFingerprint,
    ]),
  });
}

function recentWindowStart(referenceTime, days) {
  const reference = new Date(referenceTime);
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be an integer of at least 1");
  if (Number.isNaN(reference.getTime())) throw new RangeError("referenceTime must be a valid date");
  return new Date(reference.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function toEventRecord(row) {
  if (!row) return null;
  const { provenanceJson, ...event } = { ...row };
  return { ...event, provenance: parseProvenance(provenanceJson) };
}

function directionCounts(events) {
  return events.reduce((counts, event) => {
    if (event.direction === "bullish" || event.direction === "bearish" || event.direction === "neutral") {
      counts[event.direction] += 1;
    }
    return counts;
  }, { bullish: 0, bearish: 0, neutral: 0 });
}

function stableEventKey(article, evidence) {
  const features = eventFeatures(article || { title: evidence.headline, eventStage: evidence.eventStage });
  const identity = [features.action, features.asset, features.entity, features.eventStage].join("|");
  const fallback = normalizedTitle(article || { title: evidence.headline });
  const eventDate = toIsoDate(article?.date || article?.publishedAt)?.slice(0, 10) || "undated";
  const source = `${identity === "other|||unclear" ? fallback : identity}|${eventDate}`;
  return crypto.createHash("sha256").update(source).digest("hex");
}

function toStoredEvent(evidence, article, now) {
  const provenance = {
    representativeArticleId: article?.id || evidence.representativeArticleId || null,
    source: article?.source || null,
    sourceId: article?.sourceId || null,
    classifierModel: article?.classifierModel || evidence.classifierModel || null,
    classifierVersion: article?.classifierVersion || evidence.classifierVersion || null,
    articleFingerprint: article?.articleFingerprint || evidence.articleFingerprint || null,
    classifierModels: uniqueStrings([article?.classifierModel || evidence.classifierModel || null]),
    classifierVersions: uniqueStrings([article?.classifierVersion || evidence.classifierVersion || null]),
    articleFingerprints: uniqueStrings([article?.articleFingerprint || evidence.articleFingerprint || null]),
    duplicateSources: Array.isArray(evidence.duplicateSources) ? evidence.duplicateSources : [],
    duplicateTitles: Array.isArray(article?.duplicateTitles) ? article.duplicateTitles : [],
  };
  return {
    // A conservative incremental deduplication match may identify an existing
    // durable event even when a syndicated headline yields a different title
    // fingerprint. Preserve that existing primary key for an idempotent upsert.
    eventKey: article?.eventKey || stableEventKey(article, evidence),
    eventId: evidence.eventId,
    firstSeenAt: now,
    lastSeenAt: now,
    publishedAt: toIsoDate(article?.date || article?.publishedAt),
    title: evidence.headline,
    category: evidence.category,
    direction: evidence.direction,
    supplyEffect: evidence.supplyEffect,
    demandEffect: evidence.demandEffect,
    eventStage: evidence.eventStage,
    evidenceMaturity: evidence.evidenceMaturity,
    severity: numberOr(evidence.severity, 0),
    confidence: numberOr(evidence.confidence, 0),
    globalRelevance: numberOr(evidence.globalRelevance, 0),
    chinaRelevance: numberOr(evidence.chinaRelevance, 0.5),
    euRelevance: numberOr(evidence.euRelevance, 0.5),
    horizonWeeks: numberOr(evidence.horizonWeeks, 12),
    provenanceJson: JSON.stringify(provenance),
    duplicateCount: numberOr(evidence.duplicateCount, 1),
    createdAt: now,
    updatedAt: now,
  };
}

function toStoredPriceOutcome(eventId, association, outcome, now) {
  if (typeof eventId !== "string" || !eventId.trim()) throw new TypeError("eventId must be a non-empty string");
  if (!association || !["china", "eu"].includes(association.market)) {
    throw new RangeError("association market must be china or eu");
  }
  const horizonWeeks = Number(outcome?.horizonWeeks);
  const eventDate = toIsoDay(association.eventDate);
  const targetDate = toIsoDay(outcome?.targetDate);
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1) throw new RangeError("horizonWeeks must be a positive integer");
  if (!eventDate || !targetDate) throw new TypeError("eventDate and targetDate must be valid dates");
  const status = PRICE_OUTCOME_STATUSES.has(outcome?.status) ? outcome.status : "unavailable";
  return {
    eventId,
    market: association.market,
    eventDate,
    priceAtEventDate: toIsoDay(association.matchedPriceDate),
    priceAtEvent: numberOr(association.priceAtEvent, null),
    unit: String(association.unit || ""),
    horizonWeeks,
    targetDate,
    matchedFuturePriceDate: toIsoDay(outcome?.matchedPriceDate),
    futurePrice: numberOr(outcome?.futurePrice, null),
    returnPct: numberOr(outcome?.returnPct, null),
    status,
    calculatedAt: now,
    updatedAt: now,
  };
}

class NewsEventStore {
  constructor({ databasePath = DEFAULT_DATABASE_PATH, now = () => new Date().toISOString() } = {}) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS news_events (
        event_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        published_at TEXT,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        direction TEXT NOT NULL,
        supply_effect TEXT NOT NULL,
        demand_effect TEXT NOT NULL,
        event_stage TEXT NOT NULL,
        evidence_maturity TEXT NOT NULL,
        severity REAL NOT NULL,
        confidence REAL NOT NULL,
        global_relevance REAL NOT NULL,
        china_relevance REAL NOT NULL,
        eu_relevance REAL NOT NULL,
        horizon_weeks INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS news_events_published_at ON news_events(published_at);
      CREATE TABLE IF NOT EXISTS news_event_price_outcomes (
        event_id TEXT NOT NULL,
        market TEXT NOT NULL CHECK (market IN ('china', 'eu')),
        event_date TEXT NOT NULL,
        price_at_event_date TEXT,
        price_at_event REAL,
        unit TEXT NOT NULL,
        horizon_weeks INTEGER NOT NULL CHECK (horizon_weeks > 0),
        target_date TEXT NOT NULL,
        matched_future_price_date TEXT,
        future_price REAL,
        return_pct REAL,
        status TEXT NOT NULL CHECK (status IN ('available', 'pending', 'unavailable')),
        calculated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (event_id, market, horizon_weeks)
      );
      CREATE INDEX IF NOT EXISTS news_event_price_outcomes_market_event_date
        ON news_event_price_outcomes(market, event_date);
    `);
    this.upsertStatement = this.db.prepare(`
      INSERT INTO news_events (
        event_key, event_id, first_seen_at, last_seen_at, published_at, title,
        category, direction, supply_effect, demand_effect, event_stage, evidence_maturity,
        severity, confidence, global_relevance, china_relevance, eu_relevance, horizon_weeks,
        provenance_json, duplicate_count, created_at, updated_at
      ) VALUES (
        @eventKey, @eventId, @firstSeenAt, @lastSeenAt, @publishedAt, @title,
        @category, @direction, @supplyEffect, @demandEffect, @eventStage, @evidenceMaturity,
        @severity, @confidence, @globalRelevance, @chinaRelevance, @euRelevance, @horizonWeeks,
        @provenanceJson, @duplicateCount, @createdAt, @updatedAt
      ) ON CONFLICT(event_key) DO UPDATE SET
        event_id = excluded.event_id,
        last_seen_at = excluded.last_seen_at,
        published_at = COALESCE(excluded.published_at, news_events.published_at),
        title = excluded.title,
        category = excluded.category,
        direction = excluded.direction,
        supply_effect = excluded.supply_effect,
        demand_effect = excluded.demand_effect,
        event_stage = excluded.event_stage,
        evidence_maturity = excluded.evidence_maturity,
        severity = excluded.severity,
        confidence = excluded.confidence,
        global_relevance = excluded.global_relevance,
        china_relevance = excluded.china_relevance,
        eu_relevance = excluded.eu_relevance,
        horizon_weeks = excluded.horizon_weeks,
        provenance_json = excluded.provenance_json,
        duplicate_count = excluded.duplicate_count,
        updated_at = excluded.updated_at
    `);
    this.existingEventStatement = this.db.prepare(
      "SELECT duplicate_count AS duplicateCount, provenance_json AS provenanceJson FROM news_events WHERE event_key = ?"
    );
    this.eventCountStatement = this.db.prepare("SELECT COUNT(*) AS count FROM news_events");
    this.priceOutcomeCountStatement = this.db.prepare("SELECT COUNT(*) AS count FROM news_event_price_outcomes");
    this.existingPriceOutcomeStatement = this.db.prepare(
      "SELECT 1 AS found FROM news_event_price_outcomes WHERE event_id = ? AND market = ? AND horizon_weeks = ?"
    );
    this.upsertPriceOutcomeStatement = this.db.prepare(`
      INSERT INTO news_event_price_outcomes (
        event_id, market, event_date, price_at_event_date, price_at_event, unit,
        horizon_weeks, target_date, matched_future_price_date, future_price,
        return_pct, status, calculated_at, updated_at
      ) VALUES (
        @eventId, @market, @eventDate, @priceAtEventDate, @priceAtEvent, @unit,
        @horizonWeeks, @targetDate, @matchedFuturePriceDate, @futurePrice,
        @returnPct, @status, @calculatedAt, @updatedAt
      ) ON CONFLICT(event_id, market, horizon_weeks) DO UPDATE SET
        event_date = excluded.event_date,
        price_at_event_date = excluded.price_at_event_date,
        price_at_event = excluded.price_at_event,
        unit = excluded.unit,
        target_date = excluded.target_date,
        matched_future_price_date = excluded.matched_future_price_date,
        future_price = excluded.future_price,
        return_pct = excluded.return_pct,
        status = excluded.status,
        calculated_at = excluded.calculated_at,
        updated_at = excluded.updated_at
    `);
    this.updatePendingPriceOutcomeStatement = this.db.prepare(`
      UPDATE news_event_price_outcomes SET
        event_date = @eventDate,
        price_at_event_date = @priceAtEventDate,
        price_at_event = @priceAtEvent,
        unit = @unit,
        target_date = @targetDate,
        matched_future_price_date = @matchedFuturePriceDate,
        future_price = @futurePrice,
        return_pct = @returnPct,
        status = @status,
        calculated_at = @calculatedAt,
        updated_at = @updatedAt
      WHERE event_id = @eventId AND market = @market AND horizon_weeks = @horizonWeeks
        AND status = 'pending'
    `);
    this.priceOutcomeStatements = {
      all: this.db.prepare(`
        SELECT event_id AS eventId, market, event_date AS eventDate,
          price_at_event_date AS priceAtEventDate, price_at_event AS priceAtEvent,
          unit, horizon_weeks AS horizonWeeks, target_date AS targetDate,
          matched_future_price_date AS matchedFuturePriceDate,
          future_price AS futurePrice, return_pct AS returnPct, status,
          calculated_at AS calculatedAt, updated_at AS updatedAt
        FROM news_event_price_outcomes
        WHERE event_id = ?
        ORDER BY market ASC, horizon_weeks ASC
      `),
      market: this.db.prepare(`
        SELECT event_id AS eventId, market, event_date AS eventDate,
          price_at_event_date AS priceAtEventDate, price_at_event AS priceAtEvent,
          unit, horizon_weeks AS horizonWeeks, target_date AS targetDate,
          matched_future_price_date AS matchedFuturePriceDate,
          future_price AS futurePrice, return_pct AS returnPct, status,
          calculated_at AS calculatedAt, updated_at AS updatedAt
        FROM news_event_price_outcomes
        WHERE event_id = ? AND market = ?
        ORDER BY horizon_weeks ASC
      `),
    };
    this.pendingPriceOutcomesStatement = this.db.prepare(`
      SELECT event_id AS eventId, market, event_date AS eventDate,
        price_at_event_date AS priceAtEventDate, price_at_event AS priceAtEvent,
        unit, horizon_weeks AS horizonWeeks, target_date AS targetDate,
        matched_future_price_date AS matchedFuturePriceDate,
        future_price AS futurePrice, return_pct AS returnPct, status,
        calculated_at AS calculatedAt, updated_at AS updatedAt
      FROM news_event_price_outcomes
      WHERE status = 'pending'
      ORDER BY event_id ASC, market ASC, horizon_weeks ASC
    `);
    this.allEventsStatement = this.db.prepare(`
      SELECT event_key AS eventKey, event_id AS eventId, first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt, published_at AS publishedAt, title, category, direction,
        supply_effect AS supplyEffect, demand_effect AS demandEffect, event_stage AS eventStage,
        evidence_maturity AS evidenceMaturity, severity, confidence,
        global_relevance AS globalRelevance, china_relevance AS chinaRelevance,
        eu_relevance AS euRelevance, horizon_weeks AS horizonWeeks,
        provenance_json AS provenanceJson, duplicate_count AS duplicateCount,
        created_at AS createdAt, updated_at AS updatedAt
      FROM news_events
      ORDER BY COALESCE(published_at, first_seen_at) ASC, event_key ASC
    `);
    this.recentEventStatements = {
      all: this.db.prepare(`
        SELECT event_key AS eventKey, event_id AS eventId, first_seen_at AS firstSeenAt,
          last_seen_at AS lastSeenAt, published_at AS publishedAt, title, category, direction,
          supply_effect AS supplyEffect, demand_effect AS demandEffect, event_stage AS eventStage,
          evidence_maturity AS evidenceMaturity, severity, confidence,
          global_relevance AS globalRelevance, china_relevance AS chinaRelevance,
          eu_relevance AS euRelevance, horizon_weeks AS horizonWeeks,
          provenance_json AS provenanceJson, duplicate_count AS duplicateCount,
          created_at AS createdAt, updated_at AS updatedAt
        FROM news_events
        WHERE COALESCE(published_at, first_seen_at) >= ?
        ORDER BY COALESCE(published_at, first_seen_at) DESC, event_key ASC
      `),
      global: this.db.prepare(`
        SELECT event_key AS eventKey, event_id AS eventId, first_seen_at AS firstSeenAt,
          last_seen_at AS lastSeenAt, published_at AS publishedAt, title, category, direction,
          supply_effect AS supplyEffect, demand_effect AS demandEffect, event_stage AS eventStage,
          evidence_maturity AS evidenceMaturity, severity, confidence,
          global_relevance AS globalRelevance, china_relevance AS chinaRelevance,
          eu_relevance AS euRelevance, horizon_weeks AS horizonWeeks,
          provenance_json AS provenanceJson, duplicate_count AS duplicateCount,
          created_at AS createdAt, updated_at AS updatedAt
        FROM news_events
        WHERE COALESCE(published_at, first_seen_at) >= ? AND global_relevance > 0
        ORDER BY COALESCE(published_at, first_seen_at) DESC, event_key ASC
      `),
      china: this.db.prepare(`
        SELECT event_key AS eventKey, event_id AS eventId, first_seen_at AS firstSeenAt,
          last_seen_at AS lastSeenAt, published_at AS publishedAt, title, category, direction,
          supply_effect AS supplyEffect, demand_effect AS demandEffect, event_stage AS eventStage,
          evidence_maturity AS evidenceMaturity, severity, confidence,
          global_relevance AS globalRelevance, china_relevance AS chinaRelevance,
          eu_relevance AS euRelevance, horizon_weeks AS horizonWeeks,
          provenance_json AS provenanceJson, duplicate_count AS duplicateCount,
          created_at AS createdAt, updated_at AS updatedAt
        FROM news_events
        WHERE COALESCE(published_at, first_seen_at) >= ? AND china_relevance > 0
        ORDER BY COALESCE(published_at, first_seen_at) DESC, event_key ASC
      `),
      eu: this.db.prepare(`
        SELECT event_key AS eventKey, event_id AS eventId, first_seen_at AS firstSeenAt,
          last_seen_at AS lastSeenAt, published_at AS publishedAt, title, category, direction,
          supply_effect AS supplyEffect, demand_effect AS demandEffect, event_stage AS eventStage,
          evidence_maturity AS evidenceMaturity, severity, confidence,
          global_relevance AS globalRelevance, china_relevance AS chinaRelevance,
          eu_relevance AS euRelevance, horizon_weeks AS horizonWeeks,
          provenance_json AS provenanceJson, duplicate_count AS duplicateCount,
          created_at AS createdAt, updated_at AS updatedAt
        FROM news_events
        WHERE COALESCE(published_at, first_seen_at) >= ? AND eu_relevance > 0
        ORDER BY COALESCE(published_at, first_seen_at) DESC, event_key ASC
      `),
    };
  }

  upsert(eventEvidence, representative) {
    const record = toStoredEvent(eventEvidence, representative, this.now());
    const existing = this.existingEventStatement.get(record.eventKey);
    if (existing) {
      record.provenanceJson = mergeProvenance(existing.provenanceJson, record.provenanceJson);
      record.duplicateCount = Math.max(record.duplicateCount, numberOr(existing.duplicateCount, 0));
    }
    this.upsertStatement.run(record);
    return record.eventKey;
  }

  upsertMany(eventEvidence, representatives = []) {
    const byEventId = new Map(representatives.map((article) => [article.eventId, article]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      let updated = 0;
      const keys = eventEvidence.map((evidence, index) => {
        const record = toStoredEvent(evidence, byEventId.get(evidence.eventId) || representatives[index], this.now());
        const existing = this.existingEventStatement.get(record.eventKey);
        if (existing) {
          record.provenanceJson = mergeProvenance(existing.provenanceJson, record.provenanceJson);
          // A later, narrower feed result must not erase duplicate evidence
          // validated and stored during an earlier refresh.
          record.duplicateCount = Math.max(record.duplicateCount, numberOr(existing.duplicateCount, 0));
          updated += 1;
        } else {
          inserted += 1;
        }
        this.upsertStatement.run(record);
        return record.eventKey;
      });
      this.db.exec("COMMIT");
      return {
        eventKeys: keys,
        inserted,
        updated,
        totalEvents: this.eventCountStatement.get().count,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Inclusion uses publishedAt, because the current News-Lage window is about
  // when an event occurred. firstSeenAt is used only when a source supplied no
  // valid publication timestamp. The cutoff itself is inclusive.
  getRecentEvents({ days = 30, market = "all", referenceTime = this.now() } = {}) {
    const statement = this.recentEventStatements[market];
    if (!statement) throw new RangeError("market must be one of: all, global, china, eu");
    return statement.all(recentWindowStart(referenceTime, days)).map(toEventRecord);
  }

  // Additive event-study storage. The core news_event row remains unchanged;
  // re-running an association replaces only the same event/market/horizon row.
  upsertPriceOutcomes(eventId, association) {
    const outcomes = Array.isArray(association?.outcomes) ? association.outcomes : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      let updated = 0;
      for (const outcome of outcomes) {
        const record = toStoredPriceOutcome(eventId, association, outcome, this.now());
        if (this.existingPriceOutcomeStatement.get(record.eventId, record.market, record.horizonWeeks)) updated += 1;
        else inserted += 1;
        this.upsertPriceOutcomeStatement.run(record);
      }
      this.db.exec("COMMIT");
      return { inserted, updated, totalOutcomes: this.priceOutcomeCountStatement.get().count };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPriceOutcomes({ eventId, market } = {}) {
    if (typeof eventId !== "string" || !eventId.trim()) throw new TypeError("eventId must be a non-empty string");
    if (market === undefined) return this.priceOutcomeStatements.all.all(eventId).map((row) => ({ ...row }));
    if (market !== "china" && market !== "eu") throw new RangeError("market must be one of: china, eu");
    return this.priceOutcomeStatements.market.all(eventId, market).map((row) => ({ ...row }));
  }

  // Pending-only refresh support. Rows that have already become available or
  // unavailable are never re-written by this method.
  getPendingPriceOutcomes() {
    return this.pendingPriceOutcomesStatement.all().map((row) => ({ ...row }));
  }

  updatePendingPriceOutcomes(eventId, association) {
    const outcomes = Array.isArray(association?.outcomes) ? association.outcomes : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let updated = 0;
      for (const outcome of outcomes) {
        const record = toStoredPriceOutcome(eventId, association, outcome, this.now());
        if (record.status === "pending") continue;
        updated += this.updatePendingPriceOutcomeStatement.run(record).changes;
      }
      this.db.exec("COMMIT");
      return { updated, totalOutcomes: this.priceOutcomeCountStatement.get().count };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Full durable history for offline/event-study jobs. Unlike getRecentEvents,
  // this deliberately applies no retention window or market relevance filter.
  getAllEvents() {
    return this.allEventsStatement.all().map(toEventRecord);
  }

  // Read-only News-Lage v2 preparation. Querying "all" first retains globally
  // material events so the v2-local conservative transfer rule can be applied
  // by the pure aggregator; this has no connection to Fusion or the API/UI.
  getRecentSentiment({ days = 30, market, referenceTime = this.now() } = {}) {
    const events = this.getRecentEvents({ days, market: "all", referenceTime });
    const sentiment = aggregateNewsLageSentiment(
      events,
      { market, windowDays: days, referenceTime }
    );
    const lastUpdatedAt = events.reduce((latest, event) => {
      if (!event.updatedAt || (latest && latest >= event.updatedAt)) return latest;
      return event.updatedAt;
    }, null);
    return { ...sentiment, lastUpdatedAt };
  }

  // Compact, event-level explanation data for News-Lage v2. It intentionally
  // contains only stored structured evidence/provenance—not article bodies,
  // LLM prompts, or hidden reasoning.
  getRecentEventDetails({ days = 30, market, referenceTime = this.now() } = {}) {
    if (market !== "china" && market !== "eu") throw new RangeError("market must be china or eu");
    return this.getRecentEvents({ days, market: "all", referenceTime })
      .map((event) => {
        const components = eventWeightComponents(event, market, referenceTime);
        const sources = [...new Set([
          event.provenance?.source,
          ...(Array.isArray(event.provenance?.duplicateSources) ? event.provenance.duplicateSources : []),
        ].filter(Boolean))];
        return {
          eventKey: event.eventKey,
          eventId: event.eventId,
          publishedAt: event.publishedAt,
          firstSeenAt: event.firstSeenAt,
          title: event.title,
          category: event.category,
          direction: components.directional ? event.direction : "neutral",
          eventStage: event.eventStage,
          evidenceMaturity: event.evidenceMaturity,
          severity: event.severity,
          confidence: event.confidence,
          chinaRelevance: event.chinaRelevance,
          euRelevance: event.euRelevance,
          globalRelevance: event.globalRelevance,
          effectiveMarketRelevance: components.relevanceComponent,
          finalWeight: components.finalWeight,
          duplicateCount: event.duplicateCount,
          sources,
          sourceCount: sources.length,
          // Additive, read-only event-study data for the secondary UI panel.
          // These rows are historical associations only and are not used by
          // News-Lage sentiment, Evidence Fusion, forecasting, or scenarios.
          priceOutcomes: this.getPriceOutcomes({ eventId: event.eventId, market }),
        };
      })
      .filter((event) => event.effectiveMarketRelevance > 0)
      .sort((left, right) => (
        Math.abs(right.finalWeight) - Math.abs(left.finalWeight)
        || String(right.publishedAt || right.firstSeenAt || "").localeCompare(String(left.publishedAt || left.firstSeenAt || ""))
        || String(left.eventId).localeCompare(String(right.eventId))
      ));
  }

  // Integrity diagnostic: event IDs are expected to be unique among durable
  // event rows, even though SQLite enforces the separate stable event key.
  getDuplicateEventIds() {
    return this.db.prepare(`
      SELECT event_id AS eventId
      FROM news_events
      GROUP BY event_id
      HAVING COUNT(*) > 1
      ORDER BY event_id ASC
    `).all().map((row) => row.eventId);
  }

  diagnostics(referenceTime = this.now()) {
    const totalEvents = this.db.prepare("SELECT COUNT(*) AS count FROM news_events").get().count;
    const oldestRow = this.db.prepare("SELECT event_id AS eventId, title, published_at AS publishedAt FROM news_events ORDER BY COALESCE(published_at, first_seen_at) ASC LIMIT 1").get();
    const newestRow = this.db.prepare("SELECT event_id AS eventId, title, published_at AS publishedAt FROM news_events ORDER BY COALESCE(published_at, last_seen_at) DESC LIMIT 1").get();
    const oldestEvent = oldestRow ? { ...oldestRow } : null;
    const newestEvent = newestRow ? { ...newestRow } : null;
    const recentEvents = this.getRecentEvents({ days: 30, market: "all", referenceTime });
    return {
      totalEvents,
      oldestEvent,
      newestEvent,
      eventsLast30Days: recentEvents.length,
      recentDirectionCountsByMarket: {
        all: directionCounts(recentEvents),
        global: directionCounts(this.getRecentEvents({ days: 30, market: "global", referenceTime })),
        china: directionCounts(this.getRecentEvents({ days: 30, market: "china", referenceTime })),
        eu: directionCounts(this.getRecentEvents({ days: 30, market: "eu", referenceTime })),
      },
    };
  }

  // Lazy, additive migration: tag-storage problems cannot prevent ordinary
  // event persistence or News-Lage reads from opening the store.
  ensureStrategicTagSchema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS news_event_strategic_tags (
      event_key TEXT PRIMARY KEY REFERENCES news_events(event_key),
      event_id TEXT NOT NULL,
      entities_json TEXT NOT NULL,
      topics_json TEXT NOT NULL,
      tagging_version TEXT NOT NULL,
      tagged_at TEXT NOT NULL
    )`);
  }

  getEventsForStrategicTagging(eventKeys = null) {
    return this.db.prepare(`SELECT event_key AS eventKey, event_id AS eventId,
      title, category, supply_effect AS supplyEffect, demand_effect AS demandEffect,
      provenance_json AS provenanceJson FROM news_events
      WHERE ? IS NULL OR event_key IN (SELECT value FROM json_each(?))
      ORDER BY event_key`).all(
      eventKeys === null ? null : JSON.stringify(eventKeys),
      JSON.stringify(eventKeys || []),
    ).map(toEventRecord);
  }

  upsertStrategicTags(eventKey, tags, taggingVersion) {
    this.ensureStrategicTagSchema();
    const entities = JSON.stringify([...new Set(tags.entities)].sort());
    const topics = JSON.stringify([...new Set(tags.topics)].sort());
    // Read the ID from the durable event, never change it or trust a caller's ID.
    // Identical reruns preserve tagged_at as well as avoiding duplicate rows.
    const result = this.db.prepare(`INSERT INTO news_event_strategic_tags
      (event_key, event_id, entities_json, topics_json, tagging_version, tagged_at)
      SELECT event_key, event_id, ?, ?, ?, ? FROM news_events WHERE event_key = ?
      ON CONFLICT(event_key) DO UPDATE SET
        event_id = excluded.event_id, entities_json = excluded.entities_json,
        topics_json = excluded.topics_json, tagging_version = excluded.tagging_version,
        tagged_at = excluded.tagged_at
      WHERE event_id != excluded.event_id OR entities_json != excluded.entities_json
        OR topics_json != excluded.topics_json OR tagging_version != excluded.tagging_version
    `).run(entities, topics, taggingVersion, this.now(), eventKey);
    return Number(result.changes);
  }

  getStrategicTags({ eventKey = null, eventId = null, entity = null, topic = null } = {}) {
    this.ensureStrategicTagSchema();
    return this.db.prepare(`SELECT event_key AS eventKey, event_id AS eventId,
      entities_json AS entitiesJson, topics_json AS topicsJson,
      tagging_version AS taggingVersion, tagged_at AS taggedAt
      FROM news_event_strategic_tags
      WHERE (? IS NULL OR event_key = ?) AND (? IS NULL OR event_id = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(entities_json) WHERE value = ?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(topics_json) WHERE value = ?))
      ORDER BY event_key`).all(eventKey, eventKey, eventId, eventId, entity, entity, topic, topic)
      .map(({ entitiesJson, topicsJson, ...row }) => ({ ...row,
        entities: JSON.parse(entitiesJson), topics: JSON.parse(topicsJson) }));
  }

  close() {
    this.db.close();
  }
}

module.exports = { DEFAULT_DATABASE_PATH, NewsEventStore, stableEventKey };

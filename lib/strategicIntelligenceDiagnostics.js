"use strict";
const { DatabaseSync } = require("node:sqlite");
const { DEFAULT_DATABASE_PATH } = require("./newsEventStore");
const { queryStrategicMarketIntelligence } = require("./strategicMarketIntelligence");

function summarize(view) {
  const events = view.latestEvents;
  const sources = new Set(events.flatMap(event => [event.source, event.provenance?.source,
    ...(Array.isArray(event.provenance?.duplicateSources) ? event.provenance.duplicateSources : [])])
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()));
  const brief = event => event ? {
    eventKey: event.eventKey, eventId: event.eventId, date: event.date,
    title: event.title, direction: event.direction, source: event.source,
  } : null;
  return {
    id: view.id, displayName: view.displayName, status: view.status,
    eventCount: view.totalEventCount,
    newestEvent: brief(events[0]), oldestEvent: brief(events.at(-1)),
    directionalCounts: { bullish: view.bullishEventCount, bearish: view.bearishEventCount, neutral: view.neutralEventCount },
    topRecentEvents: events.slice(0, 5).map(brief),
    sourceCount: view.totalEventCount === null ? null : sources.size,
  };
}

function collectStrategicIntelligenceDiagnostics({
  databasePath = DEFAULT_DATABASE_PATH, referenceTime = new Date().toISOString(),
} = {}) {
  const report = {
    status: "database_unavailable", referenceTime, windowDays: 30,
    taggedDefinition: "A persisted tag record exists, including empty entity/topic arrays.",
    counts: { totalStoredEvents: null, taggedEvents: null, untaggedEvents: null },
    entities: [], topics: [], duplicateEventIdCollisions: null,
    dataQuality: { orphanTagRows: null, tagEventIdMismatches: null },
    safety: { readOnly: true, canonicalIdentity: "eventKey", additionalLlmCalls: false,
      numericalForecastAdjustmentApplied: false, backfillPerformed: false,
      writeValidation: "Tag idempotency and ID preservation are covered by temporary-database regression tests; no live write test is performed." },
  };
  let db;
  try {
    const views = queryStrategicMarketIntelligence({ databasePath, referenceTime });
    report.status = views.status;
    report.entities = views.entities.map(summarize);
    report.topics = views.topics.map(summarize);
    db = new DatabaseSync(databasePath, { readOnly: true });
    const total = db.prepare("SELECT COUNT(*) AS n FROM news_events").get().n;
    const hasTags = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'news_event_strategic_tags'").get();
    const tagged = hasTags ? db.prepare(`SELECT COUNT(*) AS n FROM news_events e
      WHERE EXISTS (SELECT 1 FROM news_event_strategic_tags t WHERE t.event_key = e.event_key)`).get().n : 0;
    report.counts = { totalStoredEvents: total, taggedEvents: tagged, untaggedEvents: total - tagged };
    report.duplicateEventIdCollisions = db.prepare(`SELECT event_id AS eventId, COUNT(*) AS eventCount
      FROM news_events GROUP BY event_id HAVING COUNT(*) > 1 ORDER BY event_id`).all().map(row => ({ ...row }));
    if (hasTags) {
      report.dataQuality.orphanTagRows = db.prepare(`SELECT COUNT(*) AS n FROM news_event_strategic_tags t
        WHERE NOT EXISTS (SELECT 1 FROM news_events e WHERE e.event_key = t.event_key)`).get().n;
      report.dataQuality.tagEventIdMismatches = db.prepare(`SELECT COUNT(*) AS n FROM news_event_strategic_tags t
        JOIN news_events e ON e.event_key = t.event_key WHERE t.event_id != e.event_id`).get().n;
    }
  } catch {
    report.status = "database_unavailable";
    report.error = "Strategic diagnostics unavailable; no live data was changed.";
  } finally {
    try { db?.close(); } catch { /* Read-only cleanup is isolated. */ }
  }
  return report;
}

module.exports = { collectStrategicIntelligenceDiagnostics };

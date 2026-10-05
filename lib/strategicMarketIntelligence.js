"use strict";

const { DatabaseSync } = require("node:sqlite");
const { DEFAULT_DATABASE_PATH } = require("./newsEventStore");

const { confirmedEntities } = require("./strategicEntities");
const TOPICS = [["china_tc_operators", "China TC operators"], ["export_controls", "Export controls"]];
const DAY_MS = 24 * 60 * 60 * 1000;

function view([id, displayName], windowDays, events, status = "available") {
  const available = status === "available";
  const count = (direction) => events.filter(event => event.direction === direction).length;
  const observed = (field) => [...new Set(events.map(event => event[field]).filter(value => value != null))].sort();
  return {
    id, displayName, windowDays,
    status: available && !events.length ? "no_matching_events" : status,
    totalEventCount: available ? events.length : null,
    directionalEventCount: available ? count("bullish") + count("bearish") : null,
    bullishEventCount: available ? count("bullish") : null,
    bearishEventCount: available ? count("bearish") : null,
    neutralEventCount: available ? count("neutral") : null,
    latestEventDate: events[0]?.date || null,
    latestEvents: events,
    categories: observed("category"), supplyEffects: observed("supplyEffect"),
    demandEffects: observed("demandEffect"), eventStages: observed("eventStage"),
  };
}

/**
 * Read persisted labels and validated events only. No migrations, retagging,
 * sentiment, causal inference, retention deletion, or model calls.
 * Window is inclusive [referenceTime - windowDays * 24h, referenceTime].
 * latestEvents contains every matching event in that window (no hidden limit).
 * Missing tables are not created; callers can run the separate tag backfill.
 */
function queryStrategicMarketIntelligence({
  databasePath = DEFAULT_DATABASE_PATH, windowDays = 30, referenceTime = new Date().toISOString(),
  configuration,
} = {}) {
  const entities = confirmedEntities(configuration).map(({ id, displayName }) => [id, displayName]);
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new RangeError("windowDays must be a positive integer");
  const end = Date.parse(referenceTime);
  const start = end - windowDays * DAY_MS;
  if (!Number.isFinite(end) || !Number.isFinite(start) || Math.abs(start) > 8.64e15) {
    throw new RangeError("referenceTime and windowDays must define a valid date window");
  }
  const response = (status, rows = []) => ({
    status, windowDays, referenceTime: new Date(end).toISOString(),
    entities: entities.map(definition => view(definition, windowDays,
      rows.filter(row => row.entities.includes(definition[0])).map(row => row.event), status)),
    topics: TOPICS.map(definition => view(definition, windowDays,
      rows.filter(row => row.topics.includes(definition[0])).map(row => row.event), status)),
  });
  let db;
  try {
    // Do not instantiate NewsEventStore: its constructor performs migrations.
    db = new DatabaseSync(databasePath, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has("news_events")) return response("database_unavailable");
    if (!tables.has("news_event_strategic_tags")) return response("tags_unavailable");
    const rows = db.prepare(`SELECT e.event_key AS eventKey, e.event_id AS eventId,
      e.published_at AS publishedAt, e.first_seen_at AS firstSeenAt, e.title,
      e.category, e.direction, e.supply_effect AS supplyEffect, e.demand_effect AS demandEffect,
      e.event_stage AS eventStage, e.evidence_maturity AS evidenceMaturity,
      e.severity, e.confidence, e.global_relevance AS globalRelevance,
      e.china_relevance AS chinaRelevance, e.eu_relevance AS euRelevance,
      e.provenance_json AS provenanceJson, t.entities_json AS entitiesJson, t.topics_json AS topicsJson
      FROM news_events e JOIN news_event_strategic_tags t ON t.event_key = e.event_key
      WHERE COALESCE(julianday(e.published_at), julianday(e.first_seen_at))
        BETWEEN julianday(?) AND julianday(?)
    `).all(new Date(start).toISOString(), new Date(end).toISOString());
    const events = rows.flatMap(({ publishedAt, firstSeenAt, provenanceJson, entitiesJson, topicsJson, ...fields }) => {
      const publicationTime = Date.parse(publishedAt);
      const hasPublicationDate = Number.isFinite(publicationTime);
      const timestamp = hasPublicationDate ? publicationTime : Date.parse(firstSeenAt);
      // Enforce precise millisecond boundaries independently of SQLite date rounding.
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) return [];
      const provenance = JSON.parse(provenanceJson) || {};
      const entities = JSON.parse(entitiesJson);
      const topics = JSON.parse(topicsJson);
      if (!Array.isArray(entities) || !Array.isArray(topics)) throw new Error("Invalid stored tags");
      return [{ entities, topics, event: { ...fields,
        date: new Date(timestamp).toISOString(), dateSource: hasPublicationDate ? "publishedAt" : "firstSeenAt",
        source: provenance.source || null, provenance,
      } }];
    });
    events.sort((a, b) => b.event.date.localeCompare(a.event.date)
      || (a.event.eventKey < b.event.eventKey ? -1 : a.event.eventKey > b.event.eventKey ? 1 : 0));
    return response("available", events);
  } catch {
    // No raw errors/paths exposed, and no fabricated zero counts on read failure.
    return response("database_unavailable");
  } finally {
    try { db?.close(); } catch { /* Read-only cleanup must not interrupt callers. */ }
  }
}

module.exports = { queryStrategicMarketIntelligence };

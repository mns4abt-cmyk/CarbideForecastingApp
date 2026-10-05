"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NewsEventStore } = require("../lib/newsEventStore");
const { queryStrategicMarketIntelligence } = require("../lib/strategicMarketIntelligence");
const referenceTime = "2026-10-01T12:00:00.000Z";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strategic-query-"));
  const databasePath = path.join(directory, "events.db");
  const store = new NewsEventStore({ databasePath, now: () => referenceTime });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function insert(key, date, overrides = {}, tags = { entities: ["almonty"], topics: [] }) {
    store.upsert({ eventId: "reused-refresh-id", headline: key, category: "supply",
      direction: "bullish", supplyEffect: "decrease", demandEffect: "none",
      eventStage: "actual", evidenceMaturity: "realized", severity: 0.2, confidence: 0.8,
      globalRelevance: 0.3, chinaRelevance: 0.1, euRelevance: 0.2, horizonWeeks: 12,
      ...overrides }, { eventKey: key, date, source: "Publisher", duplicateTitles: [key] });
    if (tags) store.upsertStrategicTags(key, tags, "strategic-v1");
  }
  return { store, insert, databasePath, query: (options = {}) => queryStrategicMarketIntelligence({ databasePath, referenceTime, ...options }) };
}

test("window includes exact boundaries, excludes old/future events, and prefers publication date", (t) => {
  const f = fixture(t);
  f.insert("cutoff", "2026-09-01T12:00:00.000Z");
  f.insert("old", "2026-09-01T11:59:59.999Z");
  f.insert("now", referenceTime);
  f.insert("future", "2026-10-01T12:00:00.001Z");
  f.insert("fallback", null);
  const view = f.query().entities[0];
  assert.equal(view.windowDays, 30);
  assert.equal(view.totalEventCount, 3);
  assert.deepEqual(view.latestEvents.map(e => e.eventKey), ["fallback", "now", "cutoff"]);
  assert.equal(view.latestEvents[0].date, referenceTime);
  assert.equal(view.latestEvents[0].dateSource, "firstSeenAt");
  assert.equal(view.latestEvents[2].dateSource, "publishedAt");
  assert.equal(f.query({ windowDays: 1 }).entities[0].totalEventCount, 2);
  assert.equal(f.store.getAllEvents().length, 5);
});

test("counts distinct stored events, sorts newest first, and returns original fields and observed sets", (t) => {
  const f = fixture(t);
  f.insert("older", "2026-09-20", { direction: "bearish", supplyEffect: "increase" });
  f.insert("newer", "2026-09-30", { direction: "neutral", category: "regulation", eventStage: "announced", demandEffect: "decrease" });
  f.insert("middle", "2026-09-25");
  const view = f.query().entities[0];
  assert.equal(view.status, "available");
  assert.equal(view.totalEventCount, 3);
  assert.equal(view.directionalEventCount, 2);
  assert.equal(view.bullishEventCount, 1);
  assert.equal(view.bearishEventCount, 1);
  assert.equal(view.neutralEventCount, 1);
  assert.equal(view.latestEventDate, "2026-09-30T00:00:00.000Z");
  assert.deepEqual(view.latestEvents.map(e => e.title), ["newer", "middle", "older"]);
  assert.deepEqual(view.categories, ["regulation", "supply"]);
  assert.deepEqual(view.supplyEffects, ["decrease", "increase"]);
  assert.deepEqual(view.demandEffects, ["decrease", "none"]);
  assert.deepEqual(view.eventStages, ["actual", "announced"]);
  const event = view.latestEvents[0];
  assert.equal(event.eventId, "reused-refresh-id");
  assert.equal(event.source, "Publisher");
  assert.equal(event.provenance.source, "Publisher");
  assert.equal(event.evidenceMaturity, "realized");
  assert.equal(event.severity, 0.2);
  assert.equal(event.confidence, 0.8);
  assert.equal(event.globalRelevance, 0.3);
  assert.equal(event.chinaRelevance, 0.1);
  assert.equal(event.euRelevance, 0.2);
});

test("matches persisted multi-tags only, without retagging titles or counting duplicate tags twice", (t) => {
  const f = fixture(t);
  f.insert("unrelated title", "2026-09-20", {}, {
    entities: ["almonty", "masan_group", "jinlu"], topics: ["china_tc_operators", "export_controls"],
  });
  f.insert("Almonty tungsten export controls", "2026-09-21", {}, null);
  const result = f.query();
  assert.deepEqual(result.entities.map(v => [v.displayName, v.totalEventCount]), [["Almonty", 1], ["Masan Group", 1], ["Jinlu", 1]]);
  assert.deepEqual(result.topics.map(v => v.totalEventCount), [1, 1]);
});

test("empty views are explicit and querying does not alter database contents or schema", (t) => {
  const f = fixture(t);
  f.store.ensureStrategicTagSchema();
  const before = fs.readFileSync(f.databasePath);
  const result = f.query();
  assert.equal(result.status, "available");
  for (const view of [...result.entities, ...result.topics]) {
    assert.equal(view.status, "no_matching_events");
    assert.equal(view.totalEventCount, 0);
    assert.equal(view.latestEventDate, null);
    assert.deepEqual(view.latestEvents, []);
    assert.deepEqual(view.categories, []);
  }
  assert.deepEqual(fs.readFileSync(f.databasePath), before);
});

test("missing tag schema is reported without creating it", (t) => {
  const f = fixture(t);
  f.insert("legacy", "2026-09-20", {}, null);
  const before = fs.readFileSync(f.databasePath);
  assert.equal(f.query().status, "tags_unavailable");
  assert.equal(f.query().entities[0].totalEventCount, null);
  assert.deepEqual(fs.readFileSync(f.databasePath), before);
});

test("missing or corrupt database is unavailable, not an empty successful result", (t) => {
  const f = fixture(t);
  const missing = path.join(path.dirname(f.databasePath), "missing.db");
  for (const databasePath of [missing, path.join(__dirname, "strategicMarketIntelligence.test.js")]) {
    const result = f.query({ databasePath });
    assert.equal(result.status, "database_unavailable");
    assert.equal(result.entities[0].status, "database_unavailable");
    assert.equal(result.entities[0].totalEventCount, null);
    assert.deepEqual(result.entities[0].latestEvents, []);
    assert.ok(!JSON.stringify(result).includes(databasePath));
  }
  assert.equal(fs.existsSync(missing), false);
});

test("invalid query options are rejected explicitly", (t) => {
  const f = fixture(t);
  for (const windowDays of [0, -1, 1.5, "30"]) assert.throws(() => f.query({ windowDays }), RangeError);
  assert.throws(() => f.query({ referenceTime: "invalid" }), RangeError);
});

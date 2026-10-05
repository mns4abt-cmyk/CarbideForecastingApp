"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NewsEventStore } = require("../lib/newsEventStore");
const { persistStrategicTags } = require("../lib/strategicMarketTagPersistence");
const { collectStrategicIntelligenceDiagnostics } = require("../lib/strategicIntelligenceDiagnostics");
const referenceTime = "2026-10-01T12:00:00.000Z";
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strategic-diagnostic-"));
  const databasePath = path.join(directory, "events.db");
  const store = new NewsEventStore({ databasePath });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function insert(key, date, title = "Almonty production") {
    store.upsert({ eventId: "shared-id", headline: title, category: "supply", direction: "bearish",
      supplyEffect: "increase", demandEffect: "none", eventStage: "actual", evidenceMaturity: "realized",
      severity: 0.2, confidence: 0.8, globalRelevance: 0.2, chinaRelevance: 0, euRelevance: 0, horizonWeeks: 12,
      duplicateSources: ["Publisher A", "Publisher B", "publisher a"],
    }, { eventKey: key, date, source: "Publisher A", duplicateSources: ["Publisher A", "Publisher B"] });
  }
  return { store, insert, databasePath, query: () => collectStrategicIntelligenceDiagnostics({ databasePath, referenceTime }) };
}
test("counts all history including empty tag records, retains five newest and counts distinct publishers", (t) => {
  const f = fixture(t);
  for (let day = 20; day <= 25; day++) f.insert(`key-${day}`, `2026-09-${day}`);
  f.insert("old", "2026-01-01");
  f.insert("empty-tags", "2026-09-25");
  f.insert("untagged", "2026-09-25");
  persistStrategicTags(f.store, ["old", ...[20,21,22,23,24,25].map(day => `key-${day}`)]);
  f.store.upsertStrategicTags("empty-tags", { entities: [], topics: [] }, "strategic-v1");
  const before = fs.readFileSync(f.databasePath);
  const report = f.query();
  assert.deepEqual(report.counts, { totalStoredEvents: 9, taggedEvents: 8, untaggedEvents: 1 });
  const view = report.entities[0];
  assert.equal(view.eventCount, 6);
  assert.equal(view.newestEvent.eventKey, "key-25");
  assert.equal(view.oldestEvent.eventKey, "key-20");
  assert.deepEqual(view.directionalCounts, { bullish: 0, bearish: 6, neutral: 0 });
  assert.equal(view.topRecentEvents.length, 5);
  assert.equal(view.sourceCount, 2);
  assert.equal(report.duplicateEventIdCollisions[0].eventCount, 9);
  assert.equal(report.entities[1].eventCount, 0);
  assert.deepEqual(fs.readFileSync(f.databasePath), before);
  assert.equal(report.safety.additionalLlmCalls, false);
  assert.equal(report.safety.numericalForecastAdjustmentApplied, false);
});
test("missing tag schema reports all events untagged without creating tables", (t) => {
  const f = fixture(t);
  f.insert("legacy", "2026-09-25");
  const before = fs.readFileSync(f.databasePath);
  const result = f.query();
  assert.equal(result.status, "tags_unavailable");
  assert.deepEqual(result.counts, { totalStoredEvents: 1, taggedEvents: 0, untaggedEvents: 1 });
  assert.equal(result.entities[0].eventCount, null);
  assert.deepEqual(fs.readFileSync(f.databasePath), before);
});
test("missing DB remains absent and is not reported as zero events", (t) => {
  const f = fixture(t);
  const missing = path.join(path.dirname(f.databasePath), "missing.db");
  const result = collectStrategicIntelligenceDiagnostics({ databasePath: missing, referenceTime });
  assert.equal(result.status, "database_unavailable");
  assert.equal(result.counts.totalStoredEvents, null);
  assert.equal(fs.existsSync(missing), false);
});
test("temporary-database writes prove tag idempotency, ID preservation and stable-key duplicate handling", (t) => {
  const f = fixture(t);
  f.insert("a", "2026-09-25");
  f.insert("a", "2026-09-25");
  f.insert("b", "2026-09-25");
  const events = f.store.getAllEvents();
  assert.equal(events.length, 2);
  assert.equal(persistStrategicTags(f.store).changed, 2);
  const tags = f.store.getStrategicTags();
  assert.equal(persistStrategicTags(f.store).changed, 0);
  assert.deepEqual(f.store.getStrategicTags(), tags);
  assert.deepEqual(f.store.getAllEvents(), events);
  assert.equal(f.query().entities[0].eventCount, 2);
});

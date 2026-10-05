"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore } = require("../lib/newsEventStore");
const { persistValidatedEvents } = require("../lib/newsEventPersistence");
const { persistStrategicTags, backfillStrategicTags } = require("../lib/strategicMarketTagPersistence");
const logger = { info() {}, warn() {} };
const evidence = {
  eventId: "event-1", headline: "Almonty and Masan expand tungsten production capacity",
  category: "supply", direction: "bearish", supplyEffect: "increase", demandEffect: "none",
  eventStage: "actual", evidenceMaturity: "realized", severity: 0.2, confidence: 0.8,
  globalRelevance: 0.3, chinaRelevance: 0, euRelevance: 0, horizonWeeks: 26,
};
function setup(t) {
  const store = new NewsEventStore({ databasePath: ":memory:" });
  t.after(() => store.close());
  return store;
}
function insert(store, eventKey = "stable-key", value = evidence) {
  return store.upsert(value, { eventKey, title: value.headline, date: "2026-09-01", source: "Test" });
}

test("inserts multiple queryable tags without changing stored events or IDs", (t) => {
  const store = setup(t);
  const key = insert(store);
  const before = store.getAllEvents();
  assert.deepEqual(persistStrategicTags(store, [key], logger), { ok: true, processed: 1, changed: 1 });
  const [tags] = store.getStrategicTags({ entity: "almonty", topic: "capacity" });
  assert.equal(tags.eventId, "event-1");
  assert.deepEqual(tags.entities, ["almonty", "masan_group"]);
  assert.deepEqual(tags.topics, ["capacity", "production", "supply"]);
  assert.equal(tags.taggingVersion, "strategic-v1");
  assert.ok(Number.isFinite(Date.parse(tags.taggedAt)));
  assert.deepEqual(store.getStrategicTags({ entity: "jinlu" }), []);
  assert.deepEqual(store.getAllEvents(), before);
});

test("reruns are idempotent including taggedAt; changed tags and versions update", (t) => {
  const store = setup(t);
  const key = insert(store);
  persistStrategicTags(store, [key], logger);
  const before = store.getStrategicTags();
  store.now = () => "2026-10-02T00:00:00.000Z";
  assert.equal(persistStrategicTags(store, [key], logger).changed, 0);
  assert.deepEqual(store.getStrategicTags(), before);
  assert.equal(store.upsertStrategicTags(key, { entities: ["jinlu", "jinlu"], topics: [] }, "strategic-v2"), 1);
  assert.equal(store.getStrategicTags().length, 1);
  assert.deepEqual(store.getStrategicTags()[0].entities, ["jinlu"]);
  assert.equal(store.getStrategicTags()[0].taggingVersion, "strategic-v2");
  assert.equal(store.getStrategicTags()[0].taggedAt, "2026-10-02T00:00:00.000Z");
});

test("backfills existing untagged events, persists empty tags, and safely reruns", (t) => {
  const store = setup(t);
  insert(store);
  insert(store, "no-tags", { ...evidence, headline: "Administrative meeting", category: "other", supplyEffect: "none" });
  assert.deepEqual(store.getStrategicTags(), []);
  const options = { createStore: () => ({
    getEventsForStrategicTagging: (...args) => store.getEventsForStrategicTagging(...args),
    upsertStrategicTags: (...args) => store.upsertStrategicTags(...args), close() {},
  }), logger };
  assert.deepEqual(backfillStrategicTags(options), { ok: true, processed: 2, changed: 2 });
  assert.deepEqual(store.getStrategicTags({ eventKey: "no-tags" })[0].entities, []);
  assert.deepEqual(backfillStrategicTags(options), { ok: true, processed: 2, changed: 0 });
  // Refresh-local IDs may repeat: durable event keys keep tag rows distinct.
  assert.equal(store.getStrategicTags({ eventId: "event-1" }).length, 2);
});

test("refresh automatically tags committed events and updates from merged provenance", (t) => {
  const store = setup(t);
  const originalClose = store.close.bind(store);
  store.close = () => {};
  t.after(originalClose);
  const options = { createStore: () => store, logger };
  assert.equal(persistValidatedEvents([evidence], [{ eventKey: "key" }], options).ok, true);
  assert.equal(store.getStrategicTags().length, 1);
  assert.equal(persistValidatedEvents([{ ...evidence, headline: "Jinlu tungsten production" }], [{ eventKey: "key" }], options).ok, true);
  assert.ok(store.getStrategicTags()[0].entities.includes("jinlu"));
});

test("tag database failure cannot roll back events or turn successful persistence into failure", (t) => {
  const store = setup(t);
  const originalClose = store.close.bind(store);
  store.close = () => {};
  t.after(originalClose);
  store.ensureStrategicTagSchema = () => { throw new Error("database is locked"); };
  const result = persistValidatedEvents([evidence], [{ eventKey: "key" }], { createStore: () => store, logger });
  assert.equal(result.ok, true);
  assert.equal(store.getAllEvents().length, 1);
  assert.equal(persistStrategicTags(store, null, logger).ok, false);
  assert.deepEqual(backfillStrategicTags({ createStore() { throw new Error("unavailable"); }, logger }),
    { ok: false, processed: 0, changed: 0 });
});

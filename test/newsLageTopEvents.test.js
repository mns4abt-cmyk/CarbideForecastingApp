"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectTopEvents } = require("../lib/newsLageTopEvents");
const { NewsEventStore } = require("../lib/newsEventStore");
function event(eventKey, overrides = {}) {
  return { eventKey, publishedAt: "2026-10-01T00:00:00Z", firstSeenAt: "2026-10-02T00:00:00Z",
    title: eventKey, sources: ["Publisher A", "Publisher B"], direction: "bullish", category: "supply",
    eventStage: "actual", evidenceMaturity: "realized", effectiveMarketRelevance: 0.2,
    finalWeight: 0.1, ...overrides };
}
test("ranks by unchanged weight, then date, then stable key regardless of input order", () => {
  const events = [event("z"), event("a"), event("new", { publishedAt: "2026-10-02" }),
    event("heavy", { finalWeight: 0.123456789, publishedAt: "2026-09-20" })];
  assert.deepEqual(selectTopEvents(events).map(e => e.eventKey), ["heavy", "new", "a", "z"]);
  assert.equal(selectTopEvents(events)[0].finalWeight, 0.123456789);
  assert.deepEqual(selectTopEvents(events), selectTopEvents([...events].reverse()));
});
test("topN defaults to five, supports zero/large limits and rejects invalid limits", () => {
  const events = Array.from({ length: 7 }, (_, i) => event(String(i)));
  assert.equal(selectTopEvents(events).length, 5);
  assert.equal(selectTopEvents(events, { topN: 2 }).length, 2);
  assert.equal(selectTopEvents(events, { topN: 99 }).length, 7);
  assert.deepEqual(selectTopEvents(events, { topN: 0 }), []);
  for (const topN of [-1, 1.5, Infinity, "5"]) assert.throws(() => selectTopEvents(events, { topN }), RangeError);
  assert.deepEqual(selectTopEvents([]), []);
  assert.deepEqual(selectTopEvents(), []);
  assert.deepEqual(selectTopEvents(null), []);
});
test("requires existing relevance, stable keys and weight strictly above the unchanged cutoff", () => {
  const events = [null, event(""), event(" "), event("bad", { finalWeight: NaN }),
    event("inf", { finalWeight: Infinity }), event("negative", { finalWeight: -1 }),
    event("string", { finalWeight: "0.5" }), event("cutoff", { finalWeight: 1e-12 }),
    event("neutral", { direction: "neutral", finalWeight: 0 }),
    event("irrelevant", { effectiveMarketRelevance: 0 }),
    event("missing", { effectiveMarketRelevance: undefined }),
    event("valid", { finalWeight: 1.0001e-12 })];
  assert.deepEqual(selectTopEvents(events).map(e => e.eventKey), ["valid"]);
});
test("uses existing date precedence and returns only UI fields with detached source metadata", () => {
  const input = [event("fallback", { publishedAt: "invalid" }), event("undated", { publishedAt: null, firstSeenAt: null })];
  const before = structuredClone(input);
  const result = selectTopEvents(input);
  assert.deepEqual(result, [{ eventKey: "fallback", date: "2026-10-02T00:00:00.000Z",
    title: "fallback", source: "Publisher A", provenance: { sources: ["Publisher A", "Publisher B"] },
    direction: "bullish", category: "supply", eventStage: "actual", evidenceMaturity: "realized", finalWeight: 0.1 }]);
  assert.deepEqual(input, before);
  result[0].provenance.sources.push("changed");
  assert.deepEqual(input, before);
});
test("persisted 30-day details expose canonical key without changing event records or weights", () => {
  const store = new NewsEventStore({ databasePath: ":memory:" });
  try {
    store.upsert({ eventId: "existing-id", headline: "China restricts tungsten exports", category: "regulation",
      direction: "bullish", supplyEffect: "decrease", demandEffect: "none", eventStage: "actual",
      evidenceMaturity: "realized", severity: 0.2, confidence: 0.8, globalRelevance: 0,
      chinaRelevance: 1, euRelevance: 0, horizonWeeks: 12,
    }, { eventKey: "stable-key", date: "2026-10-01", source: "Source" });
    const before = store.getAllEvents();
    const details = store.getRecentEventDetails({ market: "china", referenceTime: "2026-10-01T00:00:00Z" });
    assert.equal(details[0].eventKey, "stable-key");
    assert.equal(details[0].eventId, "existing-id");
    assert.equal(selectTopEvents(details)[0].finalWeight, details[0].finalWeight);
    assert.deepEqual(store.getAllEvents(), before);
  } finally { store.close(); }
});

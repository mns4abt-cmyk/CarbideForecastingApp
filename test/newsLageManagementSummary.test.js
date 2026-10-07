"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore } = require("../lib/newsEventStore");
const { loadNewsLageV2 } = require("../lib/newsLageV2");
const { buildNewsLageSummary } = require("../lib/newsLageSummary");
const { selectTopEvents } = require("../lib/newsLageTopEvents");
const referenceTime = "2026-10-05T12:00:00.000Z";
function setup(t, count = 1) {
  const store = new NewsEventStore({ databasePath: ":memory:", now: () => referenceTime });
  t.after(() => store.close());
  for (const market of ["china", "eu"]) for (let i = 0; i < count; i++) {
    store.upsert({ eventId: `${market}-${i}`, headline: `${market} event ${i}`, category: "supply",
      direction: market === "china" ? "bullish" : "bearish", supplyEffect: market === "china" ? "decrease" : "increase",
      demandEffect: "none", eventStage: "actual", evidenceMaturity: "realized", severity: 0.2, confidence: 0.8,
      globalRelevance: 0, chinaRelevance: market === "china" ? 1 : 0, euRelevance: market === "eu" ? 1 : 0, horizonWeeks: 12,
    }, { eventKey: `${market}-${i}`, date: "2026-10-04", source: `${market} source` });
  }
  const reads = [];
  const createStore = () => ({
    getRecentSentiment(options) { reads.push(`sentiment:${options.market}`); return store.getRecentSentiment(options); },
    getRecentEventDetails(options) { reads.push(`events:${options.market}`); return store.getRecentEventDetails(options); },
    close() {},
  });
  return { store, reads, load: (options = {}) => loadNewsLageV2({ createStore, referenceTime, logger: { warn() {} }, ...options }) };
}
test("populated summaries retain independent market labels/counts, select five events and add no reads", (t) => {
  const f = setup(t, 6);
  const result = f.load();
  assert.deepEqual(f.reads, ["sentiment:china", "sentiment:eu", "events:china", "events:eu"]);
  for (const market of ["china", "eu"]) {
    const summary = result.managementSummary[market];
    assert.equal(summary.status, "available");
    assert.equal(summary.qualitativeLabel, result[market].qualitativeLabel);
    assert.equal(summary.totalEventCount, result[market].totalEventCount);
    assert.equal(summary.directionalEventCount, result[market].directionalEventCount);
    assert.equal(summary.topEvents.length, 5);
    assert.ok(summary.topEvents.every(e => e.eventKey.startsWith(market)));
    assert.ok(summary.text.includes(`${market} event`));
    assert.equal(summary.generatedFrom, "validated_30d_events");
    assert.equal(summary.additionalLlmCalls, false);
    assert.equal(summary.numericalForecastAdjustmentApplied, false);
  }
});
test("sparse and empty states use existing deterministic wording", (t) => {
  const sparse = setup(t).load();
  assert.ok(sparse.managementSummary.china.text.includes("china event"));
  const empty = setup(t, 0).load();
  for (const market of ["china", "eu"]) {
    assert.equal(empty.managementSummary[market].status, "empty");
    assert.equal(empty.managementSummary[market].totalEventCount, 0);
    assert.deepEqual(empty.managementSummary[market].topEvents, []);
    assert.ok(empty.managementSummary[market].text.includes("No selected news content"));
  }
});
test("unavailable DB yields unavailable summaries with null counts", () => {
  const result = loadNewsLageV2({ createStore() { throw Error("unavailable"); }, logger: { warn() {} } });
  assert.equal(result.available, false);
  for (const summary of Object.values(result.managementSummary)) {
    assert.equal(summary.status, "unavailable");
    assert.equal(summary.totalEventCount, null);
    assert.equal(summary.directionalEventCount, null);
    assert.equal(summary.qualitativeLabel, "unavailable");
    assert.deepEqual(summary.topEvents, []);
  }
});
test("non-30-day loader behavior is preserved without mislabelling it as a 30-day summary", (t) => {
  const result = setup(t).load({ windowDays: 7 });
  assert.equal(result.available, true);
  assert.equal(result.windowDays, 7);
  assert.equal(result.china.windowDays, 7);
  assert.equal(result.managementSummary.china.status, "unavailable");
  assert.equal(result.managementSummary.eu.status, "unavailable");
});
for (const failedMarket of ["china", "eu"]) for (const failingStep of ["selection", "wording"]) {
  test(`${failedMarket}-only ${failingStep} failure preserves the other summary and all original News-Lage fields`, (t) => {
    const f = setup(t);
    const expected = f.load();
    const result = f.load({
      selectEvents(events) {
        if (failingStep === "selection" && events[0].eventKey.startsWith(failedMarket)) throw Error("private error");
        return selectTopEvents(events);
      },
      buildSummary(input) {
        if (failingStep === "wording" && input.topEvents[0].eventKey.startsWith(failedMarket)) throw Error("private error");
        return buildNewsLageSummary(input);
      },
    });
    assert.equal(result.available, true);
    assert.equal(result.managementSummary[failedMarket].status, "unavailable");
    assert.equal(result.managementSummary[failedMarket].totalEventCount, result[failedMarket].totalEventCount);
    const other = failedMarket === "china" ? "eu" : "china";
    assert.deepEqual(result.managementSummary[other], expected.managementSummary[other]);
    assert.ok(!JSON.stringify(result.managementSummary).includes("private error"));
    delete result.managementSummary;
    delete expected.managementSummary;
    assert.deepEqual(result, expected);
  });
}

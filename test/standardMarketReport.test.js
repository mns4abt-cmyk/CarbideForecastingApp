"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStandardMarketReport } = require("../lib/standardMarketReport");
const generatedAt = "2026-10-01T12:00:00.000Z";
function fixture() {
  const event = (eventKey, date) => ({ eventKey, eventId: "reused", date, title: eventKey, confidence: 0.8 });
  return {
    refresh: { generatedAt, forecastLabels: ["Oct"],
      baseline: { china: { p10: [9], p50: [11], p90: [13] }, eu: { p10: [18], p50: [21], p90: [24] } },
      scenarios: [{ id: "base", kind: "baseline", expectedChange12m: { china: 10, eu: 5 } },
        { id: "supplyShock", kind: "stress_test", china: [12.123], eu: [22], expectedChange12m: { china: 21.23, eu: 10 } },
        { id: "currentMarket", kind: "stress_test", china: [999] }],
      newsLage: { available: true, windowDays: 30, china: { sentimentScore: 12.345, totalEventCount: 2 }, eu: { sentimentScore: -5 } },
      evidenceFusion: { china: { 4: { strength: 0.01234, reliability: "LOW" } } },
      strategicMarketIntelligence: { status: "available", windowDays: 30, entities: {
        almonty: { status: "available", latestEvents: [event("older", "2026-09-15"), event("newer", "2026-09-25")] },
      }, topics: { exportControls: { status: "available", latestEvents: [event("older", "2026-09-15"), event("boundary", "2026-09-01T12:00:00Z")] } } },
    },
    pipelineResult: { china: { reliability: { "4w": { label: "LOW", smape: 8.08 } },
      forecast_horizons: { "4w": { p50: 11.11, changePct: 11.1 } }, selected_model: "Naive", transformation: "raw" } },
  };
}
test("copies numerical layers exactly and excludes base/currentMarket from stress tests", () => {
  const input = fixture();
  const result = buildStandardMarketReport(input);
  assert.deepEqual(result.marketStatus.baseline.data, input.refresh.baseline);
  assert.deepEqual(result.marketStatus.baselineScenario.data, input.refresh.scenarios[0]);
  assert.deepEqual(result.marketStatus.reliability.china.data, input.pipelineResult.china.reliability);
  assert.deepEqual(result.marketStatus.forecastMetadata.china.forecast_horizons, input.pipelineResult.china.forecast_horizons);
  assert.deepEqual(result.newsLage.data, input.refresh.newsLage);
  assert.deepEqual(result.evidenceCheck.data, input.refresh.evidenceFusion);
  assert.deepEqual(result.strategicMarketIntelligence.data, input.refresh.strategicMarketIntelligence);
  assert.deepEqual(result.stressScenarios.data, [input.refresh.scenarios[1]]);
});
test("does not mutate or retain mutable references to inputs and is deterministic", () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = buildStandardMarketReport(input);
  assert.deepEqual(buildStandardMarketReport(input), result);
  assert.deepEqual(input, before);
  result.marketStatus.baseline.data.china.p50[0] = 999;
  result.keyValidatedEvents.events[0].title = "changed";
  assert.deepEqual(input, before);
});
test("key events deduplicate stable keys, not reused event IDs, newest first without scoring", () => {
  const result = buildStandardMarketReport(fixture());
  assert.deepEqual(result.keyValidatedEvents.events.map(e => e.eventKey), ["newer", "older", "boundary"]);
  assert.equal(result.keyValidatedEvents.selection, "newest_first");
  assert.equal(result.keyValidatedEvents.availableEventCount, 3);
  assert.equal(buildStandardMarketReport({ ...fixture(), maxKeyEvents: 1 }).keyValidatedEvents.events.length, 1);
});
test("reporting window boundaries exclude old, future and undated events, using firstSeen fallback", () => {
  const input = fixture();
  input.refresh.strategicMarketIntelligence.entities.almonty.latestEvents.push(
    { eventKey: "old", date: "2026-09-01T11:59:59.999Z" },
    { eventKey: "future", date: "2026-10-01T12:00:00.001Z" },
    { eventKey: "fallback", firstSeenAt: generatedAt }, { eventKey: "undated" },
    { eventId: "no-key", date: generatedAt });
  const report = buildStandardMarketReport(input);
  assert.equal(report.generatedAt, generatedAt);
  assert.equal(report.reportingWindowDays, 30);
  assert.deepEqual(report.reportingWindow, { start: "2026-09-01T12:00:00.000Z", end: generatedAt });
  assert.deepEqual(report.keyValidatedEvents.events.map(e => e.eventKey), ["fallback", "newer", "older", "boundary"]);
  assert.equal(buildStandardMarketReport({ ...input, reportingWindowDays: 1 }).keyValidatedEvents.events.length, 1);
});
test("versioned schema and missing inputs explicitly unavailable, not invented zeros", () => {
  const result = buildStandardMarketReport({ generatedAt });
  assert.equal(result.schemaVersion, "standard-market-report-v1");
  assert.deepEqual(Object.keys(result), ["schemaVersion", "generatedAt", "reportingWindowDays", "reportingWindow",
    "marketStatus", "newsLage", "strategicMarketIntelligence", "keyValidatedEvents", "evidenceCheck", "stressScenarios"]);
  assert.equal(result.marketStatus.baseline.status, "unavailable");
  assert.equal(result.marketStatus.reliability.china.data, null);
  for (const section of ["newsLage", "strategicMarketIntelligence", "evidenceCheck", "stressScenarios"]) {
    assert.deepEqual(result[section], { status: "unavailable", data: null });
  }
  assert.equal(result.keyValidatedEvents.status, "unavailable");
  assert.equal(result.keyValidatedEvents.availableEventCount, null);
});
test("upstream unavailable states are preserved and empty successful event/scenario sets remain distinct", () => {
  const input = fixture();
  input.refresh.newsLage.available = false;
  input.refresh.strategicMarketIntelligence = { status: "database_unavailable", entities: {}, topics: {} };
  assert.equal(buildStandardMarketReport(input).newsLage.status, "unavailable");
  assert.equal(buildStandardMarketReport(input).strategicMarketIntelligence.status, "database_unavailable");
  input.refresh.strategicMarketIntelligence.status = "available";
  input.refresh.scenarios = [];
  const result = buildStandardMarketReport(input);
  assert.equal(result.keyValidatedEvents.status, "empty");
  assert.equal(result.keyValidatedEvents.availableEventCount, 0);
  assert.deepEqual(result.stressScenarios, { status: "available", data: [] });
});
test("pure builder requires a supplied valid timestamp and validates options", () => {
  assert.throws(() => buildStandardMarketReport(), RangeError);
  assert.throws(() => buildStandardMarketReport({ generatedAt: "invalid" }), RangeError);
  for (const reportingWindowDays of [0, -1, 0.5]) assert.throws(() => buildStandardMarketReport({ generatedAt, reportingWindowDays }), RangeError);
  assert.throws(() => buildStandardMarketReport({ generatedAt, maxKeyEvents: 0 }), RangeError);
});

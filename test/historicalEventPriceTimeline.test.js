"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  METHODOLOGY,
  loadHistoricalEventPriceTimeline,
  projectWeeklyPrices,
} = require("../lib/historicalEventPriceTimeline");

const EVENT = {
  eventKey: "event-key",
  eventId: "event-event-key",
  publishedAt: "2026-09-25T00:00:00.000Z",
  firstSeenAt: "2026-09-25T12:00:00.000Z",
  title: "Tungsten supply update",
  category: "supply",
  direction: "bullish",
  supplyEffect: "decrease",
  demandEffect: "neutral",
  eventStage: "realized",
  evidenceMaturity: "realized",
  chinaRelevance: 0.9,
  euRelevance: 0.8,
  provenance: {
    source: "Primary source",
    duplicateSources: ["Primary source", "Syndicated source", "Syndicated source"],
    classifierModel: "must-not-leak",
    articleFingerprints: ["must-not-leak"],
  },
};

const OUTCOME = {
  eventId: "event-event-key",
  market: "china",
  eventDate: "2026-09-25",
  priceAtEventDate: "2026-09-19",
  priceAtEvent: 570,
  unit: "CNY/kg APT",
  horizonWeeks: 4,
  targetDate: "2026-10-23",
  matchedFuturePriceDate: null,
  futurePrice: null,
  returnPct: null,
  status: "pending",
  calculatedAt: "2026-10-06T12:00:00.000Z",
  updatedAt: "2026-10-06T12:00:00.000Z",
};

function createReadOnlyStore({ events = [EVENT], outcomes = [OUTCOME] } = {}) {
  let closed = false;
  return {
    get closed() { return closed; },
    getAllEvents: () => events,
    getPriceOutcomes: ({ eventId }) => outcomes.filter((outcome) => outcome.eventId === eventId),
    upsert: () => assert.fail("timeline must not persist events"),
    upsertMany: () => assert.fail("timeline must not persist events"),
    upsertPriceOutcomes: () => assert.fail("timeline must not persist outcomes"),
    updatePendingPriceOutcomes: () => assert.fail("timeline must not refresh outcomes"),
    close: () => { closed = true; },
  };
}

test("read-only timeline projects only display-safe event data and stored outcomes", async () => {
  const store = createReadOnlyStore();
  const report = await loadHistoricalEventPriceTimeline({
    createStore: () => store,
    loadWeeklySeries: async () => [{ week: "2026-09-25", china_cny_kg: 570, eu_usd_mtu: 2800 }],
  });

  assert.equal(report.available, true);
  assert.equal(store.closed, true);
  assert.deepEqual(Object.keys(report.events[0]).sort(), [
    "category", "chinaRelevance", "demandEffect", "direction", "euRelevance", "eventId", "eventKey",
    "eventStage", "evidenceMaturity", "firstSeenAt", "priceOutcomes", "provenance", "publishedAt",
    "supplyEffect", "title",
  ]);
  assert.deepEqual(report.events[0].provenance, {
    source: "Primary source",
    duplicateSources: ["Primary source", "Syndicated source"],
  });
  assert.equal(JSON.stringify(report.events[0]).includes("must-not-leak"), false);
  assert.deepEqual(report.events[0].priceOutcomes, [OUTCOME]);
});

test("weekly prices reuse normalized rows and preserve separate market units", () => {
  const prices = projectWeeklyPrices([
    { week: "2026-09-25", china_cny_kg: 570, eu_usd_mtu: 2800 },
    { week: "2026-10-02", china_cny_kg: null, eu_usd_mtu: 2810 },
    { week: "2026-10-09", china_cny_kg: -1, eu_usd_mtu: NaN },
  ]);

  assert.deepEqual(prices.china, [{ date: "2026-09-25", value: 570, unit: "CNY/kg APT" }]);
  assert.deepEqual(prices.eu, [
    { date: "2026-09-25", value: 2800, unit: "USD/mtu WO3" },
    { date: "2026-10-02", value: 2810, unit: "USD/mtu WO3" },
  ]);
});

test("methodology explicitly preserves descriptive interpretation and forecast isolation", async () => {
  const report = await loadHistoricalEventPriceTimeline({
    createStore: () => createReadOnlyStore({ events: [], outcomes: [] }),
    loadWeeklySeries: async () => [],
  });

  assert.deepEqual(report.methodology, METHODOLOGY);
  assert.match(report.methodology.interpretation, /no causal interpretation/i);
  assert.equal(report.methodology.numericalForecastAdjustmentApplied, false);
});

test("read failures are unavailable, sanitized, and do not attempt mutation", async () => {
  const warnings = [];
  const report = await loadHistoricalEventPriceTimeline({
    createStore: () => ({
      getAllEvents: () => { throw new Error("secret database path"); },
      close() {},
      upsert: () => assert.fail("timeline must not mutate state"),
    }),
    loadWeeklySeries: async () => assert.fail("price loader should not run after store failure"),
    logger: { warn: (...parts) => warnings.push(parts.join(" ")) },
  });

  assert.equal(report.available, false);
  assert.equal(report.error.code, "historical_event_price_timeline_unavailable");
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.match(warnings[0], /secret database path/);
});

test("server exposes the timeline through an isolated GET route without refresh dependencies", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routeStart = source.indexOf('app.get("/api/historical-event-prices"');
  const routeEnd = source.indexOf("\n});", routeStart) + "\n});".length;
  const route = source.slice(routeStart, routeEnd);

  assert.ok(routeStart >= 0);
  assert.match(route, /loadHistoricalEventPriceTimeline/);
  assert.doesNotMatch(route, /runForecastingPipeline|fetchRealNews|newsClassifier|persistValidatedEvents|refreshPendingEventOutcomes|loadNewsLageV2|buildEvidenceFusionDiagnostics|runCurrentMarketScenario/);
  assert.match(route, /timeline\.available \? 200 : 503/);
});
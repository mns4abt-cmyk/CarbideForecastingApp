"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeContribution,
  aggregateMarketState,
  freshnessWeight,
  DEFAULT_HALF_LIFE_DAYS,
} = require("../lib/newsSignals");

const NOW = new Date("2026-09-01T00:00:00Z");

function isoDaysAgo(days, from = NOW) {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function baseItem(overrides = {}) {
  return {
    date: isoDaysAgo(0),
    category: "supply",
    direction: "bullish",
    severity: 0.8,
    confidence: 0.8,
    chinaRelevance: 1,
    euRelevance: 1,
    ...overrides,
  };
}

test("bullish news produces a positive contribution", () => {
  const item = baseItem({ direction: "bullish" });
  const contribution = computeContribution(item, "china", { now: NOW });
  assert.ok(contribution > 0, `expected positive contribution, got ${contribution}`);
  assert.ok(contribution <= 1);
});

test("bearish news produces a negative contribution", () => {
  const item = baseItem({ direction: "bearish" });
  const contribution = computeContribution(item, "china", { now: NOW });
  assert.ok(contribution < 0, `expected negative contribution, got ${contribution}`);
  assert.ok(contribution >= -1);
});

test("neutral news produces exactly zero contribution regardless of severity/confidence", () => {
  const item = baseItem({ direction: "neutral", severity: 1, confidence: 1 });
  const contribution = computeContribution(item, "china", { now: NOW });
  assert.equal(contribution, 0);
});

test("older news contributes less than identical fresh news (freshness decay)", () => {
  const fresh = baseItem({ date: isoDaysAgo(0) });
  const old = baseItem({ date: isoDaysAgo(30) });

  const freshContribution = computeContribution(fresh, "china", { now: NOW });
  const oldContribution = computeContribution(old, "china", { now: NOW });

  assert.ok(oldContribution > 0, "old bullish news should still be positive");
  assert.ok(
    oldContribution < freshContribution,
    `30-day-old news (${oldContribution}) should not outweigh fresh news (${freshContribution})`
  );
});

test("news older than 30 days never has more influence than fresher news of the same kind", () => {
  const day30 = computeContribution(baseItem({ date: isoDaysAgo(30) }), "china", { now: NOW });
  const day60 = computeContribution(baseItem({ date: isoDaysAgo(60) }), "china", { now: NOW });
  const day90 = computeContribution(baseItem({ date: isoDaysAgo(90) }), "china", { now: NOW });

  assert.ok(day60 < day30);
  assert.ok(day90 < day60);
});

test("freshness weight halves every half-life period", () => {
  const halfLifeDays = 14;
  const atHalfLife = freshnessWeight({ date: isoDaysAgo(halfLifeDays) }, NOW, halfLifeDays);
  const atZero = freshnessWeight({ date: isoDaysAgo(0) }, NOW, halfLifeDays);
  assert.equal(atZero, 1);
  assert.ok(Math.abs(atHalfLife - 0.5) < 1e-9, `expected ~0.5, got ${atHalfLife}`);
});

test("default half-life is 14 days", () => {
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 14);
});

test("low-confidence news contributes close to zero even with high severity", () => {
  const item = baseItem({ direction: "bullish", severity: 1, confidence: 0.02 });
  const contribution = computeContribution(item, "china", { now: NOW });
  assert.ok(contribution > 0);
  assert.ok(contribution < 0.05, `expected near-zero contribution, got ${contribution}`);
});

test("zero confidence produces exactly zero contribution", () => {
  const item = baseItem({ direction: "bullish", severity: 1, confidence: 0 });
  const contribution = computeContribution(item, "china", { now: NOW });
  assert.equal(contribution, 0);
});

test("news relevant to EU but not China only affects the EU score", () => {
  const item = baseItem({ direction: "bullish", chinaRelevance: 0, euRelevance: 1 });
  const chinaContribution = computeContribution(item, "china", { now: NOW });
  const euContribution = computeContribution(item, "eu", { now: NOW });

  assert.equal(chinaContribution, 0);
  assert.ok(euContribution > 0);
});

test("aggregateMarketState returns bounded overall + per-category scores for both regions", () => {
  const items = [
    baseItem({ category: "supply", direction: "bullish", chinaRelevance: 1, euRelevance: 0.2 }),
    baseItem({ category: "demand", direction: "bearish", chinaRelevance: 0.5, euRelevance: 0.5 }),
    baseItem({ category: "regulation", direction: "bullish", chinaRelevance: 0.1, euRelevance: 1 }),
  ];

  const marketState = aggregateMarketState(items, { now: NOW });

  for (const region of ["china", "eu"]) {
    assert.ok(region in marketState);
    for (const key of ["overall", "supply", "demand", "regulation", "geopolitics", "technology", "macro"]) {
      const value = marketState[region][key];
      assert.equal(typeof value, "number");
      assert.ok(value >= -1 && value <= 1, `${region}.${key} = ${value} out of bounds`);
    }
  }

  // EU-Regulatorik-News dominiert eu.regulation (bullish, hohe euRelevance).
  assert.ok(marketState.eu.regulation > 0);
  // Dieselbe News hat kaum China-Relevanz -> china.regulation nahe 0.
  assert.ok(Math.abs(marketState.china.regulation) < 0.2);
});

test("aggregateMarketState returns all-neutral state for an empty news list", () => {
  const marketState = aggregateMarketState([], { now: NOW });
  for (const region of ["china", "eu"]) {
    for (const key of ["overall", "supply", "demand", "regulation", "geopolitics", "technology", "macro"]) {
      assert.equal(marketState[region][key], 0);
    }
  }
});

test("categories with no matching news default to a neutral 0 score", () => {
  const items = [baseItem({ category: "supply", direction: "bullish" })];
  const marketState = aggregateMarketState(items, { now: NOW });
  assert.equal(marketState.china.technology, 0);
  assert.equal(marketState.eu.macro, 0);
});

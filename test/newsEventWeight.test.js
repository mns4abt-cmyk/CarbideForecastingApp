"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NEWS_LAGE_V2_MATURITY_WEIGHTS,
  NEWS_LAGE_V2_GLOBAL_TRANSFER_FACTOR,
  effectiveMarketRelevance,
  eventWeightComponents,
} = require("../lib/newsEventWeight");

const REFERENCE_TIME = "2026-09-30T12:00:00.000Z";

function event(overrides = {}) {
  return {
    publishedAt: REFERENCE_TIME,
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    eventStage: "actual",
    evidenceMaturity: "realized",
    severity: 0.8,
    confidence: 0.9,
    globalRelevance: 0.4,
    chinaRelevance: 0.6,
    euRelevance: 0.2,
    ...overrides,
  };
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to be close to ${expected}`);
}

test("News-Lage v2 returns transparent multiplicative event-weight components", () => {
  const result = eventWeightComponents(event(), "china", REFERENCE_TIME);
  assert.deepEqual({ ...result, finalWeight: 0 }, {
    severityComponent: 0.8,
    confidenceComponent: 0.9,
    maturityComponent: 1,
    relevanceComponent: 0.6,
    freshnessComponent: 1,
    finalWeight: 0,
    directional: true,
  });
  assertClose(result.finalWeight, 0.432);
});

test("News-Lage v2 maturity weights are documented and deterministic", () => {
  assert.deepEqual(NEWS_LAGE_V2_MATURITY_WEIGHTS, {
    realized: 1, prospective: 0.5, speculative: 0.2, unclear: 0,
  });
  assertClose(eventWeightComponents(event({ evidenceMaturity: "prospective", eventStage: "announced" }), "china", REFERENCE_TIME).finalWeight, 0.216);
  assert.equal(eventWeightComponents(event({ evidenceMaturity: "speculative", eventStage: "speculative", supplyEffect: "none", direction: "neutral" }), "china", REFERENCE_TIME).maturityComponent, 0.2);
  assert.equal(eventWeightComponents(event({ evidenceMaturity: "unclear", direction: "neutral", supplyEffect: "none" }), "china", REFERENCE_TIME).maturityComponent, 0);
});

test("News-Lage v2 market relevance uses direct relevance with conservative global transfer", () => {
  const globallyRelevant = event({ globalRelevance: 0.8, chinaRelevance: 0.1, euRelevance: 0 });
  assert.equal(NEWS_LAGE_V2_GLOBAL_TRANSFER_FACTOR, 0.35);
  assertClose(effectiveMarketRelevance(globallyRelevant, "china"), 0.28);
  assertClose(effectiveMarketRelevance(globallyRelevant, "eu"), 0.28);
  assert.equal(effectiveMarketRelevance(globallyRelevant, "global"), 0.8);
});

test("News-Lage v2 event weight incorporates the 10-day freshness component", () => {
  const tenDaysOld = event({ publishedAt: "2026-09-20T12:00:00.000Z" });
  const result = eventWeightComponents(tenDaysOld, "china", REFERENCE_TIME);
  assert.equal(result.freshnessComponent, 0.5);
  assertClose(result.finalWeight, 0.216);
});

test("neutral or causally contradictory events cannot create directional weight", () => {
  const neutral = event({ direction: "neutral", supplyEffect: "none" });
  const contradictory = event({ direction: "bullish", supplyEffect: "increase" });
  for (const candidate of [neutral, contradictory]) {
    const result = eventWeightComponents(candidate, "china", REFERENCE_TIME);
    assert.equal(result.directional, false);
    assert.equal(result.finalWeight, 0);
    assert.equal(result.severityComponent, 0.8);
  }
});

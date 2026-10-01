"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateNewsLageSentiment,
  sentimentLabel,
} = require("../lib/newsEventSentiment");

const REFERENCE_TIME = "2026-09-30T12:00:00.000Z";

function event(overrides = {}) {
  return {
    publishedAt: REFERENCE_TIME,
    firstSeenAt: REFERENCE_TIME,
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    eventStage: "actual",
    evidenceMaturity: "realized",
    severity: 1,
    confidence: 1,
    globalRelevance: 0,
    chinaRelevance: 1,
    euRelevance: 1,
    ...overrides,
  };
}

function aggregate(events, market = "china") {
  return aggregateNewsLageSentiment(events, { market, referenceTime: REFERENCE_TIME });
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to be close to ${expected}`);
}

test("all bullish directional evidence scores +100", () => {
  const result = aggregate([event(), event({ severity: 0.4 })]);
  assert.equal(result.sentimentScore, 100);
  assert.equal(result.sentimentLabel, "stark bullish");
  assert.equal(result.bullishEventCount, 2);
  assert.equal(result.bearishWeight, 0);
});

test("all bearish directional evidence scores -100", () => {
  const result = aggregate([event({ direction: "bearish", supplyEffect: "increase" })]);
  assert.equal(result.sentimentScore, -100);
  assert.equal(result.sentimentLabel, "stark bearish");
  assert.equal(result.bearishEventCount, 1);
});

test("equal bullish and bearish weights are balanced", () => {
  const result = aggregate([event(), event({ direction: "bearish", supplyEffect: "increase" })]);
  assert.equal(result.sentimentScore, 0);
  assert.equal(result.sentimentLabel, "neutral/ausgeglichen");
  assert.equal(result.directionalEventCount, 2);
});

test("no directional evidence is neutral with zero score", () => {
  const result = aggregate([
    event({ direction: "neutral", supplyEffect: "none" }),
    event({ direction: "bullish", supplyEffect: "increase" }),
  ]);
  assert.equal(result.sentimentScore, 0);
  assert.equal(result.directionalEventCount, 0);
  assert.equal(result.neutralEventCount, 2);
});

test("a strong old bullish event loses to a recent bearish event", () => {
  const result = aggregate([
    event({ publishedAt: "2026-08-31T12:00:00.000Z" }),
    event({ direction: "bearish", supplyEffect: "increase", severity: 0.5 }),
  ]);
  assertClose(result.bullishWeight, 0.125);
  assertClose(result.bearishWeight, 0.5);
  assert.equal(result.sentimentScore, -60);
  assert.equal(result.sentimentLabel, "stark bearish");
});

test("mixed weighted evidence uses the documented normalized balance", () => {
  const result = aggregate([
    event({ severity: 0.8, confidence: 0.5 }),
    event({ direction: "bearish", supplyEffect: "increase", severity: 0.2 }),
  ]);
  assertClose(result.bullishWeight, 0.4);
  assertClose(result.bearishWeight, 0.2);
  assertClose(result.sentimentScore, (0.2 / 0.6) * 100);
  assert.equal(result.methodology, "validated_event_weighted_directional_balance");
  assert.equal(result.version, "news-lage-v2");
});

test("score is bounded and label boundaries are exact and non-overlapping", () => {
  assert.equal(aggregate([event()]).sentimentScore, 100);
  assert.equal(aggregate([event({ direction: "bearish", supplyEffect: "increase" })]).sentimentScore, -100);
  assert.deepEqual([
    sentimentLabel(-100), sentimentLabel(-60), sentimentLabel(-59.999), sentimentLabel(-20),
    sentimentLabel(20), sentimentLabel(20.001), sentimentLabel(60), sentimentLabel(100),
  ], [
    "stark bearish", "stark bearish", "bearish", "neutral/ausgeglichen",
    "neutral/ausgeglichen", "bullish", "stark bullish", "stark bullish",
  ]);
});

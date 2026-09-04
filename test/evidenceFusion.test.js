"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fuseEvidence, horizonWeight } = require("../lib/evidenceFusion");

function baseline(forecastChangePct = 2, reliability = "LOW") {
  return { forecastChangePct, reliability };
}

function event(overrides = {}) {
  return {
    eventId: "event-1", direction: "bullish", supplyEffect: "decrease", demandEffect: "none",
    evidenceMaturity: "realized", severity: 0.3, confidence: 0.9,
    globalRelevance: 0, chinaRelevance: 0.9, euRelevance: 0,
    horizonWeeks: 26, duplicateCount: 1, evidenceSource: "news", ...overrides,
  };
}

function fuse(events, overrides = {}) {
  return fuseEvidence({ market: "china", horizonWeeks: 12, baseline: baseline(), events, ...overrides });
}

test("no events returns none and NONE corroboration", () => {
  const result = fuse([]);
  assert.equal(result.newsEvidence.direction, "none");
  assert.equal(result.corroboration, "NONE");
  assert.equal(result.numericalAdjustmentApplied, false);
});

test("neutral and mechanism-free events remain neutral with zero contribution", () => {
  const result = fuse([
    event({ eventId: "neutral", direction: "neutral", supplyEffect: "none", severity: 1 }),
    event({ eventId: "unvalidated", direction: "bullish", supplyEffect: "none", demandEffect: "none", severity: 1 }),
  ]);
  assert.equal(result.newsEvidence.direction, "neutral");
  assert.equal(result.newsEvidence.directionalEvents, 0);
  assert.equal(result.newsEvidence.neutralEvents, 2);
  assert.equal(result.corroboration, "NONE");
});

test("one weak global realized event stays below the directional exposure threshold", () => {
  const result = fuse([event({ severity: 0.2, confidence: 0.8, chinaRelevance: 0, globalRelevance: 0.35 })]);
  assert.equal(result.newsEvidence.direction, "neutral");
  assert.ok(result.newsEvidence.strength < 0.1);
});

test("three agreeing weak global realized events become directional but remain LOW", () => {
  const events = ["a", "b", "c"].map((eventId) => event({ eventId, severity: 0.2, confidence: 0.8, chinaRelevance: 0, globalRelevance: 0.35 }));
  const result = fuse(events);
  assert.equal(result.newsEvidence.direction, "bullish");
  assert.equal(result.corroboration, "LOW");
  assert.ok(result.newsEvidence.strength < 0.2);
});

test("a strong region-specific realized event agreeing with baseline is MEDIUM", () => {
  const result = fuse([event()]);
  assert.equal(result.newsEvidence.direction, "bullish");
  assert.equal(result.agreement, "agree");
  assert.equal(result.corroboration, "MEDIUM");
});

test("multiple strong realized events produce HIGH corroboration", () => {
  const result = fuse(["a", "b", "c"].map((eventId) => event({ eventId })));
  assert.equal(result.newsEvidence.realizedDirectionalEvents, 3);
  assert.equal(result.corroboration, "HIGH");
});

test("opposing baseline and news are conflict and LOW", () => {
  const result = fuse([event({ direction: "bearish", supplyEffect: "increase" })]);
  assert.deepEqual([result.agreement, result.corroboration], ["conflict", "LOW"]);
});

test("balanced bullish and bearish events are mixed and LOW", () => {
  const result = fuse([
    event({ eventId: "bull" }),
    event({ eventId: "bear", direction: "bearish", supplyEffect: "increase" }),
  ]);
  assert.deepEqual([result.newsEvidence.direction, result.agreement, result.corroboration], ["mixed", "mixed", "LOW"]);
});

test("neutral baseline with directional news is news_only and LOW", () => {
  const result = fuse([event()], { baseline: baseline(1.0, "VERY_LOW") });
  assert.deepEqual([result.baselineEvidence.direction, result.agreement, result.corroboration], ["neutral", "news_only", "LOW"]);
});

test("prospective-only agreeing evidence cannot be MEDIUM", () => {
  const result = fuse([event({ evidenceMaturity: "prospective" })]);
  assert.equal(result.newsEvidence.prospectiveDirectionalEvents, 1);
  assert.equal(result.newsEvidence.realizedDirectionalEvents, 0);
  assert.equal(result.corroboration, "LOW");
});

test("duplicateCount never changes fusion output", () => {
  const once = fuse([event({ duplicateCount: 1 })]);
  const many = fuse([event({ duplicateCount: 100 })]);
  assert.deepEqual(many, once);
});

test("market-specific relevance applies only to its specified market", () => {
  const evidence = event({ chinaRelevance: 0.9, euRelevance: 0, globalRelevance: 0 });
  const china = fuse([evidence], { market: "china" });
  const eu = fuse([evidence], { market: "eu" });
  assert.equal(china.newsEvidence.direction, "bullish");
  assert.equal(eu.newsEvidence.direction, "neutral");
});

test("global relevance transfers only through the conservative factor", () => {
  const result = fuse([event({ severity: 1, confidence: 1, chinaRelevance: 0, globalRelevance: 1 })]);
  assert.ok(Math.abs(result.newsEvidence.strength - (1 - Math.exp(-0.7))) < 1e-12);
});

test("short event horizons decay for longer requested horizons", () => {
  const short = event({ horizonWeeks: 4 });
  const near = fuse([short], { horizonWeeks: 4 });
  const long = fuse([short], { horizonWeeks: 26 });
  assert.equal(horizonWeight(4, 4), 1);
  assert.ok(horizonWeight(4, 26) < 1);
  assert.ok(long.newsEvidence.strength < near.newsEvidence.strength);
});

test("extraction confidence ignores neutral events", () => {
  const directional = event({ confidence: 0.8 });
  const neutral = event({ eventId: "neutral", direction: "neutral", supplyEffect: "none", confidence: 0 });
  const result = fuse([directional, neutral]);
  assert.equal(result.newsEvidence.extractionConfidence, 0.8);
});

test("exact positive and negative baseline neutrality boundaries are neutral", () => {
  assert.equal(fuse([], { baseline: baseline(1.0) }).baselineEvidence.direction, "neutral");
  assert.equal(fuse([], { baseline: baseline(-1.0) }).baselineEvidence.direction, "neutral");
});

test("malformed numeric inputs remain finite and contribute zero", () => {
  const result = fuse([event({ severity: Infinity, confidence: "bad", globalRelevance: NaN, chinaRelevance: -4, horizonWeeks: 0 })]);
  assert.equal(result.newsEvidence.direction, "neutral");
  assert.ok(Number.isFinite(result.newsEvidence.strength));
  assert.ok(Number.isFinite(result.newsEvidence.signedBalance));
  assert.ok(Number.isFinite(result.newsEvidence.extractionConfidence));
});

test("baseline reliability is copied unchanged and Fusion never applies a numerical adjustment", () => {
  const result = fuse([event()], { baseline: baseline(2, "VERY_LOW") });
  assert.equal(result.baselineEvidence.reliability, "VERY_LOW");
  assert.equal(result.numericalAdjustmentApplied, false);
  assert.equal(result.baselineEvidence.forecastChangePct, 2);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_MIN_COMPLETED_OUTCOMES,
  METHODOLOGY,
  METHODOLOGY_NOTE,
  aggregateHistoricalEventOutcomes,
  collectHistoricalEventOutcomeAssociations,
  loadHistoricalEventOutcomeAssociations,
} = require("../lib/eventOutcomeAggregation");

function event(eventId, overrides = {}) {
  return {
    eventId,
    category: "regulation",
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    evidenceMaturity: "realized",
    ...overrides,
  };
}

function outcome(eventId, returnPct, overrides = {}) {
  return {
    eventId,
    market: "china",
    horizonWeeks: 4,
    status: "available",
    returnPct,
    ...overrides,
  };
}

test("completed outcomes are deterministically aggregated by validated event type, market, and horizon", () => {
  const report = aggregateHistoricalEventOutcomes({
    events: [event("one"), event("two"), event("three"), event("pending")],
    outcomes: [
      outcome("one", 10),
      outcome("two", -5),
      outcome("three", 0),
      outcome("pending", null, { status: "pending" }),
      outcome("unknown", 30),
    ],
  });

  assert.equal(report.methodology, METHODOLOGY);
  assert.equal(report.methodologyNote, METHODOLOGY_NOTE);
  assert.match(report.methodologyNote, /historical association.*historical subsequent price movement/i);
  assert.equal(report.minCompletedOutcomes, DEFAULT_MIN_COMPLETED_OUTCOMES);
  assert.deepEqual(report.groups, [{
    category: "regulation",
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    evidenceMaturity: "realized",
    market: "china",
    horizonWeeks: 4,
    eventCount: 3,
    completedOutcomeCount: 3,
    insufficientEvidence: false,
    meanReturnPct: 5 / 3,
    medianReturnPct: 0,
    positiveShare: 1 / 3,
    negativeShare: 1 / 3,
    minReturnPct: -5,
    maxReturnPct: 10,
  }]);
});

test("groups below the configured completed-outcome minimum are explicitly insufficient", () => {
  const events = [
    event("one", { category: "mine", direction: "bearish", supplyEffect: "increase", evidenceMaturity: "prospective" }),
    event("two", { category: "mine", direction: "bearish", supplyEffect: "increase", evidenceMaturity: "prospective" }),
  ];
  const outcomes = [
    outcome("one", 3, { market: "eu", horizonWeeks: 12 }),
    outcome("two", -1, { market: "eu", horizonWeeks: 12 }),
  ];
  const insufficient = aggregateHistoricalEventOutcomes({ events, outcomes });
  assert.equal(insufficient.groups.length, 1);
  assert.deepEqual(insufficient.groups[0], {
    category: "mine",
    direction: "bearish",
    supplyEffect: "increase",
    demandEffect: "none",
    evidenceMaturity: "prospective",
    market: "eu",
    horizonWeeks: 12,
    eventCount: 2,
    completedOutcomeCount: 2,
    insufficientEvidence: true,
    meanReturnPct: null,
    medianReturnPct: null,
    positiveShare: null,
    negativeShare: null,
    minReturnPct: null,
    maxReturnPct: null,
  });

  const sufficient = aggregateHistoricalEventOutcomes({ events, outcomes, minCompletedOutcomes: 2 });
  assert.equal(sufficient.groups[0].insufficientEvidence, false);
  assert.equal(sufficient.groups[0].meanReturnPct, 1);
  assert.equal(sufficient.groups[0].medianReturnPct, 1);
  assert.equal(sufficient.groups[0].positiveShare, 0.5);
  assert.equal(sufficient.groups[0].negativeShare, 0.5);
});

test("read-only store adapter passes all durable events and outcomes to the pure aggregation", () => {
  let closed = false;
  const report = collectHistoricalEventOutcomeAssociations({
    databasePath: "analysis-test.db",
    minCompletedOutcomes: 1,
    createStore: () => ({
      getAllEvents: () => [event("one")],
      getPriceOutcomes: ({ eventId }) => [outcome(eventId, 4, { market: "eu", horizonWeeks: 1 })],
      close: () => { closed = true; },
    }),
  });
  assert.equal(closed, true);
  assert.equal(report.groups[0].market, "eu");
  assert.equal(report.groups[0].meanReturnPct, 4);
});

test("minimum completed-outcome validation rejects unsafe values", () => {
  assert.throws(
    () => aggregateHistoricalEventOutcomes({ minCompletedOutcomes: 0 }),
    /integer of at least 1/
  );
});

test("historical association UI preparation isolates a store failure", () => {
  const warnings = [];
  const report = loadHistoricalEventOutcomeAssociations({
    createStore: () => { throw new Error("database is locked"); },
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
  });
  assert.equal(report.available, false);
  assert.deepEqual(report.groups, []);
  assert.match(warnings[0], /Stored outcome history unavailable: database is locked/);
});

test("refresh exposes historical associations additively without connecting them to forecast paths", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /const historicalEventAssociations = loadHistoricalEventOutcomeAssociations\(\{/);
  assert.match(source, /historicalEventAssociations,/);
  const call = source.match(/const historicalEventAssociations = loadHistoricalEventOutcomeAssociations\(\{[\s\S]*?\}\);/)?.[0] || "";
  assert.doesNotMatch(call, /pipelineResult|scenarios|marketState|evidenceFusion|newsLage/);
});

test("refresh invokes pending-only outcome maintenance after event persistence", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /await refreshPendingEventOutcomes\(\{/);
  assert.ok(source.indexOf("persistValidatedEvents(eventEvidence") < source.indexOf("await refreshPendingEventOutcomes"));
  const call = source.match(/await refreshPendingEventOutcomes\(\{[\s\S]*?\}\);/)?.[0] || "";
  assert.doesNotMatch(call, /pipelineResult|scenarios|marketState|evidenceFusion|newsLage/);
});

test("project context documents the retained, read-only historical association layer", () => {
  const context = fs.readFileSync(path.join(__dirname, "..", "PROJECT_CONTEXT.md"), "utf8");
  assert.match(context, /Historical event-price association/);
  assert.match(context, /latest valid observation on or before the event date/);
  assert.match(context, /never modify P50, model selection, reliability, Evidence Fusion, News-Lage sentiment/);
});

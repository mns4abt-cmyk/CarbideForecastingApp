"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MIN_DIRECTIONAL_EVENTS,
  METHODOLOGY,
  METHODOLOGY_NOTE,
  validateHistoricalEventDirections,
  collectHistoricalDirectionValidation,
} = require("../lib/eventDirectionValidation");

function event(eventId, direction) {
  return { eventId, direction };
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

test("directional validation compares completed bullish and bearish events with subsequent movement", () => {
  const report = validateHistoricalEventDirections({
    events: [event("bullish-hit", "bullish"), event("bullish-miss", "bullish"), event("bearish-hit", "bearish"), event("neutral", "neutral")],
    outcomes: [
      outcome("bullish-hit", 5),
      outcome("bullish-miss", -2),
      outcome("bearish-hit", -3),
      outcome("neutral", 9),
      outcome("bullish-hit", null, { horizonWeeks: 12, status: "pending" }),
    ],
  });

  assert.equal(report.methodology, METHODOLOGY);
  assert.equal(report.methodologyNote, METHODOLOGY_NOTE);
  assert.match(report.methodologyNote, /historical association/i);
  assert.equal(report.minDirectionalEvents, DEFAULT_MIN_DIRECTIONAL_EVENTS);
  assert.deepEqual(report.groups, [{
    market: "china",
    horizonWeeks: 4,
    completedOutcomeCount: 4,
    directionalEventCount: 3,
    correctDirectionCount: 2,
    insufficientEvidence: false,
    evidenceStatus: "sufficient_sample",
    directionalHitRate: 2 / 3,
    medianReturnBullishEvents: 1.5,
    medianReturnBearishEvents: -3,
  }]);
});

test("below the directional minimum retains raw counts but suppresses rate and median statistics", () => {
  const report = validateHistoricalEventDirections({
    events: [event("bullish", "bullish"), event("bearish", "bearish"), event("neutral", "neutral")],
    outcomes: [
      outcome("bullish", 2, { market: "eu", horizonWeeks: 12 }),
      outcome("bearish", -1, { market: "eu", horizonWeeks: 12 }),
      outcome("neutral", 10, { market: "eu", horizonWeeks: 12 }),
    ],
  });
  assert.deepEqual(report.groups, [{
    market: "eu",
    horizonWeeks: 12,
    completedOutcomeCount: 3,
    directionalEventCount: 2,
    correctDirectionCount: 2,
    insufficientEvidence: true,
    evidenceStatus: "insufficient_evidence",
    directionalHitRate: null,
    medianReturnBullishEvents: null,
    medianReturnBearishEvents: null,
  }]);
});

test("zero returns are directional misses and neutral-only groups cannot create a hit rate", () => {
  const report = validateHistoricalEventDirections({
    events: [event("flat", "bullish"), event("neutral", "neutral")],
    outcomes: [outcome("flat", 0), outcome("neutral", -4)],
    minDirectionalEvents: 1,
  });
  assert.deepEqual(report.groups[0], {
    market: "china",
    horizonWeeks: 4,
    completedOutcomeCount: 2,
    directionalEventCount: 1,
    correctDirectionCount: 0,
    insufficientEvidence: false,
    evidenceStatus: "sufficient_sample",
    directionalHitRate: 0,
    medianReturnBullishEvents: 0,
    medianReturnBearishEvents: null,
  });
});

test("read-only adapter loads durable records and minimum validation rejects unsafe values", () => {
  let closed = false;
  const report = collectHistoricalDirectionValidation({
    minDirectionalEvents: 1,
    createStore: () => ({
      getAllEvents: () => [event("event-1", "bearish")],
      getPriceOutcomes: ({ eventId }) => [outcome(eventId, -2, { market: "eu", horizonWeeks: 1 })],
      close: () => { closed = true; },
    }),
  });
  assert.equal(closed, true);
  assert.equal(report.groups[0].directionalHitRate, 1);
  assert.throws(
    () => validateHistoricalEventDirections({ minDirectionalEvents: 0 }),
    /integer of at least 1/
  );
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  METHODOLOGY_NOTE,
  collectEventOutcomeDiagnostics,
} = require("../lib/eventOutcomeDiagnostics");

function outcome(horizonWeeks, overrides = {}) {
  return {
    horizonWeeks,
    priceAtEvent: 100,
    status: "available",
    returnPct: horizonWeeks === 1 ? 5 : 0,
    ...overrides,
  };
}

test("event outcome diagnostic reports market counts and compact non-causal samples", () => {
  const event = {
    eventId: "event-1",
    publishedAt: "2026-09-04T12:00:00.000Z",
    firstSeenAt: "2026-09-05T12:00:00.000Z",
    title: "China tungsten export controls take effect",
    direction: "bullish",
    chinaRelevance: 1,
    euRelevance: 0,
    globalRelevance: 0,
  };
  const report = collectEventOutcomeDiagnostics({
    databasePath: "diagnostic-test.db",
    createStore: () => ({
      getAllEvents: () => [event],
      getPriceOutcomes: ({ market }) => market === "china"
        ? [
          outcome(1), outcome(4, { status: "pending", returnPct: null }),
          outcome(12, { status: "unavailable", priceAtEvent: null, returnPct: null }), outcome(26),
        ]
        : [],
      close() {},
    }),
  });
  assert.equal(report.methodologyNote, METHODOLOGY_NOTE);
  assert.match(report.methodologyNote, /historical association|subsequent price movement/i);
  assert.deepEqual(report.china, {
    storedEventCount: 1,
    eventsWithPriceAtEvent: 1,
    completed1wOutcomes: 1,
    completed4wOutcomes: 0,
    completed12wOutcomes: 0,
    completed26wOutcomes: 1,
    pendingOutcomes: 1,
    unavailableOutcomes: 1,
    sampleEvents: [{
      eventId: "event-1",
      date: "2026-09-04T12:00:00.000Z",
      title: "China tungsten export controls take effect",
      direction: "bullish",
      priceAtEvent: 100,
      return1w: 5,
      return4w: null,
      return12w: null,
      return26w: 0,
    }],
  });
  assert.deepEqual(report.eu, {
    storedEventCount: 0,
    eventsWithPriceAtEvent: 0,
    completed1wOutcomes: 0,
    completed4wOutcomes: 0,
    completed12wOutcomes: 0,
    completed26wOutcomes: 0,
    pendingOutcomes: 0,
    unavailableOutcomes: 0,
    sampleEvents: [],
  });
});

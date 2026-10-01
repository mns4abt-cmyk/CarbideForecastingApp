"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FORWARD_MATCH_TOLERANCE_DAYS,
  associateEventPrice,
  associateEventPriceOutcomes,
} = require("../lib/eventPriceAssociation");

const WEEKLY_SERIES = [
  { week: "2026-09-04", china_cny_kg: 100, eu_usd_mtu: 300 },
  { week: "2026-09-11", china_cny_kg: 102, eu_usd_mtu: 305 },
  { week: "2026-09-18", china_cny_kg: 104, eu_usd_mtu: 310 },
];

test("uses the normalized weekly observation on an exact event date", () => {
  assert.deepEqual(associateEventPrice({
    market: "china", eventDate: "2026-09-11", weeklySeries: WEEKLY_SERIES,
  }), {
    market: "china",
    eventDate: "2026-09-11",
    matchedPriceDate: "2026-09-11",
    priceAtEvent: 102,
    unit: "CNY/kg APT",
    available: true,
    reason: null,
  });
});

test("uses the preceding Friday for a weekend event and never a future price", () => {
  const result = associateEventPrice({
    market: "eu", eventDate: "2026-09-13", weeklySeries: WEEKLY_SERIES,
  });
  assert.equal(result.matchedPriceDate, "2026-09-11");
  assert.equal(result.priceAtEvent, 305);
  assert.equal(result.unit, "USD/mtu WO3");
});

test("uses the latest available observation for an event between weekly observations", () => {
  const result = associateEventPrice({
    market: "china", eventDate: "2026-09-16T08:00:00.000Z", weeklySeries: WEEKLY_SERIES,
  });
  assert.equal(result.eventDate, "2026-09-16");
  assert.equal(result.matchedPriceDate, "2026-09-11");
  assert.equal(result.priceAtEvent, 102);
});

test("returns an explicit unavailable result before the first historical observation", () => {
  assert.deepEqual(associateEventPrice({
    market: "eu", eventDate: "2026-09-03", weeklySeries: WEEKLY_SERIES,
  }), {
    market: "eu",
    eventDate: "2026-09-03",
    matchedPriceDate: null,
    priceAtEvent: null,
    unit: "USD/mtu WO3",
    available: false,
    reason: "no_historical_price",
  });
});

test("skips missing normalized weeks rather than manufacturing a price", () => {
  const result = associateEventPrice({
    market: "china",
    eventDate: "2026-09-18",
    weeklySeries: [
      { week: "2026-09-04", china_cny_kg: 100 },
      { week: "2026-09-11", china_cny_kg: null },
      { week: "2026-09-18", china_cny_kg: null },
    ],
  });
  assert.equal(result.matchedPriceDate, "2026-09-04");
  assert.equal(result.priceAtEvent, 100);
});

function outcome(result, horizonWeeks) {
  return result.outcomes.find((item) => item.horizonWeeks === horizonWeeks);
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to be close to ${expected}`);
}

test("calculates positive, negative, and unchanged realized forward returns", () => {
  const result = associateEventPriceOutcomes({
    market: "china",
    eventDate: "2026-09-04",
    referenceDate: "2027-03-31",
    weeklySeries: [
      { week: "2026-09-04", china_cny_kg: 100 },
      { week: "2026-09-11", china_cny_kg: 105 },
      { week: "2026-10-02", china_cny_kg: 90 },
      { week: "2026-11-27", china_cny_kg: 100 },
      { week: "2027-03-05", china_cny_kg: 110 },
    ],
  });
  assert.equal(outcome(result, 1).targetDate, "2026-09-11");
  assert.equal(outcome(result, 1).matchedPriceDate, "2026-09-11");
  assert.equal(outcome(result, 1).futurePrice, 105);
  assert.equal(outcome(result, 1).status, "available");
  assertClose(outcome(result, 1).returnPct, 5);
  assertClose(outcome(result, 4).returnPct, -10);
  assert.equal(outcome(result, 12).returnPct, 0);
});

test("returns unavailable when an elapsed horizon has no normalized price within tolerance", () => {
  const result = associateEventPriceOutcomes({
    market: "eu",
    eventDate: "2026-09-04",
    referenceDate: "2026-11-01",
    weeklySeries: [{ week: "2026-09-04", eu_usd_mtu: 300 }],
  });
  assert.deepEqual(outcome(result, 4), {
    horizonWeeks: 4, targetDate: "2026-10-02", matchedPriceDate: null,
    futurePrice: null, returnPct: null, available: false, status: "unavailable", reason: "no_price_within_tolerance",
  });
});

test("returns pending rather than fabricating outcomes whose target date has not occurred", () => {
  const result = associateEventPriceOutcomes({
    market: "china",
    eventDate: "2026-09-18",
    referenceDate: "2026-09-24",
    weeklySeries: [
      { week: "2026-09-18", china_cny_kg: 104 },
      { week: "2026-09-25", china_cny_kg: 106 },
    ],
  });
  for (const item of result.outcomes) {
    assert.equal(item.available, false);
    assert.equal(item.status, "pending");
    assert.equal(item.reason, "target_date_not_reached");
  }
});

test("matches the first valid weekly observation at the inclusive tolerance boundary", () => {
  assert.equal(FORWARD_MATCH_TOLERANCE_DAYS, 7);
  const result = associateEventPriceOutcomes({
    market: "eu",
    eventDate: "2026-09-04",
    referenceDate: "2026-10-01",
    weeklySeries: [
      { week: "2026-09-04", eu_usd_mtu: 300 },
      // The 1-week target is 2026-09-11; this is exactly seven days later.
      { week: "2026-09-18", eu_usd_mtu: 330 },
    ],
  });
  const oneWeek = outcome(result, 1);
  assert.equal(oneWeek.matchedPriceDate, "2026-09-18");
  assert.equal(oneWeek.futurePrice, 330);
  assertClose(oneWeek.returnPct, 10);
});

test("can calculate only explicitly requested pending horizons", () => {
  const result = associateEventPriceOutcomes({
    market: "china",
    eventDate: "2026-09-04",
    referenceDate: "2026-10-31",
    weeklySeries: WEEKLY_SERIES,
    horizons: [4],
  });
  assert.deepEqual(result.outcomes.map((outcome) => outcome.horizonWeeks), [4]);
});

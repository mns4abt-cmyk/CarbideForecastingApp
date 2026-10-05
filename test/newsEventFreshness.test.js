"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NEWS_LAGE_V2_HALF_LIFE_DAYS, freshnessWeight } = require("../lib/newsEventFreshness");

const REFERENCE_TIME = "2026-09-30T12:00:00.000Z";

function eventAt(daysAgo) {
  return {
    publishedAt: new Date(new Date(REFERENCE_TIME).getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    firstSeenAt: REFERENCE_TIME,
  };
}

test("News-Lage v2 freshness has the documented 10-day half-life", () => {
  assert.equal(NEWS_LAGE_V2_HALF_LIFE_DAYS, 10);
  assert.equal(freshnessWeight(eventAt(0), REFERENCE_TIME), 1);
  assert.equal(freshnessWeight(eventAt(10), REFERENCE_TIME), 0.5);
  assert.equal(freshnessWeight(eventAt(20), REFERENCE_TIME), 0.25);
  assert.equal(freshnessWeight(eventAt(30), REFERENCE_TIME), 0.125);
});

test("News-Lage v2 freshness falls back to firstSeenAt when publishedAt is unavailable", () => {
  assert.equal(freshnessWeight({ publishedAt: "invalid", firstSeenAt: eventAt(10).publishedAt }, REFERENCE_TIME), 0.5);
});

test("News-Lage v2 freshness rejects invalid event and reference timestamps", () => {
  assert.equal(freshnessWeight({ publishedAt: "not-a-date" }, REFERENCE_TIME), 0);
  assert.equal(freshnessWeight(eventAt(0), "not-a-date"), 0);
});

test("News-Lage v2 freshness treats future timestamps as current", () => {
  assert.equal(freshnessWeight({ publishedAt: "2026-10-01T12:00:00.000Z" }, REFERENCE_TIME), 1);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const timeline = require("../public/js/historicalEventTimeline");

function event(overrides = {}) {
  return {
    eventId: "event-1",
    publishedAt: "2026-09-25T00:00:00.000Z",
    firstSeenAt: "2026-09-25T12:00:00.000Z",
    title: "Tungsten supply event",
    category: "supply",
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "neutral",
    eventStage: "realized",
    evidenceMaturity: "realized",
    priceOutcomes: [{ market: "china", horizonWeeks: 1, priceAtEvent: 570, unit: "CNY/kg APT", status: "available" }],
    ...overrides,
  };
}

const filters = { category: "all", direction: "all", stage: "all", maturity: "all" };

test("event filters select only market-linked events and apply simple frontend fields", () => {
  const events = [event(), event({ eventId: "event-2", category: "regulation", direction: "bearish", priceOutcomes: [{ market: "eu", horizonWeeks: 1, priceAtEvent: 2800, unit: "USD/mtu WO3", status: "available" }] })];
  assert.equal(timeline.filterEvents(events, "china", filters).length, 1);
  assert.equal(timeline.filterEvents(events, "eu", { ...filters, category: "regulation", direction: "bearish" })[0].eventId, "event-2");
});

test("association summaries exclude insufficient evidence and absent medians", () => {
  const groups = timeline.associationGroups({ available: true, groups: [
    { market: "china", horizonWeeks: 1, insufficientEvidence: false, medianReturnPct: 1.2 },
    { market: "china", horizonWeeks: 1, insufficientEvidence: true, medianReturnPct: null },
    { market: "eu", horizonWeeks: 1, insufficientEvidence: false, medianReturnPct: 2.3 },
  ] }, "china", 1);
  assert.deepEqual(groups, [{ market: "china", horizonWeeks: 1, insufficientEvidence: false, medianReturnPct: 1.2 }]);
});

test("event categories map deterministically to human-readable categorical lanes", () => {
  assert.equal(timeline.categoryLane("supply").label, "Angebot");
  assert.equal(timeline.categoryLane("technology").label, "Unternehmen / Produktion");
  assert.equal(timeline.categoryLane("macro").label, "Sonstige");
});

test("same-date events in the same category become one non-quantitative cluster", () => {
  const range = { start: Date.parse("2026-09-01"), end: Date.parse("2026-10-01"), span: 30 * 24 * 60 * 60 * 1000 };
  const clusters = timeline.clusterEvents([event(), event({ eventId: "event-2", title: "Second supply event" })], range);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].events.length, 2);
  assert.equal(clusters[0].lane.label, "Angebot");
});

test("separate charts align event dates with a selected matched price observation", () => {
  const points = [
    { date: "2026-09-19", value: 560, unit: "CNY/kg APT" },
    { date: "2026-09-26", value: 570, unit: "CNY/kg APT" },
  ];
  const selected = event({ marketOutcomes: [{ market: "china", horizonWeeks: 1, priceAtEventDate: "2026-09-19", priceAtEvent: 560, unit: "CNY/kg APT", status: "available" }] });
  const range = timeline.sharedRange(points, [selected], "12");
  const eventChart = timeline.projectEventChart([selected], "event-1", range);
  const priceChart = timeline.projectPriceChart(points, selected, range);
  assert.match(eventChart, /Markt-Ereignisse nach Kategorie/);
  assert.match(eventChart, /event-lane-label/);
  assert.match(eventChart, /data-event-id="event-1"/);
  assert.doesNotMatch(eventChart, /timeline-price-line/);
  assert.match(priceChart, /timeline-price-line/);
  assert.match(priceChart, /selected-event-guide/);
  assert.match(priceChart, /matched-price-observation/);
});
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const panel = require("../public/js/historicalAssociationPanel");

function group(overrides = {}) {
  return {
    category: "regulation",
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    evidenceMaturity: "realized",
    market: "china",
    horizonWeeks: 4,
    eventCount: 8,
    completedOutcomeCount: 8,
    insufficientEvidence: false,
    medianReturnPct: 6.2,
    ...overrides,
  };
}

test("historical association panel presents event counts and median returns without rankings", () => {
  const html = panel.render({
    report: {
      available: true,
      minCompletedOutcomes: 3,
      groups: [group(), group({ horizonWeeks: 12, medianReturnPct: 11.4 })],
    },
    region: "china",
  });
  assert.match(html, /Kategorie: regulation/);
  assert.match(html, /China/);
  assert.match(html, /8.*abgeschlossene Ereignisse/);
  assert.match(html, /4 Wochen/);
  assert.match(html, /12 Wochen/);
  assert.match(html, /Median nachfolgende Rendite/);
  assert.match(html, /\+6,2%/);
  assert.match(html, /\+11,4%/);
  assert.doesNotMatch(html, /Rang|Empfehlung/i);
});

test("insufficient evidence is marked and does not display a median as zero", () => {
  const html = panel.render({
    report: {
      available: true,
      minCompletedOutcomes: 3,
      groups: [group({ eventCount: 2, completedOutcomeCount: 2, insufficientEvidence: true, medianReturnPct: null })],
    },
    region: "china",
  });
  assert.match(html, /Unzureichende Datenbasis \(n=2, mindestens 3\)/);
  assert.doesNotMatch(html, /0,0%/);
});

test("panel filters deterministic groups by market and handles unavailable data", () => {
  const report = {
    available: true,
    minCompletedOutcomes: 3,
    groups: [group(), group({ market: "eu", category: "supply", medianReturnPct: -2.5 })],
  };
  assert.match(panel.render({ report, region: "eu" }), /Kategorie: supply/);
  assert.doesNotMatch(panel.render({ report, region: "eu" }), /Kategorie: regulation/);
  assert.match(panel.render({ report: { available: false }, region: "both" }), /derzeit nicht verf\u00fcgbar/);
});

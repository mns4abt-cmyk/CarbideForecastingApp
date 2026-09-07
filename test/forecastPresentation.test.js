"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const presentation = require("../public/js/forecastPresentation");

test("market-specific unit display uses native units and the Both index", () => {
  assert.equal(presentation.unitForRegion("china"), "CNY/kg APT");
  assert.equal(presentation.unitForRegion("eu"), "USD/mtu WO3");
  assert.equal(presentation.unitForRegion("both"), "Index (Heute = 100)");
  assert.equal(presentation.nonNegativeAxisMinimum(-12, true), 0);
  assert.equal(presentation.nonNegativeAxisMinimum(85, true), 85);
  assert.equal(presentation.nonNegativeAxisMinimum(-12, false), -12);
});

test("scenario presentation keeps absolute changes unchanged and derives percentage-point deltas", () => {
  const baseline = { id: "base", expectedChange12m: { china: -2.5, eu: -51.0 } };
  const scenario = { id: "supplyShock", expectedChange12m: { china: 5.5, eu: -38.0 } };
  const before = structuredClone(scenario);

  assert.equal(presentation.scenarioDeltaPct(scenario, baseline, "china"), 8);
  assert.equal(presentation.scenarioDeltaPct(scenario, baseline, "eu"), 13);
  assert.equal(presentation.formatPercentagePointDelta(13), "vs. Basis: +13.0 %-Pkt.");
  assert.equal(presentation.formatPercentagePointDelta(-13), "vs. Basis: -13.0 %-Pkt.");
  assert.equal(presentation.shouldShowScenarioDelta(baseline), false);
  assert.equal(presentation.shouldShowScenarioDelta(scenario), true);
  assert.deepEqual(scenario, before);
});

test("frontend copy identifies historical stress calibration and separate news interpretation", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(index, /News-Lage/);
  assert.match(index, /Separate Einordnung/);
  assert.match(index, /keine Anpassung der statistischen Baseline/);
  assert.match(index, /Historisch kalibrierte Stressszenarien relativ zur statistischen Baseline/);
  assert.doesNotMatch(index, /News-adjustiert/);
});

test("footer and News-Lage copy are provider-neutral and identify the separate news scenario", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(index, /Stimmen des Marktes/);
  assert.match(index, /Separates 12M-News-Szenario/);
  assert.match(index, /News-Szenario im Chart anzeigen/);
  assert.doesNotMatch(index, /Bosch Model Farm/);
  assert.doesNotMatch(index, /Google News/);
});

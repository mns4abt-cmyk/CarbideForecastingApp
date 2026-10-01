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
  assert.match(index, /statistischen Preisforecast nicht/);
  assert.match(index, /Historisch kalibrierte Stressszenarien relativ zur statistischen Baseline/);
  assert.doesNotMatch(index, /News-adjustiert/);
});

test("footer and News-Lage copy are provider-neutral and retain a v2 history path", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  assert.match(index, /Stimmen des Marktes/);
  assert.match(index, /News-Lage &ndash; letzte 30 Tage/);
  assert.match(index, /Der Sentiment Score wird deterministisch aus validierten Nachrichtenereignissen der letzten 30 Tage berechnet/);
  assert.match(index, /Ereignisse der letzten 30 Tage/);
  assert.match(index, /Ereignis- und Preisverlauf/);
  assert.match(index, /zeitliche Zusammenh&auml;nge nach einem Ereignis und keine nachgewiesene Kausalit&auml;t/);
  assert.match(index, /Historische Ereignisassoziationen/);
  assert.match(index, /historische nachfolgende Preisbewegungen und keine nachgewiesene kausale Wirkung/);
  assert.match(index, /-100[\s\S]*0[\s\S]*\+100/);
  assert.match(app, /NEWS_LAGE: json\.newsLage \|\| null/);
  assert.match(app, /function renderNewsLageV2Card/);
  assert.match(app, /gespeicherte Ereignisse/);
  assert.match(app, /mit validierter Richtung/);
  assert.match(app, /newsLageEventsContent/);
  assert.match(app, /eventOutcomesPanel/);
  assert.match(app, /Preis zum Ereignis/);
  assert.match(app, /Ausstehend/);
  assert.match(app, /Nicht verf\\u00fcgbar/);
  assert.match(app, /priceOutcomes/);
  assert.match(app, /HISTORICAL_EVENT_ASSOCIATIONS: json\.historicalEventAssociations \|\| null/);
  assert.match(app, /renderHistoricalAssociations/);
  assert.match(app, /Deterministisches Ereignisgewicht/);
  assert.match(app, /renderCurrentMarketCard\(\);/);
  assert.match(app, /currentMarketToggleWrap\.hidden = true/);
  assert.doesNotMatch(index, /Bosch Model Farm/);
  assert.doesNotMatch(index, /Google News/);
});

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

test("market switching uses the correct main-chart Y-axis labels", () => {
  assert.equal(presentation.chartYAxisLabelForRegion("china"), "Preis (CNY/kg APT)");
  assert.equal(presentation.chartYAxisLabelForRegion("eu"), "Preis (USD/mtu WO₃)");
  assert.equal(presentation.chartYAxisLabelForRegion("both"), "Index (Heute = 100)");

  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  const chart = fs.readFileSync(path.join(__dirname, "..", "public", "js", "chart.js"), "utf8");
  assert.match(app, /chartYAxisLabelForRegion\(state\.region\)/);
  assert.match(chart, /yAxisTitle\.textContent = cfg\.yAxisLabel \|\| unit/);
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

test("China native-price axis starts at zero and rounds the visible maximum upward", () => {
  const bounds = presentation.chartYAxisBounds({ series: [{ data: [2980, 3140, 3015] }] });
  assert.deepEqual(bounds, { min: 0, max: 3500 });
});

test("EU native-price axis includes a P90 maximum and uses a clean ceiling", () => {
  const bounds = presentation.chartYAxisBounds({
    series: [{ data: [610, 657] }],
    bands: [{ p10: [590, 600], p50: [620, 640], p90: [650, 657] }],
  });
  assert.deepEqual(bounds, { min: 0, max: 750 });
});

test("historical-only native chart ignores absent forecasts while retaining zero minimum", () => {
  assert.deepEqual(presentation.chartYAxisBounds({ series: [{ data: [500, 540, 560] }], bands: [] }),
    { min: 0, max: 750 });
});

test("visible scenario values expand the native price chart while hidden scenarios do not", () => {
  const historical = [{ data: [600, 650] }];
  assert.deepEqual(presentation.chartYAxisBounds({ series: [...historical, { data: [650, 900] }] }),
    { min: 0, max: 1000 });
  assert.deepEqual(presentation.chartYAxisBounds({ series: historical }), { min: 0, max: 750 });
});

test("native price bounds handle near-zero, null, and invalid values without clipping finite data", () => {
  assert.deepEqual(presentation.chartYAxisBounds({ series: [{ data: [0, 0.004, null, NaN, Infinity] }] }),
    { min: 0, max: 0.005 });
  assert.deepEqual(presentation.chartYAxisBounds({ series: [{ data: [null, NaN, Infinity] }] }),
    { min: 0, max: 1 });
});

test("Both mode keeps index data on an independently padded index axis", () => {
  const bounds = presentation.chartYAxisBounds({
    indexMode: true,
    series: [{ data: [90, 100, 105] }, { data: [95, 100, 102] }],
    bands: [{ p10: [null, 97, 98], p50: [null, 100, 102], p90: [null, 104, 106] }],
  });
  assert.deepEqual(bounds, { min: 85, max: 110 });
  assert.notEqual(bounds.min, 0);
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
  const management = require("../public/js/newsLageManagementPanel").render();
  assert.match(management, /Validierte Ereignisse/);
  assert.match(management, /Gerichtete Ereignisse/);
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

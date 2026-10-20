"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const presentation = require("../public/js/forecastPresentation");

test("market-specific unit display uses native units, including the Both view", () => {
  assert.equal(presentation.unitForRegion("china"), "CNY/kg APT");
  assert.equal(presentation.unitForRegion("eu"), "USD/mtu WO₃");
  assert.equal(presentation.unitForRegion("both"), "China: CNY/kg APT | EU: USD/mtu WO₃");
  assert.equal(presentation.nonNegativeAxisMinimum(-12, true), 0);
  assert.equal(presentation.nonNegativeAxisMinimum(85, true), 85);
  assert.equal(presentation.nonNegativeAxisMinimum(-12, false), -12);
});

test("market switching uses the correct native-price Y-axis labels", () => {
  assert.equal(presentation.chartYAxisLabelForRegion("china"), "Preis (CNY/kg APT)");
  assert.equal(presentation.chartYAxisLabelForRegion("eu"), "Preis (USD/mtu WO₃)");
  assert.equal(presentation.chartYAxisLabelForRegion("both"), "Getrennte native Preisachsen");

  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  const chart = fs.readFileSync(path.join(__dirname, "..", "public", "js", "chart.js"), "utf8");
  assert.match(app, /chartYAxisLabelForRegion\(region\)/);
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

test("uncertainty-band visibility removes P10/P90 from the native-price axis and restores them", () => {
  const series = [{ data: [610, 657] }]; // P50/baseline stays visible independently.
  const p10p90Band = [{ p10: [590, 600], p50: [620, 640], p90: [650, 900] }];

  // Default: the checked control supplies the P10/P90 band to the chart.
  assert.deepEqual(presentation.chartYAxisBounds({ series, bands: p10p90Band }), { min: 0, max: 1000 });
  // Hide: only the band is omitted, so P50's scenario line still sets the scale.
  assert.deepEqual(presentation.chartYAxisBounds({ series, bands: [] }), { min: 0, max: 750 });
  // Show again: the original interval scale returns unchanged.
  assert.deepEqual(presentation.chartYAxisBounds({ series, bands: p10p90Band }), { min: 0, max: 1000 });
});

test("master overlay control hides and restores only optional layers", () => {
  const optionalScenarioIds = ["supplyShock", "demandShock", "currentMarket"];
  const initial = { showUncertaintyBand: true, activeScenarioIds: ["base", ...optionalScenarioIds], optionalScenarioIds };
  assert.equal(presentation.optionalOverlayVisibility(initial).state, "all");

  const hidden = presentation.setOptionalOverlaysVisible(initial, false);
  assert.equal(hidden.showUncertaintyBand, false);
  assert.deepEqual([...hidden.activeScenarioIds], ["base"]);
  assert.equal(presentation.optionalOverlayVisibility({ ...hidden, optionalScenarioIds }).state, "none");

  const shown = presentation.setOptionalOverlaysVisible({ ...hidden, optionalScenarioIds }, true);
  assert.equal(shown.showUncertaintyBand, true);
  assert.deepEqual([...shown.activeScenarioIds], ["base", ...optionalScenarioIds]);
  assert.equal(presentation.optionalOverlayVisibility({ ...shown, optionalScenarioIds }).state, "all");
});

test("an individual overlay change after master visibility produces the mixed state", () => {
  const optionalScenarioIds = ["supplyShock", "currentMarket"];
  const allShown = presentation.setOptionalOverlaysVisible({
    activeScenarioIds: ["base"], optionalScenarioIds,
  }, true);
  allShown.activeScenarioIds.delete("supplyShock");

  const mixed = presentation.optionalOverlayVisibility({ ...allShown, optionalScenarioIds });
  assert.deepEqual(mixed, { state: "mixed", visibleCount: 2, total: 3 });
  assert.ok(allShown.activeScenarioIds.has("base"));
});

test("master overlay visibility recalculates the Y-axis from only currently visible layers", () => {
  const baseline = [{ data: [600, 650] }];
  const optionalScenario = { data: [650, 900] };
  const uncertainty = [{ p10: [590, 600], p50: [620, 640], p90: [650, 950] }];

  assert.deepEqual(presentation.chartYAxisBounds({ series: [...baseline, optionalScenario], bands: uncertainty }), { min: 0, max: 1100 });
  assert.deepEqual(presentation.chartYAxisBounds({ series: baseline, bands: [] }), { min: 0, max: 750 });
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

test("Both view uses independent native-price Y-axis scales", () => {
  const chinaBounds = presentation.chartYAxisBounds({
    series: [{ data: [270, 285, 300] }],
    bands: [{ p10: [265, 275, 280], p50: [270, 285, 290], p90: [275, 295, 340] }],
  });
  const euBounds = presentation.chartYAxisBounds({
    series: [{ data: [600, 650, 675] }],
    bands: [{ p10: [590, 630, 640], p50: [600, 650, 660], p90: [610, 670, 720] }],
  });
  assert.deepEqual(chinaBounds, { min: 0, max: 400 });
  assert.deepEqual(euBounds, { min: 0, max: 800 });
  assert.notEqual(chinaBounds.max, euBounds.max);
});

test("market chart layout is mutually exclusive through China, Both, and EU switches", () => {
  const china = presentation.chartLayoutForRegion("china");
  const both = presentation.chartLayoutForRegion("both");
  const eu = presentation.chartLayoutForRegion("eu");

  assert.deepEqual(china, { mode: "single", market: "china", markets: ["china"] });
  assert.deepEqual(both, { mode: "both", market: null, markets: ["china", "eu"] });
  assert.deepEqual(eu, { mode: "single", market: "eu", markets: ["eu"] });
  assert.equal(china.markets.length, 1);
  assert.equal(both.markets.length, 2);
  assert.equal(eu.markets.length, 1);

  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "styles.css"), "utf8");
  assert.match(app, /const layout = window\.ForecastPresentation\.chartLayoutForRegion\(state\.region\);/);
  assert.match(app, /els\.singleChartView\.hidden = layout\.mode !== "single";/);
  assert.match(app, /els\.bothCharts\.hidden = layout\.mode !== "both";/);
  assert.match(css, /\.both-chart-grid\[hidden\] \{ display: none; \}/);
});

test("Beide renders two native-market charts with synchronized labels and overlays", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  const chart = fs.readFileSync(path.join(__dirname, "..", "public", "js", "chart.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "styles.css"), "utf8");

  assert.match(index, /id="bothCharts"/);
  assert.match(index, /id="chinaPriceChart"/);
  assert.match(index, /id="euPriceChart"/);
  assert.match(app, /renderMarketChart\("china", els\.chinaChartSvg/);
  assert.match(app, /renderMarketChart\("eu", els\.euChartSvg/);
  assert.match(app, /labels: ALL_LABELS,[\s\S]*historyCount: HIST_COUNT/);
  assert.doesNotMatch(app, /function toIndex|indexMode|Index \(Today = 100\)/);
  assert.doesNotMatch(chart, /indexMode|index comparison/);
  assert.match(css, /\.both-chart-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.both-chart-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(index, /id="uncertaintyBandToggle" checked/);
  assert.match(index, /Unsicherheitsbereich anzeigen/);
  assert.match(app, /showUncertaintyBand: true/);
  assert.match(app, /state\.showUncertaintyBand \? baselineBands : \[\]/);
  assert.match(app, /function wireUncertaintyBandToggle/);
  assert.match(app, /function setAllOptionalOverlaysVisible/);
  assert.match(app, /tooltipBands: baselineBands/);
  assert.match(chart, /const tooltipBands = cfg\.tooltipBands \|\| bands/);
});

test("master overlay control synchronizes optional scenario, News, and uncertainty controls", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");

  assert.match(index, /id="overlayVisibilityMaster"/);
  assert.match(app, /function setAllOptionalOverlaysVisible/);
  assert.match(app, /!scenario\.alwaysOn/);
  assert.match(app, /currentMarketInitialized/);
  assert.match(app, /state\.activeScenarios\.has\("currentMarket"\)/);
  assert.match(app, /Teilweise sichtbar/);
  assert.match(app, /renderScenarioToggles\(\);[\s\S]*renderChart\(\);[\s\S]*renderInsights\(\);/);
});

test("Voices of the Market collapses horizontally with an accessible local-only handle", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "styles.css"), "utf8");

  assert.match(index, /class="news-col is-collapsed" id="newsColumn"/);
  assert.match(index, /id="newsSectionToggle"/);
  assert.match(index, /type="button" aria-controls="newsSectionContent" aria-expanded="false" aria-label="Stimmen des Marktes ausklappen"/);
  assert.match(index, /id="newsSectionContent" aria-hidden="true" inert/);
  assert.match(app, /newsSectionExpanded: false/);
  assert.match(app, /function updateNewsSectionVisibility/);
  assert.match(app, /newsColumn\.classList\.toggle\("is-collapsed", collapsed\)/);
  assert.match(app, /newsSectionContent\.setAttribute\("aria-hidden", String\(collapsed\)\)/);
  assert.match(app, /newsSectionContent\.inert = collapsed/);
  assert.match(app, /newsSectionToggle\.setAttribute\("aria-expanded", String\(state\.newsSectionExpanded\)\)/);
  assert.match(app, /function wireNewsSectionToggle/);
  assert.match(css, /\.news-col\.is-collapsed \{ flex: 0 0 48px; min-width: 48px; max-width: 48px; \}/);
  assert.match(css, /\.news-col\.is-collapsed #newsSectionContent \{ visibility: hidden; opacity: 0; pointer-events: none; transform: translateX\(100%\); transition:/);
  assert.match(css, /writing-mode: vertical-rl/);
  assert.match(css, /transition: flex-basis 280ms ease/);
  const collapsedRules = css.match(/\.news-col\.is-collapsed \{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(collapsedRules, /height|max-height/);
  const toggleFunction = app.slice(app.indexOf("function wireNewsSectionToggle"), app.indexOf("function renderNews"));
  assert.doesNotMatch(toggleFunction, /fetch\(|refreshData\(/);
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

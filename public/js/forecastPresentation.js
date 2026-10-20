(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ForecastPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const UNITS_BY_REGION = Object.freeze({
    china: "CNY/kg APT",
    eu: "USD/mtu WO₃",
    both: "China: CNY/kg APT | EU: USD/mtu WO₃",
  });

  function unitForRegion(region) {
    return UNITS_BY_REGION[region] || UNITS_BY_REGION.both;
  }

  function chartYAxisLabelForRegion(region) {
    if (region === "china") return "Preis (CNY/kg APT)";
    if (region === "eu") return "Preis (USD/mtu WO₃)";
    return "Getrennte native Preisachsen";
  }

  // Exactly one chart layout is active: a single native-price market chart or
  // the two independent native-price charts for the combined view.
  function chartLayoutForRegion(region) {
    if (region === "china" || region === "eu") {
      return { mode: "single", market: region, markets: [region] };
    }
    return { mode: "both", market: null, markets: ["china", "eu"] };
  }

  function scenarioDeltaPct(scenario, baselineScenario, market) {
    const scenarioChange = Number(scenario?.expectedChange12m?.[market]);
    const baselineChange = Number(baselineScenario?.expectedChange12m?.[market]);
    if (!Number.isFinite(scenarioChange) || !Number.isFinite(baselineChange)) return null;
    return scenarioChange - baselineChange;
  }

  function shouldShowScenarioDelta(scenario) {
    return Boolean(scenario && scenario.id !== "base");
  }

  function formatPercentagePointDelta(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    const sign = number > 0 ? "+" : "";
    return `vs. Basis: ${sign}${number.toFixed(1)} %-Pkt.`;
  }

  // Optional overlays never include the historical series or the always-on P50
  // baseline. The returned state lets one master control reflect individual
  // uncertainty-, stress-scenario-, and News-scenario controls.
  function optionalOverlayVisibility({ showUncertaintyBand = true, activeScenarioIds = [], optionalScenarioIds = [] } = {}) {
    const activeIds = new Set(activeScenarioIds);
    const optionalIds = [...new Set(optionalScenarioIds)];
    const visibleCount = (showUncertaintyBand ? 1 : 0)
      + optionalIds.filter((id) => activeIds.has(id)).length;
    const total = 1 + optionalIds.length;
    return {
      state: visibleCount === total ? "all" : visibleCount === 0 ? "none" : "mixed",
      visibleCount,
      total,
    };
  }

  function setOptionalOverlaysVisible({ activeScenarioIds = [], optionalScenarioIds = [] } = {}, visible) {
    const nextActiveIds = new Set(activeScenarioIds);
    [...new Set(optionalScenarioIds)].forEach((id) => {
      if (visible) nextActiveIds.add(id);
      else nextActiveIds.delete(id);
    });
    return { showUncertaintyBand: Boolean(visible), activeScenarioIds: nextActiveIds };
  }

  function nonNegativeAxisMinimum(minimum, enabled) {
    return enabled ? Math.max(0, minimum) : minimum;
  }

  function finiteValues(series, bands) {
    const values = [];
    (series || []).forEach((item) => (item?.data || []).forEach((value) => {
      if (Number.isFinite(value)) values.push(value);
    }));
    (bands || []).forEach((band) => [band?.p10, band?.p50, band?.p90].forEach((data) => (data || []).forEach((value) => {
      if (Number.isFinite(value)) values.push(value);
    })));
    return values;
  }

  function cleanCeiling(value) {
    if (!Number.isFinite(value) || value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const candidates = [1, 1.1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7.5, 8, 8.5, 9, 10];
    return Number((candidates.find((candidate) => candidate * magnitude >= value) * magnitude).toPrecision(14));
  }

  // Presentation-only bounds. `series` and `bands` are already filtered to
  // the lines currently visible in the chart.
  function chartYAxisBounds({ series = [], bands = [] } = {}) {
    const values = finiteValues(series, bands);
    if (!values.length) return { min: 0, max: 1 };
    const visibleMax = Math.max(...values);
    return { min: 0, max: cleanCeiling(Math.max(visibleMax, 0) * 1.1 || 1) };
  }

  return { UNITS_BY_REGION, unitForRegion, chartYAxisLabelForRegion, chartLayoutForRegion, scenarioDeltaPct, shouldShowScenarioDelta, formatPercentagePointDelta,
    optionalOverlayVisibility, setOptionalOverlaysVisible, nonNegativeAxisMinimum, chartYAxisBounds, cleanCeiling };
});

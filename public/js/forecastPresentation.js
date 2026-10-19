(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ForecastPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const UNITS_BY_REGION = Object.freeze({
    china: "CNY/kg APT",
    eu: "USD/mtu WO3",
    both: "Index (Heute = 100)",
  });

  function unitForRegion(region) {
    return UNITS_BY_REGION[region] || UNITS_BY_REGION.both;
  }

  function chartYAxisLabelForRegion(region) {
    if (region === "china") return "Preis (CNY/kg APT)";
    if (region === "eu") return "Preis (USD/mtu WO₃)";
    return "Index (Heute = 100)";
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

  function cleanFloor(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return -cleanCeiling(Math.abs(value));
    if (value === 0) return 0;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const candidates = [1, 1.1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7.5, 8, 8.5, 9, 10];
    return Number(([...candidates].reverse().find((candidate) => candidate * magnitude <= value) * magnitude).toPrecision(14));
  }

  // Presentation-only bounds. `series` and `bands` are already filtered to
  // the lines currently visible in the chart.
  function chartYAxisBounds({ series = [], bands = [], indexMode = false } = {}) {
    const values = finiteValues(series, bands);
    if (!values.length) return { min: 0, max: 1 };
    const visibleMin = Math.min(...values);
    const visibleMax = Math.max(...values);
    if (!indexMode) return { min: 0, max: cleanCeiling(Math.max(visibleMax, 0) * 1.1 || 1) };

    const range = visibleMax - visibleMin;
    const padding = range > 0 ? range * 0.1 : Math.max(Math.abs(visibleMax) * 0.1, 1);
    const min = cleanFloor(visibleMin - padding);
    const max = cleanCeiling(visibleMax + padding);
    return max > min ? { min, max } : { min: min - 1, max: max + 1 };
  }

  return { UNITS_BY_REGION, unitForRegion, chartYAxisLabelForRegion, scenarioDeltaPct, shouldShowScenarioDelta, formatPercentagePointDelta,
    nonNegativeAxisMinimum, chartYAxisBounds, cleanCeiling };
});

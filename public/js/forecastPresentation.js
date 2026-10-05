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

  return { UNITS_BY_REGION, unitForRegion, scenarioDeltaPct, shouldShowScenarioDelta, formatPercentagePointDelta, nonNegativeAxisMinimum };
});

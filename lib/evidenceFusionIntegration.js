"use strict";

const { fuseEvidence } = require("./evidenceFusion");

const FUSION_MARKETS = ["china", "eu"];
const FUSION_HORIZONS = [4, 12, 26];

function baselineForFusion(pipelineResult, market, horizonWeeks) {
  const marketResult = pipelineResult?.[market];
  const horizon = marketResult?.forecast_horizons?.[`${horizonWeeks}w`];
  const lastPrice = Number(marketResult?.last_observed?.price);
  const p50 = Number(horizon?.p50);
  const reliability = marketResult?.reliability?.[`${horizonWeeks}w`]?.label;
  if (!Number.isFinite(lastPrice) || lastPrice <= 0 || !Number.isFinite(p50) || p50 <= 0 || !reliability) {
    throw new Error("required statistical baseline metadata is unavailable");
  }
  return {
    forecastChangePct: ((p50 / lastPrice) - 1) * 100,
    reliability,
  };
}

function unavailableFusion() {
  return {
    status: "unavailable",
    error: "Evidence Fusion diagnostics unavailable.",
    numericalAdjustmentApplied: false,
  };
}

function buildEvidenceFusionDiagnostics({ pipelineResult, eventEvidence, fuse = fuseEvidence } = {}) {
  const events = Array.isArray(eventEvidence) ? eventEvidence : [];
  const output = {};
  for (const market of FUSION_MARKETS) {
    output[market] = {};
    for (const horizonWeeks of FUSION_HORIZONS) {
      try {
        output[market][String(horizonWeeks)] = fuse({
          market,
          horizonWeeks,
          baseline: baselineForFusion(pipelineResult, market, horizonWeeks),
          events,
        });
      } catch (error) {
        output[market][String(horizonWeeks)] = unavailableFusion();
      }
    }
  }
  return output;
}

module.exports = {
  FUSION_MARKETS,
  FUSION_HORIZONS,
  baselineForFusion,
  buildEvidenceFusionDiagnostics,
};

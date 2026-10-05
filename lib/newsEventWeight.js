"use strict";

const { derivePriceDirection } = require("./newsCausality");
const { freshnessWeight } = require("./newsEventFreshness");

// News-Lage v2 constants. They are deliberately local to this module: this
// helper does not participate in Evidence Fusion v1 or newsSignals.
const NEWS_LAGE_V2_MATURITY_WEIGHTS = Object.freeze({
  realized: 1.0,
  prospective: 0.5,
  speculative: 0.2,
  unclear: 0,
});
// A globally material event can contribute conservatively to China/EU when it
// has no stronger direct regional relevance. This matches the architecture's
// distinction between global and regional materiality without sharing Fusion's
// implementation or state.
const NEWS_LAGE_V2_GLOBAL_TRANSFER_FACTOR = 0.35;

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function effectiveMarketRelevance(event, market) {
  const global = clamp01(event?.globalRelevance);
  if (market === "global") return global;
  if (market !== "china" && market !== "eu") return 0;
  const direct = clamp01(market === "china" ? event?.chinaRelevance : event?.euRelevance);
  return Math.max(direct, NEWS_LAGE_V2_GLOBAL_TRANSFER_FACTOR * global);
}

function hasDirectionalValidatedMechanism(event) {
  if (!event || !["bullish", "bearish"].includes(event.direction)) return false;
  // Stored events originated from deterministic validation. Re-deriving the
  // direction here prevents corrupted or contradictory persisted values from
  // becoming directional News-Lage v2 weight.
  return derivePriceDirection(event) === event.direction;
}

/**
 * Explainable News-Lage v2 event weighting, before any sentiment aggregation:
 *
 * severity * confidence * maturity * effective market relevance * freshness
 *
 * The result is unsigned; a later v2 aggregator may apply event.direction.
 * Neutral, malformed, or causally contradictory events retain diagnostics but
 * have finalWeight zero.
 */
function eventWeightComponents(event, market, referenceTime) {
  const severityComponent = clamp01(event?.severity);
  const confidenceComponent = clamp01(event?.confidence);
  const maturityComponent = NEWS_LAGE_V2_MATURITY_WEIGHTS[event?.evidenceMaturity] ?? 0;
  const relevanceComponent = effectiveMarketRelevance(event, market);
  const freshnessComponent = freshnessWeight(event, referenceTime);
  const directional = hasDirectionalValidatedMechanism(event);
  const finalWeight = directional
    ? severityComponent * confidenceComponent * maturityComponent * relevanceComponent * freshnessComponent
    : 0;

  return {
    severityComponent,
    confidenceComponent,
    maturityComponent,
    relevanceComponent,
    freshnessComponent,
    finalWeight,
    directional,
  };
}

module.exports = {
  NEWS_LAGE_V2_MATURITY_WEIGHTS,
  NEWS_LAGE_V2_GLOBAL_TRANSFER_FACTOR,
  effectiveMarketRelevance,
  hasDirectionalValidatedMechanism,
  eventWeightComponents,
};

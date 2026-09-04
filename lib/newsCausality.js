"use strict";
const { detectConcreteMarketEvent } = require("./newsConcreteEvent");

const EFFECTS = ["increase", "decrease", "none", "unclear"];
const EVENT_STAGES = ["actual", "announced", "planned", "study", "exploration", "speculative", "unclear"];
const NON_CURRENT_SUPPLY_STAGES = new Set(["study", "exploration", "speculative"]);
const EVIDENCE_MATURITY_BY_STAGE = {
  actual: "realized", announced: "prospective", planned: "prospective",
  study: "speculative", exploration: "speculative", speculative: "speculative", unclear: "unclear",
};
const SEVERITY_CAP_BY_MATURITY = { realized: 1, prospective: 0.5, speculative: 0.2, unclear: 0.2 };

function articleText(article = {}) {
  return `${article.title || ""}\n${article.snippet || ""}`.toLowerCase();
}

function hasExplorationIndicator(text) {
  return /\b(discovery|discover(?:ed|y|ies)?|drill(?:ing|ed|s)?|drill program|assay(?:s)?|intercept(?:s)?|high[ -]grade|mineralisation|mineralization|resource target|exploration target|geological target|bohrprogramm|bohrung|bohrergebnis|exploration|explorationsprogramm|entdeckung|lagerstättenerkundung|mineralisierung|ressourcenziel)\b/.test(text);
}

function hasActualCommercialProduction(text) {
  return detectConcreteMarketEvent(text).productionExpansion || /\b(beg(?:ins|an)|start(?:s|ed)|commenc(?:es|ed)|enter(?:s|ed)|reach(?:es|ed))\b[^.\n]{0,80}\bproduction\b|\bproduction\b[^.\n]{0,80}\b(beg(?:ins|an)|start(?:s|ed)|commenc(?:es|ed)|enter(?:s|ed)|reach(?:es|ed))\b/.test(text);
}

function hasSupplyRestriction(text) {
  return detectConcreteMarketEvent(text).supplyDecrease;
}

function hasEffectiveRestriction(text) {
  return /\b(in force|takes? effect|effective (?:immediately|now|on)|now requires?|are required|is required)\b/.test(text);
}

function hasExplicitDemandEvidence(text, effect) {
  const increase = /\b(demand|consumption|purchases?|purchasing|orders?|procurement|usage)\b[^.\n]{0,50}\b(ris(?:e|es|ing)|increas(?:e|es|ed|ing)|grow(?:s|th|ing)|strengthen(?:s|ed|ing)|expand(?:s|ed|ing)|surge(?:s|d|ing))\b|\b(ris(?:ing|e)|increas(?:ing|e)|strong(?:er|ening)|growing|higher)\b[^.\n]{0,50}\b(demand|consumption|purchases?|purchasing|orders?|procurement|usage)\b/.test(text);
  const decrease = /\b(demand|consumption|purchases?|purchasing|orders?|procurement|usage)\b[^.\n]{0,50}\b(fall(?:s|ing)?|decreas(?:e|es|ed|ing)|weaken(?:s|ed|ing)|declin(?:e|es|ed|ing)|contract(?:s|ed|ing)|reduc(?:e|es|ed|ing))\b|\b(falling|lower|reduced|weaker|declining)\b[^.\n]{0,50}\b(demand|consumption|purchases?|purchasing|orders?|procurement|usage)\b/.test(text);
  return effect === "increase" ? increase : effect === "decrease" ? decrease : false;
}

function normalize(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function derivePriceDirection({ supplyEffect, demandEffect, eventStage }) {
  const supply = normalize(supplyEffect, EFFECTS, "unclear");
  const demand = normalize(demandEffect, EFFECTS, "unclear");
  const stage = normalize(eventStage, EVENT_STAGES, "unclear");
  const supplyPressure = NON_CURRENT_SUPPLY_STAGES.has(stage) ? 0 : supply === "increase" ? -1 : supply === "decrease" ? 1 : 0;
  const demandPressure = demand === "increase" ? 1 : demand === "decrease" ? -1 : 0;
  if (supplyPressure && demandPressure && supplyPressure !== demandPressure) return "neutral";
  const pressure = supplyPressure || demandPressure;
  return pressure > 0 ? "bullish" : pressure < 0 ? "bearish" : "neutral";
}

function buildImpactExplanation({ supplyEffect, demandEffect, eventStage, direction }) {
  const prospective = eventStage === "announced" || eventStage === "planned";
  const prefix = prospective ? "The announced or planned development is prospective: " : "";
  if (supplyEffect === "increase" && direction === "bearish") {
    return `${prefix}${prospective ? "a supply expansion would increase" : "Confirmed supply expansion increases"} tungsten availability and therefore creates downward price pressure, all else equal.`;
  }
  if (supplyEffect === "decrease" && direction === "bullish") {
    return `${prefix}${prospective ? "reduced availability would create" : "Reduced tungsten availability creates"} upward price pressure, all else equal.`;
  }
  if (demandEffect === "increase" && direction === "bullish") {
    return `${prefix}${prospective ? "stronger evidenced demand would create" : "Stronger evidenced tungsten demand creates"} upward price pressure, all else equal.`;
  }
  if (demandEffect === "decrease" && direction === "bearish") {
    return `${prefix}${prospective ? "weaker evidenced demand would create" : "Weaker evidenced tungsten demand creates"} downward price pressure, all else equal.`;
  }
  return "The supplied information does not establish a sufficiently clear current supply/demand effect for a directional tungsten-price signal.";
}

function normalizeGlobalRelevance(globalRelevance, confidence, causal, article = {}) {
  const suppliedText = articleText(article);
  const explicitGlobalMarket = /\b(global|international)\s+tungsten\s+market\b/.test(suppliedText);
  const clearMechanism = ["increase", "decrease"].includes(causal.supplyEffect) || ["increase", "decrease"].includes(causal.demandEffect);
  const original = Number.isFinite(globalRelevance) ? globalRelevance : 0;
  if (explicitGlobalMarket && clearMechanism && confidence >= 0.7 && original < 0.35) {
    return { globalRelevance: 0.35, globalRelevanceCorrected: true };
  }
  return { globalRelevance: original, globalRelevanceCorrected: false };
}

function normalizeCausalClassification(classification = {}, article = {}) {
  const text = articleText(article);
  const rawSupply = normalize(classification.supplyEffect, EFFECTS, "unclear");
  const rawDemand = normalize(classification.demandEffect, EFFECTS, "unclear");
  const rawStage = normalize(classification.eventStage, EVENT_STAGES, "unclear");
  const exploration = hasExplorationIndicator(text) && !hasActualCommercialProduction(text);
  const commercialProduction = hasActualCommercialProduction(text);
  let supplyEffect = rawSupply;
  let demandEffect = rawDemand;
  let eventStage = rawStage;

  const supplyExpansion = hasActualCommercialProduction(text);
  const supplyDecrease = hasSupplyRestriction(text);
  if (exploration) {
    eventStage = "exploration";
    supplyEffect = "none";
  } else if (commercialProduction) {
    eventStage = "actual";
    if (!supplyDecrease) supplyEffect = "increase";
  } else if (supplyDecrease && !supplyExpansion) {
    supplyEffect = "decrease";
  }
  if (supplyDecrease && hasEffectiveRestriction(text)) eventStage = "actual";
  if ((demandEffect === "increase" || demandEffect === "decrease") && !hasExplicitDemandEvidence(text, demandEffect)) demandEffect = "none";

  const direction = derivePriceDirection({ supplyEffect, demandEffect, eventStage });
  const evidenceMaturity = EVIDENCE_MATURITY_BY_STAGE[eventStage];
  return {
    supplyEffect,
    demandEffect,
    eventStage,
    direction,
    causalExtractionCorrected: rawSupply !== supplyEffect || rawDemand !== demandEffect || rawStage !== eventStage,
    causalConsistencyCorrected: classification.direction !== direction || rawSupply !== supplyEffect || rawDemand !== demandEffect || rawStage !== eventStage,
    evidenceMaturity,
    severityCap: SEVERITY_CAP_BY_MATURITY[evidenceMaturity],
    confidenceCap: evidenceMaturity === "prospective" ? 0.7 : evidenceMaturity === "speculative" ? 0.5 : 1,
    impactExplanation: buildImpactExplanation({ supplyEffect, demandEffect, eventStage, direction }),
  };
}

module.exports = { EFFECTS, EVENT_STAGES, EVIDENCE_MATURITY_BY_STAGE, SEVERITY_CAP_BY_MATURITY, derivePriceDirection, normalizeCausalClassification, normalizeGlobalRelevance, buildImpactExplanation };

"use strict";

// Evidence Fusion v1 is explanatory only. It deliberately has no I/O and does
// not create numerical forecast or scenario adjustments.
const BASELINE_NEUTRALITY_BAND_PCT_POINTS = 1.0;
const GLOBAL_TRANSFER_FACTOR = 0.35;
const MATURITY_WEIGHT = Object.freeze({ realized: 1.00, prospective: 0.50, speculative: 0.20, unclear: 0.00 });
const HORIZON_DECAY_HALF_LIFE_WEEKS = 12;
const MIN_DIRECTIONAL_EXPOSURE = 0.05;
const DIRECTION_BALANCE_THRESHOLD = 0.40;
const STRENGTH_SCALE = 2.0;
const MEDIUM_STRENGTH = 0.20;
const HIGH_STRENGTH = 0.70;
const MEDIUM_EXTRACTION_CONFIDENCE = 0.60;
const HIGH_EXTRACTION_CONFIDENCE = 0.70;

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function clampSigned(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(-1, number)) : 0;
}

function baselineDirection(forecastChangePct) {
  const change = Number(forecastChangePct);
  if (!Number.isFinite(change)) return "neutral";
  if (change > BASELINE_NEUTRALITY_BAND_PCT_POINTS) return "bullish";
  if (change < -BASELINE_NEUTRALITY_BAND_PCT_POINTS) return "bearish";
  return "neutral";
}

function hasValidatedMechanism(event) {
  return ["increase", "decrease"].includes(event?.supplyEffect)
    || ["increase", "decrease"].includes(event?.demandEffect);
}

function isDirectionalEvent(event) {
  return ["bullish", "bearish"].includes(event?.direction) && hasValidatedMechanism(event);
}

function effectiveRelevance(event, market) {
  const marketSpecific = clamp01(market === "eu" ? event?.euRelevance : event?.chinaRelevance);
  return Math.max(marketSpecific, GLOBAL_TRANSFER_FACTOR * clamp01(event?.globalRelevance));
}

function horizonWeight(eventHorizonWeeks, requestedHorizonWeeks) {
  const eventHorizon = Number(eventHorizonWeeks);
  const requested = Number(requestedHorizonWeeks);
  if (!Number.isFinite(eventHorizon) || eventHorizon <= 0 || !Number.isFinite(requested) || requested <= 0) return 0;
  if (eventHorizon >= requested) return 1;
  return Math.pow(2, -(requested - eventHorizon) / HORIZON_DECAY_HALF_LIFE_WEEKS);
}

function eventComponents(event, market, requestedHorizonWeeks) {
  const maturityWeight = MATURITY_WEIGHT[event?.evidenceMaturity] ?? 0;
  const relevance = effectiveRelevance(event, market);
  const horizon = horizonWeight(event?.horizonWeeks, requestedHorizonWeeks);
  const baseWeight = clamp01(event?.severity) * maturityWeight * relevance * horizon;
  const confidence = clamp01(event?.confidence);
  return {
    baseWeight,
    confidence,
    eventWeight: baseWeight * confidence,
    maturity: event?.evidenceMaturity || "unclear",
    effectiveRelevance: relevance,
    horizonWeight: horizon,
  };
}

function newsDirection({ classifiedEvents, directionalExposure, positive, negative, signedBalance }) {
  if (classifiedEvents === 0) return "none";
  if (directionalExposure === 0 || directionalExposure < MIN_DIRECTIONAL_EXPOSURE) return "neutral";
  if (positive > 0 && negative > 0 && Math.abs(signedBalance) < DIRECTION_BALANCE_THRESHOLD) return "mixed";
  if (signedBalance >= DIRECTION_BALANCE_THRESHOLD) return "bullish";
  if (signedBalance <= -DIRECTION_BALANCE_THRESHOLD) return "bearish";
  return "mixed";
}

function agreementFor(baseline, news) {
  if (news === "mixed") return "mixed";
  if (news === "none" || news === "neutral") return "none";
  if (baseline === "neutral") return "news_only";
  return baseline === news ? "agree" : "conflict";
}

function corroborationFor({ newsDirection: direction, agreement, strength, extractionConfidence, realizedDirectionalEvents }) {
  if (direction === "none" || direction === "neutral") return "NONE";
  if (agreement === "agree"
    && strength >= HIGH_STRENGTH
    && extractionConfidence >= HIGH_EXTRACTION_CONFIDENCE
    && realizedDirectionalEvents >= 2) return "HIGH";
  if (agreement === "agree"
    && strength >= MEDIUM_STRENGTH
    && extractionConfidence >= MEDIUM_EXTRACTION_CONFIDENCE
    && realizedDirectionalEvents >= 1) return "MEDIUM";
  return "LOW";
}

function explanationReasons({ baselineDirection: baseline, newsDirection: news, agreement, corroboration }) {
  const reasons = [
    `Statistical baseline direction: ${baseline}.`,
    `Validated news evidence direction: ${news}.`,
  ];
  if (agreement === "agree") reasons.push("Baseline and directional news evidence agree.");
  else if (agreement === "conflict") reasons.push("Baseline and directional news evidence conflict; no numerical forecast was changed.");
  else if (agreement === "mixed") reasons.push("Bullish and bearish news evidence is mixed; no numerical forecast was changed.");
  else if (agreement === "news_only") reasons.push("The baseline is neutral while directional news evidence is present; no numerical forecast was changed.");
  else reasons.push("No meaningful directional news evidence is available.");
  reasons.push(`Corroboration: ${corroboration}.`);
  return reasons;
}

function fuseEvidence({ market, horizonWeeks, baseline = {}, events = [] } = {}) {
  const resolvedMarket = market === "eu" ? "eu" : "china";
  const resolvedHorizon = [4, 12, 26].includes(Number(horizonWeeks)) ? Number(horizonWeeks) : 12;
  const forecastChangePct = Number.isFinite(Number(baseline.forecastChangePct)) ? Number(baseline.forecastChangePct) : 0;
  const baselineEvidence = {
    direction: baselineDirection(forecastChangePct),
    forecastChangePct,
    reliability: baseline.reliability,
    source: "backtested_time_series",
  };
  const classified = Array.isArray(events) ? events.filter((event) => event && typeof event === "object") : [];
  let positive = 0;
  let negative = 0;
  let confidenceNumerator = 0;
  let confidenceDenominator = 0;
  let directionalEvents = 0;
  const maturityCounts = { realized: 0, prospective: 0, speculative: 0 };
  const eventIds = new Set();

  for (const event of classified) {
    if (!isDirectionalEvent(event)) continue;
    const component = eventComponents(event, resolvedMarket, resolvedHorizon);
    // Extraction confidence is intentionally limited to directional events with
    // non-zero base evidence, even when their final confidence is zero.
    if (component.baseWeight > 0) {
      confidenceNumerator += component.baseWeight * component.confidence;
      confidenceDenominator += component.baseWeight;
    }
    if (component.eventWeight <= 0) continue;
    if (event.direction === "bullish") positive += component.eventWeight;
    else negative += component.eventWeight;
    directionalEvents += 1;
    if (Object.hasOwn(maturityCounts, component.maturity)) maturityCounts[component.maturity] += 1;
    if (typeof event.eventId === "string" && event.eventId.trim()) eventIds.add(event.eventId);
  }

  const directionalExposure = positive + negative;
  const signedBalance = directionalExposure > 0 ? clampSigned((positive - negative) / directionalExposure) : 0;
  const strength = clamp01(1 - Math.exp(-STRENGTH_SCALE * directionalExposure));
  const extractionConfidence = confidenceDenominator > 0 ? clamp01(confidenceNumerator / confidenceDenominator) : 0;
  const resolvedNewsDirection = newsDirection({
    classifiedEvents: classified.length, directionalExposure, positive, negative, signedBalance,
  });
  const agreement = agreementFor(baselineEvidence.direction, resolvedNewsDirection);
  const newsEvidence = {
    direction: resolvedNewsDirection,
    signedBalance,
    strength,
    extractionConfidence,
    classifiedEvents: classified.length,
    directionalEvents,
    neutralEvents: classified.length - directionalEvents,
    realizedDirectionalEvents: maturityCounts.realized,
    prospectiveDirectionalEvents: maturityCounts.prospective,
    speculativeDirectionalEvents: maturityCounts.speculative,
    eventIds: [...eventIds],
  };
  const corroboration = corroborationFor({
    newsDirection: resolvedNewsDirection,
    agreement,
    strength,
    extractionConfidence,
    realizedDirectionalEvents: maturityCounts.realized,
  });

  return {
    market: resolvedMarket,
    horizonWeeks: resolvedHorizon,
    baselineEvidence,
    newsEvidence,
    agreement,
    corroboration,
    explanationReasons: explanationReasons({ baselineDirection: baselineEvidence.direction, newsDirection: resolvedNewsDirection, agreement, corroboration }),
    fusionVersion: "v1",
    numericalAdjustmentApplied: false,
  };
}

module.exports = {
  BASELINE_NEUTRALITY_BAND_PCT_POINTS,
  GLOBAL_TRANSFER_FACTOR,
  MATURITY_WEIGHT,
  HORIZON_DECAY_HALF_LIFE_WEEKS,
  MIN_DIRECTIONAL_EXPOSURE,
  DIRECTION_BALANCE_THRESHOLD,
  STRENGTH_SCALE,
  MEDIUM_STRENGTH,
  HIGH_STRENGTH,
  MEDIUM_EXTRACTION_CONFIDENCE,
  HIGH_EXTRACTION_CONFIDENCE,
  baselineDirection,
  isDirectionalEvent,
  effectiveRelevance,
  horizonWeight,
  eventComponents,
  fuseEvidence,
};

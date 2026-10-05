"use strict";

const NEWS_CATEGORIES = ["supply", "demand", "regulation", "geopolitics", "technology", "macro", "other"];
const NEWS_DIRECTIONS = ["bullish", "bearish", "neutral"];
const SUPPLY_DEMAND_EFFECTS = ["increase", "decrease", "none", "unclear"];
const EVENT_STAGES = ["actual", "announced", "planned", "study", "exploration", "speculative", "unclear"];

function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function clampHorizonWeeks(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(52, Math.max(1, n)) : fallback;
}

function neutralNewsClassification(title) {
  return { category: "other", direction: "neutral", supplyEffect: "unclear", demandEffect: "unclear", eventStage: "unclear", severity: 0, confidence: 0, globalRelevance: 0, chinaRelevance: 0.5, euRelevance: 0.5, horizonWeeks: 12, summary: title, impactExplanation: "Automatisch abgerufen, noch keine KI-Einschätzung verfügbar." };
}

function validateNewsClassification(raw, title) {
  if (!raw || typeof raw !== "object") return neutralNewsClassification(title);
  return {
    category: NEWS_CATEGORIES.includes(raw.category) ? raw.category : "other",
    direction: NEWS_DIRECTIONS.includes(raw.direction) ? raw.direction : "neutral",
    supplyEffect: SUPPLY_DEMAND_EFFECTS.includes(raw.supplyEffect) ? raw.supplyEffect : "unclear",
    demandEffect: SUPPLY_DEMAND_EFFECTS.includes(raw.demandEffect) ? raw.demandEffect : "unclear",
    eventStage: EVENT_STAGES.includes(raw.eventStage) ? raw.eventStage : "unclear",
    severity: clamp01(raw.severity, 0), confidence: clamp01(raw.confidence, 0), globalRelevance: clamp01(raw.globalRelevance, 0),
    chinaRelevance: clamp01(raw.chinaRelevance, 0.5), euRelevance: clamp01(raw.euRelevance, 0.5),
    horizonWeeks: clampHorizonWeeks(raw.horizonWeeks, 12),
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : title,
    impactExplanation: typeof raw.impactExplanation === "string" && raw.impactExplanation.trim() ? raw.impactExplanation.trim() : "",
  };
}

module.exports = { validateNewsClassification };

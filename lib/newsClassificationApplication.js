"use strict";

const { validateNewsClassification } = require("./newsClassificationValidation");
const { normalizeCausalClassification, normalizeGlobalRelevance } = require("./newsCausality");

// Shared post-LLM processing for live refreshes and historical backfills. This
// guarantees durable evidence passes through exactly the same deterministic
// validation and causal normalization as live News-Lage evidence.
const NEWS_CATEGORY_LABELS_DE = Object.freeze({
  supply: "Angebot", demand: "Nachfrage", regulation: "Regulierung",
  geopolitics: "Geopolitik", technology: "Technologie", macro: "Makro", other: "Sonstiges",
});

function scenariosForClassification(category, direction) {
  if (category === "supply" || category === "geopolitics") return ["supplyShock"];
  if (category === "regulation") return ["euRegulation"];
  if (category === "technology") return ["demandSurge"];
  if (category === "demand") {
    if (direction === "bullish") return ["demandSurge"];
    if (direction === "bearish") return ["demandSlowdown"];
  }
  return [];
}

function applyNewsClassification(newsItem, raw) {
  const validated = validateNewsClassification(raw, newsItem.title);
  const causal = normalizeCausalClassification(validated, newsItem);
  const globalRelevance = normalizeGlobalRelevance(validated.globalRelevance, validated.confidence, causal, newsItem);
  newsItem.category = NEWS_CATEGORY_LABELS_DE[validated.category];
  newsItem.categoryKey = validated.category;
  newsItem.llmDirection = validated.direction;
  newsItem.sentiment = causal.direction;
  newsItem.supplyEffect = causal.supplyEffect;
  newsItem.demandEffect = causal.demandEffect;
  newsItem.eventStage = causal.eventStage;
  newsItem.evidenceMaturity = causal.evidenceMaturity;
  newsItem.causalExtractionCorrected = causal.causalExtractionCorrected;
  newsItem.causalConsistencyCorrected = causal.causalConsistencyCorrected;
  newsItem.summary = validated.summary;
  newsItem.llmImpactExplanation = validated.impactExplanation;
  newsItem.impact = causal.impactExplanation;
  newsItem.scenarios = scenariosForClassification(validated.category, causal.direction);
  newsItem.severity = Math.min(validated.severity, causal.severityCap);
  newsItem.confidence = Math.min(validated.confidence, causal.confidenceCap);
  newsItem.globalRelevance = globalRelevance.globalRelevance;
  newsItem.globalRelevanceCorrected = globalRelevance.globalRelevanceCorrected;
  newsItem.chinaRelevance = validated.chinaRelevance;
  newsItem.euRelevance = validated.euRelevance;
  newsItem.horizonWeeks = validated.horizonWeeks;
  newsItem.aiGenerated = true;
  newsItem.classificationStatus = "classified";
  return newsItem;
}

module.exports = { NEWS_CATEGORY_LABELS_DE, scenariosForClassification, applyNewsClassification };

"use strict";

function buildEventEvidence(representatives) {
  return representatives.map((article) => ({
    eventId: article.eventId || `event-${article.id}`,
    representativeArticleId: article.id,
    headline: article.title,
    category: article.categoryKey || article.category || "other",
    direction: article.sentiment || article.direction || "neutral",
    supplyEffect: article.supplyEffect || "unclear",
    demandEffect: article.demandEffect || "unclear",
    eventStage: article.eventStage || "unclear",
    evidenceMaturity: article.evidenceMaturity || "unclear",
    severity: Number.isFinite(article.severity) ? article.severity : 0,
    confidence: Number.isFinite(article.confidence) ? article.confidence : 0,
    globalRelevance: Number.isFinite(article.globalRelevance) ? article.globalRelevance : 0,
    chinaRelevance: Number.isFinite(article.chinaRelevance) ? article.chinaRelevance : 0.5,
    euRelevance: Number.isFinite(article.euRelevance) ? article.euRelevance : 0.5,
    horizonWeeks: article.horizonWeeks || 12,
    duplicateCount: article.duplicateCount || 1,
    duplicateSources: article.duplicateSources || [],
    evidenceSource: "news",
  }));
}

module.exports = { buildEventEvidence };

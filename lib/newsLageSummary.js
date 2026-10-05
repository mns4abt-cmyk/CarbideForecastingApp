"use strict";

// Fixed English presentation of existing backend labels; no score thresholds.
const LABELS = Object.freeze({
  bullish: "predominantly bullish",
  bearish: "predominantly bearish",
  "stark bullish": "strongly bullish",
  "stark bearish": "strongly bearish",
  "neutral/ausgeglichen": "neutral/balanced",
});
const CATEGORIES = Object.freeze({
  supply: "supply", demand: "demand", regulation: "regulation",
  geopolitics: "geopolitics", technology: "technology", macro: "macroeconomics", other: "other topics",
});
const CLOSING = "The statistical price forecast is not adjusted by this news assessment.";
const INSUFFICIENT = `There is insufficient information for a directional news assessment. ${CLOSING}`;

/**
 * Pure wording for one market's existing 30-day News-Lage output. topEvents
 * must already be selected/ranked upstream. Scores are checked for availability
 * only, never mapped to labels, reweighted or reconciled with event titles.
 * The 1–2 directional-event warning is presentation only, not a methodology
 * threshold. No names, causal mechanisms or price movements are inferred.
 */
function buildNewsLageSummary(input = {}) {
  if (!input || typeof input !== "object") return INSUFFICIENT;
  const { qualitativeLabel, sentimentScore, topEvents, totalEventCount, directionalEventCount } = input;
  if (!Number.isInteger(totalEventCount) || totalEventCount < 0
    || !Number.isInteger(directionalEventCount) || directionalEventCount < 0
    || directionalEventCount > totalEventCount) return INSUFFICIENT;

  // Counts support these factual statements without inventing any market label.
  if (totalEventCount === 0) return `No validated events are available for the 30-day assessment. ${CLOSING}`;
  if (directionalEventCount === 0) {
    return `Validated events are available, but no clear directional assessment is supported. ${CLOSING}`;
  }
  if (!Number.isFinite(sentimentScore) || !Object.hasOwn(LABELS, qualitativeLabel)) return INSUFFICIENT;

  const sentences = [`The news assessment is ${LABELS[qualitativeLabel]} for tungsten/APT price pressure.`];
  const categories = [...new Set((Array.isArray(topEvents) ? topEvents : [])
    .map(event => event?.category)
    .filter(category => typeof category === "string" && Object.hasOwn(CATEGORIES, category)))]
    .slice(0, 3).map(category => CATEGORIES[category]);
  if (categories.length) {
    const list = categories.length === 1 ? categories[0]
      : `${categories.slice(0, -1).join(", ")} and ${categories.at(-1)}`;
    const verb = categories.length === 1 && categories[0] !== "other topics" ? "is" : "are";
    sentences.push(`Among the selected events, ${list} ${verb} most prominent.`);
  }
  if (directionalEventCount <= 2) {
    sentences.push("This assessment currently rests on a small number of validated directional events.");
  }
  sentences.push(CLOSING);
  return sentences.join(" ");
}

module.exports = { buildNewsLageSummary };

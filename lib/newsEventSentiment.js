"use strict";

const { eventWeightComponents } = require("./newsEventWeight");

const NEWS_LAGE_V2_SENTIMENT_VERSION = "news-lage-v2";
const NEWS_LAGE_V2_SENTIMENT_METHODOLOGY = "validated_event_weighted_directional_balance";
const EFFECTIVELY_ZERO_WEIGHT = 1e-12;

function clampScore(value) {
  return Math.max(-100, Math.min(100, value));
}

// Exact, non-overlapping boundaries: -60 is stark bearish; -20 and +20 are
// balanced; +60 is stark bullish.
function sentimentLabel(sentimentScore) {
  const score = clampScore(Number.isFinite(sentimentScore) ? sentimentScore : 0);
  if (score <= -60) return "stark bearish";
  if (score < -20) return "bearish";
  if (score <= 20) return "neutral/ausgeglichen";
  if (score < 60) return "bullish";
  return "stark bullish";
}

/**
 * Pure News-Lage v2 aggregation over already window-filtered stored events.
 * The signed direction is applied only here: bullish is +weight, bearish is
 * -weight. eventWeightComponents independently verifies the stored causal
 * mechanism, so neutral or contradictory events cannot enter P or N.
 */
function aggregateNewsLageSentiment(events, {
  market,
  windowDays = 30,
  referenceTime,
} = {}) {
  if (market !== "china" && market !== "eu") throw new RangeError("market must be china or eu");
  const inputEvents = Array.isArray(events) ? events : [];
  let bullishWeight = 0;
  let bearishWeight = 0;
  let bullishEventCount = 0;
  let bearishEventCount = 0;
  let neutralEventCount = 0;
  let totalEventCount = 0;

  for (const event of inputEvents) {
    const components = eventWeightComponents(event, market, referenceTime);
    // The caller may provide all stored events so global transfer remains
    // available; events with no effective relevance are not part of this
    // market's News-Lage v2 event set.
    if (components.relevanceComponent <= 0) continue;
    totalEventCount += 1;
    if (!components.directional || components.finalWeight <= EFFECTIVELY_ZERO_WEIGHT) {
      neutralEventCount += 1;
      continue;
    }
    if (event.direction === "bullish") {
      bullishWeight += components.finalWeight;
      bullishEventCount += 1;
    } else if (event.direction === "bearish") {
      bearishWeight += components.finalWeight;
      bearishEventCount += 1;
    } else {
      neutralEventCount += 1;
    }
  }

  const directionalEventCount = bullishEventCount + bearishEventCount;
  const totalDirectionalWeight = bullishWeight + bearishWeight;
  const sentimentScore = totalDirectionalWeight <= EFFECTIVELY_ZERO_WEIGHT
    ? 0
    : clampScore(((bullishWeight - bearishWeight) / totalDirectionalWeight) * 100);

  return {
    sentimentScore,
    sentimentLabel: sentimentLabel(sentimentScore),
    bullishWeight,
    bearishWeight,
    directionalEventCount,
    totalEventCount,
    bullishEventCount,
    bearishEventCount,
    neutralEventCount,
    windowDays,
    methodology: NEWS_LAGE_V2_SENTIMENT_METHODOLOGY,
    version: NEWS_LAGE_V2_SENTIMENT_VERSION,
  };
}

module.exports = {
  NEWS_LAGE_V2_SENTIMENT_VERSION,
  NEWS_LAGE_V2_SENTIMENT_METHODOLOGY,
  EFFECTIVELY_ZERO_WEIGHT,
  clampScore,
  sentimentLabel,
  aggregateNewsLageSentiment,
};

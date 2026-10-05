"use strict";

const { EFFECTIVELY_ZERO_WEIGHT } = require("./newsEventSentiment");
const { eventTime } = require("./newsEventFreshness");

/**
 * Presentation selection only. Input must be the already validated, persisted,
 * deduplicated 30-day per-market getRecentEventDetails() result. This function
 * performs no DB reads, classification, windowing, weighting or normalization.
 * Neutral events with zero weight are not promoted to fill the list.
 */
function selectTopEvents(events, { topN = 5 } = {}) {
  if (!Number.isInteger(topN) || topN < 0) throw new RangeError("topN must be a non-negative integer");
  if (!Array.isArray(events)) return [];
  return events.filter(event => event && typeof event.eventKey === "string" && event.eventKey.trim()
    && Number.isFinite(event.effectiveMarketRelevance) && event.effectiveMarketRelevance > 0
    && Number.isFinite(event.finalWeight) && event.finalWeight > EFFECTIVELY_ZERO_WEIGHT)
    .map(event => ({ event, timestamp: eventTime(event) }))
    .filter(({ timestamp }) => Number.isFinite(timestamp))
    .sort((a, b) => b.event.finalWeight - a.event.finalWeight || b.timestamp - a.timestamp
      || (a.event.eventKey < b.event.eventKey ? -1 : a.event.eventKey > b.event.eventKey ? 1 : 0))
    .slice(0, topN)
    .map(({ event, timestamp }) => {
      const sources = Array.isArray(event.sources) ? event.sources.filter(source => typeof source === "string" && source.trim()) : [];
      return {
        eventKey: event.eventKey,
        date: new Date(timestamp).toISOString(),
        title: event.title,
        source: sources[0] || null,
        provenance: { sources },
        direction: event.direction,
        category: event.category,
        eventStage: event.eventStage,
        evidenceMaturity: event.evidenceMaturity,
        finalWeight: event.finalWeight,
      };
    });
}

module.exports = { selectTopEvents };

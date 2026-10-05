"use strict";

const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");

const DEFAULT_MIN_DIRECTIONAL_EVENTS = 3;
const METHODOLOGY = "historical_association_directional_alignment";
const METHODOLOGY_NOTE = "Historical association of validated event direction and subsequent price movement only; no causal interpretation. A low hit rate alone does not establish that a classification is wrong.";

function validMinimum(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("minDirectionalEvents must be an integer of at least 1");
  }
  return value;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function groupSort(left, right) {
  return left.market.localeCompare(right.market) || left.horizonWeeks - right.horizonWeeks;
}

// Pure diagnostic. It considers only finite returns from completed (available)
// outcomes. Neutral events remain in completedOutcomeCount but are deliberately
// excluded from directional success and hit-rate calculations.
function validateHistoricalEventDirections({
  events = [],
  outcomes = [],
  minDirectionalEvents = DEFAULT_MIN_DIRECTIONAL_EVENTS,
} = {}) {
  const minimum = validMinimum(minDirectionalEvents);
  const eventsById = new Map(
    events
      .filter((event) => typeof event?.eventId === "string" && event.eventId.trim())
      .map((event) => [event.eventId, event])
  );
  const grouped = new Map();

  for (const outcome of outcomes) {
    if (outcome?.status !== "available" || !Number.isFinite(outcome.returnPct)) continue;
    if (outcome.market !== "china" && outcome.market !== "eu") continue;
    if (!Number.isInteger(outcome.horizonWeeks) || outcome.horizonWeeks < 1) continue;
    const event = eventsById.get(outcome.eventId);
    if (!event || !["bullish", "bearish", "neutral"].includes(event.direction)) continue;
    const key = `${outcome.market}|${outcome.horizonWeeks}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        market: outcome.market,
        horizonWeeks: outcome.horizonWeeks,
        completedOutcomeCount: 0,
        directionalEventIds: new Set(),
        correctDirectionEventIds: new Set(),
        bullishReturns: [],
        bearishReturns: [],
      });
    }
    const aggregate = grouped.get(key);
    aggregate.completedOutcomeCount += 1;
    if (event.direction === "neutral") continue;

    aggregate.directionalEventIds.add(event.eventId);
    if (event.direction === "bullish") {
      aggregate.bullishReturns.push(outcome.returnPct);
      if (outcome.returnPct > 0) aggregate.correctDirectionEventIds.add(event.eventId);
    } else {
      aggregate.bearishReturns.push(outcome.returnPct);
      if (outcome.returnPct < 0) aggregate.correctDirectionEventIds.add(event.eventId);
    }
  }

  const groups = [...grouped.values()].map((aggregate) => {
    const directionalEventCount = aggregate.directionalEventIds.size;
    const insufficientEvidence = directionalEventCount < minimum;
    return {
      market: aggregate.market,
      horizonWeeks: aggregate.horizonWeeks,
      completedOutcomeCount: aggregate.completedOutcomeCount,
      directionalEventCount,
      correctDirectionCount: aggregate.correctDirectionEventIds.size,
      insufficientEvidence,
      evidenceStatus: insufficientEvidence ? "insufficient_evidence" : "sufficient_sample",
      directionalHitRate: insufficientEvidence
        ? null
        : aggregate.correctDirectionEventIds.size / directionalEventCount,
      medianReturnBullishEvents: insufficientEvidence ? null : median(aggregate.bullishReturns),
      medianReturnBearishEvents: insufficientEvidence ? null : median(aggregate.bearishReturns),
    };
  }).sort(groupSort);

  return {
    methodology: METHODOLOGY,
    methodologyNote: METHODOLOGY_NOTE,
    minDirectionalEvents: minimum,
    groups,
  };
}

// Read-only adapter for stored event studies. This function is deliberately
// separate from all live forecast, sentiment, Fusion, and scenario paths.
function collectHistoricalDirectionValidation({
  databasePath = DEFAULT_DATABASE_PATH,
  minDirectionalEvents = DEFAULT_MIN_DIRECTIONAL_EVENTS,
  createStore = (options) => new NewsEventStore(options),
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const events = store.getAllEvents();
    const outcomes = events.flatMap((event) => store.getPriceOutcomes({ eventId: event.eventId }));
    return validateHistoricalEventDirections({ events, outcomes, minDirectionalEvents });
  } finally {
    store?.close();
  }
}

module.exports = {
  DEFAULT_MIN_DIRECTIONAL_EVENTS,
  METHODOLOGY,
  METHODOLOGY_NOTE,
  validateHistoricalEventDirections,
  collectHistoricalDirectionValidation,
};

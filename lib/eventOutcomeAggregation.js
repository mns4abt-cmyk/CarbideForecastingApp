"use strict";

const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");

const DEFAULT_MIN_COMPLETED_OUTCOMES = 3;
const METHODOLOGY = "historical_association_subsequent_price_movement";
const METHODOLOGY_NOTE = "Historical association and historical subsequent price movement only; no causal interpretation.";

function validMinimum(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("minCompletedOutcomes must be an integer of at least 1");
  }
  return value;
}

function groupValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function groupSort(left, right) {
  for (const field of ["category", "direction", "supplyEffect", "demandEffect", "evidenceMaturity", "market"]) {
    const compared = left[field].localeCompare(right[field]);
    if (compared) return compared;
  }
  return left.horizonWeeks - right.horizonWeeks;
}

function emptyStatistics() {
  return {
    meanReturnPct: null,
    medianReturnPct: null,
    positiveShare: null,
    negativeShare: null,
    minReturnPct: null,
    maxReturnPct: null,
  };
}

// Pure aggregation over validated event records and completed stored outcomes.
// A group contains only outcomes with status "available" and a finite return;
// pending and unavailable horizons therefore cannot affect any statistics.
function aggregateHistoricalEventOutcomes({
  events = [],
  outcomes = [],
  minCompletedOutcomes = DEFAULT_MIN_COMPLETED_OUTCOMES,
} = {}) {
  const minimum = validMinimum(minCompletedOutcomes);
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
    if (!event) continue;
    const group = {
      category: groupValue(event.category),
      direction: groupValue(event.direction),
      supplyEffect: groupValue(event.supplyEffect),
      demandEffect: groupValue(event.demandEffect),
      evidenceMaturity: groupValue(event.evidenceMaturity),
      market: outcome.market,
      horizonWeeks: outcome.horizonWeeks,
    };
    const key = JSON.stringify(Object.values(group));
    if (!grouped.has(key)) grouped.set(key, { ...group, eventIds: new Set(), returns: [] });
    const aggregate = grouped.get(key);
    aggregate.eventIds.add(event.eventId);
    aggregate.returns.push(outcome.returnPct);
  }

  const groups = [...grouped.values()].map((aggregate) => {
    const completedOutcomeCount = aggregate.returns.length;
    const insufficientEvidence = completedOutcomeCount < minimum;
    const statistics = insufficientEvidence
      ? emptyStatistics()
      : {
        meanReturnPct: aggregate.returns.reduce((sum, value) => sum + value, 0) / completedOutcomeCount,
        medianReturnPct: median(aggregate.returns),
        positiveShare: aggregate.returns.filter((value) => value > 0).length / completedOutcomeCount,
        negativeShare: aggregate.returns.filter((value) => value < 0).length / completedOutcomeCount,
        minReturnPct: Math.min(...aggregate.returns),
        maxReturnPct: Math.max(...aggregate.returns),
      };
    return {
      category: aggregate.category,
      direction: aggregate.direction,
      supplyEffect: aggregate.supplyEffect,
      demandEffect: aggregate.demandEffect,
      evidenceMaturity: aggregate.evidenceMaturity,
      market: aggregate.market,
      horizonWeeks: aggregate.horizonWeeks,
      // Unique event IDs are reported separately from outcome rows. With the
      // persistent table's event/market/horizon key they normally match.
      eventCount: aggregate.eventIds.size,
      completedOutcomeCount,
      insufficientEvidence,
      ...statistics,
    };
  }).sort(groupSort);

  return {
    methodology: METHODOLOGY,
    methodologyNote: METHODOLOGY_NOTE,
    minCompletedOutcomes: minimum,
    groups,
  };
}

// Read-only store adapter for offline analysis. It deliberately does not
// participate in forecast refreshes, News-Lage, Evidence Fusion, or scenarios.
function collectHistoricalEventOutcomeAssociations({
  databasePath = DEFAULT_DATABASE_PATH,
  minCompletedOutcomes = DEFAULT_MIN_COMPLETED_OUTCOMES,
  createStore = (options) => new NewsEventStore(options),
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const events = store.getAllEvents();
    const outcomes = events.flatMap((event) => store.getPriceOutcomes({ eventId: event.eventId }));
    return aggregateHistoricalEventOutcomes({ events, outcomes, minCompletedOutcomes });
  } finally {
    store?.close();
  }
}

// Additive API preparation for the secondary historical-association UI. Store
// failures are isolated so the statistical forecast and all existing news
// views remain operational.
function loadHistoricalEventOutcomeAssociations({
  databasePath = DEFAULT_DATABASE_PATH,
  minCompletedOutcomes = DEFAULT_MIN_COMPLETED_OUTCOMES,
  createStore = (options) => new NewsEventStore(options),
  logger = console,
} = {}) {
  const minimum = validMinimum(minCompletedOutcomes);
  try {
    return {
      available: true,
      ...collectHistoricalEventOutcomeAssociations({
        databasePath,
        minCompletedOutcomes: minimum,
        createStore,
      }),
    };
  } catch (error) {
    logger.warn("[Historical event association] Stored outcome history unavailable:", error.message);
    return {
      available: false,
      methodology: METHODOLOGY,
      methodologyNote: METHODOLOGY_NOTE,
      minCompletedOutcomes: minimum,
      groups: [],
    };
  }
}

module.exports = {
  DEFAULT_MIN_COMPLETED_OUTCOMES,
  METHODOLOGY,
  METHODOLOGY_NOTE,
  aggregateHistoricalEventOutcomes,
  collectHistoricalEventOutcomeAssociations,
  loadHistoricalEventOutcomeAssociations,
};

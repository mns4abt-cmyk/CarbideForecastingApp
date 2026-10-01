"use strict";

const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");
const { effectiveMarketRelevance } = require("./newsEventWeight");

const MARKETS = ["china", "eu"];
const HORIZONS = [1, 4, 12, 26];
const METHODOLOGY_NOTE = "Historical association / subsequent price movement only; no causal interpretation.";

function eventDate(event) {
  return event.publishedAt || event.firstSeenAt || null;
}

function sampleEvent(event, outcomes) {
  const byHorizon = new Map(outcomes.map((outcome) => [outcome.horizonWeeks, outcome]));
  const returnAt = (horizonWeeks) => {
    const outcome = byHorizon.get(horizonWeeks);
    return outcome?.status === "available" ? outcome.returnPct : null;
  };
  return {
    eventId: event.eventId,
    date: eventDate(event),
    title: event.title,
    direction: event.direction,
    priceAtEvent: outcomes.find((outcome) => Number.isFinite(outcome.priceAtEvent))?.priceAtEvent ?? null,
    return1w: returnAt(1),
    return4w: returnAt(4),
    return12w: returnAt(12),
    return26w: returnAt(26),
  };
}

function marketReport(events, store, market) {
  const relevantEvents = events
    .filter((event) => effectiveMarketRelevance(event, market) > 0)
    .sort((left, right) => (
      String(eventDate(right) || "").localeCompare(String(eventDate(left) || ""))
      || String(left.eventId).localeCompare(String(right.eventId))
    ));
  const eventOutcomes = relevantEvents.map((event) => ({
    event,
    outcomes: store.getPriceOutcomes({ eventId: event.eventId, market }),
  }));
  const outcomes = eventOutcomes.flatMap((item) => item.outcomes);
  const completedAt = (horizonWeeks) => outcomes.filter(
    (outcome) => outcome.horizonWeeks === horizonWeeks && outcome.status === "available"
  ).length;
  return {
    storedEventCount: relevantEvents.length,
    eventsWithPriceAtEvent: eventOutcomes.filter((item) => (
      item.outcomes.some((outcome) => Number.isFinite(outcome.priceAtEvent))
    )).length,
    completed1wOutcomes: completedAt(1),
    completed4wOutcomes: completedAt(4),
    completed12wOutcomes: completedAt(12),
    completed26wOutcomes: completedAt(26),
    pendingOutcomes: outcomes.filter((outcome) => outcome.status === "pending").length,
    unavailableOutcomes: outcomes.filter((outcome) => outcome.status === "unavailable").length,
    sampleEvents: eventOutcomes.slice(0, 10).map(({ event, outcomes: rows }) => sampleEvent(event, rows)),
  };
}

// Read-only report. It intentionally summarizes stored observation/outcome
// fields only and does not infer why a subsequent price movement occurred.
function collectEventOutcomeDiagnostics({
  databasePath = DEFAULT_DATABASE_PATH,
  createStore = (options) => new NewsEventStore(options),
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const events = store.getAllEvents();
    return {
      databasePath,
      methodologyNote: METHODOLOGY_NOTE,
      china: marketReport(events, store, "china"),
      eu: marketReport(events, store, "eu"),
    };
  } finally {
    store?.close();
  }
}

module.exports = {
  HORIZONS,
  METHODOLOGY_NOTE,
  collectEventOutcomeDiagnostics,
};

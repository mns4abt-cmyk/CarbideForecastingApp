"use strict";

const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");
const { MARKET_SERIES } = require("./eventPriceAssociation");
const { loadNormalizedWeeklySeries } = require("./eventOutcomeBackfill");

const METHODOLOGY = Object.freeze({
  eventPriceRule: "Latest valid normalized weekly price observation on or before the event date; no future price is used.",
  forwardOutcomeRule: "First valid normalized weekly price observation on or after the 1/4/12/26-week target date, within seven days and not after the explicit as-of date.",
  interpretation: "Historical association and subsequent price movement only; no causal interpretation.",
  numericalForecastAdjustmentApplied: false,
});

function displaySafeProvenance(provenance) {
  const duplicateSources = Array.isArray(provenance?.duplicateSources)
    ? [...new Set(provenance.duplicateSources.filter((source) => typeof source === "string" && source.trim()))]
    : [];
  return {
    source: typeof provenance?.source === "string" && provenance.source.trim() ? provenance.source : null,
    duplicateSources,
  };
}

function projectEvent(event, priceOutcomes) {
  return {
    eventKey: event.eventKey,
    eventId: event.eventId,
    publishedAt: event.publishedAt,
    firstSeenAt: event.firstSeenAt,
    title: event.title,
    category: event.category,
    direction: event.direction,
    supplyEffect: event.supplyEffect,
    demandEffect: event.demandEffect,
    eventStage: event.eventStage,
    evidenceMaturity: event.evidenceMaturity,
    chinaRelevance: event.chinaRelevance,
    euRelevance: event.euRelevance,
    provenance: displaySafeProvenance(event.provenance),
    priceOutcomes: Array.isArray(priceOutcomes) ? priceOutcomes.map((outcome) => ({ ...outcome })) : [],
  };
}

function projectWeeklyPrices(weeklySeries) {
  const rows = Array.isArray(weeklySeries) ? weeklySeries : [];
  return Object.fromEntries(Object.entries(MARKET_SERIES).map(([market, definition]) => [
    market,
    rows.flatMap((row) => {
      const value = Number(row?.[definition.column]);
      if (typeof row?.week !== "string" || !Number.isFinite(value) || value <= 0) return [];
      return [{ date: row.week, value, unit: definition.unit }];
    }),
  ]));
}

function unavailableTimeline() {
  return {
    available: false,
    methodology: METHODOLOGY,
    error: {
      code: "historical_event_price_timeline_unavailable",
      message: "Historical event-price timeline is currently unavailable.",
    },
    events: [],
    weeklyPrices: { china: [], eu: [] },
  };
}

async function loadHistoricalEventPriceTimeline({
  databasePath = DEFAULT_DATABASE_PATH,
  createStore = (options) => new NewsEventStore(options),
  loadWeeklySeries = loadNormalizedWeeklySeries,
  logger = console,
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const events = store.getAllEvents().map((event) => projectEvent(
      event,
      store.getPriceOutcomes({ eventId: event.eventId })
    ));
    const weeklyPrices = projectWeeklyPrices(await loadWeeklySeries());
    return { available: true, methodology: METHODOLOGY, events, weeklyPrices };
  } catch (error) {
    logger.warn("[Historical event-price timeline] Read-only load failed:", error.message);
    return unavailableTimeline();
  } finally {
    try {
      store?.close();
    } catch (error) {
      logger.warn("[Historical event-price timeline] Store close failed:", error.message);
    }
  }
}

module.exports = {
  METHODOLOGY,
  displaySafeProvenance,
  projectEvent,
  projectWeeklyPrices,
  unavailableTimeline,
  loadHistoricalEventPriceTimeline,
};
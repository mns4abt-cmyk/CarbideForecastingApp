"use strict";

const { NewsEventStore } = require("./newsEventStore");
const { selectTopEvents } = require("./newsLageTopEvents");
const { buildNewsLageSummary } = require("./newsLageSummary");

const DEFAULT_WINDOW_DAYS = 30;
const NEWS_LAGE_V2_METHOD = "30d_event_history_weighted_sentiment";

function unavailableMarket(windowDays) {
  return {
    sentimentScore: null,
    qualitativeLabel: "unavailable",
    windowDays,
    bullishWeight: null,
    bearishWeight: null,
    directionalEventCount: null,
    totalEventCount: null,
    bullishEventCount: null,
    bearishEventCount: null,
    neutralEventCount: null,
    lastUpdatedAt: null,
  };
}

function publicMarketResult(result) {
  return {
    sentimentScore: result.sentimentScore,
    qualitativeLabel: result.sentimentLabel,
    windowDays: result.windowDays,
    bullishWeight: result.bullishWeight,
    bearishWeight: result.bearishWeight,
    directionalEventCount: result.directionalEventCount,
    totalEventCount: result.totalEventCount,
    bullishEventCount: result.bullishEventCount,
    bearishEventCount: result.bearishEventCount,
    neutralEventCount: result.neutralEventCount,
    lastUpdatedAt: result.lastUpdatedAt,
  };
}

// Runs only on data already loaded below; each market has its own error boundary.
function withManagementSummary(newsLage, selectEvents, buildSummary) {
  const managementSummary = {};
  for (const market of ["china", "eu"]) {
    const data = newsLage[market];
    const base = {
      status: "unavailable",
      text: "There is insufficient information for a directional news assessment. The statistical price forecast is not adjusted by this news assessment.",
      qualitativeLabel: data?.qualitativeLabel ?? "unavailable",
      topEvents: [],
      totalEventCount: newsLage.available ? data?.totalEventCount ?? null : null,
      directionalEventCount: newsLage.available ? data?.directionalEventCount ?? null : null,
      generatedFrom: "validated_30d_events",
      additionalLlmCalls: false,
      numericalForecastAdjustmentApplied: false,
    };
    managementSummary[market] = base;
    try {
      // The wording builder's contract is explicitly 30 days. Other existing
      // loader windows still work, but must not be described as 30-day evidence.
      if (!newsLage.available || newsLage.windowDays !== 30 || !data
        || !Number.isInteger(data.totalEventCount) || data.totalEventCount < 0
        || !Number.isInteger(data.directionalEventCount) || data.directionalEventCount < 0
        || data.directionalEventCount > data.totalEventCount
        || !Number.isFinite(data.sentimentScore) || data.qualitativeLabel === "unavailable"
        || !Array.isArray(newsLage.events?.[market])) continue;
      const topEvents = selectEvents(newsLage.events[market]);
      const text = buildSummary({ ...data, topEvents });
      managementSummary[market] = { ...base,
        status: data.totalEventCount === 0 ? "empty" : "available", text, topEvents };
    } catch {
      // Preserve original labels/counts when only summary generation fails.
      // Do not expose internal errors or affect the other market or News-Lage.
    }
  }
  return { ...newsLage, managementSummary };
}

// Read-only API preparation for the News-Lage v2 card. It has no dependency
// on the forecasting pipeline, scenarios, currentMarket, or Evidence Fusion.
function loadNewsLageV2({
  databasePath,
  windowDays = DEFAULT_WINDOW_DAYS,
  referenceTime = new Date().toISOString(),
  createStore = (options) => new NewsEventStore(options),
  logger = console,
  selectEvents = selectTopEvents,
  buildSummary = buildNewsLageSummary,
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const china = publicMarketResult(store.getRecentSentiment({ days: windowDays, market: "china", referenceTime }));
    const eu = publicMarketResult(store.getRecentSentiment({ days: windowDays, market: "eu", referenceTime }));
    return withManagementSummary({
      available: true,
      windowDays,
      china,
      eu,
      events: {
        china: store.getRecentEventDetails({ days: windowDays, market: "china", referenceTime }),
        eu: store.getRecentEventDetails({ days: windowDays, market: "eu", referenceTime }),
      },
      methodology: {
        method: NEWS_LAGE_V2_METHOD,
        numericalForecastAdjustmentApplied: false,
      },
    }, selectEvents, buildSummary);
  } catch (error) {
    logger.warn("[News-Lage v2] Stored event history unavailable:", error.message);
    return withManagementSummary({
      available: false,
      windowDays,
      china: unavailableMarket(windowDays),
      eu: unavailableMarket(windowDays),
      events: { china: [], eu: [] },
      methodology: {
        method: NEWS_LAGE_V2_METHOD,
        numericalForecastAdjustmentApplied: false,
      },
    }, selectEvents, buildSummary);
  } finally {
    try {
      store?.close();
    } catch (error) {
      logger.warn("[News-Lage v2] Closing event store failed:", error.message);
    }
  }
}

module.exports = { DEFAULT_WINDOW_DAYS, NEWS_LAGE_V2_METHOD, loadNewsLageV2 };

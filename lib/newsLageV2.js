"use strict";

const { NewsEventStore } = require("./newsEventStore");

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

// Read-only API preparation for the News-Lage v2 card. It has no dependency
// on the forecasting pipeline, scenarios, currentMarket, or Evidence Fusion.
function loadNewsLageV2({
  databasePath,
  windowDays = DEFAULT_WINDOW_DAYS,
  referenceTime = new Date().toISOString(),
  createStore = (options) => new NewsEventStore(options),
  logger = console,
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const china = publicMarketResult(store.getRecentSentiment({ days: windowDays, market: "china", referenceTime }));
    const eu = publicMarketResult(store.getRecentSentiment({ days: windowDays, market: "eu", referenceTime }));
    return {
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
    };
  } catch (error) {
    logger.warn("[News-Lage v2] Stored event history unavailable:", error.message);
    return {
      available: false,
      windowDays,
      china: unavailableMarket(windowDays),
      eu: unavailableMarket(windowDays),
      events: { china: [], eu: [] },
      methodology: {
        method: NEWS_LAGE_V2_METHOD,
        numericalForecastAdjustmentApplied: false,
      },
    };
  } finally {
    try {
      store?.close();
    } catch (error) {
      logger.warn("[News-Lage v2] Closing event store failed:", error.message);
    }
  }
}

module.exports = { DEFAULT_WINDOW_DAYS, NEWS_LAGE_V2_METHOD, loadNewsLageV2 };

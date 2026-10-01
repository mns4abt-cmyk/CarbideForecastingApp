"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");
const { loadNewsLageV2 } = require("./newsLageV2");

const WINDOW_DAYS = 30;
const MARKETS = ["china", "eu"];
const SCORE_MIN = -100;
const SCORE_MAX = 100;

function eventTime(event) {
  return event.publishedAt || event.firstSeenAt || null;
}

function eventSummary(event) {
  return {
    eventId: event.eventId,
    date: eventTime(event),
    title: event.title,
    direction: event.direction,
    finalWeight: event.finalWeight,
    sources: event.sources,
    sourceCount: event.sourceCount,
  };
}

function boundaryEvent(events, direction) {
  const ordered = [...events].sort((left, right) => {
    const leftTime = new Date(eventTime(left)).getTime();
    const rightTime = new Date(eventTime(right)).getTime();
    return direction === "oldest" ? leftTime - rightTime : rightTime - leftTime;
  });
  return ordered.length ? eventSummary(ordered[0]) : null;
}

function restartCheck(databasePath, expectedEventCount, spawn = spawnSync) {
  const storeModule = path.join(__dirname, "newsEventStore.js");
  const child = spawn(process.execPath, [
    "-e",
    "const { NewsEventStore } = require(process.argv[1]); const store = new NewsEventStore({ databasePath: process.argv[2] }); try { process.stdout.write(String(store.diagnostics().totalEvents)); } finally { store.close(); }",
    storeModule,
    databasePath,
  ], { encoding: "utf8" });
  const observedEventCount = Number.parseInt(child.stdout, 10);
  return {
    valid: child.status === 0 && observedEventCount === expectedEventCount,
    expectedEventCount,
    observedEventCount: Number.isFinite(observedEventCount) ? observedEventCount : null,
    error: child.status === 0 ? null : (child.stderr || "child process failed").trim(),
  };
}

function marketDiagnostic(store, market, referenceTime) {
  const sentiment = store.getRecentSentiment({ days: WINDOW_DAYS, market, referenceTime });
  const events = store.getRecentEventDetails({ days: WINDOW_DAYS, market, referenceTime });
  return {
    eventsLast30Days: sentiment.totalEventCount,
    directionalEvents: sentiment.directionalEventCount,
    bullishEvents: sentiment.bullishEventCount,
    bearishEvents: sentiment.bearishEventCount,
    neutralEvents: sentiment.neutralEventCount,
    bullishTotalWeight: sentiment.bullishWeight,
    bearishTotalWeight: sentiment.bearishWeight,
    sentimentScore: sentiment.sentimentScore,
    qualitativeLabel: sentiment.sentimentLabel,
    oldestEventInWindow: boundaryEvent(events, "oldest"),
    newestEventInWindow: boundaryEvent(events, "newest"),
    topContributingEvents: events.slice(0, 5).map(eventSummary),
    events,
  };
}

// Read-only operational diagnostic for News-Lage v2. `events` is kept in the
// returned object solely for validation; the command prints only the compact
// report fields above. It has no dependency on forecasts, scenarios or Fusion.
function collectNewsLageDiagnostics({
  databasePath = DEFAULT_DATABASE_PATH,
  referenceTime = new Date().toISOString(),
  createStore = (options) => new NewsEventStore(options),
  restartVerifier = restartCheck,
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const diagnostics = store.diagnostics(referenceTime);
    const duplicateIds = store.getDuplicateEventIds();
    const markets = Object.fromEntries(MARKETS.map((market) => [
      market,
      {
        databasePath,
        totalStoredEvents: diagnostics.totalEvents,
        ...marketDiagnostic(store, market, referenceTime),
      },
    ]));
    const newsLage = loadNewsLageV2({ databasePath, referenceTime });
    const invalidWeights = MARKETS.flatMap((market) => markets[market].events
      .filter((event) => !Number.isFinite(event.finalWeight) || event.finalWeight < 0)
      .map((event) => ({ market, eventId: event.eventId, finalWeight: event.finalWeight })));
    const scoreViolations = MARKETS.flatMap((market) => {
      const score = markets[market].sentimentScore;
      return Number.isFinite(score) && score >= SCORE_MIN && score <= SCORE_MAX
        ? []
        : [{ market, sentimentScore: score }];
    });

    // Close before opening a fresh Node process, so the restart check verifies
    // the persisted file rather than this process's in-memory connection.
    store.close();
    store = null;
    const restart = restartVerifier(databasePath, diagnostics.totalEvents);
    const numericalForecastAdjustmentApplied = newsLage?.methodology?.numericalForecastAdjustmentApplied;

    return {
      databasePath,
      referenceTime,
      windowDays: WINDOW_DAYS,
      totalStoredEvents: diagnostics.totalEvents,
      china: markets.china,
      eu: markets.eu,
      validations: {
        noDuplicateEventIds: { valid: duplicateIds.length === 0, duplicateEventIds: duplicateIds },
        noNegativeEventWeights: { valid: invalidWeights.length === 0, violations: invalidWeights },
        sentimentScoreWithinBounds: { valid: scoreViolations.length === 0, violations: scoreViolations },
        noNumericalForecastAdjustment: {
          valid: numericalForecastAdjustmentApplied === false,
          numericalForecastAdjustmentApplied,
        },
        databaseSurvivesProcessRestart: restart,
      },
    };
  } finally {
    store?.close();
  }
}

function reportHasFailures(report) {
  return Object.values(report.validations).some((validation) => !validation.valid);
}

module.exports = {
  WINDOW_DAYS,
  collectNewsLageDiagnostics,
  reportHasFailures,
  restartCheck,
};

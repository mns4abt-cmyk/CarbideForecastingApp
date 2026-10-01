"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore } = require("../lib/newsEventStore");
const {
  collectNewsLageDiagnostics,
  reportHasFailures,
  restartCheck,
} = require("../lib/newsLageDiagnostics");
const { printableMarket } = require("../scripts/diagnose-news-lage");

const REFERENCE_TIME = "2026-09-30T12:00:00.000Z";

function event(overrides = {}) {
  return {
    eventId: "event-1",
    representativeArticleId: "article-1",
    headline: "China tungsten export controls take effect",
    category: "regulation",
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    eventStage: "actual",
    evidenceMaturity: "realized",
    severity: 0.8,
    confidence: 0.9,
    globalRelevance: 0,
    chinaRelevance: 1,
    euRelevance: 0,
    horizonWeeks: 26,
    duplicateCount: 2,
    duplicateSources: ["Source A", "Source B"],
    ...overrides,
  };
}

function article(eventId, date, title) {
  return {
    id: `article-${eventId}`,
    date,
    title,
    source: "Source A",
    sourceId: "source-a",
  };
}

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-lage-diagnostic-"));
  const databasePath = path.join(directory, "news-events.db");
  return { directory, databasePath };
}

test("News-Lage diagnostic reports 30-day China/EU sentiment, contributions, and safety validations", () => {
  const { directory, databasePath } = createDatabase();
  const store = new NewsEventStore({ databasePath, now: () => REFERENCE_TIME });
  try {
    store.upsert(event(), article("event-1", "2026-09-29T12:00:00.000Z", "China tungsten export controls take effect"));
    store.upsert(event({
      eventId: "event-2",
      headline: "European mine restarts tungsten production",
      direction: "bearish",
      supplyEffect: "increase",
      severity: 0.4,
      chinaRelevance: 0,
      euRelevance: 1,
      duplicateCount: 1,
    }), article("event-2", "2026-09-28T12:00:00.000Z", "European mine restarts tungsten production"));
    store.upsert(event({
      eventId: "event-3",
      headline: "Global tungsten market update",
      direction: "neutral",
      supplyEffect: "none",
      globalRelevance: 0.6,
      chinaRelevance: 0,
      euRelevance: 0,
      duplicateCount: 1,
    }), article("event-3", "2026-09-27T12:00:00.000Z", "Global tungsten market update"));
  } finally {
    store.close();
  }

  try {
    const report = collectNewsLageDiagnostics({
      databasePath,
      referenceTime: REFERENCE_TIME,
      restartVerifier: (file, count) => ({ valid: file === databasePath && count === 3, expectedEventCount: count, observedEventCount: count, error: null }),
    });
    assert.equal(report.databasePath, databasePath);
    assert.equal(report.totalStoredEvents, 3);
    assert.equal(report.china.databasePath, databasePath);
    assert.equal(report.eu.totalStoredEvents, 3);
    assert.equal(report.china.eventsLast30Days, 2);
    assert.equal(report.china.directionalEvents, 1);
    assert.equal(report.china.bullishEvents, 1);
    assert.equal(report.china.neutralEvents, 1);
    assert.equal(report.eu.eventsLast30Days, 2);
    assert.equal(report.eu.bearishEvents, 1);
    assert.equal(report.china.topContributingEvents[0].eventId, "event-1");
    assert.equal(report.eu.topContributingEvents[0].eventId, "event-2");
    assert.equal(report.china.oldestEventInWindow.eventId, "event-3");
    assert.equal(report.china.newestEventInWindow.eventId, "event-1");
    assert.deepEqual(report.validations, {
      noDuplicateEventIds: { valid: true, duplicateEventIds: [] },
      noNegativeEventWeights: { valid: true, violations: [] },
      sentimentScoreWithinBounds: { valid: true, violations: [] },
      noNumericalForecastAdjustment: { valid: true, numericalForecastAdjustmentApplied: false },
      databaseSurvivesProcessRestart: { valid: true, expectedEventCount: 3, observedEventCount: 3, error: null },
    });
    assert.equal(reportHasFailures(report), false);
    const printable = printableMarket(report.china);
    assert.equal("events" in printable, false);
    assert.deepEqual(printable.topContributingEvents[0].sources, ["Source A", "Source B"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("News-Lage diagnostic detects duplicate durable event IDs", () => {
  const { directory, databasePath } = createDatabase();
  const store = new NewsEventStore({ databasePath, now: () => REFERENCE_TIME });
  try {
    store.upsert(event({ eventId: "duplicate-id" }), article("one", "2026-09-29T12:00:00.000Z", "China tungsten export controls take effect"));
    store.upsert(event({ eventId: "different-id", headline: "European tungsten mine restarts", chinaRelevance: 0, euRelevance: 1 }), article("two", "2026-09-28T12:00:00.000Z", "European tungsten mine restarts"));
    store.db.prepare("UPDATE news_events SET event_id = ? WHERE event_id = ?").run("duplicate-id", "different-id");
  } finally {
    store.close();
  }

  try {
    const report = collectNewsLageDiagnostics({
      databasePath,
      referenceTime: REFERENCE_TIME,
      restartVerifier: () => ({ valid: true, expectedEventCount: 2, observedEventCount: 2, error: null }),
    });
    assert.deepEqual(report.validations.noDuplicateEventIds, { valid: false, duplicateEventIds: ["duplicate-id"] });
    assert.equal(reportHasFailures(report), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart check reads the durable SQLite event count from a fresh Node process", () => {
  const { directory, databasePath } = createDatabase();
  const store = new NewsEventStore({ databasePath, now: () => REFERENCE_TIME });
  try {
    store.upsert(event(), article("event-1", "2026-09-29T12:00:00.000Z", "China tungsten export controls take effect"));
  } finally {
    store.close();
  }
  try {
    assert.deepEqual(restartCheck(databasePath, 1), {
      valid: true,
      expectedEventCount: 1,
      observedEventCount: 1,
      error: null,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

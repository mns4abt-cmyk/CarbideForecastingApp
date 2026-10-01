"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore } = require("../lib/newsEventStore");
const { backfillEventOutcomes, loadNormalizedWeeklySeries } = require("../lib/eventOutcomeBackfill");
const { refreshPendingEventOutcomes } = require("../lib/eventOutcomePendingRefresh");

const EVENT_DATE = "2026-09-04T12:00:00.000Z";
const WEEKLY_SERIES = [
  { week: "2026-09-04", china_cny_kg: 100, eu_usd_mtu: 300 },
  { week: "2026-09-11", china_cny_kg: 105, eu_usd_mtu: 306 },
  { week: "2026-10-02", china_cny_kg: 90, eu_usd_mtu: 294 },
  { week: "2026-11-27", china_cny_kg: 100, eu_usd_mtu: 300 },
  { week: "2027-03-05", china_cny_kg: 110, eu_usd_mtu: 315 },
];

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "event-outcome-backfill-"));
  return { directory, databasePath: path.join(directory, "news-events.db") };
}

function addStoredEvent(databasePath, eventId = "event-1") {
  const store = new NewsEventStore({ databasePath, now: () => "2026-09-05T12:00:00.000Z" });
  try {
    store.upsert({
      eventId,
      representativeArticleId: `article-${eventId}`,
      headline: "Global tungsten export controls take effect",
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
      euRelevance: 1,
      horizonWeeks: 26,
      duplicateCount: 1,
    }, {
      id: `article-${eventId}`,
      date: EVENT_DATE,
      title: "Global tungsten export controls take effect",
      source: "Source A",
      sourceId: "source-a",
    });
  } finally {
    store.close();
  }
}

test("backfill persists China and EU outcomes and is idempotent on rerun", async () => {
  const { directory, databasePath } = createDatabase();
  addStoredEvent(databasePath);
  try {
    const options = {
      databasePath,
      referenceDate: "2027-03-31",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { warn() {} },
    };
    const first = await backfillEventOutcomes(options);
    assert.deepEqual(first, {
      referenceDate: "2027-03-31",
      eventsProcessed: 1,
      marketAssociationsCreated: 2,
      completedOutcomes: 8,
      pendingOutcomes: 0,
      unavailableOutcomes: 0,
      errors: [],
    });
    const second = await backfillEventOutcomes(options);
    assert.deepEqual(second, {
      ...first,
      marketAssociationsCreated: 0,
    });
    const store = new NewsEventStore({ databasePath });
    try {
      assert.equal(store.getAllEvents().length, 1);
      assert.equal(store.getPriceOutcomes({ eventId: "event-1" }).length, 8);
      assert.equal(store.getPriceOutcomes({ eventId: "event-1", market: "china" })[0].returnPct, 5.000000000000004);
      assert.equal(store.getPriceOutcomes({ eventId: "event-1", market: "eu" })[0].unit, "USD/mtu WO3");
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("backfill updates pending outcomes once the reference date reaches their horizons", async () => {
  const { directory, databasePath } = createDatabase();
  addStoredEvent(databasePath);
  try {
    const initial = await backfillEventOutcomes({
      databasePath,
      referenceDate: "2026-09-10",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { warn() {} },
    });
    assert.equal(initial.pendingOutcomes, 8);
    assert.equal(initial.completedOutcomes, 0);

    const completed = await backfillEventOutcomes({
      databasePath,
      referenceDate: "2027-03-31",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { warn() {} },
    });
    assert.equal(completed.marketAssociationsCreated, 0);
    assert.equal(completed.completedOutcomes, 8);
    assert.equal(completed.pendingOutcomes, 0);
    const store = new NewsEventStore({ databasePath });
    try {
      const rows = store.getPriceOutcomes({ eventId: "event-1" });
      assert.equal(rows.length, 8);
      assert.ok(rows.every((row) => row.status === "available"));
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pending-only refresh completes eligible rows without recalculating completed rows", async () => {
  const { directory, databasePath } = createDatabase();
  addStoredEvent(databasePath);
  try {
    await backfillEventOutcomes({
      databasePath,
      referenceDate: "2026-09-10",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { warn() {} },
    });
    const logs = [];
    const refreshed = await refreshPendingEventOutcomes({
      databasePath,
      referenceDate: "2027-03-31",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { info: (message) => logs.push(message), warn() {} },
    });
    assert.deepEqual(refreshed, {
      referenceDate: "2027-03-31",
      pendingChecked: 8,
      newlyCompleted: 8,
      stillPending: 0,
      newlyUnavailable: 0,
      errors: [],
    });
    assert.match(logs[0], /pending checked=8, newly completed=8, still pending=0/);

    let weeklyLoads = 0;
    const rerun = await refreshPendingEventOutcomes({
      databasePath,
      referenceDate: "2027-03-31",
      loadWeeklySeries: async () => { weeklyLoads += 1; return WEEKLY_SERIES; },
      logger: { info() {}, warn() {} },
    });
    assert.equal(weeklyLoads, 0);
    assert.deepEqual(rerun, {
      referenceDate: "2027-03-31",
      pendingChecked: 0,
      newlyCompleted: 0,
      stillPending: 0,
      newlyUnavailable: 0,
      errors: [],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pending-only refresh leaves previously completed horizons untouched", async () => {
  const { directory, databasePath } = createDatabase();
  addStoredEvent(databasePath);
  try {
    await backfillEventOutcomes({
      databasePath,
      referenceDate: "2026-09-12",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { warn() {} },
    });
    const beforeStore = new NewsEventStore({ databasePath });
    const completedBefore = beforeStore.getPriceOutcomes({ eventId: "event-1", market: "china" }).find((row) => row.horizonWeeks === 1);
    beforeStore.close();

    const refreshed = await refreshPendingEventOutcomes({
      databasePath,
      referenceDate: "2026-10-15",
      loadWeeklySeries: async () => WEEKLY_SERIES,
      logger: { info() {}, warn() {} },
    });
    assert.equal(refreshed.pendingChecked, 6);
    assert.equal(refreshed.newlyCompleted, 2);
    assert.equal(refreshed.stillPending, 4);

    const afterStore = new NewsEventStore({ databasePath });
    try {
      const china = afterStore.getPriceOutcomes({ eventId: "event-1", market: "china" });
      const completedAfter = china.find((row) => row.horizonWeeks === 1);
      assert.equal(completedAfter.status, "available");
      assert.equal(completedAfter.updatedAt, completedBefore.updatedAt);
      assert.equal(china.find((row) => row.horizonWeeks === 4).status, "available");
    } finally {
      afterStore.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pending-only refresh remains graceful when weekly price loading fails", async () => {
  const warnings = [];
  const result = await refreshPendingEventOutcomes({
    referenceDate: "2026-10-02",
    createStore: () => ({
      getPendingPriceOutcomes: () => [{ eventId: "event-1", market: "china", eventDate: EVENT_DATE, horizonWeeks: 1 }],
      close() {},
    }),
    loadWeeklySeries: async () => { throw new Error("price export unavailable"); },
    logger: { info() {}, warn: (...args) => warnings.push(args.join(" ")) },
  });
  assert.deepEqual(result, {
    referenceDate: "2026-10-02",
    pendingChecked: 1,
    newlyCompleted: 0,
    stillPending: 1,
    newlyUnavailable: 0,
    errors: [{ eventId: null, market: null, message: "Loading weekly prices failed: price export unavailable" }],
  });
  assert.match(warnings[0], /price export unavailable/);
});

test("backfill isolates a per-market persistence error and reports it", async () => {
  const errors = [];
  const result = await backfillEventOutcomes({
    createStore: () => ({
      getAllEvents: () => [{ eventId: "event-1", publishedAt: EVENT_DATE, chinaRelevance: 1, euRelevance: 0, globalRelevance: 0 }],
      upsertPriceOutcomes: () => { throw new Error("database is locked"); },
      close() {},
    }),
    referenceDate: "2027-03-31",
    loadWeeklySeries: async () => WEEKLY_SERIES,
    logger: { warn: (...args) => errors.push(args.join(" ")) },
  });
  assert.equal(result.eventsProcessed, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /database is locked/);
  assert.match(errors[0], /Association failed/);
});

test("weekly export falls through from a version-valid Python without dependencies", async () => {
  const preferred = { command: "broken-python", argsPrefix: [], display: "broken" };
  const fallback = { command: "working-python", argsPrefix: [], display: "working" };
  const calls = [];
  const rows = await loadNormalizedWeeklySeries({
    resolveInterpreter: async () => preferred,
    candidateProvider: () => [preferred, fallback],
    execFileImpl: async (command) => {
      calls.push(command);
      if (command === "broken-python") throw new Error("ModuleNotFoundError: No module named 'pandas'");
      return { stdout: JSON.stringify(WEEKLY_SERIES) };
    },
  });
  assert.deepEqual(calls, ["broken-python", "working-python"]);
  assert.deepEqual(rows, WEEKLY_SERIES);
});

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore } = require("../lib/newsEventStore");
const { persistEventPriceOutcomes } = require("../lib/newsEventPriceOutcomePersistence");

function createStore(now = () => "2026-09-30T12:00:00.000Z") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-event-price-outcomes-"));
  return {
    directory,
    databasePath: path.join(directory, "news-events.db"),
    store: new NewsEventStore({ databasePath: path.join(directory, "news-events.db"), now }),
  };
}

function association(market = "china", overrides = {}) {
  return {
    market,
    eventDate: "2026-09-04",
    matchedPriceDate: "2026-09-04",
    priceAtEvent: market === "china" ? 100 : 300,
    unit: market === "china" ? "CNY/kg APT" : "USD/mtu WO3",
    outcomes: [1, 4, 12, 26].map((horizonWeeks) => ({
      horizonWeeks,
      targetDate: new Date(Date.UTC(2026, 8, 4 + horizonWeeks * 7)).toISOString().slice(0, 10),
      matchedPriceDate: null,
      futurePrice: null,
      returnPct: null,
      status: "pending",
      ...overrides[horizonWeeks],
    })),
  };
}

test("inserts one separate durable row per event, market, and horizon", () => {
  const { directory, store } = createStore();
  try {
    assert.deepEqual(store.upsertPriceOutcomes("event-1", association()), {
      inserted: 4, updated: 0, totalOutcomes: 4,
    });
    const rows = store.getPriceOutcomes({ eventId: "event-1", market: "china" });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], {
      eventId: "event-1", market: "china", eventDate: "2026-09-04",
      priceAtEventDate: "2026-09-04", priceAtEvent: 100, unit: "CNY/kg APT",
      horizonWeeks: 1, targetDate: "2026-09-11", matchedFuturePriceDate: null,
      futurePrice: null, returnPct: null, status: "pending",
      calculatedAt: "2026-09-30T12:00:00.000Z", updatedAt: "2026-09-30T12:00:00.000Z",
    });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("upsert updates a pending outcome to completed without creating a duplicate row", () => {
  let timestamp = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => timestamp);
  try {
    store.upsertPriceOutcomes("event-1", association());
    timestamp = "2026-10-10T12:00:00.000Z";
    const completed = association("china", {
      1: {
        matchedPriceDate: "2026-09-11",
        futurePrice: 105,
        returnPct: 5,
        status: "available",
      },
    });
    assert.deepEqual(store.upsertPriceOutcomes("event-1", completed), {
      inserted: 0, updated: 4, totalOutcomes: 4,
    });
    const oneWeek = store.getPriceOutcomes({ eventId: "event-1", market: "china" })[0];
    assert.equal(oneWeek.status, "available");
    assert.equal(oneWeek.futurePrice, 105);
    assert.equal(oneWeek.returnPct, 5);
    assert.equal(oneWeek.updatedAt, "2026-10-10T12:00:00.000Z");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM news_event_price_outcomes").get().count, 4);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("same event remains separate across China and EU price outcomes", () => {
  const { directory, store } = createStore();
  try {
    store.upsertPriceOutcomes("event-shared", association("china"));
    store.upsertPriceOutcomes("event-shared", association("eu"));
    assert.equal(store.getPriceOutcomes({ eventId: "event-shared" }).length, 8);
    const eu = store.getPriceOutcomes({ eventId: "event-shared", market: "eu" });
    assert.equal(eu.length, 4);
    assert.equal(eu[0].priceAtEvent, 300);
    assert.equal(eu[0].unit, "USD/mtu WO3");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("outcome persistence failure is isolated from the caller", () => {
  const warnings = [];
  const result = persistEventPriceOutcomes("event-1", association(), {
    createStore: () => { throw new Error("database is locked"); },
    logger: { info() {}, warn: (...args) => warnings.push(args.join(" ")) },
  });
  assert.deepEqual(result, { ok: false, inserted: 0, updated: 0, totalOutcomes: null });
  assert.match(warnings[0], /Persistence failed; continuing refresh: database is locked/);
});

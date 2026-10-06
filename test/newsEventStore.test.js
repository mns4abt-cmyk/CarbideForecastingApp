"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore, stableEventId } = require("../lib/newsEventStore");
const { persistValidatedEvents } = require("../lib/newsEventPersistence");
const { deduplicateEvents } = require("../lib/newsEventDedup");
const { buildEventEvidence } = require("../lib/newsEventEvidence");

function representative(overrides = {}) {
  return {
    id: "article-1",
    date: "2026-09-01T10:00:00.000Z",
    title: "China export controls on tungsten take effect",
    source: "Source A",
    sourceId: "source-a",
    duplicateTitles: ["China export controls on tungsten take effect"],
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    eventId: "event-1",
    representativeArticleId: "article-1",
    headline: "China export controls on tungsten take effect",
    category: "regulation",
    direction: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    eventStage: "actual",
    evidenceMaturity: "realized",
    severity: 0.8,
    confidence: 0.9,
    globalRelevance: 0.7,
    chinaRelevance: 1,
    euRelevance: 0.6,
    horizonWeeks: 26,
    duplicateCount: 2,
    duplicateSources: ["Source A", "Source B"],
    evidenceSource: "news",
    ...overrides,
  };
}

function createStore(now) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-event-store-"));
  return { directory, store: new NewsEventStore({ databasePath: path.join(directory, "news-events.db"), now }) };
}

function storeEvent(store, {
  eventId,
  date,
  title,
  direction = "neutral",
  globalRelevance = 0,
  chinaRelevance = 0,
  euRelevance = 0,
} = {}) {
  store.upsert(
    evidence({ eventId, headline: title, direction, globalRelevance, chinaRelevance, euRelevance }),
    representative({ id: `article-${eventId}`, date, title })
  );
}

test("inserts validated deduplicated event-level data with provenance", () => {
  const { directory, store } = createStore(() => "2026-09-02T12:00:00.000Z");
  try {
    store.upsertMany([evidence()], [representative()]);
    const row = store.db.prepare("SELECT * FROM news_events").get();
    assert.equal(row.event_id, stableEventId(row.event_key));
    assert.equal(row.first_seen_at, "2026-09-02T12:00:00.000Z");
    assert.equal(row.published_at, "2026-09-01T10:00:00.000Z");
    assert.equal(row.duplicate_count, 2);
    assert.deepEqual(JSON.parse(row.provenance_json).duplicateSources, ["Source A", "Source B"]);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("upsert updates an existing event without changing first-seen or created timestamps", () => {
  const timestamps = ["2026-09-02T12:00:00.000Z", "2026-09-03T12:00:00.000Z"];
  const { directory, store } = createStore(() => timestamps.shift());
  try {
    store.upsert(evidence(), representative());
    store.upsert(evidence({ eventId: "event-99", severity: 0.6, duplicateCount: 3 }), representative({ id: "article-9" }));
    const rows = store.db.prepare("SELECT * FROM news_events").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, "event-99");
    assert.equal(rows[0].first_seen_at, "2026-09-02T12:00:00.000Z");
    assert.equal(rows[0].last_seen_at, "2026-09-03T12:00:00.000Z");
    assert.equal(rows[0].created_at, "2026-09-02T12:00:00.000Z");
    assert.equal(rows[0].updated_at, "2026-09-03T12:00:00.000Z");
    assert.equal(rows[0].severity, 0.6);
    assert.equal(rows[0].duplicate_count, 3);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refresh persistence inserts once, then updates and preserves cumulative duplicate provenance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-event-refresh-"));
  const databasePath = path.join(directory, "news-events.db");
  const messages = [];
  const logger = {
    info: (...args) => messages.push(args.join(" ")),
    warn: (...args) => messages.push(args.join(" ")),
  };
  const classifiedArticle = (overrides = {}) => ({
    ...representative(),
    classificationStatus: "classified",
    categoryKey: "regulation",
    sentiment: "bullish",
    supplyEffect: "decrease",
    demandEffect: "none",
    eventStage: "actual",
    evidenceMaturity: "realized",
    severity: 0.8,
    confidence: 0.9,
    globalRelevance: 0.7,
    chinaRelevance: 1,
    euRelevance: 0.6,
    horizonWeeks: 26,
    ...overrides,
  });
  try {
    const first = deduplicateEvents([
      classifiedArticle(),
      classifiedArticle({ id: "article-2", source: "Source B", sourceId: "source-b" }),
    ]);
    const firstResult = persistValidatedEvents(buildEventEvidence(first.representatives), first.representatives, { databasePath, logger });
    assert.deepEqual(firstResult, { ok: true, eventsWritten: 1, eventsUpdated: 0, storedEventCount: 1 });

    const second = deduplicateEvents([
      classifiedArticle({ id: "article-3", source: "Source C", sourceId: "source-c" }),
    ]);
    const secondResult = persistValidatedEvents(buildEventEvidence(second.representatives), second.representatives, { databasePath, logger });
    assert.deepEqual(secondResult, { ok: true, eventsWritten: 0, eventsUpdated: 1, storedEventCount: 1 });

    const store = new NewsEventStore({ databasePath });
    try {
      const row = store.db.prepare("SELECT duplicate_count, provenance_json FROM news_events").get();
      const provenance = JSON.parse(row.provenance_json);
      assert.equal(row.duplicate_count, 2);
      assert.deepEqual(provenance.duplicateSources, ["Source A", "Source B", "Source C"]);
      assert.deepEqual(provenance.sourceIds, ["source-a", "source-c"]);
    } finally {
      store.close();
    }
    assert.ok(messages.some((message) => message.includes("eventsWritten")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("database failure logs a warning and leaves the refresh caller operational", () => {
  const warnings = [];
  const result = persistValidatedEvents([evidence()], [representative()], {
    createStore: () => { throw new Error("database is locked"); },
    logger: { info() {}, warn: (...args) => warnings.push(args.join(" ")) },
  });
  assert.deepEqual(result, { ok: false, eventsWritten: 0, eventsUpdated: 0, storedEventCount: null });
  assert.match(warnings[0], /Persistence failed; continuing refresh: database is locked/);
});

test("events persist after reopening the SQLite database and diagnostics summarize them", () => {
  const { directory, store } = createStore(() => "2026-09-10T12:00:00.000Z");
  const databasePath = path.join(directory, "news-events.db");
  try {
    store.upsert(evidence(), representative());
  } finally {
    store.close();
  }
  const reopened = new NewsEventStore({ databasePath, now: () => "2026-09-10T12:00:00.000Z" });
  try {
    assert.deepEqual(reopened.diagnostics(), {
      totalEvents: 1,
      oldestEvent: { eventId: "event-1", title: "China export controls on tungsten take effect", publishedAt: "2026-09-01T10:00:00.000Z" },
      newestEvent: { eventId: "event-1", title: "China export controls on tungsten take effect", publishedAt: "2026-09-01T10:00:00.000Z" },
      eventsLast30Days: 1,
      recentDirectionCountsByMarket: {
        all: { bullish: 1, bearish: 0, neutral: 0 },
        global: { bullish: 1, bearish: 0, neutral: 0 },
        china: { bullish: 1, bearish: 0, neutral: 0 },
        eu: { bullish: 1, bearish: 0, neutral: 0 },
      },
    });
  } finally {
    reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getRecentEvents returns event-level metadata inside the default 30-day window", () => {
  const referenceTime = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => referenceTime);
  try {
    storeEvent(store, {
      eventId: "inside-window",
      date: "2026-09-15T10:00:00.000Z",
      title: "China tungsten export controls take effect",
      direction: "bullish",
      globalRelevance: 0.7,
      chinaRelevance: 1,
    });
    const [event] = store.getRecentEvents({ referenceTime });
    assert.equal(event.eventId, "inside-window");
    assert.equal(event.publishedAt, "2026-09-15T10:00:00.000Z");
    assert.equal(event.supplyEffect, "decrease");
    assert.equal(event.confidence, 0.9);
    assert.equal(event.provenance.source, "Source A");
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getRecentEvents includes the exact cutoff and excludes events before it", () => {
  const referenceTime = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => referenceTime);
  try {
    storeEvent(store, {
      eventId: "at-boundary",
      date: "2026-08-31T12:00:00.000Z",
      title: "Plymouth mine restarts tungsten production",
    });
    storeEvent(store, {
      eventId: "outside-window",
      date: "2026-08-31T11:59:59.999Z",
      title: "Wolfram mine closure reduces production",
    });
    assert.deepEqual(
      store.getRecentEvents({ days: 30, referenceTime }).map((event) => event.eventId),
      ["at-boundary"]
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getRecentEvents falls back to firstSeenAt only when publishedAt is unavailable", () => {
  const referenceTime = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => referenceTime);
  try {
    storeEvent(store, {
      eventId: "first-seen-fallback",
      date: null,
      title: "Undated tungsten production update",
    });
    const [event] = store.getRecentEvents({ referenceTime });
    assert.equal(event.eventId, "first-seen-fallback");
    assert.equal(event.publishedAt, null);
    assert.equal(event.firstSeenAt, referenceTime);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getRecentEvents filters deterministic global, China, and EU relevance", () => {
  const referenceTime = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => referenceTime);
  try {
    storeEvent(store, {
      eventId: "china-event", date: "2026-09-20T10:00:00.000Z",
      title: "China tungsten export controls take effect", direction: "bullish", chinaRelevance: 1,
    });
    storeEvent(store, {
      eventId: "eu-event", date: "2026-09-19T10:00:00.000Z",
      title: "Plymouth mine restarts tungsten production", direction: "bearish", euRelevance: 1,
    });
    storeEvent(store, {
      eventId: "global-event", date: "2026-09-18T10:00:00.000Z",
      title: "Wolfram tariff regulation announced", direction: "neutral", globalRelevance: 1,
    });
    assert.deepEqual(store.getRecentEvents({ market: "china", referenceTime }).map((event) => event.eventId), ["china-event"]);
    assert.deepEqual(store.getRecentEvents({ market: "eu", referenceTime }).map((event) => event.eventId), ["eu-event"]);
    assert.deepEqual(store.getRecentEvents({ market: "global", referenceTime }).map((event) => event.eventId), ["global-event"]);
    assert.equal(store.getRecentEvents({ market: "all", referenceTime }).length, 3);
    assert.deepEqual(store.diagnostics(referenceTime).recentDirectionCountsByMarket, {
      all: { bullish: 1, bearish: 1, neutral: 1 },
      global: { bullish: 0, bearish: 0, neutral: 1 },
      china: { bullish: 1, bearish: 0, neutral: 0 },
      eu: { bullish: 0, bearish: 1, neutral: 0 },
    });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getRecentEvents sorts newest first with stable event-key tie breaking", () => {
  const referenceTime = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => referenceTime);
  try {
    storeEvent(store, { eventId: "older-a", date: "2026-09-20T10:00:00.000Z", title: "Alpha tungsten development update" });
    storeEvent(store, { eventId: "older-b", date: "2026-09-20T10:00:00.000Z", title: "Beta tungsten development update" });
    storeEvent(store, { eventId: "newest", date: "2026-09-21T10:00:00.000Z", title: "Gamma tungsten development update" });
    const first = store.getRecentEvents({ referenceTime });
    const second = store.getRecentEvents({ referenceTime });
    assert.equal(first[0].eventId, "newest");
    assert.ok(first[1].eventKey < first[2].eventKey);
    assert.deepEqual(first, second);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("getRecentSentiment aggregates only the stored 30-day event window", () => {
  const referenceTime = "2026-09-30T12:00:00.000Z";
  const { directory, store } = createStore(() => referenceTime);
  try {
    storeEvent(store, {
      eventId: "recent-bull", date: "2026-09-20T12:00:00.000Z",
      title: "China tungsten export controls take effect", direction: "bullish", chinaRelevance: 1,
    });
    storeEvent(store, {
      eventId: "expired-bear", date: "2026-08-30T12:00:00.000Z",
      title: "Plymouth mine restarts tungsten production", direction: "bearish", euRelevance: 1,
    });
    const result = store.getRecentSentiment({ market: "china", referenceTime });
    assert.equal(result.sentimentScore, 100);
    assert.equal(result.totalEventCount, 1);
    assert.equal(result.windowDays, 30);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("different deduplicated events retain separate rows", () => {
  const { directory, store } = createStore(() => "2026-09-10T12:00:00.000Z");
  try {
    store.upsertMany([
      evidence(),
      evidence({ eventId: "event-2", headline: "Plymouth mine restarts production", eventStage: "announced", duplicateCount: 1 }),
    ], [
      representative(),
      representative({ id: "article-2", date: "2026-09-05T10:00:00.000Z", title: "Plymouth mine restarts production" }),
    ]);
    assert.equal(store.diagnostics().totalEvents, 2);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("server persists only deduplicated validated event evidence", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /const eventEvidence = buildEventEvidence\(eventDeduplication\.representatives\);/);
  assert.match(serverSource, /persistValidatedEvents\(eventEvidence, eventDeduplication\.representatives, \{/);
});

test("repairs legacy IDs to canonical-key IDs while preserving tags and outcomes", () => {
  const { directory, store } = createStore(() => "2026-09-10T12:00:00.000Z");
  try {
    store.upsert(evidence({ eventId: "legacy-a", headline: "Alpha tungsten production" }), representative({ eventKey: "a".repeat(64), title: "Alpha tungsten production" }));
    store.upsert(evidence({ eventId: "legacy-b", headline: "Beta tungsten production" }), representative({ eventKey: "b".repeat(64), title: "Beta tungsten production" }));
    store.upsertStrategicTags("a".repeat(64), { entities: ["almonty"], topics: ["production"] }, "strategic-v1");
    store.upsertPriceOutcomes("legacy-a", { market: "china", eventDate: "2026-09-04", matchedPriceDate: "2026-09-04", priceAtEvent: 100, unit: "CNY/kg APT", outcomes: [{ horizonWeeks: 1, targetDate: "2026-09-11", status: "pending" }] });

    assert.deepEqual(store.repairEventIdsToCanonicalKeys(), {
      totalEvents: 2, updatedEvents: 2, updatedTags: 1, updatedOutcomes: 1, duplicateEventIds: [],
    });
    assert.equal(store.getAllEvents().find((event) => event.eventKey === "a".repeat(64)).eventId, stableEventId("a".repeat(64)));
    assert.equal(store.getStrategicTags({ eventKey: "a".repeat(64) })[0].eventId, stableEventId("a".repeat(64)));
    assert.equal(store.getPriceOutcomes({ eventId: stableEventId("a".repeat(64)) }).length, 1);
    assert.deepEqual(store.repairEventIdsToCanonicalKeys(), {
      totalEvents: 2, updatedEvents: 0, updatedTags: 0, updatedOutcomes: 0, duplicateEventIds: [],
    });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to rewrite ambiguous price outcomes from colliding legacy IDs", () => {
  const { directory, store } = createStore(() => "2026-09-10T12:00:00.000Z");
  try {
    store.upsert(evidence({ eventId: "legacy-duplicate", headline: "Alpha tungsten production" }), representative({ eventKey: "a".repeat(64), title: "Alpha tungsten production" }));
    store.upsert(evidence({ eventId: "legacy-duplicate", headline: "Beta tungsten production" }), representative({ eventKey: "b".repeat(64), title: "Beta tungsten production" }));
    store.upsertPriceOutcomes("legacy-duplicate", { market: "china", eventDate: "2026-09-04", matchedPriceDate: "2026-09-04", priceAtEvent: 100, unit: "CNY/kg APT", outcomes: [{ horizonWeeks: 1, targetDate: "2026-09-11", status: "pending" }] });
    assert.throws(() => store.repairEventIdsToCanonicalKeys(), /outcomes attached to colliding legacy IDs/);
    assert.equal(store.getAllEvents().filter((event) => event.eventId === "legacy-duplicate").length, 2);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

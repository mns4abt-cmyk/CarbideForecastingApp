"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsClassificationCache } = require("../lib/newsClassificationCache");
const { NewsEventStore, stableEventId } = require("../lib/newsEventStore");
const { runHistoricalNewsBackfill, selectAllInRefreshWindows } = require("../lib/newsHistoricalBackfill");

function article(id, publishedAt = "2026-09-20T10:00:00.000Z", title = `China tungsten export controls ${id}`) {
  return {
    id, title, publishedAt, source: "Source A", sourceId: "google-news", url: `https://example.test/${id}`,
    snippet: "The export control takes effect and reduces tungsten supply.",
    relevance: { score: 1, reasons: [], matchedTerms: ["tungsten"], matchedThemes: ["trade_china"] },
  };
}

function classification(id) {
  return {
    id, category: "regulation", direction: "bullish", supplyEffect: "decrease", demandEffect: "none",
    eventStage: "actual", severity: 0.8, confidence: 0.9, globalRelevance: 0.6,
    chinaRelevance: 1, euRelevance: 0.3, horizonWeeks: 12, summary: "Validated", impactExplanation: "Supply decreases.",
  };
}

function fixture(articles) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-historical-backfill-"));
  return {
    directory,
    databasePath: path.join(directory, "news-events.db"),
    cache: new NewsClassificationCache({ directory: path.join(directory, "cache"), model: "qwen3:4b", schemaVersion: "causal-v3" }),
    options: {
      config: {}, dependencies: {}, referenceTime: "2026-09-24T12:00:00.000Z", maxPerRefresh: 1, batchSize: 1,
      fetchSources: async () => ({ articles, health: [{ id: "google-news", reachable: true }] }),
      relevanceFilter: (items) => ({ accepted: items, rejected: [] }),
      provider: { model: "qwen3:4b", health: async () => ({ available: true, provider: "ollama", model: "qwen3:4b" }) },
      logger: { info() {}, warn() {} },
    },
  };
}

test("partial completion persists successful validated units and continues after a single-item timeout", async () => {
  const setup = fixture([
    article("one", "2026-09-20T10:00:00.000Z", "China tungsten export controls take effect"),
    article("timeout", "2026-09-20T10:00:00.000Z", "New tungsten market update"),
    article("three", "2026-09-20T10:00:00.000Z", "Korean tungsten mine starts commercial production"),
  ]);
  const progress = [];
  try {
    const result = await runHistoricalNewsBackfill({
      ...setup.options, databasePath: setup.databasePath, classificationCache: setup.cache,
      onProgress: (entry) => progress.push(entry),
      classifyBatches: async (_provider, items) => {
        const [item] = items;
        if (item.id === "backfill-2") return {
          classifications: new Map(), failedBatches: [[item.id]],
          failedBatchDetails: [{ batchNumber: 1, articleCount: 1, error: { type: "timeout", code: "REQUEST_TIMEOUT" } }], batchCount: 1, successfulBatches: 0,
        };
        return { classifications: new Map([[item.id, classification(item.id)]]), failedBatches: [], failedBatchDetails: [], batchCount: 1, successfulBatches: 1 };
      },
    });
    assert.deepEqual({ classified: result.classified, persisted: result.persisted, failures: result.failures }, { classified: 2, persisted: 2, failures: 1 });
    assert.equal(result.failureDetails[0].error.code, "REQUEST_TIMEOUT");
    assert.equal(progress.length, 3);
    assert.equal(progress[1].status, "classification_failed");
    assert.equal(progress[2].status, "classified_persisted");
    const store = new NewsEventStore({ databasePath: setup.databasePath });
    try { assert.equal(store.getAllEvents().length, 2); } finally { store.close(); }
  } finally { fs.rmSync(setup.directory, { recursive: true, force: true }); }
});

test("restart skips the durable article fingerprint and never creates a duplicate event", async () => {
  const setup = fixture([article("one")]);
  let calls = 0;
  const classifyBatches = async (_provider, items) => {
    calls += 1;
    return { classifications: new Map([[items[0].id, classification(items[0].id)]]), failedBatches: [], failedBatchDetails: [], batchCount: 1, successfulBatches: 1 };
  };
  try {
    const first = await runHistoricalNewsBackfill({ ...setup.options, databasePath: setup.databasePath, classificationCache: setup.cache, classifyBatches });
    const second = await runHistoricalNewsBackfill({ ...setup.options, databasePath: setup.databasePath, classificationCache: setup.cache, classifyBatches });
    assert.equal(first.persisted, 1);
    assert.equal(second.skippedPersisted, 1);
    assert.equal(second.persisted, 0);
    assert.equal(calls, 1);
    const store = new NewsEventStore({ databasePath: setup.databasePath });
    try {
      assert.equal(store.getAllEvents().length, 1);
      const provenance = store.getAllEvents()[0].provenance;
      assert.deepEqual(provenance.articleFingerprints.length, 1);
      assert.equal(provenance.classifierModel, "qwen3:4b");
      assert.equal(provenance.classifierVersion, "causal-v3");
    } finally { store.close(); }
  } finally { fs.rmSync(setup.directory, { recursive: true, force: true }); }
});

test("a cached successful classification is validated and persisted without another Ollama request", async () => {
  const setup = fixture([article("one")]);
  let calls = 0;
  try {
    const failedPersistence = await runHistoricalNewsBackfill({
      ...setup.options, databasePath: setup.databasePath, classificationCache: setup.cache,
      classifyBatches: async (_provider, items) => {
        calls += 1;
        return { classifications: new Map([[items[0].id, classification(items[0].id)]]), failedBatches: [], failedBatchDetails: [], batchCount: 1, successfulBatches: 1 };
      },
      persist: () => ({ ok: false, eventsWritten: 0, eventsUpdated: 0, storedEventCount: null }),
    });
    const resumed = await runHistoricalNewsBackfill({
      ...setup.options, databasePath: setup.databasePath, classificationCache: setup.cache,
      classifyBatches: async () => { calls += 1; throw new Error("cache should have been used"); },
    });
    assert.equal(failedPersistence.failures, 1);
    assert.equal(resumed.cached, 1);
    assert.equal(resumed.persisted, 1);
    assert.equal(calls, 1);
  } finally { fs.rmSync(setup.directory, { recursive: true, force: true }); }
});

test("a fresh syndicated article updates its durable match without duplicating the canonical event id", async () => {
  const original = article("original", "2026-09-20T10:00:00.000Z", "China tungsten export controls take effect");
  const setup = fixture([{ ...original, id: "syndicated", snippet: "Same confirmed restriction reported by a second source." }]);
  const store = new NewsEventStore({ databasePath: setup.databasePath });
  try {
    store.upsert({
      eventId: "event-legacy", representativeArticleId: "original", headline: original.title,
      category: "regulation", direction: "bullish", supplyEffect: "decrease", demandEffect: "none",
      eventStage: "actual", evidenceMaturity: "realized", severity: 0.8, confidence: 0.9,
      globalRelevance: 0.6, chinaRelevance: 1, euRelevance: 0.3, horizonWeeks: 12, duplicateCount: 1, duplicateSources: ["Source A"],
    }, { ...original, date: "2026-09-20" });
  } finally { store.close(); }
  try {
    const result = await runHistoricalNewsBackfill({
      ...setup.options, databasePath: setup.databasePath, classificationCache: setup.cache,
      classifyBatches: async (_provider, items) => ({ classifications: new Map([[items[0].id, classification(items[0].id)]]), failedBatches: [], failedBatchDetails: [], batchCount: 1, successfulBatches: 1 }),
    });
    assert.equal(result.persisted, 1);
    const reopened = new NewsEventStore({ databasePath: setup.databasePath });
    try {
      assert.equal(reopened.getAllEvents().length, 1);
      assert.deepEqual(reopened.getDuplicateEventIds(), []);
      const [event] = reopened.getAllEvents();
      assert.equal(event.eventId, stableEventId(event.eventKey));
    } finally { reopened.close(); }
  } finally { fs.rmSync(setup.directory, { recursive: true, force: true }); }
});

test("backfill consumes all articles through the existing capped selection ordering", () => {
  const selected = selectAllInRefreshWindows([
    { id: "low", relevanceScore: 0.5, date: "2026-09-24" },
    { id: "high-old", relevanceScore: 1, date: "2026-09-20" },
    { id: "high-new", relevanceScore: 1, date: "2026-09-22" },
  ], 2);
  assert.deepEqual(selected.map((item) => item.id), ["high-new", "high-old", "low"]);
});

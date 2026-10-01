"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { NewsEventStore } = require("../lib/newsEventStore");
const { NEWS_LAGE_V2_METHOD, loadNewsLageV2 } = require("../lib/newsLageV2");

const REFERENCE_TIME = "2026-09-30T12:00:00.000Z";

function storedBullishEvent() {
  return {
    eventId: "stored-bullish",
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
  };
}

test("News-Lage v2 API shape is sourced from the persisted 30-day event history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-lage-v2-"));
  const databasePath = path.join(directory, "news-events.db");
  const store = new NewsEventStore({ databasePath, now: () => REFERENCE_TIME });
  try {
    store.upsert(storedBullishEvent(), {
      id: "article-1",
      date: "2026-09-25T12:00:00.000Z",
      title: "China tungsten export controls take effect",
      source: "Source A",
      sourceId: "source-a",
    });
    store.upsert({
      ...storedBullishEvent(),
      eventId: "stored-bearish",
      representativeArticleId: "article-2",
      headline: "Plymouth mine restarts tungsten production",
      direction: "bearish",
      supplyEffect: "increase",
      severity: 0.2,
      duplicateCount: 1,
      duplicateSources: ["Source C"],
    }, {
      id: "article-2",
      date: "2026-09-28T12:00:00.000Z",
      title: "Plymouth mine restarts tungsten production",
      source: "Source C",
      sourceId: "source-c",
    });
    store.upsertPriceOutcomes("stored-bullish", {
      market: "china",
      eventDate: "2026-09-25",
      matchedPriceDate: "2026-09-25",
      priceAtEvent: 100,
      unit: "CNY/kg APT",
      outcomes: [{
        horizonWeeks: 1,
        targetDate: "2026-10-02",
        matchedPriceDate: "2026-10-02",
        futurePrice: 105,
        returnPct: 5,
        status: "available",
      }],
    });
  } finally {
    store.close();
  }
  try {
    const result = loadNewsLageV2({ databasePath, referenceTime: REFERENCE_TIME, logger: { warn() {} } });
    assert.equal(result.available, true);
    assert.equal(result.methodology.method, NEWS_LAGE_V2_METHOD);
    assert.equal(result.methodology.numericalForecastAdjustmentApplied, false);
    assert.ok(result.china.sentimentScore > 20 && result.china.sentimentScore < 60);
    assert.equal(result.china.qualitativeLabel, "bullish");
    assert.equal(result.china.windowDays, 30);
    assert.equal(result.china.totalEventCount, 2);
    assert.ok(Math.abs(result.china.bullishWeight - (0.8 * 0.9 * Math.pow(0.5, 0.5))) < 1e-12);
    assert.equal(result.china.lastUpdatedAt, REFERENCE_TIME);
    assert.equal(result.eu.totalEventCount, 0);
    assert.equal(result.events.china.length, 2);
    assert.equal(result.events.china[0].eventId, "stored-bullish");
    assert.deepEqual(result.events.china[0].sources, ["Source A", "Source B"]);
    assert.equal(result.events.china[0].sourceCount, 2);
    assert.deepEqual(result.events.china[0].priceOutcomes, [{
      eventId: "stored-bullish",
      market: "china",
      eventDate: "2026-09-25",
      priceAtEventDate: "2026-09-25",
      priceAtEvent: 100,
      unit: "CNY/kg APT",
      horizonWeeks: 1,
      targetDate: "2026-10-02",
      matchedFuturePriceDate: "2026-10-02",
      futurePrice: 105,
      returnPct: 5,
      status: "available",
      calculatedAt: REFERENCE_TIME,
      updatedAt: REFERENCE_TIME,
    }]);
    assert.deepEqual(Object.keys(result.events.china[0]).sort(), [
      "category", "chinaRelevance", "confidence", "direction", "duplicateCount", "effectiveMarketRelevance",
      "euRelevance", "eventId", "eventStage", "evidenceMaturity", "finalWeight", "firstSeenAt", "globalRelevance",
      "priceOutcomes", "publishedAt", "severity", "sourceCount", "sources", "title",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("News-Lage v2 database failures are unavailable but non-throwing", () => {
  const warnings = [];
  const result = loadNewsLageV2({
    referenceTime: REFERENCE_TIME,
    createStore: () => { throw new Error("database is locked"); },
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
  });
  assert.equal(result.available, false);
  assert.equal(result.china.sentimentScore, null);
  assert.equal(result.eu.qualitativeLabel, "unavailable");
  assert.equal(result.methodology.numericalForecastAdjustmentApplied, false);
  assert.match(warnings[0], /Stored event history unavailable: database is locked/);
});

test("refresh wires News-Lage v2 after persistence without feeding Fusion or scenarios", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /const newsLage = loadNewsLageV2\(\{/);
  assert.match(source, /newsLage,/);
  assert.ok(source.indexOf("persistValidatedEvents(eventEvidence") < source.indexOf("const newsLage = loadNewsLageV2"));
  const newsLageCall = source.match(/const newsLage = loadNewsLageV2\(\{[\s\S]*?\}\);/)?.[0] || "";
  assert.doesNotMatch(newsLageCall, /pipelineResult|scenarios|marketState|evidenceFusion/);
});

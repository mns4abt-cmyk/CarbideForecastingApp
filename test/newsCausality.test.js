"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { derivePriceDirection, normalizeCausalClassification, normalizeGlobalRelevance } = require("../lib/newsCausality");
const { deduplicateEvents, hasConflictingAssets } = require("../lib/newsEventDedup");
const { NewsClassificationCache } = require("../lib/newsClassificationCache");
const { buildEventEvidence } = require("../lib/newsEventEvidence");

test("clear supply and demand mechanisms deterministically derive price direction", () => {
  assert.equal(derivePriceDirection({ supplyEffect: "increase", demandEffect: "none", eventStage: "actual" }), "bearish");
  assert.equal(derivePriceDirection({ supplyEffect: "decrease", demandEffect: "none", eventStage: "actual" }), "bullish");
  assert.equal(derivePriceDirection({ supplyEffect: "none", demandEffect: "increase", eventStage: "actual" }), "bullish");
  assert.equal(derivePriceDirection({ supplyEffect: "none", demandEffect: "decrease", eventStage: "actual" }), "bearish");
  assert.equal(derivePriceDirection({ supplyEffect: "increase", demandEffect: "increase", eventStage: "actual" }), "neutral");
  assert.equal(derivePriceDirection({ supplyEffect: "unclear", demandEffect: "unclear", eventStage: "unclear" }), "neutral");
});

test("exploration and studies do not become immediate supply changes, while commercial startup can", () => {
  assert.equal(derivePriceDirection({ supplyEffect: "increase", demandEffect: "none", eventStage: "exploration" }), "neutral");
  assert.equal(derivePriceDirection({ supplyEffect: "increase", demandEffect: "none", eventStage: "study" }), "neutral");
  assert.equal(derivePriceDirection({ supplyEffect: "increase", demandEffect: "none", eventStage: "actual" }), "bearish");
});

test("conflicting raw LLM direction is deterministically corrected and planned events are conservative", () => {
  const result = normalizeCausalClassification({ direction: "bullish", supplyEffect: "increase", demandEffect: "none", eventStage: "planned" });
  assert.equal(result.direction, "bearish");
  assert.equal(result.causalConsistencyCorrected, true);
  assert.equal(result.severityCap, 0.5);
  assert.equal(result.confidenceCap, 0.7);
});

test("exploration evidence cannot be turned into current supply or inferred demand", () => {
  const result = normalizeCausalClassification(
    { direction: "bearish", supplyEffect: "increase", demandEffect: "increase", eventStage: "planned" },
    { title: "High-grade tungsten discovery reported from drilling intercepts", snippet: "New assays identify mineralisation at the exploration target." },
  );
  assert.deepEqual([result.eventStage, result.supplyEffect, result.demandEffect, result.direction], ["exploration", "none", "none", "neutral"]);
});

test("export controls reduce supply without inferring demand", () => {
  const result = normalizeCausalClassification(
    { direction: "bullish", supplyEffect: "unclear", demandEffect: "increase", eventStage: "actual" },
    { title: "China tightens tungsten export controls", snippet: "New export licences are required." },
  );
  assert.deepEqual([result.supplyEffect, result.demandEffect, result.direction], ["decrease", "none", "bullish"]);
});

test("bilingual production evidence corrects an impossible LLM supply decrease", () => {
  const result = normalizeCausalClassification(
    { direction: "bullish", supplyEffect: "decrease", demandEffect: "none", eventStage: "actual" },
    { title: "Sangdong-Produktion erreicht Produktionshochlauf", snippet: "Die Förderung steigt." },
  );
  assert.deepEqual([result.supplyEffect, result.direction, result.causalExtractionCorrected], ["increase", "bearish", true]);
});

test("German exploration, export restriction, and contract evidence are conservatively normalized", () => {
  const exploration = normalizeCausalClassification(
    { direction: "bearish", supplyEffect: "increase", demandEffect: "none", eventStage: "planned" },
    { title: "Aben Gold informiert über Bohrprogramm", snippet: "Explorationsprogramm für Wolfram." },
  );
  const restriction = normalizeCausalClassification(
    { direction: "neutral", supplyEffect: "none", demandEffect: "none", eventStage: "actual" },
    { title: "Neue Exportbeschränkung für Wolfram", snippet: "" },
  );
  const contract = normalizeCausalClassification(
    { direction: "bullish", supplyEffect: "none", demandEffect: "increase", eventStage: "announced" },
    { title: "Long-term tungsten offtake agreement signed", snippet: "Supply contract between the companies." },
  );
  assert.deepEqual([exploration.eventStage, exploration.supplyEffect], ["exploration", "none"]);
  assert.equal(restriction.supplyEffect, "decrease");
  assert.equal(contract.demandEffect, "none");
});

test("a tungsten contract alone does not imply demand growth", () => {
  const contract = normalizeCausalClassification(
    { direction: "bullish", supplyEffect: "none", demandEffect: "increase", eventStage: "announced" },
    { title: "Long-term tungsten contract signed", snippet: "The companies announced a supply agreement." },
  );
  assert.equal(contract.demandEffect, "none");
});

test("actual commercial production is a supply increase and deterministic explanation follows the derived direction", () => {
  const result = normalizeCausalClassification(
    { direction: "bullish", supplyEffect: "unclear", demandEffect: "none", eventStage: "planned", impactExplanation: "Unsupported bullish claim" },
    { title: "New tungsten mine begins commercial production after ramp-up", snippet: "" },
  );
  assert.deepEqual([result.eventStage, result.supplyEffect, result.direction], ["actual", "increase", "bearish"]);
  assert.match(result.impactExplanation, /Confirmed supply expansion increases tungsten availability/);
  assert.doesNotMatch(result.impactExplanation, /\d+%|\$|USD\/mtu|CNY\/kg/);
});

test("event stages deterministically map to evidence maturity and conservative severity caps", () => {
  const actual = normalizeCausalClassification({ eventStage: "actual", supplyEffect: "decrease", demandEffect: "none", direction: "bullish" });
  const future = normalizeCausalClassification({ eventStage: "announced", supplyEffect: "increase", demandEffect: "none", direction: "bearish" });
  const exploration = normalizeCausalClassification({ eventStage: "exploration", supplyEffect: "none", demandEffect: "none", direction: "neutral" });
  assert.deepEqual([actual.evidenceMaturity, actual.severityCap], ["realized", 1]);
  assert.deepEqual([future.evidenceMaturity, future.severityCap], ["prospective", 0.5]);
  assert.deepEqual([exploration.evidenceMaturity, exploration.severityCap], ["speculative", 0.2]);
});

test("an effective export restriction is realized and can retain high severity", () => {
  const causal = normalizeCausalClassification(
    { eventStage: "announced", supplyEffect: "decrease", demandEffect: "none", direction: "bullish" },
    { title: "China tungsten export controls take effect immediately", snippet: "Export licences are now required." },
  );
  assert.deepEqual([causal.eventStage, causal.evidenceMaturity, causal.severityCap], ["actual", "realized", 1]);
});

test("explicit global tungsten-market mechanism gets a conservative global relevance floor", () => {
  const causal = normalizeCausalClassification(
    { eventStage: "actual", supplyEffect: "decrease", demandEffect: "none", direction: "bullish" },
    { title: "Global tungsten market faces smelting capacity bottleneck", snippet: "" },
  );
  assert.deepEqual(
    normalizeGlobalRelevance(0.1, 0.8, causal, { title: "Global tungsten market faces smelting capacity bottleneck" }),
    { globalRelevance: 0.35, globalRelevanceCorrected: true },
  );
});

test("server exposes the deterministic explanation and retains the raw LLM explanation only for diagnostics", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /newsItem\.llmImpactExplanation = validated\.impactExplanation;/);
  assert.match(source, /newsItem\.impact = causal\.impactExplanation;/);
});

function article(id, title, source, date = "2026-09-03T10:00:00Z") {
  return { id, title, source, date, relevanceScore: 0.8 };
}

test("syndicated duplicate event keeps one representative and source provenance", () => {
  const result = deduplicateEvents([
    article("a", "Great Atlantic Resources Creates Wholly-Owned Subsidiary Atlantic Canada Tungsten Mining Corp. - TMX Newsfile", "TMX Newsfile"),
    article("b", "Great Atlantic Resources Creates Wholly-Owned Subsidiary Atlantic Canada Tungsten Mining Corp. - TradingView", "TradingView"),
  ]);
  assert.equal(result.representatives.length, 1);
  assert.equal(result.representatives[0].duplicateCount, 2);
  assert.deepEqual(new Set(result.representatives[0].duplicateSources), new Set(["TMX Newsfile", "TradingView"]));
});

test("different events for the same company are not automatically merged", () => {
  const result = deduplicateEvents([
    article("a", "Great Atlantic starts commercial tungsten mine production", "TMX Newsfile"),
    article("b", "Great Atlantic commissions feasibility study for tungsten refinery", "TradingView"),
  ]);
  assert.equal(result.representatives.length, 2);
});

test("same company, project, and ramp-up event are grouped while a different event remains separate", () => {
  const result = deduplicateEvents([
    article("a", "Almonty Sangdong mine commercial production ramp-up", "Outlet A"),
    article("b", "Almonty reports Sangdong mine ramp-up into commercial production", "Outlet B", "2026-09-04T10:00:00Z"),
    article("c", "Almonty announces financing for a tungsten study", "Outlet C", "2026-09-04T10:00:00Z"),
  ].map((item) => ({ ...item, eventStage: item.id === "c" ? "announced" : "actual" })));
  assert.equal(result.representatives.length, 2);
  assert.equal(result.representatives.find((item) => item.duplicateCount === 2).duplicateTitles.length, 2);
});

test("same analyst-rating action groups, but distinct mines for one company stay separate", () => {
  const ratings = deduplicateEvents([
    article("a", "Jefferies rates Almonty Buy", "Investing.com"),
    article("b", "Jefferies starts coverage of Almonty with Buy recommendation", "Investing.com"),
  ]);
  const mines = deduplicateEvents([
    article("a", "Almonty Sangdong mine production ramp-up", "Outlet A"),
    article("b", "Almonty Panasqueira mine production ramp-up", "Outlet B"),
  ].map((item) => ({ ...item, eventStage: "actual" })));
  assert.equal(ratings.representatives.length, 1);
  assert.equal(mines.representatives.length, 2);
});

test("conflicting named assets veto deduplication, while same-source near-identical bottleneck stories group", () => {
  const dolphin = article("a", "Dolphin tungsten mine restart begins", "Outlet A");
  const plymouth = article("b", "Plymouth tungsten mine restart begins", "Outlet B");
  const mines = deduplicateEvents([dolphin, plymouth]);
  const smelting = deduplicateEvents([
    article("a", "Global tungsten market faces smelting capacity bottleneck", "Shanghai Metals Market", "2026-09-03T10:00:00Z"),
    article("b", "International tungsten market faces smelting capacity shortage", "Shanghai Metals Market", "2026-09-03T10:45:00Z"),
  ]);
  assert.equal(hasConflictingAssets(dolphin, plymouth), true);
  assert.equal(mines.representatives.length, 2);
  assert.equal(smelting.representatives.length, 1);
  assert.deepEqual(smelting.representatives[0].duplicateTitles.length, 2);
});

test("event evidence retains provenance and global relevance independently of regional relevance", () => {
  const result = deduplicateEvents([
    {
      ...article("a", "Tungsten export control takes effect", "Source A"), categoryKey: "regulation", sentiment: "bullish",
      supplyEffect: "decrease", demandEffect: "none", eventStage: "actual", evidenceMaturity: "realized",
      severity: 0.9, confidence: 0.8, globalRelevance: 0.95, chinaRelevance: 1, euRelevance: 0.2, horizonWeeks: 26,
    },
    {
      ...article("b", "Tungsten export control takes effect", "Source B"), categoryKey: "regulation", sentiment: "bullish",
      supplyEffect: "decrease", demandEffect: "none", eventStage: "actual", evidenceMaturity: "realized",
      severity: 0.9, confidence: 0.8, globalRelevance: 0.95, chinaRelevance: 1, euRelevance: 0.2, horizonWeeks: 26,
    },
  ]);
  const [evidence] = buildEventEvidence(result.representatives);
  assert.equal(result.representatives.length, 1);
  assert.deepEqual(evidence, {
    eventId: "event-1", representativeArticleId: "a", headline: "Tungsten export control takes effect",
    category: "regulation", direction: "bullish", supplyEffect: "decrease", demandEffect: "none",
    eventStage: "actual", evidenceMaturity: "realized", severity: 0.9, confidence: 0.8,
    globalRelevance: 0.95, chinaRelevance: 1, euRelevance: 0.2, horizonWeeks: 26,
    duplicateCount: 2, duplicateSources: ["Source A", "Source B"], evidenceSource: "news",
  });
});

test("classification cache reuses unchanged content but invalidates model or schema changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-cache-"));
  const item = { title: "Tungsten supply update", snippet: "Production rises", source: "Source" };
  const first = new NewsClassificationCache({ directory, model: "qwen3:4b", schemaVersion: "causal-v1" });
  first.set(item, { direction: "bearish" });
  assert.deepEqual(new NewsClassificationCache({ directory, model: "qwen3:4b", schemaVersion: "causal-v1" }).get(item), { direction: "bearish" });
  assert.equal(new NewsClassificationCache({ directory, model: "other", schemaVersion: "causal-v1" }).get(item), null);
  assert.equal(new NewsClassificationCache({ directory, model: "qwen3:4b", schemaVersion: "causal-v2" }).get(item), null);
  fs.rmSync(directory, { recursive: true, force: true });
});

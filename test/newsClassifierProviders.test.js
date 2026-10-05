"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  BmfProvider,
  batchArticles,
  CLASSIFICATION_SCHEMA,
  classifySequentialBatches,
  describeClassificationFailure,
  DIRECTION_EXAMPLES,
  OllamaProvider,
  buildClassificationPrompt,
  selectArticlesForClassification,
} = require("../lib/newsClassifierProviders");
const { validateNewsClassification } = require("../lib/newsClassificationValidation");

function item(id, overrides = {}) {
  return { id, title: `Tungsten article ${id}`, snippet: "Supply update", source: "Test", date: "2026-09-03", relevanceScore: 0.8, ...overrides };
}

function classification(id, overrides = {}) {
  return { id, category: "supply", direction: "bullish", supplyEffect: "decrease", demandEffect: "none", eventStage: "actual", severity: 0.7, confidence: 0.8, globalRelevance: 0.7, chinaRelevance: 1, euRelevance: 0.5, horizonWeeks: 12, summary: "Zusammenfassung", impactExplanation: "Qualitative Wirkung", ...overrides };
}

test("Ollama uses schema-constrained non-streaming, zero-temperature batch output", async () => {
  let request;
  const provider = new OllamaProvider({ fetch: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ classifications: [classification("a"), classification("b")] }) } }) };
  } });
  const result = await provider.classify([item("a"), item("b")]);
  assert.equal(result.get("a").category, "supply");
  assert.equal(request.stream, false);
  assert.equal(request.think, false);
  assert.equal(request.options.temperature, 0);
  assert.equal(request.format.type, "object");
});

test("malformed JSON and mismatched article ids fail safely", async () => {
  const malformed = new OllamaProvider({ fetch: async () => ({ ok: true, json: async () => ({ message: { content: "not json" } }) }) });
  await assert.rejects(() => malformed.classify([item("a")]), /JSON/);
  const mismatched = new OllamaProvider({ fetch: async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify({ classifications: [classification("other")] }) } }) }) });
  await assert.rejects(() => mismatched.classify([item("a")]), /mismatched article ids/);
});

test("Ollama health distinguishes unreachable and missing configured model", async () => {
  const unreachable = new OllamaProvider({ fetch: async () => { throw new Error("offline"); } });
  assert.deepEqual(await unreachable.health(), { provider: "ollama", configured: true, reachable: false, model: "qwen3:4b", modelAvailable: false, available: false, lastSuccessfulCall: null });
  const missing = new OllamaProvider({ fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: "other:1b" }] }) }) });
  assert.equal((await missing.health()).modelAvailable, false);
});

test("selection honors the maximum, relevance first, then recency", () => {
  const selected = selectArticlesForClassification([
    item("older-high", { relevanceScore: 0.9, date: "2026-09-01" }),
    item("newer-high", { relevanceScore: 0.9, date: "2026-09-03" }),
    item("lower", { relevanceScore: 0.8, date: "2026-09-04" }),
  ], 2);
  assert.deepEqual(selected.map((article) => article.id), ["newer-high", "older-high"]);
});

test("twelve selected articles are split into four batches of three", () => {
  const articles = Array.from({ length: 12 }, (_value, index) => item(`id-${index}`));
  assert.deepEqual(batchArticles(articles, 3).map((batch) => batch.length), [3, 3, 3, 3]);
});

test("a failed batch preserves classifications from successful sequential batches", async () => {
  const calls = [];
  const provider = { classify: async (batch) => {
    calls.push(batch.map((article) => article.id));
    if (batch[0].id === "id-3") throw new Error("timeout");
    return new Map(batch.map((article) => [article.id, classification(article.id)]));
  } };
  const articles = Array.from({ length: 6 }, (_value, index) => item(`id-${index}`));
  const result = await classifySequentialBatches(provider, articles, 3);
  assert.deepEqual(calls, [["id-0", "id-1", "id-2"], ["id-3", "id-4", "id-5"]]);
  assert.equal(result.classifications.size, 3);
  assert.deepEqual(result.failedBatches, [["id-3", "id-4", "id-5"]]);
  assert.equal(result.successfulBatches, 1);
  assert.equal(result.failedBatchDetails[0].error.type, "unknown");
});

test("Ollama requests remain direct when proxy environment variables are present", async () => {
  const original = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://corporate-proxy.example:8080";
  let requestOptions;
  try {
    const provider = new OllamaProvider({ fetch: async (_url, options) => {
      requestOptions = options;
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ classifications: [classification("a")] }) } }) };
    } });
    await provider.classify([item("a")]);
    assert.equal(requestOptions.dispatcher, undefined);
  } finally {
    if (original === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = original;
  }
});

test("batch diagnostics distinguish timeout, connection, and validation failures", () => {
  assert.deepEqual(describeClassificationFailure({ name: "AbortError" }), { type: "timeout", code: "REQUEST_TIMEOUT" });
  assert.deepEqual(describeClassificationFailure({ code: "ECONNREFUSED" }), { type: "connection", code: "ECONNREFUSED" });
  assert.deepEqual(describeClassificationFailure(new Error("classifier returned incomplete batch")), { type: "validation", code: "INVALID_CLASSIFICATION" });
});

test("complete batch failure is isolated and returns a safe empty result", async () => {
  const provider = { classify: async () => { throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" }); } };
  const result = await classifySequentialBatches(provider, [item("a"), item("b")], 1);
  assert.equal(result.classifications.size, 0);
  assert.equal(result.failedBatches.length, 2);
  assert.deepEqual(result.failedBatchDetails.map((detail) => detail.error.type), ["connection", "connection"]);
});

test("Ollama timeout is applied independently to each sequential batch", async () => {
  const signals = [];
  const provider = new OllamaProvider({
    timeoutMs: 5,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  const result = await classifySequentialBatches(provider, [item("a"), item("b")], 1);
  assert.equal(result.failedBatches.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(result.failedBatchDetails.map((detail) => detail.error.type), ["timeout", "timeout"]);
});

test("article-only prompt excludes hidden numerical model data", () => {
  const prompt = buildClassificationPrompt([item("a", { baseline: [1, 2], scenario: "supplyShock", expectedChange12m: 99 })]);
  assert.match(prompt, /Tungsten article a/);
  assert.doesNotMatch(prompt, /supplyShock|expectedChange12m|\[1,2\]/);
});

test("prompt contract defines direction as tungsten/APT price pressure and includes sanity examples", () => {
  const prompt = buildClassificationPrompt([item("a")]);
  assert.match(prompt, /DIRECTION BEDEUTET AUSSCHLIESSLICH DIE RICHTUNG DES TUNGSTEN-\/APT-PREISDRUCKS/);
  assert.match(prompt, /DIRECTION REFERS TO TUNGSTEN\/APT PRICE DIRECTION ONLY/);
  assert.match(prompt, /nicht die Bewertung für Industrie, Käufer, Produzenten/);
  assert.match(prompt, /Keine externen historischen Vergleiche/);
  assert.match(prompt, /Übertrage niemals Fakten, Kontext, Ursachen oder Wirkungen zwischen article ids/);
  assert.match(prompt, /Mehr Angebot → bearish; weniger Angebot → bullish; stärkere Nachfrage → bullish; schwächere Nachfrage → bearish/);
  assert.match(prompt, /direction=neutral und confidence niedrig/);
  assert.match(prompt, /Unternehmensmeldungen sind nicht automatisch 1/);
  assert.match(prompt, /Werte über 0.9 benötigen außergewöhnlich explizite Belege/);
  assert.match(prompt, /Mine oder Ramp-up ist supply, nicht technology/);
  assert.match(prompt, /direkte, im Artikel belegte Relevanz/);
  assert.match(prompt, /supplyEffect, demandEffect und eventStage/);
  assert.match(prompt, /Studie, Exploration und Spekulation sind keine aktuelle Angebotssteigerung/);
  assert.match(prompt, /Entdeckung, Bohrung, Assay, Intercept/);
  assert.match(prompt, /demandEffect=increase oder decrease nur bei ausdrücklich genanntem Verbrauch/);
  assert.match(prompt, /Exportkontrollen bedeuten typischerweise supplyEffect=decrease/);
  assert.match(prompt, /globalRelevance \(0-1\) misst ausschließlich/);
  assert.deepEqual(DIRECTION_EXAMPLES, [
    ["China restricts tungsten exports", "bullish"],
    ["A tungsten mine closes because of an accident", "bullish"],
    ["A major new tungsten mine starts commercial production", "bearish"],
    ["Tungsten carbide demand falls", "bearish"],
    ["The EU discusses tungsten policy with no specified supply/demand effect", "neutral"],
  ]);
  assert.match(CLASSIFICATION_SCHEMA.properties.classifications.items.properties.direction.description, /price direction only/);
  assert.equal(CLASSIFICATION_SCHEMA.properties.classifications.items.required.includes("globalRelevance"), true);
});

test("BMF is optional and only configured with its required settings", async () => {
  const unavailable = new BmfProvider({ fetch: async () => ({}) });
  assert.equal((await unavailable.health()).available, false);
  const configured = new BmfProvider({ fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ classifications: [classification("a")] }) } }] }) }), baseUrl: "https://example.test", apiKey: "secret", model: "test-model" });
  assert.equal((await configured.health()).available, true);
  assert.equal((await configured.classify([item("a")])).get("a").id, "a");
});

test("server-side validation rejects invalid enums and clamps numerical fields", () => {
  const validated = validateNewsClassification(classification("a", { category: "invalid", direction: "up", severity: 4, confidence: -2, globalRelevance: 9, chinaRelevance: 5, euRelevance: -1, horizonWeeks: 99 }), "Fallback");
  assert.equal(validated.category, "other");
  assert.equal(validated.direction, "neutral");
  assert.deepEqual([validated.severity, validated.confidence, validated.globalRelevance, validated.chinaRelevance, validated.euRelevance, validated.horizonWeeks], [1, 0, 1, 1, 0, 52]);
});

test("server catches classifier failure and keeps provider-specific HTTP outside orchestration", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /classifySequentialBatches\(/);
  assert.match(source, /Klassifizierung fehlgeschlagen/);
  assert.doesNotMatch(source, /callBoschModelFarm|function buildPrompt/);
});

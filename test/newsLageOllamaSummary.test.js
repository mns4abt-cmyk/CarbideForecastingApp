"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { addOllamaNewsLageSummaries, ALLOWED_EVENT_FIELDS, isSafeSummary } = require("../lib/newsLageOllamaSummary");

function payload() {
  const summary = (market, eventTitle) => ({ status: "available", text: "Deterministischer Fallback.",
    qualitativeLabel: market === "china" ? "bullish" : "bearish", totalEventCount: 10,
    directionalEventCount: 7, additionalLlmCalls: false, topEvents: [{ eventKey: `${market}-event`, title: eventTitle,
      source: `${market} publisher`, date: "2026-10-01T00:00:00.000Z", category: "supply",
      direction: "bullish", supplyEffect: "decrease", demandEffect: "none", eventStage: "actual",
      evidenceMaturity: "realized", effectiveMarketRelevance: 0.8, finalWeight: 123,
      p50: 999, scenario: "must not be sent" }] });
  return { available: true, windowDays: 30,
    china: { sentimentScore: 31 }, eu: { sentimentScore: -42 },
    events: { china: [{ eventKey: "china-event", publishedAt: "2026-10-01T00:00:00.000Z" }],
      eu: [{ eventKey: "eu-event", publishedAt: "2026-10-01T00:00:00.000Z" }] },
    managementSummary: { china: summary("china", "China event title"), eu: summary("eu", "EU event title") } };
}

test("sends independent market summaries with only the approved validated-event fields", async () => {
  const requests = [];
  const articleContent = [
    { title: "China event title", snippet: "Almonty restarted tungsten output at Sangdong.", source: "china publisher", publishedAt: "2026-10-01T00:00:00.000Z" },
    { title: "EU event title", snippet: "European processors reported tight tungsten supply.", source: "eu publisher", publishedAt: "2026-10-01T00:00:00.000Z" },
    { title: "Unselected article", snippet: "This must remain outside both summaries.", source: "Other", publishedAt: "2026-10-01T00:00:00.000Z" },
  ];
  const result = await addOllamaNewsLageSummaries(payload(), {
    baseUrl: "http://127.0.0.1:11434", model: "qwen3:4b", logger: { warn() {} },
    articleContent,
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      const request = requests.at(-1).body;
      assert.deepEqual(request.format, { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false });
      assert.equal(request.options.num_predict, 256);
      const prompt = request.messages[0].content;
      const market = prompt.includes('"market":"China"') ? "china" : "eu";
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ summary: market === "china"
        ? "Almonty hat die Wolframproduktion in Sangdong wieder aufgenommen. Weitere ausgewählte Meldungen beschreiben konkrete Veränderungen am Markt."
        : "Europäische Verarbeiter berichten von einer angespannten Wolframversorgung. Die ausgewählten Artikel beschreiben konkrete Entwicklungen bei den Verarbeitern." }) } }) };
    },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.url === "http://127.0.0.1:11434/api/chat"));
  const prompts = requests.map(request => request.body.messages[0].content);
  assert.ok(prompts.some(prompt => prompt.includes("China event title") && !prompt.includes("EU event title")));
  assert.ok(prompts.some(prompt => prompt.includes("EU event title") && !prompt.includes("China event title")));
  for (const prompt of prompts) {
    const input = JSON.parse(prompt.split("\n").at(-1));
    assert.equal(input.market === "China" ? input.events[0].source : input.events[0].source,
      input.market === "China" ? "china publisher" : "eu publisher");
    assert.equal(input.events[0].publishedAt, "2026-10-01T00:00:00.000Z");
    assert.match(input.events[0].snippet, /Almonty|European processors/);
    assert.ok(!prompt.includes("This must remain outside both summaries."));
    assert.deepEqual(Object.keys(input.events[0]).sort(), [...ALLOWED_EVENT_FIELDS].filter(key => input.events[0][key] !== undefined).sort());
    assert.ok(!prompt.includes("999"));
    assert.ok(!prompt.includes("must not be sent"));
    assert.ok(!prompt.includes("P10") && !prompt.includes("P50") && !prompt.includes("P90"));
  }
  assert.notEqual(result.managementSummary.china.text, result.managementSummary.eu.text);
  assert.equal(result.managementSummary.china.qualitativeLabel, "bullish");
  assert.equal(result.managementSummary.eu.qualitativeLabel, "bearish");
  assert.equal(result.managementSummary.china.numericalForecastAdjustmentApplied, false);
  assert.equal(result.managementSummary.china.additionalLlmCalls, true);
});

test("prompt requires concise management German and excludes technical or predictive claims", () => {
  const prompt = require("../lib/newsLageOllamaSummary").buildPrompt({ market: "China", events: [] });
  assert.match(prompt, /managementgerechten Nachrichtenüberblick/);
  assert.match(prompt, /genau 2 bis 3 kurze, flüssige Sätze/);
  assert.match(prompt, /konkrete Entwicklungen/);
  assert.match(prompt, /Zähle die Artikel nicht einzeln auf/);
  assert.match(prompt, /keine generische Themen-/);
  assert.match(prompt, /keine Preise oder Preisentwicklung voraus/);
  assert.match(prompt, /leite keine Folgen, Ursachen oder Auswirkungen/);
  assert.match(prompt, /nur ein Titel verfügbar ist/);
  assert.match(prompt, /mining output heißt Fördermenge oder Produktion/);
  assert.match(prompt, /Fragen, Vermutungen oder mögliche Deutungen/);
  assert.match(prompt, /keine internen Feldnamen/);
});

test("unavailable Ollama keeps deterministic market-specific summaries without failing News-Lage", async () => {
  const original = payload();
  const fallback = original.managementSummary.china.text;
  const warnings = [];
  const result = await addOllamaNewsLageSummaries(original, {
    fetch: async () => { throw new Error("provider unavailable"); },
    logger: { warn: message => warnings.push(message) },
  });
  assert.equal(result.available, true);
  assert.match(result.managementSummary.china.text, /China event title/);
  assert.notEqual(result.managementSummary.china.text, fallback);
  assert.equal(result.managementSummary.china.additionalLlmCalls, false);
  assert.equal(warnings.length, 2);
});

test("skips Ollama when unavailable and leaves empty markets alone", async () => {
  const data = payload();
  data.managementSummary.eu.status = "empty";
  let calls = 0;
  const result = await addOllamaNewsLageSummaries(data, {
    available: false, fetch: async () => { calls++; throw new Error("must not be called"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.managementSummary.eu.text, data.managementSummary.eu.text);
});

test("keeps deterministic fallback when a market has no selected events", async () => {
  const data = payload();
  data.managementSummary.china.topEvents = [];
  const fallback = data.managementSummary.china.text;
  let calls = 0;
  const result = await addOllamaNewsLageSummaries(data, {
    fetch: async () => { calls++; throw new Error("must not be called"); },
    logger: { warn() {} },
  });
  assert.equal(calls, 1);
  assert.equal(result.managementSummary.china.text, fallback);
});

test("rejects invented numerical claims and direct forecast language", () => {
  const events = [{ title: "Wolfram production update", snippet: "Supply remains tight." }];
  assert.equal(isSafeSummary("Das Angebot bleibt angespannt. Produktionsmeldungen prägen die Lage mit 25 Prozent.", events), false);
  assert.equal(isSafeSummary("Der Markt dürfte steigen. Die Meldungen beschreiben aktuelle Entwicklungen.", events), false);
  assert.equal(isSafeSummary("Die Produktion in Sangdong steigt um 25%. Die Angebotslage bleibt angespannt.",
    [{ title: "Production increases 25% at Sangdong", snippet: "" }]), true);
});

test("rejects generic summaries that do not refer to concrete selected article content", () => {
  assert.equal(isSafeSummary("Im Fokus standen Angebot. Unter den Meldungen überwiegt Abwärtsdruck.",
    [{ title: "Almonty restarts Korean tungsten production at Sangdong", snippet: "" }]), false);
  assert.equal(isSafeSummary("Almonty startet Produktion in Sangdong. Dies signalisiert eine Versorgungskrise.",
    [{ title: "Almonty restarts Korean tungsten production at Sangdong", snippet: "" }]), false);
  assert.equal(isSafeSummary("Almonty startet die Produktion in Korea. Das könnte ein Gegengewicht zu China sein.",
    [{ title: "Almonty starts production in Korea, could it counter China?", snippet: "" }]), false);
  assert.equal(isSafeSummary("EQ Resources meldet signifikante Ausgaben in Australien. Der Umsatz nahm zu.",
    [{ title: "EQ Resources delivers meaningful Q1 tungsten output, revenue increase", snippet: "" }]), false);
});
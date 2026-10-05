"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ACCEPTANCE_THRESHOLD, evaluateArticleRelevance, filterArticlesByRelevance } = require("../lib/newsRelevance");

function evaluate(title, snippet = "") {
  return evaluateArticleRelevance({ title, snippet });
}

test("accepts direct tungsten-market supply, trade, demand, and regulation articles", () => {
  const cases = [
    ["China restricts tungsten exports", "", 0.67],
    ["Ammonium paratungstate prices rise on concentrate shortage", "", 0.67],
    ["Tungsten carbide demand strengthens in cutting tools", "", 0.67],
    ["EU critical raw materials policy", "The proposal explicitly identifies tungsten as strategic.", 0.62],
    ["Tungsten mine production disruption", "", 0.67],
  ];
  for (const [title, snippet, score] of cases) {
    const result = evaluate(title, snippet);
    assert.equal(result.accepted, true, title);
    assert.equal(result.score, score, title);
  }
});

test("rejects generic finance, mining, commodity, cybersecurity APT, and generic carbide articles", () => {
  const cases = [
    "Best mining stocks to buy now",
    "Mining output increases at major producers",
    "Gold and copper prices rise on dollar weakness",
    "APT group targets European networks",
    "Carbide tooling demand improves",
    "Commodity prices dashboard lists tungsten, tin, copper, gold and silver",
  ];
  for (const title of cases) {
    const result = evaluate(title);
    assert.equal(result.accepted, false, title);
    assert.ok(result.score < ACCEPTANCE_THRESHOLD, title);
  }
});

test("title evidence weighs more than identical snippet-only evidence", () => {
  const titleMatch = evaluate("Tungsten export restriction announced");
  const snippetMatch = evaluate("Export restriction announced", "Tungsten policy update");
  assert.ok(titleMatch.score > snippetMatch.score);
  assert.equal(titleMatch.accepted, true);
  assert.equal(snippetMatch.accepted, true);
});

test("APT needs nearby tungsten-market context", () => {
  assert.equal(evaluate("APT prices rise as concentrate supply tightens").accepted, true);
  assert.equal(evaluate("APT campaign detected in enterprise network").accepted, false);
});

test("threshold, empty snippets, and malformed article fields are handled safely", () => {
  const belowThreshold = evaluate("Tungsten update");
  assert.equal(belowThreshold.score, 0.45);
  assert.equal(belowThreshold.accepted, false);
  assert.equal(evaluate("Tungsten export controls", "").accepted, true);
  assert.doesNotThrow(() => evaluateArticleRelevance({ title: null, snippet: undefined }));
  assert.equal(evaluateArticleRelevance({ title: null, snippet: undefined }).accepted, false);
});

test("only accepted articles continue after deterministic filtering", () => {
  const filtered = filterArticlesByRelevance([
    { title: "China restricts tungsten exports", snippet: "" },
    { title: "Best mining stocks to buy now", snippet: "" },
  ]);
  assert.equal(filtered.accepted.length, 1);
  assert.equal(filtered.rejected.length, 1);
  assert.equal(filtered.accepted[0].title, "China restricts tungsten exports");
});

test("Wolfram is disambiguated as a commodity rather than a person name", () => {
  for (const title of [
    "Malaktion im Freizeitpark: Wolfram Paul wird geehrt",
    "Er servierte Wolfram Siebeck eine halb rohe Kartoffel",
  ]) {
    const result = evaluate(title);
    assert.equal(result.accepted, false, title);
    assert.equal(result.relevanceDisambiguated, true, title);
  }
  assert.equal(evaluate("Wolfram-Preis steigt wegen Lieferkettenrisiken").accepted, true);
});

test("pure investor promotion is rejected but a concrete tungsten mine event remains eligible", () => {
  const rating = evaluate("Tungsten stock receives Buy rating and analyst coverage initiation");
  assert.equal(rating.accepted, false);
  assert.equal(rating.investorNoise, true);
  assert.equal(evaluate("Financial publication reports tungsten mine closure after production shutdown").accepted, true);
});

test("concrete market events override stock wrappers after publisher suffix stripping", () => {
  const exportControl = evaluateArticleRelevance({
    title: "China tightens tungsten exports as Western Star maps a New Mexico site - Stock Titan",
    source: "Stock Titan",
  });
  assert.equal(exportControl.accepted, true);
  assert.equal(exportControl.investorNoise, false);
  assert.equal(evaluate("Stock article: tungsten mine commercial production starts").accepted, true);
});

test("German Wolfram contracts are commodity context while market-mover lists remain noise", () => {
  assert.equal(evaluate("Sangdong-Produktion und langem Wolfram-Vertrag").accepted, true);
  const movers = evaluate("Market movers: Lululemon, Adobe, Zscaler, Fox Tungsten");
  assert.equal(movers.accepted, false);
  assert.equal(movers.investorNoise, true);
});

test("production evidence has explicit precedence over stock wrappers", () => {
  const german = evaluate("Die Almonty-Industries-Aktie steigt mit Sangdong-Produktion und langem Wolfram-Vertrag");
  const english = evaluate("Almonty Industries stock gains as Sangdong tungsten mine moves into full quarterly production");
  const rating = evaluate("Tungsten company receives a Buy rating because the sector is exciting");
  const movers = evaluate("Market movers: Lululemon, Adobe, Zscaler, Fox Tungsten");
  const exportInFinance = evaluate("Financial publication: China imposes tungsten export restriction");
  assert.deepEqual([german.accepted, german.investorNoise, german.concreteEvent], [true, false, true]);
  assert.deepEqual([english.accepted, english.investorNoise, english.concreteEvent], [true, false, true]);
  assert.equal(rating.accepted, false);
  assert.equal(movers.accepted, false);
  assert.equal(exportInFinance.accepted, true);
});

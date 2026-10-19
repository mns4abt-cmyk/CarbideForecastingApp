"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNewsLageSummary } = require("../lib/newsLageSummary");

function input(overrides = {}) {
  return { totalEventCount: 8, topEvents: [
    { category: "supply", direction: "bullish", title: "Company promises prices will soar", snippet: "Almonty resumed tungsten output at Sangdong." },
    { category: "regulation", direction: "bearish", title: "Another long article title", snippet: "European processors report tight concentrate supply." },
  ], ...overrides };
}

test("fallback extracts selected article descriptions instead of aggregate categories or direction counts", () => {
  const summary = buildNewsLageSummary(input());
  assert.match(summary, /Almonty resumed tungsten output at Sangdong/);
  assert.match(summary, /European processors report tight concentrate supply/);
  assert.doesNotMatch(summary, /Aufwärtsdruck|Abwärtsdruck|Im Fokus standen|bullish|bearish|finalWeight/i);
});

test("fallback prefers available snippets and uses article titles only when descriptions are absent", () => {
  const summary = buildNewsLageSummary(input({ topEvents: [{ title: "Almonty Sangdong production restarts", snippet: "" }] }));
  assert.match(summary, /Almonty Sangdong production restarts/);
});

test("fallback removes publisher suffixes from selected titles", () => {
  assert.equal(buildNewsLageSummary(input({ topEvents: [{ title: "Sangdong ships concentrate - Publisher", source: "Publisher" }] })),
    "Sangdong ships concentrate.");
});

test("empty and invalid inputs produce a short safe German fallback", () => {
  assert.match(buildNewsLageSummary(input({ totalEventCount: 0, topEvents: [] })), /nicht genügend Artikeldaten/);
  assert.match(buildNewsLageSummary(input({ topEvents: [] })), /nicht genügend Artikeldaten/);
  assert.match(buildNewsLageSummary(null), /nicht genügend Artikeldaten/);
});

test("fallback is deterministic and does not mutate the input", () => {
  const data = input();
  const before = structuredClone(data);
  assert.equal(buildNewsLageSummary(data), buildNewsLageSummary(data));
  assert.deepEqual(data, before);
});
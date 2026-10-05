"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const panel = require("../public/js/evidenceFusionPanel");

function item(overrides = {}) {
  return {
    baselineEvidence: { direction: "bullish", forecastChangePct: 4.5, reliability: "MEDIUM" },
    newsEvidence: { direction: "bullish", strength: 0.3, directionalEvents: 3, classifiedEvents: 11 },
    agreement: "agree",
    corroboration: "MEDIUM",
    ...overrides,
  };
}

function fusion() {
  return {
    china: { "4": item({ baselineEvidence: { direction: "bearish", forecastChangePct: -1.2, reliability: "LOW" } }), "12": item(), "26": item() },
    eu: { "4": item(), "12": item({ agreement: "conflict", corroboration: "LOW" }), "26": item() },
  };
}

test("renders the China panel with German baseline, news, and corroboration labels", () => {
  const html = panel.render({ fusion: fusion(), region: "china", horizonWeeks: 12 });
  assert.match(html, /<h3>China<\/h3>/);
  assert.match(html, /Aufwärtsdruck · \+4,5%/);
  assert.match(html, /Modellzuverlässigkeit: Mittel/);
  assert.match(html, /3 von 11 Ereignissen/);
  assert.match(html, /Evidenzstärke: Mittel/);
  assert.match(html, /Bestätigt/);
  assert.match(html, /Externe Bestätigung: Mittel/);
});

test("renders the EU panel and conflict state", () => {
  const html = panel.render({ fusion: fusion(), region: "eu", horizonWeeks: 12 });
  assert.match(html, /<h3>EU<\/h3>/);
  assert.match(html, /Widerspruch/);
  assert.match(html, /Externe Bestätigung: Niedrig/);
});

test("both view renders separate China and EU cards", () => {
  const html = panel.render({ fusion: fusion(), region: "both", horizonWeeks: 12 });
  assert.match(html, /data-market="china"/);
  assert.match(html, /data-market="eu"/);
});

test("horizon selection reads the requested Fusion horizon rather than combining values", () => {
  const html = panel.render({ fusion: fusion(), region: "china", horizonWeeks: 4 });
  assert.match(html, /Abwärtsdruck · -1,2%/);
  assert.match(html, /Modellzuverlässigkeit: Niedrig/);
});

test("neutral NONE state is presented without probability wording", () => {
  const html = panel.render({
    fusion: { china: { "12": item({ newsEvidence: { direction: "neutral", strength: 0.01, directionalEvents: 0, classifiedEvents: 4 }, agreement: "none", corroboration: "NONE" }) } },
    region: "china", horizonWeeks: 12,
  });
  assert.match(html, /Neutral/);
  assert.match(html, /Keine belastbare externe Bestätigung/);
  assert.doesNotMatch(html, /Externe Bestätigung: Keine/);
  assert.doesNotMatch(html, /probability|Wahrscheinlichkeit/i);
});

test("unavailable Fusion is quiet and rendering does not mutate API forecast data", () => {
  const data = { china: { "12": { status: "unavailable" } } };
  const before = structuredClone(data);
  const html = panel.render({ fusion: data, region: "china", horizonWeeks: 12 });
  assert.match(html, /Evidenzbewertung derzeit nicht verfügbar\./);
  assert.deepEqual(data, before);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { render } = require("../public/js/strategicMarketPanel");

function report() {
  const latestEvents = [24, 23, 22, 21].map(day => ({ title: `Original title ${day}`,
    date: `2026-09-${day}T12:00:00Z`, direction: "bearish", category: "supply",
    eventStage: "actual", evidenceMaturity: "realized", source: "Publisher" }));
  return { status: "available", windowDays: 30, entityDefinitions: [
    { id: "almonty", apiKey: "almonty", displayName: "Almonty" },
    { id: "masan_group", apiKey: "masan", displayName: "Masan Group" },
    { id: "jinlu", apiKey: "jinlu", displayName: "Jinlu" },
  ], entities: {
    almonty: { status: "available", totalEventCount: 4, latestEventDate: latestEvents[0].date, latestEvents },
    masan: { status: "no_matching_events", totalEventCount: 0, latestEvents: [] },
  }, topics: {} };
}

test("renders five cards with three newest titles and all events in closed details", () => {
  const html = render({ report: report() });
  assert.equal((html.match(/class="strategic-card"/g) || []).length, 5);
  for (const name of ["Almonty", "Masan Group", "Jinlu", "China TC Betreiber", "Exportkontrollen"]) assert.ok(html.includes(name));
  const preview = html.slice(0, html.indexOf("<details"));
  assert.ok(preview.includes("Original title 24"));
  assert.ok(preview.includes("Original title 22"));
  assert.ok(!preview.includes("Original title 21"));
  assert.ok(html.includes("Original title 21"));
  assert.match(html, /<summary>Alle jüngsten Ereignisse \(4\)<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test("shows German metadata, price-pressure semantics and exact methodology", () => {
  const html = render({ report: report() });
  for (const label of ["4 Ereignisse / letzte 30 Tage", "Letztes Update: 24.09.2026",
    "Wolfram/APT-Preisdruck: Abwärtsdruck", "Kategorie: Angebot", "Phase: Tatsächlich wirksam",
    "Reife: Realisiert", "Quelle: Publisher", "keine Unternehmensbewertung",
    "Die strategische Marktbeobachtung gruppiert bereits validierte Nachrichtenereignisse nach wichtigen Marktteilnehmern und Themen. Es werden keine zusätzlichen KI-Prognosen erzeugt."]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Ã|�/);
});

test("empty data uses exact wording and is not confused with unavailable storage", () => {
  const html = render({ report: report() });
  assert.ok(html.includes("Keine validierten Ereignisse im gewählten Zeitraum."));
  assert.ok(html.includes("0 Ereignisse / letzte 30 Tage"));
  assert.ok(html.includes("Letztes Update: —"));
  for (const value of [null, { status: "database_unavailable" }, { status: "tags_unavailable" }, { status: "unavailable" }]) {
    const unavailable = render({ report: value });
    assert.ok(unavailable.includes("derzeit nicht verfügbar"));
    assert.ok(!unavailable.includes("0 Ereignisse"));
    assert.ok(!unavailable.includes("Keine validierten Ereignisse im gewählten Zeitraum."));
  }
});

test("escapes all stored event text and preserves titles as text rather than markup", () => {
  const data = report();
  const payload = '<img src=x onerror="alert(1)"> & \'title\'';
  Object.assign(data.entities.almonty.latestEvents[0], { title: payload, source: payload,
    category: payload, eventStage: payload, evidenceMaturity: payload, direction: payload });
  const html = render({ report: data });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;title&#39;"));
});

test("cross-market rendering and input data remain unchanged by market selection", () => {
  const data = report();
  const before = structuredClone(data);
  assert.equal(render({ report: data, region: "china" }), render({ report: data, region: "eu" }));
  assert.deepEqual(data, before);
});

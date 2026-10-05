"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tagStrategicEvent } = require("../lib/strategicMarketTagging");

test("company aliases map to stable unique entity tags", () => {
  for (const [title, entity] of [
    ["Almonty Industries", "almonty"], ["Sangdong-Produktion", "almonty"],
    ["Masan", "masan_group"], ["Masan Group", "masan_group"],
    ["Masan High-Tech Materials", "masan_group"], ["Masan High-Tech", "masan_group"],
    ["Nui Phao Mining", "masan_group"], ["Nui Phao", "masan_group"], ["Jinlu", "jinlu"],
  ]) assert.deepEqual(tagStrategicEvent({ title }).entities, [entity], title);
  assert.deepEqual(tagStrategicEvent({ title: "Almonty and Sangdong meet Masan at Nui Phao" }).entities, ["almonty", "masan_group"]);
});

test("export controls require commodity or company context and support bilingual wording", () => {
  for (const title of ["China tungsten export controls", "Wolfram Exportbeschränkungen", "Tungsten export licensing", "Wolfram Ausfuhrverbot"]) {
    assert.deepEqual(tagStrategicEvent({ title }).topics, ["export_controls", "regulation", "trade"]);
  }
  assert.deepEqual(tagStrategicEvent({ title: "Software export controls" }).topics, []);
});

test("Chinese TC operators require explicit carbide and operator evidence", () => {
  assert.ok(tagStrategicEvent({ title: "Chinese tungsten carbide producers expand production" }).topics.includes("china_tc_operators"));
  for (const title of ["China TC operators", "Chinese tungsten exports", "European tungsten carbide producers", "China tungsten carbide demand"]) {
    assert.ok(!tagStrategicEvent({ title }).topics.includes("china_tc_operators"), title);
  }
});

test("reuses summary, provenance titles and structured fields without mutating events", () => {
  const event = {
    title: "Company update", summary: "Masan High-Tech Materials expands processing capacity",
    provenance: { duplicateTitles: ["Nui Phao production and offtake agreement"] },
    category: "supply", supplyEffect: "increase", demandEffect: "none",
    sentimentScore: 18, priceOutcomes: [{ returnPct: -5 }],
  };
  const before = structuredClone(event);
  assert.deepEqual(tagStrategicEvent(event), { entities: ["masan_group"], topics: ["production", "capacity", "offtake", "supply"] });
  assert.deepEqual(event, before);
});

test("false positives, publisher metadata, and unrelated capacity are excluded", () => {
  for (const title of ["Almontyish", "Sangdongville", "Masanova", "Jinlux", "超级Jinlu公司", "TC", "JL", "XTC"])
    assert.deepEqual(tagStrategicEvent({ title }), { entities: [], topics: [] }, title);
  assert.deepEqual(tagStrategicEvent({ title: "Results - Jinlu", provenance: { source: "Jinlu", duplicateSources: ["Almonty"] } }), { entities: [], topics: [] });
  assert.deepEqual(tagStrategicEvent({ title: "Almonty speaks in his capacity as director" }).topics, []);
  assert.deepEqual(tagStrategicEvent({ title: "Generic production news", category: "supply", supplyEffect: "increase" }).topics, []);
});

test("offtake labels do not imply demand increases or supply signals", () => {
  const event = { title: "Almonty signs tungsten offtake agreement", supplyEffect: "none", demandEffect: "none" };
  assert.deepEqual(tagStrategicEvent(event), { entities: ["almonty"], topics: ["offtake"] });
  assert.equal(event.demandEffect, "none");
});

test("empty or malformed optional fields return safely", () => {
  for (const event of [undefined, null, [], {}, { title: 5, summary: {}, provenance: { duplicateTitles: null } }]) {
    assert.deepEqual(tagStrategicEvent(event), { entities: [], topics: [] });
  }
});

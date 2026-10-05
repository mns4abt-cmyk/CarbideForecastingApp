"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadStrategicEntities, validateStrategicEntities, confirmedEntities } = require("../lib/strategicEntities");
const { tagStrategicEvent } = require("../lib/strategicMarketTagging");
const { queryStrategicMarketIntelligence } = require("../lib/strategicMarketIntelligence");
const { loadStrategicMarketIntelligence } = require("../lib/strategicMarketIntelligenceIntegration");
const { render } = require("../public/js/strategicMarketPanel");

test("loads confirmed aliases, preserves Jinlu alone and documents two unnamed slots", () => {
  const config = loadStrategicEntities();
  assert.deepEqual(confirmedEntities(config).map(e => e.id), ["almonty", "masan_group", "jinlu"]);
  assert.deepEqual(config.chinaTcOperators.map(e => e.id), ["jinlu"]);
  assert.deepEqual(config.chinaTcOperators[0].aliases, ["Jinlu"]);
  assert.equal(config.pendingChinaTcOperatorSlots, 2);
  assert.match(config.confirmationNote, /business confirmation/i);
});

test("rejects malformed definitions, duplicate IDs/API keys and invalid confirmation flags", () => {
  for (const mutate of [
    c => { c.entities = {}; },
    c => { c.entities[0].aliases = [""]; },
    c => { c.entities[0].confirmed = "true"; },
    c => { c.entities[0].id = "__proto__"; },
    c => { c.chinaTcOperators.push({ ...c.entities[0] }); },
    c => { c.chinaTcOperators[0].apiKey = "masan"; },
    c => { c.pendingChinaTcOperatorSlots = -1; },
  ]) {
    const config = structuredClone(loadStrategicEntities());
    mutate(config);
    assert.throws(() => validateStrategicEntities(config), /Invalid strategic entity configuration/);
  }
});

test("configured aliases retain unicode boundaries and hyphen matching", () => {
  for (const [title, expected] of [["Sangdong-Produktion", ["almonty"]],
    ["Masan High-Tech Materials", ["masan_group"]], ["Nui Phao Mining", ["masan_group"]],
    ["JINLU", ["jinlu"]], ["Jinlux", []], ["超级Jinlu公司", []], ["Masanova", []]]) {
    assert.deepEqual(tagStrategicEvent({ title }).entities, expected);
  }
});

test("unconfirmed fixture operator is excluded from tagging, query views and API/frontend definitions", () => {
  const configuration = structuredClone(loadStrategicEntities());
  configuration.chinaTcOperators.push({ id: "fixture_operator", apiKey: "fixtureOperator",
    displayName: "Test fixture only", aliases: ["Fixture Operator"], confirmed: false });
  assert.deepEqual(tagStrategicEvent({ title: "Fixture Operator production" }, { configuration }).entities, []);
  const result = queryStrategicMarketIntelligence({ configuration, databasePath: ":memory:" });
  assert.ok(!result.entities.some(e => e.id === "fixture_operator"));
  const api = loadStrategicMarketIntelligence({ configuration, databasePath: ":memory:" });
  assert.ok(!api.entityDefinitions.some(e => e.id === "fixture_operator"));
  assert.ok(!render({ report: api }).includes("Test fixture only"));
  configuration.chinaTcOperators.at(-1).confirmed = true;
  assert.deepEqual(tagStrategicEvent({ title: "Fixture Operator production" }, { configuration }).entities, ["fixture_operator"]);
  const confirmed = loadStrategicMarketIntelligence({ configuration, databasePath: ":memory:" });
  assert.ok(confirmed.entities.fixtureOperator);
  assert.ok(render({ report: confirmed }).includes("Test fixture only"));
});

test("general China TC topic never creates individual operator identities", () => {
  const general = tagStrategicEvent({ title: "Chinese tungsten carbide producers expand production" });
  assert.deepEqual(general.entities, []);
  assert.ok(general.topics.includes("china_tc_operators"));
  const individual = tagStrategicEvent({ title: "Jinlu production" });
  assert.deepEqual(individual.entities, ["jinlu"]);
  assert.ok(!individual.topics.includes("china_tc_operators"));
});

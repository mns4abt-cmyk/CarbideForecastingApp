"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNewsLageSummary } = require("../lib/newsLageSummary");
const closing = "The statistical price forecast is not adjusted by this news assessment.";
const sparse = "This assessment currently rests on a small number of validated directional events.";
function input(overrides = {}) {
  return { qualitativeLabel: "bullish", sentimentScore: 45, totalEventCount: 8, directionalEventCount: 4,
    topEvents: [{ category: "supply" }, { category: "regulation" }], ...overrides };
}

test("bullish/bearish/balanced wording follows the supplied label, never the score or titles", () => {
  for (const [qualitativeLabel, phrase] of [
    ["bullish", "predominantly bullish"], ["bearish", "predominantly bearish"],
    ["neutral/ausgeglichen", "neutral/balanced"],
    ["stark bullish", "strongly bullish"], ["stark bearish", "strongly bearish"],
  ]) {
    const data = input({ qualitativeLabel, sentimentScore: -99,
      topEvents: [{ category: "supply", title: "Company promises prices will soar", direction: "bearish" }] });
    const summary = buildNewsLageSummary(data);
    assert.ok(summary.includes(`The news assessment is ${phrase} for tungsten/APT price pressure.`));
    assert.ok(!summary.includes("Company"));
    assert.ok(!summary.includes("soar"));
    assert.equal(summary, buildNewsLageSummary({ ...data, sentimentScore: 99 }));
  }
});
test("zero events and zero directional events are distinguished without inventing neutral labels", () => {
  assert.equal(buildNewsLageSummary(input({ totalEventCount: 0, directionalEventCount: 0 })),
    `No validated events are available for the 30-day assessment. ${closing}`);
  const summary = buildNewsLageSummary(input({ directionalEventCount: 0 }));
  assert.equal(summary, `Validated events are available, but no clear directional assessment is supported. ${closing}`);
  assert.ok(!summary.includes("bullish"));
});
test("one and two directional events trigger wording only; three or more do not", () => {
  for (const directionalEventCount of [1, 2, 3, 4]) {
    const summary = buildNewsLageSummary(input({ directionalEventCount }));
    assert.equal(summary.includes(sparse), directionalEventCount <= 2);
    assert.ok(summary.includes("predominantly bullish"));
  }
});
test("missing, unavailable or invalid essential inputs are insufficient, not neutral", () => {
  for (const data of [undefined, null, {}, input({ qualitativeLabel: "unavailable" }),
    input({ qualitativeLabel: "unknown" }), input({ sentimentScore: null }),
    input({ sentimentScore: NaN }), input({ totalEventCount: null }),
    input({ directionalEventCount: undefined }), input({ directionalEventCount: 9 }),
    input({ totalEventCount: -1 }), input({ directionalEventCount: 1.5 })]) {
    assert.equal(buildNewsLageSummary(data), `There is insufficient information for a directional news assessment. ${closing}`);
  }
});
test("up to three known categories are deduplicated in supplied ranking order", () => {
  const summary = buildNewsLageSummary(input({ topEvents: [
    { category: "regulation" }, { category: "supply" }, { category: "regulation" },
    null, { category: "<script>unknown</script>" }, { category: "demand" }, { category: "technology" },
  ] }));
  assert.ok(summary.includes("Among the selected events, regulation, supply and demand are most prominent."));
  assert.ok(!summary.includes("technology"));
  assert.ok(!summary.includes("script"));
  assert.ok(buildNewsLageSummary(input({ topEvents: [{ category: "supply" }] }))
    .includes("Among the selected events, supply is most prominent."));
  for (const topEvents of [[], null, {}, [{ category: "unknown" }]]) {
    assert.ok(!buildNewsLageSummary(input({ topEvents })).includes("most prominent"));
  }
});
test("all branches produce 2–4 sentences ending with the required forecast disclaimer", () => {
  for (const data of [undefined, input(), input({ directionalEventCount: 1 }),
    input({ directionalEventCount: 2, topEvents: [] }), input({ directionalEventCount: 0 }),
    input({ totalEventCount: 0, directionalEventCount: 0 })]) {
    const summary = buildNewsLageSummary(data);
    const sentences = summary.split(/[.!?]+/).filter(s => s.trim());
    assert.ok(sentences.length >= 2 && sentences.length <= 4);
    assert.ok(summary.endsWith(closing));
  }
});
test("output is deterministic and inputs remain unchanged", () => {
  const data = input({ directionalEventCount: 2 });
  const before = structuredClone(data);
  const first = buildNewsLageSummary(data);
  assert.equal(buildNewsLageSummary(data), first);
  assert.deepEqual(data, before);
});

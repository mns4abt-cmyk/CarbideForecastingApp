"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildEvidenceFusionDiagnostics } = require("../lib/evidenceFusionIntegration");

function market(lastPrice, reliability) {
  return {
    last_observed: { price: lastPrice },
    // Deliberately unlike p50[] below: Fusion must use exact weekly checkpoints,
    // not display-month indices 0/2/5.
    forecast_horizons: {
      "4w": { p50: lastPrice * 1.04, changePct: 4 },
      "12w": { p50: lastPrice * 1.12, changePct: 12 },
      "26w": { p50: lastPrice * 1.26, changePct: 26 },
    },
    p50: [110, 115, 120, 125, 130, 140],
    reliability: { "4w": { label: reliability[0] }, "12w": { label: reliability[1] }, "26w": { label: reliability[2] } },
  };
}

function pipeline() {
  return {
    china: market(100, ["LOW", "MEDIUM", "VERY_LOW"]),
    eu: market(200, ["MEDIUM", "LOW", "VERY_LOW"]),
    scenarios: [{ id: "base", china: [110], eu: [220] }],
  };
}

function event(overrides = {}) {
  return {
    eventId: "event-1", direction: "bullish", supplyEffect: "decrease", demandEffect: "none",
    evidenceMaturity: "realized", severity: 0.3, confidence: 0.9,
    globalRelevance: 0, chinaRelevance: 0.9, euRelevance: 0.2, horizonWeeks: 26,
    duplicateCount: 1, evidenceSource: "news", ...overrides,
  };
}

test("integration produces six additive Fusion outputs with copied statistical metadata", () => {
  const result = buildEvidenceFusionDiagnostics({ pipelineResult: pipeline(), eventEvidence: [event()] });
  assert.deepEqual(Object.keys(result.china), ["4", "12", "26"]);
  assert.deepEqual(Object.keys(result.eu), ["4", "12", "26"]);
  assert.deepEqual(
    [result.china["4"].baselineEvidence.forecastChangePct, result.china["12"].baselineEvidence.forecastChangePct, result.china["26"].baselineEvidence.forecastChangePct]
      .map((value) => Math.round(value * 1e9) / 1e9),
    [4, 12, 26],
  );
  assert.deepEqual(
    [result.china["4"].baselineEvidence.reliability, result.china["12"].baselineEvidence.reliability, result.china["26"].baselineEvidence.reliability],
    ["LOW", "MEDIUM", "VERY_LOW"],
  );
});

test("Fusion baseline mapping is independent of monthly display P50 indices", () => {
  const input = pipeline();
  input.china.p50 = [999, 999, 999, 999, 999, 999];
  input.eu.p50 = [1, 1, 1, 1, 1, 1];

  const result = buildEvidenceFusionDiagnostics({ pipelineResult: input, eventEvidence: [] });
  const changes = (marketName) => ["4", "12", "26"].map(
    (horizon) => Math.round(result[marketName][horizon].baselineEvidence.forecastChangePct * 1e9) / 1e9,
  );
  assert.deepEqual(changes("china"), [4, 12, 26]);
  assert.deepEqual(changes("eu"), [4, 12, 26]);
});

test("integration uses unique event evidence and duplicateCount has no effect", () => {
  const first = buildEvidenceFusionDiagnostics({ pipelineResult: pipeline(), eventEvidence: [event({ duplicateCount: 1 })] });
  const second = buildEvidenceFusionDiagnostics({ pipelineResult: pipeline(), eventEvidence: [event({ duplicateCount: 100 })] });
  assert.deepEqual(first, second);
  assert.equal(first.china["12"].newsEvidence.classifiedEvents, 1);
});

test("Fusion does not modify pipeline forecasts or scenarios and handles empty event evidence", () => {
  const input = pipeline();
  const before = structuredClone(input);
  const result = buildEvidenceFusionDiagnostics({ pipelineResult: input, eventEvidence: [] });
  assert.deepEqual(input, before);
  assert.equal(result.eu["26"].newsEvidence.direction, "none");
  assert.equal(result.eu["26"].numericalAdjustmentApplied, false);
});

test("Fusion failures are isolated for every market and horizon", () => {
  const result = buildEvidenceFusionDiagnostics({
    pipelineResult: pipeline(), eventEvidence: [event()], fuse: () => { throw new Error("unexpected"); },
  });
  for (const marketName of ["china", "eu"]) {
    for (const horizon of ["4", "12", "26"]) {
      assert.deepEqual(result[marketName][horizon], {
        status: "unavailable", error: "Evidence Fusion diagnostics unavailable.", numericalAdjustmentApplied: false,
      });
    }
  }
});

test("server exposes additive Fusion diagnostics without connecting them to numerical scenarios", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /buildEvidenceFusionDiagnostics\(\{ pipelineResult, eventEvidence \}\)/);
  assert.match(source, /evidenceFusion,/);
  const currentMarketCall = source.slice(
    source.indexOf("currentMarketScenario = await runCurrentMarketScenario"),
    source.indexOf("currentMarketScenario.summary"),
  );
  assert.doesNotMatch(currentMarketCall, /evidenceFusion/);
});

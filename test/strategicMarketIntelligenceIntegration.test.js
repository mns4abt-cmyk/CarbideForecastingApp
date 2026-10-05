"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { NewsEventStore } = require("../lib/newsEventStore");
const { loadStrategicMarketIntelligence } = require("../lib/strategicMarketIntelligenceIntegration");

function fixture(t) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "strategic-api-"));
  const databasePath = path.join(appDir, "data", "news-events.db");
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  return { appDir, databasePath };
}

// Execute the server's actual response assembly, without running external news,
// Ollama or Python. This catches omitted/wrong wiring and changed sibling fields.
function refreshResponse(appDir, loader = loadStrategicMarketIntelligence) {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.lastIndexOf("    res.json({");
  const end = source.indexOf("\n    });", start) + "\n    });".length;
  let response;
  const scope = {
    appDir, path, loadStrategicMarketIntelligence: loader,
    res: { json: (value) => { response = value; } },
    aiEnabled: true, aiError: null, classificationStatus: "classified",
    newsClassifier: { id: "ollama" }, aiProvider: { available: true },
    aiDiagnostic: { status: "active" }, pythonInterpreter: { display: "python3" },
    newsSource: "live", formatMonthLabel: (label) => label,
    pipelineResult: { history: { labels: ["2026-09"], china: [10], eu: [20] },
      forecastLabels: ["2026-10"], china: { p10: [8], p50: [11], p90: [14] },
      eu: { p10: [15], p50: [21], p90: [25] } },
    scenarios: [{ id: "base", china: [11], eu: [21] }], news: [{ title: "unchanged" }],
    eventEvidence: [{ eventId: "event-1" }], newsLage: { sentiment: 0.3 },
    historicalEventAssociations: { groups: [] }, evidenceFusion: { status: "unchanged" },
    newsDiagnostics: { fetched: 1 }, marketState: { china: { overall: 0.1 } },
  };
  vm.runInNewContext(source.slice(start, end), scope);
  return JSON.parse(JSON.stringify(response));
}

function seed(databasePath, populated) {
  const store = new NewsEventStore({ databasePath });
  try {
    store.ensureStrategicTagSchema();
    if (!populated) return;
    store.upsert({ eventId: "event-1", headline: "Almonty tungsten production",
      category: "supply", direction: "bearish", supplyEffect: "increase", demandEffect: "none",
      eventStage: "actual", evidenceMaturity: "realized", severity: 0.2, confidence: 0.8,
      globalRelevance: 0.2, chinaRelevance: 0, euRelevance: 0, horizonWeeks: 12,
    }, { eventKey: "stable-1", date: new Date().toISOString(), source: "Test publisher" });
    store.upsertStrategicTags("stable-1", {
      entities: ["almonty", "masan_group"], topics: ["export_controls"],
    }, "strategic-v1");
  } finally { store.close(); }
}

test("refresh exposes populated persisted views with API maps and methodology", (t) => {
  const f = fixture(t);
  seed(f.databasePath, true);
  const response = refreshResponse(f.appDir);
  assert.equal(response.ok, true);
  const smi = response.strategicMarketIntelligence;
  assert.equal(smi.status, "available");
  assert.equal(smi.windowDays, 30);
  assert.deepEqual(Object.keys(smi.entities), ["almonty", "masan", "jinlu"]);
  assert.deepEqual(Object.keys(smi.topics), ["chinaTcOperators", "exportControls"]);
  assert.equal(smi.entities.almonty.totalEventCount, 1);
  assert.equal(smi.entities.masan.id, "masan_group");
  assert.equal(smi.topics.exportControls.totalEventCount, 1);
  assert.equal(smi.entities.almonty.latestEvents[0].source, "Test publisher");
  assert.deepEqual(smi.methodology, { source: "validated_persisted_news_events",
    additionalLlmCalls: false, numericalForecastAdjustmentApplied: false });
});

test("refresh preserves explicit empty views as a successful query", (t) => {
  const f = fixture(t);
  seed(f.databasePath, false);
  const response = refreshResponse(f.appDir);
  assert.equal(response.ok, true);
  assert.equal(response.strategicMarketIntelligence.status, "available");
  assert.equal(response.strategicMarketIntelligence.entities.almonty.status, "no_matching_events");
  assert.equal(response.strategicMarketIntelligence.entities.almonty.totalEventCount, 0);
  assert.deepEqual(response.strategicMarketIntelligence.entities.almonty.latestEvents, []);
});

test("unavailable storage and unexpected query failures affect only the new section", (t) => {
  const f = fixture(t);
  const response = refreshResponse(f.appDir);
  assert.equal(response.ok, true);
  assert.equal(response.strategicMarketIntelligence.status, "database_unavailable");
  assert.equal(response.strategicMarketIntelligence.entities.almonty.totalEventCount, null);
  assert.equal(fs.existsSync(f.databasePath), false);
  const failed = refreshResponse(f.appDir, (options) => loadStrategicMarketIntelligence({
    ...options, query: () => { throw new Error("secret path / credentials"); },
  }));
  assert.equal(failed.ok, true);
  assert.equal(failed.strategicMarketIntelligence.status, "unavailable");
  assert.ok(!JSON.stringify(failed).includes("secret"));
});

test("all pre-existing refresh response fields are unchanged regardless of query outcome", (t) => {
  const f = fixture(t);
  const unavailable = refreshResponse(f.appDir);
  seed(f.databasePath, true);
  const populated = refreshResponse(f.appDir);
  for (const response of [unavailable, populated]) {
    delete response.strategicMarketIntelligence;
    assert.ok(Number.isFinite(Date.parse(response.generatedAt)));
    delete response.generatedAt;
    assert.deepEqual(response, {
      ok: true, aiEnabled: true, aiError: null, classificationStatus: "classified",
      llmProvider: "ollama", aiProvider: { available: true }, aiProviderAvailable: true,
      aiDiagnostic: { status: "active" }, pythonInterpreter: "python3", newsSource: "live",
      history: { labels: ["2026-09"], china: [10], eu: [20] }, forecastLabels: ["2026-10"],
      baseline: { china: { p10: [8], p50: [11], p90: [14] }, eu: { p10: [15], p50: [21], p90: [25] } },
      scenarios: [{ id: "base", china: [11], eu: [21] }], news: [{ title: "unchanged" }],
      eventEvidence: [{ eventId: "event-1" }], newsLage: { sentiment: 0.3 },
      historicalEventAssociations: { groups: [] }, evidenceFusion: { status: "unchanged" },
      newsDiagnostics: { fetched: 1 }, marketState: { china: { overall: 0.1 } },
    });
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const pipelineSource = fs.readFileSync(path.join(root, "forecasting", "pipeline.py"), "utf8");

test("successful refresh consumes Python-provided scenarios, not JavaScript scenario deltas", () => {
  assert.match(serverSource, /const scenarios = pipelineResult\.scenarios;/);
  assert.doesNotMatch(serverSource, /CarbideData\.computeScenarioSeries/);
  assert.doesNotMatch(serverSource, /require\("\.\/public\/js\/data\.js"\)/);
});

test("pipeline constructs an independent P50 baseline and Python historical-quantile stress tests", () => {
  assert.match(pipelineSource, /"id": "base"/);
  assert.match(pipelineSource, /"kind": "baseline"/);
  assert.match(pipelineSource, /"china": frontend_markets\["china"\]\["p50"\]/);
  assert.match(pipelineSource, /from forecasting\.scenarios import build_scenarios/);
  assert.match(pipelineSource, /build_scenarios\(weekly_df=weekly_df, baseline=baseline\)/);
});

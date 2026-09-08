"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_OLLAMA_BATCH_SIZE,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  getOllamaRuntimeConfig,
} = require("../lib/ollamaRuntimeConfig");

test("Ollama runtime config keeps the normal defaults", () => {
  assert.deepEqual(getOllamaRuntimeConfig({}), { batchSize: DEFAULT_OLLAMA_BATCH_SIZE, timeoutMs: DEFAULT_OLLAMA_TIMEOUT_MS });
});

test("Ollama runtime config accepts the slower Windows overrides", () => {
  assert.deepEqual(
    getOllamaRuntimeConfig({ OLLAMA_BATCH_SIZE: "1", OLLAMA_TIMEOUT_MS: "180000" }),
    { batchSize: 1, timeoutMs: 180000 }
  );
});

test("invalid Ollama runtime values safely use the existing defaults", () => {
  for (const invalid of ["", "0", "-1", "1.5", "NaN", "Infinity"]) {
    assert.deepEqual(
      getOllamaRuntimeConfig({ OLLAMA_BATCH_SIZE: invalid, OLLAMA_TIMEOUT_MS: invalid }),
      { batchSize: DEFAULT_OLLAMA_BATCH_SIZE, timeoutMs: DEFAULT_OLLAMA_TIMEOUT_MS }
    );
  }
});

test("AI diagnostic reports effective batch size and per-request timeout", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "diagnose-ai.js"), "utf8");
  assert.match(source, /batchSize,/);
  assert.match(source, /timeoutMs,/);
  assert.match(source, /getOllamaRuntimeConfig/);
});

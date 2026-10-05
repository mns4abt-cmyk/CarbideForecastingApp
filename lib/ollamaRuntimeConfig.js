"use strict";

const DEFAULT_OLLAMA_BATCH_SIZE = 3;
const DEFAULT_OLLAMA_TIMEOUT_MS = 75000;
const MAX_OLLAMA_BATCH_SIZE = 12;

function parsePositiveInteger(value, fallback) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getOllamaRuntimeConfig(env = process.env) {
  return {
    batchSize: Math.min(MAX_OLLAMA_BATCH_SIZE, parsePositiveInteger(env.OLLAMA_BATCH_SIZE, DEFAULT_OLLAMA_BATCH_SIZE)),
    timeoutMs: parsePositiveInteger(env.OLLAMA_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS),
  };
}

module.exports = {
  DEFAULT_OLLAMA_BATCH_SIZE,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  MAX_OLLAMA_BATCH_SIZE,
  getOllamaRuntimeConfig,
  parsePositiveInteger,
};

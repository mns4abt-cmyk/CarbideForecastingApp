"use strict";

const fs = require("fs");
const path = require("path");
const { fetch, ProxyAgent } = require("undici");
const { createNewsTransport } = require("../lib/newsTransport");
const { createNewsClassifierProvider } = require("../lib/newsClassifierProviders");
const { NewsClassificationCache } = require("../lib/newsClassificationCache");
const { getOllamaRuntimeConfig } = require("../lib/ollamaRuntimeConfig");
const { runHistoricalNewsBackfill } = require("../lib/newsHistoricalBackfill");

const appDir = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(appDir, ".env") });

const CLASSIFIER_VERSION = "causal-v3";

function optionalPositiveInteger(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(appDir, "config", "news-sources.json"), "utf8"));
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  const transport = createNewsTransport({ fetch, dispatcher: proxyUrl ? new ProxyAgent(proxyUrl) : undefined });
  const runtime = getOllamaRuntimeConfig(process.env);
  const provider = createNewsClassifierProvider({
    providerId: process.env.LLM_PROVIDER || "ollama",
    fetch,
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
    timeoutMs: runtime.timeoutMs,
  });
  const classificationCache = new NewsClassificationCache({
    directory: path.join(appDir, ".cache"),
    model: provider.model,
    schemaVersion: CLASSIFIER_VERSION,
  });
  const result = await runHistoricalNewsBackfill({
    config,
    dependencies: { fetch: transport.fetch, transportFor: transport.transportFor },
    provider,
    databasePath: path.join(appDir, "data", "news-events.db"),
    maxPerRefresh: Number(process.env.MAX_LLM_ARTICLES) || 12,
    batchSize: provider.id === "ollama" ? runtime.batchSize : (Number(process.env.MAX_LLM_ARTICLES) || 12),
    maxArticles: optionalPositiveInteger(process.env.NEWS_BACKFILL_MAX_ARTICLES),
    classificationCache,
    classifierVersion: CLASSIFIER_VERSION,
    onProgress: (progress) => console.log(JSON.stringify({ type: "news-backfill-progress", ...progress })),
  });
  console.log(JSON.stringify({ runtime: { batchSize: runtime.batchSize, timeoutMs: runtime.timeoutMs }, ...result }, null, 2));
  // Individual timeouts are isolated and recorded in `failures`; they never
  // prevent later units from being persisted, but leave a non-zero result for
  // unattended jobs to signal that a rerun still has work to do.
  if (!result.provider.available || result.failures > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Historical news backfill failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };

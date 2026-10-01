"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");
const { effectiveMarketRelevance } = require("./newsEventWeight");
const { associateEventPriceOutcomes } = require("./eventPriceAssociation");
const { candidatesFor, resolvePythonInterpreter } = require("./pythonResolver");

const execFileAsync = promisify(execFile);
const MARKETS = ["china", "eu"];
const appDir = path.join(__dirname, "..");
const WEEKLY_EXPORT_SCRIPT = path.join(appDir, "forecasting", "export_weekly_market_data.py");

async function loadNormalizedWeeklySeries({
  rootDir = appDir,
  resolveInterpreter = resolvePythonInterpreter,
  candidateProvider = candidatesFor,
  execFileImpl = execFileAsync,
} = {}) {
  let preferred;
  try {
    preferred = await resolveInterpreter({ appDir: rootDir });
  } catch {
    // The candidate list below supplies the final useful error after attempting
    // the actual import/export operation rather than only `--version`.
  }
  const key = (candidate) => `${candidate.command}\u0000${candidate.argsPrefix.join("\u0000")}`;
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...candidateProvider({ appDir: rootDir }),
  ].filter((candidate, index, all) => all.findIndex((item) => key(item) === key(candidate)) === index);
  const failures = [];
  for (const interpreter of candidates) {
    try {
      const { stdout } = await execFileImpl(
        interpreter.command,
        [...interpreter.argsPrefix, WEEKLY_EXPORT_SCRIPT],
        { cwd: rootDir, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
      );
      const rows = JSON.parse(stdout);
      if (!Array.isArray(rows)) throw new Error("Normalized weekly price export did not return an array");
      return rows;
    } catch (error) {
      failures.push(`${interpreter.display || interpreter.command}: ${error.message}`);
    }
  }
  throw new Error(`Could not export normalized weekly prices. ${failures.join(" | ")}`);
}

function eventDate(event) {
  return event?.publishedAt || event?.firstSeenAt || null;
}

function emptyDiagnostics(referenceDate) {
  return {
    referenceDate,
    eventsProcessed: 0,
    marketAssociationsCreated: 0,
    completedOutcomes: 0,
    pendingOutcomes: 0,
    unavailableOutcomes: 0,
    errors: [],
  };
}

// Offline, idempotent event-study job. It deliberately reads existing durable
// events only; it has no dependency on LLMs, news retrieval, Fusion, or any
// numerical forecast/scenario output.
async function backfillEventOutcomes({
  databasePath = DEFAULT_DATABASE_PATH,
  referenceDate = new Date().toISOString(),
  createStore = (options) => new NewsEventStore(options),
  loadWeeklySeries = loadNormalizedWeeklySeries,
  logger = console,
} = {}) {
  const diagnostics = emptyDiagnostics(referenceDate);
  let store;
  try {
    store = createStore({ databasePath });
    const weeklySeries = await loadWeeklySeries();
    for (const event of store.getAllEvents()) {
      diagnostics.eventsProcessed += 1;
      const date = eventDate(event);
      for (const market of MARKETS) {
        if (effectiveMarketRelevance(event, market) <= 0) continue;
        try {
          const association = associateEventPriceOutcomes({
            market,
            eventDate: date,
            weeklySeries,
            referenceDate,
          });
          const write = store.upsertPriceOutcomes(event.eventId, association);
          if (write.inserted > 0) diagnostics.marketAssociationsCreated += 1;
          for (const outcome of association.outcomes) {
            if (outcome.status === "available") diagnostics.completedOutcomes += 1;
            else if (outcome.status === "pending") diagnostics.pendingOutcomes += 1;
            else diagnostics.unavailableOutcomes += 1;
          }
        } catch (error) {
          diagnostics.errors.push({ eventId: event.eventId, market, message: error.message });
          logger.warn("[EventOutcomeBackfill] Association failed:", event.eventId, market, error.message);
        }
      }
    }
    return diagnostics;
  } finally {
    try {
      store?.close();
    } catch (error) {
      diagnostics.errors.push({ eventId: null, market: null, message: `Closing store failed: ${error.message}` });
      logger.warn("[EventOutcomeBackfill] Closing store failed:", error.message);
    }
  }
}

module.exports = { MARKETS, loadNormalizedWeeklySeries, backfillEventOutcomes };

"use strict";

const { DEFAULT_DATABASE_PATH, NewsEventStore } = require("./newsEventStore");
const { associateEventPriceOutcomes } = require("./eventPriceAssociation");
const { loadNormalizedWeeklySeries } = require("./eventOutcomeBackfill");

function emptyDiagnostics(referenceDate) {
  return {
    referenceDate,
    pendingChecked: 0,
    newlyCompleted: 0,
    stillPending: 0,
    newlyUnavailable: 0,
    errors: [],
  };
}

function logSummary(logger, diagnostics) {
  const message = `[EventOutcomePendingRefresh] pending checked=${diagnostics.pendingChecked}, newly completed=${diagnostics.newlyCompleted}, still pending=${diagnostics.stillPending}`;
  if (typeof logger?.info === "function") logger.info(message);
  else if (typeof logger?.log === "function") logger.log(message);
}

function pendingGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.eventId}\u0000${row.market}`;
    if (!groups.has(key)) groups.set(key, { eventId: row.eventId, market: row.market, eventDate: row.eventDate, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

// Lightweight, idempotent maintenance for live/scheduled refreshes. It reads
// only existing pending rows. If none exist it does not load the Excel-derived
// weekly series; completed/unavailable rows are never recalculated or written.
async function refreshPendingEventOutcomes({
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
    const pendingRows = store.getPendingPriceOutcomes();
    diagnostics.pendingChecked = pendingRows.length;
    if (!pendingRows.length) return diagnostics;

    let weeklySeries;
    try {
      weeklySeries = await loadWeeklySeries();
    } catch (error) {
      diagnostics.stillPending = pendingRows.length;
      diagnostics.errors.push({ eventId: null, market: null, message: `Loading weekly prices failed: ${error.message}` });
      logger.warn("[EventOutcomePendingRefresh] Loading weekly prices failed; continuing refresh:", error.message);
      return diagnostics;
    }

    for (const group of pendingGroups(pendingRows)) {
      try {
        const association = associateEventPriceOutcomes({
          market: group.market,
          eventDate: group.eventDate,
          weeklySeries,
          referenceDate,
          horizons: group.rows.map((row) => row.horizonWeeks),
        });
        const pendingHorizons = new Set(group.rows.map((row) => row.horizonWeeks));
        const outcomesByHorizon = new Map(association.outcomes.map((outcome) => [outcome.horizonWeeks, outcome]));
        const resolved = [];
        for (const horizonWeeks of pendingHorizons) {
          const outcome = outcomesByHorizon.get(horizonWeeks);
          if (!outcome || outcome.status === "pending") diagnostics.stillPending += 1;
          else resolved.push(outcome);
        }
        if (!resolved.length) continue;

        const write = store.updatePendingPriceOutcomes(group.eventId, { ...association, outcomes: resolved });
        if (write.updated !== resolved.length) {
          diagnostics.errors.push({
            eventId: group.eventId,
            market: group.market,
            message: `Expected ${resolved.length} pending rows to update, updated ${write.updated}`,
          });
          diagnostics.stillPending += resolved.length - write.updated;
          continue;
        }
        for (const outcome of resolved) {
          if (outcome.status === "available") diagnostics.newlyCompleted += 1;
          else diagnostics.newlyUnavailable += 1;
        }
      } catch (error) {
        diagnostics.stillPending += group.rows.length;
        diagnostics.errors.push({ eventId: group.eventId, market: group.market, message: error.message });
        logger.warn("[EventOutcomePendingRefresh] Pending association failed; continuing refresh:", group.eventId, group.market, error.message);
      }
    }
    return diagnostics;
  } catch (error) {
    diagnostics.errors.push({ eventId: null, market: null, message: error.message });
    logger.warn("[EventOutcomePendingRefresh] Pending outcome check failed; continuing refresh:", error.message);
    return diagnostics;
  } finally {
    try {
      store?.close();
    } catch (error) {
      diagnostics.errors.push({ eventId: null, market: null, message: `Closing store failed: ${error.message}` });
      logger.warn("[EventOutcomePendingRefresh] Closing store failed; continuing refresh:", error.message);
    }
    logSummary(logger, diagnostics);
  }
}

module.exports = { emptyDiagnostics, pendingGroups, refreshPendingEventOutcomes };

"use strict";

const { NewsEventStore } = require("./newsEventStore");

// An additive, best-effort side effect: callers invoke this only after
// classification, deterministic validation and event deduplication. A local
// database problem must never interrupt the forecasting or news refresh path.
function persistValidatedEvents(eventEvidence, representatives, {
  databasePath,
  createStore = (options) => new NewsEventStore(options),
  logger = console,
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const write = store.upsertMany(eventEvidence, representatives);
    const result = {
      ok: true,
      eventsWritten: write.inserted,
      eventsUpdated: write.updated,
      storedEventCount: write.totalEvents,
    };
    logger.info("[NewsEventStore] Refresh persistence:", JSON.stringify(result));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      eventsWritten: 0,
      eventsUpdated: 0,
      storedEventCount: null,
    };
    logger.warn("[NewsEventStore] Persistence failed; continuing refresh:", error.message);
    return result;
  } finally {
    try {
      store?.close();
    } catch (error) {
      logger.warn("[NewsEventStore] Closing store failed; continuing refresh:", error.message);
    }
  }
}

module.exports = { persistValidatedEvents };

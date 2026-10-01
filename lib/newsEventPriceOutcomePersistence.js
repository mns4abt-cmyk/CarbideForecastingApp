"use strict";

const { NewsEventStore } = require("./newsEventStore");

// Best-effort, additive persistence for a separately calculated event-price
// association. It deliberately does not call forecasting, news retrieval, or
// classification, and a local SQLite issue must never interrupt a refresh.
function persistEventPriceOutcomes(eventId, association, {
  databasePath,
  createStore = (options) => new NewsEventStore(options),
  logger = console,
} = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    const write = store.upsertPriceOutcomes(eventId, association);
    const result = { ok: true, ...write };
    logger.info("[NewsEventPriceOutcomes] Persistence:", JSON.stringify(result));
    return result;
  } catch (error) {
    const result = { ok: false, inserted: 0, updated: 0, totalOutcomes: null };
    logger.warn("[NewsEventPriceOutcomes] Persistence failed; continuing refresh:", error.message);
    return result;
  } finally {
    try {
      store?.close();
    } catch (error) {
      logger.warn("[NewsEventPriceOutcomes] Closing store failed; continuing refresh:", error.message);
    }
  }
}

module.exports = { persistEventPriceOutcomes };

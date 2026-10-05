"use strict";

const { NewsEventStore } = require("./newsEventStore");
const { tagStrategicEvent, STRATEGIC_TAGGING_VERSION } = require("./strategicMarketTagging");

// Reuse merged, durable provenance for both refresh tagging and historical
// backfill. Empty arrays are persisted too, distinguishing tagged from missing.
function persistStrategicTags(store, eventKeys = null, logger = console) {
  let processed = 0;
  let changed = 0;
  try {
    for (const event of store.getEventsForStrategicTagging(eventKeys)) {
      changed += store.upsertStrategicTags(event.eventKey, tagStrategicEvent(event), STRATEGIC_TAGGING_VERSION);
      processed += 1;
    }
    return { ok: true, processed, changed };
  } catch {
    logger.warn("[StrategicTags] Tag persistence unavailable; saved news remains usable.");
    return { ok: false, processed, changed };
  }
}

function backfillStrategicTags({ databasePath, createStore = (options) => new NewsEventStore(options), logger = console } = {}) {
  let store;
  try {
    store = createStore({ databasePath });
    return persistStrategicTags(store, null, logger);
  } catch {
    logger.warn("[StrategicTags] Backfill unavailable; existing events unchanged.");
    return { ok: false, processed: 0, changed: 0 };
  } finally {
    try { store?.close(); } catch {
      logger.warn("[StrategicTags] Could not close backfill store.");
    }
  }
}

module.exports = { persistStrategicTags, backfillStrategicTags };

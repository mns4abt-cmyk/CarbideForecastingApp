"use strict";

const { queryStrategicMarketIntelligence } = require("./strategicMarketIntelligence");
const { loadStrategicEntities, confirmedEntities } = require("./strategicEntities");

// Presentation adapter only: no forecast/event data enters this function.
function loadStrategicMarketIntelligence({
  databasePath, referenceTime = new Date().toISOString(),
  query = queryStrategicMarketIntelligence,
  configuration,
} = {}) {
  const methodology = {
    source: "validated_persisted_news_events",
    additionalLlmCalls: false,
    numericalForecastAdjustmentApplied: false,
  };
  let entityDefinitions = [];
  try {
    const config = configuration || loadStrategicEntities();
    entityDefinitions = confirmedEntities(config).map(({ id, apiKey, displayName }) => ({ id, apiKey, displayName }));
    const result = query({ databasePath, referenceTime, windowDays: 30, configuration: config });
    const entities = Object.fromEntries(result.entities.map(view => [view.id, view]));
    const topics = Object.fromEntries(result.topics.map(view => [view.id, view]));
    return {
      status: result.status,
      windowDays: result.windowDays,
      referenceTime: result.referenceTime,
      entities: Object.fromEntries(entityDefinitions.map(({ id, apiKey }) => [apiKey, entities[id]])),
      entityDefinitions,
      topics: { chinaTcOperators: topics.china_tc_operators, exportControls: topics.export_controls },
      methodology,
    };
  } catch {
    // Unexpected query/adapter failures must not fail the surrounding refresh.
    // Do not expose raw errors or invent zero counts for unreadable history.
    return { status: "unavailable", windowDays: 30, referenceTime,
      entities: {}, topics: {}, entityDefinitions, methodology };
  }
}

module.exports = { loadStrategicMarketIntelligence };

"use strict";

function section(data) {
  if (data == null) return { status: "unavailable", data: null };
  return { status: data.available === false ? "unavailable" : data.status || "available", data };
}

function keyEvents(strategic, start, end, limit) {
  const result = {
    status: "unavailable",
    source: "strategicMarketIntelligence.latestEvents",
    selection: "newest_first",
    limit,
    availableEventCount: null,
    events: [],
  };
  if (strategic?.status !== "available") return result;
  const candidates = [...Object.values(strategic.entities || {}), ...Object.values(strategic.topics || {})]
    .filter(view => view?.status === "available" || view?.status === "no_matching_events")
    .flatMap(view => Array.isArray(view.latestEvents) ? view.latestEvents : []);
  const byKey = new Map();
  for (const event of candidates) {
    if (typeof event?.eventKey !== "string" || !event.eventKey.trim()) continue;
    const timestamp = [event.date, event.publishedAt, event.firstSeenAt]
      .map(value => typeof value === "string" ? Date.parse(value) : NaN).find(Number.isFinite);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
    // Deterministic first occurrence wins for overlapping entity/topic views.
    // Never merge text, infer identities from titles or deduplicate by eventId.
    if (!byKey.has(event.eventKey)) byKey.set(event.eventKey, { event, timestamp });
  }
  const ordered = [...byKey.values()].sort((a, b) => b.timestamp - a.timestamp
    || (a.event.eventKey < b.event.eventKey ? -1 : a.event.eventKey > b.event.eventKey ? 1 : 0));
  return { ...result, status: ordered.length ? "available" : "empty",
    availableEventCount: ordered.length, events: ordered.slice(0, limit).map(item => item.event) };
}

/**
 * Pure report assembly from JSON-compatible backend outputs. No clock, I/O,
 * model calls, interpretation or numerical recalculation. Supply generatedAt
 * explicitly or via refresh.generatedAt. Returned data is detached from inputs.
 *
 * The reporting window filters only the key-event list. Other layers retain
 * their original upstream windows/statuses unchanged (not recomputed here).
 * Key-event coverage is the supplied strategic views, not all market news.
 * Reliability is copied only from optional Python pipeline metadata; never
 * inferred from Evidence Fusion corroboration or news sentiment.
 */
function buildStandardMarketReport({
  refresh = {}, pipelineResult = null, generatedAt = refresh.generatedAt,
  reportingWindowDays = 30, maxKeyEvents = 10,
} = {}) {
  const end = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
  const start = end - reportingWindowDays * 86400000;
  if (!Number.isFinite(end) || !Number.isInteger(reportingWindowDays) || reportingWindowDays < 1
    || !Number.isFinite(start) || Math.abs(start) > 8.64e15) {
    throw new RangeError("Supply a valid generatedAt timestamp and positive integer reportingWindowDays");
  }
  if (!Number.isInteger(maxKeyEvents) || maxKeyEvents < 1) throw new RangeError("maxKeyEvents must be a positive integer");
  const scenarios = Array.isArray(refresh.scenarios) ? refresh.scenarios : null;
  const reliability = {};
  const forecastMetadata = {};
  for (const market of ["china", "eu"]) {
    const metadata = pipelineResult?.[market];
    reliability[market] = section(metadata?.reliability);
    forecastMetadata[market] = metadata ? {
      selected_model: metadata.selected_model ?? null,
      transformation: metadata.transformation ?? null,
      last_observed: metadata.last_observed ?? null,
      forecast_horizons: metadata.forecast_horizons ?? null,
    } : null;
  }
  return structuredClone({
    schemaVersion: "standard-market-report-v1",
    generatedAt: new Date(end).toISOString(),
    reportingWindowDays,
    reportingWindow: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    marketStatus: {
      baseline: section(refresh.baseline),
      baselineScenario: section(scenarios?.find(item => item.id === "base")),
      forecastLabels: refresh.forecastLabels ?? null,
      reliability,
      forecastMetadata,
    },
    newsLage: section(refresh.newsLage),
    strategicMarketIntelligence: section(refresh.strategicMarketIntelligence),
    keyValidatedEvents: keyEvents(refresh.strategicMarketIntelligence, start, end, maxKeyEvents),
    evidenceCheck: section(refresh.evidenceFusion),
    stressScenarios: section(scenarios?.filter(item => item.kind === "stress_test"
      && item.id !== "currentMarket" && item.id !== "base")),
  });
}

module.exports = { buildStandardMarketReport };

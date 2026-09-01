"use strict";

/**
 * Aggregiert bereits klassifizierte News (siehe server.js validateNewsClassification) zu einem
 * beschränkten Marktsignal (marketState) je Region und Kategorie.
 *
 * Reine Signal-Aggregationslogik - KEIN HTML/Rendering, KEINE Preis-Prozentsätze, KEINE
 * Prognosezeitreihen. marketState darf aktuell NICHT verwendet werden, um numerische
 * Preisszenarien zu verändern (siehe server.js /api/refresh).
 *
 * Erwartetes Item-Format (pro News-Artikel):
 *   {
 *     date: "YYYY-MM-DD" | ISO-String,
 *     category: "supply"|"demand"|"regulation"|"geopolitics"|"technology"|"macro"|"other",
 *     direction: "bullish"|"bearish"|"neutral",   // alternativ: "sentiment" (gleiche Werte)
 *     severity: 0.0-1.0,
 *     confidence: 0.0-1.0,
 *     chinaRelevance: 0.0-1.0,
 *     euRelevance: 0.0-1.0,
 *   }
 */

const DIRECTION_VALUES = { bullish: 1, bearish: -1, neutral: 0 };
const CATEGORIES = ["supply", "demand", "regulation", "geopolitics", "technology", "macro"];
const REGIONS = ["china", "eu"];
const DEFAULT_HALF_LIFE_DAYS = 14;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function clampSigned(value) {
  return Math.min(1, Math.max(-1, value));
}

function directionValue(item) {
  const raw = item.direction != null ? item.direction : item.sentiment;
  return DIRECTION_VALUES[raw] ?? 0;
}

function ageDaysOf(item, now) {
  const published = new Date(item.date);
  if (Number.isNaN(published.getTime())) return 0;
  return Math.max(0, (now.getTime() - published.getTime()) / MS_PER_DAY);
}

// Exponentieller Zerfall mit konfigurierbarer Halbwertszeit: Gewicht halbiert sich alle
// `halfLifeDays` Tage. Ältere News werden dadurch automatisch stetig weniger einflussreich,
// ohne einen willkürlichen harten Cutoff.
function freshnessWeight(item, now, halfLifeDays) {
  const ageDays = ageDaysOf(item, now);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function regionalRelevance(item, region) {
  const value = region === "china" ? item.chinaRelevance : item.euRelevance;
  return clamp01(value, 0.5);
}

/**
 * Signierter Beitrag eines einzelnen News-Items für eine Region:
 *   direction * severity * confidence * regionalRelevance * freshnessWeight
 * Jeder Faktor liegt in [0,1] (direction in {-1,0,1}), daher liegt das Ergebnis immer in [-1,1].
 */
function computeContribution(item, region, options = {}) {
  const now = options.now || new Date();
  const halfLifeDays = options.halfLifeDays || DEFAULT_HALF_LIFE_DAYS;

  const severity = clamp01(item.severity);
  const confidence = clamp01(item.confidence);
  const relevance = regionalRelevance(item, region);
  const weight = freshnessWeight(item, now, halfLifeDays);

  return clampSigned(directionValue(item) * severity * confidence * relevance * weight);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Berechnet marketState = { china: {supply,demand,regulation,geopolitics,technology,macro,overall}, eu: {...} }
 * aus einer Liste klassifizierter News-Items. Jede Region/Kategorie-Kombination ist der Mittelwert
 * der Einzelbeiträge (Mittelwert bereits [-1,1]-beschränkter Werte bleibt in [-1,1]); fehlen Items
 * für eine Kategorie, ist der Score 0 (neutral, keine Daten).
 */
function aggregateMarketState(newsItems, options = {}) {
  const now = options.now || new Date();
  const halfLifeDays = options.halfLifeDays || DEFAULT_HALF_LIFE_DAYS;
  const items = Array.isArray(newsItems) ? newsItems : [];

  const result = {};
  for (const region of REGIONS) {
    const contributions = items.map((item) => ({
      category: item.category,
      value: computeContribution(item, region, { now, halfLifeDays }),
    }));

    const regionScores = { overall: clampSigned(average(contributions.map((c) => c.value))) };
    for (const category of CATEGORIES) {
      const bucket = contributions.filter((c) => c.category === category).map((c) => c.value);
      regionScores[category] = clampSigned(average(bucket));
    }
    result[region] = regionScores;
  }
  return result;
}

module.exports = {
  DEFAULT_HALF_LIFE_DAYS,
  CATEGORIES,
  REGIONS,
  directionValue,
  freshnessWeight,
  computeContribution,
  aggregateMarketState,
};

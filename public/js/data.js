/**
 * Datenmodell für die Wolfram-Carbide Preisprognose.
 *
 * WICHTIG: Die Preisreihen sind illustrative Modelldaten (USD/kg WO₃-Gehalt),
 * die die real beobachtete Marktdynamik (u.a. China-Exportkontrollen 2025) nachbilden.
 * Die Struktur ist so aufgebaut, dass HISTORY perspektivisch durch einen echten
 * Marktdaten-Feed (z.B. Fastmarkets/Argus API) ersetzt werden kann, ohne den Rest
 * der Anwendung anzupassen.
 *
 * UMD-Muster: Diese Datei funktioniert unverändert sowohl als <script> im Browser
 * (hängt sich an window.CarbideData) als auch per require() in Node.js (server.js),
 * damit Frontend und Backend exakt dieselbe Berechnungslogik verwenden.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CarbideData = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
// ---- Zeitachse -------------------------------------------------------
const MONTH_NAMES = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function buildMonthLabels(startYear, startMonthIndex, count) {
  const labels = [];
  let y = startYear, m = startMonthIndex;
  for (let i = 0; i < count; i++) {
    labels.push(`${MONTH_NAMES[m]} ${String(y).slice(2)}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return labels;
}

// 24 Monate Historie: Sep 2024 – Aug 2026
const HISTORY_LABELS = buildMonthLabels(2024, 8, 24);
// 12 Monate Prognose: Sep 2026 – Aug 2027
const FORECAST_LABELS = buildMonthLabels(2026, 8, 12);

// ---- Historische Preisbasis China (USD/kg WO3-Gehalt) ---------------------------
// Skaliert auf reale Marktbenchmarks (Stand Aug 2026): China-APT ca. $1.008-1.025/mtu
// (≈ $100,8-102,5/kg), abgeleitet aus Yn600.000-610.000/Tonne. Bildet den realen
// Rally-Verlauf 2024/2025 nach (Exportkontroll-Schock Feb 2025), skaliert auf das aktuelle Niveau.
const CHINA_HISTORY = [
  73.0, 74.2, 75.5, 76.8, 78.7, 85.0, 90.4, 92.6, 91.4, 93.6, 95.2, 96.7,
  94.5, 95.8, 97.7, 99.0, 99.9, 98.3, 100.2, 100.9, 99.6, 101.2, 102.1, 101.5,
];

// EU-Importaufschlag gegenüber China (Faktor), weitet sich nach dem Exportkontroll-Schock stark aus.
// Reale Benchmark (Aug 2026): EU-APT ca. $3.000-3.279/mtu, also ca. das 3-fache des China-Preises
// (strukturelle Exportbeschränkungen + knappes Angebot außerhalb Chinas) - vor dem Schock war die
// EU-Prämie moderat (~10%).
const EU_PREMIUM_HISTORY = [
  1.10, 1.10, 1.10, 1.10, 1.10, 1.35, 1.55, 1.75, 1.95, 2.15, 2.35, 2.50,
  2.60, 2.70, 2.80, 2.85, 2.90, 2.95, 2.98, 3.00, 3.02, 3.03, 3.04, 3.05,
];

const EU_HISTORY = CHINA_HISTORY.map((v, i) => Math.round(v * EU_PREMIUM_HISTORY[i] * 10) / 10);

const LAST_CHINA = CHINA_HISTORY[CHINA_HISTORY.length - 1]; // ~101.5
const LAST_EU = EU_HISTORY[EU_HISTORY.length - 1]; // ~309.6

// ---- Basis-Fortschreibung (leichter Aufwärtsdrift + Saisonalität) -----
function baseTrend(lastValue, months) {
  const out = [];
  let v = lastValue;
  for (let i = 1; i <= months; i++) {
    const drift = 0.003; // +0,3%/Monat
    const seasonal = Math.sin((i / 12) * Math.PI * 2) * 0.006; // +-0.6% Wellenbewegung
    v = v * (1 + drift + seasonal);
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}

const BASE_CHINA_FORECAST = baseTrend(LAST_CHINA, 12);
const BASE_EU_FORECAST = baseTrend(LAST_EU, 12);

// ---- Szenario-Definitionen --------------------------------------------
// Jedes Szenario liefert eine kumulative prozentuale Abweichung je Monat
// gegenüber der Basis-Fortschreibung, getrennt für China und EU.
const SCENARIOS = [
  {
    id: "base",
    name: "Basisszenario",
    shortName: "Basis",
    color: "#6b7789",
    sentiment: "neutral",
    alwaysOn: true,
    summary: "Fortführung des aktuellen Trends mit moderatem Aufwärtsdrift (~0,3%/Monat) und leichter Saisonalität, ohne größere Angebots- oder Nachfrageschocks.",
    expectedChange12m: { china: null, eu: null }, // wird berechnet
    deltaFn: () => ({ china: 0, eu: 0 }), // keine Abweichung von der Basisfortschreibung
  },
  {
    id: "supplyShock",
    name: "Angebotsverknappung China (Exportkontrollen / Minenschließungen)",
    shortName: "Angebotsschock",
    color: "#d1495b",
    sentiment: "bullish",
    summary: "Verschärfte chinesische Exportlizenzpflichten, Förderkürzungen und Lagerhaltung außerhalb Chinas verknappen das Weltmarktangebot spürbar. EU-Aufschlag weitet sich zusätzlich aus.",
    deltaFn: (m) => ({
      china: 1.2 * m,          // kumulative % pro Monat
      eu: 1.6 * m,              // EU reagiert stärker (Lizenz-Engpass, Fracht/Diversifizierung)
    }),
  },
  {
    id: "demandSlowdown",
    name: "Globale Nachfrageabschwächung",
    shortName: "Nachfrage schwach",
    color: "#2a9d8f",
    sentiment: "bearish",
    summary: "Schwache Industriekonjunktur (PMI-Daten), steigende Recyclingquoten und Lagerabbau bei Verarbeitern dämpfen die Nachfrage in beiden Regionen.",
    deltaFn: (m) => ({
      china: -0.8 * m,
      eu: -0.6 * m, // EU etwas robuster wegen strategischer Lagerhaltung
    }),
  },
  {
    id: "demandSurge",
    name: "Grüne-Tech- & Rüstungsnachfrage steigt",
    shortName: "Tech/Rüstung",
    color: "#e08e2f",
    sentiment: "bullish",
    summary: "Höhere Rüstungsausgaben, Halbleiter- und Energiewende-Investitionen erhöhen den Bedarf an verschleißfesten Hartmetallwerkzeugen.",
    deltaFn: (m) => ({
      china: 0.45 * m,
      eu: 0.55 * m,
    }),
  },
  {
    id: "euRegulation",
    name: "EU-Regulatorik (Critical Raw Materials Act, Vorratspflicht, Zölle)",
    shortName: "EU-Regulatorik",
    color: "#7b52ab",
    sentiment: "bullish-eu",
    summary: "Einstufung als kritischer Rohstoff, Vorratshaltungspflichten und mögliche Zölle auf chinesische Importe erhöhen gezielt die Kosten für europäische Abnehmer, während China kaum betroffen ist.",
    deltaFn: (m) => ({
      china: 0.08 * m,
      eu: 0.9 * m,
    }),
  },
];

// Serien je Szenario berechnen.
// Nimmt optional eine ECHTE Basis-Fortschreibung (z.B. die p50-Modellprognose aus
// forecasting/pipeline.py) samt letzten realen Beobachtungswerten entgegen. Ohne
// Argumente (z.B. beim ersten Laden im Browser, bevor /api/refresh geantwortet hat)
// wird auf die illustrative interne Fortschreibung zurückgefallen, damit die Seite
// sofort etwas anzeigen kann.
function computeScenarioSeries(baseChina, baseEu, lastChina, lastEu) {
  const chinaBase = baseChina || BASE_CHINA_FORECAST;
  const euBase = baseEu || BASE_EU_FORECAST;
  const refChina = lastChina != null ? lastChina : LAST_CHINA;
  const refEu = lastEu != null ? lastEu : LAST_EU;
  const horizon = chinaBase.length;

  return SCENARIOS.map((sc) => {
    const chinaSeries = [];
    const euSeries = [];
    for (let i = 1; i <= horizon; i++) {
      const delta = sc.deltaFn(i);
      chinaSeries.push(Math.round(chinaBase[i - 1] * (1 + delta.china / 100) * 10) / 10);
      euSeries.push(Math.round(euBase[i - 1] * (1 + delta.eu / 100) * 10) / 10);
    }
    const changeChina = Math.round(((chinaSeries[horizon - 1] - refChina) / refChina) * 1000) / 10;
    const changeEu = Math.round(((euSeries[horizon - 1] - refEu) / refEu) * 1000) / 10;
    return { ...sc, china: chinaSeries, eu: euSeries, expectedChange12m: { china: changeChina, eu: changeEu } };
  });
}

const SCENARIO_SERIES = computeScenarioSeries();

// ---- Voices of the Market: News-Feed -----------------------------------
// Es gibt keine fiktiven/Dummy-Einträge mehr. Die App zeigt ausschließlich echte,
// live per Google-News-RSS abgerufene Artikel an (siehe server.js: fetchRealNews()).
// Dieses leere Array dient nur als Startzustand, bevor der erste Abruf abgeschlossen ist,
// und als Typ-/Strukturreferenz für Frontend und Backend.
const NEWS = [];

// ---- Export -------------------------------------------------------------
return {
  HISTORY_LABELS,
  FORECAST_LABELS,
  CHINA_HISTORY,
  EU_HISTORY,
  LAST_CHINA,
  LAST_EU,
  SCENARIOS: SCENARIO_SERIES,
  NEWS,
  BASELINE: null, // erst nach /api/refresh verfügbar (echtes p10/p50/p90 aus forecasting/pipeline.py)
  computeScenarioSeries,
};

}); // Ende UMD-Factory

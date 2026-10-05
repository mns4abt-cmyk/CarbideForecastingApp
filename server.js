/**
 * Backend für den Wolfram-Carbide Marktradar.
 *
 * Aufgaben:
 *  1. Liefert das statische Frontend aus (public/) über express.static.
 *  2. Stellt POST /api/refresh bereit: berechnet die Szenario-Prognosen neu und
 *     lässt optional über die Bosch Model Farm (BMF) – ein internes LLM-Gateway –
 *     aktualisierte, sachliche Szenario-Einschätzungen auf Basis der aktuellen
 *     "Voices of the Market"-News generieren.
 *
 * Sicherheit:
 *  - Der BMF-API-Key wird ausschließlich serverseitig aus .env gelesen und NIE an
 *    den Browser weitergereicht (weder im Response-Body noch in Logs).
 *  - .env ist in .gitignore eingetragen und darf nicht committet werden.
 *  - Anfragen an BMF laufen mit Timeout (AbortController), Fehler werden nur
 *    generisch an den Client zurückgegeben, Details landen ausschließlich im
 *    Server-Log.
 */

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// .env immer aus dem Ordner laden, in dem die Anwendung tatsächlich liegt - NICHT aus dem
// aktuellen Arbeitsverzeichnis (process.cwd() kann z.B. beim Start per Doppelklick oder aus
// einem anderen Ordner abweichen). Bei einer mit pkg gebauten eigenständigen .exe liegt der
// Code in einem virtuellen Snapshot, daher wird in diesem Fall der Ordner der .exe selbst
// verwendet (process.execPath) - so funktioniert eine .env direkt neben der .exe bei Kollegen.
const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;
require("dotenv").config({ path: path.join(appDir, ".env") });

const express = require("express");
// fetch + ProxyAgent MÜSSEN aus demselben "undici"-Paket kommen wie der Dispatcher,
// sonst gibt es einen Versions-Mismatch mit Node's internem fetch ("invalid onRequestStart method").
const { fetch, ProxyAgent } = require("undici");
const { aggregateMarketState } = require("./lib/newsSignals");
const { fetchConfiguredNewsSources } = require("./lib/newsSources");
const { createNewsTransport } = require("./lib/newsTransport");
const { filterArticlesByRelevance } = require("./lib/newsRelevance");
const { classifySequentialBatches, createNewsClassifierProvider, selectArticlesForClassification } = require("./lib/newsClassifierProviders");
const { validateNewsClassification } = require("./lib/newsClassificationValidation");
const { normalizeCausalClassification, normalizeGlobalRelevance } = require("./lib/newsCausality");
const { deduplicateEvents } = require("./lib/newsEventDedup");
const { buildEventEvidence } = require("./lib/newsEventEvidence");
const { persistValidatedEvents } = require("./lib/newsEventPersistence");
const { loadNewsLageV2 } = require("./lib/newsLageV2");
const { loadStrategicMarketIntelligence } = require("./lib/strategicMarketIntelligenceIntegration");
const { loadHistoricalEventOutcomeAssociations } = require("./lib/eventOutcomeAggregation");
const { refreshPendingEventOutcomes } = require("./lib/eventOutcomePendingRefresh");
const { NewsClassificationCache } = require("./lib/newsClassificationCache");
const { buildEvidenceFusionDiagnostics } = require("./lib/evidenceFusionIntegration");
const { resolvePythonInterpreter } = require("./lib/pythonResolver");
const { deriveClassificationStatus } = require("./lib/aiRefreshStatus");
const { getOllamaRuntimeConfig } = require("./lib/ollamaRuntimeConfig");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const BMF_BASE_URL = (process.env.BMF_BASE_URL || "").replace(/\/+$/, "");
const BMF_API_KEY = process.env.BMF_API_KEY || "";
const BMF_MODEL = process.env.BMF_MODEL || "";
const BMF_API_VERSION = process.env.BMF_API_VERSION || "2025-04-01-preview";
// "subscription-key" = Header "genaiplatform-farm-subscription-key: <key>" (laut BMF-Welcome-Mail).
// "apikey" = Header "api-key: <key>" (Azure-OpenAI-Stil). "bearer" = "Authorization: Bearer <key>".
const BMF_AUTH_STYLE = (process.env.BMF_AUTH_STYLE || "subscription-key").toLowerCase();
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:4b";
const MAX_LLM_ARTICLES = Math.min(12, Math.max(1, Number(process.env.MAX_LLM_ARTICLES) || 12));
const { batchSize: OLLAMA_BATCH_SIZE, timeoutMs: OLLAMA_TIMEOUT_MS } = getOllamaRuntimeConfig();
const CLASSIFICATION_SCHEMA_VERSION = "causal-v3";

// Firmenproxy: Node's fetch nutzt HTTP_PROXY/HTTPS_PROXY NICHT automatisch, daher explizit über undici ProxyAgent.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const newsTransport = createNewsTransport({ fetch, dispatcher: proxyDispatcher });
const NEWS_SOURCES_CONFIG = JSON.parse(fs.readFileSync(path.join(appDir, "config", "news-sources.json"), "utf8"));
const newsClassifier = createNewsClassifierProvider({
  providerId: LLM_PROVIDER,
  fetch,
  // Ollama is local-only and must never receive the corporate proxy dispatcher.
  dispatcher: LLM_PROVIDER === "bmf" ? proxyDispatcher : undefined,
  baseUrl: LLM_PROVIDER === "bmf" ? BMF_BASE_URL : OLLAMA_BASE_URL,
  apiKey: BMF_API_KEY,
  model: LLM_PROVIDER === "bmf" ? BMF_MODEL : OLLAMA_MODEL,
  apiVersion: BMF_API_VERSION,
  authStyle: BMF_AUTH_STYLE,
  timeoutMs: LLM_PROVIDER === "ollama" ? OLLAMA_TIMEOUT_MS : 75000,
});
const classificationCache = new NewsClassificationCache({
  directory: path.join(appDir, ".cache"),
  model: LLM_PROVIDER === "bmf" ? BMF_MODEL : OLLAMA_MODEL,
  schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
});

// ---- Python-Forecasting-Pipeline (echte Excel-Daten + Backtest-Modellauswahl) ------------
// The interpreter is resolved and minimally probed cross-platform before each
// refresh; FORECAST_PYTHON remains the explicit first-choice override.
const FORECAST_SCRIPT = path.join(appDir, "forecasting", "pipeline.py");
const SCENARIOS_SCRIPT = path.join(appDir, "forecasting", "scenarios.py");
const FORECAST_TIMEOUT_MS = Number(process.env.FORECAST_TIMEOUT_MS) || 120000;

// Deutsche Monatskürzel wie in public/js/data.js (buildMonthLabels), damit "YYYY-MM"-Strings
// aus Python exakt im bisherigen Anzeigeformat erscheinen ("Sep 26" statt lokalisiertem "Sept.").
const MONTH_NAMES_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
function formatMonthLabel(isoMonth) {
  const [year, month] = isoMonth.split("-").map(Number);
  return `${MONTH_NAMES_DE[month - 1]} ${String(year).slice(2)}`;
}

// Ruft "python forecasting/pipeline.py --json" per execFile auf (KEINE Shell, KEINE
// String-Konkatenation eines Kommandos - Argumente werden als Array übergeben). Liefert das
// vom Python-Skript auf stdout geschriebene JSON (build_frontend_payload); Python-Logging
// geht laut Skript-Konvention ausschließlich an stderr.
async function runForecastingPipeline() {
  const interpreter = await resolvePythonInterpreter({ appDir });
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      interpreter.command,
      [...interpreter.argsPrefix, FORECAST_SCRIPT, "--json"],
      { cwd: appDir, timeout: FORECAST_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }
    ));
  } catch (err) {
    if (err.killed || err.signal === "SIGTERM") {
      throw new Error(`Forecasting-Pipeline hat das Zeitlimit von ${FORECAST_TIMEOUT_MS}ms überschritten.`);
    }
    const detail = (err.stderr || err.message || "").toString().trim().slice(0, 500);
    throw new Error(`Forecasting-Pipeline (forecasting/pipeline.py) fehlgeschlagen: ${detail}`);
  }

  if (stderr && stderr.trim()) {
    // Erwartetes Python-Logging (stderr) - nur zu Diagnosezwecken protokollieren, kein Fehler.
    console.log("[forecasting/pipeline.py]", stderr.trim());
  }

  try {
    return { pipelineResult: JSON.parse(stdout), interpreter };
  } catch (err) {
    throw new Error("Forecasting-Pipeline hat kein valides JSON auf stdout geliefert.");
  }
}

// Ruft "python forecasting/scenarios.py --current-market --json" auf, um das dynamische,
// newsgesteuerte "currentMarket"-Szenario ("Aktuelle Marktlage") zu berechnen. china_/euScore
// sind AUSSCHLIESSLICH marketState.china.overall / marketState.eu.overall (deterministisch aus
// lib/newsSignals.js) - an keiner Stelle fließt ein vom LLM erzeugter Preiswert ein. Läuft als
// eigenständiger Python-Aufruf (eigener Backtest/Fit) NACH der News-/KI-Verarbeitung, da
// marketState erst zu diesem Zeitpunkt bekannt ist.
async function runCurrentMarketScenario(chinaScore, euScore, available, interpreter) {
  const args = [
    SCENARIOS_SCRIPT,
    "--current-market",
    "--china-score", String(chinaScore),
    "--eu-score", String(euScore),
    "--json",
  ];
  if (!available) args.push("--unavailable");

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      interpreter.command,
      [...interpreter.argsPrefix, ...args],
      { cwd: appDir, timeout: FORECAST_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }
    ));
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().trim().slice(0, 500);
    throw new Error(`Aktuelle-Marktlage-Szenario (forecasting/scenarios.py) fehlgeschlagen: ${detail}`);
  }

  if (stderr && stderr.trim()) {
    console.log("[forecasting/scenarios.py]", stderr.trim());
  }

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error("forecasting/scenarios.py hat kein valides JSON auf stdout geliefert.");
  }
}

// ---- Echte News: Source adapter (Google News is the current discovery source) --
// Liefert echte, aktuelle Artikel-Metadaten (Titel, Link, Datum, Quelle). Der Volltext der
// Artikel wird NICHT abgerufen (nur RSS-Snippet) - die KI-Klassifizierung (Kategorie/Sentiment/
// Einschätzung) basiert daher ausschließlich auf Titel + Quelle, nicht auf frei erfundenen Inhalten.
// Neben den preisbezogenen Suchen werden bewusst auch breitere "Overall"-Marktsuchen abgefragt
// (Markt/Industrie/Bergbau, nicht nur "price"), damit auch allgemeine Branchennews auftauchen.
function toIsoDate(pubDate) {
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

async function fetchRealNews(limit) {
  const { articles, health } = await fetchConfiguredNewsSources(
    NEWS_SOURCES_CONFIG,
    { fetch: newsTransport.fetch, transportFor: newsTransport.transportFor },
    { limit }
  );
  const { accepted: relevant, rejected } = filterArticlesByRelevance(articles);
  return {
    news: relevant.map((item, i) => ({
    id: `live-${i + 1}`,
    date: toIsoDate(item.publishedAt),
    title: item.title,
    snippet: item.snippet,
    source: item.source,
    link: item.url,
    real: true,
    // Additive debug fields; the existing frontend fields above remain unchanged.
    relevanceScore: item.relevance.score,
    relevanceReasons: item.relevance.reasons,
    matchedTerms: item.relevance.matchedTerms,
    matchedThemes: item.relevance.matchedThemes,
  })),
    diagnostics: {
      fetchedCount: health.reduce((count, source) => count + (source.fetchedCount || 0), 0),
      deduplicatedCount: articles.length,
      relevantCount: relevant.length,
      rejectedCount: rejected.length,
    },
  };
}

app.get("/api/status", async (req, res) => {
  const ai = await newsClassifier.health();
  res.json({ ok: true, aiConfigured: ai.available, model: ai.model, aiProvider: ai });
});

// ---- Validierung der News-Klassifizierung ------------------------------------------------
// Das LLM liefert AUSSCHLIESSLICH semantische Klassifizierung (siehe buildPrompt) - niemals
// Preise/Kursziele/Prozentänderungen/Zeitreihen. Alle Felder werden serverseitig zusätzlich
// geklemmt/whitelisted, bevor sie das Backend verlassen; bei einer strukturell ungültigen
// Antwort (kein Objekt) wird komplett auf eine neutrale Klassifizierung zurückgefallen.
const NEWS_CATEGORY_LABELS_DE = {
  supply: "Angebot",
  demand: "Nachfrage",
  regulation: "Regulierung",
  geopolitics: "Geopolitik",
  technology: "Technologie",
  macro: "Makro",
  other: "Sonstiges",
};
// Rein deterministische, nicht vom LLM erzeugte Zuordnung Kategorie -> im Chart hervorzuhebende
// Szenarien (nur für die bestehende Klick-Hervorhebung in der UI, keine Preisrelevanz).
function scenariosForClassification(category, direction) {
  if (category === "supply" || category === "geopolitics") return ["supplyShock"];
  if (category === "regulation") return ["euRegulation"];
  if (category === "technology") return ["demandSurge"];
  if (category === "demand") {
    if (direction === "bullish") return ["demandSurge"];
    if (direction === "bearish") return ["demandSlowdown"];
  }
  return [];
}

function applyNewsClassification(newsItem, raw) {
  const validated = validateNewsClassification(raw, newsItem.title);
  const causal = normalizeCausalClassification(validated, newsItem);
  const globalRelevance = normalizeGlobalRelevance(validated.globalRelevance, validated.confidence, causal, newsItem);
  newsItem.category = NEWS_CATEGORY_LABELS_DE[validated.category];
  newsItem.categoryKey = validated.category;
  newsItem.llmDirection = validated.direction;
  newsItem.sentiment = causal.direction;
  newsItem.supplyEffect = causal.supplyEffect;
  newsItem.demandEffect = causal.demandEffect;
  newsItem.eventStage = causal.eventStage;
  newsItem.evidenceMaturity = causal.evidenceMaturity;
  newsItem.causalExtractionCorrected = causal.causalExtractionCorrected;
  newsItem.causalConsistencyCorrected = causal.causalConsistencyCorrected;
  newsItem.summary = validated.summary;
  newsItem.llmImpactExplanation = validated.impactExplanation;
  newsItem.impact = causal.impactExplanation;
  newsItem.scenarios = scenariosForClassification(validated.category, causal.direction);
  newsItem.severity = Math.min(validated.severity, causal.severityCap);
  newsItem.confidence = Math.min(validated.confidence, causal.confidenceCap);
  newsItem.globalRelevance = globalRelevance.globalRelevance;
  newsItem.globalRelevanceCorrected = globalRelevance.globalRelevanceCorrected;
  newsItem.chinaRelevance = validated.chinaRelevance;
  newsItem.euRelevance = validated.euRelevance;
  newsItem.horizonWeeks = validated.horizonWeeks;
  newsItem.aiGenerated = true;
  newsItem.classificationStatus = "classified";
}

// Neutrale Standard-Klassifizierung für echte News, falls keine KI verfügbar ist/fehlschlägt.
function applyFallbackClassification(newsItems) {
  newsItems.forEach((n) => {
    n.category = n.category || "Nicht klassifiziert";
    n.categoryKey = n.categoryKey ?? null;
    n.sentiment = n.sentiment || "neutral";
    n.summary = n.summary || n.title;
    n.impact = n.impact || "Automatisch abgerufen, noch keine KI-Einschätzung verfügbar.";
    n.scenarios = n.scenarios || [];
    n.severity = n.severity ?? 0;
    n.confidence = n.confidence ?? 0;
    n.chinaRelevance = n.chinaRelevance ?? 0.5;
    n.euRelevance = n.euRelevance ?? 0.5;
    n.horizonWeeks = n.horizonWeeks ?? 12;
    n.classificationStatus = n.classificationStatus || "unavailable";
  });
  return newsItems;
}

// ---- Textbaustein für "Aktuelle Marktlage" (currentMarket) --------------------------------
// Rein deterministisch aus bereits validierten/geklemmten Feldern generiert (Kategorie/
// Richtung/Konfidenz je News, marketState-Scores) - KEIN zusätzlicher LLM-Aufruf, KEIN
// erfundener Preiswert. Erklärt Richtung/Treiber/Konfidenz sowie, dass die Größenordnung
// historisch kalibriert (Quantil) statt von der KI numerisch vorgegeben ist.
function directionLabelDe(direction) {
  if (direction === "bullish") return "preistreibend";
  if (direction === "bearish") return "preisdämpfend";
  return "neutral";
}

function buildCurrentMarketSummary({ newsSource, aiEnabled, news, marketState }) {
  if (newsSource !== "live" || !aiEnabled) {
    return (
      "Aktuell keine live abgerufenen bzw. KI-klassifizierten News verfügbar - \"Aktuelle " +
      "Marktlage\" entspricht daher unverändert der Basisprognose. Es wird kein Marktsignal erfunden."
    );
  }

  const relevantNews = news.filter((n) => (n.severity ?? 0) > 0 && (n.confidence ?? 0) > 0);
  const topDrivers = [...relevantNews]
    .sort((a, b) => (b.severity ?? 0) * (b.confidence ?? 0) - (a.severity ?? 0) * (a.confidence ?? 0))
    .slice(0, 3);
  const driverText = topDrivers.length
    ? topDrivers.map((n) => `"${n.title}" (${n.category}, ${directionLabelDe(n.sentiment)})`).join("; ")
    : "keine klar dominierenden Einzelmeldungen";

  const avgConfidence = relevantNews.length
    ? relevantNews.reduce((sum, n) => sum + (n.confidence ?? 0), 0) / relevantNews.length
    : 0;

  const chinaOverall = marketState.china.overall;
  const euOverall = marketState.eu.overall;
  const chinaDir = chinaOverall > 0.02 ? "bullish" : chinaOverall < -0.02 ? "bearish" : "neutral";
  const euDir = euOverall > 0.02 ? "bullish" : euOverall < -0.02 ? "bearish" : "neutral";

  return (
    `Basierend auf aktuell klassifizierten News: China ${directionLabelDe(chinaDir)} ` +
    `(Marktdruck ${Math.abs(chinaOverall).toFixed(2)}), EU ${directionLabelDe(euDir)} ` +
    `(Marktdruck ${Math.abs(euOverall).toFixed(2)}). Wichtigste Treiber: ${driverText}. ` +
    `Durchschnittliche KI-Konfidenz der zugrunde liegenden Klassifizierung: ${Math.round(avgConfidence * 100)}%. ` +
    `Die Größenordnung der Preisabweichung ist historisch kalibriert (Quantil der realen ` +
    `Forward-Return-Verteilung) und wurde NICHT direkt von der KI als Preisprognose vorgegeben; ` +
    `ohne aktuelle/relevante News konvergiert dieses Szenario automatisch zur Basisprognose zurück (Freshness-Decay).`
  );
}

app.post("/api/refresh", async (req, res) => {
  try {
    // Echte Historie + per Backtest gewähltes Modell/p50-Prognose aus forecasting/pipeline.py
    // (Excel-Daten) statt der illustrativen Konstanten aus public/js/data.js.
    let pipelineResult;
    let pythonInterpreter;
    try {
      const forecastRun = await runForecastingPipeline();
      pipelineResult = forecastRun.pipelineResult;
      pythonInterpreter = forecastRun.interpreter;
    } catch (err) {
      console.error("[Forecasting] Pipeline-Aufruf fehlgeschlagen:", err.message);
      return res.status(502).json({
        ok: false,
        error: `Prognose-Pipeline nicht verfügbar: ${err.message}`,
      });
    }

    // Baseline (unveränderte Modell-P50) und feste Stresstests kommen gemeinsam aus
    // forecasting/pipeline.py. Die Stresstests werden in forecasting/scenarios.py aus
    // historischen Forward-Return-Quantilen erzeugt; kein JavaScript-Delta und kein LLM
    // erzeugt numerische Preiswerte.
    const scenarios = pipelineResult.scenarios;
    if (!Array.isArray(scenarios) || !scenarios.length) {
      throw new Error("Forecasting-Pipeline hat keine Szenarien geliefert.");
    }

    // Echte, aktuelle News per Google-News-RSS abrufen (kein API-Key nötig). Es gibt bewusst
    // KEINEN fiktiven Fallback mehr - schlägt der Abruf fehl, bleibt die Liste leer und das
    // Frontend zeigt einen entsprechenden Hinweis an.
    let news;
    let newsSource;
    let newsDiagnostics;
    try {
      const newsResult = await fetchRealNews(20);
      news = newsResult.news;
      newsDiagnostics = newsResult.diagnostics;
      newsDiagnostics.classifiedFresh = 0;
      newsDiagnostics.classifiedFromCache = 0;
      newsSource = news.length ? "live" : "unavailable";
    } catch (err) {
      console.error("[News-RSS] Fehlgeschlagen:", err.message);
      news = [];
      newsDiagnostics = { fetchedCount: 0, deduplicatedCount: 0, relevantCount: 0, rejectedCount: 0 };
      newsDiagnostics.classifiedFresh = 0;
      newsDiagnostics.classifiedFromCache = 0;
      newsSource = "unavailable";
    }

    let aiEnabled = false;
    let aiError = null;
    let aiProvider;
    try {
      aiProvider = await newsClassifier.health();
    } catch {
      aiProvider = {
        provider: newsClassifier.id,
        configured: false,
        reachable: false,
        model: null,
        modelAvailable: false,
        available: false,
        lastSuccessfulCall: null,
      };
    }
    let classificationResult = {
      classifications: new Map(), failedBatches: [], failedBatchDetails: [], batchCount: 0, successfulBatches: 0, durationMs: 0,
    };
    let selectedCount = 0;
    let classifiedFromCache = 0;

    if (newsSource === "live") {
      try {
        const selected = selectArticlesForClassification(news, MAX_LLM_ARTICLES);
        selectedCount = selected.length;
        const classifications = new Map();
        const fresh = [];
        selected.forEach((item) => {
          const cached = classificationCache.get(item);
          if (cached) { classifications.set(item.id, cached); classifiedFromCache++; }
          else fresh.push(item);
        });
        if (fresh.length && aiProvider.available) {
          classificationResult = await classifySequentialBatches(
            newsClassifier,
            fresh,
            newsClassifier.id === "ollama" ? OLLAMA_BATCH_SIZE : MAX_LLM_ARTICLES
          );
        } else if (fresh.length) {
          classificationResult = {
            ...classificationResult,
            batchCount: Math.ceil(fresh.length / (newsClassifier.id === "ollama" ? OLLAMA_BATCH_SIZE : MAX_LLM_ARTICLES)),
          };
        }
        classificationResult.classifications.forEach((classification, id) => {
          classifications.set(id, classification);
          const item = fresh.find((candidate) => candidate.id === id);
          if (item) classificationCache.set(item, classification);
        });
        selected.filter((item) => classifications.has(item.id))
          .forEach((item) => applyNewsClassification(item, classifications.get(item.id)));
        aiEnabled = classifications.size > 0;
        newsDiagnostics.classifiedFresh = classificationResult.classifications.size;
        newsDiagnostics.classifiedFromCache = classifiedFromCache;
        if (classificationResult.failedBatches.length) {
          aiError = classifications.size
            ? "Ein Teil der KI-Klassifizierungen ist aktuell nicht verfügbar."
            : "KI-Kommentierung aktuell nicht verfügbar – zeige modellbasierte Standardtexte.";
        }
      } catch (err) {
        console.error(`[${newsClassifier.id}] Klassifizierung fehlgeschlagen:`, err.message);
        aiError = "KI-Kommentierung aktuell nicht verfügbar – zeige modellbasierte Standardtexte.";
      }
    }

    if (newsSource === "live") applyFallbackClassification(news);

    const classificationStatus = deriveClassificationStatus({
      providerAvailable: aiProvider.available,
      selectedCount,
      classifiedCount: newsDiagnostics.classifiedFresh + classifiedFromCache,
      failedBatches: classificationResult.failedBatches.length,
    });
    if (classificationStatus === "unavailable" && !aiError) {
      aiError = "KI-Kommentierung aktuell nicht verf\u00fcgbar \u2013 zeige modellbasierte Standardtexte.";
    }
    const aiDiagnostic = {
      code: classificationResult.failedBatchDetails[0]?.error?.code || (aiProvider.available ? null : "PROVIDER_UNAVAILABLE"),
      provider: newsClassifier.id,
      model: aiProvider.model,
      providerAvailable: aiProvider.available,
      selectedForLlm: selectedCount,
      freshForLlm: Math.max(0, selectedCount - classifiedFromCache),
      batchCount: classificationResult.batchCount,
      successfulBatches: classificationResult.successfulBatches,
      failedBatches: classificationResult.failedBatchDetails,
      classifiedFresh: newsDiagnostics.classifiedFresh,
      classifiedFromCache,
      failedClassification: Math.max(0, selectedCount - newsDiagnostics.classifiedFresh - classifiedFromCache),
      durationMs: classificationResult.durationMs,
      refreshSucceeded: true,
    };
    if (classificationStatus === "failed" || classificationStatus === "partial" || classificationStatus === "unavailable") {
      console.warn("[AI classification]", JSON.stringify({ stage: "classification", classificationStatus, ...aiDiagnostic }));
    }

    // Keep all article provenance in the response, but count only one representative
    // of a conservatively detected syndicated event as evidence.
    const classifiedEvidence = news.filter((n) => n.classificationStatus === "classified");
    const eventDeduplication = deduplicateEvents(classifiedEvidence);
    const eventEvidence = buildEventEvidence(eventDeduplication.representatives);
    persistValidatedEvents(eventEvidence, eventDeduplication.representatives, {
      databasePath: path.join(appDir, "data", "news-events.db"),
    });
    // Pending-only maintenance: it skips price loading when no pending rows
    // exist and isolates all failures from the forecast/news response.
    await refreshPendingEventOutcomes({
      databasePath: path.join(appDir, "data", "news-events.db"),
    });
    // News-Lage v2 is a read-only description of persisted, validated events
    // across its own 30-day history. Its failure is intentionally isolated from
    // forecasting, Fusion, stress scenarios, and the legacy currentMarket API.
    const newsLage = loadNewsLageV2({
      databasePath: path.join(appDir, "data", "news-events.db"),
    });
    // Separate, additive historical-event study. It reads only persisted
    // completed outcomes and never informs forecast, News-Lage, Fusion, or scenarios.
    const historicalEventAssociations = loadHistoricalEventOutcomeAssociations({
      databasePath: path.join(appDir, "data", "news-events.db"),
    });
    newsDiagnostics.eventRepresentativeCount = eventDeduplication.representatives.length;
    newsDiagnostics.duplicateArticleCount = classifiedEvidence.length - eventDeduplication.representatives.length;

    // Additive, read-only diagnostic metadata. Fusion receives the unique event
    // evidence only; it cannot alter forecasts, scenarios, currentMarket, or the UI.
    const evidenceFusion = buildEvidenceFusionDiagnostics({ pipelineResult, eventEvidence });

    // Reine Signal-Aggregation (lib/newsSignals.js) aus den bereits klassifizierten News -
    // fließt aktuell NICHT in die numerische Prognose ein, siehe dortige Dokumentation.
    const marketState = aggregateMarketState(
      newsSource === "live"
        ? eventDeduplication.representatives.map((n) => ({
            date: n.date,
            category: n.categoryKey,
            direction: n.sentiment,
            severity: n.severity,
            confidence: n.confidence,
            chinaRelevance: n.chinaRelevance,
            euRelevance: n.euRelevance,
          }))
        : []
    );

    // Dynamisches, newsgesteuertes Szenario "Aktuelle Marktlage" (currentMarket): bildet
    // ausschließlich Vorzeichen (Richtung) und Betrag (Marktdruck) von marketState.<region>.overall
    // auf ein Quantil der ECHTEN historischen Forward-Return-Verteilung ab (forecasting/scenarios.py,
    // build_news_adjusted_scenario) - die KI liefert an keiner Stelle einen Preiswert. Nur verfügbar,
    // wenn sowohl live News als auch eine KI-Klassifizierung vorliegen; sonst explizit als nicht
    // verfügbar markiert (entspricht dann zusätzlich exakt der Basisprognose, siehe dortige Doku).
    const currentMarketAvailable = newsSource === "live" && aiEnabled;
    let currentMarketScenario;
    try {
      currentMarketScenario = await runCurrentMarketScenario(
        marketState.china.overall,
        marketState.eu.overall,
        currentMarketAvailable,
        pythonInterpreter
      );
      currentMarketScenario.summary = buildCurrentMarketSummary({
        newsSource, aiEnabled, news, marketState,
      });
    } catch (err) {
      console.error("[Aktuelle Marktlage] Berechnung fehlgeschlagen:", err.message);
      currentMarketScenario = null;
    }
    if (currentMarketScenario) scenarios.push(currentMarketScenario);

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      aiEnabled,
      aiError,
      classificationStatus,
      llmProvider: newsClassifier.id,
      aiProvider,
      aiProviderAvailable: aiProvider.available,
      aiDiagnostic,
      pythonInterpreter: pythonInterpreter.display,
      newsSource,
      history: {
        labels: pipelineResult.history.labels.map(formatMonthLabel),
        china: pipelineResult.history.china,
        eu: pipelineResult.history.eu,
      },
      forecastLabels: pipelineResult.forecastLabels.map(formatMonthLabel),
      // Zusätzlich zum bisherigen p50-Basisszenario in "scenarios": rohe p10/p50/p90-Baseline-
      // Bandbreite je Region, für die Unsicherheits-Visualisierung im Chart. Rein additiv - bricht
      // keinen bestehenden Vertrag (scenarios/history/forecastLabels bleiben unverändert).
      baseline: {
        china: { p10: pipelineResult.china.p10, p50: pipelineResult.china.p50, p90: pipelineResult.china.p90 },
        eu: { p10: pipelineResult.eu.p10, p50: pipelineResult.eu.p50, p90: pipelineResult.eu.p90 },
      },
      scenarios,
      news,
      eventEvidence,
      newsLage,
      historicalEventAssociations,
      evidenceFusion,
      newsDiagnostics,
      marketState,
      // Read-only persisted-event views; failures remain local to this section.
      strategicMarketIntelligence: loadStrategicMarketIntelligence({
        databasePath: path.join(appDir, "data", "news-events.db"),
      }),
    });
  } catch (err) {
    console.error("[/api/refresh] Fehler:", err);
    res.status(500).json({ ok: false, error: "Aktualisierung fehlgeschlagen. Bitte später erneut versuchen." });
  }
});

app.listen(PORT, () => {
  console.log(`Carbide Marktradar läuft auf http://localhost:${PORT}`);
  console.log(`KI-Kommentierung: Provider ${newsClassifier.id} (siehe .env.example).`);
});

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
const CarbideData = require("./public/js/data.js");
const { aggregateMarketState } = require("./lib/newsSignals");

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

// Firmenproxy: Node's fetch nutzt HTTP_PROXY/HTTPS_PROXY NICHT automatisch, daher explizit über undici ProxyAgent.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

// ---- Python-Forecasting-Pipeline (echte Excel-Daten + Backtest-Modellauswahl) ------------
// 1. FORECAST_PYTHON aus .env, falls gesetzt. 2. Sonst "python" (muss im PATH liegen).
const FORECAST_PYTHON = process.env.FORECAST_PYTHON || "python";
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
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      FORECAST_PYTHON,
      [FORECAST_SCRIPT, "--json"],
      { cwd: appDir, timeout: FORECAST_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }
    ));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Python-Interpreter "${FORECAST_PYTHON}" konnte nicht gestartet werden. ` +
        `FORECAST_PYTHON in .env setzen oder sicherstellen, dass "python" im PATH liegt.`
      );
    }
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
    return JSON.parse(stdout);
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
async function runCurrentMarketScenario(chinaScore, euScore, available) {
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
      FORECAST_PYTHON,
      args,
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

const AI_CONFIGURED = Boolean(BMF_BASE_URL && BMF_API_KEY && BMF_MODEL);

if (!AI_CONFIGURED) {
  console.warn(
    "[BMF] Kein vollständiges API-Setup gefunden (BMF_BASE_URL/BMF_API_KEY/BMF_MODEL). " +
    "KI-Kommentierung ist deaktiviert, /api/refresh liefert weiterhin die neu berechneten Szenarien. " +
    "Siehe .env.example."
  );
}

// ---- Echte News: Google-News-RSS (öffentlich, ohne API-Key) ------------------
// Liefert echte, aktuelle Artikel-Metadaten (Titel, Link, Datum, Quelle). Der Volltext der
// Artikel wird NICHT abgerufen (nur RSS-Snippet) - die KI-Klassifizierung (Kategorie/Sentiment/
// Einschätzung) basiert daher ausschließlich auf Titel + Quelle, nicht auf frei erfundenen Inhalten.
// Neben den preisbezogenen Suchen werden bewusst auch breitere "Overall"-Marktsuchen abgefragt
// (Markt/Industrie/Bergbau, nicht nur "price"), damit auch allgemeine Branchennews auftauchen.
const RSS_QUERIES = [
  { url: "https://news.google.com/rss/search?q=tungsten%20price%20when:30d&hl=en-US&gl=US&ceid=US:en", lang: "en" },
  { url: "https://news.google.com/rss/search?q=Wolfram%20Preis%20when:30d&hl=de&gl=DE&ceid=DE:de", lang: "de" },
  { url: "https://news.google.com/rss/search?q=tungsten%20market%20when:30d&hl=en-US&gl=US&ceid=US:en", lang: "en" },
  { url: "https://news.google.com/rss/search?q=tungsten%20mining%20when:30d&hl=en-US&gl=US&ceid=US:en", lang: "en" },
  { url: "https://news.google.com/rss/search?q=tungsten%20carbide%20when:30d&hl=en-US&gl=US&ceid=US:en", lang: "en" },
  { url: "https://news.google.com/rss/search?q=Wolfram%20Rohstoff%20when:30d&hl=de&gl=DE&ceid=DE:de", lang: "de" },
];

function extractTag(block, tag) {
  // WICHTIG: String.raw verwenden, sonst interpretiert JS "\s"/"\/" in Template-Literals als
  // unbekannte Escape-Sequenzen und verschluckt die Backslashes, bevor der Regex sie sieht.
  const re = new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  let val = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(val);
  if (cdata) val = cdata[1];
  return val
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml))) {
    const block = m[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTag(block, "source") || "Google News";
    if (title) items.push({ title, link, pubDate, source });
  }
  return items;
}

function toIsoDate(pubDate) {
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

async function fetchRealNews(limit) {
  const all = [];
  for (const q of RSS_QUERIES) {
    try {
      const res = await fetch(q.url, { dispatcher: proxyDispatcher });
      if (!res.ok) continue;
      const xml = await res.text();
      all.push(...parseRss(xml));
    } catch (err) {
      console.error(`[News-RSS] Abruf fehlgeschlagen (${q.lang}):`, err.message);
    }
  }

  // Deduplizieren (gleicher Titel) und nach Datum absteigend sortieren.
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  deduped.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  return deduped.slice(0, limit).map((item, i) => ({
    id: `live-${i + 1}`,
    date: toIsoDate(item.pubDate),
    title: item.title,
    source: item.source,
    link: item.link,
    real: true,
  }));
}

// ---- Prompt: Szenario-Einschätzungen + semantische Klassifizierung echter News -------------
// WICHTIG: Die News-Klassifizierung ist reine semantische Ereignis-Einordnung. Das LLM darf
// NIEMALS einen zukünftigen Preis, ein Kursziel, eine prozentuale Preisänderung oder eine
// Prognose-Zeitreihe liefern - weder als Zahl noch im Freitext. Diese Klassifizierung fließt
// aktuell NICHT in die numerischen Szenarien ein (siehe /api/refresh).
function buildPrompt(realNews, scenarios) {
  const newsBlock = realNews
    .map((n, i) => `${i}. [Datum: ${n.date}] [Quelle: ${n.source}] Titel: ${n.title}`)
    .join("\n");
  const scenarioBlock = scenarios
    .map((s) => `- ${s.id} ("${s.name}"): aktuell erwartete 12M-Änderung China ${s.expectedChange12m.china ?? 0}%, EU ${s.expectedChange12m.eu ?? 0}%`)
    .join("\n");

  return (
    `Du bist Rohstoff-Analyst für Wolfram-Carbide (China/EU-Markt). Du bekommst ausschließlich ECHTE, ` +
    `aktuell recherchierte Nachrichten-Metadaten (Titel, Quelle, Datum - keine erfundenen Meldungen, kein ` +
    `Artikel-Volltext). Nutze für die News-Klassifizierung AUSSCHLIESSLICH diese genannten Felder ` +
    `(Titel/Quelle/Datum, sowie Snippet falls angegeben) und erfinde keine zusätzlichen Fakten.\n\n` +
    `Echte Nachrichten-Metadaten:\n${newsBlock || "(keine aktuellen Artikel gefunden)"}\n\n` +
    `Preisszenarien mit aktuell berechneter 12-Monats-Preisänderung (nur als Kontext für die ` +
    `Szenario-Einschätzungen, NICHT für die News-Klassifizierung relevant):\n${scenarioBlock}\n\n` +
    `Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt in folgender Form, ohne weiteren Text:\n` +
    `{\n` +
    `  "scenarios": { "<scenarioId>": "<1-2 Satz sachliche Einschätzung auf Deutsch, OHNE neue Preiswerte>", ... },\n` +
    `  "news": { "<index>": {\n` +
    `    "category": "supply|demand|regulation|geopolitics|technology|macro|other",\n` +
    `    "direction": "bullish|bearish|neutral",\n` +
    `    "severity": <Zahl 0.0-1.0 - potenzielle Stärke des Marktereignisses, KEIN Prozentwert und KEINE Preisänderung>,\n` +
    `    "confidence": <Zahl 0.0-1.0 - wie sicher du dir bei dieser Klassifizierung bist>,\n` +
    `    "chinaRelevance": <Zahl 0.0-1.0>,\n` +
    `    "euRelevance": <Zahl 0.0-1.0>,\n` +
    `    "horizonWeeks": <ganze Zahl 1-52 - erwarteter Wirkungshorizont des Ereignisses>,\n` +
    `    "summary": "<1 sachlicher Satz NUR basierend auf Titel/Quelle/Datum, auf Deutsch>",\n` +
    `    "impactExplanation": "<1 Satz qualitative Erklärung der möglichen Marktrelevanz - OHNE Preiswert, OHNE Prozentangabe, OHNE Kursziel, OHNE Zeitreihe>"\n` +
    `  }, ... }\n` +
    `}\n` +
    `Für "scenarios" MÜSSEN alle Szenario-ids als Schlüssel vorkommen. Für "news" MÜSSEN alle Indizes ` +
    `0 bis ${Math.max(realNews.length - 1, 0)} vorkommen, sofern Artikel vorhanden sind. Keine Übertreibungen, ` +
    `keine Anlageberatung. Wiederhole: NIE einen Preis, ein Kursziel, eine Preisänderung in Prozent oder eine ` +
    `Zeitreihe nennen - weder in "scenarios" noch in "news".`
  );
}

async function callBoschModelFarm(prompt) {
  // Bosch Model Farm nutzt ein Azure-OpenAI-kompatibles Deployment-Schema:
  // POST {BASE}/api/openai/deployments/{model}/chat/completions?api-version={version}
  const url =
    `${BMF_BASE_URL}/api/openai/deployments/${encodeURIComponent(BMF_MODEL)}` +
    `/chat/completions?api-version=${encodeURIComponent(BMF_API_VERSION)}`;

  const headers = { "Content-Type": "application/json" };
  if (BMF_AUTH_STYLE === "apikey") {
    headers["api-key"] = BMF_API_KEY;
  } else if (BMF_AUTH_STYLE === "subscription-key") {
    headers["genaiplatform-farm-subscription-key"] = BMF_API_KEY;
  } else {
    headers["Authorization"] = `Bearer ${BMF_API_KEY}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      dispatcher: proxyDispatcher,
      body: JSON.stringify({
        model: BMF_MODEL,
        messages: [
          { role: "system", content: "Du antwortest ausschließlich mit validem JSON, ohne Markdown-Codeblock." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`BMF-Antwort ${response.status}: ${bodyText.slice(0, 300)}`);
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content?.trim() || "";
    const cleaned = content.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/status", (req, res) => {
  res.json({ ok: true, aiConfigured: AI_CONFIGURED, model: AI_CONFIGURED ? BMF_MODEL : null });
});

// ---- Validierung der News-Klassifizierung ------------------------------------------------
// Das LLM liefert AUSSCHLIESSLICH semantische Klassifizierung (siehe buildPrompt) - niemals
// Preise/Kursziele/Prozentänderungen/Zeitreihen. Alle Felder werden serverseitig zusätzlich
// geklemmt/whitelisted, bevor sie das Backend verlassen; bei einer strukturell ungültigen
// Antwort (kein Objekt) wird komplett auf eine neutrale Klassifizierung zurückgefallen.
const NEWS_CATEGORIES = ["supply", "demand", "regulation", "geopolitics", "technology", "macro", "other"];
const NEWS_DIRECTIONS = ["bullish", "bearish", "neutral"];
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

function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function clampHorizonWeeks(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(52, Math.max(1, n)) : fallback;
}

function neutralNewsClassification(title) {
  return {
    category: "other",
    direction: "neutral",
    severity: 0,
    confidence: 0,
    chinaRelevance: 0.5,
    euRelevance: 0.5,
    horizonWeeks: 12,
    summary: title,
    impactExplanation: "Automatisch abgerufen, noch keine KI-Einschätzung verfügbar.",
  };
}

function validateNewsClassification(raw, title) {
  if (!raw || typeof raw !== "object") return neutralNewsClassification(title);
  return {
    category: NEWS_CATEGORIES.includes(raw.category) ? raw.category : "other",
    direction: NEWS_DIRECTIONS.includes(raw.direction) ? raw.direction : "neutral",
    severity: clamp01(raw.severity, 0),
    confidence: clamp01(raw.confidence, 0),
    chinaRelevance: clamp01(raw.chinaRelevance, 0.5),
    euRelevance: clamp01(raw.euRelevance, 0.5),
    horizonWeeks: clampHorizonWeeks(raw.horizonWeeks, 12),
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : title,
    impactExplanation: typeof raw.impactExplanation === "string" && raw.impactExplanation.trim()
      ? raw.impactExplanation.trim()
      : "",
  };
}

// Neutrale Standard-Klassifizierung für echte News, falls keine KI verfügbar ist/fehlschlägt.
function applyFallbackClassification(newsItems) {
  newsItems.forEach((n) => {
    n.category = n.category || NEWS_CATEGORY_LABELS_DE.other;
    n.categoryKey = n.categoryKey || "other";
    n.sentiment = n.sentiment || "neutral";
    n.summary = n.summary || n.title;
    n.impact = n.impact || "Automatisch abgerufen, noch keine KI-Einschätzung verfügbar.";
    n.scenarios = n.scenarios || [];
    n.severity = n.severity ?? 0;
    n.confidence = n.confidence ?? 0;
    n.chinaRelevance = n.chinaRelevance ?? 0.5;
    n.euRelevance = n.euRelevance ?? 0.5;
    n.horizonWeeks = n.horizonWeeks ?? 12;
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
    try {
      pipelineResult = await runForecastingPipeline();
    } catch (err) {
      console.error("[Forecasting] Pipeline-Aufruf fehlgeschlagen:", err.message);
      return res.status(502).json({
        ok: false,
        error: `Prognose-Pipeline nicht verfügbar: ${err.message}`,
      });
    }

    // "base"-Szenario = exakt die p50-Modellprognose (deltaFn liefert 0). Die übrigen
    // Szenarien wenden ihre bestehenden Sensitivitäten weiterhin auf diese ECHTE Basis an,
    // statt auf die frühere künstliche baseTrend()-Fortschreibung.
    const scenarios = CarbideData.computeScenarioSeries(
      pipelineResult.china.p50,
      pipelineResult.eu.p50,
      pipelineResult.china.last_observed.price,
      pipelineResult.eu.last_observed.price
    );

    // Echte, aktuelle News per Google-News-RSS abrufen (kein API-Key nötig). Es gibt bewusst
    // KEINEN fiktiven Fallback mehr - schlägt der Abruf fehl, bleibt die Liste leer und das
    // Frontend zeigt einen entsprechenden Hinweis an.
    let news;
    let newsSource;
    try {
      news = await fetchRealNews(20);
      if (!news.length) throw new Error("Keine Artikel gefunden");
      newsSource = "live";
    } catch (err) {
      console.error("[News-RSS] Fehlgeschlagen:", err.message);
      news = [];
      newsSource = "unavailable";
    }

    let aiEnabled = false;
    let aiError = null;

    if (AI_CONFIGURED) {
      try {
        const prompt = buildPrompt(newsSource === "live" ? news : [], scenarios);
        const aiResult = await callBoschModelFarm(prompt);

        const scenarioInsights = aiResult?.scenarios || {};
        scenarios.forEach((s) => {
          if (typeof scenarioInsights[s.id] === "string" && scenarioInsights[s.id].trim()) {
            s.summary = scenarioInsights[s.id].trim();
            s.aiGenerated = true;
          }
        });

        if (newsSource === "live") {
          const newsClassification = aiResult?.news || {};
          news.forEach((n, i) => {
            // Serverseitig validiert/geklemmt (Kategorie/Richtung whitelisted, Werte auf 0..1
            // bzw. 1..52 geklemmt) - fällt bei strukturell ungültiger LLM-Antwort komplett auf
            // eine neutrale Klassifizierung zurück. Die zusätzlichen Felder (severity/confidence/
            // chinaRelevance/euRelevance/horizonWeeks) werden aktuell NICHT zur Veränderung der
            // numerischen Szenarien verwendet.
            const validated = validateNewsClassification(newsClassification[String(i)], n.title);
            n.category = NEWS_CATEGORY_LABELS_DE[validated.category];
            n.categoryKey = validated.category; // roher Enum-Wert für lib/newsSignals.js, getrennt vom Anzeige-Label
            n.sentiment = validated.direction;
            n.summary = validated.summary;
            n.impact = validated.impactExplanation;
            n.scenarios = scenariosForClassification(validated.category, validated.direction);
            n.severity = validated.severity;
            n.confidence = validated.confidence;
            n.chinaRelevance = validated.chinaRelevance;
            n.euRelevance = validated.euRelevance;
            n.horizonWeeks = validated.horizonWeeks;
            n.aiGenerated = true;
          });
        }
        aiEnabled = true;
      } catch (err) {
        console.error("[BMF] Anfrage fehlgeschlagen:", err.message);
        aiError = "KI-Kommentierung aktuell nicht verfügbar – zeige modellbasierte Standardtexte.";
      }
    }

    if (newsSource === "live") applyFallbackClassification(news);

    // Reine Signal-Aggregation (lib/newsSignals.js) aus den bereits klassifizierten News -
    // fließt aktuell NICHT in die numerische Prognose ein, siehe dortige Dokumentation.
    const marketState = aggregateMarketState(
      newsSource === "live"
        ? news.map((n) => ({
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
        currentMarketAvailable
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
      marketState,
    });
  } catch (err) {
    console.error("[/api/refresh] Fehler:", err);
    res.status(500).json({ ok: false, error: "Aktualisierung fehlgeschlagen. Bitte später erneut versuchen." });
  }
});

app.listen(PORT, () => {
  console.log(`Carbide Marktradar läuft auf http://localhost:${PORT}`);
  console.log(`KI-Kommentierung (Bosch Model Farm): ${AI_CONFIGURED ? "aktiv" : "deaktiviert (siehe .env.example)"}`);
});

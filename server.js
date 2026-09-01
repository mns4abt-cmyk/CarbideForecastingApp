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

// ---- Prompt: Szenario-Einschätzungen + Klassifizierung echter News in einem Aufruf ----------
function buildPrompt(realNews, scenarios) {
  const newsBlock = realNews
    .map((n, i) => `${i}. [${n.date}] (Quelle: ${n.source}) ${n.title}`)
    .join("\n");
  const scenarioBlock = scenarios
    .map((s) => `- ${s.id} ("${s.name}"): aktuell erwartete 12M-Änderung China ${s.expectedChange12m.china ?? 0}%, EU ${s.expectedChange12m.eu ?? 0}%`)
    .join("\n");
  const scenarioIds = scenarios.map((s) => s.id).join(", ");

  return (
    `Du bist Rohstoff-Analyst für Wolfram-Carbide (China/EU-Markt). Du bekommst ausschließlich ECHTE, ` +
    `aktuell recherchierte Nachrichtentitel (keine erfundenen Meldungen). Bewerte NUR auf Basis von Titel ` +
    `und Quelle, erfinde keine zusätzlichen Fakten die nicht im Titel stehen.\n\n` +
    `Echte Nachrichtentitel (Index. [Datum] (Quelle) Titel):\n${newsBlock || "(keine aktuellen Artikel gefunden)"}\n\n` +
    `Preisszenarien mit aktuell berechneter 12-Monats-Preisänderung:\n${scenarioBlock}\n\n` +
    `Antworte AUSSCHLIESSLICH mit einem validen JSON-Objekt in folgender Form, ohne weiteren Text:\n` +
    `{\n` +
    `  "scenarios": { "<scenarioId>": "<1-2 Satz sachliche Einschätzung auf Deutsch>", ... },\n` +
    `  "news": { "<index>": { "category": "<kurze Kategorie, z.B. Angebot/Nachfrage/Regulierung>", ` +
    `"sentiment": "bullish|bearish|neutral", "summary": "<1 sachlicher Satz NUR basierend auf dem Titel>", ` +
    `"impact": "<1 Satz mögliche Auswirkung auf Wolfram-Carbide-Preis>", ` +
    `"scenarios": ["<passende Szenario-ids aus: ${scenarioIds}>"] }, ... }\n` +
    `}\n` +
    `Für "scenarios" MÜSSEN alle Szenario-ids als Schlüssel vorkommen. Für "news" MÜSSEN alle Indizes ` +
    `0 bis ${Math.max(realNews.length - 1, 0)} vorkommen, sofern Artikel vorhanden sind. Keine Übertreibungen, keine Anlageberatung.`
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

// Neutrale Standard-Klassifizierung für echte News, falls keine KI verfügbar ist/fehlschlägt.
function applyFallbackClassification(newsItems) {
  newsItems.forEach((n) => {
    n.category = n.category || "Nachrichten (unklassifiziert)";
    n.sentiment = n.sentiment || "neutral";
    n.summary = n.summary || n.title;
    n.impact = n.impact || "Automatisch abgerufen, noch keine KI-Einschätzung verfügbar.";
    n.scenarios = n.scenarios || [];
  });
  return newsItems;
}

app.post("/api/refresh", async (req, res) => {
  try {
    const scenarios = CarbideData.computeScenarioSeries();

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
            const c = newsClassification[String(i)];
            if (c) {
              n.category = c.category || "Sonstiges";
              n.sentiment = c.sentiment || "neutral";
              n.summary = c.summary || n.title;
              n.impact = c.impact || "";
              n.scenarios = Array.isArray(c.scenarios) ? c.scenarios : [];
              n.aiGenerated = true;
            }
          });
        }
        aiEnabled = true;
      } catch (err) {
        console.error("[BMF] Anfrage fehlgeschlagen:", err.message);
        aiError = "KI-Kommentierung aktuell nicht verfügbar – zeige modellbasierte Standardtexte.";
      }
    }

    if (newsSource === "live") applyFallbackClassification(news);

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      aiEnabled,
      aiError,
      newsSource,
      history: {
        labels: CarbideData.HISTORY_LABELS,
        china: CarbideData.CHINA_HISTORY,
        eu: CarbideData.EU_HISTORY,
      },
      forecastLabels: CarbideData.FORECAST_LABELS,
      scenarios,
      news,
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

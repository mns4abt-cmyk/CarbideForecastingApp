"use strict";

const { buildNewsLageSummary } = require("./newsLageSummary");

const ALLOWED_EVENT_FIELDS = ["title", "snippet", "source", "publishedAt", "category", "direction",
  "supplyEffect", "demandEffect", "eventStage", "evidenceMaturity"];

function summaryInput(market, events) {
  return {
    market,
    events: events.map(event => Object.fromEntries(ALLOWED_EVENT_FIELDS
      .filter(field => event[field] !== undefined && event[field] !== null)
      .map(field => [field, event[field]]))),
  };
}

function buildPrompt(input) {
  return [
    "Du schreibst einen präzisen, managementgerechten Nachrichtenüberblick auf Basis echter Artikelinhalte.",
    "Fasse ausschließlich die bereits validierten Nachrichtenereignisse für den angegebenen Markt zusammen.",
    "Schreibe genau 2 bis 3 kurze, flüssige Sätze auf natürlichem Deutsch.",
    "Benenne konkrete Entwicklungen aus Titeln und Beschreibungen und verbinde überlappende Meldungen zu einem zusammenhängenden Überblick.",
    "Achte auf konkrete Produktions-, Angebots-, Nachfrage- oder Regulierungsentwicklungen, sofern sie in den Artikeln beschrieben sind.",
    "Verknüpfe nur Meldungen, die erkennbar denselben Vorgang beschreiben; leite keine Folgen, Ursachen oder Auswirkungen auf die Versorgung ab.",
    "Wenn nur ein Titel verfügbar ist, bleibe bei den darin ausdrücklich genannten Namen und Handlungen; ergänze keine vermuteten Zusammenhänge.",
    "Gib Fragen, Vermutungen oder mögliche Deutungen aus Nachrichtentiteln nicht als bestätigte Tatsachen wieder.",
    "Zähle die Artikel nicht einzeln auf und wiederhole keinen Nachrichtentitel wörtlich.",
    "Schreibe keine generische Themen-, Kategorie- oder Richtungszusammenfassung, die auch ohne diese Artikel passen würde.",
    "Verwende keine internen Feldnamen; vermeide bullish/bearish und technische Bewertungs- oder Klassifikationsbegriffe.",
    "Verwende natürliches Deutsch: Tungsten heißt Wolfram, tungsten concentrate heißt Wolframkonzentrat, mining output heißt Fördermenge oder Produktion, revenue heißt Umsatz.",
    "Beschreibe nur ausdrücklich berichtete Entwicklungen; füge keine Deutung, Schlussfolgerung oder Ursache-Wirkung-Verbindung hinzu.",
    "Sage keine Preise oder Preisentwicklung voraus und nenne keine Forecast-Werte.",
    "Erfinde keine konkreten Tatsachen oder Zahlen, die nicht in den Artikeldaten stehen.",
    "Leite die qualitative News-Lage-Einordnung nicht ab und verändere sie nicht; sie wird separat berechnet.",
    "Gib ausschließlich ein JSON-Objekt mit dem Feld summary zurück. Das Feld enthält nur den Überblickstext, ohne Überschrift oder Aufzählung.",
    JSON.stringify(input),
  ].join("\n");
}

function isSafeSummary(text, events) {
  if (typeof text !== "string") return false;
  const normalized = text.trim();
  const sentences = normalized.split(/(?<=[.!?])\s+/u).filter(Boolean);
  if (normalized.length < 40 || normalized.length > 700 || sentences.length < 2 || sentences.length > 3) return false;
  if (/\b(?:prognose|vorhersage|forecast|wird steigen|wird fallen|dürfte steigen|dürfte fallen|könnte steigen|könnte fallen|steigende preise|fallende preise|verursacht|verursachen|führt zu|führen zu|wegen|infolge|dadurch|deshalb|signalisiert|signalisieren|deutet darauf|bewirkt|ermöglicht|als teil|als folge|wobei|durch|mögliche?\s+(?:gegenmaßnahme|gegengewicht|widerstand)|gegenmaßnahme|gegengewicht|widerstand|ausgaben|caused by|leads? to|results? in)\b/iu.test(normalized)) return false;
  if (/\b(?:finalWeight|marketRelevance|supplyEffect|demandEffect|eventStage|evidenceMaturity|klassifizierung|konfidenz|relevanzscore)\b/iu.test(normalized)) return false;
  const numericTokens = value => [...String(value || "").matchAll(/\d+(?:[.,]\d+)?\s?%?/gu)].map(match => match[0].replace(/\s+/g, ""));
  const sourceNumbers = new Set(events.flatMap(event => [...numericTokens(event.title), ...numericTokens(event.snippet), ...numericTokens(event.publishedAt)]));
  if (numericTokens(normalized).some(number => !sourceNumbers.has(number))) return false;
  const stopWords = new Set(["aber", "auch", "beim", "dabei", "dass", "diese", "einer", "eines", "einem", "einen", "erste", "ihre", "ihren", "ihrer", "mehrere", "neue", "neuen", "sowie", "und", "über", "unter", "wurde", "werden", "weiter", "während", "sich", "the", "this", "with", "from", "after", "into", "about", "amid", "over", "will", "price", "shock", "signals", "signal", "deeper", "supply", "demand", "tungsten", "wolfram", "output", "market", "report", "reports", "article", "news"]);
  const terms = value => String(value || "").toLocaleLowerCase("de-DE").match(/[\p{L}\p{N}]{4,}/gu) || [];
  const equivalent = term => ({ production: "produktion", output: "produktion", tungsten: "wolfram",
    supply: "angebot", demand: "nachfrage", restart: "wiederaufnahme", restarted: "wiederaufnahme",
    restarting: "wiederaufnahme", korean: "korea", europe: "europa", european: "europäisch",
    europäische: "europäisch", processors: "verarbeiter", processor: "verarbeiter",
    reported: "berichten", reports: "berichten", tight: "angespannt", increases: "zunahme",
    increase: "zunahme" })[term] || term;
  const contentTerms = new Set(events.flatMap(event => [...terms(event.title), ...terms(event.snippet)])
    .filter(term => !stopWords.has(term)).map(equivalent));
  const matchedTerms = new Set(terms(normalized).map(equivalent).filter(term => contentTerms.has(term)));
  if (!contentTerms.size || matchedTerms.size < Math.min(2, contentTerms.size)) return false;
  return !events.some(event => typeof event.title === "string" && event.title.length > 24
    && normalized.toLocaleLowerCase("de-DE").includes(event.title.toLocaleLowerCase("de-DE")));
}

function eventDateKey(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function findArticleContent(event, articles) {
  return articles.find(article => {
    if (!article || article.title !== event.title) return false;
    if (event.source && article.source && event.source.toLocaleLowerCase() !== article.source.toLocaleLowerCase()) return false;
    const eventDate = eventDateKey(event.date);
    const articleDate = eventDateKey(article.publishedAt || article.date);
    return !eventDate || !articleDate || eventDate === articleDate;
  });
}

async function requestSummary(fetchImpl, { baseUrl, model, timeoutMs }, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, think: false,
        format: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
        options: { temperature: 0, num_predict: 256 },
        messages: [{ role: "user", content: buildPrompt(input) }] }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("summary request failed");
    const body = await response.json();
    let parsed;
    try { parsed = JSON.parse(body?.message?.content || ""); } catch { throw new Error("summary response was not valid JSON"); }
    const text = parsed?.summary;
    if (!isSafeSummary(text, input.events)) throw new Error("summary response failed validation");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function addOllamaNewsLageSummaries(newsLage, {
  fetch,
  articleContent = [],
  baseUrl = "http://127.0.0.1:11434",
  model = "qwen3:4b",
  timeoutMs = 15000,
  available = true,
  logger = console,
} = {}) {
  if (!newsLage?.managementSummary) return newsLage;
  const managementSummary = { ...newsLage.managementSummary };

  await Promise.all(["china", "eu"].map(async market => {
    const current = managementSummary[market];
    if (!current || !["available", "empty"].includes(current.status) || current.status === "empty") return;
    const selectedEvents = current.topEvents || [];
    if (!selectedEvents.length) return;
    const details = new Map((newsLage.events?.[market] || []).map(event => [event.eventKey, event]));
    const summaryEvents = selectedEvents.map(event => {
      const article = findArticleContent(event, articleContent);
      const detail = details.get(event.eventKey);
      return {
      title: event.title,
      snippet: article?.snippet || event.snippet,
      source: event.source,
      publishedAt: detail?.publishedAt || event.date,
      category: event.category,
      direction: event.direction,
      supplyEffect: event.supplyEffect,
      demandEffect: event.demandEffect,
      eventStage: event.eventStage,
      evidenceMaturity: event.evidenceMaturity,
      };
    });
    const fallbackText = buildNewsLageSummary({ ...current, topEvents: summaryEvents });
    managementSummary[market] = { ...current, text: fallbackText };
    if (!available || typeof fetch !== "function") return;
    const input = summaryInput(market === "china" ? "China" : "EU", summaryEvents);
    try {
      const text = await requestSummary(fetch, { baseUrl, model, timeoutMs }, input);
      managementSummary[market] = { ...managementSummary[market], text, generatedFrom: "validated_30d_events_ollama",
        additionalLlmCalls: true, numericalForecastAdjustmentApplied: false };
    } catch (error) {
      logger.warn(`[News-Lage summary] ${market} summary unavailable; using deterministic fallback.`);
    }
  }));
  return { ...newsLage, managementSummary };
}

module.exports = { ALLOWED_EVENT_FIELDS, addOllamaNewsLageSummaries, buildPrompt, findArticleContent, isSafeSummary, summaryInput };
"use strict";

const CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classifications"],
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "direction", "supplyEffect", "demandEffect", "eventStage", "severity", "confidence", "globalRelevance", "chinaRelevance", "euRelevance", "horizonWeeks", "summary", "impactExplanation"],
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: ["supply", "demand", "regulation", "geopolitics", "technology", "macro", "other"] },
          direction: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Tungsten/APT price direction only: bullish=upward pressure, bearish=downward pressure, neutral=no clear price pressure." },
          supplyEffect: { type: "string", enum: ["increase", "decrease", "none", "unclear"] },
          demandEffect: { type: "string", enum: ["increase", "decrease", "none", "unclear"] },
          eventStage: { type: "string", enum: ["actual", "announced", "planned", "study", "exploration", "speculative", "unclear"] },
          severity: { type: "number" },
          confidence: { type: "number" },
          globalRelevance: { type: "number", description: "0-1 materiality of the evidenced event to international tungsten/APT supply-demand balance; not popularity and not implied by the word tungsten alone." },
          chinaRelevance: { type: "number" },
          euRelevance: { type: "number" },
          horizonWeeks: { type: "integer" },
          summary: { type: "string" },
          impactExplanation: { type: "string" },
        },
      },
    },
  },
};

// Prompt-contract examples, not production rules or classifier overrides.
const DIRECTION_EXAMPLES = [
  ["China restricts tungsten exports", "bullish"],
  ["A tungsten mine closes because of an accident", "bullish"],
  ["A major new tungsten mine starts commercial production", "bearish"],
  ["Tungsten carbide demand falls", "bearish"],
  ["The EU discusses tungsten policy with no specified supply/demand effect", "neutral"],
];

function selectArticlesForClassification(items, maxArticles) {
  return [...items]
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0) || new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, maxArticles);
}

function batchArticles(items, batchSize) {
  const batches = [];
  for (let index = 0; index < items.length; index += batchSize) batches.push(items.slice(index, index + batchSize));
  return batches;
}

async function classifySequentialBatches(provider, items, batchSize) {
  const classifications = new Map();
  const failedBatches = [];
  for (const batch of batchArticles(items, batchSize)) {
    try {
      const result = await provider.classify(batch);
      result.forEach((classification, id) => classifications.set(id, classification));
    } catch {
      failedBatches.push(batch.map((article) => article.id));
    }
  }
  return { classifications, failedBatches };
}

function buildClassificationPrompt(items) {
  const articles = items.map(({ id, title, snippet, source, date }) => ({
    id,
    title: title || "",
    snippet: snippet || "",
    publisher: source || "",
    publishedAt: date || "",
  }));
  return [
    "Du klassifizierst ausschließlich die folgenden Nachrichtenartikel für den Wolframmarkt.",
    "Nutze nur Titel, Snippet, Herausgeber und Datum. Erfinde keine Fakten.",
    "Jede article id ist unabhängig: Übertrage niemals Fakten, Kontext, Ursachen oder Wirkungen zwischen article ids.",
    "DIRECTION BEDEUTET AUSSCHLIESSLICH DIE RICHTUNG DES TUNGSTEN-/APT-PREISDRUCKS, nicht die Bewertung für Industrie, Käufer, Produzenten oder die allgemeine Marktstimmung.",
    "Im Denken nenne diese Bedeutung priceDirection; im JSON bleibt das Feld aus Kompatibilitätsgründen direction.",
    "bullish = erwarteter Aufwärtsdruck auf den Tungsten-/APT-Preis. bearish = erwarteter Abwärtsdruck auf den Tungsten-/APT-Preis. neutral = kein ausreichend klarer Preisrichtungsdruck.",
    "Beispiele für direction: China beschränkt Tungsten-Exporte → bullish; Minenschließung durch Unfall → bullish; große neue Tungsten-Mine startet kommerzielle Produktion → bearish; sinkende Tungsten-Carbide-Nachfrage → bearish; reine EU-Policy-Ankündigung ohne genannten Angebots-/Nachfrageeffekt → neutral.",
    "impactExplanation darf nur den kausalen Mechanismus aus dem gelieferten Artikel erklären. Keine externen historischen Vergleiche, keine nicht genannten Ereignisse oder Fakten ergänzen.",
    "Primäre Aufgabe: extrahiere supplyEffect, demandEffect und eventStage aus dem gelieferten Text. direction ist nur Debug-Kompatibilität und wird serverseitig aus diesen Feldern abgeleitet.",
    "eventStage: actual=bereits real wirksam; announced=angekündigt; planned=geplant; study=Studie; exploration=Entdeckung/Exploration; speculative=Spekulation; unclear=unklar. Studie, Exploration und Spekulation sind keine aktuelle Angebotssteigerung. Entdeckung, Bohrung, Assay, Intercept, hochgradige Mineralisierung oder Resource-/Exploration-/Geological-Target = exploration, außer der Text nennt zusätzlich tatsächliche kommerzielle Produktion. Exploration allein bedeutet supplyEffect=none und keine abgeleitete demandEffect.",
    "demandEffect=increase oder decrease nur bei ausdrücklich genanntem Verbrauch, Kauf, Auftrag, Beschaffung, Nutzung oder demand. Knappheit, Buyer pressure, Beschaffungsprobleme, Inputkosten oder Exportbeschränkungen sind kein Nachfrageanstieg. Exportkontrollen bedeuten typischerweise supplyEffect=decrease und demandEffect=none, sofern der Text keine getrennte Nachfragewirkung nennt.",
    "Begründe gedanklich immer: Ereignis → belegte Angebots-/Nachfragewirkung → Tungsten-/APT-Preisrichtung. Mehr Angebot → bearish; weniger Angebot → bullish; stärkere Nachfrage → bullish; schwächere Nachfrage → bearish. Bei widersprüchlichen oder nicht belegten Wirkungen: neutral.",
    "Wenn Titel/Snippet keinen klaren kausalen Angebots-/Nachfragemechanismus belegen, setze direction=neutral und confidence niedrig. Erfinde weder Engpässe noch Produktions-, Nachfrage- oder Policy-Wirkungen.",
    "severity ist die Bedeutung des Ereignisses für den globalen bzw. belegten regionalen Tungstenmarkt, nicht die Sicherheit: 0.0-0.2 gering/unklar oder firmenspezifisch; 0.2-0.5 begrenzt; 0.5-0.75 großes regionales Ereignis; 0.75-1.0 außergewöhnliche marktweite Störung. Werte nahe 1 sind selten; Unternehmensmeldungen sind nicht automatisch 1.",
    "globalRelevance (0-1) misst ausschließlich, wie materiell die belegte Nachricht die internationale Tungsten-/APT-Angebots-Nachfragebilanz beeinflussen könnte, nicht Artikelpopularität. Das Wort Tungsten allein genügt nie für einen hohen Wert. Große tatsächlich wirksame Produktionsstörungen oder wirksame China-Exportkontrollen können hoch sein; Exploration, Finanzierung, Aktien- oder Werbemeldungen sind niedrig.",
    "confidence ist die Sicherheit, dass Kategorie und direction durch den gelieferten Text belegt sind. Ohne Snippet, bei werblichem/vagem Text, notwendiger Inferenz oder einzelner Unternehmensmeldung: niedrig. Werte über 0.9 benötigen außergewöhnlich explizite Belege.",
    "horizonWeeks beschreibt die plausible Dauer der belegten Wirkung: temporäre Betriebsereignisse eher kurz, Exportregeln oder Produktionsänderungen eher mittel/lang, strukturelle Policy potenziell länger. Nicht pauschal 1 wählen.",
    "Kategorien: supply=Mine/Produktion/Verarbeitung/Verfügbarkeit/Inventar/Ramp-up/Schließung; demand=industrieller Verbrauch, Tools, Defence, Aerospace, Einkauf; regulation=Exportkontrollen, Zölle, Lizenzen, Regulierung; geopolitics=politische/Sicherheitsereignisse mit belegter Wirkung; technology=tatsächliche technologische Entwicklung mit Tungsten-Nachfrage oder Substitution; macro=breite Makrowirkung; other=keine davon. Mine oder Ramp-up ist supply, nicht technology.",
    "chinaRelevance und euRelevance bedeuten direkte, im Artikel belegte Relevanz für den jeweiligen Markt. Nicht allein wegen der globalen Bedeutung Chinas/EU hochsetzen. Indirekte globale Relevanz nur moderat, wenn der Text sie stützt.",
    "Unternehmens-, Investor-, Finanzierungs-, Konsortiums- oder Werbemeldungen ohne belegte materielle Produktions-/Nachfrageänderung: severity niedrig und direction gegebenenfalls neutral.",
    "DIRECTION REFERS TO TUNGSTEN/APT PRICE DIRECTION ONLY.",
    "Gib genau eine Klassifizierung pro vorgegebener id zurück. Verwende niemals andere ids.",
    "Keine Preise, Kursziele, Renditen oder Preisprognosen zu Rohstoffmärkten nennen. Die Aufgabe ist ausschließlich qualitative Ereignisklassifikation.",
    "Antwortformat: ein JSON-Objekt gemäß dem vorgegebenen Schema.",
    JSON.stringify({ articles }),
  ].join("\n\n");
}

function parseJsonContent(content) {
  if (typeof content === "object" && content) return content;
  if (typeof content !== "string") throw new Error("classifier returned no JSON content");
  return JSON.parse(content.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
}

function validateBatch(payload, expectedItems) {
  const classifications = payload?.classifications;
  const expectedIds = new Set(expectedItems.map((item) => item.id));
  if (!Array.isArray(classifications) || classifications.length !== expectedIds.size) {
    throw new Error("classifier returned an incomplete batch");
  }
  const mapped = new Map();
  for (const classification of classifications) {
    if (!classification || typeof classification.id !== "string" || !expectedIds.has(classification.id) || mapped.has(classification.id)) {
      throw new Error("classifier returned mismatched article ids");
    }
    mapped.set(classification.id, classification);
  }
  return mapped;
}

async function requestWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class OllamaProvider {
  constructor({ fetch, baseUrl = "http://127.0.0.1:11434", model = "qwen3:4b", timeoutMs = 75000 } = {}) {
    if (typeof fetch !== "function") throw new TypeError("OllamaProvider requires fetch");
    this.id = "ollama";
    this.fetchImpl = fetch;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.lastSuccessfulCall = null;
  }

  async health() {
    try {
      const response = await requestWithTimeout(this.fetchImpl, `${this.baseUrl}/api/tags`, {}, 3000);
      if (!response.ok) throw new Error("health request failed");
      const body = await response.json();
      const modelAvailable = Array.isArray(body.models) && body.models.some((item) => item.name === this.model);
      return { provider: this.id, configured: true, reachable: true, model: this.model, modelAvailable, available: modelAvailable, lastSuccessfulCall: this.lastSuccessfulCall };
    } catch {
      return { provider: this.id, configured: true, reachable: false, model: this.model, modelAvailable: false, available: false, lastSuccessfulCall: this.lastSuccessfulCall };
    }
  }

  async classify(items) {
    const response = await requestWithTimeout(this.fetchImpl, `${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: CLASSIFICATION_SCHEMA,
        options: { temperature: 0 },
        messages: [{ role: "user", content: buildClassificationPrompt(items) }],
      }),
    }, this.timeoutMs);
    if (!response.ok) throw new Error("Ollama classification request failed");
    const body = await response.json();
    const classifications = validateBatch(parseJsonContent(body?.message?.content), items);
    this.lastSuccessfulCall = new Date().toISOString();
    return classifications;
  }
}

class BmfProvider {
  constructor({ fetch, dispatcher, baseUrl, apiKey, model, apiVersion = "2025-04-01-preview", authStyle = "subscription-key", timeoutMs = 75000 } = {}) {
    if (typeof fetch !== "function") throw new TypeError("BmfProvider requires fetch");
    this.id = "bmf";
    this.fetchImpl = fetch;
    this.dispatcher = dispatcher;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.model = model || "";
    this.apiVersion = apiVersion;
    this.authStyle = authStyle;
    this.timeoutMs = timeoutMs;
    this.lastSuccessfulCall = null;
  }

  async health() {
    const configured = Boolean(this.baseUrl && this.apiKey && this.model);
    return { provider: this.id, configured, reachable: null, model: configured ? this.model : null, modelAvailable: configured ? null : false, available: configured, lastSuccessfulCall: this.lastSuccessfulCall };
  }

  async classify(items) {
    if (!(await this.health()).configured) throw new Error("BMF provider is not configured");
    const headers = { "Content-Type": "application/json" };
    if (this.authStyle === "apikey") headers["api-key"] = this.apiKey;
    else if (this.authStyle === "subscription-key") headers["genaiplatform-farm-subscription-key"] = this.apiKey;
    else headers.Authorization = `Bearer ${this.apiKey}`;
    const url = `${this.baseUrl}/api/openai/deployments/${encodeURIComponent(this.model)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    const response = await requestWithTimeout(this.fetchImpl, url, {
      method: "POST",
      headers,
      dispatcher: this.dispatcher,
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: buildClassificationPrompt(items) }] }),
    }, this.timeoutMs);
    if (!response.ok) throw new Error("BMF classification request failed");
    const body = await response.json();
    const classifications = validateBatch(parseJsonContent(body?.choices?.[0]?.message?.content), items);
    this.lastSuccessfulCall = new Date().toISOString();
    return classifications;
  }
}

function createNewsClassifierProvider(options) {
  if (options.providerId === "bmf") return new BmfProvider(options);
  return new OllamaProvider(options);
}

module.exports = {
  batchArticles,
  BmfProvider,
  CLASSIFICATION_SCHEMA,
  DIRECTION_EXAMPLES,
  OllamaProvider,
  buildClassificationPrompt,
  createNewsClassifierProvider,
  classifySequentialBatches,
  selectArticlesForClassification,
};

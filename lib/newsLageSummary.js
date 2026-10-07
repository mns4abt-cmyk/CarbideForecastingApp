"use strict";

const SUMMARY_PROMPT = `Write a factual news overview in natural, concise business English for management. Use 2–3 short sentences, at most 70 words total.
The selected events follow below. Summarize ONLY concrete facts stated in their title or snippet. Stay close to the source wording. Merge overlapping stories cleanly without repeating article titles. Do not list articles or mention their sources.
The market label only indicates relevance: it does NOT mean these events happened in that market. Do not begin with "In China" or "In the EU" unless a title explicitly says so.
Metadata is context, NOT additional news. Do not turn direction, supplyEffect, demandEffect or relevance into factual claims. Do not claim supply increased/decreased, or demand was unchanged, unless explicitly stated in the titles/snippets.
Distinguish clearly between planned, ongoing, and completed developments. No speculation, invented facts, price predictions, causality, numeric scores, internal field names, or unsupported conclusions. Do not mention P10/P50/P90, scenarios, or forecast outputs.
Use neutral wording and accurate English terminology. Production of concentrate is not proof of higher output.
Return only a JSON object with a "summary" string containing the 2–3 English sentences.`;

function content(value, limit = 1600) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

// Explicit allowlist: no weights, aggregates, forecasts, scenarios or outcomes.
function summaryEvents(newsLage, market) {
  const details = new Map((newsLage.events?.[market] || []).map(event => [event.eventKey, event]));
  return (newsLage.managementSummary?.[market]?.topEvents || []).map(selected => {
    const event = details.get(selected.eventKey) || selected;
    return {
      title: content(event.title, 500),
      snippet: content(event.snippet || event.description),
      source: content(event.source || event.sources?.[0] || selected.source, 300),
      publishedAt: event.publishedAt || null,
      category: event.category ?? null,
      direction: event.direction ?? null,
      supplyEffect: event.supplyEffect ?? null,
      demandEffect: event.demandEffect ?? null,
      eventStage: event.eventStage ?? null,
      evidenceMaturity: event.evidenceMaturity ?? null,
      marketRelevance: event.effectiveMarketRelevance ?? null,
    };
  });
}

function buildNewsLageSummary(input = {}) {
  const topEvents = Array.isArray(input?.topEvents) ? input.topEvents : [];
  const topics = [...new Set(topEvents.map(event => content(event?.title || event?.snippet || event?.description, 300)).filter(Boolean))];
  if (!topics.length) return "No selected news content is available for an overview.";
  // Extractive fallback deliberately attributes the source wording, without
  // guessing translations or inferring developments from directional labels.
  return `The selected reports cover the following content: ${topics.map(title => `“${title}”`).join("; ")}. A consolidated summary is currently unavailable.`;
}

function validSummary(value) {
  if (typeof value !== "string" || value.length < 40 || value.length > 1200) return false;
  if (/[\n<>`]|^\s*[-*#]|\b(?:finalWeight|sentimentScore|supplyEffect|demandEffect|eventStage|evidenceMaturity|bullish|bearish|P10|P50|P90|forecast|score|scoring|marketRelevance|Relevanz|Gewichtung|relevance|weighting|scenarios?)\b/i.test(value)) return false;
  if (/Preisprognos|Kausal|verursacht|führ(?:t|en)\s+zu|Preise?\s+(?:wird|werden|dürfte|dürften)|Preisziel|causal|caus(?:e[sd]?|ing)|leads?\s+to|results?\s+in|prices?\s+(?:will|would|could|may|might|should)|price\s+targets?/i.test(value)) return false;
  const sentences = value.match(/[^.!?]+[.!?]+(?:["”»])?(?=\s|$)/g) || [];
  return sentences.length >= 2 && sentences.length <= 3
    && /\b(?:the|a|an|and|is|are|has|have|reported|reports)\b/i.test(value)
    && /[.!?]$/.test(value.trim());
}

// Async presentation-only enrichment keeps the synchronous loader contract.
async function summarizeNewsLage(newsLage, {
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = "http://127.0.0.1:11434", model = "qwen3:4b", timeoutMs = 75000, cache,
} = {}) {
  const managementSummary = { ...newsLage.managementSummary };
  for (const market of ["china", "eu"]) {
    const previous = managementSummary[market];
    if (!newsLage.available || previous?.status !== "available") continue;
    const events = summaryEvents(newsLage, market);
    const result = { ...previous, text: buildNewsLageSummary({ topEvents: events }), additionalLlmCalls: false };
    managementSummary[market] = result;
    if (!events.length) continue;
    const data = JSON.stringify({ market: market === "china" ? "China" : "EU", events });
    const prompt = `${SUMMARY_PROMPT}\n\nEVENTS:\n${data}`;
    // Reuse the existing cache instance/file, with a distinct task/model/prompt key.
    const key = { title: `news-lage-summary:v1:${model}`, snippet: prompt };
    let timer;
    const controller = new AbortController();
    try {
      const cached = cache?.get(key);
      if (validSummary(cached?.summary)) { result.text = cached.summary; continue; }
      result.additionalLlmCalls = true;
      const request = async () => {
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0 },
            format: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
            messages: [{ role: "user", content: prompt },
              // Older local Qwen3 templates open <think> even with think:false.
              ...(/^qwen3(?::|$)/i.test(model) ? [{ role: "assistant", content: "<think>\n\n</think>\n\n" }] : [])],
          }),
        });
        if (!response.ok) throw new Error("Summary request failed");
        const body = await response.json();
        return JSON.parse(body?.message?.content)?.summary;
      };
      // Covers both response headers and body, even a transport ignoring abort.
      const summary = await Promise.race([request(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Summary timeout")); }, timeoutMs);
      })]);
      if (validSummary(summary)) {
        result.text = summary.trim();
        try { cache?.set(key, { summary: result.text }); } catch { /* optional cache */ }
      }
    } catch { /* Per-market content fallback; News-Lage remains usable. */ }
    finally { clearTimeout(timer); }
  }
  return { ...newsLage, managementSummary };
}

module.exports = { buildNewsLageSummary, summarizeNewsLage, summaryEvents, SUMMARY_PROMPT };

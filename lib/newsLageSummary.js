"use strict";

const INSUFFICIENT = "Für einen inhaltlichen Nachrichtenüberblick liegen derzeit nicht genügend Artikeldaten vor.";

/**
 * Deterministic extractive fallback from the already selected article content.
 * It never infers an aggregate direction or changes the assessment label.
 */
function buildNewsLageSummary(input = {}) {
  if (!input || typeof input !== "object") return INSUFFICIENT;
  const { topEvents } = input;
  if (!Array.isArray(topEvents)) return INSUFFICIENT;

  const excerpts = [...new Map(topEvents.map(event => {
    let text = String(event?.snippet || event?.title || "");
    if (!event?.snippet && event?.source) {
      const suffix = ` - ${String(event.source)}`;
      if (text.toLocaleLowerCase("de-DE").endsWith(suffix.toLocaleLowerCase("de-DE"))) {
        text = text.slice(0, -suffix.length);
      }
    }
    const content = text.replace(/<[^>]*>/gu, " ")
      .replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/\s+/gu, " ").trim();
    return [content.toLocaleLowerCase("de-DE"), content];
  }).filter(([key]) => key))].slice(0, 3).map(([, content]) => {
    const concise = content.length > 280 ? `${content.slice(0, 277).replace(/\s+\S*$/u, "")}...` : content;
    return /[.!?]$/u.test(concise) ? concise : `${concise}.`;
  });
  return excerpts.length ? excerpts.join(" ") : INSUFFICIENT;
}

module.exports = { buildNewsLageSummary };

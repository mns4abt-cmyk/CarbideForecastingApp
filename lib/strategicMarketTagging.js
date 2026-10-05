"use strict";

// Read-only labels for already validated events. No classification, scoring,
// persistence, or external calls. Array order is stable; each tag appears once.
const { confirmedEntities } = require("./strategicEntities");

function normalize(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/[\p{Pd}_]/gu, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : "";
}

function eventTexts(event) {
  const provenance = event.provenance && typeof event.provenance === "object" ? event.provenance : {};
  const sources = [event.source, provenance.source, ...(Array.isArray(provenance.duplicateSources) ? provenance.duplicateSources : [])]
    .map(normalize).filter(Boolean);
  const titles = [event.title, event.headline, ...(Array.isArray(provenance.duplicateTitles) ? provenance.duplicateTitles : [])];
  // RSS titles can end in " - Publisher". Publisher identity is provenance,
  // not evidence that the event concerns that company or topic.
  const cleanedTitles = titles.filter((title) => typeof title === "string").map((title) => {
    const parts = title.split(/\s+[\p{Pd}|]\s+/u);
    if (parts.length > 1 && sources.includes(normalize(parts.at(-1)))) parts.pop();
    return parts.join(" ");
  });
  return [...cleanedTitles, event.summary, event.snippet].map(normalize).filter(Boolean);
}

function tagStrategicEvent(event, { configuration } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return { entities: [], topics: [] };
  const texts = eventTexts(event);
  // Unicode-aware outer boundaries prevent aliases embedded in other names.
  const matches = (pattern) => texts.some((text) => pattern.test(text));
  // Normalized aliases contain only letters/numbers/spaces: never execute
  // configured text as regex syntax. Preserve Unicode-aware word boundaries.
  const entities = confirmedEntities(configuration).filter(entry => entry.aliases.some(alias =>
    matches(new RegExp(`(?<![\\p{L}\\p{N}])${normalize(alias)}(?![\\p{L}\\p{N}])`, "u"))
  )).map(entry => entry.id);
  const commodity = matches(/\b(?:tungsten|wolfram|wolframcarbid|ammonium paratungstate|ammoniumparawolframat)\b/u);
  const topics = [];
  if (!commodity && !entities.length) return { entities, topics };

  const category = normalize(event.categoryKey || event.category);
  if (texts.some((text) => /\b(?:china|chinese|chinesische[nrsm]?)\b/u.test(text)
    && /\b(?:tungsten carbide|wolframcarbid|wolfram carbid)\b/u.test(text)
    && /\b(?:operators?|producers?|manufacturers?|betreiber|hersteller|produzenten)\b/u.test(text))) {
    topics.push("china_tc_operators");
  }
  const exportControls = matches(/\b(?:export (?:controls?|restrictions?|bans?|licen[cs](?:e|es|ing)|quotas?)|exportbeschränkungen?|exportkontrollen?|ausfuhrverbote?|ausfuhrbeschränkungen?)\b/u);
  if (exportControls) topics.push("export_controls");
  if (matches(/\b(?:production|output|ramp up|produktion|produktionsstart|produktionshochlauf|produktionsstopp|produktionskürzung|förderung|förderbeginn)\b/u)) topics.push("production");
  if (matches(/\b(?:(?:production|processing|smelting|refining|plant|mine|manufacturing) capacity|capacity (?:expansion|increase|reduction|bottleneck|shortage)|produktionskapazität|schmelzkapazität|kapazitätsausbau|kapazitätserweiterung)\b/u)) topics.push("capacity");
  if (matches(/\b(?:offtake|off take|abnahmevertrag|abnahmeverträge|liefervertrag|supply (?:contract|agreement)|purchase agreement)\b/u)) topics.push("offtake");
  if (["supply", "angebot"].includes(category) || ["increase", "decrease"].includes(event.supplyEffect)
    || matches(/\b(?:supply (?:shortage|disruption|expansion|cut|increase)|concentrate shortage|versorgungsengpass|konzentratknappheit)\b/u)) topics.push("supply");
  if (exportControls || ["regulation", "regulierung"].includes(category)
    || matches(/\b(?:regulations?|regulierung|verordnung|tariffs?|zölle)\b/u)) topics.push("regulation");
  if (exportControls || matches(/\b(?:exports?|imports?|exporte|importe|tariffs?|zölle|trade (?:policy|restrictions?|agreement)|handelspolitik)\b/u)) topics.push("trade");
  // demandEffect is deliberately not converted into offtake, supply, or a
  // sentiment score: it does not identify any of the requested topics alone.
  return { entities, topics };
}

// Increment when deterministic tagging rules change; backfill upgrades old rows.
const STRATEGIC_TAGGING_VERSION = "strategic-v1";
module.exports = { tagStrategicEvent, STRATEGIC_TAGGING_VERSION };

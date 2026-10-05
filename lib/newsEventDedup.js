"use strict";

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "news", "tungsten", "mine", "project", "production", "report", "reports", "announces", "starts", "start", "new"]);
const ACTION_PATTERNS = [
  ["analyst_rating", /\b(buy rating|buy recommendation|rates? .{0,40}\bbuy\b|coverage|kursziel|kaufempfehlung|aktiencheck)\b/],
  ["production_ramp", /\b(ramp[ -]?up|commission(?:ed|ing)?|commercial production|production start|produktionsstart|produktionshochlauf|hochlauf)\b/],
  ["mine_restart", /\b(reopen(?:s|ed|ing)?|restart(?:s|ed|ing)?|wiedereröffnung|wiedereröffnet)\b/],
  ["export_restriction", /\b(export controls?|export restrictions?|export licen[cs]e|export ban|export quota|exportbeschränkung|exportkontrolle|ausfuhrbeschränkung|ausfuhrverbot)\b/],
  ["mine_closure", /\b(close[ds]?|closure|shutdown|minenschließung|produktionsstopp)\b/],
  ["exploration", /\b(discovery|drilling|assay|intercept|mineralisation|mineralization|bohrprogramm|bohrung|exploration|entdeckung|mineralisierung)\b/],
  ["study", /\b(study|feasibility|resource target|exploration target|studie|machbarkeitsstudie|ressourcenziel)\b/],
  ["financing", /\b(financing|funding|placement|finanzierung|kapitalerhöhung)\b/],
  ["offtake", /\b(offtake|supply contract|customer agreement|long-term contract|abnahmevertrag|liefervertrag)\b/],
  ["smelting_bottleneck", /\b(smelting (?:capacity )?(?:bottleneck|shortage)|capacity (?:bottleneck|shortage)|schmelz(?:kapazität|engpass))\b/],
  ["supply_shortage", /\b(supply shortage|concentrate shortage|supply bottleneck|versorgungsengpass|konzentratknappheit)\b/],
  ["regulation", /\b(regulation|policy|tariff|sanction|regulierung|verordnung|zoll)\b/],
  ["production", /\b(production|output|produktion|förderung)\b/],
];

function normalizedTitle(article) {
  let title = String(article.title || "").toLowerCase();
  const source = String(article.source || "").toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (source) title = title.replace(new RegExp(`\\s*-\\s*${source}\\s*$`, "i"), "");
  return title.replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(article) {
  return new Set(normalizedTitle(article).split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function similarity(left, right) {
  const a = tokens(left); const b = tokens(right);
  const overlap = [...a].filter((token) => b.has(token));
  const union = new Set([...a, ...b]);
  return { overlap, score: union.size ? overlap.length / union.size : 0 };
}

function closeInTime(left, right) {
  const a = new Date(left.date || left.publishedAt || 0).getTime();
  const b = new Date(right.date || right.publishedAt || 0).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 48 * 60 * 60 * 1000;
}

function veryCloseInTime(left, right) {
  const a = new Date(left.date || left.publishedAt || 0).getTime();
  const b = new Date(right.date || right.publishedAt || 0).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2 * 60 * 60 * 1000;
}

function namedAssets(article) {
  const words = normalizedTitle(article).split(" ");
  const assets = new Set();
  const assetKinds = new Set(["mine", "project", "deposit", "operation", "facility"]);
  for (let index = 0; index < words.length; index += 1) {
    if (!assetKinds.has(words[index])) continue;
    let nameIndex = index - 1;
    while (nameIndex >= 0 && ["tungsten", "wolfram", "the", "a", "an"].includes(words[nameIndex])) nameIndex -= 1;
    const name = words[nameIndex];
    if (name && name.length > 2 && !STOP_WORDS.has(name)) assets.add(`${name} ${words[index]}`);
  }
  return assets;
}

function hasConflictingAssets(left, right) {
  const leftAssets = namedAssets(left); const rightAssets = namedAssets(right);
  return leftAssets.size > 0 && rightAssets.size > 0 && ![...leftAssets].some((asset) => rightAssets.has(asset));
}

function eventFeatures(article) {
  const title = normalizedTitle(article);
  const original = String(article.title || "").toLowerCase();
  const action = ACTION_PATTERNS.find(([, pattern]) => pattern.test(original))?.[0] || "other";
  const asset = [...namedAssets(article)][0] || "";
  const actionTerms = new Set(["buy", "rating", "recommendation", "coverage", "rates", "analyst", "commercial", "ramp", "commissioned", "reopen", "restart", "export", "control", "restriction", "licence", "closure", "shutdown", "discovery", "drilling", "assay", "intercept", "study", "feasibility", "financing", "funding", "offtake", "contract", "regulation", "policy", "tariff", "sanction"]);
  const entity = [...tokens(article)].filter((token) => !asset.split(" ").includes(token) && !actionTerms.has(token)).sort().join(" ");
  return { action, asset, entity, eventStage: article.eventStage || "unclear" };
}

function sameFingerprint(left, right) {
  const a = eventFeatures(left); const b = eventFeatures(right);
  if (a.action !== b.action || a.eventStage !== b.eventStage) return false;
  if (a.asset && b.asset) return a.asset === b.asset;
  if (!a.entity || a.entity !== b.entity) return false;
  if (a.action === "analyst_rating") return true;
  return similarity(left, right).score >= 0.45;
}

function sameEvent(left, right) {
  const leftTitle = normalizedTitle(left); const rightTitle = normalizedTitle(right);
  if (!leftTitle || !rightTitle || !closeInTime(left, right)) return false;
  if (hasConflictingAssets(left, right)) return false;
  if (leftTitle === rightTitle) return true;
  const leftFeatures = eventFeatures(left); const rightFeatures = eventFeatures(right);
  const sameSourceMechanism = String(left.source || "").trim().toLowerCase() === String(right.source || "").trim().toLowerCase()
    && leftFeatures.action === rightFeatures.action
    && leftFeatures.action !== "other"
    && veryCloseInTime(left, right);
  if (sameSourceMechanism) {
    const { overlap, score } = similarity(left, right);
    if (overlap.length >= 3 && score >= 0.35) return true;
  }
  if (sameFingerprint(left, right)) return true;
  const { overlap, score } = similarity(left, right);
  return score >= 0.72 && overlap.length >= 4;
}

function deduplicateEvents(articles) {
  const groups = [];
  for (const article of articles) {
    const group = groups.find((candidate) => sameEvent(candidate[0], article));
    if (group) group.push(article); else groups.push([article]);
  }
  const representatives = groups.map((group, groupIndex) => {
    const representative = [...group].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))[0];
    const sources = [...new Set(group.map((article) => article.source).filter(Boolean))];
    const titles = [...new Set(group.map((article) => article.title).filter(Boolean))];
    const eventId = `event-${groupIndex + 1}`;
    representative.eventId = eventId;
    representative.duplicateCount = group.length;
    representative.duplicateSources = sources;
    representative.duplicateTitles = titles;
    group.filter((article) => article !== representative).forEach((article) => {
      article.duplicateOf = representative.id;
      article.duplicateGroupId = eventId;
    });
    return representative;
  });
  return { representatives, groups };
}

module.exports = { deduplicateEvents, normalizedTitle, eventFeatures, namedAssets, hasConflictingAssets, sameEvent };

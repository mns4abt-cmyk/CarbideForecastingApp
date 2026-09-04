"use strict";
const { detectConcreteMarketEvent } = require("./newsConcreteEvent");

// Stage A of the local-first news pipeline. This intentionally relies only on
// article metadata already supplied by the news adapters: it is deterministic,
// explainable, and makes no network or model calls.
const ACCEPTANCE_THRESHOLD = 0.60;

const STRONG_ENTITIES = [
  { term: "ammonium paratungstate", pattern: /\bammonium\s+paratungstate\b/i },
  { term: "tungsten carbide", pattern: /\btungsten\s+carbide\b/i },
  { term: "tungsten concentrate", pattern: /\btungsten\s+concentrate\b/i },
  { term: "tungsten", pattern: /\btungsten\b/i },
  { term: "scheelite", pattern: /\bscheelite\b/i },
  { term: "wolframite", pattern: /\bwolframite\b/i },
];

const WOLFRAM_PATTERN = /\bwolfram\b/i;
const WOLFRAM_COMMODITY_CONTEXT = /\bwolfram[ -]?(?:preis|markt|versorgung|mine|bergbau|produktion|förderung|lagerstätte|projekt|export|lieferkette|lieferung|vertrag|liefervertrag|abnahmevertrag|carbid)\b|\b(rohstoff|metall|bergbau|mineral(?:isierung|isation)?|mine|mining|production|produktion|förderung|commodity|material|market|preis|price|supply|versorgung|export|vertrag|liefervertrag|abnahmevertrag|lieferung)\b/i;
const INVESTOR_NOISE_PATTERN = /\b(aktie|aktiencheck|aktien im check|kaufempfehlung|kursziel|kursfantasie|anleger|buy rating|buy recommendation|analyst coverage|coverage initiation|price target|stock|share price|investor story|stock momentum|market movers|stock movers|stocks to watch|share-price roundup|analyst roundup)\b/i;
const PROMOTIONAL_MARKET_PATTERN = /\b(market size|market research|market report|market forecast|marktgröße|marktvolumen|marktstudie|marktforschung)\b/i;

const THEMES = [
  { name: "supply", pattern: /\b(mine|mining|production|output|concentrate|smelter|processing|refinery|shortage|disruption|closure|inventory|stockpile|mine|bergbau|produktion|förderung|konzentrat|schmelze|raffinerie|knappheit|störung|minenschließung)\b/i },
  { name: "trade_china", pattern: /\b(china|chinese|export|export control|export restriction|export licen[cs]e|quota|customs|ministry of commerce|mofcom|china|ausfuhr|exportbeschränkung|exportkontrolle)\b/i },
  { name: "regulation", pattern: /\b(tariff|sanction|regulation|critical raw materials|strategic raw materials|eu|european commission|zoll|sanktion|regulierung|kritische rohstoffe)\b/i },
  { name: "demand", pattern: /\b(tungsten carbide|cutting tools|tooling|aerospace|defen[cs]e|automotive|semiconductor|electronics|industrial demand)\b/i },
  { name: "price_market", pattern: /\b(price|pricing|premium|market|supply[ -]?demand|availability|preis|markt|versorgung|verfügbarkeit)\b/i },
];

// "APT" is also a common cybersecurity acronym. It is a tungsten entity only
// when its nearby context provides a commodity/industrial interpretation.
const APT_PATTERN = /\bapt\b/ig;
const APT_CONTEXT_PATTERN = /\b(tungsten|wolfram|ammonium paratungstate|mine|mining|production|concentrate|carbide|commodity|price|pricing|market|supply|smelter|processing|refinery)\b/i;
const COMMODITY_LIST_PATTERN = /\b(tungsten|wolfram|gold|silver|copper|tin|zinc|nickel|lithium|cobalt|iron ore)\b/ig;

function safeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stripPublisherSuffix(title, source) {
  const safeTitle = safeText(title);
  const safeSource = safeText(source).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (safeSource) return safeTitle.replace(new RegExp(`\\s*-\\s*${safeSource}\\s*$`, "i"), "").trim();
  return safeTitle;
}

function hasAptInMarketContext(text) {
  let match;
  APT_PATTERN.lastIndex = 0;
  while ((match = APT_PATTERN.exec(text))) {
    const start = Math.max(0, match.index - 100);
    const end = Math.min(text.length, match.index + match[0].length + 100);
    if (APT_CONTEXT_PATTERN.test(text.slice(start, end))) return true;
  }
  return false;
}

function matchTerms(text) {
  const matched = STRONG_ENTITIES.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
  if (WOLFRAM_PATTERN.test(text) && WOLFRAM_COMMODITY_CONTEXT.test(text)) matched.push("wolfram (commodity context)");
  if (hasAptInMarketContext(text)) matched.push("APT (tungsten-market context)");
  return matched;
}

function matchThemes(text) {
  return THEMES.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

function looksLikeCommodityList(text) {
  const terms = new Set();
  COMMODITY_LIST_PATTERN.lastIndex = 0;
  let match;
  while ((match = COMMODITY_LIST_PATTERN.exec(text))) terms.add(match[0].toLowerCase());
  return terms.size >= 3;
}

function evaluateArticleRelevance(article = {}) {
  const title = stripPublisherSuffix(article.title, article.source);
  const snippet = safeText(article.snippet);
  const titleTerms = matchTerms(title);
  const snippetTerms = matchTerms(snippet);
  const titleThemes = matchThemes(title);
  const snippetThemes = matchThemes(snippet);
  const matchedTerms = [...new Set([...titleTerms, ...snippetTerms])];
  const matchedThemes = [...new Set([...titleThemes, ...snippetThemes])];
  const commodityList = looksLikeCommodityList(`${title} ${snippet}`);
  const allText = `${title} ${snippet}`;
  const wolframDisambiguated = WOLFRAM_PATTERN.test(allText) && !WOLFRAM_COMMODITY_CONTEXT.test(allText);
  const concreteEvent = detectConcreteMarketEvent(allText).hasConcreteEvent;
  const pureInvestorNoise = INVESTOR_NOISE_PATTERN.test(allText);
  const purePromotionalNoise = PROMOTIONAL_MARKET_PATTERN.test(allText);
  const investorNoise = pureInvestorNoise && !concreteEvent;
  const promotionalNoise = purePromotionalNoise && !concreteEvent;

  // An entity in the title is stronger evidence than one found only in a feed
  // summary. Themes are supporting evidence, capped so a generic mining/finance
  // article cannot pass without a direct tungsten-market entity.
  const entityScore = commodityList ? 0.15 : (titleTerms.length ? 0.45 : 0) + (snippetTerms.length ? 0.40 : 0);
  const themeScore = (titleThemes.length ? 0.22 : 0) + (snippetThemes.length ? 0.12 : 0);
  const score = Math.min(1, Math.round((entityScore + themeScore) * 100) / 100);
  const hasDirectEntity = matchedTerms.length > 0;
  // Explicit precedence: no commodity entity never passes; a concrete market
  // event neutralizes a stock/investor wrapper; otherwise pure wrapper noise is
  // rejected before ordinary threshold scoring.
  let accepted = false;
  if (!hasDirectEntity) accepted = false;
  else if (concreteEvent) accepted = score >= ACCEPTANCE_THRESHOLD;
  else if (investorNoise || promotionalNoise) accepted = false;
  else accepted = score >= ACCEPTANCE_THRESHOLD;
  const reasons = [];

  if (titleTerms.length) reasons.push("direct tungsten-market entity in title");
  if (snippetTerms.length) reasons.push("direct tungsten-market entity in snippet");
  if (titleThemes.length) reasons.push(`market theme in title: ${titleThemes.join(", ")}`);
  if (snippetThemes.length) reasons.push(`market theme in snippet: ${snippetThemes.join(", ")}`);
  if (commodityList) reasons.push("tungsten appears in a multi-commodity list without specific market evidence");
  if (wolframDisambiguated) reasons.push("Wolfram appears without commodity/material context and was treated as ambiguous");
  if (investorNoise) reasons.push("pure investor or analyst content without a concrete tungsten-market event");
  if (promotionalNoise) reasons.push("generic promotional market-size content without a concrete tungsten-market event");
  if (!hasDirectEntity) reasons.push("no direct tungsten-market entity");
  if (hasDirectEntity && score < ACCEPTANCE_THRESHOLD) reasons.push("insufficient market context for conservative threshold");

  return { accepted, score, matchedTerms, matchedThemes, reasons, relevanceDisambiguated: wolframDisambiguated, concreteEvent, investorNoise, promotionalNoise };
}

function filterArticlesByRelevance(articles) {
  const evaluated = (Array.isArray(articles) ? articles : []).map((article) => ({
    ...article,
    relevance: evaluateArticleRelevance(article),
  }));
  return {
    accepted: evaluated.filter((article) => article.relevance.accepted),
    rejected: evaluated.filter((article) => !article.relevance.accepted),
  };
}

module.exports = { ACCEPTANCE_THRESHOLD, evaluateArticleRelevance, filterArticlesByRelevance, stripPublisherSuffix };

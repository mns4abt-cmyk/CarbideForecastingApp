"use strict";

// Small NewsSource-compatible adapter. Future sources implement the same
// id/kind/enabled/fetch({ timeoutMs, limit }) shape without changing server.js.
const GOOGLE_NEWS_QUERIES = [
  { query: "tungsten", language: "en", region: "US" },
  { query: "wolfram", language: "de", region: "DE" },
  { query: "\"ammonium paratungstate\"", language: "en", region: "US" },
  { query: "\"tungsten carbide\"", language: "en", region: "US" },
  { query: "\"tungsten mine\" production", language: "en", region: "US" },
  { query: "\"tungsten concentrate\" supply", language: "en", region: "US" },
  { query: "China tungsten export", language: "en", region: "US" },
  { query: "\"tungsten export control\"", language: "en", region: "US" },
  { query: "tungsten cutting tools", language: "en", region: "US" },
  { query: "tungsten critical raw materials", language: "en", region: "US" },
].map((query) => ({
  ...query,
  url: `https://news.google.com/rss/search?q=${encodeURIComponent(query.query)}%20when%3A30d&hl=${query.language}-${query.region}&gl=${query.region}&ceid=${query.region}:${query.language}`,
}));

function decodeEntities(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function stripHtml(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractTag(block, tag) {
  const match = new RegExp(String.raw`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "i").exec(block);
  if (!match) return "";
  const value = match[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
  return decodeEntities(value).trim();
}

function parseRss(xml, language, sourceId = "google-news", sourceName = "Google News") {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml))) {
    const block = match[1];
    const title = extractTag(block, "title");
    if (!title) continue;
    const description = extractTag(block, "description");
    articles.push({
      title,
      url: extractTag(block, "link"),
      source: extractTag(block, "source") || sourceName,
      publishedAt: extractTag(block, "pubDate"),
      snippet: description ? stripHtml(description) : "",
      language,
      sourceId,
    });
  }
  return articles;
}

function parseAtom(xml, language, sourceId, sourceName) {
  const articles = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const title = stripHtml(extractTag(block, "title"));
    if (!title) continue;
    const linkMatch = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
    const summary = extractTag(block, "summary") || extractTag(block, "content");
    const authorBlock = extractTag(block, "author");
    articles.push({
      title,
      url: linkMatch ? decodeEntities(linkMatch[1]) : "",
      source: stripHtml(extractTag(authorBlock, "name")) || sourceName,
      publishedAt: extractTag(block, "updated") || extractTag(block, "published"),
      snippet: summary ? stripHtml(summary) : "",
      language,
      sourceId,
    });
  }
  return articles;
}

function parseDirectFeed(xml, config) {
  if (/<rss\b|<channel\b/i.test(xml)) return parseRss(xml, config.language || "", config.id, config.sourceName || config.id);
  if (/<feed\b/i.test(xml)) return parseAtom(xml, config.language || "", config.id, config.sourceName || config.id);
  throw new Error("invalid feed XML");
}

function sanitizeError(error) {
  if (error?.name === "AbortError") return "request timed out";
  return "request failed";
}

class GoogleNewsSource {
  constructor({ fetch, dispatcher, transportFor, enabled = true } = {}) {
    if (typeof fetch !== "function") throw new TypeError("GoogleNewsSource requires fetch");
    this.id = "google-news";
    this.kind = "rss";
    this.enabled = enabled;
    this.fetchImpl = fetch;
    this.dispatcher = dispatcher;
    this.transportFor = transportFor;
    this.health = { id: this.id, reachable: false, lastSuccessfulFetch: null, fetchedCount: 0, error: null };
  }

  async fetch({ timeoutMs = 15000, limit = 20 } = {}) {
    if (!this.enabled) return { articles: [], health: { ...this.health, error: "disabled" } };
    const all = [];
    const errors = [];
    const queryDiagnostics = [];
    for (const query of GOOGLE_NEWS_QUERIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const diagnostic = { query: query.query, httpStatus: null, rawRssItemCount: 0, parsedItemCount: 0, newestArticleDate: null, error: null };
      try {
        const response = await this.fetchImpl(query.url, { dispatcher: this.dispatcher, signal: controller.signal });
        diagnostic.httpStatus = response.status;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const xml = await response.text();
        diagnostic.rawRssItemCount = (xml.match(/<item\b/gi) || []).length;
        const parsed = parseRss(xml, query.language);
        diagnostic.parsedItemCount = parsed.length;
        diagnostic.newestArticleDate = parsed.map((article) => article.publishedAt)
          .sort((a, b) => new Date(b) - new Date(a))[0] || null;
        all.push(...parsed);
      } catch (error) {
        errors.push(sanitizeError(error));
        diagnostic.error = sanitizeError(error);
      } finally {
        clearTimeout(timer);
        queryDiagnostics.push(diagnostic);
      }
    }
    const seen = new Set();
    const articles = all.filter((article) => {
      const key = article.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, limit);

    const transportState = this.transportFor ? this.transportFor(GOOGLE_NEWS_QUERIES[0].url) : null;
    this.health = {
      id: this.id,
      reachable: errors.length < GOOGLE_NEWS_QUERIES.length,
      lastSuccessfulFetch: errors.length < GOOGLE_NEWS_QUERIES.length ? new Date().toISOString() : this.health.lastSuccessfulFetch,
      fetchedCount: articles.length,
      error: errors.length ? (errors.length === GOOGLE_NEWS_QUERIES.length ? errors[0] : "some requests failed") : null,
      ...(transportState || {}),
    };
    return { articles, health: { ...this.health }, queryDiagnostics };
  }
}

class DirectFeedSource {
  constructor(config, { fetch, dispatcher, transportFor } = {}) {
    if (typeof fetch !== "function") throw new TypeError("DirectFeedSource requires fetch");
    this.id = config.id;
    this.kind = config.kind;
    this.enabled = Boolean(config.enabled);
    this.config = config;
    this.fetchImpl = fetch;
    this.dispatcher = dispatcher;
    this.transportFor = transportFor;
    this.health = { id: this.id, reachable: false, lastSuccessfulFetch: null, fetchedCount: 0, error: null };
  }

  async fetch({ timeoutMs = 15000, limit = 20 } = {}) {
    if (!this.enabled) return { articles: [], health: { ...this.health, error: "disabled" } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (!this.config.url) throw new Error("missing feed URL");
      const response = await this.fetchImpl(this.config.url, { dispatcher: this.dispatcher, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const articles = parseDirectFeed(await response.text(), this.config).slice(0, limit);
      this.health = {
        id: this.id, reachable: true, lastSuccessfulFetch: new Date().toISOString(), fetchedCount: articles.length, error: null,
        ...(this.transportFor ? this.transportFor(this.config.url) : {}),
      };
      return { articles, health: { ...this.health } };
    } catch (error) {
      this.health = {
        ...this.health, reachable: false, fetchedCount: 0, error: sanitizeError(error),
        ...(this.transportFor ? this.transportFor(this.config.url) : {}),
      };
      return { articles: [], health: { ...this.health } };
    } finally { clearTimeout(timer); }
  }
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    [...url.searchParams.keys()].filter((key) => /^utm_/i.test(key)).forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch { return ""; }
}

function mergeArticles(results, limit = 20) {
  const seen = new Set();
  const merged = [];
  for (const article of results.flatMap((result) => result.articles)) {
    const urlKey = canonicalUrl(article.url);
    const titleKey = article.title.toLowerCase().replace(/\s+/g, " ").trim();
    const key = urlKey ? `url:${urlKey}` : `title:${titleKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(article);
  }
  return merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, limit);
}

function createConfiguredSources(config, dependencies) {
  return (config.sources || []).map((entry) => {
    if (entry.kind === "google-news") return new GoogleNewsSource({ ...dependencies, enabled: entry.enabled !== false });
    if (entry.kind === "rss" || entry.kind === "atom") return new DirectFeedSource(entry, dependencies);
    return null;
  }).filter(Boolean);
}

async function fetchConfiguredNewsSources(config, dependencies, { timeoutMs = 15000, limit = 20 } = {}) {
  const sources = createConfiguredSources(config, dependencies).filter((source) => source.enabled);
  const results = await Promise.all(sources.map((source) => source.fetch({ timeoutMs, limit })));
  return { articles: mergeArticles(results, limit), health: results.map((result) => result.health) };
}

module.exports = { GoogleNewsSource, DirectFeedSource, GOOGLE_NEWS_QUERIES, parseRss, parseAtom, mergeArticles, fetchConfiguredNewsSources };

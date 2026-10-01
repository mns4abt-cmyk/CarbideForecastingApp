"use strict";

// Local-only operational diagnostic. It uses the same configured adapters,
// normalization, merge/deduplication, and deterministic relevance filter as a
// refresh, but never calls forecasting or an LLM.
const fs = require("fs");
const path = require("path");
const { GoogleNewsSource, DirectFeedSource, mergeArticles } = require("../lib/newsSources");
const { createNewsTransport } = require("../lib/newsTransport");
const { filterArticlesByRelevance } = require("../lib/newsRelevance");

const appDir = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(appDir, "config", "news-sources.json"), "utf8"));
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
let fetchImpl = globalThis.fetch;
let dispatcher;
try {
  // Match server.js when dependencies are installed, including explicit proxy
  // support. Node's built-in fetch keeps this diagnostic usable before npm install.
  const { fetch, ProxyAgent } = require("undici");
  fetchImpl = fetch;
  dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
} catch {
  if (proxyUrl) console.error("undici is not installed; diagnostic is running without explicit proxy support.");
}
const newsTransport = createNewsTransport({ fetch: fetchImpl, dispatcher });
const dependencies = { fetch: newsTransport.fetch, transportFor: newsTransport.transportFor };

function instantiate(entry) {
  if (entry.kind === "google-news") return new GoogleNewsSource({ ...dependencies, enabled: entry.enabled !== false });
  if (entry.kind === "rss" || entry.kind === "atom") return new DirectFeedSource(entry, dependencies);
  return null;
}

function newestArticleDate(articles) {
  return articles.map((article) => article.publishedAt)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;
}

function articleView(article) {
  return {
    title: article.title,
    publisher: article.source,
    date: article.publishedAt,
    sourceId: article.sourceId,
    relevanceScore: article.relevance.score,
    matchedTerms: article.relevance.matchedTerms,
    matchedThemes: article.relevance.matchedThemes,
    reasons: article.relevance.reasons,
  };
}

async function main() {
  const sources = config.sources.filter((entry) => entry.enabled !== false).map(instantiate).filter(Boolean);
  const results = await Promise.all(sources.map((source) => source.fetch({ timeoutMs: 15000, limit: 50 })));
  const perSource = results.map((result, index) => {
    const filtered = filterArticlesByRelevance(result.articles);
    return {
      id: sources[index].id,
      reachable: result.health.reachable,
      fetchedCount: result.health.fetchedCount,
      newestArticleDate: newestArticleDate(result.articles),
      error: result.health.error,
      relevantCount: filtered.accepted.length,
      rejectedCount: filtered.rejected.length,
      proxyConfigured: result.health.proxyConfigured,
      proxyAuthMode: result.health.proxyAuthMode,
      transport: result.health.transport,
      queryDiagnostics: result.queryDiagnostics || undefined,
    };
  });
  const merged = mergeArticles(results, 200);
  const filtered = filterArticlesByRelevance(merged);
  const closestRejectedGoogle = results
    .flatMap((result) => result.articles)
    .filter((article) => article.sourceId === "google-news")
    .map((article) => ({ ...article, relevance: filterArticlesByRelevance([article]).rejected[0]?.relevance }))
    .filter((article) => article.relevance)
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, 10)
    .map(articleView);

  console.log(JSON.stringify({
    perSource,
    totals: {
      fetched: results.reduce((sum, result) => sum + result.articles.length, 0),
      deduplicated: merged.length,
      relevant: filtered.accepted.length,
      rejected: filtered.rejected.length,
    },
    accepted: filtered.accepted.slice(0, 15).map(articleView),
    closestRejectedGoogle,
  }, null, 2));
}

main().catch((error) => {
  console.error("News diagnostic failed:", error?.message || "request failed");
  process.exitCode = 1;
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { GoogleNewsSource, DirectFeedSource, GOOGLE_NEWS_QUERIES, parseRss, parseAtom, fetchConfiguredNewsSources, mergeArticles } = require("../lib/newsSources");

const XML = `<?xml version="1.0"?><rss><channel><item>
<title><![CDATA[Tungsten &amp; APT update]]></title><link>https://example.test/article</link>
<pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><source>Example Source</source>
<description><![CDATA[<p>APT <b>supply</b> &amp; policy update.</p>]]></description>
</item></channel></rss>`;

test("RSS parsing returns normalized source-compatible articles and preserves a safe snippet", () => {
  const [article] = parseRss(XML, "en");
  assert.deepEqual(article, {
    title: "Tungsten & APT update",
    url: "https://example.test/article",
    source: "Example Source",
    publishedAt: "Mon, 01 Sep 2026 10:00:00 GMT",
    snippet: "APT supply & policy update.",
    language: "en",
    sourceId: "google-news",
  });
});

test("one failed Google query is isolated and does not discard successful articles", async () => {
  let calls = 0;
  const source = new GoogleNewsSource({ fetch: async () => {
    calls++;
    if (calls === 1) return { ok: true, text: async () => XML };
    throw new Error("proxy credentials must not leak");
  }});
  const result = await source.fetch({ timeoutMs: 10 });
  assert.equal(result.articles.length, 1);
  assert.equal(result.health.reachable, true);
  assert.equal(result.health.error, "some requests failed");
});

test("production Google queries are tungsten-specific and exclude broad generic discovery queries", () => {
  assert.ok(GOOGLE_NEWS_QUERIES.length >= 18 && GOOGLE_NEWS_QUERIES.length <= 24);
  for (const query of GOOGLE_NEWS_QUERIES) {
    assert.match(query.query, /tungsten|wolfram|ammonium paratungstate/i, query.query);
    assert.doesNotMatch(query.query, /mining stocks|commodity markets|china markets|industrial metals/i, query.query);
  }
});

test("company discovery queries stay commodity-qualified and cover every watchlist entity", () => {
  const companyQueries = [
    "Almonty tungsten", "Almonty wolfram", "Masan tungsten", "Masan High-Tech Materials tungsten",
    "Xiamen Golden Egret tungsten", "Golden Egret tungsten", "Jinlu tungsten",
    "Treibacher tungsten", "Treibacher wolfram", "H.C. Starck tungsten", "HC Starck tungsten", "HC Starck wolfram",
  ];
  assert.deepEqual(GOOGLE_NEWS_QUERIES.filter(entry => companyQueries.includes(entry.query)).map(entry => entry.query), companyQueries);
  for (const query of companyQueries) assert.match(query, /\b(?:tungsten|wolfram)\b/i, query);
});

test("Google source returns safe per-query RSS diagnostics", async () => {
  const source = new GoogleNewsSource({ fetch: async () => ({ status: 200, ok: true, text: async () => XML }) });
  const result = await source.fetch();
  assert.equal(result.queryDiagnostics.length, GOOGLE_NEWS_QUERIES.length);
  assert.deepEqual(result.queryDiagnostics[0], {
    query: GOOGLE_NEWS_QUERIES[0].query,
    httpStatus: 200,
    rawRssItemCount: 1,
    parsedItemCount: 1,
    newestArticleDate: "Mon, 01 Sep 2026 10:00:00 GMT",
    error: null,
  });
});

test("timeout/failure returns empty articles and sanitized health instead of throwing", async () => {
  const source = new GoogleNewsSource({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("secret"), { name: "AbortError" })));
  }) });
  const result = await source.fetch({ timeoutMs: 1 });
  assert.deepEqual(result.articles, []);
  assert.equal(result.health.reachable, false);
  assert.equal(result.health.error, "request timed out");
});

test("server delegates Google RSS parsing to the adapter", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /fetchConfiguredNewsSources/);
  assert.doesNotMatch(source, /function parseRss/);
  assert.doesNotMatch(source, /RSS_QUERIES/);
});

test("Atom parsing normalizes title, alternate link, author, and HTML summary", () => {
  const atom = `<feed><entry><title>Wolfram policy</title><link rel="alternate" href="https://example.test/a"/>
    <updated>2026-09-01T10:00:00Z</updated><author><name>EU Source</name></author>
    <summary><![CDATA[<b>Policy</b> update]]></summary></entry></feed>`;
  const [article] = parseAtom(atom, "en", "direct", "Fallback");
  assert.deepEqual(article, { title: "Wolfram policy", url: "https://example.test/a", source: "EU Source", publishedAt: "2026-09-01T10:00:00Z", snippet: "Policy update", language: "en", sourceId: "direct" });
});

test("configured sources skip disabled entries and isolate a failed direct feed", async () => {
  const config = { sources: [
    { id: "google-news", kind: "google-news", enabled: false },
    { id: "bad", kind: "rss", enabled: true, url: "https://bad.test", sourceName: "Bad" },
    { id: "good", kind: "atom", enabled: true, url: "https://good.test", sourceName: "Good", language: "en" },
  ] };
  const atom = `<feed><entry><title>APT update</title><link href="https://good.test/article"/><updated>2026-09-01T00:00:00Z</updated></entry></feed>`;
  const result = await fetchConfiguredNewsSources(config, { fetch: async (url) => {
    if (url.includes("bad")) throw new Error("failed");
    return { ok: true, text: async () => atom };
  } });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].sourceId, "good");
  assert.equal(result.health.length, 2);
});

test("cross-source merge deduplicates canonical URLs first and normalized titles as fallback", () => {
  const article = (overrides) => ({ title: "Tungsten update", url: "", source: "x", publishedAt: "2026-09-01", snippet: "", language: "en", sourceId: "x", ...overrides });
  const merged = mergeArticles([
    { articles: [article({ url: "https://example.test/a?utm_source=x" }), article({ url: "https://example.test/a" })] },
    { articles: [article({ title: "  tungsten   update ", sourceId: "y" }), article({ title: "TUNGSTEN update", sourceId: "z" })] },
  ]);
  assert.equal(merged.length, 2);
});

test("all configured sources unavailable returns an empty list safely", async () => {
  const source = new DirectFeedSource({ id: "bad", kind: "rss", enabled: true, url: "https://bad.test" }, { fetch: async () => { throw new Error("failed"); } });
  const result = await source.fetch();
  assert.deepEqual(result.articles, []);
  assert.equal(result.health.reachable, false);
});

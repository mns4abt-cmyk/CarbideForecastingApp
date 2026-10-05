"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GoogleNewsSource } = require("../lib/newsSources");
const { createNewsTransport, shouldBypassProxy } = require("../lib/newsTransport");

const PROXY_ENV = {
  HTTPS_PROXY: "http://rb-proxy-de.bosch.com:8080",
  NO_PROXY: "rb-omscloudasl4.server.bosch.com,127.0.0.*,localhost",
};
const XML = "<rss><channel><item><title>Tungsten update</title><link>https://example.test/a</link><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>";

test("Windows corporate proxy selects curl Negotiate transport with redirect following", async () => {
  let invocation;
  const transport = createNewsTransport({
    fetch: async () => { throw new Error("Node transport should not be used"); },
    env: PROXY_ENV,
    platform: "win32",
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: `${XML}\n__NEWS_HTTP_STATUS__:200`, stderr: "" };
    },
  });

  assert.deepEqual(transport.transportFor("https://news.google.com/rss/search?q=tungsten"), {
    transport: "windows-curl-fallback", proxyConfigured: true, proxyAuthMode: "negotiate",
  });
  const response = await transport.fetch("https://news.google.com/rss/search?q=tungsten", { timeoutMs: 15000 });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), XML);
  assert.equal(invocation.file, "curl.exe");
  assert.ok(invocation.args.includes("--location"));
  assert.ok(invocation.args.includes("--proxy-negotiate"));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--user") + 1, invocation.args.indexOf("--user") + 2), [":"]);
  assert.equal(invocation.args.includes("--proxy-user"), false);
  assert.equal(invocation.args.includes("--header"), false);
  assert.equal(invocation.options.shell, undefined);
});

test("non-Windows proxy requests retain the Node fetch and dispatcher behavior", async () => {
  const dispatcher = { name: "existing-undici-dispatcher" };
  let received;
  const transport = createNewsTransport({
    fetch: async (_url, options) => {
      received = options;
      return { status: 200, ok: true, text: async () => XML };
    },
    dispatcher,
    env: PROXY_ENV,
    platform: "linux",
  });

  const response = await transport.fetch("https://news.google.com/rss/search?q=tungsten");
  assert.equal(response.ok, true);
  assert.equal(received.dispatcher, dispatcher);
  assert.deepEqual(transport.transportFor("https://news.google.com/rss/search?q=tungsten"), {
    transport: "node", proxyConfigured: true, proxyAuthMode: "none",
  });
});

test("localhost, loopback, and configured NO_PROXY hosts bypass the proxy", async () => {
  const calls = [];
  const transport = createNewsTransport({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, text: async () => "" };
    },
    dispatcher: { proxy: true },
    env: PROXY_ENV,
    platform: "win32",
    execFileImpl: async () => { throw new Error("curl should not run for bypassed hosts"); },
  });

  for (const url of ["http://localhost:11434/api/tags", "http://127.0.0.1:11434/api/tags", "https://rb-omscloudasl4.server.bosch.com/api"]) {
    await transport.fetch(url);
    assert.equal(transport.transportFor(url).transport, "node");
    assert.equal(transport.transportFor(url).proxyAuthMode, "not_applicable");
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.dispatcher === undefined));
  assert.equal(shouldBypassProxy("http://127.0.0.42:11434", PROXY_ENV.NO_PROXY), true);
});

test("authenticated proxy failure remains isolated and news normalization shape is unchanged", async () => {
  const transport = createNewsTransport({
    fetch: async () => { throw new Error("Node transport should not be used"); },
    env: PROXY_ENV,
    platform: "win32",
    execFileImpl: async () => { throw new Error("proxy negotiation failed"); },
  });
  const source = new GoogleNewsSource({ fetch: transport.fetch, transportFor: transport.transportFor });
  const result = await source.fetch({ timeoutMs: 5, limit: 2 });
  assert.deepEqual(result.articles, []);
  assert.equal(result.health.reachable, false);
  assert.equal(result.health.error, "request failed");
  assert.equal(result.health.transport, "windows-curl-fallback");
  assert.equal(result.health.proxyAuthMode, "negotiate");
});

test("transport diagnostics never log credentials or proxy authorization tokens", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const transport = createNewsTransport({
      fetch: async () => ({ status: 200, ok: true, text: async () => "" }),
      env: PROXY_ENV,
      platform: "win32",
      execFileImpl: async () => ({ stdout: "\n__NEWS_HTTP_STATUS__:200", stderr: "Proxy-Authorization: secret" }),
    });
    await transport.fetch("https://news.google.com/rss/search?q=tungsten");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(logs, []);
});

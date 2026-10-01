"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const STATUS_MARKER = "\n__NEWS_HTTP_STATUS__:";

function proxyFromEnv(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
}

function noProxyFromEnv(env = process.env) {
  return env.NO_PROXY || env.no_proxy || "";
}

function noProxyMatches(hostname, port, noProxy = "") {
  const host = hostname.toLowerCase();
  return noProxy.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === "*") return true;
    const token = entry.replace(/^\./, "");
    const [tokenHost, tokenPort] = token.split(":");
    if (tokenPort && tokenPort !== port) return false;
    if (tokenHost.endsWith("*")) return host.startsWith(tokenHost.slice(0, -1));
    return host === tokenHost || host.endsWith(`.${tokenHost}`);
  });
}

function shouldBypassProxy(url, noProxy = "") {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.")
    || noProxyMatches(host, target.port || (target.protocol === "https:" ? "443" : "80"), noProxy);
}

function createCurlResponse(stdout, stderr, url) {
  const markerIndex = stdout.lastIndexOf(STATUS_MARKER);
  if (markerIndex < 0) throw new Error("curl response did not include an HTTP status");
  const status = Number(stdout.slice(markerIndex + STATUS_MARKER.length).trim());
  if (!Number.isInteger(status)) throw new Error("curl returned an invalid HTTP status");
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    text: async () => stdout.slice(0, markerIndex),
    _stderr: stderr,
  };
}

function createWindowsCurlFetch({ proxyUrl, execFileImpl = execFileAsync } = {}) {
  return async function windowsCurlFetch(url, { signal, timeoutMs = 15000 } = {}) {
    const args = [
      "--silent", "--show-error", "--location", "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "--proxy", proxyUrl,
      "--proxy-negotiate", "--user", ":",
      "--write-out", `${STATUS_MARKER}%{http_code}`,
      url,
    ];
    try {
      const { stdout, stderr } = await execFileImpl("curl.exe", args, {
        windowsHide: true,
        signal,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return createCurlResponse(stdout, stderr, url);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error("authenticated proxy request failed");
    }
  };
}

function createNewsTransport({ fetch, dispatcher, env = process.env, platform = process.platform, execFileImpl } = {}) {
  if (typeof fetch !== "function") throw new TypeError("createNewsTransport requires fetch");
  const proxyUrl = proxyFromEnv(env);
  const noProxy = noProxyFromEnv(env);
  const curlFetch = platform === "win32" && proxyUrl
    ? createWindowsCurlFetch({ proxyUrl, execFileImpl })
    : null;

  function transportFor(url) {
    if (!proxyUrl || shouldBypassProxy(url, noProxy)) return { transport: "node", proxyConfigured: Boolean(proxyUrl), proxyAuthMode: "not_applicable" };
    if (curlFetch) return { transport: "windows-curl-fallback", proxyConfigured: true, proxyAuthMode: "negotiate" };
    return { transport: "node", proxyConfigured: true, proxyAuthMode: "none" };
  }

  return {
    fetch: async (url, options = {}) => {
      const state = transportFor(url);
      if (state.transport === "windows-curl-fallback") {
        return curlFetch(url, { signal: options.signal, timeoutMs: options.timeoutMs });
      }
      return fetch(url, { ...options, dispatcher: shouldBypassProxy(url, noProxy) ? undefined : dispatcher });
    },
    transportFor,
  };
}

module.exports = { createNewsTransport, createWindowsCurlFetch, noProxyMatches, shouldBypassProxy };

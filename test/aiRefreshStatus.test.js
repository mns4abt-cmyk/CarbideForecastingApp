"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveClassificationStatus } = require("../lib/aiRefreshStatus");
const { pillState } = require("../public/js/aiStatus");

test("reachable provider with successful classifications is active", () => {
  assert.equal(deriveClassificationStatus({ providerAvailable: true, selectedCount: 3, classifiedCount: 3, failedBatches: 0 }), "success");
  assert.deepEqual(pillState({ aiProviderAvailable: true, classificationStatus: "success" }), { text: "KI-Kommentierung aktiv", off: false });
});

test("partial batch failure does not mark the provider inactive", () => {
  assert.equal(deriveClassificationStatus({ providerAvailable: true, selectedCount: 6, classifiedCount: 3, failedBatches: 1 }), "partial");
  assert.deepEqual(pillState({ aiProviderAvailable: true, classificationStatus: "partial" }), { text: "KI-Kommentierung teilweise aktiv", off: false });
});

test("no relevant articles is distinct from Ollama unavailability", () => {
  assert.equal(deriveClassificationStatus({ providerAvailable: true, selectedCount: 0, classifiedCount: 0, failedBatches: 0 }), "no_input");
  assert.deepEqual(pillState({ aiProviderAvailable: true, classificationStatus: "no_input" }), { text: "KI-Kommentierung bereit", off: false });
});

test("a true connection failure is inactive", () => {
  assert.equal(deriveClassificationStatus({ providerAvailable: false, selectedCount: 3, classifiedCount: 0, failedBatches: 0 }), "unavailable");
  assert.deepEqual(pillState({ aiProviderAvailable: false, classificationStatus: "unavailable" }), { text: "KI-Kommentierung inaktiv", off: true });
});

test("cached classifications do not mask a currently unavailable provider", () => {
  assert.deepEqual(pillState({ aiProviderAvailable: false, classificationStatus: "success" }), { text: "KI-Kommentierung inaktiv", off: true });
});

test("a complete classification failure is not presented as active", () => {
  assert.equal(deriveClassificationStatus({ providerAvailable: true, selectedCount: 3, classifiedCount: 0, failedBatches: 1 }), "failed");
  assert.deepEqual(pillState({ aiProviderAvailable: true, classificationStatus: "failed" }), { text: "KI-Kommentierung fehlgeschlagen", off: true });
});

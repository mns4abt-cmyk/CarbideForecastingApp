"use strict";
const fs = require("node:fs");
const path = require("node:path");

function validateStrategicEntities(config) {
  const fail = () => { throw new Error("Invalid strategic entity configuration"); };
  if (!config || !Array.isArray(config.entities) || !Array.isArray(config.chinaTcOperators)
    || !Number.isInteger(config.pendingChinaTcOperatorSlots) || config.pendingChinaTcOperatorSlots < 0
    || typeof config.confirmationNote !== "string") fail();
  const ids = new Set();
  const keys = new Set();
  for (const entry of [...config.entities, ...config.chinaTcOperators]) {
    if (!entry || !/^[a-z][a-z0-9_]*$/.test(entry.id || "")
      || !/^[a-z][a-zA-Z0-9_]*$/.test(entry.apiKey || "")
      || ["constructor", "prototype"].includes(entry.id)
      || ["constructor", "prototype"].includes(entry.apiKey)
      || typeof entry.displayName !== "string" || !entry.displayName.trim()
      || typeof entry.confirmed !== "boolean" || !Array.isArray(entry.aliases) || !entry.aliases.length
      || entry.aliases.some(alias => typeof alias !== "string" || !/[\p{L}\p{N}]/u.test(alias))
      || ids.has(entry.id) || keys.has(entry.apiKey)) fail();
    ids.add(entry.id);
    keys.add(entry.apiKey);
  }
  return config;
}

function loadStrategicEntities(filePath = path.join(__dirname, "..", "config", "strategic-entities.json")) {
  return validateStrategicEntities(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function confirmedEntities(configuration = loadStrategicEntities()) {
  const config = validateStrategicEntities(configuration);
  return [...config.entities, ...config.chinaTcOperators].filter(entry => entry.confirmed === true);
}

module.exports = { loadStrategicEntities, validateStrategicEntities, confirmedEntities };

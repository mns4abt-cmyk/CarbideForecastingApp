"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

class NewsClassificationCache {
  constructor({ directory, model, schemaVersion }) {
    this.directory = directory;
    this.file = path.join(directory, "news-classifications.json");
    this.model = model;
    this.schemaVersion = schemaVersion;
    this.entries = this.load();
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }

  key(article) {
    return crypto.createHash("sha256").update(JSON.stringify({ title: article.title || "", snippet: article.snippet || "", source: article.source || "", model: this.model, schemaVersion: this.schemaVersion })).digest("hex");
  }

  get(article) { return this.entries[this.key(article)] || null; }

  set(article, classification) {
    this.entries[this.key(article)] = classification;
    try { fs.mkdirSync(this.directory, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.entries)); } catch { /* cache is optional */ }
  }
}

module.exports = { NewsClassificationCache };

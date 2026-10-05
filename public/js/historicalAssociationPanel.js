(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HistoricalAssociationPanel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MARKET_LABELS = Object.freeze({ china: "China", eu: "EU" });

  function formatReturn(value) {
    if (!Number.isFinite(value)) return "Nicht verf\u00fcgbar";
    return `${value > 0 ? "+" : ""}${value.toFixed(1).replace(".", ",")}%`;
  }

  function groupKey(item) {
    return [item.category, item.direction, item.supplyEffect, item.demandEffect, item.evidenceMaturity, item.market].join("|");
  }

  // Preserves the deterministic backend order; it intentionally does not rank
  // groups by return, hit rate, or any recommendation-like signal.
  function combineHorizonGroups(groups, region) {
    const markets = region === "china" || region === "eu" ? new Set([region]) : new Set(["china", "eu"]);
    const combined = new Map();
    for (const item of Array.isArray(groups) ? groups : []) {
      if (!markets.has(item.market)) continue;
      const key = groupKey(item);
      if (!combined.has(key)) combined.set(key, { ...item, horizons: [] });
      combined.get(key).horizons.push(item);
    }
    return [...combined.values()].map((item) => ({
      ...item,
      horizons: item.horizons.sort((left, right) => left.horizonWeeks - right.horizonWeeks),
    }));
  }

  function horizonStatistic(item, minimum) {
    const sample = Number(item.eventCount) || 0;
    if (item.insufficientEvidence || !Number.isFinite(item.medianReturnPct)) {
      return `<div class="historical-association-horizon historical-association-insufficient"><strong>${item.horizonWeeks} Wochen</strong><span>Unzureichende Datenbasis (n=${sample}, mindestens ${minimum})</span></div>`;
    }
    const changeClass = item.medianReturnPct > 0 ? "change-up" : item.medianReturnPct < 0 ? "change-down" : "change-flat";
    return `<div class="historical-association-horizon"><strong>${item.horizonWeeks} Wochen <small>n=${sample}</small></strong><span>Median nachfolgende Rendite</span><b class="${changeClass}">${formatReturn(item.medianReturnPct)}</b></div>`;
  }

  function renderGroup(item, minimum) {
    const totalEvents = Math.max(...item.horizons.map((horizon) => Number(horizon.eventCount) || 0));
    return `<article class="historical-association-group" data-market="${item.market}">
      <div class="historical-association-head"><span>Kategorie: ${item.category}</span><span>${MARKET_LABELS[item.market] || item.market}</span></div>
      <strong class="historical-association-count">${totalEvents}</strong><span class="historical-association-count-label">abgeschlossene Ereignisse</span>
      <p>${item.direction} &middot; ${item.supplyEffect} / ${item.demandEffect} &middot; ${item.evidenceMaturity}</p>
      <div class="historical-association-horizons">${item.horizons.map((horizon) => horizonStatistic(horizon, minimum)).join("")}</div>
    </article>`;
  }

  function render({ report, region = "both" } = {}) {
    if (!report?.available) return "<p class=\"historical-association-empty\">Historische Ereignisassoziationen sind derzeit nicht verf\u00fcgbar.</p>";
    const groups = combineHorizonGroups(report.groups, region);
    if (!groups.length) return "<p class=\"historical-association-empty\">Noch keine abgeschlossenen historischen Ereignis-Outcomes f\u00fcr die gew\u00e4hlte Ansicht.</p>";
    return groups.map((item) => renderGroup(item, report.minCompletedOutcomes)).join("");
  }

  return { MARKET_LABELS, formatReturn, groupKey, combineHorizonGroups, horizonStatistic, renderGroup, render };
});

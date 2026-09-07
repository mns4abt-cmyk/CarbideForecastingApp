(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EvidenceFusionPanel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MARKET_LABELS = Object.freeze({ china: "China", eu: "EU" });
  const DIRECTION_LABELS = Object.freeze({
    bullish: "Aufwärtsdruck", bearish: "Abwärtsdruck", neutral: "Neutral", mixed: "Gemischt", none: "Keine Evidenz",
  });
  const RELIABILITY_LABELS = Object.freeze({ HIGH: "Hoch", MEDIUM: "Mittel", LOW: "Niedrig", VERY_LOW: "Sehr niedrig" });
  const AGREEMENT_LABELS = Object.freeze({
    agree: "Bestätigt", conflict: "Widerspruch", mixed: "Gemischt", news_only: "Nur externe Evidenz", none: "Keine Bestätigung",
  });
  const CORROBORATION_LABELS = Object.freeze({ HIGH: "Hoch", MEDIUM: "Mittel", LOW: "Niedrig", NONE: "Keine" });

  function labelFor(labels, value, fallback = "Nicht verfügbar") {
    return labels[value] || fallback;
  }

  function formatChange(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "–";
    const sign = number > 0 ? "+" : "";
    return `${sign}${number.toFixed(1).replace(".", ",")}%`;
  }

  function strengthLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0.20) return "Schwach";
    if (number < 0.70) return "Mittel";
    return "Stark";
  }

  function fusionFor(fusion, market, horizonWeeks) {
    return fusion?.[market]?.[String(horizonWeeks)] || null;
  }

  function corroborationText(corroboration) {
    if (corroboration === "NONE") return "Keine belastbare externe Bestätigung";
    return `Externe Bestätigung: ${labelFor(CORROBORATION_LABELS, corroboration)}`;
  }

  function renderMarket(fusion, market, horizonWeeks) {
    const item = fusionFor(fusion, market, horizonWeeks);
    const marketLabel = MARKET_LABELS[market] || market;
    if (!item || item.status === "unavailable") {
      return `<section class="evidence-fusion-market" data-market="${market}">
        <h3>${marketLabel}</h3>
        <p class="evidence-fusion-unavailable">Evidenzbewertung derzeit nicht verfügbar.</p>
      </section>`;
    }

    const baseline = item.baselineEvidence || {};
    const news = item.newsEvidence || {};
    return `<section class="evidence-fusion-market" data-market="${market}">
      <h3>${marketLabel}</h3>
      <div class="evidence-fusion-section">
        <span class="evidence-fusion-label">Statistische Baseline</span>
        <strong>${labelFor(DIRECTION_LABELS, baseline.direction)} · ${formatChange(baseline.forecastChangePct)}</strong>
        <span>Modellzuverlässigkeit: ${labelFor(RELIABILITY_LABELS, baseline.reliability)}</span>
      </div>
      <div class="evidence-fusion-section">
        <span class="evidence-fusion-label">Aktuelle Nachrichten</span>
        <strong>${labelFor(DIRECTION_LABELS, news.direction)}</strong>
        <span>${Number(news.directionalEvents) || 0} von ${Number(news.classifiedEvents) || 0} Ereignissen mit validierter Richtung</span>
        <span>Evidenzstärke: ${strengthLabel(news.strength)}</span>
      </div>
      <div class="evidence-fusion-section">
        <span class="evidence-fusion-label">Bewertung</span>
        <strong>${labelFor(AGREEMENT_LABELS, item.agreement)}</strong>
        <span>${corroborationText(item.corroboration)}</span>
      </div>
    </section>`;
  }

  function render({ fusion, region = "both", horizonWeeks = 12 } = {}) {
    const markets = region === "china" || region === "eu" ? [region] : ["china", "eu"];
    return markets.map((market) => renderMarket(fusion, market, horizonWeeks)).join("");
  }

  return {
    DIRECTION_LABELS,
    RELIABILITY_LABELS,
    AGREEMENT_LABELS,
    CORROBORATION_LABELS,
    formatChange,
    strengthLabel,
    fusionFor,
    corroborationText,
    renderMarket,
    render,
  };
});

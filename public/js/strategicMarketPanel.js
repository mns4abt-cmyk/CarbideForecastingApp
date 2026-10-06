(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrategicMarketPanel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const CATEGORY = { supply: "Angebot", demand: "Nachfrage", regulation: "Regulierung",
    geopolitics: "Geopolitik", technology: "Technologie", macro: "Makroökonomie", other: "Sonstiges" };
  const DIRECTION = { bullish: "Aufwärtsdruck", bearish: "Abwärtsdruck", neutral: "Keine klare Richtung" };
  const STAGE = { actual: "Tatsächlich wirksam", announced: "Angekündigt", planned: "Geplant",
    study: "Studie", exploration: "Exploration", speculative: "Spekulativ", unclear: "Unklar" };
  const MATURITY = { realized: "Realisiert", prospective: "Prospektiv", speculative: "Spekulativ", unclear: "Unklar" };
  const escape = value => String(value ?? "").replace(/[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const label = (labels, value) => escape(Object.hasOwn(labels, value) ? labels[value] : value || "Nicht angegeben");
  function date(value) {
    const timestamp = value ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC",
    }) : "—";
  }
  function eventItem(event) {
    const source = event.source || event.provenance?.source || "Nicht angegeben";
    return `<li><p class="strategic-event-title">${escape(event.title)}</p>
      <p class="strategic-event-meta">${date(event.date)} · Quelle: ${escape(source)}</p>
      <p class="strategic-event-meta">Kategorie: ${label(CATEGORY, event.category)}</p>
      <p class="strategic-event-meta">Wolfram/APT-Preisdruck: ${label(DIRECTION, event.direction)}</p>
      <p class="strategic-event-meta">Phase: ${label(STAGE, event.eventStage)} · Reife: ${label(MATURITY, event.evidenceMaturity)}</p>
    </li>`;
  }
  function render({ report } = {}) {
    // Definitions are supplied by the confirmed server configuration, never
    // guessed from article text or from generic China TC topic membership.
    const definitions = Array.isArray(report?.entityDefinitions) ? report.entityDefinitions : [];
    const cards = definitions.map(entry => ["entities", entry.apiKey, entry.displayName]).map(([group, id, name]) => {
      const view = report?.[group]?.[id];
      const available = report?.status === "available" && ["available", "no_matching_events"].includes(view?.status);
      let body;
      if (!available) {
        body = '<p class="strategic-status">Validierte Ereignisdaten sind derzeit nicht verfügbar.</p>';
      } else {
        // The query layer supplies newest-first order; no importance ranking,
        // regional filtering, interpretation or sentiment is introduced here.
        const events = Array.isArray(view.latestEvents) ? view.latestEvents : [];
        body = `<p class="strategic-count">${escape(view.totalEventCount)} Ereignisse / letzte ${escape(report.windowDays)} Tage</p>
          <p class="strategic-event-meta">Letztes Update: ${date(view.latestEventDate)}</p>`;
        body += events.length
          ? `<ul class="strategic-events">${events.slice(0, 3).map(eventItem).join("")}</ul>
            <details class="strategic-details"><summary>Alle jüngsten Ereignisse (${events.length})</summary>
              <ul class="strategic-events">${events.map(eventItem).join("")}</ul></details>`
          : '<p class="strategic-status">Keine validierten Ereignisse im gewählten Zeitraum.</p>';
      }
      return `<article class="strategic-card"><h3>${escape(name)}</h3>${body}</article>`;
    }).join("");
    return `<p class="strategic-note">Marktübergreifende Unternehmensbeobachtung, keine Preisprognose und keine Unternehmensbewertung oder Empfehlung. Wolfram/APT-Preisdruck beschreibt die validierte Ereignisrichtung, keine nachgewiesene kausale Wirkung.</p>
      <div class="strategic-grid">${cards}</div>
      <p class="strategic-note">Die strategische Marktbeobachtung gruppiert bereits validierte Nachrichtenereignisse nach benannten Unternehmen. Es werden keine zusätzlichen KI-Prognosen erzeugt.</p>`;
  }
  return { render };
});

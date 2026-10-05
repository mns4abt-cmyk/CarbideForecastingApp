(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NewsLageManagementPanel = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const methodology = 'Die News-Lage basiert auf validierten Nachrichtenereignissen der letzten 30 Tage. Neuere und materiellere Ereignisse erhalten ein höheres Gewicht. Der statistische Preisforecast wird dadurch nicht verändert.';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const number = (value) => Number.isFinite(value) ? escape(value) : 'Nicht verfügbar';
  function eventList(events, technical = false) {
    if (!events.length) return '<p>Keine gewichteten Top-Ereignisse verfügbar.</p>';
    return `<ol class="news-management-events">${events.map((event) => {
      const date = event.date ? new Date(event.date) : null;
      const dateText = date && Number.isFinite(date.getTime())
        ? date.toLocaleDateString('de-DE', { timeZone: 'UTC' }) : 'Datum nicht verfügbar';
      const source = event.source || event.provenance?.sources?.join(', ') || 'Quelle nicht angegeben';
      return `<li><time>${escape(dateText)}</time><strong>${escape(event.title)}</strong>
        <span>${escape(source)}</span>
        <span>Wolfram/APT-Preisdruck: ${escape(event.direction || 'Nicht verfügbar')}</span>
        <span>${[event.category, event.eventStage, event.evidenceMaturity].filter(Boolean).map(escape).join(' · ')}</span>
        ${technical ? `<small>finalWeight: ${number(event.finalWeight)}</small>` : ''}</li>`;
    }).join('')}</ol>`;
  }
  function marketPanel(newsLage, market) {
    const summary = newsLage?.managementSummary?.[market];
    const usable = newsLage?.available !== false && ['available', 'empty'].includes(summary?.status);
    const empty = usable && summary.status === 'empty';
    const sparse = usable && !empty && [1, 2].includes(summary.directionalEventCount);
    const events = usable && Array.isArray(summary.topEvents) ? summary.topEvents.slice(0, 5) : [];
    return `<section class="news-management-market" data-market="${market}">
      <h3>${market === 'china' ? 'China' : 'EU'}</h3>
      <h4>Kurzfazit</h4>
      <p class="news-management-summary">${escape(summary?.text || 'Management-Zusammenfassung derzeit nicht verfügbar.')}</p>
      ${!usable ? '<p role="status">Management-Zusammenfassung derzeit nicht verfügbar.</p>'
        : empty ? '<p role="status">Keine validierten Ereignisse im gewählten Zeitraum.</p>'
          : sparse ? '<p class="news-management-status">Kleine Datenbasis: 1–2 gerichtete Ereignisse.</p>' : ''}
      <h4>Aktuelle Einordnung</h4>
      <p class="news-management-label">${escape(usable ? summary.qualitativeLabel || 'Nicht verfügbar' : 'Nicht verfügbar')}</p>
      <dl class="news-management-counts"><div><dt>Validierte Ereignisse</dt><dd>${number(usable ? summary.totalEventCount : null)}</dd></div>
        <div><dt>Gerichtete Ereignisse</dt><dd>${number(usable ? summary.directionalEventCount : null)}</dd></div></dl>
      <h4>Top-Ereignisse</h4>${usable ? eventList(events.slice(0, 3)) : '<p>Top-Ereignisse nicht verfügbar.</p>'}
      <details class="news-lage-details"><summary>Methodik / Details anzeigen</summary>
        <p>${methodology}</p>
        <p>Sentiment Score: ${number(usable ? newsLage?.[market]?.sentimentScore : null)}</p>
        <h4>Alle ausgewählten Top-Ereignisse</h4>${usable ? eventList(events, true) : '<p>Nicht verfügbar.</p>'}
      </details>
    </section>`;
  }
  function render({ newsLage, region = 'both' } = {}) {
    const markets = region === 'china' ? ['china'] : region === 'eu' ? ['eu'] : ['china', 'eu'];
    return `<div class="news-lage-management">${markets.map((market) => marketPanel(newsLage, market)).join('')}</div>`;
  }
  return { render };
});

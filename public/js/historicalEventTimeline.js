(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HistoricalEventTimeline = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const HORIZONS = Object.freeze([1, 4, 12, 26]);
  const CATEGORY_LANES = Object.freeze([
    Object.freeze({ id: "supply", label: "Angebot", categories: ["supply"] }),
    Object.freeze({ id: "demand", label: "Nachfrage", categories: ["demand"] }),
    Object.freeze({ id: "regulation", label: "Regulierung", categories: ["regulation"] }),
    Object.freeze({ id: "geopolitics", label: "Geopolitik", categories: ["geopolitics"] }),
    Object.freeze({ id: "production", label: "Unternehmen / Produktion", categories: ["technology"] }),
    Object.freeze({ id: "other", label: "Sonstige", categories: ["macro", "other"] }),
  ]);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
    }[character]));
  }

  function dateValue(value) {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Nicht verfügbar";
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
  }

  function formatPrice(value, unit) {
    if (!Number.isFinite(value)) return "Nicht verfügbar";
    return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value)} ${unit || ""}`.trim();
  }

  function formatReturn(value) {
    if (!Number.isFinite(value)) return "Nicht verfügbar";
    return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value)}%`;
  }

  function directionLabel(direction) {
    return direction === "bullish" ? "Preistreibend" : direction === "bearish" ? "Preisdämpfend" : "Neutral";
  }

  function eventDate(event) {
    return event?.publishedAt || event?.firstSeenAt || null;
  }

  function categoryLane(category) {
    return CATEGORY_LANES.find((lane) => lane.categories.includes(category)) || CATEGORY_LANES.at(-1);
  }

  function optionValues(events, property) {
    return [...new Set(events.map((event) => event[property]).filter((value) => typeof value === "string" && value.trim()))]
      .sort((left, right) => left.localeCompare(right));
  }

  function outcomeForMarket(event, market) {
    return (Array.isArray(event?.priceOutcomes) ? event.priceOutcomes : []).filter((outcome) => outcome.market === market);
  }

  function filterEvents(events, market, filters) {
    return (Array.isArray(events) ? events : [])
      .filter((event) => outcomeForMarket(event, market).length > 0)
      .filter((event) => filters.category === "all" || event.category === filters.category)
      .filter((event) => filters.direction === "all" || event.direction === filters.direction)
      .filter((event) => filters.stage === "all" || event.eventStage === filters.stage)
      .filter((event) => filters.maturity === "all" || event.evidenceMaturity === filters.maturity)
      .map((event) => ({ ...event, marketOutcomes: outcomeForMarket(event, market) }))
      .sort((left, right) => String(eventDate(left) || "").localeCompare(String(eventDate(right) || "")) || String(left.title).localeCompare(String(right.title)));
  }

  function associationGroups(report, market, horizonWeeks) {
    if (!report?.available || !Array.isArray(report.groups)) return [];
    return report.groups.filter((group) => group.market === market
      && group.horizonWeeks === horizonWeeks
      && !group.insufficientEvidence
      && Number.isFinite(group.medianReturnPct));
  }

  function selectOptions(values, selected) {
    return [`<option value="all">Alle</option>`, ...values.map((value) => (
      `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
    ))].join("");
  }

  function sharedRange(points, events, viewMonths) {
    const times = [
      ...(Array.isArray(points) ? points : []).map((point) => dateValue(point.date)),
      ...(Array.isArray(events) ? events : []).map(eventDate).map(dateValue),
    ].filter((time) => time !== null);
    const earliest = Math.min(...times);
    const latest = Math.max(...times);
    const start = viewMonths === "all" ? earliest : Math.max(earliest, latest - Number(viewMonths) * 30.4375 * 24 * 60 * 60 * 1000);
    return { start, end: latest, span: Math.max(latest - start, 1) };
  }

  function axisLabels(range, width, height, x) {
    return Array.from({ length: 5 }, (_, index) => {
      const time = range.start + (range.span * index) / 4;
      return `<text x="${x(time)}" y="${height - 10}" text-anchor="${index === 0 ? "start" : index === 4 ? "end" : "middle"}" class="timeline-axis-label">${formatDate(new Date(time).toISOString())}</text>`;
    }).join("");
  }

  function clusterEvents(events, range) {
    const clusters = new Map();
    events.forEach((event) => {
      const time = dateValue(eventDate(event));
      const lane = categoryLane(event.category);
      if (time === null || time < range.start || time > range.end) return;
      const key = `${time}\u0000${lane.id}`;
      if (!clusters.has(key)) clusters.set(key, { time, lane, events: [] });
      clusters.get(key).events.push(event);
    });
    return [...clusters.values()].map((cluster) => {
      const directions = [...new Set(cluster.events.map((event) => event.direction))];
      return { ...cluster, direction: directions.length === 1 ? directions[0] : "neutral" };
    }).sort((left, right) => left.time - right.time || left.lane.id.localeCompare(right.lane.id));
  }

  function eventChartSvg(events, selectedEventId, range) {
    const width = 1000;
    const height = 260;
    const margin = { top: 16, right: 20, bottom: 34, left: 166 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const x = (time) => margin.left + ((time - range.start) / range.span) * innerWidth;
    const laneHeight = innerHeight / CATEGORY_LANES.length;
    const laneY = (lane) => margin.top + (CATEGORY_LANES.findIndex((item) => item.id === lane.id) + 0.5) * laneHeight;
    const laneRows = CATEGORY_LANES.map((lane, index) => {
      const y = margin.top + index * laneHeight;
      return `<rect x="${margin.left}" y="${y}" width="${innerWidth}" height="${laneHeight}" class="event-lane-${index % 2}" /><line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" class="event-lane-rule" /><text x="${margin.left - 10}" y="${laneY(lane) + 4}" text-anchor="end" class="event-lane-label">${lane.label}</text>`;
    }).join("");
    const markers = clusterEvents(events, range).map((cluster) => {
      const selected = cluster.events.some((event) => event.eventId === selectedEventId);
      const eventIds = cluster.events.map((event) => event.eventId).join(" ");
      const title = cluster.events.length === 1
        ? `${cluster.events[0].title} (${formatDate(eventDate(cluster.events[0]))})`
        : `${cluster.events.length} Ereignisse: ${cluster.events.map((event) => event.title).join(" | ")}`;
      const direction = ["bullish", "bearish"].includes(cluster.direction) ? cluster.direction : "neutral";
      const count = cluster.events.length > 1 ? `<text x="${x(cluster.time)}" y="${laneY(cluster.lane) + 3}" text-anchor="middle" class="event-cluster-count">+${cluster.events.length}</text>` : "";
      return `<g class="event-cluster${selected ? " is-selected" : ""}"><circle class="event-cluster-marker ${direction}${selected ? " is-selected" : ""}" data-event-id="${escapeHtml(cluster.events[0].eventId)}" data-event-ids="${escapeHtml(eventIds)}" cx="${x(cluster.time)}" cy="${laneY(cluster.lane)}" r="${cluster.events.length > 1 ? 7 : 3.5}" tabindex="0" role="button" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title></circle>${count}</g>`;
    }).join("");
    return `<svg class="historical-event-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Markt-Ereignisse nach Kategorie">${laneRows}<line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + innerHeight}" y2="${margin.top + innerHeight}" class="event-lane-rule" />${axisLabels(range, width, height, x)}${markers}</svg>`;
  }

  function priceChartSvg(points, selectedEvent, range) {
    const datedPoints = points.map((point) => ({ ...point, time: dateValue(point.date) }))
      .filter((point) => point.time !== null && Number.isFinite(point.value) && point.time >= range.start && point.time <= range.end);
    if (!datedPoints.length) return "<p class=\"timeline-empty\">Keine normalisierten Wochenpreise für den gewählten Markt verfügbar.</p>";
    const width = 1000;
    const height = 310;
    const margin = { top: 18, right: 20, bottom: 34, left: 66 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const values = datedPoints.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = (max - min) * 0.12 || Math.max(Math.abs(max) * 0.05, 1);
    const yMin = min - pad;
    const yMax = max + pad;
    const x = (time) => margin.left + ((time - range.start) / range.span) * innerWidth;
    const y = (value) => margin.top + innerHeight - ((value - yMin) / (yMax - yMin)) * innerHeight;
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = yMin + ((yMax - yMin) * index) / 4;
      const position = y(value);
      return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${position}" y2="${position}" class="timeline-grid" /><text x="${margin.left - 8}" y="${position + 4}" text-anchor="end" class="timeline-axis-label">${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value)}</text>`;
    }).join("");
    const path = datedPoints.map((point) => `${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    const eventOutcome = selectedEvent?.marketOutcomes?.find((outcome) => Number.isFinite(outcome.priceAtEvent));
    const matchedPoint = eventOutcome ? datedPoints.find((point) => point.date === eventOutcome.priceAtEventDate) : null;
    const selectedTime = selectedEvent ? dateValue(eventDate(selectedEvent)) : null;
    const guide = selectedTime !== null && selectedTime >= range.start && selectedTime <= range.end
      ? `<line x1="${x(selectedTime)}" x2="${x(selectedTime)}" y1="${margin.top}" y2="${margin.top + innerHeight}" class="selected-event-guide" />` : "";
    const matched = matchedPoint
      ? `<circle cx="${x(matchedPoint.time)}" cy="${y(matchedPoint.value)}" r="6" class="matched-price-observation"><title>Verwendete Preisbeobachtung: ${formatDate(matchedPoint.date)}</title></circle>` : "";
    return `<svg class="historical-price-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historische wöchentliche Preisentwicklung">${grid}${axisLabels(range, width, height, x)}${guide}<polyline points="${path}" class="timeline-price-line" />${matched}</svg>`;
  }

  function outcomeCell(outcomes, horizonWeeks) {
    const outcome = outcomes.find((item) => item.horizonWeeks === horizonWeeks);
    const label = `Nach ${horizonWeeks} Woche${horizonWeeks === 1 ? "" : "n"}`;
    if (outcome?.status === "available") return `<div class="timeline-outcome is-available"><strong>${label}</strong><b>${formatPrice(outcome.futurePrice, outcome.unit)}</b><small class="${outcome.returnPct > 0 ? "change-up" : outcome.returnPct < 0 ? "change-down" : "change-flat"}">${formatReturn(outcome.returnPct)}</small></div>`;
    if (outcome?.status === "pending") return `<div class="timeline-outcome is-pending"><strong>${label}</strong><span>Noch nicht verfügbar</span></div>`;
    return `<div class="timeline-outcome is-unavailable"><strong>${label}</strong><span>Keine passende Preisbeobachtung</span></div>`;
  }

  function eventDetail(event, market) {
    if (!event) return "<p class=\"timeline-empty\">Wähle einen Ereignispunkt, um Details zu sehen.</p>";
    const outcomes = event.marketOutcomes;
    const eventPrice = outcomes.find((outcome) => Number.isFinite(outcome.priceAtEvent));
    const source = event.provenance?.source || "Quelle nicht angegeben";
    const lane = categoryLane(event.category);
    return `<article class="timeline-detail-record"><div class="timeline-detail-head"><time>${formatDate(eventDate(event))}</time><span class="badge badge-${escapeHtml(event.direction)}">${directionLabel(event.direction)}</span></div><h3>${escapeHtml(event.title)}</h3><p class="timeline-detail-meta">${market === "china" ? "China" : "EU"} · ${escapeHtml(lane.label)} · ${escapeHtml(event.eventStage)} / ${escapeHtml(event.evidenceMaturity)}</p><p class="timeline-detail-meta">${escapeHtml(source)} · Preisdatum: ${formatDate(eventPrice?.priceAtEventDate)} · Ereignispreis: ${formatPrice(eventPrice?.priceAtEvent, eventPrice?.unit)}</p><div class="timeline-outcomes">${HORIZONS.map((horizonWeeks) => outcomeCell(outcomes, horizonWeeks)).join("")}</div></article>`;
  }

  function create(container) {
    const state = { timeline: null, associations: null, market: "china", selectedEventId: null, associationHorizon: 1, viewMonths: "12", filters: { category: "all", direction: "all", stage: "all", maturity: "all" } };
    function render() {
      if (!state.timeline) { container.innerHTML = "<p class=\"timeline-empty\">Historische Ereignis-Preis-Daten werden geladen.</p>"; return; }
      if (!state.timeline.available) { container.innerHTML = `<p class="timeline-empty">${escapeHtml(state.timeline.error?.message || "Historische Ereignis-Preis-Daten sind derzeit nicht verfügbar.")}</p>`; return; }
      const allEvents = state.timeline.events || [];
      const events = filterEvents(allEvents, state.market, state.filters);
      if (!events.some((event) => event.eventId === state.selectedEventId)) state.selectedEventId = events[0]?.eventId || null;
      const selectedEvent = events.find((event) => event.eventId === state.selectedEventId) || null;
      const points = state.timeline.weeklyPrices?.[state.market] || [];
      const range = sharedRange(points, events, state.viewMonths);
      const groups = associationGroups(state.associations, state.market, state.associationHorizon);
      const marketName = state.market === "china" ? "China" : "EU";
      container.innerHTML = `
        <div class="timeline-controls"><div class="timeline-market-toggle" role="group" aria-label="Markt auswählen"><button type="button" data-market="china" class="${state.market === "china" ? "active" : ""}">China</button><button type="button" data-market="eu" class="${state.market === "eu" ? "active" : ""}">EU</button></div><label>Ansicht <select data-view-months><option value="12"${state.viewMonths === "12" ? " selected" : ""}>12 Monate</option><option value="all"${state.viewMonths === "all" ? " selected" : ""}>Gesamte Historie</option></select></label><label>Kategorie <select data-filter="category">${selectOptions(optionValues(allEvents, "category"), state.filters.category)}</select></label><label>Richtung <select data-filter="direction">${selectOptions(optionValues(allEvents, "direction"), state.filters.direction)}</select></label><label>Stufe <select data-filter="stage">${selectOptions(optionValues(allEvents, "eventStage"), state.filters.stage)}</select></label><label>Reifegrad <select data-filter="maturity">${selectOptions(optionValues(allEvents, "evidenceMaturity"), state.filters.maturity)}</select></label></div>
        <p class="timeline-market-label">${marketName} · ${points[0]?.unit || "Einheit nicht verfügbar"} · ${events.length} Ereignisse im Filter</p>
        <section class="timeline-chart-section"><div class="timeline-chart-heading"><h3>Markt-Ereignisse</h3><div class="event-direction-legend"><span class="bullish">Preistreibend</span><span class="bearish">Preisdämpfend</span><span class="neutral">Neutral</span></div></div><div class="event-chart-wrap">${eventChartSvg(events, state.selectedEventId, range)}</div><p class="timeline-chart-note">Ereignispunkte zeigen Zeitpunkt und Typ einer Nachricht. Ihre vertikale Position stellt keinen Preis und keine Ereignisstärke dar.</p></section>
        <section class="timeline-chart-section"><div class="timeline-chart-heading"><h3>Preisentwicklung</h3><span>${escapeHtml(points[0]?.unit || "")}</span></div><div class="price-chart-wrap">${priceChartSvg(points, selectedEvent, range)}</div></section>
        <p class="timeline-limitation">Viele 4W/12W/26W-Ergebnisse sind noch ausstehend, da die gespeicherten Ereignisse überwiegend aus den letzten Wochen stammen.</p><p class="timeline-interpretation">Die Ereignisdarstellung zeigt, wann und welche Marktinformationen vorlagen. Der Preisverlauf wird separat dargestellt. Eine zeitliche Nähe zwischen Ereignis und Preisbewegung ist keine Kausalitätsaussage.</p><p class="timeline-forecast-note">Nachrichten verändern weder P50 noch P10/P90 noch die historischen Stressszenarien.</p>
        <div class="timeline-detail">${eventDetail(selectedEvent, state.market)}</div>
        <section class="timeline-association-summary" aria-label="Historische Assoziation"><div class="timeline-association-head"><h3>Historische Assoziation — keine Kausalitätsaussage</h3><label>Horizont <select data-association-horizon>${HORIZONS.map((horizon) => `<option value="${horizon}"${state.associationHorizon === horizon ? " selected" : ""}>${horizon}W</option>`).join("")}</select></label></div>${groups.length ? `<div class="timeline-association-groups">${groups.map((group) => `<article><strong>${escapeHtml(group.category)} · ${escapeHtml(group.direction)} · ${escapeHtml(group.supplyEffect)} / ${escapeHtml(group.demandEffect)} · ${escapeHtml(group.evidenceMaturity)}</strong><span>n=${group.completedOutcomeCount} · Median ${formatReturn(group.medianReturnPct)} · ${group.horizonWeeks}W</span></article>`).join("")}</div>` : "<p class=\"timeline-association-empty\">Keine Gruppe mit ausreichender Datenbasis für den gewählten Markt und Horizont.</p>"}</section>`;
      wire();
    }
    function wire() {
      container.querySelectorAll("[data-market]").forEach((button) => button.addEventListener("click", () => { state.market = button.dataset.market; state.selectedEventId = null; render(); }));
      container.querySelectorAll("[data-filter]").forEach((select) => select.addEventListener("change", () => { state.filters[select.dataset.filter] = select.value; state.selectedEventId = null; render(); }));
      container.querySelector("[data-view-months]")?.addEventListener("change", (event) => { state.viewMonths = event.target.value; render(); });
      container.querySelector("[data-association-horizon]")?.addEventListener("change", (event) => { state.associationHorizon = Number(event.target.value); render(); });
      container.querySelectorAll(".event-cluster-marker").forEach((marker) => {
        const select = () => { state.selectedEventId = marker.dataset.eventId; render(); };
        marker.addEventListener("click", select);
        marker.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
      });
    }
    return { update({ timeline, associations } = {}) { if (timeline !== undefined) state.timeline = timeline; if (associations !== undefined) state.associations = associations; render(); }, render };
  }

  return { HORIZONS, CATEGORY_LANES, categoryLane, filterEvents, associationGroups, sharedRange, clusterEvents, projectEventChart: eventChartSvg, projectPriceChart: priceChartSvg, create };
});
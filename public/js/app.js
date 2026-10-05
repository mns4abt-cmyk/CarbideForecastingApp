(function () {
  let D = window.CarbideData;

  const state = {
    region: "both", // 'china' | 'eu' | 'both'
    activeScenarios: new Set(D.SCENARIOS.map((s) => s.id)),
    highlightScenarios: null, // set by clicking a news item
    selectedNewsId: null,
    selectedOutcomeEventKey: null,
    refreshing: false,
    evidenceFusionHorizon: 12,
  };

  const els = {
    lastUpdate: document.getElementById("lastUpdate"),
    unitDisplay: document.getElementById("unitDisplay"),
    regionToggle: document.getElementById("regionToggle"),
    scenarioToggles: document.getElementById("scenarioToggles"),
    chartSvg: document.getElementById("priceChart"),
    chartTooltip: document.getElementById("chartTooltip"),
    chartLegend: document.getElementById("chartLegend"),
    insightsList: document.getElementById("insightsList"),
    newsList: document.getElementById("newsList"),
    refreshBtn: document.getElementById("refreshBtn"),
    aiStatusPill: document.getElementById("aiStatusPill"),
    toast: document.getElementById("toast"),
    currentMarketCard: document.getElementById("currentMarketCard"),
    currentMarketToggleWrap: document.getElementById("currentMarketToggleWrap"),
    currentMarketToggle: document.getElementById("currentMarketToggle"),
    currentMarketDot: document.getElementById("currentMarketDot"),
    currentMarketChanges: document.getElementById("currentMarketChanges"),
    currentMarketSummary: document.getElementById("currentMarketSummary"),
    currentMarketLabel: document.getElementById("currentMarketLabel"),
    newsLageTitle: document.getElementById("newsLageTitle"),
    newsLageScale: document.getElementById("newsLageScale"),
    newsLageMethodology: document.getElementById("newsLageMethodology"),
    newsLageDetails: document.getElementById("newsLageDetails"),
    newsLageEvents: document.getElementById("newsLageEvents"),
    newsLageEventsContent: document.getElementById("newsLageEventsContent"),
    eventOutcomesPanel: document.getElementById("eventOutcomesPanel"),
    eventOutcomesContent: document.getElementById("eventOutcomesContent"),
    historicalAssociationCard: document.getElementById("historicalAssociationCard"),
    historicalAssociationContent: document.getElementById("historicalAssociationContent"),
    evidenceFusionHorizons: document.getElementById("evidenceFusionHorizons"),
    evidenceFusionContent: document.getElementById("evidenceFusionContent"),
    strategicMarketContent: document.getElementById("strategicMarketContent"),
  };

  // Von D abgeleitete Werte werden nach jedem Refresh neu berechnet (siehe recomputeDerived).
  let ALL_LABELS = [...D.HISTORY_LABELS, ...D.FORECAST_LABELS];
  let HIST_COUNT = D.HISTORY_LABELS.length;

  function recomputeDerived() {
    ALL_LABELS = [...D.HISTORY_LABELS, ...D.FORECAST_LABELS];
    HIST_COUNT = D.HISTORY_LABELS.length;
  }

  function fmtDate(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
  }

  function fmtDateTime(date) {
    const datePart = date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    const timePart = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return `${datePart}, ${timePart} Uhr`;
  }

  function updateUnitDisplay() {
    els.unitDisplay.textContent = `Einheit: ${window.ForecastPresentation.unitForRegion(state.region)}`;
  }

  function lighten(hex, amount) {
    const c = hex.replace("#", "");
    const num = parseInt(c, 16);
    let r = (num >> 16) + Math.round(255 * amount);
    let g = ((num >> 8) & 0x00ff) + Math.round(255 * amount);
    let b = (num & 0x0000ff) + Math.round(255 * amount);
    r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  function sentimentArrow(sentiment) {
    if (sentiment === "bullish" || sentiment === "bullish-eu") return "▲";
    if (sentiment === "bearish") return "▼";
    return "▶";
  }
  function sentimentClass(sentiment) {
    if (sentiment === "bullish" || sentiment === "bullish-eu") return "bullish";
    if (sentiment === "bearish") return "bearish";
    return "neutral";
  }
  function sentimentLabel(sentiment) {
    if (sentiment === "bullish") return "Preistreibend";
    if (sentiment === "bullish-eu") return "Preistreibend (EU)";
    if (sentiment === "bearish") return "Preisdämpfend";
    return "Neutral";
  }

  // ---- Chart-Konfiguration bauen -----------------------------------
  // Raw EU (USD/mtu WO3) und China (CNY/kg APT) Preise sind unterschiedliche Einheiten und
  // dürfen bei "Beide" nicht direkt auf derselben Y-Achse verglichen werden. Für diesen Fall
  // wird jede Serie rein zur Anzeige auf einen Index (letzter Historienwert = 100) umgerechnet;
  // die Rohdaten in D bleiben unverändert.
  function toIndex(data, lastValue) {
    if (!lastValue) return data.map(() => null);
    return data.map((v) => (v === null || v === undefined ? null : (v / lastValue) * 100));
  }

  function buildSeries() {
    const series = [];
    const showChina = state.region === "china" || state.region === "both";
    const showEu = state.region === "eu" || state.region === "both";
    const indexMode = state.region === "both";
    const hasHighlight = !!(state.highlightScenarios && state.highlightScenarios.length);

    if (showChina) {
      const raw = [...D.CHINA_HISTORY, ...Array(D.FORECAST_LABELS.length).fill(null)];
      series.push({
        id: "actual-china",
        label: "Historie China",
        color: "#101c33",
        dashed: false,
        emphasize: true,
        data: indexMode ? toIndex(raw, D.LAST_CHINA) : raw,
      });
    }
    if (showEu) {
      const raw = [...D.EU_HISTORY, ...Array(D.FORECAST_LABELS.length).fill(null)];
      series.push({
        id: "actual-eu",
        label: "Historie EU",
        color: "#3a4a63",
        dashed: false,
        emphasize: true,
        data: indexMode ? toIndex(raw, D.LAST_EU) : raw,
      });
    }

    D.SCENARIOS.forEach((sc) => {
      if (!state.activeScenarios.has(sc.id)) return;
      const isHL = hasHighlight && state.highlightScenarios.includes(sc.id);
      const faded = hasHighlight && !isHL;

      if (showChina) {
        const data = Array(HIST_COUNT).fill(null);
        data[HIST_COUNT - 1] = D.LAST_CHINA;
        const raw = [...data, ...sc.china];
        series.push({
          id: `${sc.id}-china`,
          label: `${sc.shortName} (CN)`,
          color: sc.color,
          dashed: true,
          faded,
          emphasize: isHL,
          data: indexMode ? toIndex(raw, D.LAST_CHINA) : raw,
        });
      }
      if (showEu) {
        const data = Array(HIST_COUNT).fill(null);
        data[HIST_COUNT - 1] = D.LAST_EU;
        const raw = [...data, ...sc.eu];
        series.push({
          id: `${sc.id}-eu`,
          label: `${sc.shortName} (EU)`,
          color: lighten(sc.color, 0.28),
          dashed: true,
          faded,
          emphasize: isHL,
          data: indexMode ? toIndex(raw, D.LAST_EU) : raw,
        });
      }
    });

    return series;
  }

  // Baseline-Unsicherheitsband (P10/P90) je aktiver Region, um die Modellprognose (P50) - dieselbe
  // Anker-/Index-Logik wie buildSeries() (letzter realer Wert als Übergangspunkt, Index-Skalierung
  // im "Beide"-Modus), damit Band und Basis-Linie exakt zusammenpassen.
  function buildBaselineBands() {
    if (!D.BASELINE) return [];
    const indexMode = state.region === "both";
    const showChina = state.region === "china" || state.region === "both";
    const showEu = state.region === "eu" || state.region === "both";

    function anchor(forecastValues, lastValue) {
      const data = Array(HIST_COUNT - 1).fill(null);
      return [...data, lastValue, ...forecastValues];
    }

    function makeBand(region, baseline, lastValue, color) {
      const p10 = anchor(baseline.p10, lastValue);
      const p50 = anchor(baseline.p50, lastValue);
      const p90 = anchor(baseline.p90, lastValue);
      return {
        id: `baseline-${region}`,
        regionLabel: region === "china" ? "CN" : "EU",
        color,
        p10: indexMode ? toIndex(p10, lastValue) : p10,
        p50: indexMode ? toIndex(p50, lastValue) : p50,
        p90: indexMode ? toIndex(p90, lastValue) : p90,
      };
    }

    const bands = [];
    if (showChina && D.BASELINE.china) bands.push(makeBand("china", D.BASELINE.china, D.LAST_CHINA, "#101c33"));
    if (showEu && D.BASELINE.eu) bands.push(makeBand("eu", D.BASELINE.eu, D.LAST_EU, "#3a4a63"));
    return bands;
  }

  function renderChart() {
    const series = buildSeries();
    const bands = buildBaselineBands();
    const unit = state.region === "eu" ? "USD/mtu WO3"
      : state.region === "china" ? "CNY/kg APT"
      : "Index (Today = 100)";
    window.renderPriceChart(els.chartSvg, els.chartTooltip, {
      labels: ALL_LABELS,
      historyCount: HIST_COUNT,
      series,
      bands,
      unit,
      nonNegativeAxis: state.region === "both",
    });
    renderLegend(series);
  }

  function renderLegend(series) {
    els.chartLegend.innerHTML = series
      .map((s) => `
        <span class="legend-item" style="color:${s.color}">
          <span class="legend-swatch ${s.dashed ? "dashed" : ""}" style="background:${s.dashed ? "none" : s.color}"></span>
          <span style="color:var(--text-muted)">${s.label}</span>
        </span>`)
      .join("");
  }

  // ---- Szenario-Chips -----------------------------------------------
  // "Aktuelle Marktlage" (currentMarket) erscheint bewusst NICHT in dieser Liste - sie hat eine
  // eigene, separate Karte (renderCurrentMarketCard), da sie kein festes Stress-Szenario ist,
  // sondern live aus News abgeleitet und bei jedem Refresh neu berechnet wird.
  function stressScenarios() {
    return D.SCENARIOS.filter((sc) => sc.id !== "currentMarket");
  }

  function renderScenarioToggles() {
    els.scenarioToggles.innerHTML = stressScenarios().map((sc) => {
      const checked = state.activeScenarios.has(sc.id) ? "checked" : "";
      const disabled = sc.alwaysOn ? "disabled" : "";
      const hl = state.highlightScenarios && state.highlightScenarios.includes(sc.id) ? "highlighted" : "";
      return `
        <label class="scenario-chip ${sc.alwaysOn ? "disabled" : ""} ${hl}" data-scenario="${sc.id}" title="${sc.summary}">
          <input type="checkbox" data-id="${sc.id}" ${checked} ${disabled} />
          <span class="dot" style="background:${sc.color}"></span>
          ${sc.shortName}
        </label>`;
    }).join("");

    els.scenarioToggles.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) state.activeScenarios.add(id);
        else state.activeScenarios.delete(id);
        renderChart();
        renderInsights();
      });
    });
  }

  // ---- Insights (sachliche Aussagen) --------------------------------
  function changeSpan(value) {
    if (value === null || value === undefined) return `<span class="change-flat">±0,0%</span>`;
    const cls = value > 0.05 ? "change-up" : value < -0.05 ? "change-down" : "change-flat";
    const sign = value > 0 ? "+" : "";
    return `<span class="${cls}">${sign}${value.toFixed(1)}%</span>`;
  }

  function scenarioBaselineDeltaSpan(value) {
    if (value === null || value === undefined) return "";
    const cls = value > 0.0001 ? "scenario-delta-up" : value < -0.0001 ? "scenario-delta-down" : "scenario-delta-flat";
    return `<small class="scenario-baseline-delta ${cls}">${window.ForecastPresentation.formatPercentagePointDelta(value)}</small>`;
  }

  function renderInsights() {
    const active = stressScenarios().filter((sc) => state.activeScenarios.has(sc.id));
    const baselineScenario = D.SCENARIOS.find((sc) => sc.id === "base");
    els.insightsList.innerHTML = active.map((sc) => `
      <div class="insight-item">
        <div class="insight-head">
          <div class="insight-name"><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${sc.color}"></span>${sc.name}${sc.aiGenerated ? '<span class="ai-badge" title="Von der Bosch Model Farm generierte Einschätzung">KI</span>' : ""}</div>
          <div class="insight-changes">
            <span title="China, 12 Monate">CN: ${changeSpan(sc.expectedChange12m.china)}${window.ForecastPresentation.shouldShowScenarioDelta(sc) ? scenarioBaselineDeltaSpan(window.ForecastPresentation.scenarioDeltaPct(sc, baselineScenario, "china")) : ""}</span>
            <span title="EU, 12 Monate">EU: ${changeSpan(sc.expectedChange12m.eu)}${window.ForecastPresentation.shouldShowScenarioDelta(sc) ? scenarioBaselineDeltaSpan(window.ForecastPresentation.scenarioDeltaPct(sc, baselineScenario, "eu")) : ""}</span>
          </div>
        </div>
        <p class="insight-text">${sc.summary}</p>
      </div>
    `).join("");
  }

  // ---- News-Lage (separate Einordnung, keine statistische Baseline-Anpassung) -------------
  function renderNewsLageV2Card(newsLage) {
    els.currentMarketCard.hidden = false;
    els.currentMarketToggleWrap.hidden = true;
    const windowDays = newsLage.windowDays || 30;
    els.newsLageTitle.innerHTML = `News-Lage &ndash; letzte ${windowDays} Tage <span class="badge badge-category">Separate Einordnung</span>`;
    els.currentMarketLabel.textContent = "";
    els.newsLageScale.hidden = true;
    els.newsLageMethodology.hidden = true;
    els.newsLageDetails.hidden = true;
    els.newsLageEvents.hidden = !newsLage.available;
    els.eventOutcomesPanel.hidden = !newsLage.available;
    els.currentMarketChanges.innerHTML = window.NewsLageManagementPanel.render({ newsLage, region: state.region });
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
    const formatDate = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "\u2014" : date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    };
    const directionLabel = (direction) => ({ bullish: "bullish", bearish: "bearish", neutral: "neutral" })[direction] || "neutral";
    const eventRow = (event, market) => {
      const direction = directionLabel(event.direction);
      const relevance = market === "china" ? event.chinaRelevance : event.euRelevance;
      const relevanceText = market === "both"
        ? `China-Relevanz ${Math.round((event.chinaRelevance || 0) * 100)}% &middot; EU-Relevanz ${Math.round((event.euRelevance || 0) * 100)}%`
        : `${market === "china" ? "China" : "EU"}-Relevanz ${Math.round((relevance || 0) * 100)}%`;
      const sources = event.sources?.length ? event.sources.join(", ") : "Quelle nicht angegeben";
      return `<article class="news-lage-event">
        <div class="news-lage-event-head"><time>${formatDate(event.publishedAt || event.firstSeenAt)}</time><span class="badge badge-${direction}" title="Deterministisches Ereignisgewicht: ${Number(event.finalWeight || 0).toFixed(3)}">${direction}</span></div>
        <strong>${escapeHtml(event.title)}</strong>
        <p>${escapeHtml(sources)} (${event.sourceCount || 0} Quelle${event.sourceCount === 1 ? "" : "n"})</p>
        <p class="news-lage-event-meta">${escapeHtml(event.category)} &middot; ${escapeHtml(event.eventStage)} / ${escapeHtml(event.evidenceMaturity)} &middot; Schwere ${Math.round((event.severity || 0) * 100)}% &middot; Konfidenz ${Math.round((event.confidence || 0) * 100)}% &middot; ${relevanceText}</p>
      </article>`;
    };
    const combinedEvents = [...(newsLage.events?.china || []), ...(newsLage.events?.eu || [])]
      .reduce((byEventId, event) => {
        const existing = byEventId.get(event.eventId);
        if (!existing || Math.abs(event.finalWeight) > Math.abs(existing.finalWeight)) byEventId.set(event.eventId, event);
        return byEventId;
      }, new Map());
    const eventGroups = state.region === "china" ? [["China", newsLage.events?.china || [], "china"]]
      : state.region === "eu" ? [["EU", newsLage.events?.eu || [], "eu"]]
      : [["China & EU", [...combinedEvents.values()].sort((left, right) => Math.abs(right.finalWeight) - Math.abs(left.finalWeight)), "both"]];
    els.newsLageEventsContent.innerHTML = eventGroups.map(([label, events, market]) => `
      <section class="news-lage-event-group"><h3>${label}</h3>${events.length
        ? events.map((event) => eventRow(event, market)).join("")
        : "<p class=\"news-lage-events-empty\">Keine relevanten gespeicherten Ereignisse im Zeitfenster.</p>"}</section>
    `).join("");

    // Separate, collapsed event-study display. It reads stored associations
    // only and never changes forecast or sentiment values.
    const outcomeEntries = [];
    const addOutcomeEntries = (events, market, marketLabel) => events.forEach((event) => {
      outcomeEntries.push({ key: `${market}:${event.eventId}`, event, market, marketLabel });
    });
    if (state.region === "china") addOutcomeEntries(newsLage.events?.china || [], "china", "China");
    else if (state.region === "eu") addOutcomeEntries(newsLage.events?.eu || [], "eu", "EU");
    else {
      addOutcomeEntries(newsLage.events?.china || [], "china", "China");
      addOutcomeEntries(newsLage.events?.eu || [], "eu", "EU");
    }
    if (!outcomeEntries.some((entry) => entry.key === state.selectedOutcomeEventKey)) {
      state.selectedOutcomeEventKey = outcomeEntries[0]?.key || null;
    }
    const selectedOutcomeEntry = outcomeEntries.find((entry) => entry.key === state.selectedOutcomeEventKey);
    const formatPrice = (value, unit) => Number.isFinite(value)
      ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value)} ${escapeHtml(unit || "")}`.trim()
      : "Nicht verf\u00fcgbar";
    const formatReturn = (value) => Number.isFinite(value)
      ? `${value > 0 ? "+" : ""}${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value)}%`
      : "Nicht verf\u00fcgbar";
    const outcomeCell = (byHorizon, horizonWeeks) => {
      const outcome = byHorizon.get(horizonWeeks);
      if (outcome?.status === "pending") {
        return `<div class="event-outcome-horizon"><strong>${horizonWeeks}W</strong><span class="event-outcome-pending">Ausstehend</span></div>`;
      }
      if (outcome?.status !== "available" || !Number.isFinite(outcome.futurePrice) || !Number.isFinite(outcome.returnPct)) {
        return `<div class="event-outcome-horizon"><strong>${horizonWeeks}W</strong><span>Nicht verf\u00fcgbar</span></div>`;
      }
      return `<div class="event-outcome-horizon"><strong>${horizonWeeks}W</strong><span>${formatPrice(outcome.futurePrice, outcome.unit)}</span><small class="${outcome.returnPct > 0 ? "change-up" : outcome.returnPct < 0 ? "change-down" : "change-flat"}">${formatReturn(outcome.returnPct)}</small></div>`;
    };
    if (!selectedOutcomeEntry) {
      els.eventOutcomesContent.innerHTML = "<p class=\"news-lage-events-empty\">Keine gespeicherten Ereignisse f\u00fcr den gew\u00e4hlten Markt.</p>";
    } else {
      const outcomes = Array.isArray(selectedOutcomeEntry.event.priceOutcomes) ? selectedOutcomeEntry.event.priceOutcomes : [];
      const byHorizon = new Map(outcomes.map((outcome) => [outcome.horizonWeeks, outcome]));
      const priceAtEvent = outcomes.find((outcome) => Number.isFinite(outcome.priceAtEvent));
      const direction = directionLabel(selectedOutcomeEntry.event.direction);
      els.eventOutcomesContent.innerHTML = `
        <label class="event-outcome-selector">Ereignis
          <select id="eventOutcomeSelect">${outcomeEntries.map((entry) => `<option value="${escapeHtml(entry.key)}"${entry.key === selectedOutcomeEntry.key ? " selected" : ""}>${escapeHtml(entry.event.title)} (${entry.marketLabel})</option>`).join("")}</select>
        </label>
        <article class="event-outcome-record">
          <div class="event-outcome-record-head"><time>${formatDate(selectedOutcomeEntry.event.publishedAt || selectedOutcomeEntry.event.firstSeenAt)}</time><span class="badge badge-${direction}">${direction}</span></div>
          <strong>${escapeHtml(selectedOutcomeEntry.event.title)}</strong>
          <p>${escapeHtml(selectedOutcomeEntry.event.category)} &middot; ${selectedOutcomeEntry.marketLabel} &middot; Preis zum Ereignis: ${formatPrice(priceAtEvent?.priceAtEvent, priceAtEvent?.unit)}</p>
          <div class="event-outcome-horizons">${[1, 4, 12, 26].map((horizonWeeks) => outcomeCell(byHorizon, horizonWeeks)).join("")}</div>
        </article>`;
      document.getElementById("eventOutcomeSelect")?.addEventListener("change", (event) => {
        state.selectedOutcomeEventKey = event.target.value;
        renderNewsLageV2Card(newsLage);
      });
    }
    els.currentMarketSummary.textContent = "";
  }

  function renderCurrentMarketCard() {
    const newsLage = D.NEWS_LAGE;
    if (newsLage) {
      return renderNewsLageV2Card(newsLage);
      els.currentMarketCard.hidden = false;
      els.currentMarketToggleWrap.hidden = true;
      els.currentMarketLabel.textContent = `${newsLage.windowDays || 30}-Tage-Ereignishistorie`;
      const scoreClass = (score) => score > 20 ? "bullish" : score < -20 ? "bearish" : "neutral";
      const scoreColor = (score) => score > 20 ? "#d1495b" : score < -20 ? "#2a9d8f" : "#6b7789";
      const marketLine = (label, result) => {
        if (!newsLage.available || result.sentimentScore === null) {
          return `<span title="${label}">${label}: nicht verfÃ¼gbar</span>`;
        }
        return `<span title="${label}">${label}: ${result.sentimentScore.toFixed(1)} <span class="badge badge-${scoreClass(result.sentimentScore)}">${result.qualitativeLabel}</span></span>`;
      };
      const china = newsLage.china;
      const eu = newsLage.eu;
      els.currentMarketDot.style.background = newsLage.available ? scoreColor((china.sentimentScore || 0) + (eu.sentimentScore || 0)) : "#6b7789";
      els.currentMarketChanges.innerHTML = `${marketLine("CN", china)}${marketLine("EU", eu)}`;
      els.currentMarketSummary.textContent = newsLage.available
        ? `Deterministische Einordnung aus validierten, gespeicherten Ereignissen der letzten ${newsLage.windowDays} Tage: China ${china.directionalEventCount} gerichtete Ereignisse, EU ${eu.directionalEventCount} gerichtete Ereignisse. Keine Anpassung der statistischen Basisprognose.`
        : "News-Lage aus der lokalen Ereignishistorie ist derzeit nicht verfÃ¼gbar. Die statistische Basisprognose bleibt unverÃ¤ndert.";
      return;
    }

    const sc = D.SCENARIOS.find((s) => s.id === "currentMarket");
    if (!sc) {
      els.currentMarketCard.hidden = true;
      return;
    }
    els.currentMarketCard.hidden = false;
    els.currentMarketToggleWrap.hidden = false;
    els.newsLageTitle.innerHTML = "News-Lage <span class=\"badge badge-category\">Separate Einordnung</span>";
    els.newsLageScale.hidden = true;
    els.newsLageMethodology.hidden = true;
    els.newsLageDetails.hidden = true;
    els.newsLageEvents.hidden = true;
    els.eventOutcomesPanel.hidden = true;
    els.currentMarketLabel.textContent = "Separates 12M-News-Szenario";

    const available = !!(sc.metadata && sc.metadata.available);
    els.currentMarketDot.style.background = sc.color;
    els.currentMarketChanges.innerHTML = `
      <span title="China, 12 Monate">CN: ${changeSpan(sc.expectedChange12m.china)}</span>
      <span title="EU, 12 Monate">EU: ${changeSpan(sc.expectedChange12m.eu)}</span>
      <span class="badge badge-${available ? sentimentClass(sc.sentiment) : "neutral"}">
        ${available ? sentimentLabel(sc.sentiment) : "Kein aktuelles Signal"}
      </span>
    `;
    els.currentMarketSummary.textContent = sc.summary || "";

    // Standardmäßig im Chart sichtbar, sobald sie erstmalig erscheint (z.B. nach dem ersten Refresh).
    if (!state.activeScenarios.has("currentMarket")) state.activeScenarios.add("currentMarket");
    els.currentMarketToggle.checked = state.activeScenarios.has("currentMarket");

    if (!els.currentMarketToggle.dataset.wired) {
      els.currentMarketToggle.dataset.wired = "1";
      els.currentMarketToggle.addEventListener("change", (e) => {
        if (e.target.checked) state.activeScenarios.add("currentMarket");
        else state.activeScenarios.delete("currentMarket");
        renderChart();
      });
    }
  }

  // ---- Historische Ereignisassoziationen (read-only, keine Forecast- oder Sentiment-Logik) -----
  function renderStrategicMarket() {
    els.strategicMarketContent.innerHTML = window.StrategicMarketPanel.render({
      report: D.STRATEGIC_MARKET_INTELLIGENCE,
    });
  }

  function renderHistoricalAssociations() {
    const report = D.HISTORICAL_EVENT_ASSOCIATIONS;
    els.historicalAssociationCard.hidden = !report;
    if (!report) return;
    els.historicalAssociationContent.innerHTML = window.HistoricalAssociationPanel.render({
      report,
      region: state.region,
    });
  }

  // ---- Evidenz-Check (rein erklärend; verwendet ausschließlich API-Fusionsergebnisse) -----
  function renderEvidenceFusion() {
    els.evidenceFusionContent.innerHTML = window.EvidenceFusionPanel.render({
      fusion: D.EVIDENCE_FUSION,
      region: state.region,
      horizonWeeks: state.evidenceFusionHorizon,
    });
    els.evidenceFusionHorizons.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.horizon) === state.evidenceFusionHorizon);
    });
  }

  function wireEvidenceFusionHorizons() {
    els.evidenceFusionHorizons.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        state.evidenceFusionHorizon = Number(button.dataset.horizon);
        renderEvidenceFusion();
      });
    });
  }

  // ---- News / Voices of the Market ----------------------------------
  function renderNews() {
    if (!D.NEWS.length) {
      els.newsList.innerHTML = `<p class="news-empty">Aktuell keine Meldungen verfügbar. Klicke auf "Aktualisieren", um konfigurierte Nachrichtenquellen abzurufen.</p>`;
      return;
    }
    els.newsList.innerHTML = D.NEWS.map((n) => {
      const selected = state.selectedNewsId === n.id ? "selected" : "";
      const titleHtml = n.link
        ? `<a href="${n.link}" target="_blank" rel="noopener noreferrer">${n.title}</a>`
        : n.title;
      return `
        <div class="news-item ${selected}" data-id="${n.id}">
          <div class="news-item-top">
            ${n.real ? '<span class="badge badge-live" title="Echter, live abgerufener Artikel (Google News)">● Live</span>' : ""}
            <span class="badge badge-category">${n.category}</span>
            <span class="news-date">${fmtDate(n.date)}</span>
          </div>
          <div class="news-title">${titleHtml}</div>
          <div class="news-meta">
            <span class="badge badge-${sentimentClass(n.sentiment)}">${sentimentArrow(n.sentiment)} ${sentimentLabel(n.sentiment)}</span>
            <span class="badge badge-category">${n.source}</span>
          </div>
          <p class="news-summary">${n.summary}</p>
          <div class="news-impact"><b>Einschätzung${n.aiGenerated ? ' <span class="ai-badge" title="Von der Bosch Model Farm generiert">KI</span>' : ""}:</b> ${n.impact}</div>
        </div>
      `;
    }).join("");

    els.newsList.querySelectorAll(".news-item").forEach((item) => {
      item.addEventListener("click", () => {
        const id = item.dataset.id;
        const news = D.NEWS.find((n) => n.id === id);
        if (state.selectedNewsId === id) {
          state.selectedNewsId = null;
          state.highlightScenarios = null;
        } else {
          state.selectedNewsId = id;
          state.highlightScenarios = news.scenarios;
        }
        renderNews();
        renderChart();
        renderScenarioToggles();
      });
    });
  }

  // ---- Region-Umschalter ----------------------------------------------
  function wireRegionToggle() {
    els.regionToggle.querySelectorAll(".region-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.region = btn.dataset.region;
        els.regionToggle.querySelectorAll(".region-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        updateUnitDisplay();
        renderChart();
        renderCurrentMarketCard();
        renderHistoricalAssociations();
        renderEvidenceFusion();
      });
    });
  }

  // ---- Toast / Status-Anzeige -------------------------------------------
  let toastTimer = null;
  function showToast(message, type) {
    els.toast.textContent = message;
    els.toast.className = `toast ${type === "error" ? "toast-error" : "toast-success"}`;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
  }

  function setAiPill(status) {
    if (status === null) { els.aiStatusPill.hidden = true; return; }
    els.aiStatusPill.hidden = false;
    els.aiStatusPill.textContent = status.text;
    els.aiStatusPill.classList.toggle("off", status.off);
  }

  async function fetchStatus() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("status nicht erreichbar");
      const json = await res.json();
      setAiPill(AiStatus.pillState({ aiProviderAvailable: json.aiConfigured, classificationStatus: json.aiConfigured ? "no_input" : "unavailable" }));
    } catch (e) {
      // Kein Backend erreichbar (z.B. Datei direkt im Browser geöffnet) -> Pill ausblenden, App bleibt offline nutzbar.
      setAiPill(null);
    }
  }

  // ---- Refresh (ruft Backend /api/refresh auf) ---------------------------
  async function refreshData() {
    if (state.refreshing) return;
    state.refreshing = true;
    els.refreshBtn.disabled = true;
    els.refreshBtn.classList.add("spinning");
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Server antwortete mit ${res.status}`);
      }
      const json = await res.json();

      D = {
        HISTORY_LABELS: json.history.labels,
        FORECAST_LABELS: json.forecastLabels,
        CHINA_HISTORY: json.history.china,
        EU_HISTORY: json.history.eu,
        LAST_CHINA: json.history.china[json.history.china.length - 1],
        LAST_EU: json.history.eu[json.history.eu.length - 1],
        SCENARIOS: json.scenarios,
        NEWS: json.news,
        NEWS_LAGE: json.newsLage || null,
        HISTORICAL_EVENT_ASSOCIATIONS: json.historicalEventAssociations || null,
        BASELINE: json.baseline || null,
        EVIDENCE_FUSION: json.evidenceFusion || null,
        STRATEGIC_MARKET_INTELLIGENCE: json.strategicMarketIntelligence || null,
      };
      recomputeDerived();
      setAiPill(AiStatus.pillState(json));
      els.lastUpdate.textContent = fmtDateTime(json.generatedAt ? new Date(json.generatedAt) : new Date());

      renderScenarioToggles();
      renderCurrentMarketCard();
      renderHistoricalAssociations();
      renderEvidenceFusion();
      renderStrategicMarket();
      renderChart();
      renderInsights();
      renderNews();

      const newsNote = json.newsSource === "live"
        ? " Meldungen aus konfigurierten Quellen geladen."
        : " Aktuell keine Meldungen aus konfigurierten Quellen abrufbar.";
      if (json.aiEnabled) {
        showToast(`Aktualisiert – Szenario-Einschätzungen wurden per KI (Bosch Model Farm) neu generiert.${newsNote}`, "success");
      } else if (json.aiError) {
        showToast(`${json.aiError}${newsNote}`, "error");
      } else {
        showToast(`Daten aktualisiert.${newsNote}`, "success");
      }
    } catch (e) {
      showToast(`Aktualisierung fehlgeschlagen: ${e.message}`, "error");
    } finally {
      state.refreshing = false;
      els.refreshBtn.disabled = false;
      els.refreshBtn.classList.remove("spinning");
    }
  }

  // ---- Init -------------------------------------------------------------
  function init() {
    els.lastUpdate.textContent = fmtDateTime(new Date());
    wireRegionToggle();
    updateUnitDisplay();
    wireEvidenceFusionHorizons();
    renderScenarioToggles();
    renderHistoricalAssociations();
    renderEvidenceFusion();
    renderStrategicMarket();
    renderChart();
    renderInsights();
    renderNews();
    els.refreshBtn.addEventListener("click", refreshData);
    fetchStatus();
    window.addEventListener("resize", renderChart);
    // Beim Laden direkt echte News abrufen, damit nie eine leere Liste zu sehen ist.
    refreshData();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

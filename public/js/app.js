(function () {
  let D = window.CarbideData;

  const state = {
    region: "both", // 'china' | 'eu' | 'both'
    activeScenarios: new Set(D.SCENARIOS.map((s) => s.id)),
    highlightScenarios: null, // set by clicking a news item
    selectedNewsId: null,
    refreshing: false,
  };

  const els = {
    lastUpdate: document.getElementById("lastUpdate"),
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
  function buildSeries() {
    const series = [];
    const showChina = state.region === "china" || state.region === "both";
    const showEu = state.region === "eu" || state.region === "both";
    const hasHighlight = !!(state.highlightScenarios && state.highlightScenarios.length);

    if (showChina) {
      series.push({
        id: "actual-china",
        label: "Historie China",
        color: "#101c33",
        dashed: false,
        emphasize: true,
        data: [...D.CHINA_HISTORY, ...Array(D.FORECAST_LABELS.length).fill(null)],
      });
    }
    if (showEu) {
      series.push({
        id: "actual-eu",
        label: "Historie EU",
        color: "#3a4a63",
        dashed: false,
        emphasize: true,
        data: [...D.EU_HISTORY, ...Array(D.FORECAST_LABELS.length).fill(null)],
      });
    }

    D.SCENARIOS.forEach((sc) => {
      if (!state.activeScenarios.has(sc.id)) return;
      const isHL = hasHighlight && state.highlightScenarios.includes(sc.id);
      const faded = hasHighlight && !isHL;

      if (showChina) {
        const data = Array(HIST_COUNT).fill(null);
        data[HIST_COUNT - 1] = D.LAST_CHINA;
        series.push({
          id: `${sc.id}-china`,
          label: `${sc.shortName} (CN)`,
          color: sc.color,
          dashed: true,
          faded,
          emphasize: isHL,
          data: [...data, ...sc.china],
        });
      }
      if (showEu) {
        const data = Array(HIST_COUNT).fill(null);
        data[HIST_COUNT - 1] = D.LAST_EU;
        series.push({
          id: `${sc.id}-eu`,
          label: `${sc.shortName} (EU)`,
          color: lighten(sc.color, 0.28),
          dashed: true,
          faded,
          emphasize: isHL,
          data: [...data, ...sc.eu],
        });
      }
    });

    return series;
  }

  function renderChart() {
    const series = buildSeries();
    window.renderPriceChart(els.chartSvg, els.chartTooltip, {
      labels: ALL_LABELS,
      historyCount: HIST_COUNT,
      series,
      unit: "USD/kg",
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
  function renderScenarioToggles() {
    els.scenarioToggles.innerHTML = D.SCENARIOS.map((sc) => {
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

  function renderInsights() {
    const active = D.SCENARIOS.filter((sc) => state.activeScenarios.has(sc.id));
    els.insightsList.innerHTML = active.map((sc) => `
      <div class="insight-item">
        <div class="insight-head">
          <div class="insight-name"><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${sc.color}"></span>${sc.name}${sc.aiGenerated ? '<span class="ai-badge" title="Von der Bosch Model Farm generierte Einschätzung">KI</span>' : ""}</div>
          <div class="insight-changes">
            <span title="China, 12 Monate">CN: ${changeSpan(sc.expectedChange12m.china)}</span>
            <span title="EU, 12 Monate">EU: ${changeSpan(sc.expectedChange12m.eu)}</span>
          </div>
        </div>
        <p class="insight-text">${sc.summary}</p>
      </div>
    `).join("");
  }

  // ---- News / Voices of the Market ----------------------------------
  function renderNews() {
    if (!D.NEWS.length) {
      els.newsList.innerHTML = `<p class="news-empty">Aktuell keine News verfügbar. Klicke auf "Aktualisieren", um echte Artikel von Google News abzurufen.</p>`;
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
        renderChart();
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

  function setAiPill(configured) {
    if (configured === null) { els.aiStatusPill.hidden = true; return; }
    els.aiStatusPill.hidden = false;
    els.aiStatusPill.textContent = configured ? "KI-Kommentierung aktiv" : "KI-Kommentierung inaktiv";
    els.aiStatusPill.classList.toggle("off", !configured);
  }

  async function fetchStatus() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("status nicht erreichbar");
      const json = await res.json();
      setAiPill(json.aiConfigured);
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
      };
      recomputeDerived();
      setAiPill(json.aiEnabled);
      els.lastUpdate.textContent = fmtDateTime(json.generatedAt ? new Date(json.generatedAt) : new Date());

      renderScenarioToggles();
      renderChart();
      renderInsights();
      renderNews();

      const newsNote = json.newsSource === "live"
        ? " Echte News per Google News geladen."
        : " Aktuell keine News von Google News abrufbar.";
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
    renderScenarioToggles();
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

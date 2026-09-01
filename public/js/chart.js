/**
 * Leichtgewichtiger, abhängigkeitsfreier SVG-Linienchart.
 * Kein externes Chart-Framework nötig – funktioniert offline direkt im Browser.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /**
   * @param {SVGSVGElement} svg
   * @param {HTMLElement} tooltipEl
   * @param {object} cfg { labels, historyCount, series:[{id,label,color,dashed,data[]}], unit }
   */
  function renderPriceChart(svg, tooltipEl, cfg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 380;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const margin = { top: 18, right: 24, bottom: 34, left: 56 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const { labels, historyCount, series, unit } = cfg;
    const n = labels.length;

    // Y-Skala über alle sichtbaren, nicht-null Werte
    let min = Infinity, max = -Infinity;
    series.forEach((s) => {
      s.data.forEach((v) => {
        if (v === null || v === undefined) return;
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    if (!isFinite(min)) { min = 0; max = 1; }
    const pad = (max - min) * 0.12 || max * 0.1 || 1;
    min -= pad; max += pad;

    const x = (i) => margin.left + (innerW * i) / (n - 1);
    const y = (v) => margin.top + innerH - ((v - min) / (max - min)) * innerH;

    const root = el("g", {});
    svg.appendChild(root);

    // Gridlines + Y-Achsenbeschriftung
    const gridCount = 5;
    for (let g = 0; g <= gridCount; g++) {
      const v = min + ((max - min) * g) / gridCount;
      const gy = y(v);
      root.appendChild(el("line", {
        x1: margin.left, x2: margin.left + innerW, y1: gy, y2: gy,
        stroke: "#e6e8eb", "stroke-width": 1,
      }));
      const label = el("text", {
        x: margin.left - 8, y: gy + 4, "text-anchor": "end",
        class: "chart-axis-label",
      });
      label.textContent = Math.round(v);
      root.appendChild(label);
    }

    // X-Achse: nur jedes n-te Label zeigen, um Überlappung zu vermeiden
    const step = Math.ceil(n / 12);
    for (let i = 0; i < n; i += step) {
      const t = el("text", {
        x: x(i), y: margin.top + innerH + 20, "text-anchor": "middle",
        class: "chart-axis-label",
      });
      t.textContent = labels[i];
      root.appendChild(t);
    }

    // Trennlinie "Heute" zwischen Historie und Prognose
    const todayX = x(historyCount - 1);
    root.appendChild(el("line", {
      x1: todayX, x2: todayX, y1: margin.top, y2: margin.top + innerH,
      stroke: "#9aa3af", "stroke-width": 1.5, "stroke-dasharray": "3,3",
    }));
    const todayLabel = el("text", {
      x: todayX + 4, y: margin.top + 12, class: "chart-today-label",
    });
    todayLabel.textContent = "Heute";
    root.appendChild(todayLabel);

    // Linien zeichnen
    series.forEach((s) => {
      const pts = [];
      s.data.forEach((v, i) => {
        if (v === null || v === undefined) return;
        pts.push(`${x(i)},${y(v)}`);
      });
      if (pts.length < 2) return;
      root.appendChild(el("polyline", {
        points: pts.join(" "),
        fill: "none",
        stroke: s.color,
        "stroke-width": s.emphasize ? 3 : 2.25,
        "stroke-dasharray": s.dashed ? "7,5" : "none",
        opacity: s.faded ? 0.45 : 1,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }));
    });

    // Interaktions-Overlay für Tooltip
    const overlay = el("rect", {
      x: margin.left, y: margin.top, width: innerW, height: innerH,
      fill: "transparent",
    });
    root.appendChild(overlay);

    const cursorLine = el("line", {
      y1: margin.top, y2: margin.top + innerH, stroke: "#c7ccd3", "stroke-width": 1,
      visibility: "hidden",
    });
    root.appendChild(cursorLine);

    function handleMove(evt) {
      const rect = svg.getBoundingClientRect();
      const mx = evt.clientX - rect.left;
      const relX = ((mx - margin.left) / innerW) * (n - 1);
      const idx = Math.min(n - 1, Math.max(0, Math.round(relX)));
      cursorLine.setAttribute("x1", x(idx));
      cursorLine.setAttribute("x2", x(idx));
      cursorLine.setAttribute("visibility", "visible");

      const rows = series
        .filter((s) => s.data[idx] !== null && s.data[idx] !== undefined)
        .map((s) => `<div class="tt-row"><span class="tt-dot" style="background:${s.color}"></span>${s.label}: <b>${s.data[idx].toFixed(1)} ${unit}</b></div>`)
        .join("");
      tooltipEl.innerHTML = `<div class="tt-date">${labels[idx]}</div>${rows}`;
      tooltipEl.style.display = "block";
      const tw = tooltipEl.offsetWidth;
      let left = evt.clientX - rect.left + 14;
      if (left + tw > width) left = evt.clientX - rect.left - tw - 14;
      tooltipEl.style.left = left + "px";
      tooltipEl.style.top = (y(series[0].data[idx] ?? (min + max) / 2) - 10) + "px";
    }
    overlay.addEventListener("mousemove", handleMove);
    overlay.addEventListener("mouseleave", () => {
      cursorLine.setAttribute("visibility", "hidden");
      tooltipEl.style.display = "none";
    });
  }

  window.renderPriceChart = renderPriceChart;
})();

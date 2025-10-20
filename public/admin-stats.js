(function () {
  const container = document.querySelector("[data-view-trends]");
  if (!container) {
    return;
  }

  const endpoint = container.getAttribute("data-endpoint") || "/admin/stats/trends.json";
  const initialRange = Number.parseInt(container.getAttribute("data-initial-range"), 10) || 14;
  const chartRegion = container.querySelector("[data-chart-region]");
  const fallback = container.querySelector("[data-chart-fallback]");
  const statusEl = container.querySelector("[data-chart-status]");
  const totalEl = container.querySelector("[data-chart-total]");
  const rangeLabelEl = container.querySelector("[data-chart-range-label]");
  const generatedAtEl = container.querySelector("[data-chart-generated-at]");
  const tableBody = container.querySelector("[data-chart-table-body]");
  const buttons = Array.from(container.querySelectorAll("[data-trend-range]"));

  const locale = document.documentElement.lang || "fr-FR";
  const shortDateFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  });
  const fullDateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
  });
  const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  });
  const numberFormatter = new Intl.NumberFormat(locale);

  let currentRange = initialRange;
  let loading = false;

  const NS = "http://www.w3.org/2000/svg";

  function setStatus(message, { isError = false, isBusy = false } = {}) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.dataset.status = isError ? "error" : isBusy ? "loading" : "idle";
  }

  function setLoadingState(isLoading) {
    loading = isLoading;
    container.classList.toggle("is-loading", Boolean(isLoading));
    if (isLoading) {
      setStatus("Chargement des tendances…", { isBusy: true });
    }
  }

  function updateButtons(selectedRange) {
    buttons.forEach((button) => {
      const value = Number.parseInt(button.getAttribute("data-trend-range"), 10);
      const isActive = Number.isFinite(value) && value === selectedRange;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
      button.toggleAttribute("disabled", isActive);
    });
  }

  function clearChart() {
    if (!chartRegion) {
      return;
    }
    while (chartRegion.firstChild) {
      chartRegion.removeChild(chartRegion.firstChild);
    }
  }

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS(NS, name);
    for (const [attr, value] of Object.entries(attributes)) {
      element.setAttribute(attr, String(value));
    }
    return element;
  }

  function renderSeries(points) {
    if (!chartRegion) {
      return;
    }

    clearChart();

    if (!points || !points.length) {
      const emptyMessage = document.createElement("p");
      emptyMessage.className = "stats-trends-empty";
      emptyMessage.textContent = "Aucune donnée n'est disponible pour la période sélectionnée.";
      chartRegion.appendChild(emptyMessage);
      return;
    }

    const width = 720;
    const height = 320;
    const padding = { top: 32, right: 32, bottom: 56, left: 64 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const values = points.map((point) => Number(point.views) || 0);
    const maxValue = Math.max(...values, 1);
    const minValue = 0;

    const svg = createSvgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-labelledby": "admin-trends-title admin-trends-desc",
    });
    svg.classList.add("stats-trends-svg");

    const title = createSvgElement("title", { id: "admin-trends-title" });
    title.textContent = "Courbe des vues quotidiennes";
    svg.appendChild(title);

    const desc = createSvgElement("desc", { id: "admin-trends-desc" });
    desc.textContent = `Historique sur ${points.length} jour(s).`;
    svg.appendChild(desc);

    const defs = createSvgElement("defs");
    const gradient = createSvgElement("linearGradient", {
      id: "admin-trends-gradient",
      x1: "0%",
      y1: "0%",
      x2: "0%",
      y2: "100%",
    });
    gradient.appendChild(createSvgElement("stop", { offset: "0%", "stop-color": "var(--color-accent-strong)", "stop-opacity": "0.35" }));
    gradient.appendChild(createSvgElement("stop", { offset: "100%", "stop-color": "var(--color-accent)", "stop-opacity": "0" }));
    defs.appendChild(gradient);
    svg.appendChild(defs);

    const axisGroup = createSvgElement("g", { class: "stats-trends-axes" });
    const baselineY = height - padding.bottom;
    axisGroup.appendChild(createSvgElement("line", {
      x1: padding.left,
      y1: baselineY,
      x2: width - padding.right,
      y2: baselineY,
      class: "stats-trends-axis-line",
    }));

    const yTicks = 4;
    for (let i = 0; i <= yTicks; i += 1) {
      const ratio = i / yTicks;
      const value = minValue + (maxValue - minValue) * ratio;
      const y = height - padding.bottom - ratio * chartHeight;
      axisGroup.appendChild(
        createSvgElement("line", {
          x1: padding.left,
          x2: width - padding.right,
          y1: y,
          y2: y,
          class: "stats-trends-grid-line",
        }),
      );
      const label = createSvgElement("text", {
        x: padding.left - 12,
        y: y + 4,
        class: "stats-trends-axis-label",
      });
      label.textContent = numberFormatter.format(Math.round(value));
      axisGroup.appendChild(label);
    }

    svg.appendChild(axisGroup);

    const stepX = points.length > 1 ? chartWidth / (points.length - 1) : chartWidth;

    const coordinates = points.map((point, index) => {
      const value = Number(point.views) || 0;
      const ratio = maxValue === minValue ? 0 : (value - minValue) / (maxValue - minValue);
      const x = padding.left + stepX * index;
      const y = height - padding.bottom - ratio * chartHeight;
      return { x, y, value, date: point.date };
    });

    const linePath = coordinates
      .map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(2)},${coord.y.toFixed(2)}`)
      .join(" ");

    const areaPath = `${linePath} L${coordinates.at(-1).x.toFixed(2)},${baselineY} L${coordinates[0].x.toFixed(2)},${baselineY} Z`;

    const area = createSvgElement("path", {
      d: areaPath,
      class: "stats-trends-area",
      fill: "url(#admin-trends-gradient)",
    });
    svg.appendChild(area);

    const line = createSvgElement("path", {
      d: linePath,
      class: "stats-trends-line",
    });
    svg.appendChild(line);

    const dotsGroup = createSvgElement("g", { class: "stats-trends-dots" });
    coordinates.forEach((coord) => {
      const circle = createSvgElement("circle", {
        cx: coord.x,
        cy: coord.y,
        r: 4,
        class: "stats-trends-dot",
      });
      circle.appendChild(document.createComment(`${coord.date}: ${coord.value}`));
      dotsGroup.appendChild(circle);
    });
    svg.appendChild(dotsGroup);

    const tickCount = Math.min(points.length, 6);
    const usedIndices = new Set();
    const ticksGroup = createSvgElement("g", { class: "stats-trends-ticks" });
    for (let i = 0; i < tickCount; i += 1) {
      const ratio = tickCount === 1 ? 0 : i / (tickCount - 1);
      const index = Math.min(points.length - 1, Math.round(ratio * (points.length - 1)));
      if (usedIndices.has(index)) {
        continue;
      }
      usedIndices.add(index);
      const coord = coordinates[index];
      const label = createSvgElement("text", {
        x: coord.x,
        y: height - padding.bottom + 28,
        class: "stats-trends-axis-label stats-trends-axis-label--x",
      });
      label.textContent = shortDateFormatter.format(new Date(`${coord.date}T00:00:00Z`));
      ticksGroup.appendChild(label);
    }
    svg.appendChild(ticksGroup);

    chartRegion.appendChild(svg);
  }

  function updateMeta({ range, totals, generatedAt }) {
    if (rangeLabelEl && range?.from && range?.to) {
      const fromDate = new Date(`${range.from}T00:00:00Z`);
      const toDate = new Date(`${range.to}T00:00:00Z`);
      rangeLabelEl.textContent = `${fullDateFormatter.format(fromDate)} – ${fullDateFormatter.format(toDate)}`;
    }
    if (totalEl) {
      const totalViews = totals?.views || 0;
      totalEl.textContent = numberFormatter.format(totalViews);
    }
    if (generatedAtEl && generatedAt) {
      generatedAtEl.textContent = dateTimeFormatter.format(new Date(generatedAt));
    }
  }

  function updateTable(points) {
    if (!tableBody) {
      return;
    }
    tableBody.innerHTML = "";
    points.forEach((point) => {
      const row = document.createElement("tr");
      const header = document.createElement("th");
      header.scope = "row";
      header.textContent = point.date;
      const cell = document.createElement("td");
      cell.textContent = numberFormatter.format(Number(point.views) || 0);
      row.appendChild(header);
      row.appendChild(cell);
      tableBody.appendChild(row);
    });
  }

  async function fetchSeries(range) {
    if (loading) {
      return;
    }
    setLoadingState(true);
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("range", String(range));
      url.searchParams.set("_", Date.now().toString(36));
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Requête refusée (${response.status})`);
      }
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.points)) {
        throw new Error("Réponse inattendue");
      }
      renderSeries(payload.points);
      updateTable(payload.points);
      updateMeta(payload);
      currentRange = payload.range?.days || range;
      updateButtons(currentRange);
      if (fallback) {
        fallback.hidden = true;
      }
      const daysLabel = payload.points.length > 1 ? `${payload.points.length} jours` : "1 jour";
      setStatus(`Tendances mises à jour (${daysLabel}).`);
    } catch (error) {
      console.error("Impossible de charger les tendances des vues :", error);
      setStatus("Impossible de charger les tendances pour le moment.", { isError: true });
      if (fallback) {
        fallback.hidden = false;
      }
    } finally {
      setLoadingState(false);
    }
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const value = Number.parseInt(button.getAttribute("data-trend-range"), 10);
      if (!Number.isFinite(value) || value === currentRange) {
        return;
      }
      fetchSeries(value);
    });
  });

  updateButtons(currentRange);
  setStatus("Chargement des tendances…", { isBusy: true });
  fetchSeries(currentRange);
})();

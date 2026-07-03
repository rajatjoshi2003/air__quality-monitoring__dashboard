// ============================================================
// AirWatch — Application Logic
// ============================================================

// ── State ─────────────────────────────────────────────────
const state = {
  city:        'delhi',
  timeRange:   '24h',
  view:        'overview',
  theme:       'dark',
  data:        [],
  regional:    {},
  charts:      {},
  activePollutants: new Set(['pm25', 'pm10', 'no2', 'o3', 'co', 'so2']),
  liveTimer:   null,
  forecast:    { model: 'holtWinters', horizon: 24, built: false },
  liveByCity:  {},   // cityId → last live WAQI snapshot { aqi, category, station, iaqi, dominant, lastUpdate, ts }
};

// Expose on window so sibling modules (filters.js, analytics.js, etl-*.js)
// can read/write the live dashboard state. They reference `window.state`;
// without this the KPI dashboard, Analytics Studio and ETL "current state"
// source all see an empty dataset.
window.state = state;

// ── Chart.js global defaults ──────────────────────────────
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.color = '#8b9dc3';

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadThemeFromStorage();
  refreshData();
  bindEvents();
  buildAboutContent();
  tick(); // clock
  setInterval(tick, 1000);
  // Auto-refresh every 60 s
  state.liveTimer = setInterval(() => {
    refreshData(true);
  }, 60_000);
});

// ── Clock ─────────────────────────────────────────────────
function tick() {
  const el = document.getElementById('last-update-time');
  if (el) el.textContent = new Date().toLocaleTimeString();
}

// ── Theme ─────────────────────────────────────────────────
function loadThemeFromStorage() {
  const saved = localStorage.getItem('aw-theme') || 'dark';
  applyTheme(saved);
}
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('aw-theme', theme);
}

// CPCB updates roughly hourly; treat a live snapshot as stale after 30 min.
const LIVE_TTL_MS = 30 * 60 * 1000;

// Re-apply the cached live CPCB snapshot for the current city onto the
// freshly-generated synthetic series. refreshData() regenerates state.data every
// 60 s, which would otherwise wipe the live value between the 5-min fetches —
// this keeps the latest reading + regional snapshot live (and internally
// consistent across all pollutants) until the snapshot expires.
function _applyLiveSnapshot() {
  const live = state.liveByCity[state.city];
  if (!live || Date.now() - live.ts > LIVE_TTL_MS) return false;

  const POLS = ['pm25', 'pm10', 'no2', 'so2', 'o3', 'co'];
  if (state.data.length) {
    const last = state.data[state.data.length - 1];
    last.aqi = live.aqi;
    POLS.forEach(p => { if (live.pollutants?.[p] != null) last[p] = live.pollutants[p]; });
    last._live = true;
  }
  if (state.regional[state.city]) {
    state.regional[state.city].aqi = live.aqi;
    if (live.pollutants?.pm25 != null) state.regional[state.city].pm25 = +live.pollutants.pm25.toFixed(1);
    state.regional[state.city]._liveStation = live.station;
  }
  const stn = live.station ? ` · ${live.station}` : '';
  updateSourceBadge('live', `WAQI Live${stn}`);
  return true;
}

// ── Data Refresh ──────────────────────────────────────────
function refreshData(silent = false) {
  const cfg  = getRangeConfig(state.timeRange);
  state.data = generateHistoricalData(state.city, cfg.points, cfg.intervalMs);
  state.regional = generateAllCitiesSnapshot();

  // Re-apply any fresh live CPCB value so the 60 s synthetic refresh keeps it;
  // if the snapshot has expired, clear a lingering "WAQI Live" badge.
  if (!_applyLiveSnapshot()) {
    const b = document.getElementById('source-badge');
    if (b && b.classList.contains('live')) updateSourceBadge('synth', 'Synthetic');
  }

  // Only rebuild the view the user is actually looking at — avoids
  // re-rendering hidden charts (esp. on the 60 s auto-refresh).
  const renderers = {
    overview: renderOverview, trends: renderTrends, comparison: renderComparison,
    heatmap: renderHeatmap, health: renderHealth, forecast: renderForecast,
  };
  (renderers[state.view] || renderOverview)();

  if (!silent) showToast(`Data loaded for ${CITIES[state.city].name}`);
}

// ═══════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════
function bindEvents() {
  // Sidebar toggle (desktop mini-collapse)
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  // Mobile off-canvas drawer
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const closeDrawer = () => { sidebar.classList.remove('mobile-open'); backdrop.classList.remove('show'); };
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    sidebar.classList.add('mobile-open');
    backdrop.classList.add('show');
  });
  backdrop?.addEventListener('click', closeDrawer);

  // Navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(el.dataset.view);
      closeDrawer();   // dismiss the drawer after picking a view on mobile
    });
  });

  // City selector
  document.getElementById('city-select').addEventListener('change', e => {
    state.city = e.target.value;
    document.getElementById('gauge-city-name').textContent = CITIES[state.city].name;
    refreshData();
    // Pull live CPCB data for the newly selected city (refreshData only re-applies
    // a cached snapshot; a city we haven't fetched yet needs a fresh request).
    tryLiveFetch();
  });

  // Time range buttons
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.timeRange = btn.dataset.range;
      refreshData();
    });
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    const icon = document.querySelector('#refresh-btn svg');
    icon.classList.add('spinning');
    refreshData();
    setTimeout(() => icon.classList.remove('spinning'), 800);
  });

  // Export CSV
  document.getElementById('export-btn').addEventListener('click', exportCSV);

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    rebuildAllCharts();
  });
}

function navigateTo(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`)?.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });

  const labels = { overview: 'Overview', trends: 'Trends', comparison: 'Comparison',
                   heatmap: 'Heatmap', health: 'Health Advisory', forecast: 'Forecast',
                   pipeline: 'Data Pipeline',
                   database: 'Database',
                   etl: 'ETL Studio',
                   kpis: 'KPI Dashboard',
                   analytics: 'Analytics Studio',
                   sensors: 'Sensor Network', datasources: 'Data Sources', about: 'About AQI' };
  document.getElementById('page-title').textContent    = labels[view] || view;
  document.getElementById('breadcrumb-view').textContent = labels[view] || view;

  // Lazy-render views on first visit
  if (view === 'trends')     renderTrends();
  if (view === 'comparison') renderComparison();
  if (view === 'heatmap')    renderHeatmap();
  if (view === 'health')     renderHealth();
  if (view === 'forecast')   renderForecast();
  if (view === 'about')      buildAboutContent();
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function isDark() { return state.theme === 'dark'; }

function gridColor() { return isDark() ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'; }

function aqiToColor(aqi) { return getAQICategory(aqi).color; }

function clampPct(val, limit) { return Math.min(100, Math.round((val / (limit * 3)) * 100)); }

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function rebuildAllCharts() {
  Object.keys(state.charts).forEach(k => { state.charts[k].destroy(); delete state.charts[k]; });
  renderOverview();
  if (state.view === 'trends')     renderTrends();
  if (state.view === 'comparison') renderComparison();
  if (state.view === 'health')     renderHealth();
  if (state.view === 'forecast')   renderForecast();
}

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  document.getElementById('toast-text').textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), duration);
}

function showAlert(msg, color = 'var(--aqi-hazardous)') {
  const el   = document.getElementById('alert-banner');
  const text = document.getElementById('alert-text');
  el.style.background = color;
  text.textContent = msg;
  el.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// VIEW: OVERVIEW
// ═══════════════════════════════════════════════════════════
function renderOverview() {
  const latest = state.data[state.data.length - 1];
  if (!latest) return;

  updateGauge(latest.aqi);
  updateAlertIndicator(latest.aqi);
  updateKPICards(latest);
  renderTrendChart();
  renderPollutantBarChart(latest);
  renderLiveSubindices();
  renderRegionalChart();
  updateTrendSubtitle();

  const cat = getAQICategory(latest.aqi);
  if (latest.aqi >= 201) showAlert(`⚠ ${CITIES[state.city].name}: ${cat.label} air quality (AQI ${latest.aqi}). ${cat.advice}`, cat.color);
}

// ── AQI Gauge ─────────────────────────────────────────────
function updateGauge(aqi) {
  const PI  = Math.PI;
  const R   = 88;   // radius
  const cx  = 110;  // SVG center x (viewBox 220)
  const cy  = 112;  // SVG center y (baseline)

  // Needle angle: aqi=0 → left (π), aqi=500 → right (0)
  const angleRad = PI - (aqi / 500) * PI;
  const nx = cx + R * Math.cos(angleRad);
  const ny = cy - R * Math.sin(angleRad);

  const needle = document.getElementById('gauge-needle');
  if (needle) { needle.setAttribute('x2', nx.toFixed(1)); needle.setAttribute('y2', ny.toFixed(1)); }

  const cat = getAQICategory(aqi);
  const valEl  = document.getElementById('gauge-value-text');
  const catEl  = document.getElementById('gauge-category-text');
  if (valEl) { valEl.textContent = aqi; valEl.setAttribute('fill', cat.color); }
  if (catEl) { catEl.textContent = cat.short.toUpperCase(); }
}

function updateAlertIndicator(aqi) {
  const loc = document.querySelector('.aqi-location');
  if (!loc) return;
  let badge = document.getElementById('gauge-alert');
  if (aqi >= 301) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'gauge-alert';
      badge.className = 'gauge-alert';
      badge.title = 'Hazardous AQI';
      badge.textContent = '☠️ HAZARD';
      loc.appendChild(badge);
    } else {
      badge.style.display = 'inline-flex';
    }
  } else if (badge) {
    badge.remove();
  }
}

// ── KPI Cards ─────────────────────────────────────────────
const KPI_META = [
  { id: 'pm25', who: 15 }, { id: 'pm10', who: 45 },
  { id: 'no2',  who: 25 }, { id: 'o3',   who: 100 },
  { id: 'co',   who: 4  }, { id: 'so2',  who: 40  },
];
function updateKPICards(data) {
  KPI_META.forEach(({ id, who }) => {
    const val = data[id];
    const pct = Math.min(100, Math.round((val / (who * 4)) * 100));
    const el  = document.getElementById(`kpi-${id}-val`);
    const bar = document.getElementById(`kpi-${id}-bar`);
    if (el)  el.textContent = id === 'co' ? val.toFixed(1) : val;
    if (bar) bar.style.width = pct + '%';
  });
}

function updateTrendSubtitle() {
  const cfg   = getRangeConfig(state.timeRange);
  const el    = document.getElementById('trend-subtitle');
  if (el) el.textContent = `Last ${cfg.label}`;
}

// ── Trend Chart ───────────────────────────────────────────
function renderTrendChart() {
  destroyChart('trend');
  const ctx  = document.getElementById('chart-trend')?.getContext('2d');
  if (!ctx) return;

  const cfg    = getRangeConfig(state.timeRange);
  const labels = state.data.map(d => formatTimestamp(d.timestamp, cfg.fmt));
  const aqiVals= state.data.map(d => d.aqi);

  const grad = ctx.createLinearGradient(0, 0, 0, 280);
  grad.addColorStop(0, 'rgba(59,130,246,0.35)');
  grad.addColorStop(1, 'rgba(59,130,246,0.02)');

  state.charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'AQI',
        data: aqiVals,
        borderColor: '#3b82f6',
        backgroundColor: grad,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.4,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            afterLabel: ctx => {
              const cat = getAQICategory(ctx.raw);
              return `Status: ${cat.label}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
        y: { grid: { color: gridColor() }, min: 0,
             ticks: {
               callback: v => v,
             },
             afterDataLimits(scale) { scale.max = Math.max(scale.max, 100); },
        },
      },
    },
  });
}

// ── Pollutant Bar Chart ───────────────────────────────────
function renderPollutantBarChart(latest) {
  destroyChart('pollBar');
  const ctx = document.getElementById('chart-pollutant-bar')?.getContext('2d');
  if (!ctx) return;

  const pols    = POLLUTANTS.filter(p => p.id !== 'co'); // co has different unit
  const labels  = pols.map(p => p.name);
  const actual  = pols.map(p => latest[p.id]);
  const limits  = pols.map(p => p.who);

  state.charts.pollBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Current',
          data: actual,
          backgroundColor: pols.map(p => p.color + 'cc'),
          borderColor: pols.map(p => p.color),
          borderWidth: 1.5,
          borderRadius: 5,
        },
        {
          label: 'WHO Limit',
          data: limits,
          backgroundColor: 'rgba(255,255,255,0.06)',
          borderColor: 'rgba(255,255,255,0.25)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          borderRadius: 5,
          type: 'bar',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 6 } },
      },
    },
  });
}

// ── Live pollutant sub-index breakdown (WAQI iaqi) ─────────
// WAQI reports per-pollutant US-EPA AQI sub-indices (0–500), NOT concentrations,
// so these are shown on the AQI scale here — kept separate from the WHO µg/m³
// "Pollutant Levels" chart to avoid mixing units. Hidden unless a fresh live
// snapshot with iaqi data exists for the current city.
function renderLiveSubindices() {
  const card = document.getElementById('live-iaqi-card');
  const grid = document.getElementById('live-iaqi-grid');
  if (!card || !grid) return;

  const live = state.liveByCity[state.city];
  const iaqi = live && (Date.now() - live.ts <= LIVE_TTL_MS) ? live.iaqi : null;
  const entries = iaqi
    ? POLLUTANTS.filter(p => iaqi[p.id] && typeof iaqi[p.id].v === 'number')
    : [];

  if (!entries.length) { card.style.display = 'none'; return; }

  const sub = document.getElementById('live-iaqi-sub');
  if (sub) {
    const when = live.lastUpdate ? ` · ${live.lastUpdate}` : '';
    sub.textContent = `WAQI${live.station ? ' · ' + live.station : ''} · US-EPA sub-index (0–500)${when}`;
  }

  grid.innerHTML = entries.map(p => {
    const v   = iaqi[p.id].v;
    const cat = getAQICategory(v);
    const pct = Math.min(100, Math.max(2, v / 500 * 100));
    const dom = live.dominant === p.id;
    return `
      <div class="live-iaqi-row" style="display:flex;align-items:center;gap:10px;margin:7px 0">
        <span style="width:54px;font-size:12px;font-weight:${dom ? 700 : 400};color:var(--text-secondary)" title="${dom ? 'Dominant pollutant' : ''}">${dom ? '▸ ' : ''}${p.name}</span>
        <div style="flex:1;height:14px;background:rgba(128,128,128,0.18);border-radius:7px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${cat.color};border-radius:7px;transition:width .4s"></div>
        </div>
        <span style="width:36px;text-align:right;font-weight:600;font-size:13px;color:${cat.color}">${v}</span>
      </div>`;
  }).join('');

  card.style.display = '';
}

// ── Regional Snapshot Chart ───────────────────────────────
function renderRegionalChart() {
  destroyChart('regional');
  const ctx = document.getElementById('chart-regional')?.getContext('2d');
  if (!ctx) return;

  const cities = Object.values(state.regional).sort((a, b) => a.aqi - b.aqi);
  const labels = cities.map(c => c.name);
  const aqis   = cities.map(c => c.aqi);
  const colors = aqis.map(a => aqiToColor(a) + 'cc');

  state.charts.regional = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'AQI',
        data: aqis,
        backgroundColor: colors,
        borderColor: aqis.map(a => aqiToColor(a)),
        borderWidth: 1.5,
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: ctx => `Status: ${getAQICategory(ctx.raw).label}`,
          },
        },
      },
      scales: {
        x: { grid: { color: gridColor() }, min: 0 },
        y: { grid: { display: false } },
      },
    },
  });
}

// ═══════════════════════════════════════════════════════════
// VIEW: TRENDS
// ═══════════════════════════════════════════════════════════
function renderTrends() {
  buildPollutantToggles();
  renderMultiTrendChart();
  renderDailyAvgChart();
  renderRadarChart();
}

function buildPollutantToggles() {
  const container = document.getElementById('pollutant-toggles');
  if (!container || container.dataset.built) return;
  container.dataset.built = '1';

  POLLUTANTS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'pill-toggle on';
    btn.textContent = p.name;
    btn.style.borderColor = p.color;
    btn.style.background  = p.color + '33';
    btn.style.color       = p.color;
    btn.dataset.pid = p.id;

    btn.addEventListener('click', () => {
      if (state.activePollutants.has(p.id)) {
        state.activePollutants.delete(p.id);
        btn.classList.remove('on');
        btn.style.background = 'var(--bg-input)';
        btn.style.color      = 'var(--text-secondary)';
      } else {
        state.activePollutants.add(p.id);
        btn.classList.add('on');
        btn.style.background = p.color + '33';
        btn.style.color      = p.color;
      }
      renderMultiTrendChart();
    });
    container.appendChild(btn);
  });
}

function renderMultiTrendChart() {
  destroyChart('multiTrend');
  const ctx = document.getElementById('chart-multi-trend')?.getContext('2d');
  if (!ctx) return;

  const cfg    = getRangeConfig(state.timeRange);
  const labels = state.data.map(d => formatTimestamp(d.timestamp, cfg.fmt));
  const maxPoints = 60;
  const stride = Math.max(1, Math.floor(state.data.length / maxPoints));

  const sampledLabels = labels.filter((_, i) => i % stride === 0);
  const sampledData   = state.data.filter((_, i) => i % stride === 0);

  const datasets = POLLUTANTS
    .filter(p => state.activePollutants.has(p.id))
    .map(p => ({
      label: `${p.name} (${p.unit})`,
      data: sampledData.map(d => d[p.id]),
      borderColor: p.color,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.4,
    }));

  state.charts.multiTrend = new Chart(ctx, {
    type: 'line',
    data: { labels: sampledLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, usePointStyle: true } } },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
        y: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 6 } },
      },
    },
  });
}

function renderDailyAvgChart() {
  destroyChart('dailyAvg');
  const ctx = document.getElementById('chart-daily-avg')?.getContext('2d');
  if (!ctx) return;

  // Generate 30 daily averages
  const dailyData = generateHistoricalData(state.city, 30, 86_400_000);
  const labels    = dailyData.map(d => formatTimestamp(d.timestamp, 'MMM DD'));
  const aqis      = dailyData.map(d => d.aqi);
  const colors    = aqis.map(a => aqiToColor(a) + 'bb');

  state.charts.dailyAvg = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Daily AQI',
        data: aqis,
        backgroundColor: colors,
        borderColor: aqis.map(a => aqiToColor(a)),
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 30 } },
        y: { grid: { color: gridColor() }, min: 0 },
      },
    },
  });
}

function renderRadarChart() {
  destroyChart('radar');
  const ctx = document.getElementById('chart-radar')?.getContext('2d');
  if (!ctx) return;

  const latest = state.data[state.data.length - 1];
  const labels  = POLLUTANTS.map(p => p.name);
  const normed  = POLLUTANTS.map(p => {
    const val = latest[p.id];
    return Math.min(300, Math.round((val / p.who) * 100));
  });

  state.charts.radar = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [
        {
          label: 'Current (% of WHO limit)',
          data: normed,
          backgroundColor: 'rgba(59,130,246,0.2)',
          borderColor: '#3b82f6',
          borderWidth: 2,
          pointBackgroundColor: '#3b82f6',
          pointRadius: 3,
        },
        {
          label: 'WHO 100%',
          data: new Array(POLLUTANTS.length).fill(100),
          backgroundColor: 'rgba(255,255,255,0.03)',
          borderColor: 'rgba(255,255,255,0.2)',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
      scales: {
        r: {
          grid: { color: gridColor() },
          ticks: { display: false },
          pointLabels: { color: 'var(--text-secondary)', font: { size: 11 } },
        },
      },
    },
  });
}

// ═══════════════════════════════════════════════════════════
// VIEW: FORECAST
// ═══════════════════════════════════════════════════════════
const FORECAST_HISTORY_HOURS = 168;   // 7 days of hourly data to train on
const FORECAST_CHART_LOOKBACK = 72;   // hours of history shown on the chart

function buildForecastControls() {
  if (state.forecast.built) return;
  state.forecast.built = true;

  // Model dropdown
  const sel = document.getElementById('forecast-model');
  if (sel) {
    sel.innerHTML = Object.entries(Forecaster.MODELS)
      .map(([id, m]) => `<option value="${id}">${m.label}</option>`).join('');
    sel.value = state.forecast.model;
    sel.addEventListener('change', () => {
      state.forecast.model = sel.value;
      renderForecast();
    });
  }

  // Horizon tabs
  document.querySelectorAll('#forecast-horizon-tabs .forecast-horizon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#forecast-horizon-tabs .forecast-horizon-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.forecast.horizon = parseInt(btn.dataset.h, 10);
      renderForecast();
    });
  });
}

function aqiValueClass(aqi) {
  if (aqi <= 50)  return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 200) return 'unhealthy';
  return 'hazardous';
}

function renderForecast() {
  buildForecastControls();
  if (window.ApiClient && ApiClient.getMode() === 'backend') {
    renderForecastFromBackend();
  } else {
    renderForecastBrowser();
  }
}

function renderForecastBrowser() {
  const { model, horizon } = state.forecast;

  // Build the training series: 7 days of hourly AQI for the active city
  const series  = generateHistoricalData(state.city, FORECAST_HISTORY_HOURS, 3_600_000);
  const history = series.map(d => ({ timestamp: d.timestamp, value: d.aqi }));

  let result;
  try {
    result = Forecaster.run(history, { method: model, horizon });
  } catch (e) {
    showToast(`Forecast error: ${e.message}`);
    return;
  }

  document.getElementById('forecast-model-desc').textContent = Forecaster.MODELS[model].desc;
  document.getElementById('forecast-chart-sub').textContent =
    `${CITIES[state.city].name} · ${FORECAST_CHART_LOOKBACK} h history + ${horizon} h projection`;

  renderForecastCards(history, result);
  renderForecastChart(history, result);
  renderForecastTable(result);
  renderForecastAccuracyChart(history);
}

async function renderForecastFromBackend() {
  const { model, horizon } = state.forecast;
  try {
    const { data } = await ApiClient.forecast.aqi(state.city, { method: model, horizon });

    // Normalise ISO timestamps -> epoch ms so the shared renderers work
    const history = data.history.map(h => ({ timestamp: Date.parse(h.timestamp), value: h.value }));
    const result = {
      method: data.method, label: data.label, horizon: data.horizon, sigma: data.sigma,
      accuracy: data.accuracy,
      points: data.points.map(p => ({
        timestamp: Date.parse(p.timestamp), value: p.value, lower: p.lower, upper: p.upper,
      })),
    };

    document.getElementById('forecast-model-desc').textContent = Forecaster.MODELS[model].desc;
    document.getElementById('forecast-chart-sub').textContent =
      `${CITIES[state.city].name} · backend API · ${horizon} h projection`;

    renderForecastCards(history, result);
    renderForecastChart(history, result);
    renderForecastTable(result);
    renderForecastAccuracyChart(history);   // model comparison computed client-side from the same history
  } catch (e) {
    showToast(`Backend forecast failed (${e.message}) — using browser data`);
    renderForecastBrowser();
  }
}

function renderForecastCards(history, result) {
  const wrap = document.getElementById('forecast-cards');
  if (!wrap) return;

  const current = Math.round(history[history.length - 1].value);
  const fc      = result.points;
  const peak    = fc.reduce((a, p) => (p.value > a.value ? p : a), fc[0]);
  const end     = fc[fc.length - 1];
  const avg     = Math.round(fc.reduce((s, p) => s + p.value, 0) / fc.length);
  const delta   = end.value - current;
  const acc     = result.accuracy;

  const peakCat = getAQICategory(peak.value);
  const peakWhen = formatTimestamp(peak.timestamp, peak.timestamp - Date.now() > 86_400_000 ? 'MMM DD' : 'Day HH');

  const cards = [
    { label: 'Current AQI',  value: current,      cls: aqiValueClass(current),
      sub: getAQICategory(current).label },
    { label: `Peak (next ${result.horizon}h)`, value: peak.value, cls: aqiValueClass(peak.value),
      sub: `${peakCat.label} · ${peakWhen}` },
    { label: 'Avg Forecast', value: avg,          cls: aqiValueClass(avg),
      sub: getAQICategory(avg).label },
    { label: `In ${result.horizon}h`, value: end.value, cls: aqiValueClass(end.value),
      sub: `${delta >= 0 ? '▲ +' : '▼ '}${delta} vs now` },
    { label: 'Confidence ±', value: `±${Math.round(end.upper - end.value)}`, cls: '',
      sub: `90% band at +${result.horizon}h` },
    { label: 'Model Error',  value: acc ? acc.mae : '—', cls: '',
      sub: acc ? `MAE · ${acc.mape != null ? acc.mape + '% MAPE' : 'backtest'}` : 'n/a' },
  ];

  wrap.innerHTML = cards.map(c => `
    <div class="kpi-card">
      <div class="kpi-card-label">${c.label}</div>
      <div class="kpi-card-value ${c.cls}">${c.value}</div>
      <div class="kpi-card-sub">${c.sub}</div>
    </div>`).join('');
}

function renderForecastChart(history, result) {
  destroyChart('forecast');
  const ctx = document.getElementById('chart-forecast')?.getContext('2d');
  if (!ctx) return;

  const hist = history.slice(-FORECAST_CHART_LOOKBACK);
  const fc   = result.points;
  const H    = fc.length;
  const gap  = hist.length - 1;   // index of last actual point (forecast joins here)

  const fmt = (result.points[result.points.length - 1].timestamp - Date.now() > 86_400_000)
    ? 'MMM DD' : 'Day HH';
  const labels = [...hist.map(d => formatTimestamp(d.timestamp, 'Day HH')),
                  ...fc.map(p => formatTimestamp(p.timestamp, fmt))];

  const pad = (arr, lead) => [...Array(lead).fill(null), ...arr];
  const lastActual = hist[hist.length - 1].value;

  const historyData  = [...hist.map(d => d.value), ...Array(H).fill(null)];
  const forecastData = pad([lastActual, ...fc.map(p => p.value)], gap);
  const upperData    = pad([lastActual, ...fc.map(p => p.upper)], gap);
  const lowerData    = pad([lastActual, ...fc.map(p => p.lower)], gap);

  state.charts.forecast = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'History', data: historyData,
          borderColor: '#8b9dc3', backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0, tension: 0.3 },
        { label: 'Forecast', data: forecastData,
          borderColor: '#38bdf8', backgroundColor: 'transparent',
          borderWidth: 2.5, borderDash: [6, 4], pointRadius: 0, tension: 0.3 },
        { label: 'Upper 90%', data: upperData,
          borderColor: 'rgba(56,189,248,0.25)', backgroundColor: 'rgba(56,189,248,0.12)',
          borderWidth: 1, pointRadius: 0, tension: 0.3, fill: '+1' },
        { label: 'Lower 90%', data: lowerData,
          borderColor: 'rgba(56,189,248,0.25)', backgroundColor: 'transparent',
          borderWidth: 1, pointRadius: 0, tension: 0.3, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom',
          labels: { boxWidth: 12, padding: 10, usePointStyle: true,
            filter: it => !it.text.includes('90%') } },
      },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 12, maxRotation: 0 } },
        y: { grid: { color: gridColor() }, min: 0, title: { display: true, text: 'AQI' } },
      },
    },
  });
}

function renderForecastTable(result) {
  const tbody = document.getElementById('forecast-tbody');
  if (!tbody) return;
  const now = Date.now();
  tbody.innerHTML = result.points.map(p => {
    const cat = getAQICategory(p.value);
    const fmt = p.timestamp - now > 86_400_000 ? 'MMM DD' : 'Day HH';
    return `<tr>
      <td>${formatTimestamp(p.timestamp, fmt)}</td>
      <td style="font-weight:700;color:${cat.color}">${p.value}</td>
      <td style="color:var(--text-muted)">${p.lower}–${p.upper}</td>
      <td><span class="forecast-badge" style="background:${cat.bg};color:${cat.color}">${cat.short}</span></td>
    </tr>`;
  }).join('');
}

function renderForecastAccuracyChart(history) {
  destroyChart('forecastAccuracy');
  const ctx = document.getElementById('chart-forecast-accuracy')?.getContext('2d');
  if (!ctx) return;

  const models = Object.keys(Forecaster.MODELS);
  const rows = models.map(m => {
    try {
      const r = Forecaster.run(history, { method: m, horizon: state.forecast.horizon });
      return { id: m, label: Forecaster.MODELS[m].label, mae: r.accuracy ? r.accuracy.mae : null };
    } catch { return { id: m, label: Forecaster.MODELS[m].label, mae: null }; }
  });

  const best = rows.filter(r => r.mae != null).sort((a, b) => a.mae - b.mae)[0];

  state.charts.forecastAccuracy = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.label),
      datasets: [{
        label: 'Backtest MAE',
        data: rows.map(r => r.mae),
        backgroundColor: rows.map(r =>
          r.id === state.forecast.model ? '#38bdf8'
          : (best && r.id === best.id ? 'rgba(34,197,94,0.6)' : 'rgba(139,157,195,0.4)')),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => `MAE: ${c.parsed.x} AQI` } } },
      scales: {
        x: { grid: { color: gridColor() }, title: { display: true, text: 'Mean Abs. Error (lower = better)' } },
        y: { grid: { display: false } },
      },
    },
  });

  const note = document.getElementById('forecast-accuracy-note');
  if (note) {
    note.innerHTML = best
      ? `Lowest error: <strong>${best.label}</strong> (MAE ${best.mae} AQI). ` +
        `Errors come from a hold-out backtest — the last ${Math.min(state.forecast.horizon, Forecaster.PERIOD)} h are hidden, predicted, then compared to actuals.`
      : 'Not enough history to backtest.';
  }
}

// ═══════════════════════════════════════════════════════════
// VIEW: COMPARISON
// ═══════════════════════════════════════════════════════════
function renderComparison() {
  buildCityCards();
  renderComparisonBarChart();
  buildRankingTable();
}

function buildCityCards() {
  const grid = document.getElementById('city-cards-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const sorted = Object.entries(state.regional).sort((a, b) => b[1].aqi - a[1].aqi);
  sorted.forEach(([id, city]) => {
    const cat   = city.category;
    const trend = city.trend >= 0 ? `▲ ${city.trend}` : `▼ ${Math.abs(city.trend)}`;
    const trendColor = city.trend >= 0 ? '#ef4444' : '#22c55e';

    const card = document.createElement('div');
    card.className = `city-card${id === state.city ? ' selected' : ''}`;
    card.innerHTML = `
      <div class="city-card-glow" style="background:${cat.color}"></div>
      <div class="city-card-name">${city.name}</div>
      <div class="city-card-state">${city.state}</div>
      <div class="city-card-aqi" style="color:${cat.color}">${city.aqi}</div>
      <div class="city-card-badge" style="background:${cat.bg};color:${cat.color}">${cat.short}</div>
      ${cat.min >= 301 ? `<div class="city-card-alert" title="Hazardous AQI">☠️</div>` : ''}
      <div class="city-card-trend" style="color:${trendColor}">${trend} from last hour</div>
    `;
    card.addEventListener('click', () => {
      state.city = id;
      document.getElementById('city-select').value = id;
      refreshData(true);
      renderComparison();
    });
    grid.appendChild(card);
  });
}

function renderComparisonBarChart() {
  destroyChart('compBar');
  const ctx = document.getElementById('chart-comparison-bar')?.getContext('2d');
  if (!ctx) return;

  const sorted = Object.values(state.regional).sort((a, b) => b.aqi - a.aqi);
  const labels = sorted.map(c => c.name);
  const aqis   = sorted.map(c => c.aqi);

  state.charts.compBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'AQI',
        data: aqis,
        backgroundColor: aqis.map(a => aqiToColor(a) + 'cc'),
        borderColor: aqis.map(a => aqiToColor(a)),
        borderWidth: 1.5,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: ctx => `Category: ${getAQICategory(ctx.raw).label}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: gridColor() }, min: 0 },
      },
    },
  });
}

function buildRankingTable() {
  const tbody = document.getElementById('ranking-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const sorted = Object.values(state.regional).sort((a, b) => b.aqi - a.aqi);
  sorted.forEach((city, idx) => {
    const rank = idx + 1;
    const cat  = city.category;
    const rankCls = rank <= 3 ? ` rank-${rank}` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rank-badge${rankCls}">${rank}</span></td>
      <td>${city.name}</td>
      <td style="font-weight:700;color:${cat.color}">${city.aqi}</td>
      <td><span class="status-badge" style="background:${cat.bg};color:${cat.color}">${cat.short}</span></td>
      <td>${city.pm25}</td>
      <td>${city.pm10}</td>
      <td>${city.no2}</td>
      <td>${city.so2}</td>
      <td style="color:${cat.color};font-weight:600">${cat.short}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ═══════════════════════════════════════════════════════════
// VIEW: HEATMAP
// ═══════════════════════════════════════════════════════════
const DAY_LABELS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2,'0')}:00`);

function renderHeatmap() {
  const matrix = generateHeatmapMatrix(state.city);
  buildHeatmapGrid(matrix);
  buildBestTimeGrid(matrix);
}

function aqiToHeatColor(aqi) {
  // Interpolate a colour from green→yellow→orange→red→purple based on AQI
  const stops = [
    { t: 0,   c: [34,  197, 94]  },  // green   0
    { t: 50,  c: [234, 179, 8]   },  // yellow  50
    { t: 100, c: [249, 115, 22]  },  // orange  100
    { t: 150, c: [239, 68,  68]  },  // red     150
    { t: 200, c: [168, 85,  247] },  // purple  200
    { t: 300, c: [220, 38,  38]  },  // maroon  300+
  ];
  const clamped = Math.min(300, Math.max(0, aqi));
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped >= stops[i].t && clamped <= stops[i + 1].t) {
      lo = stops[i]; hi = stops[i + 1]; break;
    }
  }
  const t = lo.t === hi.t ? 0 : (clamped - lo.t) / (hi.t - lo.t);
  const r = Math.round(lo.c[0] + t * (hi.c[0] - lo.c[0]));
  const g = Math.round(lo.c[1] + t * (hi.c[1] - lo.c[1]));
  const b = Math.round(lo.c[2] + t * (hi.c[2] - lo.c[2]));
  return `rgba(${r},${g},${b},0.80)`;
}

function buildHeatmapGrid(matrix) {
  const container = document.getElementById('heatmap-container');
  if (!container) return;

  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';

  // Top-left empty corner
  const corner = document.createElement('div');
  grid.appendChild(corner);

  // Hour labels (columns)
  HOUR_LABELS.forEach((h, i) => {
    const lbl = document.createElement('div');
    lbl.className = 'heatmap-hour-label';
    lbl.textContent = i % 3 === 0 ? h.slice(0, 2) : '';
    grid.appendChild(lbl);
  });

  // Rows: one per day
  matrix.forEach((row, dayIdx) => {
    const dayLbl = document.createElement('div');
    dayLbl.className = 'heatmap-day-label';
    dayLbl.textContent = DAY_LABELS[dayIdx];
    grid.appendChild(dayLbl);

    row.forEach((aqi, hour) => {
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.style.background = aqiToHeatColor(aqi);
      cell.dataset.tip = `${DAY_LABELS[dayIdx]} ${HOUR_LABELS[hour]} — AQI ${aqi} (${getAQICategory(aqi).short})`;
      grid.appendChild(cell);
    });
  });

  container.innerHTML = '';
  container.appendChild(grid);
}

function buildBestTimeGrid(matrix) {
  const gridEl = document.getElementById('best-time-grid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  DAY_LABELS.forEach((day, dIdx) => {
    const row   = matrix[dIdx];
    const minAqi= Math.min(...row);
    const minH  = row.indexOf(minAqi);
    const cat   = getAQICategory(minAqi);

    const item = document.createElement('div');
    item.className = 'best-time-item';
    item.innerHTML = `
      <div class="best-time-day">${day}</div>
      <div class="best-time-hour" style="color:${cat.color}">${HOUR_LABELS[minH].slice(0,5)}</div>
      <div class="best-time-aqi">AQI ${minAqi} · ${cat.short}</div>
    `;
    gridEl.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════════
// VIEW: HEALTH ADVISORY
// ═══════════════════════════════════════════════════════════
function renderHealth() {
  const latest = state.data[state.data.length - 1];
  if (!latest) return;

  const cat   = getAQICategory(latest.aqi);
  const lvl   = AQI_CATEGORIES.indexOf(cat);

  // Header card
  const headerCard = document.getElementById('health-alert-card');
  if (headerCard) {
    headerCard.style.borderColor = cat.color;
    headerCard.style.background  = cat.bg;
  }
  const iconEl = document.getElementById('health-icon');
  const catEl  = document.getElementById('health-category');
  const advEl  = document.getElementById('health-advice');
  if (iconEl) iconEl.textContent = cat.icon;
  if (catEl)  { catEl.textContent = `${cat.label} — AQI ${latest.aqi}`; catEl.style.color = cat.color; }
  if (advEl)  advEl.textContent = cat.advice;

  // Group advice
  const groups = ['children', 'elderly', 'heart', 'lung', 'athletes', 'general'];
  const adviceMap = { children: HEALTH_ADVICE.children, elderly: HEALTH_ADVICE.elderly,
                      heart: HEALTH_ADVICE.heart, lung: HEALTH_ADVICE.lung,
                      athletes: HEALTH_ADVICE.athletes, general: HEALTH_ADVICE.general };
  groups.forEach(g => {
    const el = document.getElementById(`hg-${g}`);
    if (el) el.textContent = adviceMap[g][Math.min(lvl, adviceMap[g].length - 1)];
  });

  // WHO chart
  renderWHOChart(latest);

  // Protective measures
  buildMeasuresGrid(lvl);
}

function renderWHOChart(latest) {
  destroyChart('who');
  const ctx = document.getElementById('chart-who')?.getContext('2d');
  if (!ctx) return;

  const pols   = POLLUTANTS.filter(p => p.id !== 'co');
  const labels = pols.map(p => p.name);
  const actual = pols.map(p => latest[p.id]);
  const limits = pols.map(p => p.who);

  state.charts.who = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Current Level',
          data: actual,
          backgroundColor: pols.map(p => p.color + 'bb'),
          borderColor: pols.map(p => p.color),
          borderWidth: 1.5,
          borderRadius: 5,
        },
        {
          label: 'WHO Annual Guideline',
          data: limits,
          backgroundColor: 'rgba(255,255,255,0.07)',
          borderColor: 'rgba(255,255,255,0.3)',
          borderWidth: 2,
          borderRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: gridColor() } },
      },
    },
  });
}

function buildMeasuresGrid(level) {
  const grid = document.getElementById('measures-grid');
  if (!grid) return;
  grid.innerHTML = '';

  PROTECTIVE_MEASURES.forEach(m => {
    const active = m.levels.includes(level);
    const div    = document.createElement('div');
    div.className = `measure-item${active ? ' active' : ''}`;
    div.innerHTML = `
      <div class="measure-icon">${m.icon}</div>
      <div>
        <div class="measure-title">${m.title}</div>
        <div class="measure-desc">${m.desc}</div>
      </div>
    `;
    grid.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════
// VIEW: ABOUT AQI (static, built once)
// ═══════════════════════════════════════════════════════════
function buildAboutContent() {
  // AQI scale
  const scaleEl = document.getElementById('aqi-scale-content');
  if (scaleEl && !scaleEl.dataset.built) {
    scaleEl.dataset.built = '1';
    AQI_CATEGORIES.forEach(cat => {
      const row = document.createElement('div');
      row.className = 'aqi-scale-row';
      row.style.background   = cat.bg;
      row.style.borderColor  = cat.color;
      row.innerHTML = `
        <div class="aqi-range" style="color:${cat.color}">${cat.min}–${cat.max}</div>
        <div class="aqi-label-text" style="color:${cat.color}">${cat.icon} ${cat.short}</div>
        <div class="aqi-desc">${cat.advice}</div>
      `;
      scaleEl.appendChild(row);
    });
  }

  // Pollutants info
  const pollEl = document.getElementById('pollutants-info');
  if (pollEl && !pollEl.dataset.built) {
    pollEl.dataset.built = '1';
    POLLUTANTS.forEach(p => {
      const item = document.createElement('div');
      item.className = 'pollutant-info-item';
      item.innerHTML = `
        <div class="pollutant-info-header">
          <div class="pollutant-dot" style="background:${p.color}"></div>
          <span class="pollutant-info-name">${p.name}</span>
          <span class="pollutant-who">WHO: ${p.who} ${p.unit}</span>
        </div>
        <div class="pollutant-info-desc">${p.desc}</div>
      `;
      pollEl.appendChild(item);
    });
  }
}

// ═══════════════════════════════════════════════════════════
// EXPORT CSV
// ═══════════════════════════════════════════════════════════
function exportCSV() {
  const cfg  = getRangeConfig(state.timeRange);
  const rows = [['Timestamp','AQI','PM2.5','PM10','NO2','O3','CO','SO2','Category']];

  state.data.forEach(d => {
    const cat = getAQICategory(d.aqi);
    rows.push([
      new Date(d.timestamp).toISOString(),
      d.aqi, d.pm25, d.pm10, d.no2, d.o3, d.co, d.so2, cat.label,
    ]);
  });

  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `airwatch-${state.city}-${state.timeRange}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported successfully');
}

// ═══════════════════════════════════════════════════════════
// VIEW: DATA PIPELINE
// ═══════════════════════════════════════════════════════════

// Pipeline session state
const pipeState = {
  dirtyData:  null,
  cleanData:  null,
  report:     null,
  pipeline:   null,
  hasDirty:   false,
};

function renderPipeline() {
  // Only bind events once
  if (!document.getElementById('btn-run-pipeline')._bound) {
    document.getElementById('btn-run-pipeline')._bound = true;
    document.getElementById('btn-inject-dirty').addEventListener('click', injectDirtyData);
    document.getElementById('btn-run-pipeline').addEventListener('click', executePipeline);
    document.getElementById('btn-apply-clean').addEventListener('click', applyCleanData);
    document.getElementById('btn-reset-pipeline').addEventListener('click', resetPipeline);
  }
}

function injectDirtyData() {
  if (!window.Cleaner) return showToast('Cleaner module not loaded', 3000);
  const source = state.data.length > 0 ? state.data : generateHistoricalData(state.city, 24, 3_600_000);
  const { dirty, injectionLog } = Cleaner.injectIssues(source);
  pipeState.dirtyData = dirty;
  pipeState.hasDirty  = true;
  pipeState.cleanData = null;
  pipeState.report    = null;

  const counts = {};
  injectionLog.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
  const summary = Object.entries(counts).map(([k,v]) => `${v} ${k.replace(/_/g,' ')}`).join(', ');
  showToast(`Injected: ${summary}`, 4000);
  setAllStepStatus('idle');
  document.getElementById('pipeline-results').classList.add('hidden');
  document.getElementById('btn-apply-clean').disabled = true;
  document.getElementById('btn-run-pipeline').textContent = '▶ Run Pipeline';
}

async function executePipeline() {
  if (!window.DataPipeline) return showToast('Pipeline module not loaded', 3000);
  const rawData = pipeState.dirtyData || state.data;

  // Read config from UI
  const cfg = {
    city:            state.city,
    missingStrategy: document.getElementById('cfg-missing-strategy')?.value || 'interpolate',
    outlierMethod:   document.getElementById('cfg-outlier-method')?.value   || 'ensemble',
    outlierTreatment:document.getElementById('cfg-outlier-treatment')?.value || 'clip',
    unitConfidence:  parseFloat(document.getElementById('cfg-unit-confidence')?.value || '0.75'),
  };

  // Animate steps
  const steps = ['sentinels','units','ranges','outliers','missing','consistency'];
  for (const step of steps) {
    setStepStatus(step, 'running');
    await new Promise(r => setTimeout(r, 60));
  }

  // Run synchronously (fast)
  const p = new DataPipeline(rawData, cfg);
  p.run();
  const report = p.generateReport();

  pipeState.pipeline  = p;
  pipeState.cleanData = p.getCleanData();
  pipeState.report    = report;

  // Mark all done
  steps.forEach(s => setStepStatus(s, 'done'));
  document.getElementById('pipeline-results').classList.remove('hidden');
  document.getElementById('btn-apply-clean').disabled = false;
  document.getElementById('btn-run-pipeline').textContent = '▶ Re-run Pipeline';

  // Render results
  renderQualityCards(report);
  renderPipelineComparisonChart(rawData, p.getCleanData(), p.audit);
  renderIssuesDonut(report);
  renderChangesByParam(report);
  renderMissingHeatmaps(rawData, p.getCleanData(), p.audit);
  renderAuditLog(report);
  showToast(`Pipeline complete — quality ${report.qualityBefore?.overall}% → ${report.qualityAfter?.overall}%`, 4000);
}

function applyCleanData() {
  if (!pipeState.cleanData) return;
  state.data = pipeState.cleanData;
  renderOverview();
  showToast('Clean data applied to dashboard', 3000);
}

function resetPipeline() {
  pipeState.dirtyData = null;
  pipeState.cleanData = null;
  pipeState.report    = null;
  pipeState.hasDirty  = false;
  setAllStepStatus('idle');
  document.getElementById('pipeline-results').classList.add('hidden');
  document.getElementById('btn-apply-clean').disabled = true;
  document.getElementById('btn-run-pipeline').textContent = '▶ Run Pipeline';
  showToast('Pipeline reset', 2000);
}

function setStepStatus(step, status) {
  const el = document.querySelector(`#pstep-${step} .pipe-step-status`);
  const card = document.getElementById(`pstep-${step}`);
  if (!el || !card) return;
  el.className = `pipe-step-status ${status}`;
  el.textContent = { idle:'Pending', running:'Running…', done:'✓ Done', error:'✕ Error' }[status] || status;
  card.className = `pipe-step ${status === 'idle' ? '' : status}`;
}
function setAllStepStatus(s) { ['sentinels','units','ranges','outliers','missing','consistency'].forEach(n => setStepStatus(n, s)); }

// ── Quality score cards ───────────────────────────────────
function renderQualityCards(report) {
  const grid = document.getElementById('quality-score-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const metrics = [
    { label:'Overall Quality',  before: report.qualityBefore?.overall,    after: report.qualityAfter?.overall,    unit:'%' },
    { label:'Completeness',     before: report.qualityBefore?.completeness,after: report.qualityAfter?.completeness,unit:'%' },
    { label:'Validity',         before: report.qualityBefore?.validityPct, after: report.qualityAfter?.validityPct, unit:'%' },
    { label:'Consistency',      before: report.qualityBefore?.consPct,     after: report.qualityAfter?.consPct,     unit:'%' },
    { label:'Total Changes',    before: '--',                               after: report.totalChanges,              unit:'' },
    { label:'Pipeline Time',    before: '--',                               after: Object.values(report.timing||{}).reduce((a,b)=>a+b,0).toFixed(0), unit:'ms' },
  ];

  metrics.forEach(m => {
    const gain = (typeof m.before === 'number' && typeof m.after === 'number')
      ? +(m.after - m.before).toFixed(1) : null;
    const card = document.createElement('div');
    card.className = 'quality-score-card';
    card.innerHTML = `
      <div class="qs-label">${m.label}</div>
      <div style="display:flex;align-items:center;justify-content:center">
        <span class="qs-before">${typeof m.before === 'number' ? m.before + m.unit : m.before}</span>
        <span class="qs-arrow">→</span>
        <span class="qs-after">${typeof m.after === 'number' ? m.after + m.unit : m.after}</span>
      </div>
      ${gain !== null ? `<div class="qs-gain${gain < 0 ? ' negative' : ''}">
        ${gain >= 0 ? '+' : ''}${gain}${m.unit} improvement</div>` : ''}
    `;
    grid.appendChild(card);
  });
}

// ── Before/after PM2.5 chart ──────────────────────────────
function renderPipelineComparisonChart(raw, clean, auditLog) {
  destroyChart('pipeComp');
  const ctx = document.getElementById('chart-pipeline-comparison')?.getContext('2d');
  if (!ctx) return;

  const cfg    = getRangeConfig(state.timeRange);
  const labels = raw.map(d => formatTimestamp(d.timestamp, cfg.fmt));

  const rawPM25   = raw.map(d => d.pm25);
  const cleanPM25 = clean.map(d => d.pm25);

  // Build point colour arrays
  const imputedSet  = new Set(auditLog.filter(e => e.type === 'imputed' && e.param === 'pm25').map(e => e.index));
  const outlierSet  = new Set(auditLog.filter(e => ['clip','interpolate','rolling_median'].includes(e.type) && e.param === 'pm25').map(e => e.index));

  const pointColors = cleanPM25.map((_, i) =>
    imputedSet.has(i) ? '#eab308' : outlierSet.has(i) ? '#ef4444' : '#22c55e'
  );
  const pointRadii  = cleanPM25.map((_, i) =>
    (imputedSet.has(i) || outlierSet.has(i)) ? 5 : 0
  );

  state.charts.pipeComp = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Original',
          data: rawPM25,
          borderColor: '#3b82f6',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          borderDash: [4, 3],
        },
        {
          label: 'Cleaned',
          data: cleanPM25,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.08)',
          borderWidth: 2,
          pointRadius: pointRadii,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10 } },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const i = items[0]?.dataIndex;
              if (i == null) return;
              const tags = [];
              if (imputedSet.has(i)) tags.push('⚡ Imputed (was missing)');
              if (outlierSet.has(i)) tags.push('📊 Outlier treated');
              return tags;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
        y: { grid: { color: gridColor() }, min: 0, title: { display: true, text: 'PM2.5 (μg/m³)', color: 'var(--text-secondary)', font: { size: 11 } } },
      },
    },
  });
}

// ── Issues donut ──────────────────────────────────────────
function renderIssuesDonut(report) {
  destroyChart('issueDonut');
  const ctx = document.getElementById('chart-issues-donut')?.getContext('2d');
  if (!ctx) return;

  const byType = report.byType || {};
  const labels = Object.keys(byType).filter(k => k !== 'summary');
  const values = labels.map(k => byType[k]);
  const colors = {
    'imputed':           '#eab308',
    'clip':              '#3b82f6',
    'interpolate':       '#22c55e',
    'rolling_median':    '#22c55e',
    'unit_conversion':   '#a855f7',
    'hard_outlier→null': '#ef4444',
    'soft_outlier_flagged':'#f97316',
    'pm10_corrected':    '#f97316',
    'aqi_recalculated':  '#3b82f6',
    'sentinel→null':     '#94a3b8',
  };

  const total = values.reduce((a, b) => a + b, 0);
  const el    = document.getElementById('issues-total-label');
  if (el) el.textContent = `${total} total changes`;

  state.charts.issueDonut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels.map(l => l.replace(/[-_]/g,' ')),
      datasets: [{
        data: values,
        backgroundColor: labels.map(l => colors[l] || '#8b9dc3'),
        borderWidth: 2,
        borderColor: 'var(--bg-card)',
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 11, padding: 8, font: { size: 11 } } },
      },
    },
  });
}

// ── Changes by parameter bar ──────────────────────────────
function renderChangesByParam(report) {
  destroyChart('changeParam');
  const ctx = document.getElementById('chart-changes-param')?.getContext('2d');
  if (!ctx) return;

  const byParam = report.changesByParam || {};
  const params  = Object.keys(byParam).filter(p => byParam[p] > 0);
  const vals    = params.map(p => byParam[p]);
  const colors  = { pm25:'#ef4444', pm10:'#f97316', no2:'#eab308', o3:'#22c55e', co:'#3b82f6', so2:'#a855f7', aqi:'#60a5fa', temperature:'#fb923c', humidity:'#34d399' };

  state.charts.changeParam = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: params.map(p => POLLUTANTS.find(x => x.id === p)?.name || p.toUpperCase()),
      datasets: [{
        label: 'Changes',
        data: vals,
        backgroundColor: params.map(p => (colors[p] || '#8b9dc3') + 'cc'),
        borderColor:      params.map(p => colors[p] || '#8b9dc3'),
        borderWidth: 1.5,
        borderRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: gridColor() }, min: 0, ticks: { stepSize: 1 } },
      },
    },
  });
}

// ── Missing value heatmaps (before + after) ───────────────
function renderMissingHeatmaps(raw, clean, auditLog) {
  const container = document.getElementById('missing-heatmap-container');
  if (!container) return;
  container.innerHTML = '';

  const params = ['pm25','pm10','no2','so2','o3','co'];
  const imputedMap = {};
  const outlierMap = {};
  auditLog.forEach(e => {
    if (e.type === 'imputed')         { imputedMap[`${e.param}-${e.index}`] = true; }
    if (['clip','interpolate','rolling_median'].includes(e.type)) { outlierMap[`${e.param}-${e.index}`] = true; }
  });

  ['Before', 'After'].forEach((label, pass) => {
    const dataset = pass === 0 ? raw : clean;
    const panel   = document.createElement('div');
    panel.className = 'missing-heatmap-panel';
    panel.innerHTML = `<h4>${label} Pipeline (${dataset.length} rows × ${params.length} params)</h4>`;

    params.forEach(p => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      const lbl = document.createElement('div');
      lbl.className = 'missing-param-label';
      lbl.textContent = (POLLUTANTS.find(x => x.id === p)?.name || p).toUpperCase();
      row.appendChild(lbl);

      const grid = document.createElement('div');
      grid.className = 'missing-heatmap-grid';
      grid.style.gridTemplateColumns = `repeat(${Math.min(dataset.length, 120)}, 1fr)`;

      // Sample to max 120 columns
      const stride = Math.max(1, Math.floor(dataset.length / 120));
      dataset.filter((_, i) => i % stride === 0).forEach((d, idx) => {
        const realIdx = idx * stride;
        const cell = document.createElement('div');
        cell.className = 'missing-cell';
        const v = d[p];
        const missing = v == null || isNaN(v);
        if (pass === 1 && imputedMap[`${p}-${realIdx}`]) cell.classList.add('imputed');
        else if (pass === 1 && outlierMap[`${p}-${realIdx}`]) cell.classList.add('outlier');
        else if (missing) cell.classList.add('missing');
        else cell.classList.add('present');
        grid.appendChild(cell);
      });
      row.appendChild(grid);
      panel.appendChild(row);
    });
    container.appendChild(panel);
  });

  // Legend
  const legend = document.createElement('div');
  legend.style.cssText = 'margin-top:10px;display:flex;gap:16px;font-size:0.68rem;color:var(--text-secondary)';
  legend.innerHTML = `
    <span><span style="display:inline-block;width:12px;height:12px;background:var(--aqi-good);border-radius:2px;opacity:0.7;margin-right:4px"></span>Present</span>
    <span><span style="display:inline-block;width:12px;height:12px;background:var(--aqi-unhealthy);border-radius:2px;opacity:0.8;margin-right:4px"></span>Missing</span>
    <span><span style="display:inline-block;width:12px;height:12px;background:var(--aqi-moderate);border-radius:2px;opacity:0.9;margin-right:4px"></span>Imputed</span>
    <span><span style="display:inline-block;width:12px;height:12px;background:var(--aqi-very);border-radius:2px;opacity:0.8;margin-right:4px"></span>Outlier fixed</span>
  `;
  container.appendChild(legend);
}

// ── Audit log table ───────────────────────────────────────
function renderAuditLog(report) {
  const tbody = document.getElementById('audit-log-body');
  const countEl = document.getElementById('audit-count-label');
  if (!tbody) return;
  tbody.innerHTML = '';

  const entries = (report.auditLog || []).filter(e => e.type !== 'summary');
  if (countEl) countEl.textContent = `${entries.length} entries (${report.summaries?.length || 0} step summaries)`;

  // Show max 500 rows in table (performance)
  entries.slice(0, 500).forEach((e, idx) => {
    const tr = document.createElement('tr');
    const fmtVal = v => (v == null ? '<em style="color:var(--text-muted)">null</em>' :
                         typeof v === 'number' ? v.toFixed(3) : v);
    const detail = e.fromUnit  ? `${e.fromUnit} → ${e.toUnit || 'std'}` :
                   e.strategy  ? e.strategy :
                   e.method    ? e.method :
                   e.rule      ? e.rule : '';

    tr.innerHTML = `
      <td style="color:var(--text-muted)">${idx + 1}</td>
      <td style="font-weight:600">${e.step || '—'}</td>
      <td class="audit-type-${e.type}" style="font-weight:600;white-space:nowrap">${e.type}</td>
      <td>${e.param ? (POLLUTANTS.find(x=>x.id===e.param)?.name || e.param.toUpperCase()) : '—'}</td>
      <td>${e.index != null ? e.index : '—'}</td>
      <td>${fmtVal(e.before)}</td>
      <td>${fmtVal(e.after)}</td>
      <td style="font-size:0.68rem;color:var(--text-muted)">${detail}</td>
    `;
    tbody.appendChild(tr);
  });

  if (entries.length > 500) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="8" style="text-align:center;color:var(--text-muted);padding:12px">… ${entries.length - 500} more entries (export CSV for full log)</td>`;
    tbody.appendChild(tr);
  }
}

// ═══════════════════════════════════════════════════════════
// VIEW: KPI DASHBOARD
// ═══════════════════════════════════════════════════════════

const kpiState = {
  period:  30,
  source:  'browser',   // 'browser' | 'api'
  charts:  {},
  kpis:    null,
};

// ── AQI helpers ──────────────────────────────────────────────────────────────
const AQI_CATS = [
  { lo:  0, hi:  50, label:'Good',                    color:'#22c55e', short:'Good'   },
  { lo: 51, hi: 100, label:'Moderate',                color:'#eab308', short:'Mod'    },
  { lo:101, hi: 150, label:'Unhealthy for Sensitive',  color:'#f97316', short:'USG'    },
  { lo:151, hi: 200, label:'Unhealthy',                color:'#ef4444', short:'UNH'    },
  { lo:201, hi: 300, label:'Very Unhealthy',           color:'#8b5cf6', short:'V.UNH'  },
  { lo:301, hi: 999, label:'Hazardous',                color:'#991b1b', short:'HAZ'    },
];
const WHO_LIMITS  = { pm25:15, pm10:45, no2:25, so2:40, o3:100, co:4 };
const NAAQS_LIMITS= { pm25:60, pm10:100, no2:80, so2:80, o3:180, co:10 };
const PARAM_LABELS= { pm25:'PM2.5', pm10:'PM10', no2:'NO₂', so2:'SO₂', o3:'O₃', co:'CO' };
const PARAM_UNITS = { pm25:'μg/m³', pm10:'μg/m³', no2:'μg/m³', so2:'μg/m³', o3:'μg/m³', co:'mg/m³' };

function _aqiCat(v) {
  if (v == null) return AQI_CATS[0];
  return AQI_CATS.find(c => v >= c.lo && v <= c.hi) || AQI_CATS[AQI_CATS.length-1];
}
function _aqiColor(v) { return _aqiCat(v).color; }
function _aqiLabel(v) { return _aqiCat(v).label; }

// ── Math helpers ──────────────────────────────────────────────────────────────
function _mean(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;
}
function _linregSlope(vals) {
  const n = vals.length;
  if (n < 2) return 0;
  const mx = (n-1)/2, my = _mean(vals) || 0;
  let numer=0, denom=0;
  vals.forEach((y,x) => { if (y!=null){numer+=(x-mx)*(y-my); denom+=(x-mx)**2;} });
  return denom ? numer/denom : 0;
}
function _pctChange(cur, prev) {
  if (!prev || !cur) return null;
  return +((cur-prev)/prev*100).toFixed(1);
}
function _rollingMean(arr, w) {
  return arr.map((_,i) => {
    const slice = arr.slice(Math.max(0,i-w+1), i+1).filter(x=>x!=null);
    return slice.length ? _mean(slice) : null;
  });
}
function _pli(means) {
  const ratios = Object.entries(WHO_LIMITS)
    .filter(([p,w]) => means[p]!=null && w)
    .map(([p,w]) => means[p]/w)
    .filter(r => r > 0);
  if (!ratios.length) return null;
  return +(Math.exp(ratios.reduce((s,r)=>s+Math.log(r),0)/ratios.length)).toFixed(3);
}
function _pliCat(pli) {
  if (pli == null) return {label:'Unknown', color:'var(--text-muted)'};
  if (pli <= 0.5)  return {label:'Excellent', color:'#22c55e'};
  if (pli <= 1.0)  return {label:'Good',      color:'#86efac'};
  if (pli <= 2.0)  return {label:'Moderate',  color:'#eab308'};
  if (pli <= 5.0)  return {label:'Unhealthy', color:'#ef4444'};
  return             {label:'Hazardous',  color:'#991b1b'};
}

// ── KPI computation from state.data ───────────────────────────────────────────
function computeKPIs(data, days) {
  const now    = Date.now();
  const cutoff = now - days * 86_400_000;
  const prevCutoff = cutoff - days * 86_400_000;

  const cur  = data.filter(d => d.timestamp >= cutoff && d.timestamp <= now);
  const prev = data.filter(d => d.timestamp >= prevCutoff && d.timestamp < cutoff);

  if (!cur.length) return null;

  // ── Group by ISO date ────────────────────────────────────────────────────
  const byDay = {};
  cur.forEach(d => {
    const key = new Date(d.timestamp).toISOString().slice(0,10);
    (byDay[key] = byDay[key] || []).push(d);
  });

  // ── Daily AQI means (for trend) ──────────────────────────────────────────
  const dayKeys  = Object.keys(byDay).sort();
  const dayMeans = dayKeys.map(k => _mean(byDay[k].map(d=>d.aqi)));

  // ── Average AQI ──────────────────────────────────────────────────────────
  const avgAQI     = _mean(cur.map(d=>d.aqi));
  const prevAvgAQI = _mean(prev.map(d=>d.aqi));

  // ── Peak AQI ─────────────────────────────────────────────────────────────
  let peakRow = cur.reduce((a,b)=>(b.aqi||0)>(a.aqi||0)?b:a, cur[0]);
  const peakAQI  = peakRow?.aqi;
  const peakHour = peakRow ? new Date(peakRow.timestamp).getHours() : null;
  const peakDate = peakRow ? new Date(peakRow.timestamp).toISOString().slice(0,10) : null;

  // ── Day classification ────────────────────────────────────────────────────
  const classCounts = {Good:0, Moderate:0, 'Unhealthy for Sensitive':0, Unhealthy:0, 'Very Unhealthy':0, Hazardous:0};
  const byDayList = dayKeys.map(date => {
    const mean = _mean(byDay[date].map(d=>d.aqi));
    const cat  = _aqiLabel(mean ? Math.round(mean) : null);
    if (cat in classCounts) classCounts[cat]++;
    return { date, mean_aqi: mean ? +mean.toFixed(1) : null, category: cat };
  });
  const totalDays = dayKeys.length;
  const safeDays  = (classCounts.Good||0) + (classCounts.Moderate||0);
  const hazDays   = (classCounts['Very Unhealthy']||0) + (classCounts.Hazardous||0);

  // ── WHO/NAAQS compliance (PM2.5) ─────────────────────────────────────────
  const pm25All  = cur.map(d=>d.pm25).filter(v=>v!=null);
  const whoOK    = pm25All.filter(v=>v<=WHO_LIMITS.pm25).length;
  const naaqs_OK = pm25All.filter(v=>v<=NAAQS_LIMITS.pm25).length;
  const whoPct   = pm25All.length ? +(whoOK/pm25All.length*100).toFixed(1) : null;
  const naaqs_Pct= pm25All.length ? +(naaqs_OK/pm25All.length*100).toFixed(1) : null;

  // ── Dominant pollutant ────────────────────────────────────────────────────
  const exceedCounts = {};
  Object.entries(WHO_LIMITS).forEach(([p,w]) => {
    exceedCounts[p] = cur.filter(d=>d[p]!=null && d[p]>w).length;
  });
  const dominantParam = Object.entries(exceedCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'pm25';
  const dominantPct   = pm25All.length ? +(exceedCounts[dominantParam]/cur.length*100).toFixed(1) : null;

  // ── Hourly profile (0-23) ─────────────────────────────────────────────────
  const byHour = Array.from({length:24}, (_,h) => {
    const hrs = cur.filter(d => new Date(d.timestamp).getHours() === h);
    const weekday = hrs.filter(d => ![0,6].includes(new Date(d.timestamp).getDay()));
    const weekend = hrs.filter(d => [0,6].includes(new Date(d.timestamp).getDay()));
    return {
      hour: h,
      mean_aqi:    _mean(hrs.map(d=>d.aqi)),
      mean_pm25:   _mean(hrs.map(d=>d.pm25)),
      weekday_aqi: _mean(weekday.map(d=>d.aqi)),
      weekend_aqi: _mean(weekend.map(d=>d.aqi)),
      readings: hrs.length,
    };
  });
  const sortedHours = [...byHour].filter(h=>h.mean_aqi!=null).sort((a,b)=>b.mean_aqi-a.mean_aqi);
  const worst3   = sortedHours.slice(0,3).map(h=>h.hour);
  const cleanest3= sortedHours.slice(-3).map(h=>h.hour);

  // ── Per-parameter trends ──────────────────────────────────────────────────
  const _activeParams = window.Filters ? window.Filters.getActivePollutants() : Object.keys(PARAM_LABELS);
  const paramTrends = Object.keys(PARAM_LABELS).filter(p => _activeParams.includes(p)).map(p => {
    const vals     = cur.map(d=>d[p]).filter(v=>v!=null);
    const prevVals = prev.map(d=>d[p]).filter(v=>v!=null);
    const curMean  = _mean(vals);
    const prevMean = _mean(prevVals);
    const daily    = dayKeys.map(k => _mean(byDay[k].map(d=>d[p])));
    const slope    = _linregSlope(daily.filter(v=>v!=null));
    const dir      = curMean ? (slope/curMean*100 > 2 ? 'up' : slope/curMean*100 < -2 ? 'down' : 'stable') : 'stable';
    const who  = WHO_LIMITS[p];
    const naaqs= NAAQS_LIMITS[p];
    return {
      param:          p,
      label:          PARAM_LABELS[p],
      unit:           PARAM_UNITS[p],
      mean_current:   curMean ? +curMean.toFixed(2) : null,
      mean_previous:  prevMean ? +prevMean.toFixed(2) : null,
      pct_change:     _pctChange(curMean, prevMean),
      slope:          +slope.toFixed(4),
      direction:      dir,
      who_ratio:      who && curMean ? +(curMean/who).toFixed(2) : null,
      naaqs_ratio:    naaqs && curMean ? +(curMean/naaqs).toFixed(2) : null,
      who_exceedance_pct:  vals.length && who ? +(vals.filter(v=>v>who).length/vals.length*100).toFixed(1) : null,
      naaqs_exceedance_pct: vals.length && naaqs ? +(vals.filter(v=>v>naaqs).length/vals.length*100).toFixed(1) : null,
      daily_series:   dayKeys.map((d,i)=>({date:d, value: _mean(byDay[d].map(dd=>dd[p]))})),
    };
  });

  // ── PLI (health index) ────────────────────────────────────────────────────
  const overallMeans = {};
  Object.keys(PARAM_LABELS).forEach(p => { overallMeans[p] = _mean(cur.map(d=>d[p]).filter(v=>v!=null)); });
  const pli = _pli(overallMeans);

  const dailyPLI = dayKeys.map(date => {
    const dm = {};
    Object.keys(PARAM_LABELS).forEach(p => { dm[p] = _mean(byDay[date].map(d=>d[p]).filter(v=>v!=null)); });
    const dp = _pli(dm);
    const cat= dp==null?'Unknown': dp<=0.5?'Low': dp<=1?'Moderate': dp<=2?'High': dp<=5?'Very High':'Extreme';
    return { date, pli: dp, risk: cat };
  });
  const riskCounts = {Low:0,Moderate:0,High:0,'Very High':0,Extreme:0};
  dailyPLI.forEach(r => { if (r.risk in riskCounts) riskCounts[r.risk]++; });

  // ── Heatmap data (param × hour) ───────────────────────────────────────────
  const heatmap = {};
  Object.keys(PARAM_LABELS).forEach(p => {
    heatmap[p] = Array.from({length:24}, (_,h) => {
      const hrs = cur.filter(d=>new Date(d.timestamp).getHours()===h && d[p]!=null);
      return hrs.length ? +(_mean(hrs.map(d=>d[p]))).toFixed(2) : null;
    });
  });

  // ── Sparkline (daily AQI) ─────────────────────────────────────────────────
  const sparkline = dayKeys.map((d,i)=>({date:d, aqi:dayMeans[i]}));

  return {
    avgAQI, prevAvgAQI, peakAQI, peakHour, peakDate,
    totalDays, safeDays, hazDays, classCounts, byDayList,
    whoPct, naaqs_Pct, dominantParam, dominantPct,
    byHour, worst3, cleanest3,
    paramTrends,
    pli, pliComponents: Object.entries(WHO_LIMITS).map(([p,w])=>({
      param:p, mean: overallMeans[p], who:w,
      ratio: overallMeans[p]!=null && w ? +(overallMeans[p]/w).toFixed(2) : null
    })),
    dailyPLI, riskCounts,
    heatmap, sparkline,
    aqi_pct_change: _pctChange(avgAQI, prevAvgAQI),
    period: days,
  };
}

// ── Browser-source data ───────────────────────────────────────────────────────
// The KPI period tabs (7/30/90 d) are the window control here — independent of
// the Overview's time-range and the global filter's day clamp — so generate that
// many days of hourly readings for the current city directly. Without this the
// view inherits the Overview's 24 h slice and shows ~2 days for any period.
function _kpiBrowserData(days) {
  if (typeof generateHistoricalData === 'function') {
    return generateHistoricalData(state.city, days * 24, 3_600_000);
  }
  return window.Filters?.getFilteredData() || state.data;
}

// ── Main render entry ─────────────────────────────────────────────────────────
function renderKPIs() {
  const view = document.getElementById('view-kpis');
  if (!view) return;
  if (!view._bound) {
    view._bound = true;
    _bindKPIControls();
  }
  _refreshKPIs();
}

function _bindKPIControls() {
  // Period tabs
  document.querySelectorAll('.kpi-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.kpi-period-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      kpiState.period = parseInt(btn.dataset.days);
      _refreshKPIs();
    });
  });

  // Source toggle
  document.getElementById('btn-kpi-browser')?.addEventListener('click', () => {
    kpiState.source = 'browser';
    document.getElementById('btn-kpi-browser').classList.add('active');
    document.getElementById('btn-kpi-api').classList.remove('active');
    _refreshKPIs();
  });
  document.getElementById('btn-kpi-api')?.addEventListener('click', () => {
    kpiState.source = 'api';
    document.getElementById('btn-kpi-api').classList.add('active');
    document.getElementById('btn-kpi-browser').classList.remove('active');
    _refreshKPIs();
  });

  document.getElementById('btn-kpi-refresh')?.addEventListener('click', _refreshKPIs);
}

async function _refreshKPIs() {
  const statusEl = document.getElementById('kpi-status');
  if (statusEl) statusEl.textContent = 'Computing…';

  let kpis = null;
  try {
    if (kpiState.source === 'api' && window.ApiClient) {
      kpis = await _fetchKPIsFromAPI(kpiState.period);
    } else {
      kpis = computeKPIs(_kpiBrowserData(kpiState.period), kpiState.period);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
    return;
  }

  if (!kpis) {
    if (statusEl) statusEl.textContent = 'No data available for this period.';
    return;
  }

  kpiState.kpis = kpis;
  document.getElementById('kpi-city-label').textContent =
    (state.city || 'Delhi').charAt(0).toUpperCase() + (state.city||'delhi').slice(1);

  _renderKPICards(kpis);
  _renderAQITrendChart(kpis);
  _renderDayClassChart(kpis);
  _renderPeakHoursChart(kpis);
  _renderTrendsTable(kpis);
  _renderHealthIndex(kpis);
  _renderRiskChart(kpis);
  _renderHeatmap(kpis);

  if (statusEl) statusEl.textContent =
    `Last updated: ${new Date().toLocaleTimeString()} · ${kpis.period}d · ${kpis.sparkline?.length || 0} days data`;
}

// ── API source (calls Flask backend) ─────────────────────────────────────────
async function _fetchKPIsFromAPI(period) {
  const city = state.city || 'delhi';
  try {
    const [ov, ph, dc, tr, hi] = await Promise.all([
      ApiClient.cities    ? fetch(`${ApiClient.getBaseUrl()}/kpis/overview?city=${city}&period=${period}`).then(r=>r.json()).then(r=>r.data) : null,
      ApiClient.cities    ? fetch(`${ApiClient.getBaseUrl()}/kpis/peak-hours?city=${city}&period=${period}`).then(r=>r.json()).then(r=>r.data) : null,
      ApiClient.cities    ? fetch(`${ApiClient.getBaseUrl()}/kpis/day-categories?city=${city}&period=${period}`).then(r=>r.json()).then(r=>r.data) : null,
      ApiClient.cities    ? fetch(`${ApiClient.getBaseUrl()}/kpis/trends?city=${city}&period=${period}`).then(r=>r.json()).then(r=>r.data) : null,
      ApiClient.cities    ? fetch(`${ApiClient.getBaseUrl()}/kpis/health-index?city=${city}&period=${period}`).then(r=>r.json()).then(r=>r.data) : null,
    ]);
    // Remap API response shapes to match browser computeKPIs output
    return {
      avgAQI:        ov?.avg_aqi,          prevAvgAQI:    ov?.prev_avg_aqi,
      aqi_pct_change:ov?.aqi_pct_change,   peakAQI:       ov?.peak_aqi,
      peakHour:      ov?.peak_hour,        peakDate:      ov?.peak_date,
      totalDays:     ov?.total_days,       safeDays:      ov?.safe_days,
      hazDays:       ov?.hazardous_days,   whoPct:        ov?.who_compliance_pct,
      naaqs_Pct:     ov?.naaqs_compliance_pct,
      dominantParam: ov?.dominant_param,   dominantPct:   ov?.dominant_exceedance_pct,
      sparkline:     ov?.sparkline,        classCounts:   dc?.counts,
      byDayList:     dc?.by_day,           byHour:        ph?.hours,
      worst3:        ph?.worst_3,          cleanest3:     ph?.cleanest_3,
      paramTrends:   tr?.map?.(t=>({...t, label:PARAM_LABELS[t.param]||t.param, unit:PARAM_UNITS[t.param]||''})) || [],
      pli:           hi?.pli,             pliComponents: hi?.components?.map?.(c=>({...c,mean:c.mean})) || [],
      dailyPLI:      hi?.daily_series,    riskCounts:    hi?.risk_counts,
      heatmap:       null, period,
    };
  } catch(e) {
    showToast(`API error: ${e.message} — falling back to browser`, 3000);
    return computeKPIs(_kpiBrowserData(period), period);
  }
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────
function _renderKPICards(kpis) {
  const row = document.getElementById('kpi-cards-row');
  if (!row) return;
  const { avgAQI, prevAvgAQI, aqi_pct_change, peakAQI, peakHour, totalDays,
          safeDays, hazDays, whoPct, dominantParam, dominantPct, sparkline } = kpis;

  const changeEl = (pct, invert=false) => {
    if (pct == null) return '';
    const isUp    = pct > 0;
    const cls     = invert ? (isUp?'down':'up') : (isUp?'up':'down');
    const arrow   = isUp ? '↑' : '↓';
    return `<span class="kpi-card-change ${cls}">${arrow} ${Math.abs(pct)}% vs prev</span>`;
  };

  // Build sparkline SVG
  function _sparkSVG(vals, color) {
    const v = vals.filter(x=>x!=null);
    if (v.length < 2) return '';
    const mn=Math.min(...v), mx=Math.max(...v), rng=mx-mn||1;
    const W=200, H=36, pts = v.map((y,i)=>`${(i/(v.length-1))*W},${H-(y-mn)/rng*H}`).join(' ');
    return `<svg class="kpi-sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>
      <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".4"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
      <polygon fill="url(#sg)" points="0,${H} ${pts} ${W},${H}"/>
    </svg>`;
  }

  const aqiColor  = _aqiColor(avgAQI ? Math.round(avgAQI) : null);
  const aqiCls    = avgAQI <= 50 ? 'good' : avgAQI <= 100 ? 'moderate' : avgAQI <= 200 ? 'unhealthy' : 'hazardous';
  const peakColor = _aqiColor(peakAQI ? Math.round(peakAQI) : null);
  const hourLabel = peakHour != null ? `${peakHour===0?12:peakHour>12?peakHour-12:peakHour} ${peakHour<12?'AM':'PM'}` : '—';

  const sparkVals = (sparkline||[]).map(s=>s.aqi);

  const CARDS = [
    {
      icon:'📊', label:'Avg AQI', cls: aqiCls,
      value: avgAQI ? avgAQI.toFixed(0) : '—',
      sub: _aqiLabel(avgAQI ? Math.round(avgAQI) : null),
      change: changeEl(aqi_pct_change, true),
      accent: aqiColor, spark: _sparkSVG(sparkVals, aqiColor),
    },
    {
      icon:'⚡', label:'Peak AQI', cls: peakAQI>200?'hazardous':peakAQI>100?'unhealthy':'moderate',
      value: peakAQI ? Math.round(peakAQI) : '—',
      sub: `at ${hourLabel}${kpis.peakDate ? ' · '+kpis.peakDate.slice(5) : ''}`,
      change: '', accent: peakColor, spark:'',
    },
    {
      icon:'✅', label:'Safe Days',
      value: safeDays,
      sub: `of ${totalDays} days (AQI ≤ 100)`,
      change: `<span class="kpi-card-change ${safeDays/totalDays>=.5?'down':'up'}">${totalDays?+(safeDays/totalDays*100).toFixed(0):0}%</span>`,
      accent: '#22c55e', spark: '', cls:'',
    },
    {
      icon:'☠️', label:'Hazardous Days',
      value: hazDays,
      sub: `of ${totalDays} days (AQI > 200)`,
      change: `<span class="kpi-card-change ${hazDays>0?'up':'down'}">${totalDays?+(hazDays/totalDays*100).toFixed(0):0}%</span>`,
      accent: '#991b1b', spark: '', cls: hazDays>0?'hazardous':'',
    },
    {
      icon:'🌍', label:'WHO Compliance',
      value: whoPct != null ? `${whoPct}%` : '—',
      sub: 'PM2.5 ≤ 15 μg/m³',
      change: `<span class="kpi-card-change ${(whoPct||0)>=50?'down':'up'}">${(whoPct||0)>=50?'On track':'Off target'}</span>`,
      accent: (whoPct||0)>=80?'#22c55e':(whoPct||0)>=40?'#eab308':'#ef4444', spark:'', cls:'',
    },
    {
      icon:'🔴', label:'Dominant Pollutant',
      value: dominantParam ? PARAM_LABELS[dominantParam]||dominantParam : '—',
      sub: dominantPct!=null ? `${dominantPct}% above WHO limit` : '',
      change: '', accent: '#8b5cf6', spark:'', cls:'',
    },
  ];

  row.innerHTML = CARDS.map(c => `
    <div class="kpi-card">
      <div class="kpi-card-accent-bar" style="background:${c.accent}"></div>
      <div class="kpi-card-icon">${c.icon}</div>
      <div class="kpi-card-label">${c.label}</div>
      <div class="kpi-card-value ${c.cls||''}">${c.value}</div>
      <div class="kpi-card-sub">${c.sub||''}</div>
      ${c.change}
      ${c.spark}
    </div>
  `).join('');
}

// ── AQI Trend Chart ───────────────────────────────────────────────────────────
function _renderAQITrendChart(kpis) {
  const canvas = document.getElementById('kpi-chart-trend');
  if (!canvas) return;
  if (kpiState.charts.trend) kpiState.charts.trend.destroy();

  const dates  = (kpis.sparkline||[]).map(s=>s.date);
  const vals   = (kpis.sparkline||[]).map(s=>s.aqi);
  const rolled = _rollingMean(vals, 7);

  const sub = document.getElementById('kpi-trend-sub');
  if (sub) sub.textContent = `${dates.length} days · 7-day rolling avg`;

  // Category annotation bands
  const plugins = window.Chart?.registry?.plugins ? [] : [];

  kpiState.charts.trend = new Chart(canvas, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'Daily Mean AQI',
          data: vals,
          borderColor: vals.map(v=>_aqiColor(v?Math.round(v):null)),
          borderWidth: 0,
          backgroundColor: vals.map(v=>_aqiColor(v?Math.round(v):null)+'55'),
          fill: false,
          pointRadius: 3, pointHoverRadius: 5,
          segment: { borderColor: ctx => _aqiColor(Math.round(ctx.p1.parsed.y||0)) },
        },
        {
          label: '7-Day Rolling Avg',
          data: rolled,
          borderColor: 'rgba(255,255,255,.55)',
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: 'rgba(255,255,255,.5)', boxWidth: 12, font:{size:10} } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(0)} (${_aqiLabel(Math.round(ctx.parsed.y||0))})`,
          },
        },
      },
      scales: {
        x: { ticks:{ color:'rgba(255,255,255,.3)', maxTicksLimit:8, font:{size:9} }, grid:{color:'rgba(255,255,255,.05)'} },
        y: {
          min: 0, ticks:{ color:'rgba(255,255,255,.3)', font:{size:9} },
          grid: { color:'rgba(255,255,255,.05)' },
        },
      },
    },
  });
}

// ── Day Classification Chart ──────────────────────────────────────────────────
function _renderDayClassChart(kpis) {
  const canvas = document.getElementById('kpi-chart-days');
  if (!canvas) return;
  if (kpiState.charts.days) kpiState.charts.days.destroy();

  const counts = kpis.classCounts || {};
  const labels = ['Good','Moderate','Unhealthy for Sensitive','Unhealthy','Very Unhealthy','Hazardous'];
  const colors = ['#22c55e','#eab308','#f97316','#ef4444','#8b5cf6','#991b1b'];
  const data   = labels.map(l=>counts[l]||0);

  kpiState.charts.days = new Chart(canvas, {
    type: 'doughnut',
    data: { labels: labels.map((_,i)=>AQI_CATS[i].short), datasets:[{ data, backgroundColor: colors, borderWidth:2, borderColor:'rgba(0,0,0,.3)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${labels[ctx.dataIndex]}: ${ctx.parsed} days` } },
      },
    },
  });

  // Custom legend
  const leg = document.getElementById('kpi-days-legend');
  if (leg) leg.innerHTML = labels.map((l,i) => `
    <div class="kpi-days-legend-item">
      <div class="kpi-days-dot" style="background:${colors[i]}"></div>
      <span>${l}: <strong>${data[i]}</strong></span>
    </div>`).join('');

  const sub = document.getElementById('kpi-days-sub');
  if (sub) sub.textContent = `${kpis.totalDays} days · ${kpis.safeDays} safe (${kpis.totalDays?+(kpis.safeDays/kpis.totalDays*100).toFixed(0):0}%)`;
}

// ── Peak Hours Chart ──────────────────────────────────────────────────────────
function _renderPeakHoursChart(kpis) {
  const canvas = document.getElementById('kpi-chart-hours');
  if (!canvas) return;
  if (kpiState.charts.hours) kpiState.charts.hours.destroy();

  const hours = kpis.byHour || [];
  const labels = hours.map(h => h.hour!=null ? `${h.hour===0?'12':h.hour>12?h.hour-12:h.hour}${h.hour<12?'a':'p'}` : '');
  const vals   = hours.map(h => h.mean_aqi != null ? +h.mean_aqi.toFixed(0) : null);
  const colors = vals.map(v => v!=null ? _aqiColor(Math.round(v)) : 'rgba(255,255,255,.1)');

  const worst    = new Set(kpis.worst3 || []);
  const cleanest = new Set(kpis.cleanest3 || []);

  // Peak badges
  const badgesEl = document.getElementById('kpi-peak-badges');
  if (badgesEl) {
    const fmt = h => `${h===0?12:h>12?h-12:h}${h<12?'AM':'PM'}`;
    badgesEl.innerHTML = [
      `<span class="kpi-peak-badge worst">⚠ Peak: ${(kpis.worst3||[]).map(fmt).join(', ')}</span>`,
      `<span class="kpi-peak-badge cleanest">✓ Clean: ${(kpis.cleanest3||[]).map(fmt).join(', ')}</span>`,
    ].join('');
  }

  kpiState.charts.hours = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Mean AQI by Hour',
          data: vals,
          backgroundColor: colors,
          borderRadius: 3,
          borderWidth: 0,
        },
        {
          type: 'line',
          label: 'Weekday',
          data: hours.map(h=>h.weekday_aqi!=null?+h.weekday_aqi.toFixed(0):null),
          borderColor: 'rgba(255,255,255,.35)', borderWidth:1.5, pointRadius:0, fill:false, tension:0.4,
        },
        {
          type: 'line',
          label: 'Weekend',
          data: hours.map(h=>h.weekend_aqi!=null?+h.weekend_aqi.toFixed(0):null),
          borderColor: 'rgba(139,92,246,.6)', borderWidth:1.5, pointRadius:0, fill:false, tension:0.4,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color:'rgba(255,255,255,.4)', boxWidth:10, font:{size:9} } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(0)} (${_aqiLabel(Math.round(ctx.parsed.y||0))})`,
            afterLabel: ctx => {
              if (ctx.datasetIndex !== 0) return;
              const h = parseInt(ctx.label);
              if (worst.has(ctx.dataIndex))    return '⚠ Peak hour';
              if (cleanest.has(ctx.dataIndex)) return '✓ Cleanest hour';
              return '';
            },
          },
        },
      },
      scales: {
        x: { ticks:{ color:'rgba(255,255,255,.3)', font:{size:9} }, grid:{display:false} },
        y: { min:0, ticks:{ color:'rgba(255,255,255,.3)', font:{size:9} }, grid:{color:'rgba(255,255,255,.05)'} },
      },
    },
  });
}

// ── Pollutant Trends Table ────────────────────────────────────────────────────
function _renderTrendsTable(kpis) {
  const wrap = document.getElementById('kpi-trends-table');
  if (!wrap) return;

  const trends = kpis.paramTrends || [];
  if (!trends.length) { wrap.innerHTML = '<p style="color:var(--text-muted);font-size:.72rem;padding:16px">No trend data</p>'; return; }

  const dirIcon = d => d==='up'?'↑':d==='down'?'↓':'→';

  function _ratioBar(ratio, label) {
    if (ratio == null) return '—';
    const pct   = Math.min(ratio * 50, 100);
    const color = ratio<=1?'#22c55e':ratio<=2?'#eab308':'#ef4444';
    const cls   = ratio<=1?'ok':ratio<=2?'warning':'danger';
    return `<div class="kpi-ratio-bar-wrap">
      <div class="kpi-ratio-bar-bg"><div class="kpi-ratio-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="kpi-ratio-val ${cls}">${ratio}×</span>
    </div>`;
  }

  wrap.innerHTML = `<table class="kpi-trends-table">
    <thead><tr>
      <th>Param</th><th>Mean</th><th>Trend</th><th>Chg%</th><th>vs WHO</th><th>vs NAAQS</th>
    </tr></thead>
    <tbody>
    ${trends.map(t=>`<tr>
      <td class="kpi-trend-param">${t.label||t.param}</td>
      <td>${t.mean_current!=null?t.mean_current+' '+t.unit:'—'}</td>
      <td class="kpi-trend-dir ${t.direction}">${dirIcon(t.direction)}</td>
      <td style="color:${t.pct_change==null?'var(--text-muted)':t.pct_change>0?'#ef4444':'#22c55e'}">${t.pct_change!=null?(t.pct_change>0?'+':'')+t.pct_change+'%':'—'}</td>
      <td>${_ratioBar(t.who_ratio, 'WHO')}</td>
      <td>${_ratioBar(t.naaqs_ratio,'NAAQS')}</td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

// ── Health Index Panel ────────────────────────────────────────────────────────
function _renderHealthIndex(kpis) {
  const el = document.getElementById('kpi-health-content');
  if (!el) return;
  const { pli, pliComponents } = kpis;
  const { label, color } = _pliCat(pli);

  const compRows = (pliComponents||[]).filter(c=>c.ratio!=null).sort((a,b)=>b.ratio-a.ratio);
  const maxRatio = Math.max(...compRows.map(c=>c.ratio||0), 1);

  el.innerHTML = `
    <div class="kpi-pli-meter">
      <div class="kpi-pli-gauge" style="border-color:${color}">
        <div class="kpi-pli-num" style="color:${color}">${pli!=null?pli.toFixed(2):'—'}</div>
        <div class="kpi-pli-cat" style="color:${color}">${label}</div>
      </div>
      <div class="kpi-pli-components">
        ${compRows.map(c=>{
          const barPct = Math.min(c.ratio/maxRatio*100,100);
          const barColor= c.ratio<=1?'#22c55e':c.ratio<=2?'#eab308':c.ratio<=5?'#ef4444':'#991b1b';
          return `<div class="kpi-pli-row">
            <span class="kpi-pli-name">${PARAM_LABELS[c.param]||c.param}</span>
            <div class="kpi-pli-bar-bg"><div class="kpi-pli-bar" style="width:${barPct}%;background:${barColor}"></div></div>
            <span class="kpi-pli-ratio" style="color:${barColor}">${c.ratio!=null?c.ratio+'×':'—'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div style="font-size:.64rem;color:var(--text-muted);margin-top:8px">
      PLI = geometric mean of (concentration/WHO guideline) across PM2.5, PM10, NO₂, SO₂, O₃, CO.<br>
      PLI ≤ 1.0 = within WHO guidelines &nbsp;·&nbsp; PLI > 5.0 = hazardous conditions.
    </div>
  `;
}

// ── Risk Day Distribution Chart ───────────────────────────────────────────────
function _renderRiskChart(kpis) {
  const canvas = document.getElementById('kpi-chart-risk');
  if (!canvas) return;
  if (kpiState.charts.risk) kpiState.charts.risk.destroy();

  const cats   = ['Low','Moderate','High','Very High','Extreme'];
  const colors = ['#22c55e','#eab308','#f97316','#ef4444','#991b1b'];
  const data   = cats.map(c=>(kpis.riskCounts||{})[c]||0);

  kpiState.charts.risk = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: cats,
      datasets:[{ data, backgroundColor: colors, borderRadius:4, borderWidth:0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.parsed.x} days` } },
      },
      scales: {
        x: { ticks:{color:'rgba(255,255,255,.3)',font:{size:9}}, grid:{color:'rgba(255,255,255,.05)'} },
        y: { ticks:{color:'rgba(255,255,255,.4)',font:{size:10}}, grid:{display:false} },
      },
    },
  });
}

// ── Heatmap (param × hour) ────────────────────────────────────────────────────
function _renderHeatmap(kpis) {
  const wrap = document.getElementById('kpi-heatmap');
  if (!wrap) return;

  const heatmap = kpis.heatmap;
  if (!heatmap) { wrap.innerHTML = '<p style="color:var(--text-muted);font-size:.72rem;padding:12px">No heatmap data available</p>'; return; }

  // Legend
  const legEl = document.getElementById('kpi-heatmap-legend');
  if (legEl) legEl.innerHTML = `<span>Low</span><div class="kpi-heatmap-gradient"></div><span>High</span>`;

  const params = Object.keys(PARAM_LABELS);
  const hours  = Array.from({length:24}, (_,h) => h);
  const hourFmt= h => `${h===0?'12':h>12?h-12:h}${h<12?'a':'p'}`;

  // Per-row min/max for relative coloring
  function _cellColor(val, mn, mx) {
    if (val == null) return null;
    const t = mx > mn ? (val-mn)/(mx-mn) : 0;
    const r = Math.round(34 + t*(239-34));
    const g = Math.round(197 + t*(68-197));
    const b = Math.round(94 + t*(68-94));
    return `rgb(${r},${g},${b})`;
  }
  function _textColor(r,g,b) {
    const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
    return luminance > 0.5 ? '#000' : '#fff';
  }
  function _parseRgb(css) {
    const m = css.match(/rgb\((\d+),(\d+),(\d+)\)/);
    return m ? [+m[1],+m[2],+m[3]] : [255,255,255];
  }

  let html = `<table class="kpi-hm-table"><thead><tr>
    <th class="kpi-hm-param-label">Param</th>
    ${hours.map(h=>`<th>${hourFmt(h)}</th>`).join('')}
  </tr></thead><tbody>`;

  params.forEach(p => {
    const vals = heatmap[p] || [];
    const nonNull = vals.filter(v=>v!=null);
    const mn = nonNull.length ? Math.min(...nonNull) : 0;
    const mx = nonNull.length ? Math.max(...nonNull) : 1;

    html += `<tr><td class="kpi-hm-param-label">${PARAM_LABELS[p]}</td>`;
    hours.forEach(h => {
      const val = vals[h];
      if (val == null) {
        html += `<td><div class="kpi-hm-cell missing">—</div></td>`;
      } else {
        const bg  = _cellColor(val, mn, mx);
        const rgb = _parseRgb(bg);
        const fg  = _textColor(...rgb);
        html += `<td><div class="kpi-hm-cell" style="background:${bg};color:${fg}" title="${PARAM_LABELS[p]} at ${hourFmt(h)}: ${val}">${val < 10 ? val.toFixed(1) : Math.round(val)}</div></td>`;
      }
    });
    html += '</tr>';
  });

  wrap.innerHTML = html + '</tbody></table>';
}

// ═══════════════════════════════════════════════════════════
// VIEW: ETL STUDIO
// ═══════════════════════════════════════════════════════════

const etlState = {
  sourceType: 'csv_file',
  extractResult: null,     // { headers, rows, typeInfo, mapping }
  mapping: [],             // [{ source, target, confidence }]
  steps: [],               // [{ op, config, enabled }]
  targets: new Set(),
  currentRows: null,
  previewRows: null,
  draggingIdx: null,
};

function renderETL() {
  const view = document.getElementById('view-etl');
  if (!view || view._bound) return;
  view._bound = true;

  // Populate templates dropdown
  const tmplSel = document.getElementById('etl-template-select');
  ETL_ENGINE.listTemplates().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.name;
    tmplSel.appendChild(opt);
  });
  tmplSel.addEventListener('change', () => {
    if (!tmplSel.value) return;
    loadTemplate(tmplSel.value);
    tmplSel.value = '';
  });

  // Populate operator menu
  const menu = document.getElementById('etl-add-step-menu');
  ETL_TRANSFORM.listOperators().forEach(op => {
    const btn = document.createElement('button');
    btn.className = 'etl-op-btn';
    btn.innerHTML = `<span class="etl-op-icon">${op.icon}</span><span class="etl-op-name">${op.label}</span>`;
    btn.addEventListener('click', () => {
      etlState.steps.push({ op: op.name, config: {}, enabled: true });
      menu.style.display = 'none';
      renderStepsList();
    });
    menu.appendChild(btn);
  });

  // Populate targets
  const targetWrap = document.getElementById('etl-target-buttons');
  ETL_LOAD.listTargets().forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'etl-src-btn';
    btn.textContent = `${t.icon} ${t.label}`;
    btn.dataset.target = t.id;
    btn.addEventListener('click', () => {
      if (etlState.targets.has(t.id)) etlState.targets.delete(t.id);
      else etlState.targets.add(t.id);
      btn.classList.toggle('target-on', etlState.targets.has(t.id));
    });
    targetWrap.appendChild(btn);
  });
  etlState.targets.add('dashboard_state');
  targetWrap.querySelector('[data-target="dashboard_state"]')?.classList.add('target-on');
  targetWrap.querySelector('[data-target="csv_export"]')?.classList.add('target-on');
  etlState.targets.add('csv_export');

  // Source buttons
  document.getElementById('etl-source-buttons').querySelectorAll('.etl-src-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.etl-src-btn[data-src]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      etlState.sourceType = btn.dataset.src;
      renderSourceConfig();
    });
  });
  renderSourceConfig();

  // Drop zone
  const dropZone  = document.getElementById('etl-drop-zone');
  const fileInput = document.getElementById('etl-file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.csv') || f.name.endsWith('.tsv') || f.name.endsWith('.json'))) handleFile(f);
    else showToast('Drop a .csv, .tsv, or .json file', 2500);
  });
  document.getElementById('etl-file-clear').addEventListener('click', clearFile);

  // Toolbar
  document.getElementById('btn-etl-new').addEventListener('click', resetETL);
  document.getElementById('btn-etl-preview').addEventListener('click', () => runJob(true));
  document.getElementById('btn-etl-run').addEventListener('click', () => runJob(false));
  document.getElementById('btn-etl-history').addEventListener('click', toggleHistory);
  document.getElementById('btn-etl-clear-history').addEventListener('click', () => {
    ETL_ENGINE.clearHistory(); renderHistory();
  });
  document.getElementById('btn-etl-add-step').addEventListener('click', (e) => {
    const menu = document.getElementById('etl-add-step-menu');
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.cssText = `display:grid;position:fixed;top:${rect.bottom+4}px;left:${rect.left}px`;
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  });
  function closeMenu() { document.getElementById('etl-add-step-menu').style.display = 'none'; }
  document.getElementById('btn-etl-auto-map')?.addEventListener('click', () => {
    if (etlState.extractResult) { etlState.mapping = [...etlState.extractResult.mapping]; renderMappingTable(); }
  });
  document.getElementById('etl-preview-mode')?.addEventListener('change', () => {
    if (etlState.previewRows) renderPreviewTable(etlState.previewRows);
  });

  // Progress bus
  ETL_ENGINE.onProgress(evt => renderProgress(evt));
}

// ── Source config ─────────────────────────────────────────
function renderSourceConfig() {
  const cfg = document.getElementById('etl-src-config');
  const { sourceType } = etlState;
  const showDrop = sourceType === 'csv_file' || sourceType === 'json_file';
  document.getElementById('etl-drop-zone').style.display = showDrop ? '' : 'none';
  if (!showDrop) clearFile();

  const configs = {
    current: `<div style="padding:8px 0;font-size:.72rem;color:var(--text-secondary)">
        Uses current dashboard data (${state.data.length} rows for <strong>${state.city}</strong>).</div>`,
    iot: `<div style="padding:8px 0"><label style="font-size:.70rem;color:var(--text-muted)">Duration (hours)</label>
        <input type="number" id="etl-iot-hours" value="24" min="1" max="168"
          style="background:var(--bg-input);border:1px solid var(--border);border-radius:4px;
                 padding:4px 8px;font-size:.72rem;color:var(--text-primary);width:80px;margin-left:8px"></div>`,
    cpcb: `<div style="padding:8px 0;display:flex;flex-wrap:wrap;gap:8px">
        <label style="font-size:.70rem;color:var(--text-muted)">Year:</label>
        <select id="etl-cpcb-year" style="background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:4px;font-size:.70rem;color:var(--text-primary)">
          <option value="">All (2019–2023)</option>
          ${[2019,2020,2021,2022,2023].map(y=>`<option>${y}</option>`).join('')}
        </select></div>`,
    sqlite: `<div style="padding:8px 0">
        <label style="font-size:.70rem;color:var(--text-muted)">SQL Query</label>
        <textarea id="etl-sqlite-sql" rows="3" style="width:100%;margin-top:4px;background:var(--bg-input);
          border:1px solid var(--border);border-radius:4px;padding:6px;font-size:.70rem;
          color:var(--text-primary);font-family:monospace;resize:vertical">SELECT * FROM vw_latest_measurements LIMIT 500</textarea>
        <button class="btn-etl" style="margin-top:6px;padding:4px 10px;font-size:.68rem" id="btn-etl-run-sql">↓ Fetch</button>
        </div>`,
  };
  cfg.innerHTML = configs[sourceType] || '';
  if (sourceType === 'sqlite') {
    document.getElementById('btn-etl-run-sql')?.addEventListener('click', async () => {
      const sql = document.getElementById('etl-sqlite-sql')?.value;
      if (!sql) return;
      await extractAndLoad(() => ETL_EXTRACT.fromSQLite(sql));
    });
  }
  if (sourceType === 'current') extractAndLoad(() => ETL_EXTRACT.fromCurrentState(state.data, state.city));
  if (sourceType === 'iot') {
    const btn = document.createElement('button');
    btn.className = 'btn-etl'; btn.textContent = '↓ Load from IoT';
    btn.style.cssText = 'margin-top:8px;display:block';
    btn.addEventListener('click', () => {
      const h = parseInt(document.getElementById('etl-iot-hours')?.value || 24);
      extractAndLoad(() => ETL_EXTRACT.fromIoT(state.city, h));
    });
    cfg.appendChild(btn);
  }
  if (sourceType === 'cpcb') {
    const btn = document.createElement('button');
    btn.className = 'btn-etl'; btn.textContent = '↓ Load from CPCB';
    btn.style.cssText = 'margin-top:8px;display:block';
    btn.addEventListener('click', () => {
      const yr = document.getElementById('etl-cpcb-year')?.value;
      extractAndLoad(() => ETL_EXTRACT.fromCPCB(state.city, yr ? +yr : null));
    });
    cfg.appendChild(btn);
  }
}

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  await extractAndLoad(() => ext === 'json' ? ETL_EXTRACT.fromJSONFile(file) : ETL_EXTRACT.fromCSVFile(file));
  document.getElementById('etl-file-info').style.display = 'flex';
  document.getElementById('etl-drop-zone').style.display = '';
  document.getElementById('etl-file-name').textContent = file.name;
}

function clearFile() {
  etlState.extractResult = null; etlState.mapping = [];
  document.getElementById('etl-file-info').style.display = 'none';
  document.getElementById('etl-mapping-panel').style.display = 'none';
  document.getElementById('etl-file-input').value = '';
}

async function extractAndLoad(fn) {
  try {
    showToast('Extracting…', 1500);
    const result = await fn();
    etlState.extractResult = result;
    etlState.mapping = result.mapping ? [...result.mapping] : ETL_EXTRACT.autoMap(result.headers);
    etlState.currentRows = result.rows;

    const fileRows = document.getElementById('etl-file-rows');
    const fileDelim = document.getElementById('etl-file-delim');
    if (fileRows) fileRows.textContent = `${result.rowCount.toLocaleString()} rows`;
    if (fileDelim && result.delimiter) {
      const labels = { ',':'CSV', ';':'CSV (;)', '\t':'TSV', '|':'PSV' };
      fileDelim.textContent = labels[result.delimiter] || result.delimiter;
    }

    document.getElementById('etl-mapping-panel').style.display = '';
    renderMappingTable();
    renderPreviewTable(result.rows.slice(0, 50));
    document.getElementById('etl-preview-panel').style.display = '';
    showToast(`Loaded ${result.rowCount.toLocaleString()} rows`, 2000);
  } catch (e) {
    showToast(`Extract error: ${e.message}`, 4000);
  }
}

// ── Column mapping ────────────────────────────────────────
function renderMappingTable() {
  const { extractResult, mapping } = etlState;
  if (!extractResult) return;
  const { headers, typeInfo = [] } = extractResult;
  const typeMap = Object.fromEntries(typeInfo.map(t => [t.col, t]));

  const allTargets = ['', ...Object.keys(ETL_EXTRACT.ALIASES)];
  const mapped = mapping.filter(m => m.target).length;
  const conf   = document.getElementById('etl-mapping-conf-badge');
  if (conf) conf.textContent = `${mapped}/${headers.length} mapped`;

  const tbl = document.getElementById('etl-mapping-table');
  tbl.innerHTML = `<thead><tr>
    <th>Source Column</th><th>Type</th><th>Samples</th><th>→ Target Field</th><th>Conf</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  headers.forEach(h => {
    const mapEntry = mapping.find(m => m.source === h) || { source: h, target: null, confidence: 0 };
    const ti = typeMap[h] || {};
    const confVal = mapEntry.confidence || 0;
    const confCls = confVal >= 0.9 ? 'high' : confVal >= 0.6 ? 'med' : 'low';
    const confLabel = confVal >= 0.9 ? '●●●' : confVal >= 0.6 ? '●●○' : confVal > 0 ? '●○○' : '○○○';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="etl-map-src">${h}</td>
      <td class="etl-map-type">${ti.type || '?'}</td>
      <td class="etl-map-sample" title="${(ti.samples||[]).join(', ')}">${(ti.samples||[]).slice(0,2).join(', ')}</td>
      <td><select class="etl-map-sel" data-src="${h}">
        ${allTargets.map(t => `<option value="${t}" ${t===mapEntry.target?'selected':''}>${t || '— ignore —'}</option>`).join('')}
      </select></td>
      <td class="etl-map-conf ${confCls}">${confLabel}</td>
    `;
    tr.querySelector('select').addEventListener('change', e => {
      const mi = etlState.mapping.findIndex(m => m.source === h);
      if (mi >= 0) etlState.mapping[mi].target = e.target.value;
      else etlState.mapping.push({ source: h, target: e.target.value, confidence: 1 });
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
}

// ── Steps builder ─────────────────────────────────────────
function renderStepsList() {
  const list = document.getElementById('etl-steps-list');
  list.innerHTML = '';
  if (!etlState.steps.length) {
    list.innerHTML = '<div class="etl-steps-empty">No transform steps — raw data will be loaded as-is.<br>Click <strong>＋ Add Step</strong> to build your pipeline.</div>';
    return;
  }

  etlState.steps.forEach((step, idx) => {
    const op = ETL_TRANSFORM.getOperator(step.op);
    const card = document.createElement('div');
    card.className = `etl-step-card${step.enabled===false?' disabled':''}`;
    card.draggable = true;
    card.dataset.idx = idx;

    // Build simple param controls for primitive types
    const paramHtml = (op?.params || []).filter(p => ['string','number','boolean','range'].includes(p.type)).map(p => {
      const val = step.config[p.id] ?? p.default ?? '';
      if (p.type === 'boolean') {
        return `<span class="etl-step-param"><input type="checkbox" data-param="${p.id}" ${val?'checked':''}><label>${p.label}</label></span>`;
      }
      if (p.type === 'range') {
        return `<span class="etl-step-param"><label>${p.label}:</label><input type="range" min="${p.min}" max="${p.max}" step="${p.step||0.1}" value="${val}" data-param="${p.id}" style="width:70px"><span data-rangeval="${p.id}">${val}</span></span>`;
      }
      if (p.type === 'select') {
        return `<span class="etl-step-param"><label>${p.label}:</label><select data-param="${p.id}">${(p.options||[]).map(o=>`<option value="${o}" ${o===val?'selected':''}>${o}</option>`).join('')}</select></span>`;
      }
      return `<span class="etl-step-param"><label>${p.label}:</label><input type="text" data-param="${p.id}" value="${val}" placeholder="${p.default||''}"></span>`;
    }).join('');

    card.innerHTML = `
      <span class="etl-step-num">${idx + 1}</span>
      <span class="etl-step-icon">${op?.icon || '⚙️'}</span>
      <div class="etl-step-body">
        <div class="etl-step-name">${op?.label || step.op}</div>
        <div class="etl-step-desc">${op?.desc || ''}</div>
        ${paramHtml ? `<div class="etl-step-cfg">${paramHtml}</div>` : ''}
      </div>
      <div class="etl-step-actions">
        <button class="etl-step-toggle" title="Toggle">${step.enabled===false?'⏸':'▶'}</button>
        <button class="etl-step-del" title="Remove">✕</button>
      </div>
    `;

    // Param bindings
    card.querySelectorAll('[data-param]').forEach(el => {
      el.addEventListener('change', () => {
        const pid = el.dataset.param;
        step.config[pid] = el.type === 'checkbox' ? el.checked
          : el.type === 'range' ? parseFloat(el.value)
          : el.value;
        const rv = card.querySelector(`[data-rangeval="${pid}"]`);
        if (rv) rv.textContent = el.value;
      });
    });
    card.querySelector('.etl-step-del').addEventListener('click', () => { etlState.steps.splice(idx,1); renderStepsList(); });
    card.querySelector('.etl-step-toggle').addEventListener('click', () => {
      step.enabled = step.enabled === false ? true : false; renderStepsList();
    });

    // Drag reorder
    card.addEventListener('dragstart', e => {
      etlState.draggingIdx = idx;
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend',   () => card.classList.remove('dragging'));
    card.addEventListener('dragover',  e => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop',      e => {
      e.preventDefault(); card.classList.remove('drag-over');
      const from = etlState.draggingIdx, to = idx;
      if (from != null && from !== to) {
        const [s] = etlState.steps.splice(from, 1);
        etlState.steps.splice(to, 0, s);
        renderStepsList();
      }
    });

    list.appendChild(card);
  });
}

// ── Job execution ─────────────────────────────────────────
async function runJob(preview = false) {
  if (!etlState.extractResult && etlState.sourceType !== 'current') {
    showToast('Load a data source first', 2500); return;
  }
  document.getElementById('etl-history-panel').style.display = 'none';

  // Build field_map step from column mapping (insert at front if any mapping exists)
  const fieldMapCfg = {};
  (etlState.mapping || []).forEach(m => { if (m.source && m.target) fieldMapCfg[m.source] = m.target; });

  const steps = [];
  if (Object.keys(fieldMapCfg).length) {
    steps.push({ op:'field_map', config:{ mapping: fieldMapCfg, keep_extra: true } });
  }
  steps.push(...etlState.steps.filter(s => s.enabled !== false));

  const jobDef = {
    name: etlState.extractResult?.fileName || `${etlState.sourceType} job`,
    preview,
    source: _buildSourceDef(),
    steps,
    targets: preview ? [] : [...etlState.targets].map(t => ({ type: t, config: {} })),
  };

  // Update progress panel
  document.getElementById('etl-progress-inner').innerHTML = '<div class="etl-progress-idle">Running…</div>';
  document.getElementById('etl-stats-row').innerHTML = '';

  try {
    const result = await ETL_ENGINE[preview ? 'preview' : 'run'](jobDef);
    etlState.previewRows = result.rows;
    document.getElementById('etl-preview-panel').style.display = '';
    renderPreviewTable(result.rows.slice(0, 80));
    renderStatsCards(result.entry);
    renderHistory();
  } catch (e) {
    showToast(`Job failed: ${e.message}`, 5000);
  }
}

function _buildSourceDef() {
  const { sourceType } = etlState;
  if (sourceType === 'csv_file' || sourceType === 'json_file') {
    // Raw rows already extracted — pass them directly
    return { type: 'raw', rows: etlState.currentRows || [] };
  }
  if (sourceType === 'current') return { type:'current' };
  if (sourceType === 'iot')     return { type:'iot', city: state.city, hours: parseInt(document.getElementById('etl-iot-hours')?.value||24) };
  if (sourceType === 'cpcb')    return { type:'cpcb', city: state.city, year: document.getElementById('etl-cpcb-year')?.value || null };
  if (sourceType === 'sqlite')  return { type:'sqlite', sql: document.getElementById('etl-sqlite-sql')?.value };
  return { type: sourceType };
}

// ── Progress rendering ────────────────────────────────────
function renderProgress(evt) {
  const inner = document.getElementById('etl-progress-inner');
  if (!inner) return;

  if (evt.type === 'start') {
    inner.innerHTML = `<div class="etl-progress-item">
      <span class="etl-prog-icon">⏳</span>
      <span class="etl-prog-label">Extracting source data…</span>
    </div>`;
  } else if (evt.type === 'extract_done') {
    inner.innerHTML = `<div class="etl-progress-item">
      <span class="etl-prog-icon">✅</span>
      <span class="etl-prog-label">Extracted</span>
      <span class="etl-prog-rows">${evt.rowCount?.toLocaleString()} rows</span>
    </div>`;
  } else if (evt.type === 'step_start') {
    const item = document.createElement('div'); item.className = 'etl-progress-item'; item.id = `eprog-${evt.step}`;
    item.innerHTML = `<span class="etl-prog-icon">⏳</span>
      <span class="etl-prog-label">Step ${evt.label}</span>
      <div class="etl-prog-bar-wrap" style="width:100%"><div class="etl-prog-bar" style="width:0%"></div></div>`;
    inner.appendChild(item);
  } else if (evt.type === 'step_progress') {
    const bar = document.querySelector(`#eprog-${evt.step} .etl-prog-bar`);
    if (bar) bar.style.width = Math.round(evt.pct * 100) + '%';
  } else if (evt.type === 'step_done') {
    const item = document.getElementById(`eprog-${evt.step}`);
    if (item) item.innerHTML = `<span class="etl-prog-icon">✅</span>
      <span class="etl-prog-label">Step ${evt.op}</span>
      <span class="etl-prog-rows">${evt.rowsOut?.toLocaleString()} rows · ${evt.duration}ms</span>`;
  } else if (evt.type === 'step_error') {
    const item = document.getElementById(`eprog-${evt.step}`);
    if (item) item.innerHTML = `<span class="etl-prog-icon">⚠️</span>
      <span class="etl-prog-label">Step ${evt.op} — <span style="color:var(--aqi-unhealthy)">${evt.error}</span></span>`;
  } else if (evt.type === 'load_done') {
    const item = document.createElement('div'); item.className = 'etl-progress-item';
    item.innerHTML = `<span class="etl-prog-icon">💾</span>
      <span class="etl-prog-label">Loaded → ${evt.target}</span>
      <span class="etl-prog-rows">${evt.result?.rowsWritten?.toLocaleString() || ''} written</span>`;
    inner.appendChild(item);
  } else if (evt.type === 'done') {
    const item = document.createElement('div'); item.className = 'etl-progress-item';
    item.style.cssText = 'color:var(--aqi-good);font-weight:700;margin-top:8px';
    item.innerHTML = `<span class="etl-prog-icon">🎉</span>
      <span class="etl-prog-label">Done — ${evt.rowsOut?.toLocaleString()} rows in ${evt.duration}ms</span>`;
    inner.appendChild(item);
  } else if (evt.type === 'error') {
    const item = document.createElement('div'); item.className = 'etl-progress-item';
    item.style.color = 'var(--aqi-unhealthy)';
    item.innerHTML = `<span class="etl-prog-icon">✕</span><span>Error: ${evt.error}</span>`;
    inner.appendChild(item);
  }
}

// ── Preview table ─────────────────────────────────────────
function renderPreviewTable(rows) {
  const wrap = document.getElementById('etl-preview-wrap');
  const badge = document.getElementById('etl-preview-badge');
  if (!wrap || !rows?.length) return;
  badge.textContent = `${rows.length} rows`;

  const headers = Object.keys(rows[0]);
  const tbl = document.createElement('table'); tbl.className = 'etl-preview-tbl';
  tbl.innerHTML = `<thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr');
    headers.forEach(h => {
      const td = document.createElement('td');
      const v  = r[h];
      if (v == null)              { td.textContent = 'null'; td.className = 'etl-cell-null'; }
      else if (typeof v === 'number' || (!isNaN(parseFloat(v)) && String(v).length < 15)) {
        td.textContent = v; td.className = 'etl-cell-num';
      } else if (String(v).match(/^\d{4}-\d{2}-\d{2}/)) {
        td.textContent = v; td.className = 'etl-cell-ts';
      } else { td.textContent = String(v); td.className = 'etl-cell-str'; }
      td.title = String(v ?? '');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.innerHTML = ''; wrap.appendChild(tbl);
}

// ── Stats cards ───────────────────────────────────────────
function renderStatsCards(entry) {
  if (!entry) return;
  const row = document.getElementById('etl-stats-row');
  row.innerHTML = `
    <div class="etl-stat-card">
      <div class="etl-stat-val" style="color:var(--accent)">${(entry.rowsIn||0).toLocaleString()}</div>
      <div class="etl-stat-lbl">Rows In</div>
    </div>
    <div class="etl-stat-card">
      <div class="etl-stat-val" style="color:var(--aqi-good)">${(entry.rowsOut||0).toLocaleString()}</div>
      <div class="etl-stat-lbl">Rows Out</div>
    </div>
    <div class="etl-stat-card">
      <div class="etl-stat-val" style="color:var(--aqi-moderate)">${entry.duration||0}ms</div>
      <div class="etl-stat-lbl">Duration</div>
    </div>
  `;
}

// ── History ───────────────────────────────────────────────
function toggleHistory() {
  const panel = document.getElementById('etl-history-panel');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
  if (panel.style.display !== 'none') renderHistory();
}
function renderHistory() {
  const list = document.getElementById('etl-history-list');
  if (!list) return;
  const history = ETL_ENGINE.getHistory();
  if (!history.length) { list.innerHTML = '<div style="font-size:.72rem;color:var(--text-muted);padding:12px">No jobs yet</div>'; return; }
  list.innerHTML = '';
  history.forEach(j => {
    const d = document.createElement('div'); d.className = 'etl-history-item';
    const stepSummary = (j.steps||[]).map(s => s.op).join(' → ');
    d.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px">
        <span class="etl-hist-name">${j.name}</span>
        <span class="etl-hist-status ${j.status}">${j.status}</span>
        ${j.status==='completed'?`<span style="margin-left:auto;font-size:.65rem;color:var(--text-muted)">${j.duration}ms</span>`:''}
      </div>
      <div class="etl-hist-meta">${j.startedAt?.slice(0,19).replace('T',' ')} · ${(j.rowsIn||0).toLocaleString()}→${(j.rowsOut||0).toLocaleString()} rows · ${j.steps?.length||0} steps</div>
      ${stepSummary ? `<div style="font-size:.62rem;color:var(--text-muted);margin-top:2px;font-family:monospace">${stepSummary}</div>` : ''}
    `;
    list.appendChild(d);
  });
}

// ── Templates ─────────────────────────────────────────────
function loadTemplate(id) {
  const tmpl = ETL_ENGINE.getTemplate(id);
  if (!tmpl) return;
  etlState.steps = (tmpl.steps || []).map(s => ({ ...s, enabled: true }));
  // Set source
  etlState.sourceType = tmpl.source?.type || 'current';
  document.querySelectorAll('.etl-src-btn[data-src]').forEach(b => {
    b.classList.toggle('active', b.dataset.src === etlState.sourceType);
  });
  renderSourceConfig();
  renderStepsList();
  // Set targets
  etlState.targets.clear();
  (tmpl.targets || []).forEach(t => etlState.targets.add(t.type));
  document.querySelectorAll('.etl-src-btn[data-target]').forEach(b => {
    b.classList.toggle('target-on', etlState.targets.has(b.dataset.target));
  });
  showToast(`Loaded template: ${tmpl.name}`, 2500);
}

function resetETL() {
  etlState.steps = []; etlState.extractResult = null; etlState.currentRows = null;
  etlState.mapping = []; etlState.previewRows = null;
  clearFile();
  renderStepsList();
  document.getElementById('etl-progress-inner').innerHTML = '<div class="etl-progress-idle">Job not started</div>';
  document.getElementById('etl-stats-row').innerHTML = '';
  document.getElementById('etl-preview-panel').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// VIEW: DATABASE EXPLORER
// ═══════════════════════════════════════════════════════════

const dbState = { initialized: false, seeded: false, activeTable: null, activeTab: 'schema', queryResults: null };

const EXAMPLE_QUERIES = {
  latest_aqi: `SELECT city, station, aqi_value, aqi_category, dominant_pollutant, timestamp_utc
FROM vw_aqi_summary
LIMIT 20;`,
  who_exceedances: `SELECT city, station, parameter, who_limit, date,
       ROUND(mean_value,2) AS mean_ugm3,
       exceedance_ratio
FROM vw_who_exceedances
ORDER BY exceedance_ratio DESC
LIMIT 30;`,
  naaqs_compliance: `SELECT city, parameter, naaqs_limit,
       annual_mean, pct_of_naaqs,
       total_exceedance_days
FROM vw_naaqs_compliance
ORDER BY pct_of_naaqs DESC;`,
  monthly_trend: `SELECT ma.year, ma.month,
       ROUND(ma.mean_value, 1) AS pm25_mean,
       ma.days_exceeding_who, ma.days_exceeding_naaqs
FROM monthly_aggregates ma
JOIN stations s   ON ma.station_id   = s.station_id
JOIN regions  r   ON s.region_id     = r.region_id
JOIN parameters p ON ma.parameter_id = p.parameter_id
WHERE lower(r.name) = 'delhi' AND p.code = 'pm25'
ORDER BY ma.year, ma.month;`,
  completeness: `SELECT city, station, parameter,
       total_records, valid_count, imputed_count, outlier_count,
       completeness_pct
FROM vw_data_completeness
ORDER BY completeness_pct;`,
  open_alerts: `SELECT city, station, parameter,
       alert_type, severity, threshold_value, observed_value,
       message, timestamp_utc
FROM vw_open_alerts
LIMIT 50;`,
  sensor_health: `SELECT city, station, parameter,
       model, measurement_tech,
       last_calibration, next_calibration, calibration_status, is_active
FROM vw_sensor_health
ORDER BY calibration_status DESC;`,
  pipeline_runs: `SELECT run_id, city, started_at, duration_ms,
       total_records, issues_found, issues_fixed,
       fix_rate_pct, quality_before, quality_after, quality_gain, status
FROM vw_pipeline_summary
LIMIT 20;`,
  top_stations: `SELECT r.name AS city, s.name AS station, s.zone_type,
       ROUND(AVG(a.aqi_value)) AS avg_aqi, MAX(a.aqi_value) AS max_aqi,
       COUNT(*) AS readings
FROM aqi_readings a
JOIN stations s ON a.station_id = s.station_id
JOIN regions  r ON s.region_id  = r.region_id
GROUP BY a.station_id
ORDER BY avg_aqi DESC
LIMIT 10;`,
  hourly_pattern: `SELECT
  CAST(strftime('%H', m.timestamp_utc) AS INTEGER) AS hour_of_day,
  ROUND(AVG(m.value), 1) AS avg_pm25,
  ROUND(MIN(m.value), 1) AS min_pm25,
  ROUND(MAX(m.value), 1) AS max_pm25,
  COUNT(*) AS readings
FROM measurements m
JOIN parameters p ON m.parameter_id = p.parameter_id
WHERE p.code = 'pm25'
  AND m.quality_flag = 'VALID'
GROUP BY hour_of_day
ORDER BY hour_of_day;`,
};

async function renderDatabase() {
  const view = document.getElementById('view-database');
  if (!view) return;

  // Bind tabs (once)
  if (!view._tabsBound) {
    view._tabsBound = true;
    view.querySelectorAll('.db-tab').forEach(btn => {
      btn.addEventListener('click', () => switchDBTab(btn.dataset.dbtab));
    });
    document.getElementById('btn-db-seed')?.addEventListener('click', seedDatabase);
    document.getElementById('btn-db-run-query')?.addEventListener('click', runDBQuery);
    document.getElementById('btn-db-clear-query')?.addEventListener('click', () => {
      document.getElementById('db-sql-input').value = '';
      document.getElementById('query-timing').textContent = '';
      document.getElementById('db-query-results-wrap').innerHTML = '<div class="db-results-placeholder">Run a query to see results</div>';
    });
    document.getElementById('btn-db-export-results')?.addEventListener('click', exportQueryResults);
    document.getElementById('btn-db-download-sql')?.addEventListener('click', () => AQI_DB.isReady() && AQI_DB.downloadSQL());
    document.getElementById('btn-db-download-sqlite')?.addEventListener('click', () => AQI_DB.isReady() && AQI_DB.downloadSQLite());
    document.getElementById('db-example-queries')?.addEventListener('change', e => {
      const sql = EXAMPLE_QUERIES[e.target.value];
      if (sql) document.getElementById('db-sql-input').value = sql;
    });
    document.getElementById('btn-er-reset')?.addEventListener('click', () => renderERDiagram());
  }

  // Init DB if needed
  if (!dbState.initialized) {
    await initDatabase();
  }

  refreshDBStats();
  renderSchemaList();
}

async function initDatabase() {
  setDBIndicator('loading', 'Initializing sql.js…');
  try {
    await AQI_DB.init();
    dbState.initialized = true;
    setDBIndicator('ready', 'Ready (not seeded)');
    document.getElementById('btn-db-seed').textContent = '⚡ Seed Database';
  } catch (e) {
    setDBIndicator('error', 'Failed: ' + e.message.slice(0, 40));
    console.error('[DB]', e);
  }
}

async function seedDatabase() {
  if (!dbState.initialized) await initDatabase();
  const btn = document.getElementById('btn-db-seed');
  btn.disabled = true;
  btn.textContent = '⏳ Seeding…';
  setDBIndicator('loading', 'Seeding…');

  await new Promise(r => setTimeout(r, 0)); // yield to paint

  const report = window.pipeState?.report || null;
  const result = await DB_SEEDER.seedAll({
    cityId: state.city,
    timeSeriesData: state.data,
    pipelineReport: report,
  });

  dbState.seeded = true;
  btn.disabled = false;
  btn.textContent = '↺ Re-seed';
  setDBIndicator('ready', `Seeded (${result.ms} ms)`);

  refreshDBStats();
  renderSchemaList();
  if (dbState.activeTab === 'er') renderERDiagram();
  if (dbState.activeTab === 'stats') renderDBStats();
  showToast(result.log.filter(l => l.startsWith('✓')).length + ' tables populated', 3000);
}

function setDBIndicator(state, label) {
  const dot  = document.querySelector('#db-init-indicator .db-dot');
  const lbl  = document.getElementById('db-init-label');
  if (dot)  { dot.className = `db-dot ${state}`; }
  if (lbl)  { lbl.textContent = label; }
}

function refreshDBStats() {
  if (!AQI_DB.isReady()) return;
  const tables = AQI_DB.listTables();
  const views  = AQI_DB.listViews();
  const counts = AQI_DB.allRowCounts();
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const sizeBytes = AQI_DB.dbSize();
  const sizeLabel = sizeBytes > 1024*1024
    ? (sizeBytes/(1024*1024)).toFixed(1) + ' MB'
    : (sizeBytes/1024).toFixed(0) + ' KB';

  document.getElementById('dbstat-tables').textContent = tables.length;
  document.getElementById('dbstat-views').textContent  = views.length;
  document.getElementById('dbstat-rows').textContent   = totalRows.toLocaleString();
  document.getElementById('dbstat-size').textContent   = sizeLabel;
}

// ── Schema browser ────────────────────────────────────────
function switchDBTab(tab) {
  dbState.activeTab = tab;
  document.querySelectorAll('.db-tab').forEach(b => b.classList.toggle('active', b.dataset.dbtab === tab));
  document.querySelectorAll('.db-tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `dbpanel-${tab}`));
  if (tab === 'er')    renderERDiagram();
  if (tab === 'stats') renderDBStats();
}

function renderSchemaList() {
  if (!AQI_DB.isReady()) return;
  const { SCHEMA_META } = window.DB_SCHEMA;
  const tables = AQI_DB.listTables();
  const views  = AQI_DB.listViews();
  const counts = AQI_DB.allRowCounts();
  const LAYER_COLORS = {
    Geography: '#22c55e', Infrastructure: '#3b82f6', Reference: '#a855f7',
    'Time-Series': '#f97316', Aggregates: '#eab308', Derived: '#ef4444', Operations: '#94a3b8',
  };

  const tableList = document.getElementById('db-table-list-items');
  const viewList  = document.getElementById('db-view-list-items');
  if (!tableList || !viewList) return;

  tableList.innerHTML = '';
  tables.forEach(t => {
    const meta  = SCHEMA_META[t] || {};
    const color = LAYER_COLORS[meta.layer] || '#8b9dc3';
    const btn   = document.createElement('button');
    btn.className = 'db-table-btn' + (dbState.activeTable === t ? ' active' : '');
    btn.innerHTML = `
      <span class="db-table-layer-dot" style="background:${color}"></span>
      ${t}
      <span class="db-table-badge">${(counts[t] || 0).toLocaleString()}</span>
    `;
    btn.addEventListener('click', () => { dbState.activeTable = t; showTableDetail(t); renderSchemaList(); });
    tableList.appendChild(btn);
  });

  viewList.innerHTML = '';
  views.forEach(v => {
    const btn = document.createElement('button');
    btn.className = 'db-table-btn';
    btn.innerHTML = `<span class="db-table-layer-dot" style="background:#60a5fa;border:1px solid #3b82f6"></span>${v}`;
    btn.style.fontStyle = 'italic';
    btn.addEventListener('click', () => {
      document.getElementById('db-sql-input').value = `SELECT * FROM ${v} LIMIT 20;`;
      switchDBTab('query');
    });
    viewList.appendChild(btn);
  });

  if (dbState.activeTable) showTableDetail(dbState.activeTable);
}

function showTableDetail(tableName) {
  const { SCHEMA_META, SCHEMA_RELATIONSHIPS } = window.DB_SCHEMA;
  const detail = document.getElementById('db-column-detail');
  if (!detail) return;
  const meta = SCHEMA_META[tableName];
  if (!meta) { detail.innerHTML = '<div class="db-detail-placeholder">No metadata for this table</div>'; return; }

  const LAYER_COLORS = {
    Geography: '#22c55e', Infrastructure: '#3b82f6', Reference: '#a855f7',
    'Time-Series': '#f97316', Aggregates: '#eab308', Derived: '#ef4444', Operations: '#94a3b8',
  };
  const color = LAYER_COLORS[meta.layer] || '#8b9dc3';

  const fksOut = SCHEMA_RELATIONSHIPS.filter(r => r.from === tableName);
  const fksIn  = SCHEMA_RELATIONSHIPS.filter(r => r.to   === tableName);

  detail.innerHTML = `
    <div class="db-detail-header">
      <span class="db-detail-title">${tableName}</span>
      <span class="db-detail-layer" style="color:${color};border-color:${color}20">${meta.layer}</span>
      <span style="margin-left:auto;font-size:0.70rem;color:var(--text-muted)">${meta.pk} PK · ${meta.columns.length} columns</span>
    </div>
    <div class="db-detail-desc">${meta.desc}</div>

    <table class="db-col-table">
      <thead><tr>
        <th>Column</th><th>Type</th><th>Key</th><th>Null</th><th>Notes</th>
      </tr></thead>
      <tbody>
        ${meta.columns.map(c => `
          <tr>
            <td class="col-name">${c.name}</td>
            <td class="col-type">${c.type}</td>
            <td>
              ${c.pk ? '<span class="col-pk">PK</span>' : ''}
              ${c.fk ? `<span class="col-fk">FK→${c.fk}</span>` : ''}
            </td>
            <td class="col-nn">${c.nullable ? 'NULL' : 'NOT NULL'}</td>
            <td class="col-note">${c.note || ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    ${fksOut.length ? `
      <div class="db-fk-section">
        <h4>References (FK out)</h4>
        ${fksOut.map(r => `<div class="db-fk-item">→ ${r.to}.${r.toCol} &nbsp;·&nbsp; ${r.card}</div>`).join('')}
      </div>` : ''}

    ${fksIn.length ? `
      <div class="db-fk-section">
        <h4>Referenced by</h4>
        ${fksIn.map(r => `<div class="db-fk-item">← ${r.from}.${r.fromCol} &nbsp;·&nbsp; ${r.card}</div>`).join('')}
      </div>` : ''}

    ${meta.indexes?.length ? `
      <div class="db-fk-section">
        <h4>Indexes</h4>
        ${meta.indexes.map(i => `<div class="db-index-item">${i}</div>`).join('')}
      </div>` : ''}
  `;
}

// ── SQL Console ───────────────────────────────────────────
function runDBQuery() {
  if (!AQI_DB.isReady()) { showToast('Database not initialized — click Seed Database first', 3000); return; }
  const sql  = document.getElementById('db-sql-input')?.value?.trim();
  if (!sql) return;

  const wrap  = document.getElementById('db-query-results-wrap');
  const timer = document.getElementById('query-timing');
  wrap.innerHTML = '';

  try {
    const result = AQI_DB.query(sql);
    dbState.queryResults = result;
    timer.textContent = `${result.rowCount} row${result.rowCount !== 1 ? 's' : ''} · ${result.ms} ms`;

    if (!result.columns.length) {
      wrap.innerHTML = '<div class="db-results-placeholder">Query returned no rows</div>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'db-results-table';
    table.innerHTML = `<thead><tr>${result.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
    const tbody = document.createElement('tbody');
    result.rows.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach(cell => {
        const td = document.createElement('td');
        if (cell === null || cell === undefined) { td.textContent = 'NULL'; td.classList.add('null-cell'); }
        else td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  } catch (e) {
    timer.textContent = '';
    wrap.innerHTML = `<div class="db-error-box">✕ ${e.message}</div>`;
    dbState.queryResults = null;
  }
}

function exportQueryResults() {
  const r = dbState.queryResults;
  if (!r?.columns?.length) return;
  const lines = [r.columns.join(',')];
  r.rows.forEach(row => lines.push(row.map(v => v === null ? '' : `"${String(v).replace(/"/g,'""')}"`).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a    = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'query-results.csv'; a.click();
}

// ── Table Stats tab ───────────────────────────────────────
function renderDBStats() {
  if (!AQI_DB.isReady()) return;
  const { SCHEMA_META } = window.DB_SCHEMA;
  const counts = AQI_DB.allRowCounts();
  const LAYER_COLORS = {
    Geography:'#22c55e', Infrastructure:'#3b82f6', Reference:'#a855f7',
    'Time-Series':'#f97316', Aggregates:'#eab308', Derived:'#ef4444', Operations:'#94a3b8',
  };

  const grid = document.getElementById('db-stats-grid');
  if (!grid) return;
  grid.innerHTML = '';

  Object.entries(counts).forEach(([t, c]) => {
    const meta  = SCHEMA_META[t] || {};
    const color = LAYER_COLORS[meta.layer] || '#8b9dc3';
    const card  = document.createElement('div');
    card.className = 'db-stats-card';
    card.style.borderLeftColor = color;
    card.innerHTML = `
      <div class="dsc-name">${t}</div>
      <div class="dsc-count">${c.toLocaleString()}</div>
      <div class="dsc-layer">${meta.layer || 'table'}</div>
    `;
    grid.appendChild(card);
  });

  // Bar chart
  destroyChart('dbRowDist');
  const ctx = document.getElementById('chart-db-row-dist')?.getContext('2d');
  if (!ctx) return;
  const tables = Object.keys(counts);
  const vals   = Object.values(counts);
  const colors = tables.map(t => LAYER_COLORS[(SCHEMA_META[t]||{}).layer] || '#8b9dc3');

  state.charts.dbRowDist = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: tables,
      datasets: [{ data: vals, backgroundColor: colors.map(c => c+'bb'), borderColor: colors, borderWidth: 1.5, borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'monospace', size: 10 }, maxRotation: 45 } },
        y: { grid: { color: gridColor() }, ticks: { stepSize: 1 } },
      },
    },
  });
}

// ── ER Diagram (SVG) ──────────────────────────────────────
function renderERDiagram() {
  const svg  = document.getElementById('db-er-svg');
  if (!svg) return;
  svg.innerHTML = '';

  const { SCHEMA_META, SCHEMA_RELATIONSHIPS } = window.DB_SCHEMA;
  const counts = AQI_DB.isReady() ? AQI_DB.allRowCounts() : {};
  const LAYER_COLORS = {
    Geography:'#22c55e', Infrastructure:'#3b82f6', Reference:'#a855f7',
    'Time-Series':'#f97316', Aggregates:'#eab308', Derived:'#ef4444', Operations:'#94a3b8',
  };

  // Table positions
  const POSITIONS = {
    regions:              [30,  30],
    stations:             [310, 30],
    sensors:              [590, 30],
    calibration_records:  [870, 30],
    parameters:           [870, 270],
    data_sources:         [870, 490],
    measurements:         [30,  310],
    hourly_aggregates:    [30,  560],
    daily_aggregates:     [310, 560],
    monthly_aggregates:   [590, 560],
    aqi_readings:         [30,  740],
    pipeline_runs:        [310, 310],
    quality_log:          [590, 310],
    alerts:               [590, 490],
  };
  const BOX_W = 210, HDR_H = 32, ROW_H = 20, PAD = 8;

  // Helper to get box center
  function center(name) {
    const p = POSITIONS[name];
    if (!p) return [640, 440];
    const meta = SCHEMA_META[name];
    const h    = HDR_H + (meta?.columns?.length || 0) * ROW_H + PAD * 2;
    return [p[0] + BOX_W / 2, p[1] + h / 2];
  }
  function boxBottom(name) {
    const p = POSITIONS[name]; if (!p) return 440;
    const meta = SCHEMA_META[name];
    return p[1] + HDR_H + (meta?.columns?.length || 0) * ROW_H + PAD * 2;
  }
  function boxRight(name) { return (POSITIONS[name]?.[0] ?? 0) + BOX_W; }

  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, txt) {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, v));
    if (txt != null) e.textContent = txt;
    return e;
  }

  // Defs (arrowhead marker)
  const defs  = el('defs', {});
  const arrow = el('marker', { id:'er-arrow', markerWidth:'8', markerHeight:'6',
    refX:'8', refY:'3', orient:'auto' });
  arrow.appendChild(el('polygon', { points:'0 0, 8 3, 0 6', fill:'#475569' }));
  defs.appendChild(arrow);
  svg.appendChild(defs);

  // Background
  svg.appendChild(el('rect', { x:0,y:0,width:'100%',height:'100%', fill:'var(--bg-base)' }));

  // Layer labels (faint text)
  const layerLabels = { Geography:[170,10], Infrastructure:[500,10], Reference:[990,10],
    'Time-Series':[125,500], Aggregates:[400,548], Derived:[120,730], Operations:[420,480] };
  Object.entries(layerLabels).forEach(([layer, [x,y]]) => {
    const c = LAYER_COLORS[layer] || '#8b9dc3';
    svg.appendChild(el('text',
      { x, y, fill: c, 'font-size':'9', 'font-weight':'700', 'letter-spacing':'2',
        'text-anchor':'middle', opacity:'0.4', 'font-family':'sans-serif', 'text-transform':'uppercase' },
      layer.toUpperCase()
    ));
  });

  // Draw FK lines first (behind boxes)
  const lineGroup = el('g', { id:'er-lines' });
  SCHEMA_RELATIONSHIPS.forEach(rel => {
    const [fx, fy] = POSITIONS[rel.from] || [];
    const [tx, ty] = POSITIONS[rel.to]   || [];
    if (!fx || !tx) return;
    const [cx1, cy1] = center(rel.from);
    const [cx2, cy2] = center(rel.to);
    // Simple bezier
    const mx = (cx1 + cx2) / 2;
    const path = el('path', {
      d: `M${cx1},${cy1} C${mx},${cy1} ${mx},${cy2} ${cx2},${cy2}`,
      fill: 'none',
      stroke: '#334155',
      'stroke-width': '1.5',
      'marker-end': 'url(#er-arrow)',
      class: 'er-fk-line',
      'data-from': rel.from,
      'data-to': rel.to,
    });
    lineGroup.appendChild(path);
  });
  svg.appendChild(lineGroup);

  // Draw table boxes
  const boxGroup = el('g', { id:'er-boxes' });
  Object.entries(POSITIONS).forEach(([name, [x, y]]) => {
    const meta  = SCHEMA_META[name];
    if (!meta) return;
    const color = LAYER_COLORS[meta.layer] || '#8b9dc3';
    const cols  = meta.columns || [];
    const boxH  = HDR_H + cols.length * ROW_H + PAD * 2;
    const rowCount = counts[name] ?? '—';

    const g = el('g', { class:'er-table-box', 'data-table':name });

    // Shadow
    g.appendChild(el('rect', { x:x+3, y:y+3, width:BOX_W, height:boxH, rx:6, fill:'rgba(0,0,0,0.4)' }));
    // Box background
    g.appendChild(el('rect', { x, y, width:BOX_W, height:boxH, rx:6, fill:'#1e293b', stroke:'#334155', 'stroke-width':'1' }));
    // Header
    g.appendChild(el('rect', { x, y, width:BOX_W, height:HDR_H, rx:6, fill:color+'30' }));
    g.appendChild(el('rect', { x, y:y+HDR_H-4, width:BOX_W, height:4, fill:color+'30' }));
    // Header text
    g.appendChild(el('text', {
      x: x+10, y: y+20, fill: color,
      'font-size':'11', 'font-weight':'700', 'font-family':'monospace',
    }, name));
    // Row count badge
    g.appendChild(el('text', {
      x: x+BOX_W-8, y: y+20, fill: '#64748b',
      'font-size':'9', 'font-family':'sans-serif', 'text-anchor':'end',
    }, String(rowCount).toLocaleString() + ' rows'));

    // Columns
    cols.forEach((c, i) => {
      const cy = y + HDR_H + PAD + i * ROW_H + 14;
      // PK/FK icon
      if (c.pk) g.appendChild(el('text', { x:x+8, y:cy, fill:'#eab308', 'font-size':'8', 'font-weight':'700', 'font-family':'sans-serif' }, 'PK'));
      else if (c.fk) g.appendChild(el('text', { x:x+8, y:cy, fill:'#3b82f6', 'font-size':'8', 'font-weight':'700', 'font-family':'sans-serif' }, 'FK'));

      // Column name
      g.appendChild(el('text', { x:x+26, y:cy, fill: c.pk ? '#f1f5f9' : '#94a3b8', 'font-size':'9.5', 'font-family':'monospace' }, c.name));
      // Type
      g.appendChild(el('text', { x:x+BOX_W-8, y:cy, fill:'#7c3aed', 'font-size':'9', 'font-family':'monospace', 'text-anchor':'end' }, c.type));
      // Separator
      if (i < cols.length - 1) {
        g.appendChild(el('line', { x1:x+1, y1:cy+6, x2:x+BOX_W-1, y2:cy+6, stroke:'#1e3a5f', 'stroke-width':'0.5' }));
      }
    });

    // Click highlight
    g.addEventListener('click', () => highlightTable(name));
    boxGroup.appendChild(g);
  });
  svg.appendChild(boxGroup);

  // Update SVG canvas size to fit content
  const maxX = Math.max(...Object.values(POSITIONS).map(([x]) => x)) + BOX_W + 20;
  const maxY = Math.max(...Object.entries(POSITIONS).map(([name, [,y]]) => boxBottom(name))) + 20;
  svg.setAttribute('width', Math.max(1280, maxX));
  svg.setAttribute('height', Math.max(880, maxY));
}

function highlightTable(name) {
  const { SCHEMA_RELATIONSHIPS } = window.DB_SCHEMA;
  const related = new Set([name]);
  SCHEMA_RELATIONSHIPS.forEach(r => { if (r.from===name) related.add(r.to); if (r.to===name) related.add(r.from); });

  document.querySelectorAll('.er-table-box').forEach(g => {
    g.classList.toggle('dim', !related.has(g.dataset.table));
  });
  document.querySelectorAll('.er-fk-line').forEach(p => {
    p.classList.toggle('dim', !(p.dataset.from===name || p.dataset.to===name));
  });
}

// ═══════════════════════════════════════════════════════════
// LIVE DATA INTEGRATION
// ═══════════════════════════════════════════════════════════

// Extend navigateTo to handle new views
const _origNavigateTo = navigateTo;
window.navigateTo = function(view) {
  _origNavigateTo(view);
  if (view === 'pipeline')    renderPipeline();
  if (view === 'database')    renderDatabase();
  if (view === 'etl')         renderETL();
  if (view === 'kpis')        renderKPIs();
  if (view === 'analytics')   Analytics?.init();
  if (view === 'sensors')     renderSensorNetwork();
  if (view === 'datasources') renderDataSources();
  // Init filter bar on every navigation (idempotent)
  Filters?.init();
  Filters?.sync();
};

// Re-render the currently active view when filters change
function _rerenderCurrentView() {
  const v = state.view || 'overview';
  try {
    switch (v) {
      case 'overview':
        renderOverview();
        break;
      case 'trends':
        // Destroy existing trend charts so they re-render with filtered data
        ['aqiTrend','pm25Trend','pollutantTrend'].forEach(k => {
          if (state.charts[k]) { state.charts[k].destroy(); delete state.charts[k]; }
        });
        renderTrends();
        break;
      case 'comparison':
        renderComparison();
        break;
      case 'heatmap':
        renderHeatmap();
        break;
      case 'health':
        renderHealth();
        break;
      case 'kpis':
        renderKPIs();
        break;
      case 'analytics':
        // Clear render cache so tabs re-render with filtered data
        if (window.Analytics?._clearCache) Analytics._clearCache();
        Analytics?.init();
        break;
    }
  } catch(e) {
    console.warn('Filter re-render error:', e);
  }
}

// Attempt live fetch after first render; silently update badge
async function tryLiveFetch() {
  if (!window.Fetcher) return;
  updateSourceBadge('fetching', 'Fetching…');

  // Real-time AQI from WAQI (aqicn.org), read directly in the browser — WAQI
  // sends CORS headers, so no backend is needed. Requires a free token in
  // localStorage.waqi_token (see js/fetcher.js). Any failure (no token, network,
  // station offline) leaves the synthetic data in place.
  let liveAQI = null;
  try {
    liveAQI = await Fetcher.fetchLiveAQI(state.city);
  } catch {
    liveAQI = null;
  }

  if (!liveAQI || liveAQI.aqi == null) {
    // Only downgrade the badge if we don't have a still-fresh snapshot to fall back on.
    if (!_applyLiveSnapshot()) updateSourceBadge('synth', 'Synthetic');
    return;
  }

  // Cache the snapshot, then patch the series through the shared applier so the
  // value survives the next 60 s synthetic refresh.
  state.liveByCity[state.city] = { ...liveAQI, ts: Date.now() };
  _applyLiveSnapshot();
  showToast(`Live WAQI AQI ${liveAQI.aqi} (${liveAQI.category}) for ${CITIES[state.city]?.name || state.city}`, 3500);

  // Reflect the live value in whatever view is open.
  if (typeof _rerenderCurrentView === 'function') _rerenderCurrentView();
}

function updateSourceBadge(cls, label) {
  const badge = document.getElementById('source-badge');
  const dot   = document.getElementById('source-dot-topbar');
  const lbl   = document.getElementById('source-label-topbar');
  if (!badge) return;
  badge.className = `source-badge ${cls}`;
  dot.className   = `source-dot ${cls === 'live' ? 'ok' : cls === 'fetching' ? 'fetching' : 'idle'}`;
  lbl.textContent = label;
}

// Wire live fetch into init
const _origInit = window._airwatchInit;
document.addEventListener('DOMContentLoaded', () => {
  // Init global filter bar
  Filters?.init();
  Filters?.subscribe(_rerenderCurrentView);

  // Slight delay to not block first paint
  setTimeout(tryLiveFetch, 2000);
  // Re-fetch live every 5 min
  setInterval(tryLiveFetch, 5 * 60 * 1000);

  // Register CPCB explorer controls
  const paramSel = document.getElementById('cpcb-param-select');
  const yearSel  = document.getElementById('cpcb-year-select');
  if (paramSel) paramSel.addEventListener('change', () => { if (state.view === 'datasources') renderDataSources(); });
  if (yearSel)  yearSel.addEventListener('change',  () => { if (state.view === 'datasources') renderDataSources(); });
}, { once: false });

// ═══════════════════════════════════════════════════════════
// VIEW: SENSOR NETWORK
// ═══════════════════════════════════════════════════════════
function renderSensorNetwork() {
  if (!window.readCityNetwork) return;

  const latest  = state.data[state.data.length - 1] || {};
  const met     = getMetConditions(state.city);
  const network = readCityNetwork(state.city, latest.aqi || 120, latest, met);

  // Summary bar
  const agg = network.aggregates;
  setText('snet-total',   network.networkSize);
  setText('snet-online',  network.onlineCount);
  setText('snet-offline', network.offlineCount);
  setText('snet-quality', network.dataQuality + '%');
  setText('snet-temp',    agg.temperature ? agg.temperature.mean + '°C' : '--°C');
  setText('snet-hum',     agg.humidity    ? agg.humidity.mean    + '%'  : '--%');

  // Node cards
  buildSensorNodeCards(network.nodes, agg);

  // Dispersion chart
  renderSensorDispersionChart(network);

  // Status table
  buildSensorTable(network.nodes);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function buildSensorNodeCards(nodes, agg) {
  const grid = document.getElementById('sensor-nodes-grid');
  if (!grid) return;
  grid.innerHTML = '';

  nodes.forEach(node => {
    const d = node.data;
    const statusDotCls = node.status === 'ONLINE' ? 'online' : node.status === 'DEGRADED' ? 'degraded' : 'offline';
    const battColor = node.battery > 50 ? 'var(--aqi-good)' : node.battery > 20 ? 'var(--aqi-moderate)' : 'var(--aqi-unhealthy)';

    const card = document.createElement('div');
    card.className = `sensor-node-card${node.status === 'OFFLINE' ? ' offline' : ''}`;

    card.innerHTML = `
      <div class="sensor-node-header">
        <div>
          <div class="sensor-node-name">${node.name}</div>
          <div class="sensor-node-zone">${node.zone} · ${node.nodeId}</div>
        </div>
        <div class="sensor-status-dot ${statusDotCls}" title="${node.status}"></div>
      </div>

      ${d ? `
      <div class="sensor-readings-grid">
        <div class="sensor-reading">
          <div class="sensor-reading-label">PM2.5</div>
          <div class="sensor-reading-value" style="color:${aqiColor(d.pm25 * 2.5)}">${d.pm25}</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">PM10</div>
          <div class="sensor-reading-value">${d.pm10}</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">NO₂</div>
          <div class="sensor-reading-value">${d.no2}</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">O₃</div>
          <div class="sensor-reading-value">${d.o3}</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">CO</div>
          <div class="sensor-reading-value">${d.co}</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">SO₂</div>
          <div class="sensor-reading-value">${d.so2}</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">Temp</div>
          <div class="sensor-reading-value">${d.temperature}°</div>
        </div>
        <div class="sensor-reading">
          <div class="sensor-reading-label">Hum</div>
          <div class="sensor-reading-value">${d.humidity}%</div>
        </div>
      </div>
      ` : `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.80rem">⚠ Node Offline — No Data</div>`}

      <div class="sensor-node-footer">
        <div class="sensor-battery">
          <div class="battery-bar">
            <div class="battery-fill" style="width:${node.battery}%;background:${battColor}"></div>
          </div>
          <span>${node.battery.toFixed(0)}%</span>
        </div>
        <span>📶 ${node.signal}%</span>
        <span class="quality-badge quality-${node.quality || 'MISSING'}">${node.quality || 'MISSING'}</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

function aqiColor(approxAQI) { return getAQICategory(Math.max(0, Math.min(500, approxAQI))).color; }

function renderSensorDispersionChart(network) {
  destroyChart('sensorDisp');
  const ctx = document.getElementById('chart-sensor-dispersion')?.getContext('2d');
  if (!ctx) return;

  const cfg    = getRangeConfig('24h');
  const labels = state.data.slice(-24).map(d => formatTimestamp(d.timestamp, 'HH:MM'));

  // Generate per-node PM2.5 series using zone offsets
  const datasets = (network.nodes || [])
    .filter(n => n.data)
    .map(n => {
      const zoneOffset = { Industrial:25, Traffic:12, Commercial:6, Residential:0, Ambient:-6 }[n.zone] || 0;
      return {
        label: n.name,
        data: state.data.slice(-24).map(d => Math.max(0, d.pm25 + zoneOffset + (Math.random() - 0.5) * 4)),
        borderColor: { Industrial:'#ef4444', Traffic:'#f97316', Commercial:'#eab308', Residential:'#3b82f6', Ambient:'#22c55e' }[n.zone] || '#8b9dc3',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.4,
      };
    });

  state.charts.sensorDisp = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10, usePointStyle: true } },
      },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { grid: { color: gridColor() }, min: 0, title: { display: true, text: 'PM2.5 (μg/m³)', color: 'var(--text-secondary)', font: { size: 11 } } },
      },
    },
  });
}

function buildSensorTable(nodes) {
  const tbody = document.getElementById('sensor-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  nodes.forEach(n => {
    const statusColor = n.status === 'ONLINE' ? 'var(--aqi-good)' : n.status === 'DEGRADED' ? 'var(--aqi-moderate)' : 'var(--text-muted)';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-family:monospace;font-size:0.75rem">${n.nodeId}</td>
      <td>${n.name}</td>
      <td><span class="status-badge" style="background:rgba(59,130,246,0.12);color:#3b82f6">${n.zone}</span></td>
      <td style="color:${statusColor};font-weight:700">${n.status}</td>
      <td>${n.battery.toFixed(0)}%</td>
      <td>${n.signal}%</td>
      <td>${n.calibrationDays}d ago</td>
      <td><span class="quality-badge quality-${n.quality || 'MISSING'}">${n.quality || 'MISSING'}</span></td>
      <td style="font-size:0.68rem;color:var(--text-muted)">${(n.sensors || []).join(', ')}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ═══════════════════════════════════════════════════════════
// VIEW: DATA SOURCES
// ═══════════════════════════════════════════════════════════
const PROVENANCE_RECORDS = [
  {
    label: 'CPCB Annual Reports',
    sub: '2019–2023 · India',
    desc: 'Monthly city-mean concentrations for PM2.5, PM10, NO₂, SO₂, O₃, CO derived from Central Pollution Control Board published reports. 6 major metropolitan areas. 6 monitoring stations per city on average.',
  },
  {
    label: 'NCAP Baseline',
    sub: 'National Clean Air Programme',
    desc: '2017 baseline and 2019–2023 monitoring trajectory under NCAP, which targets 20–30% PM reduction by 2024/26 from 2017 levels. Used to compute annual trend lines.',
  },
  {
    label: 'WHO Air Quality DB 2022',
    sub: 'World Health Organization',
    desc: 'WHO 2021 annual guideline values: PM2.5 5 μg/m³, PM10 15 μg/m³, NO₂ 10 μg/m³, SO₂ 40 μg/m³, O₃ 60 μg/m³, CO 4 mg/m³. Used as reference benchmarks throughout the dashboard.',
  },
  {
    label: 'World Air Quality Index (WAQI)',
    sub: 'aqicn.org · global real-time feed',
    desc: 'Real-time AQI from the WAQI project (aqicn.org), aggregating thousands of monitoring stations worldwide (incl. CPCB CAAQMS in India). Read directly in the browser via the WAQI geo feed (GET api.waqi.info/feed/geo:lat;lng), which sends CORS headers — no backend required. Reports the US-EPA AQI, matching this dashboard\'s scale. Requires a free token in localStorage.waqi_token (register at aqicn.org/data-platform/token).',
  },
  {
    label: 'IoT Sensor Network (Simulated)',
    sub: 'Low-cost optical + electrochemical',
    desc: 'Virtual network of 4–5 nodes per city modelling Plantower PMS7003, Honeywell HPMA115, Alphasense OPC-N3 (PM), Alphasense CO-B4/NO₂-B43F/O₃-B4 (gas), and Bosch BME680/TE HTU31 (T/RH). Includes Gaussian noise, humidity correction (hygroscopic growth), calibration drift, and sensor failure simulation.',
  },
  {
    label: 'NAAQS Standards (India)',
    sub: 'Ministry of Environment',
    desc: 'National Ambient Air Quality Standards: PM2.5 40 μg/m³, PM10 60 μg/m³, NO₂ 40 μg/m³, SO₂ 50 μg/m³, O₃ 100 μg/m³ (8h), CO 2 mg/m³ (8h). Annual mean standards unless noted.',
  },
];

function renderDataSources() {
  buildSourceCards();
  renderCPCBHistoricalChart();
  renderNCAPTrendChart();
  renderWHOExceedanceChart();
  buildProvenanceGrid();
}

function buildSourceCards() {
  const grid = document.getElementById('source-cards-grid');
  if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';

  const sources = [
    { key:'waqi', icon:'🌍', name:'World Air Quality Index (WAQI)',  desc:'Real-time AQI from the WAQI project (aqicn.org), read directly in the browser. Needs a free token in localStorage.waqi_token — no backend required.' },
    { key:'cpcb',    icon:'📊', name:'CPCB Dataset',       desc:'Embedded 2019–2023 monthly means from CPCB Annual Reports and NCAP monitoring bulletins.' },
    { key:'iot',     icon:'📡', name:'IoT Sensor Network', desc:'Simulated multi-node low-cost sensor array with noise, drift, and T/RH measurements per city.' },
  ];

  const status = window.Fetcher ? Fetcher.getSourceStatus() : {};

  sources.forEach(s => {
    const st  = status[s.key] || { state: 'idle' };
    const card = document.createElement('div');
    card.className = 'source-card';
    card.innerHTML = `
      <div class="source-card-icon">${s.icon}</div>
      <div class="source-card-name">${s.name}</div>
      <div class="source-card-desc">${s.desc}</div>
      <div class="source-card-status" id="src-status-${s.key}">
        <span class="source-dot ${st.state === 'ok' || st.state === 'ready' ? 'ok' : st.state === 'fetching' ? 'fetching' : st.state === 'error' ? 'error' : 'idle'}"></span>
        <span>${statusLabel(st.state)}</span>
      </div>
      ${st.latencyMs ? `<div class="source-card-latency">⚡ ${st.latencyMs}ms</div>` : ''}
      <div class="source-card-meta">${st.lastSuccess ? 'Last success: ' + new Date(st.lastSuccess).toLocaleTimeString() : 'Not yet fetched'}</div>
    `;
    grid.appendChild(card);
  });

  // Register status change callback to update cards dynamically
  window._onSourceStatusChange = (allStatus) => {
    Object.entries(allStatus).forEach(([key, st]) => {
      const el = document.getElementById(`src-status-${key}`);
      if (!el) return;
      el.innerHTML = `
        <span class="source-dot ${st.state === 'ok' || st.state === 'ready' ? 'ok' : st.state === 'fetching' ? 'fetching' : st.state === 'error' ? 'error' : 'idle'}"></span>
        <span>${statusLabel(st.state)}${st.error ? ` — ${st.error}` : ''}</span>
      `;
    });
  };
}

function statusLabel(s) {
  return { ok:'Connected', ready:'Ready', fetching:'Fetching…', error:'Error', idle:'Idle' }[s] || s;
}

function renderCPCBHistoricalChart() {
  destroyChart('cpcbHist');
  const ctx = document.getElementById('chart-cpcb-historical')?.getContext('2d');
  if (!ctx) return;

  const paramSel = document.getElementById('cpcb-param-select');
  const yearSel  = document.getElementById('cpcb-year-select');
  const param    = paramSel?.value || 'pm25';
  const year     = yearSel?.value || 'all';

  const polMeta  = POLLUTANTS.find(p => p.id === param);
  const months   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const CITY_COLORS = {
    delhi:'#ef4444', mumbai:'#3b82f6', bangalore:'#22c55e',
    kolkata:'#eab308', chennai:'#a855f7', hyderabad:'#f97316',
    pune:'#14b8a6', jaipur:'#f43f5e', lucknow:'#8b5cf6', ahmedabad:'#0ea5e9',
  };

  let datasets = [];
  if (year === 'all') {
    // One dataset per city, showing monthly values for 2023
    Object.keys(CITIES).forEach(cityId => {
      const row = getCPCBMonthly(cityId, param, 2023, 2023);
      if (!row) return;
      datasets.push({
        label: CITIES[cityId].name,
        data: row.map(r => r.value),
        borderColor: CITY_COLORS[cityId] || '#8b9dc3',
        backgroundColor: (CITY_COLORS[cityId] || '#8b9dc3') + '22',
        borderWidth: 2,
        tension: 0.4,
        fill: false,
        pointRadius: 4,
      });
    });
  } else {
    // Multi-year for selected city (current city)
    const years = [2019,2020,2021,2022,2023];
    const yearColors = ['#94a3b8','#64748b','#3b82f6','#8b5cf6','#22c55e'];
    years.forEach((y, i) => {
      const row = getCPCBMonthly(state.city, param, y, y);
      if (!row) return;
      datasets.push({
        label: String(y),
        data: row.map(r => r.value),
        borderColor: yearColors[i],
        backgroundColor: yearColors[i] + '18',
        borderWidth: 2,
        tension: 0.4,
        fill: false,
        pointRadius: 4,
      });
    });
  }

  const unitLabel = polMeta ? `${polMeta.name} (${polMeta.unit})` :
                   param === 'temperature' ? 'Temperature (°C)' :
                   param === 'humidity'    ? 'Humidity (%RH)'   : param;

  state.charts.cpcbHist = new Chart(ctx, {
    type: 'line',
    data: { labels: months, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, usePointStyle: true } },
      },
      scales: {
        x: { grid: { color: gridColor() } },
        y: { grid: { color: gridColor() }, min: 0,
             title: { display: true, text: unitLabel, color: 'var(--text-secondary)', font: { size: 11 } } },
      },
    },
  });
}

function renderNCAPTrendChart() {
  destroyChart('ncapTrend');
  const ctx = document.getElementById('chart-ncap-trend')?.getContext('2d');
  if (!ctx) return;

  const years = [2019, 2020, 2021, 2022, 2023];
  const CITY_COLORS = {
    delhi:'#ef4444', mumbai:'#3b82f6', bangalore:'#22c55e',
    kolkata:'#eab308', chennai:'#a855f7', hyderabad:'#f97316',
    pune:'#14b8a6', jaipur:'#f43f5e', lucknow:'#8b5cf6', ahmedabad:'#0ea5e9',
  };

  const datasets = Object.keys(CITIES).map(cityId => ({
    label: CITIES[cityId].name,
    data: years.map(y => getCPCBAnnualMean(cityId, 'pm25', y)),
    borderColor: CITY_COLORS[cityId],
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: 4,
    tension: 0.3,
  }));

  // WHO guideline reference line
  datasets.push({
    label: 'WHO 2021 (5 μg/m³)',
    data: years.map(() => 5),
    borderColor: 'rgba(255,255,255,0.35)',
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0,
  });

  state.charts.ncapTrend = new Chart(ctx, {
    type: 'line',
    data: { labels: years, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, usePointStyle: true, font: { size: 11 } } },
      },
      scales: {
        x: { grid: { color: gridColor() } },
        y: { grid: { color: gridColor() }, min: 0,
             title: { display: true, text: 'PM2.5 Annual Mean (μg/m³)', color: 'var(--text-secondary)', font: { size: 11 } } },
      },
    },
  });
}

function renderWHOExceedanceChart() {
  destroyChart('whoExceed');
  const ctx = document.getElementById('chart-who-exceedance')?.getContext('2d');
  if (!ctx) return;

  const params  = ['pm25','pm10','no2','so2','o3'];
  const who     = WHO_GUIDELINES;
  const cities  = Object.keys(CITIES);
  const CITY_COLORS = ['#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#f97316'];

  const datasets = cities.map((cityId, i) => ({
    label: CITIES[cityId].name,
    data: params.map(p => {
      const mean = getCPCBAnnualMean(cityId, p, 2023);
      const lim  = who[p];
      return mean && lim ? +(mean / lim).toFixed(2) : null;
    }),
    backgroundColor: CITY_COLORS[i] + 'cc',
    borderColor: CITY_COLORS[i],
    borderWidth: 1.5,
    borderRadius: 4,
  }));

  state.charts.whoExceed = new Chart(ctx, {
    type: 'bar',
    data: { labels: params.map(p => POLLUTANTS.find(x=>x.id===p)?.name || p), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, usePointStyle: true, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}× WHO limit` } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: gridColor() }, min: 0,
             title: { display: true, text: 'Times above WHO limit', color: 'var(--text-secondary)', font: { size: 11 } },
             ticks: { callback: v => v + '×' } },
      },
    },
  });
}

function buildProvenanceGrid() {
  const grid = document.getElementById('provenance-grid');
  if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';

  PROVENANCE_RECORDS.forEach(r => {
    const row = document.createElement('div');
    row.className = 'provenance-item';
    row.innerHTML = `
      <div class="provenance-label">${r.label}<small>${r.sub}</small></div>
      <div class="provenance-desc">${r.desc}</div>
    `;
    grid.appendChild(row);
  });
}

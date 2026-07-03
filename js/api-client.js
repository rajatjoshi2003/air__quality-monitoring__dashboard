/**
 * api-client.js — Thin wrapper around the Flask backend API.
 *
 * Usage:
 *   ApiClient.setBaseUrl('http://localhost:5000/api/v1');
 *   const { data } = await ApiClient.cities.list();
 *   const { data } = await ApiClient.measurements.list({ city:'delhi', param:'pm25,no2' });
 *
 * Toggle between backend and browser-SQLite modes via:
 *   ApiClient.setMode('backend')   // calls Flask API
 *   ApiClient.setMode('browser')   // uses AQI_DB + state.data (default)
 */

const ApiClient = (() => {

  // ─── Configuration ─────────────────────────────────────────────────────────

  let _baseUrl = localStorage.getItem('aqi_api_url') || 'http://localhost:5000/api/v1';
  let _mode    = localStorage.getItem('aqi_api_mode') || 'browser';
  let _timeout = 10000;

  function setBaseUrl(url) {
    _baseUrl = url.replace(/\/$/, '');
    localStorage.setItem('aqi_api_url', _baseUrl);
  }

  function setMode(mode) {
    if (!['backend','browser'].includes(mode)) throw new Error('mode must be backend or browser');
    _mode = mode;
    localStorage.setItem('aqi_api_mode', mode);
  }

  function getMode()    { return _mode; }
  function getBaseUrl() { return _baseUrl; }

  // ─── Core fetch ────────────────────────────────────────────────────────────

  async function _fetch(path, opts = {}) {
    const url        = `${_baseUrl}${path}`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), _timeout);

    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal:  controller.signal,
      ...opts,
    }).finally(() => clearTimeout(timer));

    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body });
    return body;
  }

  function _qs(params) {
    const q = new URLSearchParams();
    Object.entries(params || {}).forEach(([k,v]) => {
      if (v != null && v !== '') q.append(k, v);
    });
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  const health = {
    async check() { return _fetch('/health'); },
  };

  // ─── Live (real-time CPCB AQI, proxied from data.gov.in) ───────────────────

  const live = {
    async aqi(city) { return _fetch(`/live/aqi${_qs({ city })}`); },
  };

  // ─── Cities & Stations ─────────────────────────────────────────────────────

  const cities = {
    async list(params = {})     { return _fetch(`/cities${_qs(params)}`); },
    async get(cityId)           { return _fetch(`/cities/${encodeURIComponent(cityId)}`); },
  };

  const stations = {
    async list(params = {})     { return _fetch(`/stations${_qs(params)}`); },
    async get(stationCode)      { return _fetch(`/stations/${encodeURIComponent(stationCode)}`); },
  };

  // ─── Parameters ────────────────────────────────────────────────────────────

  const parameters = {
    async list() { return _fetch('/parameters'); },
  };

  // ─── Measurements & AQI ────────────────────────────────────────────────────

  const measurements = {
    /**
     * @param {object} opts
     * @param {string} opts.city
     * @param {string} [opts.station]
     * @param {string} [opts.param]       comma-sep codes
     * @param {string} [opts.start]       ISO datetime
     * @param {string} [opts.end]         ISO datetime
     * @param {string} [opts.quality]     comma-sep flags
     * @param {string} [opts.order]       asc | desc
     * @param {number} [opts.limit]
     * @param {number} [opts.page]
     */
    async list(opts = {})       { return _fetch(`/measurements${_qs(opts)}`); },
  };

  const aqi = {
    async latest(params = {})   { return _fetch(`/aqi/latest${_qs(params)}`); },
    /**
     * @param {string} city
     * @param {object} [opts]  start, end, bin (hour|day|month)
     */
    async history(city, opts={}) {
      return _fetch(`/aqi/history${_qs({ city, ...opts })}`);
    },
  };

  // ─── Aggregations ──────────────────────────────────────────────────────────

  const aggregations = {
    /**
     * Hourly means.
     * @param {object} opts  city, station, param, start, end, quality
     */
    async hourly(opts = {})     { return _fetch(`/aggregations/hourly${_qs(opts)}`); },

    /**
     * Daily aggregates.
     * @param {object} opts  city, station, param, start, end, quality, group
     */
    async daily(opts = {})      { return _fetch(`/aggregations/daily${_qs(opts)}`); },

    /**
     * Monthly CPCB aggregates (2019–2023).
     * @param {object} opts  city, station, param, year
     */
    async monthly(opts = {})    { return _fetch(`/aggregations/monthly${_qs(opts)}`); },

    /**
     * Multi-city comparison for a single parameter.
     * @param {object} opts  cities (comma-sep), param, start, end, bin
     */
    async compare(opts = {})    { return _fetch(`/aggregations/compare${_qs(opts)}`); },
  };

  // ─── Stats ─────────────────────────────────────────────────────────────────

  const stats = {
    async summary(params = {})       { return _fetch(`/stats/summary${_qs(params)}`); },
    async exceedances(city, opts={}) { return _fetch(`/stats/exceedances${_qs({ city, ...opts })}`); },
    async rankings(params = {})      { return _fetch(`/stats/rankings${_qs(params)}`); },
    async diurnal(city, opts = {})   { return _fetch(`/stats/diurnal${_qs({ city, ...opts })}`); },
    async trend(city, opts = {})     { return _fetch(`/stats/trend${_qs({ city, ...opts })}`); },
  };

  // ─── Forecast ────────────────────────────────────────────────────────────────

  const forecast = {
    /** List available forecasting models. */
    async models() { return _fetch('/forecast/models'); },
    /**
     * Short-term AQI forecast for a city.
     * @param {string} city
     * @param {object} [opts]  method, horizon, lookback
     */
    async aqi(city, opts = {}) { return _fetch(`/forecast/aqi${_qs({ city, ...opts })}`); },
  };

  // ─── ETL ───────────────────────────────────────────────────────────────────

  const etl = {
    /**
     * Upload a CSV file for inspection (no DB write).
     * @param {File} file
     * @param {string} [delimiter]
     */
    async upload(file, delimiter) {
      const form = new FormData();
      form.append('file', file);
      if (delimiter) form.append('delimiter', delimiter);
      return _fetch('/etl/upload', {
        method:  'POST',
        headers: {},   // let browser set Content-Type with boundary
        body:    form,
      });
    },

    /**
     * Run a transform pipeline on JSON rows.
     * @param {object[]} rows
     * @param {object}   mapping       {target_field: source_column}
     * @param {string[]} steps         e.g. ['timestamp_norm','enrich_aqi']
     * @param {boolean}  previewOnly   if true, don't write to DB
     */
    async run(rows, mapping = {}, steps = [], previewOnly = true) {
      return _fetch('/etl/run', {
        method: 'POST',
        body: JSON.stringify({ rows, mapping, steps, preview_only: previewOnly }),
      });
    },

    /**
     * Directly ingest pre-mapped rows into the database.
     * @param {object[]} rows  must have station_code, timestamp_utc, and pollutant fields
     */
    async ingest(rows) {
      return _fetch('/etl/ingest', {
        method: 'POST',
        body:   JSON.stringify({ rows }),
      });
    },
  };

  // ─── Convenience: load city data into state.data ──────────────────────────

  /**
   * Fetch recent measurements for a city and convert to dashboard state.data format.
   * @param {string} cityId
   * @param {number} [hours=168]   lookback window
   */
  async function loadCityData(cityId, hours = 168) {
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data } = await measurements.list({
      city:  cityId,
      param: 'pm25,pm10,no2,so2,o3,co,temperature,humidity',
      start,
      limit: 5000,
      order: 'asc',
    });

    // Pivot: one row per timestamp (merge all params)
    const tsMap = {};
    data.forEach(row => {
      const ts = new Date(row.timestamp_utc).getTime();
      if (!tsMap[ts]) tsMap[ts] = { timestamp: ts };
      tsMap[ts][row.param] = row.value;
    });

    // Fetch AQI separately and merge
    const { data: aqiData } = await aqi.history(cityId, { start, bin: 'hour' }).catch(() => ({ data: [] }));
    aqiData.forEach(r => {
      const ts = new Date(r.ts).getTime();
      if (tsMap[ts]) tsMap[ts].aqi = r.mean_aqi;
    });

    return Object.values(tsMap).sort((a,b) => a.timestamp - b.timestamp);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    setBaseUrl, setMode, getMode, getBaseUrl,
    health,
    live,
    cities, stations, parameters,
    measurements, aqi,
    aggregations,
    stats,
    forecast,
    etl,
    loadCityData,
  };

})();

window.ApiClient = ApiClient;

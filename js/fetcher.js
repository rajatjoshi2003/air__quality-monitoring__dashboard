/**
 * Real-Data Fetcher
 *
 * Live AQI comes from the World Air Quality Index project (WAQI, aqicn.org)
 * read DIRECTLY from the browser — WAQI sends CORS headers, so no backend
 * proxy is required (unlike data.gov.in/CPCB, which blocks CORS and forced an
 * earlier Flask-proxy design). WAQI reports the US-EPA AQI, which matches the
 * scale the rest of this dashboard uses (see AQI_CATEGORIES in data.js).
 *
 * Requires a free WAQI API token (register at
 * https://aqicn.org/data-platform/token/). Provide it either via the gitignored
 * js/config.local.js (sets window.WAQI_TOKEN — see js/config.local.example.js),
 * or once from the browser console: localStorage.setItem('waqi_token','<token>').
 * window.WAQI_TOKEN takes precedence. Without a token the live fetch fails
 * silently and the UI stays synthetic.
 *
 * The former sources were removed because neither worked from the page:
 * OpenAQ v2 was retired (HTTP 410) and data.gov.in does not send CORS headers.
 */

// Representative coordinates per city — WAQI's geo feed returns the nearest
// monitoring station, which is more reliable than city-name keyword lookup.
const WAQI_COORDS = {
  delhi:     [28.6139, 77.2090],
  mumbai:    [19.0760, 72.8777],
  bangalore: [12.9716, 77.5946],
  kolkata:   [22.5726, 88.3639],
  chennai:   [13.0827, 80.2707],
  hyderabad: [17.3850, 78.4867],
  pune:      [18.5204, 73.8567],
  jaipur:    [26.9124, 75.7873],
  lucknow:   [26.8467, 80.9462],
  ahmedabad: [23.0225, 72.5714],
};

// ── Source Status ──────────────────────────────────────────
const sourceStatus = {
  waqi: { label:'World Air Quality Index (WAQI)', state:'idle',  lastSuccess:null, latencyMs:null, error:null },
  cpcb: { label:'CPCB Dataset',                   state:'ready', lastSuccess:Date.now(), latencyMs:0, error:null },
  iot:  { label:'IoT Sensors',                    state:'ready', lastSuccess:Date.now(), latencyMs:0, error:null },
};

function setSourceState(source, state, extra = {}) {
  if (!sourceStatus[source]) return;
  Object.assign(sourceStatus[source], { state, ...extra });
  if (typeof window._onSourceStatusChange === 'function') window._onSourceStatusChange(sourceStatus);
}

// ── Live AQI (WAQI, browser-direct) ────────────────────────
/**
 * Real-time AQI for a city from WAQI (aqicn.org), called directly from the
 * browser. Returns { aqi, category, station, stations, iaqi, … } or null on
 * failure (no token, network error, or station offline / no data).
 *
 * Note: WAQI's `iaqi` values are per-pollutant US-EPA AQI sub-indices, NOT
 * raw concentrations, so we do NOT patch them into the µg/m³ pollutant cards
 * (that would mix units). Only the headline AQI is taken live; the pollutant
 * breakdown stays synthetic. The sub-indices are returned under `iaqi` for
 * reference.
 */
// Fetch one WAQI /feed/ endpoint (geo:… or @uid) and return the raw `data`
// node only when it carries a usable numeric AQI, else null. Never throws.
async function fetchWAQIFeed(token, path) {
  try {
    const res  = await fetch(`https://api.waqi.info/feed/${path}/?token=${encodeURIComponent(token)}`);
    const json = await res.json();
    // WAQI returns {status:'ok', data:{…}} on success. On failure `data` is an
    // error string ("Invalid key", "can not connect", …). AQI is "-" when the
    // station is online but has no current reading.
    if (json && json.status === 'ok' && json.data && typeof json.data.aqi === 'number') {
      return json.data;
    }
  } catch { /* network error — treat as no data */ }
  return null;
}

// When the nearest-station geo feed is down for a city, ask WAQI which stations
// exist there (/search/) and return their uids, best-first. The `aqi` field in
// search results is often stale ("-"), so we only use it to rank candidates —
// the real value comes from querying each station's feed by @uid.
async function searchStationUids(token, keyword, limit = 6) {
  try {
    const res  = await fetch(`https://api.waqi.info/search/?token=${encodeURIComponent(token)}&keyword=${encodeURIComponent(keyword)}`);
    const json = await res.json();
    if (!json || json.status !== 'ok' || !Array.isArray(json.data)) return [];
    return json.data
      // stations reporting a live number in search go first, then the rest
      .sort((a, b) => (typeof b.aqi === 'number' ? 1 : 0) - (typeof a.aqi === 'number' ? 1 : 0))
      .map(s => s.uid)
      .filter(uid => uid != null)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// Shape a WAQI `data` node into the dashboard's live-snapshot object.
function toLiveSnapshot(cityId, d) {
  // WAQI station names are long ("Stadium, Delhi, Delhi, India") — keep just
  // the first segment for the badge/breakdown labels.
  const fullName = (d.city && d.city.name) || (window.CITIES && CITIES[cityId]?.name) || cityId;
  const station  = String(fullName).split(',')[0].trim();
  const cat      = typeof getAQICategory === 'function' ? getAQICategory(d.aqi).label : null;
  return {
    aqi:          d.aqi,
    category:     cat,
    pm25:         null,            // see note above — don't mix AQI sub-index into µg/m³
    pollutants:   {},              // leave synthetic concentration breakdown intact
    iaqi:         d.iaqi || {},    // per-pollutant US-EPA AQI sub-indices (reference)
    dominant:     d.dominentpol || null,
    station,
    stations:     [{ station, aqi: d.aqi, category: cat, dominant_pollutant: d.dominentpol || null }],
    stationCount: 1,
    lastUpdate:   d.time ? d.time.s : null,
    source:       'waqi',
  };
}

async function fetchLiveAQI(cityId) {
  const token = (window.WAQI_TOKEN || localStorage.getItem('waqi_token') || '').trim();
  if (!token) {
    setSourceState('waqi', 'error', { error: "no WAQI token — set localStorage.waqi_token" });
    return null;
  }

  const coord = WAQI_COORDS[cityId];
  const geoPath = coord ? `geo:${coord[0]};${coord[1]}` : encodeURIComponent(cityId);
  setSourceState('waqi', 'fetching');
  const t0 = Date.now();
  try {
    // 1) Nearest-station geo feed — the common, low-cost path.
    let d = await fetchWAQIFeed(token, geoPath);

    // 2) Fallback: the nearest station is offline / "can not connect" (happens
    //    for whole cities, e.g. Kolkata/Chennai/Lucknow). Other stations in the
    //    same city are usually live, so look them up by keyword and try each by
    //    uid until one returns a real number.
    if (!d) {
      const keyword = (window.CITIES && CITIES[cityId]?.name) || cityId;
      const uids = await searchStationUids(token, keyword);
      for (const uid of uids) {
        d = await fetchWAQIFeed(token, `@${uid}`);
        if (d) break;
      }
    }

    if (!d) {
      setSourceState('waqi', 'error', { error: 'WAQI: no live station data for this city' });
      return null;
    }

    setSourceState('waqi', 'ok', { lastSuccess: Date.now(), latencyMs: Date.now() - t0, error: null });
    return toLiveSnapshot(cityId, d);
  } catch (err) {
    setSourceState('waqi', 'error', { error: err.message || String(err) });
    return null;
  }
}

/**
 * Flatten the live snapshot into row objects suitable for ETL ingestion.
 * Returns [] when no live data is available.
 */
async function fetchLiveRows(cityId) {
  const live = await fetchLiveAQI(cityId);
  if (!live || !live.stations.length) return [];
  return live.stations
    .filter(s => s.aqi != null)
    .map(s => ({
      station:   s.station,
      city:      cityId,
      aqi:       s.aqi,
      category:  s.category,
      dominant:  s.dominant_pollutant || null,
      timestamp: Date.now(),
      source:    'waqi',
    }));
}

// ── Public API ─────────────────────────────────────────────
window.Fetcher = {
  fetchLiveAQI,
  fetchLiveRows,
  getSourceStatus: () => ({ ...sourceStatus }),
};

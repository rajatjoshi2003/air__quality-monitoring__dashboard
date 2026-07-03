// ============================================================
// DATA LAYER — Air Quality Dashboard
// ============================================================

const CITIES = {
  delhi:     { name: 'Delhi',     state: 'Delhi NCR',      baseAQI: 185, variance: 90 },
  mumbai:    { name: 'Mumbai',    state: 'Maharashtra',    baseAQI: 115, variance: 55 },
  bangalore: { name: 'Bangalore', state: 'Karnataka',      baseAQI:  92, variance: 42 },
  kolkata:   { name: 'Kolkata',   state: 'West Bengal',    baseAQI: 148, variance: 72 },
  chennai:   { name: 'Chennai',   state: 'Tamil Nadu',     baseAQI: 105, variance: 48 },
  hyderabad: { name: 'Hyderabad', state: 'Telangana',      baseAQI: 122, variance: 58 },
  pune:      { name: 'Pune',      state: 'Maharashtra',    baseAQI:  98, variance: 46 },
  jaipur:    { name: 'Jaipur',    state: 'Rajasthan',      baseAQI: 135, variance: 65 },
  lucknow:   { name: 'Lucknow',   state: 'Uttar Pradesh',  baseAQI: 165, variance: 80 },
  ahmedabad: { name: 'Ahmedabad', state: 'Gujarat',        baseAQI: 128, variance: 60 },
};

const POLLUTANTS = [
  { id: 'pm25', name: 'PM2.5', unit: 'μg/m³', who: 15,  color: '#ef4444', desc: 'Fine particulate matter (< 2.5 μm). Penetrates deep into lungs and bloodstream.' },
  { id: 'pm10', name: 'PM10',  unit: 'μg/m³', who: 45,  color: '#f97316', desc: 'Coarse particulate matter (< 10 μm). Causes respiratory irritation.' },
  { id: 'no2',  name: 'NO₂',   unit: 'μg/m³', who: 25,  color: '#eab308', desc: 'Nitrogen Dioxide. Produced by vehicle exhaust and industrial burning.' },
  { id: 'o3',   name: 'O₃',    unit: 'μg/m³', who: 100, color: '#22c55e', desc: 'Ground-level Ozone. Formed by chemical reactions between NOx and VOCs.' },
  { id: 'co',   name: 'CO',    unit: 'mg/m³', who: 4,   color: '#3b82f6', desc: 'Carbon Monoxide. Colourless, odourless gas from incomplete combustion.' },
  { id: 'so2',  name: 'SO₂',   unit: 'μg/m³', who: 40,  color: '#a855f7', desc: 'Sulphur Dioxide. Released from burning fossil fuels and volcanic activity.' },
];

const AQI_CATEGORIES = [
  { min: 0,   max: 50,  label: 'Good',                          short: 'Good',        color: '#22c55e', bg: 'rgba(34,197,94,0.15)',   icon: '😊', advice: 'Air quality is satisfactory. Enjoy outdoor activities freely.' },
  { min: 51,  max: 100, label: 'Moderate',                      short: 'Moderate',    color: '#eab308', bg: 'rgba(234,179,8,0.15)',   icon: '😐', advice: 'Air quality is acceptable. Unusually sensitive people should consider limiting prolonged outdoor exertion.' },
  { min: 101, max: 150, label: 'Unhealthy for Sensitive Groups', short: 'USG',         color: '#f97316', bg: 'rgba(249,115,22,0.15)', icon: '😷', advice: 'Sensitive groups (children, elderly, asthma patients) should limit prolonged outdoor exertion. Consider an N95 mask.' },
  { min: 151, max: 200, label: 'Unhealthy',                     short: 'Unhealthy',   color: '#ef4444', bg: 'rgba(239,68,68,0.15)',   icon: '🤢', advice: 'Everyone may begin to experience health effects. Sensitive groups should avoid outdoor activities. Wear N95 mask outdoors.' },
  { min: 201, max: 300, label: 'Very Unhealthy',                short: 'Very Bad',    color: '#a855f7', bg: 'rgba(168,85,247,0.15)', icon: '🚫', advice: 'Health alert — everyone may experience more serious effects. Stay indoors with air purifier. Avoid all outdoor physical activity.' },
  { min: 301, max: 500, label: 'Hazardous',                     short: 'Hazardous',   color: '#dc2626', bg: 'rgba(220,38,38,0.15)',   icon: '☠️', advice: 'Health emergency. Entire population at risk. Close windows, stay indoors, use air purifier. Seek medical attention if symptomatic.' },
];

const HEALTH_ADVICE = {
  children:  ['Play outdoors freely', 'Limit prolonged outdoor play', 'Avoid outdoor activities after school', 'No outdoor activities', 'Keep children indoors all day', 'Indoor-only — seal windows'],
  elderly:   ['Normal activity', 'Consider limiting extended outdoor time', 'Reduce outdoor walks', 'Stay indoors; short trips only', 'Do not go outdoors', 'Remain indoors; seek medical advice'],
  heart:     ['Normal activity', 'Monitor symptoms during exertion', 'Limit vigorous activity', 'Avoid exertion; stay indoors', 'No outdoor activity; use purifier', 'Emergency protocols if symptomatic'],
  lung:      ['Normal activity', 'Watch for symptoms', 'Use prescribed inhaler before going out', 'Avoid outdoor air; stay indoors', 'Do not go outside at all', 'Call doctor if breathing worsens'],
  athletes:  ['Train outdoors freely', 'Light outdoor training only', 'Move training indoors', 'Indoor training only', 'No physical exertion of any kind', 'Absolute rest; stay indoors'],
  general:   ['Enjoy outdoor life', 'Reduce prolonged outdoor exertion', 'Consider an N95 mask outdoors', 'Limit time outdoors; wear mask', 'Avoid outdoor activities', 'Stay home; emergency conditions'],
};

const PROTECTIVE_MEASURES = [
  { icon: '😷', title: 'Wear N95/FFP2 Mask',    levels: [3,4,5],  desc: 'Standard surgical masks do not filter PM2.5. Use rated N95 or FFP2 respirators.' },
  { icon: '🏠', title: 'Stay Indoors',           levels: [4,5],    desc: 'Keep windows closed. Use weather sealing. Consider a HEPA air purifier.' },
  { icon: '🌱', title: 'Use Air Purifier',       levels: [3,4,5],  desc: 'HEPA filters capture particles down to 0.3 μm. Run on high during peak pollution.' },
  { icon: '🚶', title: 'Limit Outdoor Exercise', levels: [2,3,4,5],desc: 'Heavy breathing during exercise increases pollutant intake 10–15×.' },
  { icon: '🚗', title: 'Avoid Peak Traffic Hours',levels: [1,2,3], desc: 'Vehicle emissions peak at 8–10 AM and 6–8 PM. Avoid outdoor exposure then.' },
  { icon: '💧', title: 'Stay Hydrated',          levels: [0,1,2,3,4,5], desc: 'Hydration helps mucous membranes trap pollutants before reaching the lungs.' },
  { icon: '🌿', title: 'Indoor Plants',          levels: [0,1,2],  desc: 'Plants like Peace Lily and Spider Plant absorb VOCs, improving indoor air quality.' },
  { icon: '📱', title: 'Monitor AQI Daily',      levels: [0,1,2,3,4,5], desc: 'Check local AQI before outdoor activities, especially for sensitive groups.' },
];

// ─── Pseudo-random generator (reproducible by seed) ──────────────────────────
function seededRand(seed) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

// ─── AQI category lookup ──────────────────────────────────────────────────────
function getAQICategory(aqi) {
  return AQI_CATEGORIES.find(c => aqi >= c.min && aqi <= c.max) || AQI_CATEGORIES[AQI_CATEGORIES.length - 1];
}

// ─── Generate a single AQI value for a city at a given timestamp ─────────────
function generateAQIValue(cityId, timestamp) {
  const city  = CITIES[cityId];
  const date  = new Date(timestamp);
  const hour  = date.getHours();
  const month = date.getMonth();     // 0–11
  const cityCode = cityId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

  // Seasonal factor (North Indian cities worse in winter)
  let seasonal = 1.0;
  const isNorth = ['delhi', 'kolkata', 'jaipur', 'lucknow'].includes(cityId);
  if (isNorth) {
    if (month >= 10 || month <= 1) seasonal = 1.65;
    else if (month >= 6 && month <= 8) seasonal = 0.58;
    else seasonal = 1.05;
  } else {
    if (month >= 11 || month <= 2) seasonal = 1.18;
    else if (month >= 6 && month <= 8) seasonal = 0.75;
  }

  // Diurnal pattern (rush hours + early morning minimum)
  const diurnal = [0.68, 0.62, 0.58, 0.57, 0.60, 0.72, 0.88, 1.12,
                   1.22, 1.10, 1.00, 0.94, 0.92, 0.88, 0.90, 0.96,
                   1.08, 1.28, 1.38, 1.20, 1.08, 1.00, 0.90, 0.78][hour];

  // Noise component (seeded for reproducibility)
  const seed   = cityCode * 1000 + Math.floor(timestamp / 3_600_000);
  const noise  = (seededRand(seed) - 0.5) * city.variance;

  const raw = city.baseAQI * seasonal * diurnal + noise;
  return Math.max(12, Math.min(500, Math.round(raw)));
}

// ─── Derive pollutant concentrations from AQI value ─────────────────────────
function derivePollutants(aqi, seed) {
  const f = aqi / 100;
  return {
    pm25: Math.max(3,  Math.round(aqi * 0.38 + (seededRand(seed * 1.1) - 0.5) * 18)),
    pm10: Math.max(8,  Math.round(aqi * 0.68 + (seededRand(seed * 1.2) - 0.5) * 30)),
    no2:  Math.max(5,  Math.round(aqi * 0.28 + (seededRand(seed * 1.3) - 0.5) * 20)),
    o3:   Math.max(10, Math.round(aqi * 0.22 + (seededRand(seed * 1.4) - 0.5) * 15)),
    co:   Math.max(0.2, +((f * 0.9    + (seededRand(seed * 1.5) - 0.5) * 1.5)).toFixed(1)),
    so2:  Math.max(2,  Math.round(aqi * 0.09 + (seededRand(seed * 1.6) - 0.5) * 10)),
  };
}

// ─── Historical data series ───────────────────────────────────────────────────
function generateHistoricalData(cityId, points, intervalMs) {
  const now = Date.now();
  const result = [];
  for (let i = points - 1; i >= 0; i--) {
    const ts  = now - i * intervalMs;
    const aqi = generateAQIValue(cityId, ts);
    const seed = Math.floor(ts / 3_600_000);
    result.push({ timestamp: ts, aqi, ...derivePollutants(aqi, seed) });
  }
  return result;
}

// ─── Current snapshot for all cities ─────────────────────────────────────────
function generateAllCitiesSnapshot() {
  const now = Date.now();
  const result = {};
  Object.keys(CITIES).forEach(id => {
    const aqi  = generateAQIValue(id, now);
    const seed = Math.floor(now / 3_600_000);
    const prev = generateAQIValue(id, now - 3_600_000);
    result[id] = {
      ...CITIES[id],
      aqi,
      trend: aqi - prev,
      category: getAQICategory(aqi),
      ...derivePollutants(aqi, seed),
    };
  });
  return result;
}

// ─── 7×24 heatmap (day-of-week × hour-of-day) ────────────────────────────────
function generateHeatmapMatrix(cityId) {
  const DAYS  = 28; // 4 weeks of history
  const now   = Date.now();
  const sums  = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const counts= Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (let d = 0; d < DAYS; d++) {
    for (let h = 0; h < 24; h++) {
      const ts  = now - d * 86_400_000 - (23 - h) * 3_600_000;
      const day = new Date(ts).getDay();
      const aqi = generateAQIValue(cityId, ts);
      sums[day][h]  += aqi;
      counts[day][h]+= 1;
    }
  }
  return sums.map((row, d) => row.map((s, h) => Math.round(s / counts[d][h])));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRangeConfig(range) {
  return {
    '24h': { points: 24,  intervalMs: 3_600_000,     fmt: 'HH:MM',  label: '24 Hours' },
    '7d':  { points: 56,  intervalMs: 10_800_000,    fmt: 'Day HH', label: '7 Days'   },
    '30d': { points: 60,  intervalMs: 43_200_000,    fmt: 'MMM DD', label: '30 Days'  },
    '1y':  { points: 52,  intervalMs: 604_800_000,   fmt: 'MMM',    label: '1 Year'   },
  }[range] || { points: 24, intervalMs: 3_600_000, fmt: 'HH:MM', label: '24 Hours' };
}

function formatTimestamp(ts, fmt) {
  const d  = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (fmt === 'HH:MM')  return `${hh}:${mm}`;
  if (fmt === 'Day HH') return `${days[d.getDay()]} ${hh}:00`;
  if (fmt === 'MMM DD') return `${months[d.getMonth()]} ${d.getDate()}`;
  if (fmt === 'MMM')    return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  return `${hh}:${mm}`;
}

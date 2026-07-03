/**
 * Unit Converter & Physical Range Validator
 *
 * Handles inconsistencies that arise when aggregating readings from:
 *   - CPCB reference monitors  (μg/m³, mg/m³)
 *   - US EPA / WHO comparisons (ppb, ppm)
 *   - IoT low-cost sensors     (may report raw ADC counts or wrong units)
 *   - International datasets   (°F temperature, ppm CO)
 *
 * All internal quantities are normalised to:
 *   PM2.5, PM10, NO₂, SO₂, O₃  → μg/m³
 *   CO                           → mg/m³
 *   Temperature                  → °C
 *   Humidity                     → % RH
 */

// ── Physical Plausibility Ranges ──────────────────────────
// hard: absolute impossibility (instrument fault / data error)
// soft: unusual but physically possible extreme (flag for review)
const PHYSICAL_RANGES = {
  pm25:        { hard: [-0.1, 1200], soft: [0, 600],  unit: 'μg/m³',  whoLimit: 5,   naaqsLimit: 40  },
  pm10:        { hard: [-0.1, 2000], soft: [0, 900],  unit: 'μg/m³',  whoLimit: 15,  naaqsLimit: 60  },
  no2:         { hard: [-0.1, 600],  soft: [0, 400],  unit: 'μg/m³',  whoLimit: 10,  naaqsLimit: 40  },
  so2:         { hard: [-0.1, 600],  soft: [0, 400],  unit: 'μg/m³',  whoLimit: 40,  naaqsLimit: 50  },
  o3:          { hard: [-0.1, 500],  soft: [0, 300],  unit: 'μg/m³',  whoLimit: 60,  naaqsLimit: 100 },
  co:          { hard: [-0.1, 150],  soft: [0, 50],   unit: 'mg/m³',  whoLimit: 4,   naaqsLimit: 2   },
  aqi:         { hard: [0,    500],  soft: [0, 500],  unit: 'AQI',    whoLimit: null, naaqsLimit: null },
  temperature: { hard: [-25,  65],   soft: [-5, 55],  unit: '°C',     whoLimit: null, naaqsLimit: null },
  humidity:    { hard: [0,    100],  soft: [2, 99],   unit: '%RH',    whoLimit: null, naaqsLimit: null },
};

// ── Molecular weights for gas-unit conversion (g/mol) ────
const MW = { no2: 46.005, so2: 64.065, o3: 47.998, co: 28.010 };

// ── Molar volume at 25 °C, 1 atm (L/mol) ────────────────
const VM25 = 24.465;

// ── Unit Conversion Functions ─────────────────────────────

/**
 * ppb (v/v) → μg/m³  at 25 °C, 1 atm
 *   μg/m³ = ppb × MW / Vm25
 */
function ppbToUgm3(ppb, param) {
  const mw = MW[param];
  if (!mw) throw new Error(`No MW for ${param}`);
  return (ppb * mw) / VM25;
}

/**
 * μg/m³ → ppb at 25 °C, 1 atm
 */
function ugm3ToPpb(ugm3, param) {
  const mw = MW[param];
  if (!mw) throw new Error(`No MW for ${param}`);
  return (ugm3 * VM25) / mw;
}

/**
 * ppm (v/v) → mg/m³ at 25 °C, 1 atm
 *   mg/m³ = ppm × MW / Vm25
 */
function ppmToMgm3(ppm, param) {
  const mw = MW[param];
  if (!mw) throw new Error(`No MW for ${param}`);
  return (ppm * mw) / VM25;
}

/** mg/m³ → μg/m³ (multiply by 1000) */
const mgToUg = (mg) => mg * 1000;
/** μg/m³ → mg/m³ */
const ugToMg = (ug) => ug / 1000;

/** °F → °C */
const fToC = (f) => (f - 32) * (5 / 9);
/** K → °C */
const kToC = (k) => k - 273.15;
/** °C → °F */
const cToF = (c) => c * (9 / 5) + 32;

// ── Unit Auto-Detection ───────────────────────────────────
/**
 * Heuristically infer the unit of a value for a given parameter.
 * Returns { detectedUnit, confidence, needsConversion, targetUnit }
 *
 * Strategy: if a value is wildly outside the expected range for the
 * standard unit, but within range after conversion, flag it.
 */
function detectUnit(param, value) {
  if (value == null || isNaN(value)) return { detectedUnit: null, confidence: 0 };

  const range = PHYSICAL_RANGES[param];
  if (!range) return { detectedUnit: 'unknown', confidence: 0 };

  const [sMin, sMax] = range.soft;
  const inStandard = value >= sMin && value <= sMax;

  switch (param) {
    case 'co': {
      // CO standard: mg/m³ (0–10 typical urban)
      // If value > 30, very likely ppm (ppm × 1.145 ≈ mg/m³, so mg/m³ > 30 means ppm~26)
      // Typical CO in ppm for Indian cities: 1–8 ppm
      // In mg/m³: 1.15–9.2 mg/m³
      // If reported value is 0.5–10 but the value should be mg/m³, it's fine.
      // If value is 0.4–9 it could be ppm (i.e. 0.46–10.3 mg/m³ → plausible both ways)
      // We check: values like 0.001–1.5 suggest ppm for high-pollution cities where mg/m³ > 1
      if (inStandard) return { detectedUnit: 'mg/m³', confidence: 0.85, needsConversion: false, targetUnit: 'mg/m³' };
      // If value is plausible as ppm (ppm × 1.145 would be in mg/m³ range)
      const asMgm3 = ppmToMgm3(value, 'co');
      if (asMgm3 >= sMin && asMgm3 <= sMax)
        return { detectedUnit: 'ppm', confidence: 0.80, needsConversion: true, targetUnit: 'mg/m³', convertedValue: +asMgm3.toFixed(3) };
      return { detectedUnit: 'mg/m³', confidence: 0.5, needsConversion: false, targetUnit: 'mg/m³' };
    }

    case 'no2':
    case 'so2':
    case 'o3': {
      // Standard: μg/m³ (e.g. NO₂ typical 10–150 μg/m³ Indian cities)
      // ppb values for same are ≈ 5–80 ppb → much smaller numbers
      if (inStandard) return { detectedUnit: 'μg/m³', confidence: 0.90, needsConversion: false, targetUnit: 'μg/m³' };
      // Check if looks like ppb (ppb → μg/m³ typically 1.88–2.62× larger)
      const asUgm3 = ppbToUgm3(value, param);
      if (asUgm3 >= sMin && asUgm3 <= sMax)
        return { detectedUnit: 'ppb', confidence: 0.75, needsConversion: true, targetUnit: 'μg/m³', convertedValue: +asUgm3.toFixed(2) };
      // Check mg/m³ (rare but possible for old equipment)
      const fromMg = mgToUg(value);
      if (fromMg >= sMin && fromMg <= sMax)
        return { detectedUnit: 'mg/m³', confidence: 0.70, needsConversion: true, targetUnit: 'μg/m³', convertedValue: +fromMg.toFixed(2) };
      return { detectedUnit: 'μg/m³', confidence: 0.5, needsConversion: false, targetUnit: 'μg/m³' };
    }

    case 'pm25':
    case 'pm10': {
      // Standard: μg/m³
      if (inStandard) return { detectedUnit: 'μg/m³', confidence: 0.95, needsConversion: false, targetUnit: 'μg/m³' };
      // mg/m³? Typical PM2.5 0.02–0.5 mg/m³ → 20–500 μg/m³
      if (value > 0 && value < 2) {
        const fromMg = mgToUg(value);
        if (fromMg >= sMin && fromMg <= sMax)
          return { detectedUnit: 'mg/m³', confidence: 0.78, needsConversion: true, targetUnit: 'μg/m³', convertedValue: +fromMg.toFixed(1) };
      }
      return { detectedUnit: 'μg/m³', confidence: 0.6, needsConversion: false, targetUnit: 'μg/m³' };
    }

    case 'temperature': {
      // Standard: °C (−5 to 50 for Indian cities)
      if (inStandard) return { detectedUnit: '°C', confidence: 0.92, needsConversion: false, targetUnit: '°C' };
      // Could be °F (23–122 °F for same range → Indian cities 20–110 °F typical)
      if (value >= 23 && value <= 122) {
        const asC = fToC(value);
        if (asC >= sMin && asC <= sMax)
          return { detectedUnit: '°F', confidence: 0.82, needsConversion: true, targetUnit: '°C', convertedValue: +asC.toFixed(1) };
      }
      // Kelvin? 293–323 K for Indian cities
      if (value >= 240 && value <= 340) {
        const asC = kToC(value);
        if (asC >= sMin && asC <= sMax)
          return { detectedUnit: 'K', confidence: 0.88, needsConversion: true, targetUnit: '°C', convertedValue: +asC.toFixed(1) };
      }
      return { detectedUnit: '°C', confidence: 0.4, needsConversion: false, targetUnit: '°C' };
    }

    default:
      return { detectedUnit: range.unit, confidence: 0.7, needsConversion: false, targetUnit: range.unit };
  }
}

/**
 * Convert a value to the standard unit for a given parameter.
 * @param {string} param - parameter id (pm25, no2, co, temperature, …)
 * @param {number} value - raw value
 * @param {string} fromUnit - source unit string
 * @returns {number} converted value in standard unit
 */
function toStandardUnit(param, value, fromUnit) {
  if (value == null || isNaN(value)) return value;

  const u = fromUnit?.toLowerCase().trim();
  switch (param) {
    case 'no2': case 'so2': case 'o3':
      if (u === 'ppb')     return +ppbToUgm3(value, param).toFixed(2);
      if (u === 'mg/m³')   return +mgToUg(value).toFixed(2);
      return value; // already μg/m³
    case 'co':
      if (u === 'ppm')     return +ppmToMgm3(value, param).toFixed(3);
      if (u === 'μg/m³')   return +ugToMg(value).toFixed(3);
      return value; // already mg/m³
    case 'pm25': case 'pm10':
      if (u === 'mg/m³')   return +mgToUg(value).toFixed(1);
      return value; // already μg/m³
    case 'temperature':
      if (u === '°f' || u === 'f')  return +fToC(value).toFixed(1);
      if (u === 'k' || u === 'kelvin') return +kToC(value).toFixed(1);
      return value; // already °C
    default:
      return value;
  }
}

// ── AQI Breakpoint Table (US EPA, PM2.5 24-hour average) ─
const PM25_BREAKPOINTS = [
  { cLo:  0.0, cHi:  12.0, iLo:  0, iHi:  50 },
  { cLo: 12.1, cHi:  35.4, iLo: 51, iHi: 100 },
  { cLo: 35.5, cHi:  55.4, iLo:101, iHi: 150 },
  { cLo: 55.5, cHi: 150.4, iLo:151, iHi: 200 },
  { cLo:150.5, cHi: 250.4, iLo:201, iHi: 300 },
  { cLo:250.5, cHi: 350.4, iLo:301, iHi: 400 },
  { cLo:350.5, cHi: 500.4, iLo:401, iHi: 500 },
];

/**
 * Calculate US EPA AQI from a 24-hour average PM2.5 concentration (μg/m³).
 * Returns integer AQI or null if out of range.
 */
function pm25ToAQI(pm25) {
  if (pm25 == null || isNaN(pm25) || pm25 < 0) return null;
  const c = Math.round(pm25 * 10) / 10; // truncate to 1 decimal
  const bp = PM25_BREAKPOINTS.find(b => c >= b.cLo && c <= b.cHi);
  if (!bp) return 500; // > 500 = hazardous
  return Math.round(((bp.iHi - bp.iLo) / (bp.cHi - bp.cLo)) * (c - bp.cLo) + bp.iLo);
}

/**
 * Simple AQI estimate from instantaneous PM2.5 using NowCast approximation.
 * (Uses same breakpoints — suitable for hourly dashboard display.)
 */
function nowCastAQI(pm25) { return pm25ToAQI(pm25); }

// ── Sentinel / Fill-Value Detection ───────────────────────
// Many monitoring systems use magic numbers for missing data
const SENTINEL_VALUES = new Set([-999, -9999, -1, 9999, 99999, 999, 9998]);

function isSentinel(value) {
  return SENTINEL_VALUES.has(value);
}

function isMissing(value) {
  return value == null || value === undefined || (typeof value === 'number' && (isNaN(value) || isSentinel(value)));
}

// ── Range Check ───────────────────────────────────────────
/**
 * Returns 'valid' | 'soft_outlier' | 'hard_outlier' for a value.
 */
function checkRange(param, value) {
  if (isMissing(value)) return 'missing';
  const r = PHYSICAL_RANGES[param];
  if (!r) return 'unknown';
  const [hMin, hMax] = r.hard;
  const [sMin, sMax] = r.soft;
  if (value < hMin || value > hMax) return 'hard_outlier';
  if (value < sMin || value > sMax) return 'soft_outlier';
  return 'valid';
}

// ── Exports ───────────────────────────────────────────────
window.UnitConverter = {
  PHYSICAL_RANGES,
  MW,
  ppbToUgm3,
  ugm3ToPpb,
  ppmToMgm3,
  mgToUg,
  ugToMg,
  fToC,
  kToC,
  cToF,
  detectUnit,
  toStandardUnit,
  pm25ToAQI,
  nowCastAQI,
  isSentinel,
  isMissing,
  checkRange,
};

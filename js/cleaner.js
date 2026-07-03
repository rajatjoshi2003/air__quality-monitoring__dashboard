/**
 * Data Cleaning Algorithms
 *
 * Provides statistical methods for:
 *   1. Missing value detection & multi-strategy imputation
 *   2. Outlier detection  — Z-score, Modified Z-score (MAD), IQR
 *   3. Outlier treatment  — clip, flag, interpolate, drop
 *   4. Cross-parameter consistency checks (PM10 ≥ PM2.5, etc.)
 *   5. Rate-of-change spike detection
 *   6. Dirty data generator (for pipeline demonstration)
 */

const PARAMS = ['pm25', 'pm10', 'no2', 'so2', 'o3', 'co', 'aqi', 'temperature', 'humidity'];

// ═══════════════════════════════════════════════════════════
// SECTION 1 — DESCRIPTIVE STATISTICS
// ═══════════════════════════════════════════════════════════

function validValues(arr) { return arr.filter(v => v != null && !isNaN(v)); }

function mean(arr) {
  const v = validValues(arr);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function median(arr) {
  const v = validValues(arr).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function stdDev(arr) {
  const v   = validValues(arr);
  if (v.length < 2) return 0;
  const mu  = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length);
}

function mad(arr) {
  const v  = validValues(arr);
  const md = median(v);
  if (md === null) return 0;
  return median(v.map(x => Math.abs(x - md)));
}

function percentile(arr, p) {
  const v = validValues(arr).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = (p / 100) * (v.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

function computeStats(values) {
  const v    = validValues(values);
  const mu   = mean(v);
  const sd   = stdDev(v);
  const q1   = percentile(v, 25);
  const q3   = percentile(v, 75);
  const iqr  = q3 != null && q1 != null ? q3 - q1 : null;
  const md   = median(v);
  const madv = mad(v);
  return {
    n: v.length, mean: mu, median: md, std: sd,
    q1, q3, iqr, mad: madv,
    min: v.length ? Math.min(...v) : null,
    max: v.length ? Math.max(...v) : null,
  };
}

// ═══════════════════════════════════════════════════════════
// SECTION 2 — MISSING VALUE DETECTION
// ═══════════════════════════════════════════════════════════

/**
 * Scans a dataset and builds a missing-value map.
 * Returns { byParam, totalMissing, completeness }
 */
function detectMissing(data, params = PARAMS) {
  const byParam   = {};
  let totalCells  = 0;
  let missingCount= 0;

  params.forEach(p => {
    const indices = [];
    data.forEach((row, i) => {
      const v = row[p];
      if (window.UnitConverter?.isMissing(v) || v == null || isNaN(v)) {
        indices.push(i);
        missingCount++;
      }
      totalCells++;
    });
    byParam[p] = {
      missingIndices: indices,
      missingCount:   indices.length,
      missingPct:     +(indices.length / data.length * 100).toFixed(1),
    };
  });

  return {
    byParam,
    totalMissing:  missingCount,
    completeness:  +((1 - missingCount / totalCells) * 100).toFixed(1),
  };
}

// ── Imputation Strategies ──────────────────────────────────

/**
 * Linear interpolation within a gap.
 * Only fills gaps shorter than maxGapSize rows; longer gaps use CPCB baseline.
 */
function imputeLinear(values, maxGapSize = 6) {
  const result   = [...values];
  const imputed  = new Set();
  let gapStart   = -1;

  for (let i = 0; i <= values.length; i++) {
    const v = i < values.length ? values[i] : null;
    const missing = v == null || isNaN(v);

    if (missing && gapStart === -1) { gapStart = i; }
    if (!missing && gapStart !== -1) {
      const gapLen = i - gapStart;
      const before = gapStart > 0 ? values[gapStart - 1] : v;
      const after  = v;

      if (gapLen <= maxGapSize && before != null && !isNaN(before)) {
        for (let j = gapStart; j < i; j++) {
          const t        = (j - gapStart + 1) / (gapLen + 1);
          result[j]      = +(before + t * (after - before)).toFixed(3);
          imputed.add(j);
        }
      }
      gapStart = -1;
    }
  }
  return { result, imputed };
}

/** Forward-fill: carry last valid value forward. */
function imputeForwardFill(values) {
  const result  = [...values];
  const imputed = new Set();
  let last = null;

  for (let i = 0; i < values.length; i++) {
    if (values[i] != null && !isNaN(values[i])) {
      last = values[i];
    } else if (last !== null) {
      result[i] = last;
      imputed.add(i);
    }
  }
  return { result, imputed };
}

/** Backward-fill: carry next valid value backward. */
function imputeBackwardFill(values) {
  const result  = [...values];
  const imputed = new Set();
  let next = null;

  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] != null && !isNaN(values[i])) {
      next = values[i];
    } else if (next !== null) {
      result[i] = next;
      imputed.add(i);
    }
  }
  return { result, imputed };
}

/** Rolling-window median fill (uses surrounding ±windowSize valid values). */
function imputeRollingMedian(values, windowSize = 12) {
  const result  = [...values];
  const imputed = new Set();

  for (let i = 0; i < values.length; i++) {
    if (values[i] != null && !isNaN(values[i])) continue;
    const window = [];
    for (let j = Math.max(0, i - windowSize); j <= Math.min(values.length - 1, i + windowSize); j++) {
      if (j !== i && values[j] != null && !isNaN(values[j])) window.push(values[j]);
    }
    if (window.length > 0) {
      result[i] = +median(window).toFixed(3);
      imputed.add(i);
    }
  }
  return { result, imputed };
}

/**
 * CPCB baseline fill: use the published monthly mean for the city/month
 * as a best-guess for long gaps where interpolation is not reliable.
 */
function imputeCPCBBaseline(values, timestamps, cityId, param) {
  if (!window.getCPCBValueAt) return imputeRollingMedian(values);

  const result  = [...values];
  const imputed = new Set();

  for (let i = 0; i < values.length; i++) {
    if (values[i] != null && !isNaN(values[i])) continue;
    if (!timestamps?.[i]) continue;
    const date = new Date(timestamps[i]);
    const baseline = window.getCPCBValueAt(cityId, param, date);
    if (baseline != null) {
      result[i] = +baseline.toFixed(3);
      imputed.add(i);
    }
  }
  return { result, imputed };
}

/** Season-hour mean: average value for same hour across all available days. */
function imputeSeasonalMean(values, timestamps) {
  const result    = [...values];
  const imputed   = new Set();
  const hourBucket= {};

  // Build hourly buckets from valid readings
  values.forEach((v, i) => {
    if (v == null || isNaN(v)) return;
    const h = timestamps?.[i] ? new Date(timestamps[i]).getHours() : 0;
    if (!hourBucket[h]) hourBucket[h] = [];
    hourBucket[h].push(v);
  });

  for (let i = 0; i < values.length; i++) {
    if (values[i] != null && !isNaN(values[i])) continue;
    const h = timestamps?.[i] ? new Date(timestamps[i]).getHours() : 0;
    const bucket = hourBucket[h];
    if (bucket?.length > 0) {
      result[i] = +median(bucket).toFixed(3);
      imputed.add(i);
    }
  }
  return { result, imputed };
}

// ═══════════════════════════════════════════════════════════
// SECTION 3 — OUTLIER DETECTION
// ═══════════════════════════════════════════════════════════

/**
 * Z-score outlier detection.
 * Flag values where |z| > threshold (default 3.0).
 */
function detectOutliersZScore(values, threshold = 3.0) {
  const v    = validValues(values);
  if (v.length < 4) return values.map(() => false);
  const mu   = mean(v);
  const sd   = stdDev(v);
  if (sd === 0) return values.map(() => false);
  return values.map(x => {
    if (x == null || isNaN(x)) return false;
    return Math.abs((x - mu) / sd) > threshold;
  });
}

/**
 * Modified Z-score (Iglewicz & Hoaglin 1993).
 * Uses MAD — more robust than standard Z-score for skewed distributions.
 * Flag values where |mZ| > threshold (default 3.5).
 */
function detectOutliersModifiedZ(values, threshold = 3.5) {
  const v   = validValues(values);
  if (v.length < 4) return values.map(() => false);
  const md  = median(v);
  const madv= mad(v);
  if (madv === 0) return detectOutliersZScore(values, threshold); // fallback
  return values.map(x => {
    if (x == null || isNaN(x)) return false;
    const mz = (0.6745 * (x - md)) / madv;
    return Math.abs(mz) > threshold;
  });
}

/**
 * Tukey IQR method.
 * Flag values below Q1 − k×IQR or above Q3 + k×IQR (default k=1.5).
 * k=3.0 = "far outlier" (more conservative).
 */
function detectOutliersIQR(values, k = 1.5) {
  const v  = validValues(values);
  if (v.length < 4) return values.map(() => false);
  const q1 = percentile(v, 25);
  const q3 = percentile(v, 75);
  const iq = q3 - q1;
  const lo = q1 - k * iq;
  const hi = q3 + k * iq;
  return values.map(x => {
    if (x == null || isNaN(x)) return false;
    return x < lo || x > hi;
  });
}

/**
 * Rate-of-change spike detection.
 * Flags a value if it changes by more than `multiplier` × rolling σ from the
 * previous value — catches sudden sensor spikes.
 */
function detectOutliersRateOfChange(values, multiplier = 5, windowSize = 8) {
  const result = values.map(() => false);
  for (let i = 1; i < values.length; i++) {
    if (values[i] == null || values[i - 1] == null) continue;
    const window = [];
    for (let j = Math.max(0, i - windowSize); j < i; j++) {
      if (values[j] != null && !isNaN(values[j])) window.push(values[j]);
    }
    if (window.length < 3) continue;
    const sd = stdDev(window);
    if (sd === 0) continue;
    const delta = Math.abs(values[i] - values[i - 1]);
    if (delta > multiplier * sd) result[i] = true;
  }
  return result;
}

/**
 * Physical range outlier detection using hard/soft bounds.
 */
function detectOutliersRange(param, values) {
  const uc = window.UnitConverter;
  return values.map(x => {
    if (x == null || isNaN(x)) return false;
    return uc ? uc.checkRange(param, x) === 'hard_outlier' : false;
  });
}

/**
 * Ensemble outlier detection: a point is an outlier if flagged by ≥ minVotes methods.
 * Returns array of booleans.
 */
function detectOutliersEnsemble(param, values, config = {}) {
  const {
    useZScore    = true,
    useModZ      = true,
    useIQR       = true,
    useRoC       = true,
    useRange     = true,
    zThreshold   = 3.0,
    modZThreshold= 3.5,
    iqrK         = 1.5,
    rocMult      = 5,
    minVotes     = 2,
  } = config;

  const votes = values.map(() => 0);
  if (useZScore) detectOutliersZScore(values, zThreshold)   .forEach((f, i) => f && votes[i]++);
  if (useModZ)  detectOutliersModifiedZ(values, modZThreshold).forEach((f, i) => f && votes[i]++);
  if (useIQR)   detectOutliersIQR(values, iqrK)             .forEach((f, i) => f && votes[i]++);
  if (useRoC)   detectOutliersRateOfChange(values, rocMult)  .forEach((f, i) => f && votes[i]++);
  if (useRange) detectOutliersRange(param, values)           .forEach((f, i) => f && votes[i]++);

  return votes.map(v => v >= minVotes);
}

// ── Outlier Treatment ──────────────────────────────────────

/**
 * Clip outliers to [Q1 − k×IQR, Q3 + k×IQR] bounds.
 * Returns { result, treated } where treated is the set of indices modified.
 */
function treatOutliersClip(values, outlierMask) {
  const v   = validValues(values.filter((_, i) => !outlierMask[i]));
  const q1  = percentile(v, 25);
  const q3  = percentile(v, 75);
  const iq  = (q1 != null && q3 != null) ? q3 - q1 : 0;
  const lo  = q1 != null ? q1 - 1.5 * iq : -Infinity;
  const hi  = q3 != null ? q3 + 1.5 * iq : Infinity;

  const result  = [...values];
  const treated = new Set();
  outlierMask.forEach((isOut, i) => {
    if (!isOut || values[i] == null) return;
    result[i] = +(Math.max(lo, Math.min(hi, values[i]))).toFixed(3);
    treated.add(i);
  });
  return { result, treated, bounds: { lo: +lo.toFixed(2), hi: +hi.toFixed(2) } };
}

/**
 * Replace outliers with linear interpolation from neighbours.
 */
function treatOutliersInterpolate(values, outlierMask) {
  const nulled = values.map((v, i) => outlierMask[i] ? null : v);
  const { result, imputed } = imputeLinear(nulled, 12);
  return { result, treated: imputed };
}

/**
 * Replace outliers with rolling median.
 */
function treatOutliersRollingMedian(values, outlierMask, windowSize = 8) {
  const nulled = values.map((v, i) => outlierMask[i] ? null : v);
  const { result, imputed } = imputeRollingMedian(nulled, windowSize);
  return { result, treated: imputed };
}

/**
 * Flag outliers: preserve value but mark row.
 * Returns { result, treated } where result is unchanged but treated marks indices.
 */
function treatOutliersFlag(values, outlierMask) {
  return { result: [...values], treated: new Set(outlierMask.reduce((a, f, i) => (f ? [...a, i] : a), [])) };
}

// ═══════════════════════════════════════════════════════════
// SECTION 4 — CROSS-PARAMETER CONSISTENCY CHECKS
// ═══════════════════════════════════════════════════════════

/**
 * Returns list of row indices where PM10 < PM2.5 (physically impossible).
 */
function checkPM10GePM25(data) {
  return data
    .map((row, i) => ({ i, pm25: row.pm25, pm10: row.pm10 }))
    .filter(r => r.pm25 != null && r.pm10 != null && !isNaN(r.pm25) && !isNaN(r.pm10) && r.pm10 < r.pm25)
    .map(r => r.i);
}

/**
 * Returns indices where AQI is wildly inconsistent with PM2.5
 * (|stored AQI − calculated AQI| > 50).
 */
function checkAQIvsPM25(data) {
  const uc = window.UnitConverter;
  if (!uc) return [];
  return data
    .map((row, i) => {
      if (row.pm25 == null || row.aqi == null) return null;
      const calcAQI = uc.pm25ToAQI(row.pm25);
      if (calcAQI == null) return null;
      return Math.abs(row.aqi - calcAQI) > 50 ? i : null;
    })
    .filter(i => i !== null);
}

/**
 * Runs all consistency checks. Returns { checks, violations }
 */
function checkConsistency(data) {
  const pm10GePM25      = checkPM10GePM25(data);
  const aqiVsPM25       = checkAQIvsPM25(data);

  return {
    checks: {
      pm10_ge_pm25:  { description: 'PM10 ≥ PM2.5',            violations: pm10GePM25,  count: pm10GePM25.length  },
      aqi_vs_pm25:   { description: 'AQI consistent with PM2.5', violations: aqiVsPM25,  count: aqiVsPM25.length   },
    },
    totalViolations: pm10GePM25.length + aqiVsPM25.length,
  };
}

/**
 * Fix PM10 < PM2.5 by setting PM10 = PM2.5 × median ratio.
 */
function fixPM10Consistency(data, violationIndices) {
  const ratios = data
    .filter(r => r.pm25 > 0 && r.pm10 >= r.pm25)
    .map(r => r.pm10 / r.pm25);
  const ratioMedian = ratios.length ? median(ratios) : 1.65;

  const result = data.map((row, i) => {
    if (!violationIndices.includes(i)) return row;
    const fixedPM10 = +(row.pm25 * ratioMedian).toFixed(1);
    return { ...row, pm10: fixedPM10, _pm10_fixed: true };
  });
  return result;
}

/**
 * Recalculate AQI from PM2.5 for inconsistent rows.
 */
function fixAQIConsistency(data, violationIndices) {
  const uc = window.UnitConverter;
  if (!uc) return data;
  return data.map((row, i) => {
    if (!violationIndices.includes(i)) return row;
    const newAQI = uc.pm25ToAQI(row.pm25);
    return newAQI != null ? { ...row, aqi: newAQI, _aqi_recalculated: true } : row;
  });
}

// ═══════════════════════════════════════════════════════════
// SECTION 5 — DIRTY DATA GENERATOR (for demo / testing)
// ═══════════════════════════════════════════════════════════

/**
 * Injects realistic data quality issues into a clean dataset.
 * Returns { dirty, injectionLog } so the pipeline can verify it finds everything.
 */
function injectIssues(cleanData, seed = 42) {
  // Simple seeded pseudo-random
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };

  const dirty       = cleanData.map(r => ({ ...r }));
  const log         = [];

  // ── 1. Missing values: clustered gaps (sensor offline) ──
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.06) { // ~6% chance to start a gap
      const gapLen = 1 + Math.floor(rand() * 4); // 1–4 consecutive
      const param  = ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'][Math.floor(rand() * 6)];
      for (let j = i; j < Math.min(i + gapLen, dirty.length); j++) {
        log.push({ index: j, type: 'missing', param, original: dirty[j][param] });
        dirty[j][param] = null;
      }
      i += gapLen - 1;
    }
  }

  // ── 2. Sentinel values (-999) scattered ─────────────────
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.025) {
      const param = ['pm25', 'no2'][Math.floor(rand() * 2)];
      log.push({ index: i, type: 'sentinel', param, original: dirty[i][param], injected: -999 });
      dirty[i][param] = -999;
    }
  }

  // ── 3. Outlier spikes (instrument noise / vehicle pass) ─
  for (let i = 2; i < dirty.length - 2; i++) {
    if (rand() < 0.035) {
      const param      = ['pm25', 'pm10', 'no2'][Math.floor(rand() * 3)];
      const original   = dirty[i][param];
      if (original == null) continue;
      const spike      = +(original * (4 + rand() * 12)).toFixed(1);
      log.push({ index: i, type: 'outlier_spike', param, original, injected: spike });
      dirty[i][param]  = spike;
    }
  }

  // ── 4. Negative values (ADC wraparound / calibration bug) ─
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.012) {
      const param    = ['pm25', 'pm10'][Math.floor(rand() * 2)];
      const original = dirty[i][param];
      if (original == null) continue;
      const neg      = -(rand() * 5).toFixed(1);
      log.push({ index: i, type: 'negative_value', param, original, injected: neg });
      dirty[i][param] = neg;
    }
  }

  // ── 5. Unit errors: CO in ppm instead of mg/m³ ──────────
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.04 && dirty[i].co != null) {
      const original = dirty[i].co;
      // ppm = mg/m³ × (VM25 / MW_CO) ≈ mg/m³ × 0.873
      const ppmValue = +(original * 0.873).toFixed(3);
      log.push({ index: i, type: 'unit_error', param: 'co', original, injected: ppmValue, fromUnit: 'ppm', toUnit: 'mg/m³' });
      dirty[i].co = ppmValue;
      dirty[i]._co_unit_hint = 'ppm';
    }
  }

  // ── 6. Temperature in °F ─────────────────────────────────
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.03 && dirty[i].temperature != null) {
      const original = dirty[i].temperature;
      const inF      = +(original * 9 / 5 + 32).toFixed(1);
      log.push({ index: i, type: 'unit_error', param: 'temperature', original, injected: inF, fromUnit: '°F', toUnit: '°C' });
      dirty[i].temperature = inF;
      dirty[i]._temp_unit_hint = '°F';
    }
  }

  // ── 7. PM10 < PM2.5 (inconsistent sensor calibration) ───
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.03 && dirty[i].pm25 != null && dirty[i].pm10 != null) {
      const original = dirty[i].pm10;
      const badPM10  = +(dirty[i].pm25 * (0.3 + rand() * 0.5)).toFixed(1);
      log.push({ index: i, type: 'consistency', param: 'pm10', original, injected: badPM10, rule: 'PM10 < PM2.5' });
      dirty[i].pm10  = badPM10;
    }
  }

  // ── 8. AQI inconsistent with PM2.5 (copy-paste error) ───
  for (let i = 0; i < dirty.length; i++) {
    if (rand() < 0.02 && dirty[i].aqi != null) {
      const original = dirty[i].aqi;
      const wrongAQI = Math.floor(rand() * 500);
      if (Math.abs(wrongAQI - original) > 60) {
        log.push({ index: i, type: 'consistency', param: 'aqi', original, injected: wrongAQI, rule: 'AQI ≠ f(PM2.5)' });
        dirty[i].aqi = wrongAQI;
      }
    }
  }

  return { dirty, injectionLog: log };
}

// ── Compute overall quality score (0–100) ─────────────────
function computeQualityScore(data, params = ['pm25','pm10','no2','so2','o3','co']) {
  const missing  = detectMissing(data, params);
  const cons     = checkConsistency(data);

  let outlierCount = 0;
  params.forEach(p => {
    const vals = data.map(r => r[p]);
    detectOutliersEnsemble(p, vals, { minVotes: 2 }).forEach(f => f && outlierCount++);
  });

  const totalCells    = data.length * params.length;
  const completeness  = missing.completeness;
  const validityPct   = +((1 - outlierCount / totalCells) * 100).toFixed(1);
  const consPct       = +((1 - cons.totalViolations / data.length) * 100).toFixed(1);

  const overall = +(completeness * 0.40 + validityPct * 0.35 + consPct * 0.25).toFixed(1);
  return { completeness, validityPct, consPct, overall, outlierCount, totalCells };
}

// ── Exports ───────────────────────────────────────────────
window.Cleaner = {
  // Stats
  mean, median, stdDev, mad, percentile, computeStats,
  // Missing
  detectMissing,
  imputeLinear, imputeForwardFill, imputeBackwardFill,
  imputeRollingMedian, imputeCPCBBaseline, imputeSeasonalMean,
  // Outlier detection
  detectOutliersZScore, detectOutliersModifiedZ, detectOutliersIQR,
  detectOutliersRateOfChange, detectOutliersRange, detectOutliersEnsemble,
  // Outlier treatment
  treatOutliersClip, treatOutliersInterpolate,
  treatOutliersRollingMedian, treatOutliersFlag,
  // Consistency
  checkConsistency, fixPM10Consistency, fixAQIConsistency,
  // Utilities
  injectIssues, computeQualityScore,
};

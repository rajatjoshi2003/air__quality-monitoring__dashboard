/**
 * DataPipeline — Configurable preprocessing pipeline
 *
 * Usage:
 *   const result = new DataPipeline(rawData, { city: 'delhi' })
 *     .run({ missing: 'interpolate', outliers: 'clip', outlierMethod: 'ensemble' });
 *
 * Each step records structured audit entries; generateReport() returns a
 * complete before/after quality comparison and per-row change log.
 */

const PIPELINE_PARAMS = ['pm25', 'pm10', 'no2', 'so2', 'o3', 'co', 'aqi', 'temperature', 'humidity'];

// ── Default pipeline configuration ───────────────────────
const DEFAULT_CONFIG = {
  city:            'delhi',
  params:          PIPELINE_PARAMS,
  // Step toggles
  runUnitCheck:    true,
  runMissing:      true,
  runOutliers:     true,
  runConsistency:  true,
  runRangeCheck:   true,
  // Missing strategy: 'interpolate' | 'forward_fill' | 'backward_fill' | 'rolling_median' | 'cpcb_baseline' | 'seasonal_mean' | 'flag_only'
  missingStrategy: 'interpolate',
  maxGapInterp:    6,   // max consecutive missing points for linear interpolation
  // Outlier detection: 'zscore' | 'modifiedz' | 'iqr' | 'ensemble'
  outlierMethod:   'ensemble',
  zThreshold:      3.0,
  modZThreshold:   3.5,
  iqrK:            1.5,
  rocMult:         5,
  minVotes:        2,
  // Outlier treatment: 'clip' | 'interpolate' | 'rolling_median' | 'flag_only'
  outlierTreatment:'clip',
  // Unit check confidence threshold (0–1): below this → convert
  unitConfidence:  0.75,
};

class DataPipeline {
  constructor(rawData, config = {}) {
    this.raw    = rawData.map(r => ({ ...r }));          // immutable copy of input
    this.data   = rawData.map(r => ({ ...r }));          // working copy
    this.cfg    = { ...DEFAULT_CONFIG, ...config };
    this.audit  = [];    // ordered log of every action
    this.timing = {};    // ms per step
    this._stepN = 0;
    this.stats  = { before: null, after: null };
  }

  // ── Internal helpers ────────────────────────────────────

  _log(step, type, param, index, before, after, meta = {}) {
    this.audit.push({ step, type, param, index, before, after, ...meta });
  }

  _time(name, fn) {
    const t0 = performance.now();
    fn();
    this.timing[name] = +(performance.now() - t0).toFixed(1);
  }

  _counts() {
    return window.Cleaner?.computeQualityScore(this.data, this.cfg.params) || {};
  }

  // ════════════════════════════════════════════════════════
  // STEP 1 — Sentinel / NaN normalization
  // Converts -999, null, NaN, undefined → null so downstream
  // steps see a consistent representation of "missing".
  // ════════════════════════════════════════════════════════
  stepNormalizeSentinels() {
    this._time('sentinels', () => {
      const uc = window.UnitConverter;
      let count = 0;
      this.data.forEach((row, i) => {
        this.cfg.params.forEach(p => {
          const v = row[p];
          if (uc?.isSentinel(v) || (typeof v === 'number' && isNaN(v))) {
            this._log('sentinels', 'sentinel→null', p, i, v, null);
            this.data[i][p] = null;
            count++;
          }
        });
      });
      this._log('sentinels', 'summary', null, null, null, null, {
        message: `Converted ${count} sentinel / NaN values to null`,
        count,
      });
    });
    return this;
  }

  // ════════════════════════════════════════════════════════
  // STEP 2 — Unit standardization
  // Detects values that appear to be in the wrong unit
  // (ppb, ppm, °F, K, mg/m³ for PM) and converts them.
  // ════════════════════════════════════════════════════════
  stepStandardizeUnits() {
    this._time('units', () => {
      const uc    = window.UnitConverter;
      if (!uc) return;
      let count   = 0;

      this.data.forEach((row, i) => {
        this.cfg.params.forEach(p => {
          const v = row[p];
          if (v == null || isNaN(v)) return;

          // Use unit hints from IoT simulator if available
          let hint = null;
          if (p === 'co'          && row._co_unit_hint)   hint = row._co_unit_hint;
          if (p === 'temperature' && row._temp_unit_hint) hint = row._temp_unit_hint;

          if (hint) {
            const converted = uc.toStandardUnit(p, v, hint);
            if (converted !== v) {
              this._log('units', 'unit_conversion', p, i, v, converted, { fromUnit: hint, confidence: 1.0 });
              this.data[i][p] = converted;
              count++;
            }
            return;
          }

          // Auto-detect
          const detection = uc.detectUnit(p, v);
          if (detection.needsConversion && detection.confidence >= this.cfg.unitConfidence) {
            const cv = detection.convertedValue ?? uc.toStandardUnit(p, v, detection.detectedUnit);
            this._log('units', 'unit_conversion', p, i, v, cv, {
              fromUnit:   detection.detectedUnit,
              toUnit:     detection.targetUnit,
              confidence: detection.confidence,
            });
            this.data[i][p] = cv;
            count++;
          }
        });
      });

      this._log('units', 'summary', null, null, null, null, {
        message: `Corrected ${count} unit mismatches across ${this.cfg.params.length} parameters`,
        count,
      });
    });
    return this;
  }

  // ════════════════════════════════════════════════════════
  // STEP 3 — Physical range validation
  // Hard-outliers (impossible values) are nulled; soft-outliers
  // are flagged but kept for the outlier step to treat.
  // ════════════════════════════════════════════════════════
  stepValidateRanges() {
    this._time('ranges', () => {
      const uc = window.UnitConverter;
      if (!uc) return;
      let hard = 0, soft = 0;

      this.data.forEach((row, i) => {
        this.cfg.params.forEach(p => {
          const v = row[p];
          if (v == null || isNaN(v)) return;
          const status = uc.checkRange(p, v);
          if (status === 'hard_outlier') {
            this._log('ranges', 'hard_outlier→null', p, i, v, null, { status });
            this.data[i][p] = null;
            hard++;
          } else if (status === 'soft_outlier') {
            this._log('ranges', 'soft_outlier_flagged', p, i, v, v, { status });
            this.data[i][`_flag_${p}`] = 'soft_outlier';
            soft++;
          }
        });
      });

      this._log('ranges', 'summary', null, null, null, null, {
        message: `Range check: ${hard} hard outliers nulled, ${soft} soft outliers flagged`,
        hardCount: hard, softCount: soft,
      });
    });
    return this;
  }

  // ════════════════════════════════════════════════════════
  // STEP 4 — Outlier detection & treatment
  // ════════════════════════════════════════════════════════
  stepHandleOutliers() {
    this._time('outliers', () => {
      const C   = window.Cleaner;
      if (!C) return;
      let totalDetected = 0, totalTreated = 0;

      this.cfg.params.filter(p => !['aqi','temperature','humidity'].includes(p)).forEach(p => {
        const values = this.data.map(r => r[p]);
        let mask;

        switch (this.cfg.outlierMethod) {
          case 'zscore':   mask = C.detectOutliersZScore(values, this.cfg.zThreshold);   break;
          case 'modifiedz':mask = C.detectOutliersModifiedZ(values, this.cfg.modZThreshold); break;
          case 'iqr':      mask = C.detectOutliersIQR(values, this.cfg.iqrK);            break;
          default:         mask = C.detectOutliersEnsemble(p, values, {
            zThreshold:    this.cfg.zThreshold,
            modZThreshold: this.cfg.modZThreshold,
            iqrK:          this.cfg.iqrK,
            rocMult:       this.cfg.rocMult,
            minVotes:      this.cfg.minVotes,
          });
        }

        const detected = mask.filter(Boolean).length;
        totalDetected += detected;
        if (detected === 0) return;

        let treated;
        switch (this.cfg.outlierTreatment) {
          case 'interpolate':    treated = C.treatOutliersInterpolate(values, mask); break;
          case 'rolling_median': treated = C.treatOutliersRollingMedian(values, mask); break;
          case 'flag_only':      treated = C.treatOutliersFlag(values, mask); break;
          default:               treated = C.treatOutliersClip(values, mask);
        }

        // Apply to data and log
        treated.treated.forEach(i => {
          const before = this.data[i][p];
          const after  = treated.result[i];
          this.data[i][p] = after;
          this.data[i][`_outlier_${p}`] = true;
          this._log('outliers', this.cfg.outlierTreatment, p, i, before, after, {
            method: this.cfg.outlierMethod,
            bounds: treated.bounds,
          });
          totalTreated++;
        });
      });

      this._log('outliers', 'summary', null, null, null, null, {
        message: `Outliers: ${totalDetected} detected, ${totalTreated} treated via '${this.cfg.outlierTreatment}'`,
        detected: totalDetected, treated: totalTreated,
      });
    });
    return this;
  }

  // ════════════════════════════════════════════════════════
  // STEP 5 — Missing value imputation
  // ════════════════════════════════════════════════════════
  stepHandleMissing() {
    this._time('missing', () => {
      const C          = window.Cleaner;
      if (!C) return;
      const timestamps = this.data.map(r => r.timestamp);
      let totalImputed = 0;

      this.cfg.params.forEach(p => {
        const values = this.data.map(r => r[p]);
        const hasMissing = values.some(v => v == null || isNaN(v));
        if (!hasMissing) return;

        let result, imputed;

        switch (this.cfg.missingStrategy) {
          case 'forward_fill':
            ({ result, imputed } = C.imputeForwardFill(values));
            break;
          case 'backward_fill':
            ({ result, imputed } = C.imputeBackwardFill(values));
            break;
          case 'rolling_median':
            ({ result, imputed } = C.imputeRollingMedian(values, 12));
            break;
          case 'cpcb_baseline':
            ({ result, imputed } = C.imputeCPCBBaseline(values, timestamps, this.cfg.city, p));
            // Fall back to rolling median for anything not covered by baseline
            if (imputed.size < values.filter(v => v == null).length) {
              const partial = result;
              const fb = C.imputeRollingMedian(partial, 12);
              fb.imputed.forEach(i => { if (!imputed.has(i)) imputed.add(i); });
              result = fb.result;
            }
            break;
          case 'seasonal_mean':
            ({ result, imputed } = C.imputeSeasonalMean(values, timestamps));
            break;
          case 'flag_only':
            result  = values;
            imputed = new Set();
            break;
          default: // 'interpolate' + rolling_median fallback for long gaps
            ({ result, imputed } = C.imputeLinear(values, this.cfg.maxGapInterp));
            // Fill remaining with rolling median
            if (result.some(v => v == null)) {
              const fb = C.imputeRollingMedian(result, 12);
              fb.imputed.forEach(i => { if (!imputed.has(i)) imputed.add(i); });
              result = fb.result;
            }
        }

        imputed.forEach(i => {
          const before = this.raw[i]?.[p] ?? null;
          const after  = result[i];
          this.data[i][p]            = after;
          this.data[i][`_imputed_${p}`] = true;
          this._log('missing', 'imputed', p, i, before, after, { strategy: this.cfg.missingStrategy });
          totalImputed++;
        });
      });

      this._log('missing', 'summary', null, null, null, null, {
        message: `Missing values: ${totalImputed} imputed using '${this.cfg.missingStrategy}'`,
        count: totalImputed,
      });
    });
    return this;
  }

  // ════════════════════════════════════════════════════════
  // STEP 6 — Cross-parameter consistency
  // ════════════════════════════════════════════════════════
  stepCheckConsistency() {
    this._time('consistency', () => {
      const C   = window.Cleaner;
      if (!C) return;
      const con = C.checkConsistency(this.data);

      // Fix PM10 < PM2.5
      if (con.checks.pm10_ge_pm25.count > 0) {
        const fixed = C.fixPM10Consistency(this.data, con.checks.pm10_ge_pm25.violations);
        fixed.forEach((row, i) => {
          if (row._pm10_fixed) {
            this._log('consistency', 'pm10_corrected', 'pm10', i,
              this.data[i].pm10, row.pm10, { rule: 'PM10 < PM2.5 → set to median ratio × PM2.5' });
            this.data[i] = row;
          }
        });
      }

      // Fix AQI ≠ f(PM2.5)
      if (con.checks.aqi_vs_pm25.count > 0) {
        const fixed = C.fixAQIConsistency(this.data, con.checks.aqi_vs_pm25.violations);
        fixed.forEach((row, i) => {
          if (row._aqi_recalculated) {
            this._log('consistency', 'aqi_recalculated', 'aqi', i,
              this.data[i].aqi, row.aqi, { rule: 'AQI recalculated from PM2.5 (US EPA formula)' });
            this.data[i] = row;
          }
        });
      }

      this._log('consistency', 'summary', null, null, null, null, {
        message: `Consistency: ${con.checks.pm10_ge_pm25.count} PM10<PM2.5 fixed, ${con.checks.aqi_vs_pm25.count} AQI recalculated`,
        pm10Violations: con.checks.pm10_ge_pm25.count,
        aqiViolations:  con.checks.aqi_vs_pm25.count,
      });
    });
    return this;
  }

  // ════════════════════════════════════════════════════════
  // RUN FULL PIPELINE
  // ════════════════════════════════════════════════════════
  run(overrides = {}) {
    Object.assign(this.cfg, overrides);
    const C = window.Cleaner;
    this.stats.before = C ? C.computeQualityScore(this.raw, this.cfg.params) : {};

    this.stepNormalizeSentinels();
    if (this.cfg.runUnitCheck)   this.stepStandardizeUnits();
    if (this.cfg.runRangeCheck)  this.stepValidateRanges();
    if (this.cfg.runOutliers)    this.stepHandleOutliers();
    if (this.cfg.runMissing)     this.stepHandleMissing();
    if (this.cfg.runConsistency) this.stepCheckConsistency();

    this.stats.after  = C ? C.computeQualityScore(this.data, this.cfg.params) : {};
    return this;
  }

  // ════════════════════════════════════════════════════════
  // REPORT
  // ════════════════════════════════════════════════════════
  generateReport() {
    const summaries = this.audit.filter(e => e.type === 'summary');
    const byType    = {};
    this.audit.filter(e => e.type !== 'summary').forEach(e => {
      byType[e.type] = (byType[e.type] || 0) + 1;
    });

    const changesByParam = {};
    this.cfg.params.forEach(p => {
      changesByParam[p] = this.audit.filter(e => e.param === p && e.type !== 'summary').length;
    });

    return {
      config:        this.cfg,
      timing:        this.timing,
      totalAuditEntries: this.audit.length,
      totalChanges:  this.audit.filter(e => e.type !== 'summary').length,
      byType,
      changesByParam,
      summaries:     summaries.map(s => s.message),
      qualityBefore: this.stats.before,
      qualityAfter:  this.stats.after,
      qualityGain:   this.stats.after?.overall != null && this.stats.before?.overall != null
        ? +(this.stats.after.overall - this.stats.before.overall).toFixed(1)
        : null,
      auditLog:      this.audit,
    };
  }

  /** Returns the cleaned dataset. */
  getCleanData() { return this.data; }

  /** Returns only rows that had at least one change. */
  getChangedRows() {
    const changedIndices = new Set(this.audit.filter(e => e.index != null).map(e => e.index));
    return this.data.filter((_, i) => changedIndices.has(i));
  }
}

// ── Convenience runner ────────────────────────────────────
function runPipeline(rawData, config = {}) {
  const p = new DataPipeline(rawData, config);
  p.run();
  return { pipeline: p, report: p.generateReport(), clean: p.getCleanData() };
}

window.DataPipeline = DataPipeline;
window.runPipeline  = runPipeline;

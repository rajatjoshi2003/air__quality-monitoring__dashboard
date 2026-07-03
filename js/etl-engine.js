/**
 * etl-engine.js — Pipeline orchestration for the ETL system
 *
 * Manages:
 *   - Job definitions (source + steps + targets)
 *   - Async execution with per-step progress emission
 *   - Job history (last 20 runs)
 *   - Named dataset registry (for JOIN operator)
 *   - Preview mode (processes first 200 rows only)
 *   - Error recovery (continue on step failure in lenient mode)
 */

const ETL_ENGINE = (() => {

  // ─── Job history & dataset registry ──────────────────────

  const _history  = [];   // [{id, name, status, startedAt, duration, rowsIn, rowsOut, steps, log}]
  const _datasets = {};   // name → { rows, headers }
  let   _jobSeq   = 0;

  // ─── Progress bus ─────────────────────────────────────────

  let _progressCb = null;
  function onProgress(cb) { _progressCb = cb; }

  function emit(event) {
    if (_progressCb) { try { _progressCb(event); } catch {} }
  }

  // ─── Job schema ───────────────────────────────────────────

  /**
   * Job definition:
   * {
   *   id?:      string,
   *   name?:    string,
   *   preview?: boolean,     // if true, process only first 200 rows
   *   lenient?: boolean,     // if true, log step errors instead of aborting
   *   source: {
   *     type: 'csv_file'|'json_file'|'current'|'iot'|'cpcb'|'sqlite'|'api',
   *     ...source-specific config
   *   },
   *   steps: [
   *     { op: 'field_map'|'type_coerce'|..., config: {...} },
   *     ...
   *   ],
   *   targets: [
   *     { type: 'csv_export'|'dashboard_state'|'sqlite_measurements'|..., config: {...} },
   *   ],
   * }
   */

  // ─── Core runner ──────────────────────────────────────────

  async function run(jobDef) {
    const jobId   = ++_jobSeq;
    const startTs = Date.now();
    const name    = jobDef.name || `Job #${jobId}`;
    const preview = jobDef.preview || false;
    const lenient = jobDef.lenient !== false; // default lenient

    const entry = {
      id: jobId, name, status: 'running',
      startedAt: new Date().toISOString(), steps: [],
      rowsIn: 0, rowsOut: 0, log: [],
    };
    _history.unshift(entry);
    if (_history.length > 20) _history.pop();

    emit({ type: 'start', jobId, name });

    try {
      // ── Extract ──────────────────────────────────────────
      emit({ type: 'extract_start', jobId });
      let extracted;
      try {
        extracted = await _extract(jobDef.source);
      } catch (e) {
        throw new Error(`Extract failed: ${e.message}`);
      }

      let rows   = extracted.rows;
      const allRows = rows.length;
      if (preview && rows.length > 200) rows = rows.slice(0, 200);
      entry.rowsIn = allRows;

      emit({ type: 'extract_done', jobId, rowCount: allRows, previewCount: rows.length,
             headers: extracted.headers, mapping: extracted.mapping });

      // ── Transform steps ──────────────────────────────────
      const steps = jobDef.steps || [];
      for (let si = 0; si < steps.length; si++) {
        const stepDef = steps[si];
        const stepLabel = `${si + 1}/${steps.length}: ${stepDef.op}`;
        emit({ type:'step_start', jobId, step: si, op: stepDef.op, label: stepLabel });

        const t0 = performance.now();
        let stepResult;
        try {
          stepResult = await ETL_TRANSFORM.runOperator(
            stepDef.op,
            rows,
            stepDef.config || {},
            pct => emit({ type:'step_progress', jobId, step: si, pct })
          );
          rows = stepResult.rows;
          const duration = Math.round(performance.now() - t0);
          const stepInfo = { op: stepDef.op, rowsIn: rows.length, rowsOut: stepResult.rows.length,
                             log: stepResult.log, duration };
          entry.steps.push(stepInfo);
          entry.log.push(...(stepResult.log || []));
          emit({ type:'step_done', jobId, step: si, op: stepDef.op, rowsOut: rows.length, duration, log: stepResult.log });
        } catch (e) {
          const info = `Step ${stepLabel} failed: ${e.message}`;
          entry.steps.push({ op: stepDef.op, error: e.message });
          entry.log.push({ type:'error', step: stepDef.op, message: e.message });
          emit({ type:'step_error', jobId, step: si, op: stepDef.op, error: e.message });
          if (!lenient) throw new Error(info);
        }
      }

      // ── Load targets ─────────────────────────────────────
      const targets = jobDef.targets || [];
      const loadResults = [];
      for (const targetDef of targets) {
        emit({ type:'load_start', jobId, target: targetDef.type });
        try {
          const result = await ETL_LOAD.load(
            targetDef.type, rows,
            targetDef.config || {},
            pct => emit({ type:'load_progress', jobId, target: targetDef.type, pct })
          );
          loadResults.push(result);
          emit({ type:'load_done', jobId, target: targetDef.type, result });
        } catch (e) {
          emit({ type:'load_error', jobId, target: targetDef.type, error: e.message });
          if (!lenient) throw new Error(`Load to ${targetDef.type} failed: ${e.message}`);
        }
      }

      // ── Finish ───────────────────────────────────────────
      entry.rowsOut   = rows.length;
      entry.status    = 'completed';
      entry.duration  = Math.round(Date.now() - startTs);
      entry.loadResults = loadResults;

      emit({ type:'done', jobId, name, rowsIn: allRows, rowsOut: rows.length,
             duration: entry.duration, loadResults, steps: entry.steps });

      return { rows, entry, loadResults };

    } catch (e) {
      entry.status   = 'failed';
      entry.error    = e.message;
      entry.duration = Math.round(Date.now() - startTs);
      emit({ type:'error', jobId, error: e.message });
      throw e;
    }
  }

  // ─── Extract dispatcher ───────────────────────────────────

  async function _extract(srcDef) {
    if (!srcDef) throw new Error('No source defined');
    switch (srcDef.type) {
      case 'csv_file':   return ETL_EXTRACT.fromCSVFile(srcDef.file);
      case 'json_file':  return ETL_EXTRACT.fromJSONFile(srcDef.file);
      case 'current':    return ETL_EXTRACT.fromCurrentState(window.state?.data, window.state?.city);
      case 'iot':        return ETL_EXTRACT.fromIoT(srcDef.city || window.state?.city, srcDef.hours || 24);
      case 'cpcb':       return ETL_EXTRACT.fromCPCB(srcDef.city || window.state?.city, srcDef.year, srcDef.params);
      case 'sqlite':     return ETL_EXTRACT.fromSQLite(srcDef.sql || 'SELECT * FROM vw_latest_measurements LIMIT 1000');
      case 'api':        return ETL_EXTRACT.fromAPI(srcDef.city, srcDef.param, srcDef.hours || 24);
      case 'raw':        return { rows: srcDef.rows, headers: Object.keys(srcDef.rows[0]||{}), mapping: [] };
      default: throw new Error(`Unknown source type: ${srcDef.type}`);
    }
  }

  // ─── Preview (first 200 rows, no targets) ─────────────────

  async function preview(jobDef) {
    return run({ ...jobDef, preview: true, targets: [] });
  }

  // ─── Named dataset registry (for JOIN) ───────────────────

  function registerDataset(name, rows, headers) { _datasets[name] = { rows, headers }; }
  function getDataset(name) { return _datasets[name]; }
  function listDatasets()   { return Object.keys(_datasets); }

  // ─── Job history ──────────────────────────────────────────

  function getHistory() { return [..._history]; }
  function getJob(id)   { return _history.find(j => j.id === id); }
  function clearHistory(){ _history.length = 0; }

  // ─── Built-in job templates ───────────────────────────────

  const TEMPLATES = {
    'cpcb_to_db': {
      name: 'CPCB Historical → Database',
      desc: 'Load embedded CPCB 2019–2023 monthly data into the SQLite monthly_aggregates table.',
      source: { type:'cpcb' },
      steps: [
        { op:'quality_score', config:{ param_cols:'pm25,pm10,no2,so2,o3,co' } },
      ],
      targets: [{ type:'sqlite_monthly', config:{} }],
    },
    'iot_to_dashboard': {
      name: 'IoT Sensor → Dashboard',
      desc: 'Read live IoT simulator readings, clean, compute AQI, and apply to dashboard.',
      source: { type:'iot', hours: 24 },
      steps: [
        { op:'timestamp_norm',  config:{ source_col:'timestamp', target_col:'timestamp_utc' } },
        { op:'filter',          config:{ conditions:[{col:'quality_flag',op:'neq',val:'MISSING'}], mode:'AND' } },
        { op:'unit_convert',    config:{ auto_detect: true } },
        { op:'enrich_aqi',      config:{} },
        { op:'quality_score',   config:{} },
      ],
      targets: [{ type:'dashboard_state', config:{} }],
    },
    'csv_wide_to_db': {
      name: 'Wide CSV → SQLite measurements',
      desc: 'Map columns from a wide-format CSV, normalise timestamps, convert units, then insert into the database.',
      source: { type:'csv_file' },
      steps: [
        { op:'field_map',       config:{ mapping:{} } },
        { op:'timestamp_norm',  config:{ source_col:'timestamp' } },
        { op:'unit_convert',    config:{ auto_detect: true } },
        { op:'deduplicate',     config:{ key_cols:'station_code,timestamp_utc', keep:'last' } },
        { op:'enrich_aqi',      config:{} },
        { op:'enrich_geo',      config:{} },
        { op:'quality_score',   config:{} },
      ],
      targets: [
        { type:'sqlite_measurements', config:{} },
        { type:'csv_export',          config:{ filename:'cleaned-output.csv' } },
      ],
    },
    'long_to_wide_agg': {
      name: 'Long-format → Wide daily aggregates',
      desc: 'Pivot long-format pollutant readings, aggregate to daily level, then export.',
      source: { type:'csv_file' },
      steps: [
        { op:'timestamp_norm',  config:{ source_col:'date' } },
        { op:'pivot',           config:{ id_cols:'timestamp_utc,station_code', pivot_col:'parameter', value_col:'value' } },
        { op:'aggregate',       config:{ time_bin:'day', group_cols:'station_code', value_cols:'pm25,pm10,no2', fns:['mean','min','max','count'] } },
        { op:'enrich_aqi',      config:{} },
        { op:'quality_score',   config:{} },
      ],
      targets: [
        { type:'json_export', config:{} },
      ],
    },
    'current_hourly': {
      name: 'Dashboard data → Hourly CSV',
      desc: 'Take current state.data, aggregate to hourly level, and export as CSV.',
      source: { type:'current' },
      steps: [
        { op:'timestamp_norm',  config:{ source_col:'timestamp' } },
        { op:'aggregate',       config:{ time_bin:'hour', group_cols:'', value_cols:'pm25,pm10,no2,so2,o3,co,aqi', fns:['mean','min','max'] } },
      ],
      targets: [{ type:'csv_export', config:{ filename:'hourly-aggregates.csv' } }],
    },
  };

  function listTemplates() {
    return Object.entries(TEMPLATES).map(([id,t]) => ({ id, name: t.name, desc: t.desc }));
  }
  function getTemplate(id) { return TEMPLATES[id] ? JSON.parse(JSON.stringify(TEMPLATES[id])) : null; }

  return {
    run, preview, onProgress,
    registerDataset, getDataset, listDatasets,
    getHistory, getJob, clearHistory,
    listTemplates, getTemplate,
  };

})();

window.ETL_ENGINE = ETL_ENGINE;

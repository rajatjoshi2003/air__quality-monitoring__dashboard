/**
 * etl-load.js — Target connectors for the ETL pipeline
 *
 * Supported targets:
 *   sqlite_measurements — bulk-insert into the AQI SQLite database
 *   sqlite_monthly      — upsert into monthly_aggregates
 *   dashboard_state     — set as the active dashboard dataset (state.data)
 *   csv_export          — download as CSV file
 *   json_export         — download as JSON file
 *   memory              — hold in ETL_LOAD.lastResult for inspection
 */

const ETL_LOAD = (() => {

  let _lastResult = null;

  // ─── Helpers ─────────────────────────────────────────────

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function rowsToCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const lines   = [headers.join(',')];
    rows.forEach(r => {
      lines.push(headers.map(h => {
        const v = r[h];
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(','));
    });
    return lines.join('\n');
  }

  // ─── Load targets ─────────────────────────────────────────

  async function toCSVExport(rows, config = {}) {
    const { filename = `aqi-export-${Date.now()}.csv` } = config;
    const csv  = rowsToCSV(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, filename);
    return { target: 'csv_export', rowsWritten: rows.length, filename };
  }

  async function toJSONExport(rows, config = {}) {
    const { filename = `aqi-export-${Date.now()}.json`, pretty = true } = config;
    const json = pretty ? JSON.stringify(rows, null, 2) : JSON.stringify(rows);
    const blob = new Blob([json], { type: 'application/json' });
    downloadBlob(blob, filename);
    return { target: 'json_export', rowsWritten: rows.length, filename };
  }

  async function toMemory(rows) {
    _lastResult = rows;
    return { target: 'memory', rowsWritten: rows.length };
  }

  async function toDashboardState(rows, config = {}) {
    const { city, timeRange } = config;
    if (!window.state) throw new Error('Dashboard state not available');

    // Map ETL rows → dashboard state.data schema
    const mapped = rows.map(r => {
      const ts = r.timestamp_utc || r.timestamp || r.date || new Date().toISOString();
      return {
        timestamp:   new Date(ts).getTime(),
        aqi:         parseFloat(r.aqi)          || null,
        pm25:        parseFloat(r.pm25)         || null,
        pm10:        parseFloat(r.pm10)         || null,
        no2:         parseFloat(r.no2)          || null,
        so2:         parseFloat(r.so2)          || null,
        o3:          parseFloat(r.o3)           || null,
        co:          parseFloat(r.co)           || null,
        temperature: parseFloat(r.temperature)  || null,
        humidity:    parseFloat(r.humidity)     || null,
        source:      r.source_type || 'etl',
      };
    }).filter(r => r.timestamp && !isNaN(r.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!mapped.length) throw new Error('No valid rows to load into dashboard');

    window.state.data = mapped;
    if (city)     window.state.city      = city;

    // Re-render the current view
    if (typeof renderOverview === 'function') renderOverview();
    if (typeof refreshData   === 'function') refreshData();

    return { target: 'dashboard_state', rowsWritten: mapped.length };
  }

  async function toSQLiteMeasurements(rows, config = {}, onProgress) {
    if (!window.AQI_DB?.isReady()) throw new Error('Database not initialized — seed it first');
    const { station_col='station_code', city_col='city', batchSize=500 } = config;

    // Resolve parameter → parameter_id map
    const paramRes = AQI_DB.query('SELECT code, parameter_id FROM parameters');
    const paramMap = Object.fromEntries(paramRes.rows.map(([code,id])=>[code,id]));

    // Resolve station codes → station_id
    const stnRes = AQI_DB.query('SELECT station_code, station_id FROM stations');
    const stnMap = Object.fromEntries(stnRes.rows.map(([code,id])=>[code,id]));

    // Resolve source_id for ETL
    let srcId = AQI_DB.query("SELECT source_id FROM data_sources WHERE source_type='derived' OR name LIKE '%ETL%' LIMIT 1").rows[0]?.[0];
    if (!srcId) {
      AQI_DB.run("INSERT OR IGNORE INTO data_sources (name,source_type,is_active,records_fetched) VALUES ('ETL Pipeline','derived',1,0)");
      srcId = AQI_DB.lastInsertId();
    }

    const PARAMS = ['pm25','pm10','no2','so2','o3','co','temperature','humidity','aqi'];
    const insertRows = [];
    let skipped = 0;

    rows.forEach(r => {
      const ts      = r.timestamp_utc || r.timestamp || r.date;
      const stnCode = r[station_col];
      if (!ts || !stnCode) { skipped++; return; }
      const stnId = stnMap[stnCode];
      if (!stnId) { skipped++; return; }
      const isoTs = new Date(ts).toISOString();

      PARAMS.forEach(param => {
        const v = parseFloat(r[param]);
        if (isNaN(v) || !paramMap[param]) return;
        insertRows.push([
          stnId, paramMap[param], null, srcId,
          isoTs, null,
          +v.toFixed(4), +v.toFixed(4),
          null,
          r.quality_flag || 'VALID',
          r.is_imputed   ? 1 : 0,
          r.is_outlier   ? 1 : 0,
        ]);
      });
    });

    const sql = `INSERT OR IGNORE INTO measurements
      (station_id,parameter_id,sensor_id,source_id,timestamp_utc,timestamp_local,
       value,raw_value,unit,quality_flag,is_imputed,is_outlier)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

    let inserted = 0;
    for (let i = 0; i < insertRows.length; i += batchSize) {
      onProgress?.((i / insertRows.length) * 0.9);
      inserted += AQI_DB.runBulk(sql, insertRows.slice(i, i + batchSize));
    }

    // Update records_fetched counter
    if (srcId) AQI_DB.run('UPDATE data_sources SET records_fetched=records_fetched+? WHERE source_id=?', [inserted, srcId]);

    return { target: 'sqlite_measurements', rowsWritten: inserted, skipped, totalAttempted: insertRows.length };
  }

  async function toSQLiteMonthlyAgg(rows, config = {}, onProgress) {
    if (!window.AQI_DB?.isReady()) throw new Error('Database not initialized');
    const { station_col='station_code', year_col='year', month_col='month', source='etl' } = config;

    const paramRes = AQI_DB.query('SELECT code, parameter_id FROM parameters');
    const paramMap = Object.fromEntries(paramRes.rows.map(([code,id])=>[code,id]));
    const stnRes   = AQI_DB.query('SELECT station_code, station_id FROM stations');
    const stnMap   = Object.fromEntries(stnRes.rows.map(([code,id])=>[code,id]));
    const PARAMS   = ['pm25','pm10','no2','so2','o3','co','temperature','humidity'];

    let inserted = 0, skipped = 0;
    const sql = `INSERT OR REPLACE INTO monthly_aggregates
      (station_id,parameter_id,year,month,mean_value,min_value,max_value,
       record_count,valid_count,days_exceeding_who,days_exceeding_naaqs,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

    rows.forEach((r, i) => {
      onProgress?.(i / rows.length);
      const stnId = stnMap[r[station_col]]; if (!stnId) { skipped++; return; }
      const yr = parseInt(r[year_col]);
      const mo = parseInt(r[month_col]);
      if (isNaN(yr) || isNaN(mo) || mo<1 || mo>12) { skipped++; return; }

      PARAMS.forEach(param => {
        const mean = parseFloat(r[param] || r[`${param}_mean`]);
        if (isNaN(mean) || !paramMap[param]) return;
        AQI_DB.run(sql, [
          stnId, paramMap[param], yr, mo,
          +mean.toFixed(3),
          parseFloat(r[`${param}_min`]) || null,
          parseFloat(r[`${param}_max`]) || null,
          parseInt(r[`${param}_count`]) || null,
          null, 0, 0, source,
        ]);
        inserted++;
      });
    });

    return { target: 'sqlite_monthly', rowsWritten: inserted, skipped };
  }

  // ─── Public API ───────────────────────────────────────────

  const TARGETS = {
    csv_export:            { label:'Download CSV',         icon:'📄', fn: toCSVExport },
    json_export:           { label:'Download JSON',        icon:'📋', fn: toJSONExport },
    dashboard_state:       { label:'Apply to Dashboard',   icon:'📊', fn: toDashboardState },
    sqlite_measurements:   { label:'Insert → measurements',icon:'🗄️', fn: toSQLiteMeasurements },
    sqlite_monthly:        { label:'Upsert → monthly_aggregates', icon:'🗄️', fn: toSQLiteMonthlyAgg },
    memory:                { label:'Keep in memory',       icon:'💾', fn: toMemory },
  };

  async function load(target, rows, config, onProgress) {
    const t = TARGETS[target];
    if (!t) throw new Error(`Unknown load target: ${target}`);
    return t.fn(rows, config, onProgress);
  }

  function listTargets() {
    return Object.entries(TARGETS).map(([id,{label,icon}])=>({id,label,icon}));
  }

  return { load, listTargets, getLastResult: () => _lastResult, rowsToCSV };

})();

window.ETL_LOAD = ETL_LOAD;

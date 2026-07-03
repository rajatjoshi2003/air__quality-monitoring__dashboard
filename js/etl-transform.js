/**
 * etl-transform.js — Transformation operators for the ETL pipeline
 *
 * Every operator has the signature:
 *   async function(rows, config, onProgress?) => { rows, log[] }
 *
 * Operators:
 *   field_map      — rename / select source columns → standard field names
 *   type_coerce    — cast to number, timestamp ISO string, string
 *   unit_convert   — ppb→μg/m³, ppm→mg/m³, °F/K→°C with auto-detection
 *   timestamp_norm — parse & normalise all timestamps to UTC ISO-8601
 *   filter         — drop rows matching a predicate expression
 *   deduplicate    — keep first|last per (station, parameter, timestamp) group
 *   pivot          — long format → wide (one row per timestamp × station)
 *   unpivot        — wide format → long (one row per reading)
 *   aggregate      — time-bin rollup: hour | day | month | city
 *   enrich_aqi     — compute AQI + category from PM2.5
 *   enrich_geo     — add lat/lng from CPCB_STATIONS lookup
 *   quality_score  — append completeness_pct, validity_pct, quality_flag
 *   rename         — bulk column rename via find/replace on header names
 *   derive         — add computed columns (arithmetic expressions)
 *   join           — inner/left join two datasets on key columns
 *   sample         — keep every Nth row or a random fraction
 */

const ETL_TRANSFORM = (() => {

  // ─── Registry ─────────────────────────────────────────────

  const OPERATORS = {};
  function register(name, meta, fn) { OPERATORS[name] = { name, ...meta, fn }; }

  // ─── Shared helpers ───────────────────────────────────────

  const STD_PARAMS = ['pm25','pm10','no2','so2','o3','co','temperature','humidity','aqi'];

  function tv(v) { return v != null && v !== '' && v !== 'NA' && v !== 'N/A' && v !== '-' && !isNaN(parseFloat(v)); }
  function num(v) { return tv(v) ? parseFloat(v) : null; }
  function isoNow() { return new Date().toISOString(); }

  // Safe expression evaluator (arithmetic only, no code injection)
  function safeEval(expr, row) {
    // Replace column references $colName with their values
    let e = expr.replace(/\$(\w+)/g, (_, col) => {
      const v = parseFloat(row[col]);
      return isNaN(v) ? 'null' : v;
    });
    // Allow only safe tokens: numbers, operators, parens, null
    if (!/^[\d\s\.\+\-\*\/\(\)nul]+$/.test(e)) return null;
    try { return Function('"use strict";return (' + e + ')')(); } catch { return null; }
  }

  // Truncate timestamp to bin
  function truncateTs(ts, bin) {
    const d = new Date(ts);
    if (isNaN(d)) return null;
    switch (bin) {
      case 'hour':  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCHours())).toISOString();
      case 'day':   return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())).toISOString().slice(0,10);
      case 'month': return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
      case 'year':  return `${d.getUTCFullYear()}`;
      default: return ts;
    }
  }

  // ═════════════════════════════════════════════════════════
  // OPERATOR IMPLEMENTATIONS
  // ═════════════════════════════════════════════════════════

  // ── 1. Field Map ──────────────────────────────────────────
  register('field_map', {
    label: 'Map Fields',
    icon: '🗺️',
    desc: 'Rename source columns to standard AQI field names. Unmapped columns are dropped unless keep_extra is set.',
    params: [
      { id:'mapping',    label:'Column mapping',  type:'mapping',  default:{} },
      { id:'keep_extra', label:'Keep unmapped',   type:'boolean',  default:false },
    ],
  }, async (rows, cfg, onProgress) => {
    const { mapping = {}, keep_extra = false } = cfg;
    const log = [];
    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const row = {};
      for (const [src, tgt] of Object.entries(mapping)) {
        if (tgt && r[src] !== undefined) row[tgt] = r[src];
      }
      if (keep_extra) {
        Object.keys(r).forEach(k => { if (!(k in mapping) && !(k in row)) row[k] = r[k]; });
      }
      return row;
    });
    log.push({ type:'field_map', renamed: Object.keys(mapping).length, rows: out.length });
    return { rows: out, log };
  });

  // ── 2. Type Coerce ────────────────────────────────────────
  register('type_coerce', {
    label: 'Type Coerce',
    icon: '🔢',
    desc: 'Cast columns to number, string, or boolean. Unparseable values become null.',
    params: [
      { id:'rules', label:'Column → type rules', type:'type_rules', default:[] },
    ],
  }, async (rows, cfg, onProgress) => {
    const { rules = [] } = cfg;
    const log = []; let changed = 0;
    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const row = { ...r };
      rules.forEach(({ col, type }) => {
        if (!(col in row)) return;
        const v = row[col];
        if (type === 'number') {
          const n = parseFloat(String(v).replace(/,/g,''));
          row[col] = isNaN(n) ? null : n; if (row[col] !== v) changed++;
        } else if (type === 'string') {
          row[col] = v == null ? null : String(v);
        } else if (type === 'boolean') {
          row[col] = /^(1|true|yes|y)$/i.test(String(v));
        } else if (type === 'integer') {
          const n = parseInt(v, 10); row[col] = isNaN(n) ? null : n;
        }
      });
      return row;
    });
    log.push({ type:'type_coerce', rules: rules.length, changed });
    return { rows: out, log };
  });

  // ── 3. Unit Convert ───────────────────────────────────────
  register('unit_convert', {
    label: 'Unit Conversion',
    icon: '🔄',
    desc: 'Convert ppb → μg/m³, ppm → mg/m³, °F/K → °C. Can auto-detect units from column name.',
    params: [
      { id:'auto_detect',  label:'Auto-detect from column names', type:'boolean', default:true },
      { id:'conversions',  label:'Manual overrides', type:'conversions', default:[] },
      { id:'confidence',   label:'Auto-detect confidence threshold', type:'range', min:0, max:1, step:0.05, default:0.75 },
    ],
  }, async (rows, cfg, onProgress) => {
    const { auto_detect = true, conversions = [], confidence = 0.75 } = cfg;
    if (!window.UnitConverter) return { rows, log:[{type:'unit_convert', skipped:'UnitConverter not loaded'}] };
    const log = []; let converted = 0;

    // Build effective conversion list
    const effectiveConv = [...conversions];
    if (auto_detect && rows.length) {
      const headers = Object.keys(rows[0]);
      headers.forEach(h => {
        const lower = h.toLowerCase();
        const { detectUnit } = UnitConverter;
        // Detect from column name suffix
        let param = null, fromUnit = null;
        if (lower.includes('pm25') || lower.includes('pm2.5')) param = 'pm25';
        else if (lower.includes('pm10')) param = 'pm10';
        else if (lower.includes('no2') && (lower.includes('ppb') || lower.includes('ug'))) param = 'no2';
        else if (lower.includes('so2') && (lower.includes('ppb') || lower.includes('ug'))) param = 'so2';
        else if (lower.includes('o3')  && (lower.includes('ppb') || lower.includes('ug'))) param = 'o3';
        else if (lower.includes('co')  && (lower.includes('ppm') || lower.includes('mg'))) param = 'co';
        else if (lower.includes('temp') && (lower.includes('_f') || lower.includes('fahrenheit'))) { param = 'temperature'; fromUnit = 'F'; }
        else if (lower.includes('temp') && (lower.includes('_k') || lower.includes('kelvin'))) { param = 'temperature'; fromUnit = 'K'; }

        if (param && !effectiveConv.find(c => c.col === h)) {
          if (!fromUnit) {
            if (lower.includes('ppb')) fromUnit = 'ppb';
            else if (lower.includes('ppm') && param !== 'co') fromUnit = 'ppb'; // treat ppm as ppb for gases
            else if (lower.includes('mg')) fromUnit = 'mgm3';
            else if (lower.includes('ug') || lower.includes('μg')) fromUnit = 'ugm3';
          }
          if (fromUnit) effectiveConv.push({ col: h, param, fromUnit });
        }
      });
    }

    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const row = { ...r };
      effectiveConv.forEach(({ col, param, fromUnit }) => {
        if (col in row && row[col] != null && !isNaN(row[col])) {
          const orig = parseFloat(row[col]);
          const conv = UnitConverter.toStandardUnit(param, orig, fromUnit);
          if (conv !== null && conv !== orig) { row[col] = +conv.toFixed(4); converted++; }
        }
      });
      return row;
    });
    log.push({ type:'unit_convert', conversions: effectiveConv.length, converted });
    return { rows: out, log };
  });

  // ── 4. Timestamp Normalise ────────────────────────────────
  register('timestamp_norm', {
    label: 'Timestamp Normalise',
    icon: '🕐',
    desc: 'Parse raw date strings into ISO-8601 UTC. Detect and apply timezone offset.',
    params: [
      { id:'source_col',  label:'Source column',    type:'column',  default:'timestamp' },
      { id:'target_col',  label:'Output column',    type:'string',  default:'timestamp_utc' },
      { id:'tz_offset',   label:'Source timezone (hours from UTC)', type:'number', default:5.5 },
      { id:'drop_invalid',label:'Drop rows with unparseable timestamps', type:'boolean', default:true },
    ],
  }, async (rows, cfg, onProgress) => {
    const { source_col='timestamp', target_col='timestamp_utc', tz_offset=5.5, drop_invalid=true } = cfg;
    const log = []; let parsed = 0, failed = 0;
    const { parseTimestamp } = ETL_EXTRACT;
    const offsetMs = tz_offset * 3_600_000;

    const out = [];
    rows.forEach((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const raw = r[source_col];
      const d   = parseTimestamp(raw);
      if (d) {
        // Adjust for source timezone (subtract to get UTC)
        const utc = new Date(d.getTime() - offsetMs);
        out.push({ ...r, [target_col]: utc.toISOString() });
        parsed++;
      } else {
        failed++;
        if (!drop_invalid) out.push({ ...r, [target_col]: null });
      }
    });
    log.push({ type:'timestamp_norm', parsed, failed, tz_offset });
    return { rows: out, log };
  });

  // ── 5. Filter ─────────────────────────────────────────────
  register('filter', {
    label: 'Filter Rows',
    icon: '🔽',
    desc: 'Keep rows where all conditions are satisfied. Use to remove nulls, sentinels, or unwanted cities.',
    params: [
      { id:'conditions', label:'Filter conditions', type:'conditions', default:[] },
      { id:'mode',       label:'Mode',              type:'select', options:['AND','OR'], default:'AND' },
    ],
  }, async (rows, cfg, onProgress) => {
    const { conditions = [], mode = 'AND' } = cfg;
    if (!conditions.length) return { rows, log:[{type:'filter', kept:rows.length, dropped:0}] };
    let kept = 0, dropped = 0;

    const test = (r, c) => {
      const v = r[c.col];
      const n = parseFloat(v);
      switch (c.op) {
        case 'eq':        return String(v) === String(c.val);
        case 'neq':       return String(v) !== String(c.val);
        case 'gt':        return !isNaN(n) && n >  parseFloat(c.val);
        case 'gte':       return !isNaN(n) && n >= parseFloat(c.val);
        case 'lt':        return !isNaN(n) && n <  parseFloat(c.val);
        case 'lte':       return !isNaN(n) && n <= parseFloat(c.val);
        case 'not_null':  return v != null && v !== '' && v !== 'NA';
        case 'is_null':   return v == null || v === '' || v === 'NA';
        case 'contains':  return String(v).toLowerCase().includes(String(c.val).toLowerCase());
        case 'regex':     try { return new RegExp(c.val,'i').test(String(v)); } catch { return false; }
        case 'in_list':   return String(c.val).split(',').map(s=>s.trim()).includes(String(v));
        default: return true;
      }
    };

    const out = rows.filter((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const results = conditions.map(c => test(r, c));
      const pass    = mode === 'AND' ? results.every(Boolean) : results.some(Boolean);
      pass ? kept++ : dropped++;
      return pass;
    });
    return { rows: out, log:[{type:'filter', kept, dropped, conditions:conditions.length, mode}] };
  });

  // ── 6. Deduplicate ────────────────────────────────────────
  register('deduplicate', {
    label: 'Deduplicate',
    icon: '♻️',
    desc: 'Remove duplicate rows. Groups by key columns and keeps the first or last occurrence.',
    params: [
      { id:'key_cols', label:'Key columns (comma-separated)', type:'string', default:'station_code,timestamp_utc,parameter' },
      { id:'keep',     label:'Keep',    type:'select', options:['first','last'], default:'first' },
    ],
  }, async (rows, cfg, onProgress) => {
    const { key_cols='station_code,timestamp_utc', keep='first' } = cfg;
    const keys = key_cols.split(',').map(s=>s.trim()).filter(Boolean);
    const seen = new Map();
    rows.forEach((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const k = keys.map(c => r[c] ?? '').join('|');
      if (!seen.has(k) || keep === 'last') seen.set(k, r);
    });
    const out = [...seen.values()];
    return { rows: out, log:[{type:'deduplicate', original:rows.length, unique:out.length, dropped:rows.length-out.length}] };
  });

  // ── 7. Pivot ──────────────────────────────────────────────
  register('pivot', {
    label: 'Pivot (Long → Wide)',
    icon: '↔️',
    desc: 'Convert long-format data (station, parameter, value per row) into wide format (all parameters as columns).',
    params: [
      { id:'id_cols',    label:'Identity columns',  type:'string', default:'timestamp_utc,station_code' },
      { id:'pivot_col',  label:'Column to pivot',   type:'column', default:'parameter' },
      { id:'value_col',  label:'Value column',      type:'column', default:'value' },
      { id:'agg_fn',     label:'Aggregation (if duplicates)', type:'select', options:['mean','sum','max','min','first'], default:'mean' },
    ],
  }, async (rows, cfg, onProgress) => {
    const { id_cols='timestamp_utc,station_code', pivot_col='parameter', value_col='value', agg_fn='mean' } = cfg;
    const idCols = id_cols.split(',').map(s=>s.trim());
    const buckets = new Map();

    rows.forEach((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length / 2);
      const key = idCols.map(c => r[c] ?? '').join('|');
      if (!buckets.has(key)) {
        const base = {}; idCols.forEach(c => { base[c] = r[c]; });
        buckets.set(key, { base, vals: {} });
      }
      const pv = r[pivot_col];
      const vv = parseFloat(r[value_col]);
      if (pv != null && !isNaN(vv)) {
        if (!buckets.get(key).vals[pv]) buckets.get(key).vals[pv] = [];
        buckets.get(key).vals[pv].push(vv);
      }
    });

    const AGG = {
      mean:  arr => arr.reduce((a,b)=>a+b,0)/arr.length,
      sum:   arr => arr.reduce((a,b)=>a+b,0),
      max:   arr => Math.max(...arr),
      min:   arr => Math.min(...arr),
      first: arr => arr[0],
    };
    const fn = AGG[agg_fn] || AGG.mean;

    let idx = 0;
    const out = [];
    for (const { base, vals } of buckets.values()) {
      if (idx % 200 === 0) onProgress?.(0.5 + idx / buckets.size / 2);
      const row = { ...base };
      Object.entries(vals).forEach(([p,arr]) => { row[p] = +fn(arr).toFixed(4); });
      out.push(row); idx++;
    }
    return { rows: out, log:[{type:'pivot', inputRows:rows.length, outputRows:out.length}] };
  });

  // ── 8. Unpivot ────────────────────────────────────────────
  register('unpivot', {
    label: 'Unpivot (Wide → Long)',
    icon: '↕️',
    desc: 'Melt wide-format data (one column per parameter) into long format (one row per reading).',
    params: [
      { id:'id_cols',    label:'Identity columns to keep', type:'string', default:'timestamp_utc,station_code' },
      { id:'value_cols', label:'Columns to melt',          type:'string', default:'pm25,pm10,no2,so2,o3,co' },
      { id:'param_col',  label:'New parameter column name',type:'string', default:'parameter' },
      { id:'value_col',  label:'New value column name',    type:'string', default:'value' },
      { id:'drop_null',  label:'Drop null values',         type:'boolean', default:true },
    ],
  }, async (rows, cfg, onProgress) => {
    const { id_cols='timestamp_utc,station_code', value_cols='pm25,pm10,no2,so2,o3,co',
            param_col='parameter', value_col='value', drop_null=true } = cfg;
    const idCols  = id_cols.split(',').map(s=>s.trim());
    const valCols = value_cols.split(',').map(s=>s.trim());
    const out = [];

    rows.forEach((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const base = {}; idCols.forEach(c => { if (c in r) base[c] = r[c]; });
      valCols.forEach(col => {
        const v = parseFloat(r[col]);
        if (drop_null && (r[col] == null || isNaN(v))) return;
        out.push({ ...base, [param_col]: col, [value_col]: isNaN(v) ? null : v });
      });
    });
    return { rows: out, log:[{type:'unpivot', inputRows:rows.length, outputRows:out.length}] };
  });

  // ── 9. Aggregate ──────────────────────────────────────────
  register('aggregate', {
    label: 'Aggregate',
    icon: '📦',
    desc: 'Group by time bin (hour/day/month) and/or station/city. Compute mean, min, max, std, count.',
    params: [
      { id:'time_bin',   label:'Time bin',        type:'select', options:['hour','day','month','year','none'], default:'day' },
      { id:'group_cols', label:'Additional group columns', type:'string', default:'station_code,city' },
      { id:'value_cols', label:'Columns to aggregate',    type:'string', default:'pm25,pm10,no2,so2,o3,co,aqi' },
      { id:'ts_col',     label:'Timestamp column',        type:'column', default:'timestamp_utc' },
      { id:'fns',        label:'Functions',               type:'multiselect', options:['mean','min','max','std','count','p95'], default:['mean','min','max','count'] },
    ],
  }, async (rows, cfg, onProgress) => {
    const { time_bin='day', group_cols='station_code', value_cols='pm25,pm10,no2,so2,o3,co',
            ts_col='timestamp_utc', fns=['mean','min','max','count'] } = cfg;
    const gCols  = group_cols.split(',').map(s=>s.trim()).filter(Boolean);
    const vCols  = value_cols.split(',').map(s=>s.trim()).filter(Boolean);
    const buckets = new Map();

    rows.forEach((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length * 0.6);
      const timePart = time_bin !== 'none' ? truncateTs(r[ts_col], time_bin) : 'all';
      const groupPart = gCols.map(c => r[c] ?? '').join('|');
      const key = `${timePart}||${groupPart}`;

      if (!buckets.has(key)) {
        const base = { [ts_col]: timePart };
        gCols.forEach(c => { base[c] = r[c]; });
        const vals = {}; vCols.forEach(c => { vals[c] = []; });
        buckets.set(key, { base, vals });
      }
      vCols.forEach(c => {
        const v = parseFloat(r[c]);
        if (!isNaN(v)) buckets.get(key).vals[c].push(v);
      });
    });

    function pct(arr, p) {
      const s = [...arr].sort((a,b)=>a-b);
      const i = Math.ceil(p/100 * s.length) - 1;
      return s[Math.max(0,i)];
    }
    function std(arr) {
      const m = arr.reduce((a,b)=>a+b,0)/arr.length;
      return Math.sqrt(arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length);
    }

    let idx = 0;
    const out = [];
    for (const { base, vals } of buckets.values()) {
      if (idx % 200 === 0) onProgress?.(0.6 + idx/buckets.size*0.4);
      const row = { ...base };
      vCols.forEach(c => {
        const arr = vals[c];
        if (fns.includes('mean')  && arr.length) row[`${c}_mean`]  = +((arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(3));
        if (fns.includes('min')   && arr.length) row[`${c}_min`]   = +Math.min(...arr).toFixed(3);
        if (fns.includes('max')   && arr.length) row[`${c}_max`]   = +Math.max(...arr).toFixed(3);
        if (fns.includes('std')   && arr.length) row[`${c}_std`]   = +std(arr).toFixed(3);
        if (fns.includes('count'))               row[`${c}_count`] = arr.length;
        if (fns.includes('p95')   && arr.length) row[`${c}_p95`]   = +pct(arr,95).toFixed(3);
      });
      out.push(row); idx++;
    }
    return { rows: out, log:[{type:'aggregate', inputRows:rows.length, outputRows:out.length, bin:time_bin}] };
  });

  // ── 10. Enrich AQI ───────────────────────────────────────
  register('enrich_aqi', {
    label: 'Enrich AQI',
    icon: '🏭',
    desc: 'Compute US EPA AQI index and category from PM2.5. Also determines dominant pollutant sub-index.',
    params: [
      { id:'pm25_col',   label:'PM2.5 column', type:'column', default:'pm25' },
      { id:'pm10_col',   label:'PM10 column',  type:'column', default:'pm10' },
      { id:'overwrite',  label:'Overwrite existing AQI column', type:'boolean', default:false },
    ],
  }, async (rows, cfg, onProgress) => {
    const { pm25_col='pm25', pm10_col='pm10', overwrite=false } = cfg;
    if (!window.UnitConverter?.pm25ToAQI) return { rows, log:[{type:'enrich_aqi', skipped:'UnitConverter not loaded'}] };
    let enriched = 0;
    const CATS = ['Good','Moderate','Unhealthy for Sensitive Groups','Unhealthy','Very Unhealthy','Hazardous'];

    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      if (!overwrite && r.aqi != null) return r;
      const pm25 = parseFloat(r[pm25_col]);
      if (isNaN(pm25)) return r;
      const aqi  = UnitConverter.pm25ToAQI(pm25);
      const cat  = aqi <= 50 ? 0 : aqi <= 100 ? 1 : aqi <= 150 ? 2 : aqi <= 200 ? 3 : aqi <= 300 ? 4 : 5;
      enriched++;
      return { ...r, aqi: Math.round(aqi), aqi_category: CATS[cat], dominant_pollutant: 'pm25' };
    });
    return { rows: out, log:[{type:'enrich_aqi', enriched}] };
  });

  // ── 11. Enrich Geo ────────────────────────────────────────
  register('enrich_geo', {
    label: 'Enrich Geo',
    icon: '📍',
    desc: 'Add lat/lng, zone_type, and operator fields from the CPCB or IoT station registry.',
    params: [
      { id:'station_col', label:'Station code column', type:'column', default:'station_code' },
      { id:'city_col',    label:'City column',         type:'column', default:'city' },
    ],
  }, async (rows, cfg, onProgress) => {
    const { station_col='station_code', city_col='city' } = cfg;
    if (!window.getCPCBStations) return { rows, log:[{type:'enrich_geo',skipped:'CPCB dataset not loaded'}] };

    // Build lookup from all cities
    const lookup = new Map();
    const cities = Object.keys(window.CITIES || {});
    cities.forEach(cid => {
      (getCPCBStations(cid) || []).forEach(st => lookup.set(st.id, { ...st, city: cid }));
    });
    // Add IoT nodes
    if (window.IOT_NETWORK) {
      Object.entries(IOT_NETWORK).forEach(([cid, nodes]) =>
        nodes.forEach(n => lookup.set(n.id, { lat: n.lat, lng: n.lng, zone: n.zone, city: cid }))
      );
    }

    let enriched = 0;
    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const code = r[station_col];
      const info = code ? lookup.get(code) : null;
      if (!info) return r;
      enriched++;
      return { ...r, lat: info.lat, lng: info.lng, zone_type: info.zone || info.zone_type || null,
               city: r[city_col] || info.city };
    });
    return { rows: out, log:[{type:'enrich_geo', enriched, total:rows.length}] };
  });

  // ── 12. Quality Score ─────────────────────────────────────
  register('quality_score', {
    label: 'Quality Score',
    icon: '⭐',
    desc: 'Append completeness_pct, validity_pct, and quality_flag columns based on defined parameter columns.',
    params: [
      { id:'param_cols', label:'Parameter columns to assess', type:'string', default:'pm25,pm10,no2,so2,o3,co' },
      { id:'flag_col',   label:'Output quality_flag column',  type:'string', default:'quality_flag' },
    ],
  }, async (rows, cfg, onProgress) => {
    const { param_cols='pm25,pm10,no2,so2,o3,co', flag_col='quality_flag' } = cfg;
    const pCols = param_cols.split(',').map(s=>s.trim()).filter(Boolean);

    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const nonNull   = pCols.filter(c => r[c] != null && !isNaN(parseFloat(r[c]))).length;
      const completeness = pCols.length ? (nonNull / pCols.length * 100) : 100;
      // Simple validity: check against hard physical ranges if UnitConverter available
      let valid = nonNull;
      if (window.UnitConverter?.checkRange) {
        valid = pCols.filter(c => {
          const v = parseFloat(r[c]);
          if (isNaN(v)) return false;
          return UnitConverter.checkRange(c, v) !== 'hard_outlier';
        }).length;
      }
      const validity = pCols.length ? (valid / pCols.length * 100) : 100;
      const flag = completeness < 30 ? 'MISSING' : validity < 80 ? 'SUSPECT' : 'VALID';
      return { ...r, completeness_pct: +completeness.toFixed(1), validity_pct: +validity.toFixed(1),
               [flag_col]: r[flag_col] || flag };
    });
    return { rows: out, log:[{type:'quality_score', rows:out.length}] };
  });

  // ── 13. Rename ────────────────────────────────────────────
  register('rename', {
    label: 'Rename Columns',
    icon: '✏️',
    desc: 'Batch rename columns using find/replace patterns.',
    params: [
      { id:'rules', label:'Find → Replace pairs', type:'rename_rules', default:[] },
    ],
  }, async (rows, cfg, onProgress) => {
    const { rules = [] } = cfg;
    if (!rules.length || !rows.length) return { rows, log:[{type:'rename', renamed:0}] };
    let renamed = 0;
    const headers = Object.keys(rows[0]);
    const newHeaders = headers.map(h => {
      for (const { find, replace, mode='exact' } of rules) {
        if (mode === 'exact'  && h === find)       return replace;
        if (mode === 'prefix' && h.startsWith(find)) { renamed++; return replace + h.slice(find.length); }
        if (mode === 'suffix' && h.endsWith(find))   { renamed++; return h.slice(0,-find.length) + replace; }
        if (mode === 'regex') { try { const r2 = new RegExp(find,'g'); if (r2.test(h)) { renamed++; return h.replace(r2, replace); } } catch{} }
        if (mode === 'exact' && h === find) { renamed++; return replace; }
      }
      return h;
    });
    if (!renamed) return { rows, log:[{type:'rename', renamed:0}] };
    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const n = {}; headers.forEach((h,j) => { n[newHeaders[j]] = r[h]; }); return n;
    });
    return { rows: out, log:[{type:'rename', renamed}] };
  });

  // ── 14. Derive Columns ────────────────────────────────────
  register('derive', {
    label: 'Derive Columns',
    icon: '🧮',
    desc: 'Add computed columns using arithmetic expressions. Reference other columns with $colName.',
    params: [
      { id:'formulas', label:'Column → formula pairs', type:'formulas', default:[] },
    ],
  }, async (rows, cfg, onProgress) => {
    const { formulas = [] } = cfg;
    let derived = 0;
    const out = rows.map((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const row = { ...r };
      formulas.forEach(({ col, expr }) => {
        const v = safeEval(expr, row);
        row[col] = v != null ? +v.toFixed(4) : null;
        if (v != null) derived++;
      });
      return row;
    });
    return { rows: out, log:[{type:'derive', formulas:formulas.length, derived}] };
  });

  // ── 15. Join ──────────────────────────────────────────────
  register('join', {
    label: 'Join Datasets',
    icon: '🔗',
    desc: 'Join the current dataset with a second dataset on matching key columns.',
    params: [
      { id:'right_source', label:'Right dataset source ID', type:'string', default:'' },
      { id:'left_key',     label:'Left key columns',        type:'string', default:'station_code,timestamp_utc' },
      { id:'right_key',    label:'Right key columns',       type:'string', default:'station_code,timestamp_utc' },
      { id:'type',         label:'Join type',               type:'select', options:['inner','left'], default:'left' },
    ],
  }, async (rows, cfg, onProgress) => {
    // Join requires the right dataset to be pre-loaded in ETL_ENGINE.datasets
    const { right_source, left_key='station_code', right_key='station_code', type='left' } = cfg;
    const rightDataset = window.ETL_ENGINE?.getDataset?.(right_source);
    if (!rightDataset?.rows?.length) {
      return { rows, log:[{type:'join', skipped: `Right dataset "${right_source}" not found`}] };
    }
    const lk = left_key.split(',').map(s=>s.trim());
    const rk = right_key.split(',').map(s=>s.trim());
    // Build hash of right rows
    const rIndex = new Map();
    rightDataset.rows.forEach(r => {
      const k = rk.map(c => r[c] ?? '').join('|');
      if (!rIndex.has(k)) rIndex.set(k, []);
      rIndex.get(k).push(r);
    });
    let matched = 0, unmatched = 0;
    const out = [];
    rows.forEach((r, i) => {
      if (i % 500 === 0) onProgress?.(i / rows.length);
      const k = lk.map(c => r[c] ?? '').join('|');
      const matches = rIndex.get(k) || [];
      if (matches.length) {
        matches.forEach(rm => { out.push({ ...rm, ...r }); matched++; });
      } else {
        if (type === 'left') { out.push(r); unmatched++; }
      }
    });
    return { rows: out, log:[{type:'join', join_type:type, matched, unmatched}] };
  });

  // ── 16. Sample ────────────────────────────────────────────
  register('sample', {
    label: 'Sample',
    icon: '🎲',
    desc: 'Reduce dataset size by keeping every Nth row or a random fraction. Useful for preview / testing.',
    params: [
      { id:'mode',     label:'Mode',          type:'select', options:['every_nth','fraction','head','tail'], default:'every_nth' },
      { id:'n',        label:'N / fraction',  type:'number', default:10 },
      { id:'seed',     label:'Random seed',   type:'number', default:42 },
    ],
  }, async (rows, cfg, onProgress) => {
    const { mode='every_nth', n=10, seed=42 } = cfg;
    let out;
    switch (mode) {
      case 'every_nth': out = rows.filter((_,i) => i % n === 0); break;
      case 'head':      out = rows.slice(0, n); break;
      case 'tail':      out = rows.slice(-n);   break;
      case 'fraction':  {
        // Seeded Fisher-Yates
        const arr = rows.map((_,i)=>i); let s = seed;
        const rng = () => { s = (s*16807 + 0) % 2147483647; return s/2147483647; };
        for (let i=arr.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
        const keep = Math.round(rows.length * Math.min(1, n));
        out = arr.slice(0, keep).sort((a,b)=>a-b).map(i=>rows[i]);
        break;
      }
      default: out = rows;
    }
    return { rows: out, log:[{type:'sample', mode, inputRows:rows.length, outputRows:out.length}] };
  });

  // ─── Public API ───────────────────────────────────────────

  function getOperator(name) { return OPERATORS[name]; }
  function listOperators()   { return Object.values(OPERATORS).map(({name,label,icon,desc,params})=>({name,label,icon,desc,params})); }

  async function runOperator(name, rows, config, onProgress) {
    const op = OPERATORS[name];
    if (!op) throw new Error(`Unknown operator: ${name}`);
    return op.fn(rows, config, onProgress);
  }

  return { getOperator, listOperators, runOperator, OPERATORS };

})();

window.ETL_TRANSFORM = ETL_TRANSFORM;

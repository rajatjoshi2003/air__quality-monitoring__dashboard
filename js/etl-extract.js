/**
 * etl-extract.js — Source connectors for the ETL pipeline
 *
 * Supported sources:
 *   csv_file    — drag-dropped or picked CSV / TSV / PSV
 *   json_file   — JSON array or newline-delimited JSON
 *   current     — current state.data already in the dashboard
 *   iot         — live IoT sensor simulator readings
 *   cpcb        — embedded CPCB historical dataset (monthly means)
 *   sqlite      — arbitrary SELECT from the in-browser SQLite database
 *   api         — real-time CPCB station rows via the Flask /live/aqi proxy
 */

const ETL_EXTRACT = (() => {

  // ─── CSV parsing ─────────────────────────────────────────
  // Full RFC 4180-compliant parser with delimiter sniffing

  const DELIMITERS = [',', ';', '\t', '|'];

  function sniffDelimiter(sample) {
    let best = ',', bestScore = -1;
    for (const d of DELIMITERS) {
      // Count occurrences on the first 5 lines, weighted by consistency
      const lines = sample.split('\n').slice(0, 5).filter(l => l.trim());
      const counts = lines.map(l => {
        let n = 0, inQ = false;
        for (let i = 0; i < l.length; i++) {
          if (l[i] === '"') inQ = !inQ;
          else if (!inQ && l[i] === d) n++;
        }
        return n;
      });
      // Score: mean count × (1 – variance/mean) → rewards consistent counts
      const mean = counts.reduce((a,b)=>a+b,0)/counts.length;
      const variance = counts.reduce((a,b)=>a+(b-mean)**2,0)/counts.length;
      const score = mean > 0 ? mean * (1 - Math.min(1, variance/mean/2)) : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function parseCSV(text) {
    // Strip UTF-8 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const delimiter = sniffDelimiter(text.slice(0, 2000));
    const lines = text.split('\n');

    // Skip leading comment/blank lines to find header
    let headerIdx = 0;
    while (headerIdx < lines.length && (!lines[headerIdx].trim() || lines[headerIdx].startsWith('#'))) headerIdx++;

    // RFC 4180 tokenizer for a single line
    function tokenize(line) {
      const fields = [];
      let i = 0, field = '';
      while (i < line.length) {
        if (line[i] === '"') {
          i++; // opening quote
          while (i < line.length) {
            if (line[i] === '"' && line[i+1] === '"') { field += '"'; i += 2; }
            else if (line[i] === '"') { i++; break; }
            else { field += line[i++]; }
          }
        } else if (line[i] === delimiter) {
          fields.push(field.trim()); field = ''; i++;
        } else {
          field += line[i++];
        }
      }
      fields.push(field.trim());
      return fields;
    }

    const headers = tokenize(lines[headerIdx]).map(h => h.replace(/^["']|["']$/g,'').trim());
    const rows = [];
    for (let li = headerIdx + 1; li < lines.length; li++) {
      const line = lines[li].trim();
      if (!line || line.startsWith('#')) continue;
      const vals = tokenize(line);
      if (vals.length < 2) continue; // skip blank rows
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
      rows.push(obj);
    }

    return { headers, rows, delimiter, rowCount: rows.length };
  }

  // ─── Type inference ───────────────────────────────────────

  function inferColumnTypes(headers, rows, sampleSize = 200) {
    const sample = rows.slice(0, sampleSize);
    return headers.map(h => {
      const vals = sample.map(r => r[h]).filter(v => v != null && v !== '' && v !== 'NA' && v !== 'N/A' && v !== '-');
      if (!vals.length) return { col: h, type: 'string', nullRate: 1 };

      const nullRate = 1 - vals.length / sample.length;
      const numericVals = vals.filter(v => !isNaN(parseFloat(v)) && isFinite(v));
      const dateVals    = vals.filter(v => !isNaN(Date.parse(v)) && isNaN(+v));

      let type = 'string';
      if (numericVals.length / vals.length > 0.85) {
        type = 'number';
      } else if (dateVals.length / vals.length > 0.85) {
        type = 'timestamp';
      }

      const numSamples = numericVals.map(Number);
      return {
        col:  h, type, nullRate,
        samples: vals.slice(0, 5),
        min: type === 'number' ? Math.min(...numSamples) : null,
        max: type === 'number' ? Math.max(...numSamples) : null,
      };
    });
  }

  // ─── Column auto-mapping ──────────────────────────────────

  const ALIASES = {
    timestamp:   ['timestamp','time','date','datetime','date_time','ts','measurement_date','reading_time','sample_time'],
    station_code:['station','station_code','station_id','site','location','site_id','monitor','location_id'],
    city:        ['city','district','region','area','zone','locality'],
    pm25:        ['pm2.5','pm25','pm_2_5','pm2_5','fine_pm','pm25_ug','pm2.5_ugm3','particulate_matter_2.5'],
    pm10:        ['pm10','pm_10','pm10_ug','pm10_ugm3','coarse_pm','particulate_matter_10'],
    no2:         ['no2','no_2','nitrogen_dioxide','nox','nox_ppb','no2_ppb','no2_ugm3'],
    so2:         ['so2','so_2','sulfur_dioxide','sulphur_dioxide','so2_ppb','so2_ugm3'],
    o3:          ['o3','ozone','ozone_ppb','o3_ppb','o3_ugm3'],
    co:          ['co','carbon_monoxide','co_ppm','co_mgm3','co_ppb'],
    temperature: ['temp','temperature','air_temp','t_air','tmp','temp_c','temperature_c'],
    humidity:    ['rh','humidity','relative_humidity','hum','rh_pct','humidity_pct'],
    aqi:         ['aqi','air_quality_index','air_quality','aqindex'],
    wind_speed:  ['ws','wind_speed','windspeed','wind_spd'],
    wind_dir:    ['wd','wind_dir','wind_direction','winddir'],
  };

  function autoMap(headers) {
    return headers.map(h => {
      const norm = h.toLowerCase().replace(/[\s\-\.]/g, '_').replace(/_+/g,'_');
      for (const [field, aliases] of Object.entries(ALIASES)) {
        const normAliases = aliases.map(a => a.replace(/[\s\-\.]/g,'_').replace(/_+/g,'_'));
        // Exact match
        if (normAliases.includes(norm)) return { source: h, target: field, confidence: 1.0 };
        // Substring match
        if (normAliases.some(a => norm.includes(a) || a.includes(norm))) {
          return { source: h, target: field, confidence: 0.7 };
        }
      }
      // Unit suffix heuristic: column ends in _ppb, _ugm3, _ppm → pollutant candidate
      const unitMatch = norm.match(/^(.+?)_(ppb|ugm3|ppm|mgm3|ug_m3)$/);
      if (unitMatch) {
        const base = unitMatch[1];
        for (const [field, aliases] of Object.entries(ALIASES)) {
          if (aliases.some(a => a.replace(/[\s\-\.]/g,'_') === base)) {
            return { source: h, target: field, confidence: 0.6, detectedUnit: unitMatch[2] };
          }
        }
      }
      return { source: h, target: null, confidence: 0 };
    });
  }

  // ─── Timestamp normalization ──────────────────────────────

  const DATE_FORMATS = [
    // ISO variants
    { re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,   parse: v => new Date(v) },
    { re: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,  parse: v => new Date(v.replace(' ','T')+'Z') },
    // Date only
    { re: /^\d{4}-\d{2}-\d{2}$/,                     parse: v => new Date(v+'T00:00:00Z') },
    // Indian format DD-MM-YYYY
    { re: /^\d{2}-\d{2}-\d{4}( \d{2}:\d{2}(:\d{2})?)?$/, parse: v => {
        const [d,m,y] = v.split(' ')[0].split('-');
        const t = v.split(' ')[1] || '00:00:00';
        return new Date(`${y}-${m}-${d}T${t}Z`);
    }},
    // US format MM/DD/YYYY
    { re: /^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2}(:\d{2})?( AM| PM)?)?$/, parse: v => new Date(v) },
    // Unix seconds (10 digits)
    { re: /^\d{10}$/,  parse: v => new Date(+v * 1000) },
    // Unix ms (13 digits)
    { re: /^\d{13}$/,  parse: v => new Date(+v) },
  ];

  function parseTimestamp(val) {
    if (!val || val === '' || val === 'NA') return null;
    for (const fmt of DATE_FORMATS) {
      if (fmt.re.test(val.trim())) {
        const d = fmt.parse(val.trim());
        if (!isNaN(d.getTime())) return d;
      }
    }
    // Fallback: native Date.parse
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }

  function parseNumber(val) {
    if (val == null || val === '' || val === 'NA' || val === 'N/A' || val === '-') return null;
    const n = parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  // ─── Source connectors ────────────────────────────────────

  async function fromCSVFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const parsed = parseCSV(e.target.result);
          const typeInfo = inferColumnTypes(parsed.headers, parsed.rows);
          const mapping  = autoMap(parsed.headers);
          resolve({ ...parsed, typeInfo, mapping, sourceType: 'csv_file', fileName: file.name, fileSize: file.size });
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function fromJSONFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          let data = JSON.parse(e.target.result);
          // Support {data:[...]} envelope
          if (data && !Array.isArray(data)) {
            const arrKey = Object.keys(data).find(k => Array.isArray(data[k]));
            data = arrKey ? data[arrKey] : [data];
          }
          if (!data.length) throw new Error('JSON contains no rows');
          const headers  = Object.keys(data[0]);
          const typeInfo = inferColumnTypes(headers, data);
          const mapping  = autoMap(headers);
          resolve({ headers, rows: data, typeInfo, mapping, rowCount: data.length,
                    sourceType: 'json_file', fileName: file.name });
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function fromCurrentState(stateData, cityId) {
    if (!stateData?.length) throw new Error('No data in dashboard state — refresh first');
    const sample = stateData[0];
    const headers = Object.keys(sample);
    const typeInfo = inferColumnTypes(headers, stateData);
    const mapping  = autoMap(headers);
    return { headers, rows: stateData, typeInfo, mapping, rowCount: stateData.length,
             sourceType: 'current', city: cityId };
  }

  async function fromIoT(cityId, duration = 24) {
    if (!window.readCityNetwork) throw new Error('IoT simulator not loaded');
    const readings = [];
    const stateData = window.state?.data || [];
    const latest    = stateData[stateData.length - 1] || {};
    const baseAQI   = latest.aqi  || 80;
    const basePollutants = { pm25: latest.pm25||35, pm10: latest.pm10||65,
                              no2: latest.no2||40, so2: latest.so2||20,
                              o3: latest.o3||60, co: latest.co||1.2 };
    const baseMet = { temperature: latest.temperature||28, humidity: latest.humidity||65 };

    const now = Date.now();
    for (let h = duration; h >= 0; h--) {
      const ts = new Date(now - h * 3_600_000);
      const network = readCityNetwork(cityId, baseAQI, basePollutants, baseMet);
      (network.nodes || []).forEach(node => {
        if (!node.data) return;
        readings.push({
          timestamp: ts.toISOString(),
          station_code: node.nodeId || node.id,
          station_name: node.name || node.nodeId,
          zone: node.zone || 'Unknown',
          pm25: node.data.pm25, pm10: node.data.pm10,
          no2: node.data.no2, so2: node.data.so2,
          o3: node.data.o3, co: node.data.co,
          temperature: node.data.temperature, humidity: node.data.humidity,
          quality_flag: node.quality || 'VALID',
          battery_pct: node.battery,
        });
      });
    }
    if (!readings.length) throw new Error(`No IoT readings for city: ${cityId}`);
    const headers  = Object.keys(readings[0]);
    const typeInfo = inferColumnTypes(headers, readings);
    const mapping  = autoMap(headers);
    return { headers, rows: readings, typeInfo, mapping, rowCount: readings.length,
             sourceType: 'iot', city: cityId };
  }

  async function fromCPCB(cityId, year, params) {
    if (!window.CPCB_MONTHLY || !window.getCPCBStations) throw new Error('CPCB dataset not loaded');
    const targetParams = params || ['pm25','pm10','no2','so2','o3','co'];
    const years = year ? [year] : [2019,2020,2021,2022,2023];
    const stns  = getCPCBStations(cityId);
    const station = stns[0]?.id || cityId.toUpperCase();
    const rows = [];
    years.forEach(yr => {
      for (let mo = 1; mo <= 12; mo++) {
        const row = { year: yr, month: mo, station_code: station, city: cityId };
        let hasData = false;
        targetParams.forEach(p => {
          const v = getCPCBValueAt?.(cityId, p, new Date(yr, mo - 1, 15));
          row[p] = v ?? null;
          if (v != null) hasData = true;
        });
        if (hasData) rows.push(row);
      }
    });
    const headers  = Object.keys(rows[0] || {});
    const typeInfo = inferColumnTypes(headers, rows);
    const mapping  = autoMap(headers);
    return { headers, rows, typeInfo, mapping, rowCount: rows.length,
             sourceType: 'cpcb', city: cityId };
  }

  async function fromSQLite(sql) {
    if (!window.AQI_DB?.isReady()) throw new Error('Database not initialized');
    const { columns, rows: rawRows, ms } = AQI_DB.query(sql);
    if (!columns.length) throw new Error('Query returned no columns');
    const rows = rawRows.map(r => Object.fromEntries(columns.map((c,i) => [c, r[i]])));
    const typeInfo = inferColumnTypes(columns, rows);
    const mapping  = autoMap(columns);
    return { headers: columns, rows, typeInfo, mapping, rowCount: rows.length,
             sourceType: 'sqlite', queryMs: ms };
  }

  async function fromAPI(cityId, param, hours) {
    if (!window.Fetcher) throw new Error('Fetcher not loaded');
    // Real-time station rows via WAQI (aqicn.org), read directly in the browser.
    const data = await Fetcher.fetchLiveRows(cityId);
    if (!data?.length) throw new Error('No live data — set a WAQI token in localStorage.waqi_token');
    const headers  = Object.keys(data[0]);
    const typeInfo = inferColumnTypes(headers, data);
    const mapping  = autoMap(headers);
    return { headers, rows: data, typeInfo, mapping, rowCount: data.length,
             sourceType: 'api', city: cityId };
  }

  return {
    parseCSV, parseTimestamp, parseNumber,
    inferColumnTypes, autoMap, sniffDelimiter,
    fromCSVFile, fromJSONFile, fromCurrentState,
    fromIoT, fromCPCB, fromSQLite, fromAPI,
    ALIASES,
  };

})();

window.ETL_EXTRACT = ETL_EXTRACT;

/**
 * db-engine.js — SQLite (sql.js) wrapper for the air quality database
 *
 * sql.js runs SQLite compiled to WebAssembly entirely in the browser —
 * no server required. All data lives in memory and can be exported as
 * a binary .sqlite file or SQL dump.
 *
 * Load order dependency: db-schema.js must be loaded first.
 */

const AQI_DB = (() => {

  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2';

  let _db   = null;
  let _SQL  = null;
  let _ready = false;
  let _initPromise = null;

  // ── Initialization ──────────────────────────────────────
  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = _doInit();
    return _initPromise;
  }

  async function _doInit() {
    if (_ready) return _db;
    if (typeof initSqlJs === 'undefined') {
      throw new Error('sql.js not loaded — add <script src="…/sql-wasm.js"> before db-engine.js');
    }
    _SQL = await initSqlJs({ locateFile: f => `${CDN}/${f}` });
    _db  = new _SQL.Database();
    _applySchema();
    _ready = true;
    return _db;
  }

  function _applySchema() {
    const { ALL_DDL } = window.DB_SCHEMA;
    ALL_DDL.forEach(block => {
      // Split on semicolons to execute each statement separately in sql.js
      block.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('/*') && !s.startsWith('--')).forEach(stmt => {
        try {
          _db.run(stmt + ';');
        } catch (e) {
          // Skip comment-only artifacts
          if (!e.message.includes('incomplete input')) {
            console.warn('[AQI_DB] DDL error:', e.message.slice(0, 100), '\n', stmt.slice(0, 80));
          }
        }
      });
    });
  }

  function assertReady() {
    if (!_ready || !_db) throw new Error('Database not initialized — call AQI_DB.init() first');
  }

  // ── Query execution ─────────────────────────────────────

  /** Execute a SELECT and return { columns, rows } */
  function query(sql, params = []) {
    assertReady();
    const t0 = performance.now();
    try {
      const res  = _db.exec(sql, params);
      const ms   = +(performance.now() - t0).toFixed(2);
      if (!res.length) return { columns: [], rows: [], rowCount: 0, ms };
      const { columns, values } = res[0];
      return { columns, rows: values, rowCount: values.length, ms };
    } catch (e) {
      throw new Error(`SQL error: ${e.message}`);
    }
  }

  /** Execute INSERT / UPDATE / DELETE / DDL */
  function run(sql, params = []) {
    assertReady();
    try {
      _db.run(sql, params);
      return _db.getRowsModified();
    } catch (e) {
      throw new Error(`SQL error: ${e.message}`);
    }
  }

  /** Execute a prepared statement with multiple row bindings (fast bulk insert) */
  function runBulk(sql, rowsOfParams) {
    assertReady();
    const stmt = _db.prepare(sql);
    let count = 0;
    _db.run('BEGIN');
    try {
      rowsOfParams.forEach(params => {
        stmt.run(params);
        count++;
      });
      _db.run('COMMIT');
    } catch (e) {
      _db.run('ROLLBACK');
      stmt.free();
      throw new Error(`Bulk insert error: ${e.message}`);
    }
    stmt.free();
    return count;
  }

  // ── Introspection ───────────────────────────────────────

  /** List all tables (excluding sqlite internals) */
  function listTables() {
    const { rows } = query(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    return rows.map(r => r[0]);
  }

  /** List all views */
  function listViews() {
    const { rows } = query(`
      SELECT name FROM sqlite_master
      WHERE type='view'
      ORDER BY name
    `);
    return rows.map(r => r[0]);
  }

  /** Return column info for a table using PRAGMA */
  function tableInfo(tableName) {
    return query(`PRAGMA table_info("${tableName}")`);
  }

  /** Return row count for a table */
  function rowCount(tableName) {
    const { rows } = query(`SELECT COUNT(*) FROM "${tableName}"`);
    return rows[0]?.[0] ?? 0;
  }

  /** Row counts for all tables */
  function allRowCounts() {
    const tables = listTables();
    const counts = {};
    tables.forEach(t => { counts[t] = rowCount(t); });
    return counts;
  }

  /** Approximate DB size in bytes (SQLite page count × page size) */
  function dbSize() {
    try {
      const { rows: pc } = query('PRAGMA page_count');
      const { rows: ps } = query('PRAGMA page_size');
      return (pc[0]?.[0] ?? 0) * (ps[0]?.[0] ?? 4096);
    } catch { return 0; }
  }

  /** Return index list for a table */
  function indexList(tableName) {
    return query(`PRAGMA index_list("${tableName}")`);
  }

  // ── Export ──────────────────────────────────────────────

  /** Export entire database as binary Uint8Array (.sqlite) */
  function exportBinary() {
    assertReady();
    return _db.export();
  }

  /** Export as a SQL dump (INSERT statements for all tables) */
  function exportSQL(tables) {
    assertReady();
    const allTables = tables || listTables();
    const lines = [
      '-- Air Quality Database Export',
      `-- Exported: ${new Date().toISOString()}`,
      'PRAGMA foreign_keys = ON;',
      '',
    ];

    // Schema first
    const { rows: schemaRows } = query(`
      SELECT sql FROM sqlite_master
      WHERE type IN ('table','index','trigger')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type DESC, name
    `);
    schemaRows.forEach(r => { if (r[0]) { lines.push(r[0] + ';'); lines.push(''); } });

    // Data
    allTables.forEach(t => {
      const { columns, rows } = query(`SELECT * FROM "${t}"`);
      if (!rows.length) return;
      lines.push(`-- ${t} (${rows.length} rows)`);
      rows.forEach(row => {
        const vals = row.map(v =>
          v === null       ? 'NULL'
          : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'`
          : v
        ).join(', ');
        lines.push(`INSERT INTO "${t}" (${columns.map(c=>`"${c}"`).join(', ')}) VALUES (${vals});`);
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  /** Trigger file download of the binary .sqlite */
  function downloadSQLite(filename = 'air-quality.sqlite') {
    const data = exportBinary();
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  /** Trigger file download of the SQL dump */
  function downloadSQL(filename = 'air-quality-dump.sql') {
    const sql  = exportSQL();
    const blob = new Blob([sql], { type: 'text/sql;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Convenience query helpers ───────────────────────────

  /** Return the last inserted row ID */
  function lastInsertId() {
    const { rows } = query('SELECT last_insert_rowid()');
    return rows[0]?.[0];
  }

  function isReady() { return _ready; }
  function raw()     { assertReady(); return _db; }

  return {
    init, isReady, raw,
    query, run, runBulk,
    listTables, listViews, tableInfo, rowCount, allRowCounts, dbSize, indexList,
    exportBinary, exportSQL, downloadSQLite, downloadSQL,
    lastInsertId,
  };

})();

window.AQI_DB = AQI_DB;

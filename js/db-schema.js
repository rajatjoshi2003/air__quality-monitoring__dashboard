/**
 * Relational Database Schema — Air Quality Monitoring System
 *
 * Design principles:
 *   • Third Normal Form (3NF): no transitive or partial dependencies
 *   • Every measurement stored once; aggregates are derived materialized views
 *   • Separate concerns: geography / infrastructure / time-series / operations
 *   • Indexes cover the dominant query patterns for time-series analytics
 *   • Foreign keys with ON DELETE semantics protect referential integrity
 *   • CHECK constraints enforce domain validity at the DB level
 */

// ════════════════════════════════════════════════════════════
// PRAGMA
// ════════════════════════════════════════════════════════════
const SQL_PRAGMA = `
PRAGMA foreign_keys  = ON;
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA cache_size    = -8000;
PRAGMA temp_store    = MEMORY;
`;

// ════════════════════════════════════════════════════════════
// TABLE DEFINITIONS
// ════════════════════════════════════════════════════════════

// ── Layer 1: Geography ─────────────────────────────────────
const SQL_TABLE_REGIONS = `
CREATE TABLE IF NOT EXISTS regions (
  region_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  region_type  TEXT    NOT NULL CHECK(region_type IN ('country','state','city','district','zone')),
  parent_id    INTEGER REFERENCES regions(region_id) ON DELETE SET NULL,
  iso_code     TEXT,
  lat          REAL    CHECK(lat  BETWEEN -90  AND 90),
  lng          REAL    CHECK(lng  BETWEEN -180 AND 180),
  population   INTEGER CHECK(population >= 0),
  area_km2     REAL    CHECK(area_km2   >= 0),
  timezone     TEXT    DEFAULT 'Asia/Kolkata',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
/* Adjacency-list hierarchy: country → state → city → district */
`;

// ── Layer 2: Infrastructure ────────────────────────────────
const SQL_TABLE_STATIONS = `
CREATE TABLE IF NOT EXISTS stations (
  station_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id    INTEGER NOT NULL REFERENCES regions(region_id) ON DELETE RESTRICT,
  station_code TEXT    UNIQUE NOT NULL,
  name         TEXT    NOT NULL,
  station_type TEXT    NOT NULL CHECK(station_type IN (
                  'reference','indicative','low_cost','mobile','satellite')),
  zone_type    TEXT    CHECK(zone_type IN (
                  'industrial','traffic','residential','commercial','ambient','background')),
  operator     TEXT,
  lat          REAL    NOT NULL CHECK(lat  BETWEEN -90  AND 90),
  lng          REAL    NOT NULL CHECK(lng  BETWEEN -180 AND 180),
  elevation_m  REAL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  installed_at TEXT,
  decommissioned_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

const SQL_TABLE_PARAMETERS = `
CREATE TABLE IF NOT EXISTS parameters (
  parameter_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    UNIQUE NOT NULL,
  name           TEXT    NOT NULL,
  full_name      TEXT,
  category       TEXT    CHECK(category IN ('pollutant','meteorological','derived')),
  standard_unit  TEXT    NOT NULL,
  molecular_weight REAL,
  who_annual_ugm3  REAL,
  who_24h_ugm3     REAL,
  naaqs_annual_ugm3 REAL,
  naaqs_24h_ugm3   REAL,
  hard_min       REAL,
  hard_max       REAL,
  description    TEXT
);
`;

const SQL_TABLE_SENSORS = `
CREATE TABLE IF NOT EXISTS sensors (
  sensor_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id       INTEGER NOT NULL REFERENCES stations(station_id)  ON DELETE CASCADE,
  parameter_id     INTEGER NOT NULL REFERENCES parameters(parameter_id) ON DELETE RESTRICT,
  sensor_code      TEXT    UNIQUE,
  model            TEXT,
  manufacturer     TEXT,
  measurement_tech TEXT    CHECK(measurement_tech IN (
                      'optical','electrochemical','chemiluminescence',
                      'gravimetric','uv_photometry','beta_attenuation',
                      'NDIR','flame_ionisation','nephelometry')),
  accuracy_pct     REAL    CHECK(accuracy_pct BETWEEN 0 AND 100),
  detection_limit  REAL    CHECK(detection_limit >= 0),
  installed_at     TEXT,
  last_calibration TEXT,
  next_calibration TEXT,
  firmware_version TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

const SQL_TABLE_DATA_SOURCES = `
CREATE TABLE IF NOT EXISTS data_sources (
  source_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  source_type     TEXT    CHECK(source_type IN (
                    'api','file_upload','iot_stream','manual_entry','derived','cpcb_report')),
  provider        TEXT,
  url             TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  auth_required   INTEGER NOT NULL DEFAULT 0,
  last_fetch_at   TEXT,
  records_fetched INTEGER NOT NULL DEFAULT 0 CHECK(records_fetched >= 0),
  avg_latency_ms  INTEGER CHECK(avg_latency_ms >= 0),
  reliability_pct REAL    CHECK(reliability_pct BETWEEN 0 AND 100),
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

// ── Layer 3: Core Time-Series ──────────────────────────────
const SQL_TABLE_MEASUREMENTS = `
CREATE TABLE IF NOT EXISTS measurements (
  measurement_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id      INTEGER NOT NULL REFERENCES stations(station_id)   ON DELETE CASCADE,
  parameter_id    INTEGER NOT NULL REFERENCES parameters(parameter_id) ON DELETE RESTRICT,
  sensor_id       INTEGER          REFERENCES sensors(sensor_id)      ON DELETE SET NULL,
  source_id       INTEGER          REFERENCES data_sources(source_id) ON DELETE SET NULL,
  timestamp_utc   TEXT    NOT NULL,
  timestamp_local TEXT,
  value           REAL,             -- cleaned / pipeline-corrected value
  raw_value       REAL,             -- as-received from the instrument
  unit            TEXT,
  quality_flag    TEXT    NOT NULL DEFAULT 'VALID'
                    CHECK(quality_flag IN ('VALID','SUSPECT','MISSING','OUTLIER','CORRECTED','ESTIMATED')),
  is_imputed      INTEGER NOT NULL DEFAULT 0 CHECK(is_imputed IN (0,1)),
  is_outlier      INTEGER NOT NULL DEFAULT 0 CHECK(is_outlier IN (0,1)),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(station_id, parameter_id, timestamp_utc)
);
/* Partition hint (for migration to PostgreSQL/TimescaleDB):
   PARTITION BY RANGE (timestamp_utc) — monthly partitions recommended
   when table exceeds ~50M rows.                                         */
`;

// ── Layer 4: Pre-computed Aggregates ──────────────────────
const SQL_TABLE_HOURLY_AGG = `
CREATE TABLE IF NOT EXISTS hourly_aggregates (
  agg_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id    INTEGER NOT NULL REFERENCES stations(station_id)   ON DELETE CASCADE,
  parameter_id  INTEGER NOT NULL REFERENCES parameters(parameter_id) ON DELETE CASCADE,
  hour_utc      TEXT    NOT NULL,   -- ISO-8601 truncated to hour: '2023-11-15T08:00:00'
  mean_value    REAL,
  min_value     REAL,
  max_value     REAL,
  std_value     REAL    CHECK(std_value >= 0),
  record_count  INTEGER CHECK(record_count >= 0),
  valid_count   INTEGER CHECK(valid_count  >= 0),
  completeness  REAL    CHECK(completeness BETWEEN 0 AND 100),
  UNIQUE(station_id, parameter_id, hour_utc)
);
`;

const SQL_TABLE_DAILY_AGG = `
CREATE TABLE IF NOT EXISTS daily_aggregates (
  agg_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id     INTEGER NOT NULL REFERENCES stations(station_id)    ON DELETE CASCADE,
  parameter_id   INTEGER NOT NULL REFERENCES parameters(parameter_id) ON DELETE CASCADE,
  date           TEXT    NOT NULL,  -- YYYY-MM-DD
  mean_value     REAL,
  min_value      REAL,
  max_value      REAL,
  p25_value      REAL,
  p75_value      REAL,
  p95_value      REAL,
  record_count   INTEGER CHECK(record_count >= 0),
  valid_count    INTEGER CHECK(valid_count  >= 0),
  completeness   REAL    CHECK(completeness BETWEEN 0 AND 100),
  exceeds_who    INTEGER NOT NULL DEFAULT 0 CHECK(exceeds_who    IN (0,1)),
  exceeds_naaqs  INTEGER NOT NULL DEFAULT 0 CHECK(exceeds_naaqs  IN (0,1)),
  UNIQUE(station_id, parameter_id, date)
);
`;

const SQL_TABLE_MONTHLY_AGG = `
CREATE TABLE IF NOT EXISTS monthly_aggregates (
  agg_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id          INTEGER NOT NULL REFERENCES stations(station_id)    ON DELETE CASCADE,
  parameter_id        INTEGER NOT NULL REFERENCES parameters(parameter_id) ON DELETE CASCADE,
  year                INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2100),
  month               INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  mean_value          REAL,
  min_value           REAL,
  max_value           REAL,
  record_count        INTEGER CHECK(record_count >= 0),
  valid_count         INTEGER CHECK(valid_count  >= 0),
  days_exceeding_who  INTEGER NOT NULL DEFAULT 0 CHECK(days_exceeding_who  >= 0),
  days_exceeding_naaqs INTEGER NOT NULL DEFAULT 0 CHECK(days_exceeding_naaqs >= 0),
  source              TEXT    NOT NULL DEFAULT 'cpcb',
  UNIQUE(station_id, parameter_id, year, month)
);
`;

// ── Layer 5: Derived AQI ───────────────────────────────────
const SQL_TABLE_AQI_READINGS = `
CREATE TABLE IF NOT EXISTS aqi_readings (
  aqi_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id         INTEGER NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
  timestamp_utc      TEXT    NOT NULL,
  aqi_value          INTEGER CHECK(aqi_value BETWEEN 0 AND 500),
  aqi_category       TEXT    CHECK(aqi_category IN (
                       'Good','Moderate','Unhealthy for Sensitive Groups',
                       'Unhealthy','Very Unhealthy','Hazardous')),
  dominant_pollutant TEXT,
  pm25_sub_index     INTEGER CHECK(pm25_sub_index BETWEEN 0 AND 500),
  pm10_sub_index     INTEGER CHECK(pm10_sub_index BETWEEN 0 AND 500),
  no2_sub_index      INTEGER CHECK(no2_sub_index  BETWEEN 0 AND 500),
  so2_sub_index      INTEGER CHECK(so2_sub_index  BETWEEN 0 AND 500),
  o3_sub_index       INTEGER CHECK(o3_sub_index   BETWEEN 0 AND 500),
  co_sub_index       INTEGER CHECK(co_sub_index   BETWEEN 0 AND 500),
  calc_method        TEXT    NOT NULL DEFAULT 'us_epa'
                       CHECK(calc_method IN ('us_epa','cpcb','who','nowcast')),
  UNIQUE(station_id, timestamp_utc)
);
`;

// ── Layer 6: Operations & Governance ──────────────────────
const SQL_TABLE_PIPELINE_RUNS = `
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id        INTEGER          REFERENCES regions(region_id) ON DELETE SET NULL,
  started_at     TEXT    NOT NULL,
  finished_at    TEXT,
  config_json    TEXT,
  total_records  INTEGER NOT NULL DEFAULT 0 CHECK(total_records >= 0),
  issues_found   INTEGER NOT NULL DEFAULT 0 CHECK(issues_found  >= 0),
  issues_fixed   INTEGER NOT NULL DEFAULT 0 CHECK(issues_fixed  >= 0),
  quality_before REAL    CHECK(quality_before BETWEEN 0 AND 100),
  quality_after  REAL    CHECK(quality_after  BETWEEN 0 AND 100),
  duration_ms    INTEGER CHECK(duration_ms >= 0),
  status         TEXT    NOT NULL DEFAULT 'running'
                   CHECK(status IN ('running','completed','failed','cancelled'))
);
`;

const SQL_TABLE_QUALITY_LOG = `
CREATE TABLE IF NOT EXISTS quality_log (
  log_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER          REFERENCES pipeline_runs(run_id) ON DELETE SET NULL,
  station_id        INTEGER          REFERENCES stations(station_id)  ON DELETE SET NULL,
  parameter_id      INTEGER          REFERENCES parameters(parameter_id) ON DELETE SET NULL,
  measurement_id    INTEGER          REFERENCES measurements(measurement_id) ON DELETE SET NULL,
  timestamp_utc     TEXT,
  issue_type        TEXT    NOT NULL CHECK(issue_type IN (
                      'missing','sentinel','unit_error','outlier','range_hard',
                      'range_soft','consistency','imputed','recalculated')),
  original_value    REAL,
  corrected_value   REAL,
  correction_method TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

const SQL_TABLE_ALERTS = `
CREATE TABLE IF NOT EXISTS alerts (
  alert_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id      INTEGER NOT NULL REFERENCES stations(station_id)   ON DELETE CASCADE,
  parameter_id    INTEGER          REFERENCES parameters(parameter_id) ON DELETE SET NULL,
  timestamp_utc   TEXT    NOT NULL,
  alert_type      TEXT    NOT NULL CHECK(alert_type IN (
                    'aqi_threshold','pm_threshold','sensor_offline',
                    'data_gap','calibration_due','outlier_cluster',
                    'rapid_change','who_exceeded')),
  severity        TEXT    NOT NULL CHECK(severity IN ('info','warning','critical','emergency')),
  threshold_value REAL,
  observed_value  REAL,
  message         TEXT,
  is_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(is_acknowledged IN (0,1)),
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  is_resolved     INTEGER NOT NULL DEFAULT 0 CHECK(is_resolved IN (0,1)),
  resolved_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

const SQL_TABLE_CALIBRATION = `
CREATE TABLE IF NOT EXISTS calibration_records (
  cal_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id        INTEGER NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  calibration_date TEXT    NOT NULL,
  next_due_date    TEXT,
  cal_type         TEXT    CHECK(cal_type IN (
                     'zero_span','multipoint','field','laboratory','factory')),
  zero_offset      REAL,
  span_factor      REAL,
  r_squared        REAL    CHECK(r_squared BETWEEN 0 AND 1),
  rmse             REAL    CHECK(rmse >= 0),
  technician       TEXT,
  certificate_ref  TEXT,
  passed           INTEGER NOT NULL DEFAULT 1 CHECK(passed IN (0,1)),
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

// ════════════════════════════════════════════════════════════
// INDEXES
// ════════════════════════════════════════════════════════════
const SQL_INDEXES = `
-- measurements: primary analytical query pattern
CREATE INDEX IF NOT EXISTS idx_meas_spt   ON measurements(station_id, parameter_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_meas_time  ON measurements(timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_meas_flag  ON measurements(quality_flag);
CREATE INDEX IF NOT EXISTS idx_meas_param ON measurements(parameter_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_meas_src   ON measurements(source_id);

-- aggregates
CREATE INDEX IF NOT EXISTS idx_hourly_spt  ON hourly_aggregates(station_id, parameter_id, hour_utc);
CREATE INDEX IF NOT EXISTS idx_daily_spd   ON daily_aggregates(station_id, parameter_id, date);
CREATE INDEX IF NOT EXISTS idx_monthly_spy ON monthly_aggregates(station_id, parameter_id, year, month);

-- aqi
CREATE INDEX IF NOT EXISTS idx_aqi_st     ON aqi_readings(station_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_aqi_val    ON aqi_readings(aqi_value);
CREATE INDEX IF NOT EXISTS idx_aqi_cat    ON aqi_readings(aqi_category);

-- stations
CREATE INDEX IF NOT EXISTS idx_sta_region ON stations(region_id);
CREATE INDEX IF NOT EXISTS idx_sta_active ON stations(is_active);
CREATE INDEX IF NOT EXISTS idx_sta_zone   ON stations(zone_type);

-- regions hierarchy
CREATE INDEX IF NOT EXISTS idx_reg_parent ON regions(parent_id);
CREATE INDEX IF NOT EXISTS idx_reg_type   ON regions(region_type);

-- quality log
CREATE INDEX IF NOT EXISTS idx_qlog_run   ON quality_log(run_id);
CREATE INDEX IF NOT EXISTS idx_qlog_type  ON quality_log(issue_type);
CREATE INDEX IF NOT EXISTS idx_qlog_param ON quality_log(parameter_id);

-- alerts
CREATE INDEX IF NOT EXISTS idx_alerts_sta      ON alerts(station_id);
CREATE INDEX IF NOT EXISTS idx_alerts_open     ON alerts(is_resolved, severity);
CREATE INDEX IF NOT EXISTS idx_alerts_type     ON alerts(alert_type, timestamp_utc);

-- sensors
CREATE INDEX IF NOT EXISTS idx_sensor_sta   ON sensors(station_id);
CREATE INDEX IF NOT EXISTS idx_sensor_param ON sensors(parameter_id);
CREATE INDEX IF NOT EXISTS idx_sensor_cal   ON sensors(next_calibration);
`;

// ════════════════════════════════════════════════════════════
// VIEWS
// ════════════════════════════════════════════════════════════
const SQL_VIEWS = `
-- Latest value per station/parameter
CREATE VIEW IF NOT EXISTS vw_latest_measurements AS
SELECT
  r.name        AS city,
  s.station_code,
  s.name        AS station,
  s.zone_type,
  p.code        AS parameter,
  p.standard_unit AS unit,
  m.value,
  m.quality_flag,
  m.timestamp_utc
FROM measurements m
JOIN stations   s ON m.station_id   = s.station_id
JOIN regions    r ON s.region_id    = r.region_id
JOIN parameters p ON m.parameter_id = p.parameter_id
WHERE m.measurement_id IN (
  SELECT MAX(measurement_id)
  FROM   measurements
  GROUP BY station_id, parameter_id
)
ORDER BY r.name, s.station_code, p.code;

-- Current AQI ranked by severity
CREATE VIEW IF NOT EXISTS vw_aqi_summary AS
SELECT
  r.name          AS city,
  s.name          AS station,
  s.station_code,
  s.zone_type,
  s.lat, s.lng,
  a.aqi_value,
  a.aqi_category,
  a.dominant_pollutant,
  a.timestamp_utc
FROM aqi_readings a
JOIN stations s ON a.station_id = s.station_id
JOIN regions  r ON s.region_id  = r.region_id
WHERE a.aqi_id IN (
  SELECT MAX(aqi_id) FROM aqi_readings GROUP BY station_id
)
ORDER BY a.aqi_value DESC;

-- WHO guideline exceedances (daily)
CREATE VIEW IF NOT EXISTS vw_who_exceedances AS
SELECT
  r.name          AS city,
  s.name          AS station,
  p.code          AS parameter,
  p.standard_unit AS unit,
  p.who_annual_ugm3 AS who_limit,
  da.date,
  da.mean_value,
  ROUND(da.mean_value / p.who_annual_ugm3, 2) AS exceedance_ratio,
  da.exceeds_naaqs
FROM daily_aggregates da
JOIN stations   s ON da.station_id   = s.station_id
JOIN regions    r ON s.region_id     = r.region_id
JOIN parameters p ON da.parameter_id = p.parameter_id
WHERE da.mean_value > p.who_annual_ugm3
  AND p.who_annual_ugm3 IS NOT NULL
ORDER BY exceedance_ratio DESC;

-- NAAQS compliance summary by city
CREATE VIEW IF NOT EXISTS vw_naaqs_compliance AS
SELECT
  r.name          AS city,
  p.code          AS parameter,
  p.naaqs_annual_ugm3 AS naaqs_limit,
  COUNT(*)        AS station_count,
  ROUND(AVG(ma.mean_value), 1) AS annual_mean,
  ROUND(AVG(ma.mean_value) / p.naaqs_annual_ugm3 * 100, 1) AS pct_of_naaqs,
  SUM(ma.days_exceeding_naaqs)  AS total_exceedance_days
FROM monthly_aggregates ma
JOIN stations   s ON ma.station_id   = s.station_id
JOIN regions    r ON s.region_id     = r.region_id
JOIN parameters p ON ma.parameter_id = p.parameter_id
WHERE ma.year = 2023
  AND p.naaqs_annual_ugm3 IS NOT NULL
GROUP BY r.name, p.code
ORDER BY pct_of_naaqs DESC;

-- Data completeness by station
CREATE VIEW IF NOT EXISTS vw_data_completeness AS
SELECT
  r.name          AS city,
  s.name          AS station,
  s.station_code,
  p.code          AS parameter,
  COUNT(*)        AS total_records,
  SUM(CASE WHEN m.quality_flag = 'VALID'     THEN 1 ELSE 0 END) AS valid_count,
  SUM(CASE WHEN m.is_imputed  = 1            THEN 1 ELSE 0 END) AS imputed_count,
  SUM(CASE WHEN m.quality_flag = 'OUTLIER'   THEN 1 ELSE 0 END) AS outlier_count,
  SUM(CASE WHEN m.quality_flag = 'MISSING'   THEN 1 ELSE 0 END) AS missing_count,
  ROUND(100.0 * SUM(CASE WHEN m.quality_flag = 'VALID' THEN 1 ELSE 0 END) / COUNT(*), 1) AS completeness_pct
FROM measurements m
JOIN stations   s ON m.station_id   = s.station_id
JOIN regions    r ON s.region_id    = r.region_id
JOIN parameters p ON m.parameter_id = p.parameter_id
GROUP BY m.station_id, m.parameter_id
ORDER BY completeness_pct;

-- Sensor calibration health
CREATE VIEW IF NOT EXISTS vw_sensor_health AS
SELECT
  r.name           AS city,
  s.name           AS station,
  p.code           AS parameter,
  se.model,
  se.manufacturer,
  se.measurement_tech,
  se.last_calibration,
  se.next_calibration,
  CASE
    WHEN se.next_calibration IS NULL THEN 'UNKNOWN'
    WHEN julianday('now') - julianday(se.next_calibration) > 0  THEN 'OVERDUE'
    WHEN julianday(se.next_calibration) - julianday('now') < 30 THEN 'DUE_SOON'
    ELSE 'OK'
  END AS calibration_status,
  se.is_active
FROM sensors se
JOIN stations   s ON se.station_id   = s.station_id
JOIN regions    r ON s.region_id     = r.region_id
JOIN parameters p ON se.parameter_id = p.parameter_id
ORDER BY calibration_status DESC, se.next_calibration;

-- Active alerts with context
CREATE VIEW IF NOT EXISTS vw_open_alerts AS
SELECT
  a.alert_id,
  r.name          AS city,
  s.name          AS station,
  p.code          AS parameter,
  a.alert_type,
  a.severity,
  a.threshold_value,
  a.observed_value,
  a.message,
  a.timestamp_utc,
  a.created_at
FROM alerts a
JOIN stations   s ON a.station_id   = s.station_id
JOIN regions    r ON s.region_id    = r.region_id
LEFT JOIN parameters p ON a.parameter_id = p.parameter_id
WHERE a.is_resolved = 0
ORDER BY CASE a.severity
  WHEN 'emergency' THEN 1
  WHEN 'critical'  THEN 2
  WHEN 'warning'   THEN 3
  ELSE 4 END, a.timestamp_utc DESC;

-- Pipeline run summary
CREATE VIEW IF NOT EXISTS vw_pipeline_summary AS
SELECT
  pr.run_id,
  r.name          AS city,
  pr.started_at,
  pr.duration_ms,
  pr.total_records,
  pr.issues_found,
  pr.issues_fixed,
  ROUND(pr.issues_fixed * 100.0 / NULLIF(pr.issues_found, 0), 1) AS fix_rate_pct,
  pr.quality_before,
  pr.quality_after,
  ROUND(pr.quality_after - pr.quality_before, 1) AS quality_gain,
  pr.status
FROM pipeline_runs pr
LEFT JOIN regions r ON pr.city_id = r.region_id
ORDER BY pr.started_at DESC;
`;

// ════════════════════════════════════════════════════════════
// TRIGGERS
// ════════════════════════════════════════════════════════════
const SQL_TRIGGERS = `
-- Auto-generate an alert when AQI > 200 (Very Unhealthy) is inserted
CREATE TRIGGER IF NOT EXISTS trg_alert_on_aqi
AFTER INSERT ON aqi_readings
WHEN NEW.aqi_value >= 200
BEGIN
  INSERT OR IGNORE INTO alerts (
    station_id, parameter_id, timestamp_utc,
    alert_type, severity, threshold_value, observed_value, message
  ) VALUES (
    NEW.station_id,
    NULL,
    NEW.timestamp_utc,
    'aqi_threshold',
    CASE
      WHEN NEW.aqi_value >= 300 THEN 'emergency'
      WHEN NEW.aqi_value >= 200 THEN 'critical'
      ELSE 'warning'
    END,
    200,
    NEW.aqi_value,
    'AQI ' || NEW.aqi_value || ' (' || NEW.aqi_category || ') at station ' || NEW.station_id
  );
END;

-- Recalculate hourly aggregate when measurement inserted
CREATE TRIGGER IF NOT EXISTS trg_update_hourly_agg
AFTER INSERT ON measurements
WHEN NEW.value IS NOT NULL
BEGIN
  INSERT INTO hourly_aggregates (
    station_id, parameter_id, hour_utc,
    mean_value, min_value, max_value, record_count, valid_count, completeness
  )
  SELECT
    NEW.station_id,
    NEW.parameter_id,
    strftime('%Y-%m-%dT%H:00:00', NEW.timestamp_utc) AS hour_utc,
    ROUND(AVG(value), 3),
    ROUND(MIN(value), 3),
    ROUND(MAX(value), 3),
    COUNT(*),
    SUM(CASE WHEN quality_flag = 'VALID' THEN 1 ELSE 0 END),
    ROUND(100.0 * SUM(CASE WHEN quality_flag = 'VALID' THEN 1 ELSE 0 END) / COUNT(*), 1)
  FROM measurements
  WHERE station_id   = NEW.station_id
    AND parameter_id = NEW.parameter_id
    AND timestamp_utc LIKE strftime('%Y-%m-%dT%H', NEW.timestamp_utc) || '%'
  ON CONFLICT(station_id, parameter_id, hour_utc) DO UPDATE SET
    mean_value   = excluded.mean_value,
    min_value    = excluded.min_value,
    max_value    = excluded.max_value,
    record_count = excluded.record_count,
    valid_count  = excluded.valid_count,
    completeness = excluded.completeness;
END;

-- Log quality issue automatically on flag change
CREATE TRIGGER IF NOT EXISTS trg_log_quality_change
AFTER UPDATE OF quality_flag ON measurements
WHEN OLD.quality_flag != NEW.quality_flag
BEGIN
  INSERT INTO quality_log (
    station_id, parameter_id, measurement_id,
    timestamp_utc, issue_type, original_value, corrected_value
  ) VALUES (
    NEW.station_id, NEW.parameter_id, NEW.measurement_id,
    NEW.timestamp_utc,
    LOWER(NEW.quality_flag),
    OLD.value,
    NEW.value
  );
END;
`;

// ════════════════════════════════════════════════════════════
// SCHEMA METADATA (for UI rendering)
// ════════════════════════════════════════════════════════════
const SCHEMA_META = {
  regions: {
    label: 'regions', layer: 'Geography', color: '#22c55e',
    desc: 'Geographic hierarchy: country → state → city → district (self-referential adjacency list)',
    pk: 'region_id',
    columns: [
      { name:'region_id',   type:'INTEGER', pk:true,  fk:null,     nullable:false, note:'Auto PK' },
      { name:'name',        type:'TEXT',    pk:false, fk:null,     nullable:false, note:'' },
      { name:'region_type', type:'TEXT',    pk:false, fk:null,     nullable:false, note:'country|state|city|district|zone' },
      { name:'parent_id',   type:'INTEGER', pk:false, fk:'regions.region_id', nullable:true, note:'Self-ref for hierarchy' },
      { name:'iso_code',    type:'TEXT',    pk:false, fk:null,     nullable:true,  note:'' },
      { name:'lat',         type:'REAL',    pk:false, fk:null,     nullable:true,  note:'−90 to 90' },
      { name:'lng',         type:'REAL',    pk:false, fk:null,     nullable:true,  note:'−180 to 180' },
      { name:'population',  type:'INTEGER', pk:false, fk:null,     nullable:true,  note:'>= 0' },
      { name:'area_km2',    type:'REAL',    pk:false, fk:null,     nullable:true,  note:'>= 0' },
      { name:'timezone',    type:'TEXT',    pk:false, fk:null,     nullable:true,  note:'Default Asia/Kolkata' },
      { name:'created_at',  type:'TEXT',    pk:false, fk:null,     nullable:false, note:'Auto datetime' },
    ],
    indexes: ['idx_reg_parent','idx_reg_type'],
  },
  stations: {
    label: 'stations', layer: 'Infrastructure', color: '#3b82f6',
    desc: 'Physical monitoring locations with geographic, type, and operational metadata',
    pk: 'station_id',
    columns: [
      { name:'station_id',   type:'INTEGER', pk:true,  fk:null,              nullable:false },
      { name:'region_id',    type:'INTEGER', pk:false, fk:'regions.region_id', nullable:false },
      { name:'station_code', type:'TEXT',    pk:false, fk:null,              nullable:false, note:'UNIQUE' },
      { name:'name',         type:'TEXT',    pk:false, fk:null,              nullable:false },
      { name:'station_type', type:'TEXT',    pk:false, fk:null,              nullable:false, note:'reference|indicative|low_cost|mobile' },
      { name:'zone_type',    type:'TEXT',    pk:false, fk:null,              nullable:true,  note:'industrial|traffic|residential|...' },
      { name:'operator',     type:'TEXT',    pk:false, fk:null,              nullable:true },
      { name:'lat',          type:'REAL',    pk:false, fk:null,              nullable:false },
      { name:'lng',          type:'REAL',    pk:false, fk:null,              nullable:false },
      { name:'elevation_m',  type:'REAL',    pk:false, fk:null,              nullable:true },
      { name:'is_active',    type:'INTEGER', pk:false, fk:null,              nullable:false, note:'0 or 1' },
      { name:'installed_at', type:'TEXT',    pk:false, fk:null,              nullable:true },
    ],
    indexes: ['idx_sta_region','idx_sta_active','idx_sta_zone'],
  },
  parameters: {
    label: 'parameters', layer: 'Reference', color: '#a855f7',
    desc: 'Pollutant and meteorological parameter definitions with WHO / NAAQS guideline values',
    pk: 'parameter_id',
    columns: [
      { name:'parameter_id',      type:'INTEGER', pk:true,  fk:null, nullable:false },
      { name:'code',              type:'TEXT',    pk:false, fk:null, nullable:false, note:'UNIQUE — pm25|pm10|no2|...' },
      { name:'name',              type:'TEXT',    pk:false, fk:null, nullable:false },
      { name:'full_name',         type:'TEXT',    pk:false, fk:null, nullable:true },
      { name:'category',          type:'TEXT',    pk:false, fk:null, nullable:true,  note:'pollutant|meteorological|derived' },
      { name:'standard_unit',     type:'TEXT',    pk:false, fk:null, nullable:false },
      { name:'molecular_weight',  type:'REAL',    pk:false, fk:null, nullable:true },
      { name:'who_annual_ugm3',   type:'REAL',    pk:false, fk:null, nullable:true,  note:'WHO 2021 annual guideline' },
      { name:'who_24h_ugm3',      type:'REAL',    pk:false, fk:null, nullable:true,  note:'WHO 2021 24h guideline' },
      { name:'naaqs_annual_ugm3', type:'REAL',    pk:false, fk:null, nullable:true,  note:'India NAAQS annual' },
      { name:'naaqs_24h_ugm3',    type:'REAL',    pk:false, fk:null, nullable:true,  note:'India NAAQS 24h' },
      { name:'hard_min',          type:'REAL',    pk:false, fk:null, nullable:true,  note:'Physical impossibility below' },
      { name:'hard_max',          type:'REAL',    pk:false, fk:null, nullable:true,  note:'Physical impossibility above' },
      { name:'description',       type:'TEXT',    pk:false, fk:null, nullable:true },
    ],
    indexes: [],
  },
  sensors: {
    label: 'sensors', layer: 'Infrastructure', color: '#3b82f6',
    desc: 'Individual sensor instruments at each station, one row per (station, parameter) pair',
    pk: 'sensor_id',
    columns: [
      { name:'sensor_id',       type:'INTEGER', pk:true,  fk:null,                    nullable:false },
      { name:'station_id',      type:'INTEGER', pk:false, fk:'stations.station_id',   nullable:false },
      { name:'parameter_id',    type:'INTEGER', pk:false, fk:'parameters.parameter_id', nullable:false },
      { name:'sensor_code',     type:'TEXT',    pk:false, fk:null,                    nullable:true, note:'UNIQUE' },
      { name:'model',           type:'TEXT',    pk:false, fk:null,                    nullable:true },
      { name:'manufacturer',    type:'TEXT',    pk:false, fk:null,                    nullable:true },
      { name:'measurement_tech',type:'TEXT',    pk:false, fk:null,                    nullable:true },
      { name:'accuracy_pct',    type:'REAL',    pk:false, fk:null,                    nullable:true },
      { name:'detection_limit', type:'REAL',    pk:false, fk:null,                    nullable:true },
      { name:'last_calibration',type:'TEXT',    pk:false, fk:null,                    nullable:true },
      { name:'next_calibration',type:'TEXT',    pk:false, fk:null,                    nullable:true },
      { name:'is_active',       type:'INTEGER', pk:false, fk:null,                    nullable:false, note:'0 or 1' },
    ],
    indexes: ['idx_sensor_sta','idx_sensor_param','idx_sensor_cal'],
  },
  data_sources: {
    label: 'data_sources', layer: 'Reference', color: '#a855f7',
    desc: 'Registry of upstream data providers (API, IoT stream, file upload, CPCB reports)',
    pk: 'source_id',
    columns: [
      { name:'source_id',       type:'INTEGER', pk:true,  fk:null, nullable:false },
      { name:'name',            type:'TEXT',    pk:false, fk:null, nullable:false, note:'UNIQUE' },
      { name:'source_type',     type:'TEXT',    pk:false, fk:null, nullable:true },
      { name:'provider',        type:'TEXT',    pk:false, fk:null, nullable:true },
      { name:'url',             type:'TEXT',    pk:false, fk:null, nullable:true },
      { name:'is_active',       type:'INTEGER', pk:false, fk:null, nullable:false },
      { name:'last_fetch_at',   type:'TEXT',    pk:false, fk:null, nullable:true },
      { name:'records_fetched', type:'INTEGER', pk:false, fk:null, nullable:false },
      { name:'reliability_pct', type:'REAL',    pk:false, fk:null, nullable:true },
    ],
    indexes: [],
  },
  measurements: {
    label: 'measurements', layer: 'Time-Series', color: '#f97316',
    desc: 'Core time-series table — one row per (station, parameter, timestamp). Unique constraint prevents duplicates.',
    pk: 'measurement_id',
    columns: [
      { name:'measurement_id', type:'INTEGER', pk:true,  fk:null,                     nullable:false },
      { name:'station_id',     type:'INTEGER', pk:false, fk:'stations.station_id',    nullable:false },
      { name:'parameter_id',   type:'INTEGER', pk:false, fk:'parameters.parameter_id', nullable:false },
      { name:'sensor_id',      type:'INTEGER', pk:false, fk:'sensors.sensor_id',      nullable:true },
      { name:'source_id',      type:'INTEGER', pk:false, fk:'data_sources.source_id', nullable:true },
      { name:'timestamp_utc',  type:'TEXT',    pk:false, fk:null,                     nullable:false, note:'ISO-8601 UTC' },
      { name:'timestamp_local',type:'TEXT',    pk:false, fk:null,                     nullable:true },
      { name:'value',          type:'REAL',    pk:false, fk:null,                     nullable:true,  note:'Cleaned value' },
      { name:'raw_value',      type:'REAL',    pk:false, fk:null,                     nullable:true,  note:'As-received' },
      { name:'unit',           type:'TEXT',    pk:false, fk:null,                     nullable:true },
      { name:'quality_flag',   type:'TEXT',    pk:false, fk:null,                     nullable:false, note:'VALID|SUSPECT|MISSING|...' },
      { name:'is_imputed',     type:'INTEGER', pk:false, fk:null,                     nullable:false, note:'1 = pipeline-filled' },
      { name:'is_outlier',     type:'INTEGER', pk:false, fk:null,                     nullable:false, note:'1 = was outlier' },
    ],
    indexes: ['idx_meas_spt','idx_meas_time','idx_meas_flag','idx_meas_param'],
  },
  hourly_aggregates: {
    label: 'hourly_aggregates', layer: 'Aggregates', color: '#eab308',
    desc: 'Pre-computed hourly statistics — mean, min, max, std, completeness. Updated by trigger.',
    pk: 'agg_id',
    columns: [
      { name:'agg_id',       type:'INTEGER', pk:true,  fk:null,                     nullable:false },
      { name:'station_id',   type:'INTEGER', pk:false, fk:'stations.station_id',    nullable:false },
      { name:'parameter_id', type:'INTEGER', pk:false, fk:'parameters.parameter_id', nullable:false },
      { name:'hour_utc',     type:'TEXT',    pk:false, fk:null,                     nullable:false, note:'YYYY-MM-DDTHH:00:00' },
      { name:'mean_value',   type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'min_value',    type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'max_value',    type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'std_value',    type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'record_count', type:'INTEGER', pk:false, fk:null,                     nullable:true },
      { name:'completeness', type:'REAL',    pk:false, fk:null,                     nullable:true, note:'0–100 %' },
    ],
    indexes: ['idx_hourly_spt'],
  },
  daily_aggregates: {
    label: 'daily_aggregates', layer: 'Aggregates', color: '#eab308',
    desc: 'Daily statistics with percentile values and WHO/NAAQS exceedance flags',
    pk: 'agg_id',
    columns: [
      { name:'agg_id',        type:'INTEGER', pk:true,  fk:null,                     nullable:false },
      { name:'station_id',    type:'INTEGER', pk:false, fk:'stations.station_id',    nullable:false },
      { name:'parameter_id',  type:'INTEGER', pk:false, fk:'parameters.parameter_id', nullable:false },
      { name:'date',          type:'TEXT',    pk:false, fk:null,                     nullable:false, note:'YYYY-MM-DD' },
      { name:'mean_value',    type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'p25_value',     type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'p75_value',     type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'p95_value',     type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'exceeds_who',   type:'INTEGER', pk:false, fk:null,                     nullable:false, note:'0 or 1' },
      { name:'exceeds_naaqs', type:'INTEGER', pk:false, fk:null,                     nullable:false, note:'0 or 1' },
    ],
    indexes: ['idx_daily_spd'],
  },
  monthly_aggregates: {
    label: 'monthly_aggregates', layer: 'Aggregates', color: '#eab308',
    desc: 'Monthly city-level means (sourced from CPCB Annual Reports 2019–2023)',
    pk: 'agg_id',
    columns: [
      { name:'agg_id',              type:'INTEGER', pk:true,  fk:null,                     nullable:false },
      { name:'station_id',          type:'INTEGER', pk:false, fk:'stations.station_id',    nullable:false },
      { name:'parameter_id',        type:'INTEGER', pk:false, fk:'parameters.parameter_id', nullable:false },
      { name:'year',                type:'INTEGER', pk:false, fk:null,                     nullable:false, note:'2000–2100' },
      { name:'month',               type:'INTEGER', pk:false, fk:null,                     nullable:false, note:'1–12' },
      { name:'mean_value',          type:'REAL',    pk:false, fk:null,                     nullable:true },
      { name:'days_exceeding_who',  type:'INTEGER', pk:false, fk:null,                     nullable:false },
      { name:'days_exceeding_naaqs',type:'INTEGER', pk:false, fk:null,                     nullable:false },
      { name:'source',              type:'TEXT',    pk:false, fk:null,                     nullable:false },
    ],
    indexes: ['idx_monthly_spy'],
  },
  aqi_readings: {
    label: 'aqi_readings', layer: 'Derived', color: '#ef4444',
    desc: 'Computed AQI with per-pollutant sub-indices. Written by pipeline or trigger.',
    pk: 'aqi_id',
    columns: [
      { name:'aqi_id',           type:'INTEGER', pk:true,  fk:null,                  nullable:false },
      { name:'station_id',       type:'INTEGER', pk:false, fk:'stations.station_id', nullable:false },
      { name:'timestamp_utc',    type:'TEXT',    pk:false, fk:null,                  nullable:false },
      { name:'aqi_value',        type:'INTEGER', pk:false, fk:null,                  nullable:true, note:'0–500' },
      { name:'aqi_category',     type:'TEXT',    pk:false, fk:null,                  nullable:true },
      { name:'dominant_pollutant',type:'TEXT',   pk:false, fk:null,                  nullable:true },
      { name:'pm25_sub_index',   type:'INTEGER', pk:false, fk:null,                  nullable:true },
      { name:'pm10_sub_index',   type:'INTEGER', pk:false, fk:null,                  nullable:true },
      { name:'calc_method',      type:'TEXT',    pk:false, fk:null,                  nullable:false, note:'us_epa|cpcb|who|nowcast' },
    ],
    indexes: ['idx_aqi_st','idx_aqi_val'],
  },
  pipeline_runs: {
    label: 'pipeline_runs', layer: 'Operations', color: '#94a3b8',
    desc: 'Audit trail of every data preprocessing pipeline execution',
    pk: 'run_id',
    columns: [
      { name:'run_id',        type:'INTEGER', pk:true,  fk:null,               nullable:false },
      { name:'city_id',       type:'INTEGER', pk:false, fk:'regions.region_id', nullable:true },
      { name:'started_at',    type:'TEXT',    pk:false, fk:null,               nullable:false },
      { name:'finished_at',   type:'TEXT',    pk:false, fk:null,               nullable:true },
      { name:'total_records', type:'INTEGER', pk:false, fk:null,               nullable:false },
      { name:'issues_found',  type:'INTEGER', pk:false, fk:null,               nullable:false },
      { name:'issues_fixed',  type:'INTEGER', pk:false, fk:null,               nullable:false },
      { name:'quality_before',type:'REAL',    pk:false, fk:null,               nullable:true },
      { name:'quality_after', type:'REAL',    pk:false, fk:null,               nullable:true },
      { name:'duration_ms',   type:'INTEGER', pk:false, fk:null,               nullable:true },
      { name:'status',        type:'TEXT',    pk:false, fk:null,               nullable:false },
    ],
    indexes: [],
  },
  quality_log: {
    label: 'quality_log', layer: 'Operations', color: '#94a3b8',
    desc: 'Row-level record of every cleaning action the pipeline applied',
    pk: 'log_id',
    columns: [
      { name:'log_id',           type:'INTEGER', pk:true,  fk:null,                         nullable:false },
      { name:'run_id',           type:'INTEGER', pk:false, fk:'pipeline_runs.run_id',        nullable:true },
      { name:'station_id',       type:'INTEGER', pk:false, fk:'stations.station_id',         nullable:true },
      { name:'parameter_id',     type:'INTEGER', pk:false, fk:'parameters.parameter_id',      nullable:true },
      { name:'measurement_id',   type:'INTEGER', pk:false, fk:'measurements.measurement_id',  nullable:true },
      { name:'timestamp_utc',    type:'TEXT',    pk:false, fk:null,                          nullable:true },
      { name:'issue_type',       type:'TEXT',    pk:false, fk:null,                          nullable:false },
      { name:'original_value',   type:'REAL',    pk:false, fk:null,                          nullable:true },
      { name:'corrected_value',  type:'REAL',    pk:false, fk:null,                          nullable:true },
      { name:'correction_method',type:'TEXT',    pk:false, fk:null,                          nullable:true },
    ],
    indexes: ['idx_qlog_run','idx_qlog_type'],
  },
  alerts: {
    label: 'alerts', layer: 'Operations', color: '#94a3b8',
    desc: 'Event-driven alerts for AQI thresholds, sensor faults, and data quality issues',
    pk: 'alert_id',
    columns: [
      { name:'alert_id',       type:'INTEGER', pk:true,  fk:null,                       nullable:false },
      { name:'station_id',     type:'INTEGER', pk:false, fk:'stations.station_id',      nullable:false },
      { name:'parameter_id',   type:'INTEGER', pk:false, fk:'parameters.parameter_id',  nullable:true },
      { name:'timestamp_utc',  type:'TEXT',    pk:false, fk:null,                       nullable:false },
      { name:'alert_type',     type:'TEXT',    pk:false, fk:null,                       nullable:false },
      { name:'severity',       type:'TEXT',    pk:false, fk:null,                       nullable:false, note:'info|warning|critical|emergency' },
      { name:'threshold_value',type:'REAL',    pk:false, fk:null,                       nullable:true },
      { name:'observed_value', type:'REAL',    pk:false, fk:null,                       nullable:true },
      { name:'message',        type:'TEXT',    pk:false, fk:null,                       nullable:true },
      { name:'is_resolved',    type:'INTEGER', pk:false, fk:null,                       nullable:false },
    ],
    indexes: ['idx_alerts_sta','idx_alerts_open'],
  },
  calibration_records: {
    label: 'calibration_records', layer: 'Infrastructure', color: '#3b82f6',
    desc: 'Historical log of sensor calibration events with traceability metadata',
    pk: 'cal_id',
    columns: [
      { name:'cal_id',           type:'INTEGER', pk:true,  fk:null,                nullable:false },
      { name:'sensor_id',        type:'INTEGER', pk:false, fk:'sensors.sensor_id', nullable:false },
      { name:'calibration_date', type:'TEXT',    pk:false, fk:null,                nullable:false },
      { name:'next_due_date',    type:'TEXT',    pk:false, fk:null,                nullable:true },
      { name:'cal_type',         type:'TEXT',    pk:false, fk:null,                nullable:true },
      { name:'zero_offset',      type:'REAL',    pk:false, fk:null,                nullable:true },
      { name:'span_factor',      type:'REAL',    pk:false, fk:null,                nullable:true },
      { name:'r_squared',        type:'REAL',    pk:false, fk:null,                nullable:true, note:'0–1' },
      { name:'passed',           type:'INTEGER', pk:false, fk:null,                nullable:false },
    ],
    indexes: [],
  },
};

// FK relationships for ER diagram rendering
const SCHEMA_RELATIONSHIPS = [
  { from:'regions',           fromCol:'region_id',    to:'regions',           toCol:'parent_id',     label:'parent →',    card:'1:N' },
  { from:'regions',           fromCol:'region_id',    to:'stations',          toCol:'region_id',     label:'has',         card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'sensors',           toCol:'station_id',    label:'has',         card:'1:N' },
  { from:'parameters',        fromCol:'parameter_id', to:'sensors',           toCol:'parameter_id',  label:'measured by', card:'1:N' },
  { from:'sensors',           fromCol:'sensor_id',    to:'calibration_records',toCol:'sensor_id',    label:'has',         card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'measurements',      toCol:'station_id',    label:'has',         card:'1:N' },
  { from:'parameters',        fromCol:'parameter_id', to:'measurements',      toCol:'parameter_id',  label:'measured in', card:'1:N' },
  { from:'sensors',           fromCol:'sensor_id',    to:'measurements',      toCol:'sensor_id',     label:'from',        card:'1:N' },
  { from:'data_sources',      fromCol:'source_id',    to:'measurements',      toCol:'source_id',     label:'provides',    card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'hourly_aggregates', toCol:'station_id',    label:'agg→',        card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'daily_aggregates',  toCol:'station_id',    label:'agg→',        card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'monthly_aggregates',toCol:'station_id',    label:'agg→',        card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'aqi_readings',      toCol:'station_id',    label:'has',         card:'1:N' },
  { from:'stations',          fromCol:'station_id',   to:'alerts',            toCol:'station_id',    label:'triggers',    card:'1:N' },
  { from:'parameters',        fromCol:'parameter_id', to:'alerts',            toCol:'parameter_id',  label:'for',         card:'1:N' },
  { from:'pipeline_runs',     fromCol:'run_id',       to:'quality_log',       toCol:'run_id',        label:'produces',    card:'1:N' },
  { from:'measurements',      fromCol:'measurement_id',to:'quality_log',      toCol:'measurement_id',label:'logged in',   card:'1:1' },
  { from:'regions',           fromCol:'region_id',    to:'pipeline_runs',     toCol:'city_id',       label:'for',         card:'1:N' },
];

// Ordered DDL execution list
const ALL_DDL = [
  SQL_PRAGMA,
  SQL_TABLE_REGIONS,
  SQL_TABLE_PARAMETERS,
  SQL_TABLE_DATA_SOURCES,
  SQL_TABLE_STATIONS,
  SQL_TABLE_SENSORS,
  SQL_TABLE_MEASUREMENTS,
  SQL_TABLE_HOURLY_AGG,
  SQL_TABLE_DAILY_AGG,
  SQL_TABLE_MONTHLY_AGG,
  SQL_TABLE_AQI_READINGS,
  SQL_TABLE_PIPELINE_RUNS,
  SQL_TABLE_QUALITY_LOG,
  SQL_TABLE_ALERTS,
  SQL_TABLE_CALIBRATION,
  SQL_INDEXES,
  SQL_VIEWS,
  SQL_TRIGGERS,
];

window.DB_SCHEMA = { ALL_DDL, SCHEMA_META, SCHEMA_RELATIONSHIPS };

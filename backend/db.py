"""
SQLite database layer.
Uses Flask's `g` object for per-request connection management.
All public query helpers return plain dicts / lists — no ORM.
"""
import sqlite3
import time
from contextlib import closing
from flask import g, current_app


# ── Schema DDL ────────────────────────────────────────────────────────────────

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS regions (
    region_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    region_type TEXT NOT NULL CHECK(region_type IN ('country','state','city')),
    parent_id   TEXT REFERENCES regions(region_id) ON DELETE SET NULL,
    country_code TEXT DEFAULT 'IN',
    lat         REAL,
    lng         REAL
);

CREATE TABLE IF NOT EXISTS parameters (
    parameter_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    code           TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    unit           TEXT,
    who_guideline  REAL,
    naaqs_standard REAL,
    aqi_enabled    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stations (
    station_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    station_code TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    region_id    TEXT REFERENCES regions(region_id) ON DELETE SET NULL,
    lat          REAL,
    lng          REAL,
    station_type TEXT DEFAULT 'cpcb',
    is_active    INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS measurements (
    measurement_id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id     INTEGER NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
    parameter_id   INTEGER NOT NULL REFERENCES parameters(parameter_id),
    timestamp_utc  TEXT NOT NULL,
    value          REAL,
    quality_flag   TEXT DEFAULT 'VALID'
                    CHECK(quality_flag IN ('VALID','SUSPECT','MISSING','OUTLIER','ESTIMATED')),
    UNIQUE(station_id, parameter_id, timestamp_utc)
);

CREATE TABLE IF NOT EXISTS monthly_aggregates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id   INTEGER NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
    parameter_id INTEGER NOT NULL REFERENCES parameters(parameter_id),
    year         INTEGER NOT NULL,
    month        INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
    mean_value   REAL,
    min_value    REAL,
    max_value    REAL,
    record_count INTEGER,
    UNIQUE(station_id, parameter_id, year, month)
);

CREATE TABLE IF NOT EXISTS aqi_readings (
    aqi_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id      INTEGER NOT NULL REFERENCES stations(station_id) ON DELETE CASCADE,
    timestamp_utc   TEXT NOT NULL,
    aqi_value       INTEGER,
    aqi_category    TEXT,
    dominant_param  TEXT DEFAULT 'pm25',
    UNIQUE(station_id, timestamp_utc)
);

CREATE INDEX IF NOT EXISTS idx_meas_station_ts   ON measurements(station_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_meas_param_ts     ON measurements(parameter_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_meas_ts           ON measurements(timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_aqi_station_ts    ON aqi_readings(station_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_monthly_stn_yr_mo ON monthly_aggregates(station_id, year, month);
CREATE INDEX IF NOT EXISTS idx_stations_region   ON stations(region_id);
"""


# ── Connection management ─────────────────────────────────────────────────────

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(
            current_app.config["DB_PATH"],
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


def close_db(e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(app):
    with app.app_context():
        db = get_db()
        for stmt in SCHEMA.split(";"):
            stmt = stmt.strip()
            if stmt:
                db.execute(stmt)
        db.commit()
    app.teardown_appcontext(close_db)


# ── Query helpers ─────────────────────────────────────────────────────────────

def query(sql: str, args=(), one=False):
    """Execute SELECT; return list of dicts (or single dict if one=True)."""
    t0  = time.perf_counter()
    cur = get_db().execute(sql, args)
    rows = [dict(r) for r in cur.fetchall()]
    ms  = round((time.perf_counter() - t0) * 1000, 2)
    if one:
        return rows[0] if rows else None, ms
    return rows, ms


def execute(sql: str, args=()):
    """Execute INSERT/UPDATE/DELETE; return (rowcount, lastrowid)."""
    db  = get_db()
    cur = db.execute(sql, args)
    db.commit()
    return cur.rowcount, cur.lastrowid


def execute_many(sql: str, args_list):
    """Bulk INSERT; returns rows inserted."""
    db  = get_db()
    cur = db.executemany(sql, args_list)
    db.commit()
    return cur.rowcount


def scalar(sql: str, args=()):
    """Return the first column of the first row."""
    row, _ = query(sql, args, one=True)
    if row:
        return next(iter(row.values()))
    return None

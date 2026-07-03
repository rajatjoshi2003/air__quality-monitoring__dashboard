"""
export_powerbi.py — Export the AirWatch SQLite DB into a clean star-schema
set of CSVs that Power BI Desktop can import directly (Get Data -> Folder/Text-CSV).

Output (powerbi/data/):
  dim_region.csv       — geography (country/state/city hierarchy)
  dim_station.csv      — monitoring stations (+ resolved city/state names)
  dim_parameter.csv    — pollutant reference (units, WHO/NAAQS limits)
  dim_date.csv         — generated daily date dimension over the data range
  fact_measurements.csv— hourly raw readings (the main fact)
  fact_aqi.csv         — hourly AQI readings
  fact_monthly.csv     — monthly aggregates (2019-2023)

Run:  python powerbi/export_powerbi.py
"""
import os
import csv
import sqlite3
from datetime import datetime, timedelta

HERE   = os.path.dirname(os.path.abspath(__file__))
DB     = os.path.join(HERE, "..", "backend", "aqi.db")
OUTDIR = os.path.join(HERE, "data")


def _write(name, header, rows):
    path = os.path.join(OUTDIR, name)
    # utf-8-sig (BOM) so Power BI's Text/CSV importer auto-detects UTF-8
    # and renders units like μg/m³ correctly.
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"  {name:24s} {len(rows):>8,} rows")
    return len(rows)


def main():
    if not os.path.exists(DB):
        raise SystemExit(f"DB not found at {DB} — start the backend once to auto-seed it.")
    os.makedirs(OUTDIR, exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    print(f"Exporting from {os.path.normpath(DB)} -> {os.path.normpath(OUTDIR)}\n")

    # ── dim_region ────────────────────────────────────────────────────────────
    rows = db.execute("""
        SELECT region_id, name, region_type, parent_id, country_code, lat, lng
        FROM regions ORDER BY region_type, name
    """).fetchall()
    _write("dim_region.csv",
           ["region_id", "region_name", "region_type", "parent_id", "country_code", "lat", "lng"],
           [tuple(r) for r in rows])

    # ── dim_parameter ─────────────────────────────────────────────────────────
    rows = db.execute("""
        SELECT parameter_id, code, name, unit, who_guideline, naaqs_standard, aqi_enabled
        FROM parameters ORDER BY parameter_id
    """).fetchall()
    _write("dim_parameter.csv",
           ["parameter_id", "param_code", "param_name", "unit", "who_guideline", "naaqs_standard", "aqi_enabled"],
           [tuple(r) for r in rows])

    # ── dim_station (resolve city + state names for slicers) ───────────────────
    rows = db.execute("""
        SELECT s.station_id, s.station_code, s.name AS station_name,
               s.region_id AS city_id, c.name AS city_name,
               st.name AS state_name, s.lat, s.lng, s.station_type, s.is_active
        FROM stations s
        LEFT JOIN regions c  ON c.region_id  = s.region_id
        LEFT JOIN regions st ON st.region_id = c.parent_id
        ORDER BY s.station_code
    """).fetchall()
    _write("dim_station.csv",
           ["station_id", "station_code", "station_name", "city_id", "city_name",
            "state_name", "lat", "lng", "station_type", "is_active"],
           [tuple(r) for r in rows])

    # ── fact_measurements (split timestamp into date/hour for time intel) ──────
    rows = db.execute("""
        SELECT station_id, parameter_id, timestamp_utc, value, quality_flag
        FROM measurements ORDER BY timestamp_utc
    """).fetchall()
    fact = []
    for r in rows:
        ts = r["timestamp_utc"]
        fact.append((r["station_id"], r["parameter_id"], ts, ts[:10], int(ts[11:13]) if len(ts) >= 13 else 0,
                     r["value"], r["quality_flag"]))
    _write("fact_measurements.csv",
           ["station_id", "parameter_id", "timestamp_utc", "date", "hour", "value", "quality_flag"],
           fact)

    # ── fact_aqi ──────────────────────────────────────────────────────────────
    rows = db.execute("""
        SELECT station_id, timestamp_utc, aqi_value, aqi_category, dominant_param
        FROM aqi_readings ORDER BY timestamp_utc
    """).fetchall()
    fact_aqi = []
    for r in rows:
        ts = r["timestamp_utc"]
        fact_aqi.append((r["station_id"], ts, ts[:10], int(ts[11:13]) if len(ts) >= 13 else 0,
                         r["aqi_value"], r["aqi_category"], r["dominant_param"]))
    _write("fact_aqi.csv",
           ["station_id", "timestamp_utc", "date", "hour", "aqi_value", "aqi_category", "dominant_param"],
           fact_aqi)

    # ── fact_monthly ──────────────────────────────────────────────────────────
    rows = db.execute("""
        SELECT station_id, parameter_id, year, month, mean_value, min_value, max_value, record_count
        FROM monthly_aggregates ORDER BY year, month
    """).fetchall()
    _write("fact_monthly.csv",
           ["station_id", "parameter_id", "year", "month", "mean_value", "min_value", "max_value", "record_count"],
           [tuple(r) for r in rows])

    # ── dim_date (daily, spanning all fact dates) ─────────────────────────────
    span = db.execute("""
        SELECT MIN(d) AS lo, MAX(d) AS hi FROM (
            SELECT DATE(timestamp_utc) d FROM measurements
            UNION SELECT DATE(timestamp_utc) FROM aqi_readings
        )
    """).fetchone()
    lo = datetime.strptime(span["lo"], "%Y-%m-%d").date()
    hi = datetime.strptime(span["hi"], "%Y-%m-%d").date()
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    dim_date, d = [], lo
    while d <= hi:
        dim_date.append((d.isoformat(), d.year, d.month, months[d.month-1], d.day,
                         (d.month-1)//3 + 1, d.strftime("%A"), 1 if d.weekday() >= 5 else 0))
        d += timedelta(days=1)
    _write("dim_date.csv",
           ["date", "year", "month_num", "month_name", "day", "quarter", "weekday", "is_weekend"],
           dim_date)

    db.close()
    print("\nDone. In Power BI Desktop: Get Data -> Text/CSV (each file) or Folder.")


if __name__ == "__main__":
    main()

"""
Seed the database with reference data and synthetic time-series.
Idempotent: skips tables that already have rows.
"""
import math
import random
from datetime import datetime, timezone, timedelta

from db import get_db, execute, execute_many, scalar
from models import (
    PARAMETERS, REGIONS, STATIONS, CPCB_MONTHLY, CITY_CLIMATE,
    DIURNAL_FACTOR, CITY_IDS, calc_aqi,
)

SEED = 42  # reproducible


def _gauss(mean: float, sigma: float, rng: random.Random) -> float:
    return max(0.0, rng.gauss(mean, sigma))


def seed_all(force: bool = False) -> dict:
    """
    Seed all tables in FK-safe order.
    Returns a summary dict {table: rows_inserted}.
    """
    rng = random.Random(SEED)
    summary = {}

    # ── parameters ────────────────────────────────────────────────────────────
    if force or scalar("SELECT COUNT(*) FROM parameters") == 0:
        execute_many(
            "INSERT OR IGNORE INTO parameters (code,name,unit,who_guideline,naaqs_standard,aqi_enabled) "
            "VALUES (?,?,?,?,?,?)",
            [(p["code"],p["name"],p["unit"],p["who"],p["naaqs"],int(p["aqi"])) for p in PARAMETERS]
        )
        summary["parameters"] = scalar("SELECT COUNT(*) FROM parameters")

    # ── regions ───────────────────────────────────────────────────────────────
    if force or scalar("SELECT COUNT(*) FROM regions") == 0:
        for r in REGIONS:
            execute(
                "INSERT OR IGNORE INTO regions (region_id,name,region_type,parent_id,lat,lng) VALUES (?,?,?,?,?,?)",
                (r["id"], r["name"], r["type"], r["parent"], r["lat"], r["lng"])
            )
        summary["regions"] = scalar("SELECT COUNT(*) FROM regions")

    # ── stations ──────────────────────────────────────────────────────────────
    if force or scalar("SELECT COUNT(*) FROM stations") == 0:
        for city_id, stns in STATIONS.items():
            for s in stns:
                execute(
                    "INSERT OR IGNORE INTO stations (station_code,name,region_id,lat,lng,station_type,is_active) "
                    "VALUES (?,?,?,?,?,?,1)",
                    (s["code"], s["name"], city_id, s["lat"], s["lng"], s["type"])
                )
        summary["stations"] = scalar("SELECT COUNT(*) FROM stations")

    # ── monthly_aggregates (CPCB 2019–2023) ───────────────────────────────────
    if force or scalar("SELECT COUNT(*) FROM monthly_aggregates") == 0:
        rows = []
        for city_id, params in CPCB_MONTHLY.items():
            stns = STATIONS.get(city_id, [])
            if not stns:
                continue
            stn_code = stns[0]["code"]
            stn_id   = scalar("SELECT station_id FROM stations WHERE station_code=?", (stn_code,))
            if not stn_id:
                continue
            for param_code, year_data in params.items():
                param_id = scalar("SELECT parameter_id FROM parameters WHERE code=?", (param_code,))
                if not param_id:
                    continue
                for year, monthly in year_data.items():
                    for mo_idx, mean_val in enumerate(monthly):
                        month = mo_idx + 1
                        noise = rng.uniform(0.88, 1.12)
                        mv    = round(mean_val * noise, 2)
                        mn    = round(mv * rng.uniform(0.60, 0.85), 2)
                        mx    = round(mv * rng.uniform(1.15, 1.60), 2)
                        count = rng.randint(520, 720)
                        rows.append((stn_id, param_id, year, month, mv, mn, mx, count))

        execute_many(
            "INSERT OR IGNORE INTO monthly_aggregates "
            "(station_id,parameter_id,year,month,mean_value,min_value,max_value,record_count) "
            "VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        summary["monthly_aggregates"] = scalar("SELECT COUNT(*) FROM monthly_aggregates")

    # ── measurements — hourly for last 30 days ────────────────────────────────
    if force or scalar("SELECT COUNT(*) FROM measurements") == 0:
        now  = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        meas_rows = []
        aqi_rows  = []
        pm25_id = scalar("SELECT parameter_id FROM parameters WHERE code='pm25'")

        for city_id in CITY_IDS:
            climate   = CITY_CLIMATE[city_id]
            cpcb_data = CPCB_MONTHLY.get(city_id, {})
            stns      = STATIONS.get(city_id, [])

            for stn in stns:
                stn_id = scalar("SELECT station_id FROM stations WHERE station_code=?", (stn["code"],))
                if not stn_id:
                    continue

                for h in range(30 * 24, -1, -1):
                    ts  = now - timedelta(hours=h)
                    iso = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
                    mo  = ts.month - 1   # 0-indexed for list
                    yr  = ts.year
                    hr  = ts.hour
                    df  = DIURNAL_FACTOR[hr]

                    # weekend factor (slight reduction)
                    wd_factor = 0.88 if ts.weekday() >= 5 else 1.0

                    for param in PARAMETERS:
                        if param["code"] in ("aqi", "temperature", "humidity"):
                            continue
                        pdata = cpcb_data.get(param["code"], {})
                        monthly = pdata.get(min(2023, max(2019, yr)), pdata.get(2023, [None]*12))
                        base = monthly[mo] if monthly and monthly[mo] is not None else 30.0

                        sigma = base * 0.18
                        val   = _gauss(base * df * wd_factor, sigma, rng)
                        val   = round(val, 2)

                        if val < 0:
                            continue

                        param_id = scalar("SELECT parameter_id FROM parameters WHERE code=?", (param["code"],))
                        if not param_id:
                            continue

                        flag = "VALID"
                        if val > base * 2.5:
                            flag = "OUTLIER"
                        elif rng.random() < 0.015:
                            flag = "SUSPECT"

                        meas_rows.append((stn_id, param_id, iso, val, flag))

                    # Temperature
                    temp_base = climate["temp"][mo]
                    temp_val  = round(_gauss(temp_base + (hr - 14) * 0.3, 1.2, rng), 1)
                    temp_id   = scalar("SELECT parameter_id FROM parameters WHERE code='temperature'")
                    if temp_id:
                        meas_rows.append((stn_id, temp_id, iso, temp_val, "VALID"))

                    # Humidity
                    hum_base = climate["hum"][mo]
                    hum_val  = round(min(99, max(5, _gauss(hum_base - (hr - 6) * 0.5, 5, rng))), 1)
                    hum_id   = scalar("SELECT parameter_id FROM parameters WHERE code='humidity'")
                    if hum_id:
                        meas_rows.append((stn_id, hum_id, iso, hum_val, "VALID"))

                    # AQI from pm25
                    pm25_years = cpcb_data.get("pm25", {})
                    pm25_base  = pm25_years.get(min(2023, max(2019, yr)), pm25_years.get(2023, [30]*12))
                    pm25_monthly = pm25_base[mo] if isinstance(pm25_base, list) else 30
                    pm25_val   = round(_gauss(pm25_monthly * df * wd_factor, pm25_monthly * 0.18, rng), 1)
                    aqi_val, aqi_cat = calc_aqi(pm25_val, "pm25")
                    aqi_rows.append((stn_id, iso, aqi_val, aqi_cat, "pm25"))

                # Bulk-insert in chunks to avoid huge transactions
                if len(meas_rows) >= 5000:
                    execute_many(
                        "INSERT OR IGNORE INTO measurements (station_id,parameter_id,timestamp_utc,value,quality_flag) "
                        "VALUES (?,?,?,?,?)",
                        meas_rows,
                    )
                    meas_rows = []

        if meas_rows:
            execute_many(
                "INSERT OR IGNORE INTO measurements (station_id,parameter_id,timestamp_utc,value,quality_flag) "
                "VALUES (?,?,?,?,?)",
                meas_rows,
            )

        if aqi_rows:
            execute_many(
                "INSERT OR IGNORE INTO aqi_readings (station_id,timestamp_utc,aqi_value,aqi_category,dominant_param) "
                "VALUES (?,?,?,?,?)",
                aqi_rows,
            )

        summary["measurements"] = scalar("SELECT COUNT(*) FROM measurements")
        summary["aqi_readings"] = scalar("SELECT COUNT(*) FROM aqi_readings")

    return summary


if __name__ == "__main__":
    # Run standalone: python seeder.py
    import sys, os
    sys.path.insert(0, os.path.dirname(__file__))
    from flask import Flask
    from config import DevelopmentConfig

    app = Flask(__name__)
    app.config.from_object(DevelopmentConfig)

    from db import init_db
    init_db(app)

    with app.app_context():
        print("Seeding database…")
        result = seed_all()
        for table, count in result.items():
            print(f"  {table}: {count} rows")
        print("Done.")

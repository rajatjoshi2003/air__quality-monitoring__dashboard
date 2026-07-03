"""
/api/v1/stats/summary      — city-level 24-h summary cards
/api/v1/stats/exceedances  — WHO / NAAQS threshold crossing counts
/api/v1/stats/rankings     — city ranking by parameter mean
/api/v1/stats/diurnal      — average hour-of-day pattern
/api/v1/stats/trend        — year-over-year trend from monthly aggregates
"""
from flask import Blueprint, request, jsonify
from db import query

bp = Blueprint("stats", __name__, url_prefix="/api/v1/stats")

VALID_PARAMS = {"pm25","pm10","no2","so2","o3","co","temperature","humidity"}


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})

def _err(msg, code=400):
    return jsonify({"error": msg}), code


# ── GET /api/v1/stats/summary ─────────────────────────────────────────────────
@bp.get("/summary")
def summary():
    """
    Per-city 24-h summary: mean AQI, dominant parameter, exceedance flags.

    Query params:
      city — restrict to one city (omit = all)
    """
    city = request.args.get("city")
    where = "s.region_id = ?" if city else "1=1"
    args  = (city,) if city else ()

    rows, ms = query(f"""
        SELECT
            s.region_id                 AS city_id,
            r.name                      AS city_name,
            ROUND(AVG(a.aqi_value), 0)  AS mean_aqi_24h,
            MAX(a.aqi_value)            AS max_aqi_24h,
            MIN(a.aqi_value)            AS min_aqi_24h,
            COUNT(a.aqi_id)             AS readings,
            MAX(a.aqi_category)         AS worst_category,
            (SELECT COUNT(*)
             FROM measurements m2
             JOIN parameters p2 ON p2.parameter_id = m2.parameter_id
             WHERE m2.station_id = s.station_id
               AND m2.timestamp_utc >= datetime('now','-24 hours')
               AND p2.who_guideline IS NOT NULL
               AND m2.value > p2.who_guideline) AS who_exceedances,
            (SELECT COUNT(*)
             FROM measurements m3
             JOIN parameters p3 ON p3.parameter_id = m3.parameter_id
             WHERE m3.station_id = s.station_id
               AND m3.timestamp_utc >= datetime('now','-24 hours')
               AND p3.naaqs_standard IS NOT NULL
               AND m3.value > p3.naaqs_standard) AS naaqs_exceedances
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        JOIN   regions  r ON r.region_id  = s.region_id
        WHERE  {where}
          AND  a.timestamp_utc >= datetime('now','-24 hours')
        GROUP BY s.region_id
        ORDER BY mean_aqi_24h DESC
    """, args)

    return _ok(rows, {"query_ms": ms})


# ── GET /api/v1/stats/exceedances ─────────────────────────────────────────────
@bp.get("/exceedances")
def exceedances():
    """
    Count hourly readings exceeding WHO and NAAQS thresholds.

    Query params:
      city    — required
      param   — comma-sep (default: pm25,pm10,no2,so2,o3,co)
      start   — default 30 days ago
      end     — default now
      std     — who | naaqs | both (default: both)
    """
    city   = request.args.get("city")
    params = [p.strip() for p in request.args.get("param","pm25,pm10,no2,so2,o3,co").split(",") if p.strip()]
    start  = request.args.get("start","")
    end    = request.args.get("end","")
    std    = request.args.get("std","both")

    if not city:
        return _err("'city' is required")

    bad = set(params) - VALID_PARAMS
    if bad:
        return _err(f"Unknown parameters: {', '.join(bad)}")

    where = ["s.region_id = ?"]
    args  = [city]

    p_ph = ",".join("?" * len(params))
    where.append(f"pa.code IN ({p_ph})"); args.extend(params)

    if start:
        where.append("m.timestamp_utc >= ?"); args.append(start)
    else:
        where.append("m.timestamp_utc >= datetime('now','-30 days')")
    if end:
        where.append("m.timestamp_utc <= ?"); args.append(end)

    rows, ms = query(f"""
        SELECT
            pa.code       AS param,
            pa.name       AS param_name,
            pa.unit,
            pa.who_guideline,
            pa.naaqs_standard,
            COUNT(*)      AS total_readings,
            SUM(CASE WHEN pa.who_guideline   IS NOT NULL AND m.value > pa.who_guideline   THEN 1 ELSE 0 END) AS who_exceedances,
            SUM(CASE WHEN pa.naaqs_standard  IS NOT NULL AND m.value > pa.naaqs_standard  THEN 1 ELSE 0 END) AS naaqs_exceedances,
            ROUND(AVG(m.value),2) AS mean_value,
            ROUND(MAX(m.value),2) AS max_value
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY pa.code
        ORDER BY who_exceedances DESC
    """, args)

    return _ok(rows, {"city": city, "query_ms": ms})


# ── GET /api/v1/stats/rankings ────────────────────────────────────────────────
@bp.get("/rankings")
def rankings():
    """
    Rank all cities by a parameter's 30-day mean.

    Query params:
      param   — default pm25
      start   — default 30 days ago
      order   — asc | desc (default: desc — worst first)
    """
    param = request.args.get("param","pm25")
    start = request.args.get("start","")
    order = request.args.get("order","desc").upper()

    if param not in VALID_PARAMS:
        return _err(f"Unknown parameter: {param}")
    if order not in ("ASC","DESC"):
        return _err("order must be asc or desc")

    where = ["pa.code = ?", "m.quality_flag IN ('VALID','ESTIMATED')"]
    args  = [param]

    if start:
        where.append("m.timestamp_utc >= ?"); args.append(start)
    else:
        where.append("m.timestamp_utc >= datetime('now','-30 days')")

    rows, ms = query(f"""
        SELECT
            s.region_id             AS city_id,
            r.name                  AS city_name,
            ROUND(AVG(m.value),2)   AS mean_value,
            ROUND(MIN(m.value),2)   AS min_value,
            ROUND(MAX(m.value),2)   AS max_value,
            COUNT(m.value)          AS readings,
            pa.unit,
            pa.who_guideline,
            pa.naaqs_standard,
            ROUND(AVG(m.value) / NULLIF(pa.who_guideline,0), 2) AS who_ratio
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   regions    r  ON r.region_id     = s.region_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
        GROUP BY s.region_id
        ORDER BY mean_value {order}
    """, args)

    for rank, row in enumerate(rows, 1):
        row["rank"] = rank

    return _ok(rows, {"param": param, "query_ms": ms})


# ── GET /api/v1/stats/diurnal ─────────────────────────────────────────────────
@bp.get("/diurnal")
def diurnal():
    """
    Average pollutant concentration by hour-of-day (0–23).

    Query params:
      city    — required
      param   — comma-sep (default: pm25,no2,o3)
      start   — default 30 days ago
    """
    city   = request.args.get("city")
    params = [p.strip() for p in request.args.get("param","pm25,no2,o3").split(",") if p.strip()]
    start  = request.args.get("start","")

    if not city:
        return _err("'city' is required")

    bad = set(params) - VALID_PARAMS
    if bad:
        return _err(f"Unknown parameters: {', '.join(bad)}")

    p_ph  = ",".join("?" * len(params))
    where = ["s.region_id = ?", f"pa.code IN ({p_ph})", "m.quality_flag IN ('VALID','ESTIMATED')"]
    args  = [city] + params

    if start:
        where.append("m.timestamp_utc >= ?"); args.append(start)
    else:
        where.append("m.timestamp_utc >= datetime('now','-30 days')")

    rows, ms = query(f"""
        SELECT
            CAST(strftime('%H', m.timestamp_utc) AS INTEGER) AS hour,
            pa.code                AS param,
            pa.unit,
            ROUND(AVG(m.value),3)  AS mean,
            ROUND(MIN(m.value),3)  AS min,
            ROUND(MAX(m.value),3)  AS max,
            COUNT(m.value)         AS count
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
        GROUP BY hour, pa.code
        ORDER BY hour, pa.code
    """, args)

    return _ok(rows, {"city": city, "query_ms": ms})


# ── GET /api/v1/stats/trend ───────────────────────────────────────────────────
@bp.get("/trend")
def trend():
    """
    Year-over-year trend from monthly_aggregates (2019–2023).

    Query params:
      city  — required
      param — comma-sep (default: pm25,pm10,no2)
    """
    city   = request.args.get("city")
    params = [p.strip() for p in request.args.get("param","pm25,pm10,no2").split(",") if p.strip()]

    if not city:
        return _err("'city' is required")

    bad = set(params) - VALID_PARAMS
    if bad:
        return _err(f"Unknown parameters: {', '.join(bad)}")

    p_ph = ",".join("?" * len(params))
    rows, ms = query(f"""
        SELECT
            ma.year,
            pa.code              AS param,
            pa.unit,
            ROUND(AVG(ma.mean_value), 2) AS annual_mean,
            ROUND(MIN(ma.min_value), 2)  AS annual_min,
            ROUND(MAX(ma.max_value), 2)  AS annual_max,
            SUM(ma.record_count)         AS total_readings
        FROM   monthly_aggregates ma
        JOIN   stations   s  ON s.station_id    = ma.station_id
        JOIN   parameters pa ON pa.parameter_id = ma.parameter_id
        WHERE  s.region_id = ?
          AND  pa.code IN ({p_ph})
        GROUP BY ma.year, pa.code
        ORDER BY ma.year, pa.code
    """, [city] + params)

    return _ok(rows, {"city": city, "query_ms": ms})

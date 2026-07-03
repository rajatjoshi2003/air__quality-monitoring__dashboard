"""
/api/v1/measurements  — raw time-series with filtering & pagination
/api/v1/aqi/latest    — latest AQI per city / station
/api/v1/aqi/history   — AQI trend for a city
/api/v1/parameters    — available parameters
"""
from flask import Blueprint, request, jsonify
from db import query, scalar

bp = Blueprint("measurements", __name__, url_prefix="/api/v1")

VALID_PARAMS  = {"pm25","pm10","no2","so2","o3","co","temperature","humidity","aqi"}
VALID_FLAGS   = {"VALID","SUSPECT","MISSING","OUTLIER","ESTIMATED"}
VALID_ORDER   = {"asc","desc"}
MAX_LIMIT     = 5000


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})

def _err(msg, code=400):
    return jsonify({"error": msg}), code


# ── GET /api/v1/parameters ────────────────────────────────────────────────────
@bp.get("/parameters")
def list_parameters():
    rows, ms = query(
        "SELECT code,name,unit,who_guideline,naaqs_standard,aqi_enabled FROM parameters ORDER BY code"
    )
    return _ok(rows, {"query_ms": ms})


# ── GET /api/v1/measurements ──────────────────────────────────────────────────
@bp.get("/measurements")
def list_measurements():
    """
    Fetch raw hourly measurements.

    Query params:
      city      — region_id  (required unless station given)
      station   — station_code
      param     — comma-separated parameter codes  (default: pm25,pm10,no2,so2,o3,co)
      start     — ISO datetime  (default: 7 days ago)
      end       — ISO datetime  (default: now)
      quality   — comma-separated flags  (default: VALID,ESTIMATED)
      order     — asc | desc  (default: asc)
      limit     — max rows per param per station (default 168, max 5000)
      page      — 1-based page number (default 1)
    """
    city    = request.args.get("city")
    station = request.args.get("station")
    params  = [p.strip() for p in request.args.get("param", "pm25,pm10,no2,so2,o3,co").split(",") if p.strip()]
    start   = request.args.get("start", "")
    end     = request.args.get("end", "")
    quality = [q.strip() for q in request.args.get("quality", "VALID,ESTIMATED").split(",") if q.strip()]
    order   = request.args.get("order", "asc").lower()
    limit   = min(int(request.args.get("limit", 168)), MAX_LIMIT)
    page    = max(1, int(request.args.get("page", 1)))

    if not city and not station:
        return _err("Provide 'city' or 'station' query parameter")

    bad_params = set(params) - VALID_PARAMS
    if bad_params:
        return _err(f"Unknown parameters: {', '.join(bad_params)}")

    bad_flags = set(quality) - VALID_FLAGS
    if bad_flags:
        return _err(f"Unknown quality flags: {', '.join(bad_flags)}")

    if order not in VALID_ORDER:
        return _err("order must be 'asc' or 'desc'")

    # Build WHERE conditions
    where  = []
    args   = []

    if station:
        where.append("s.station_code = ?")
        args.append(station)
    elif city:
        where.append("s.region_id = ?")
        args.append(city)

    if params:
        placeholders = ",".join("?" * len(params))
        where.append(f"pa.code IN ({placeholders})")
        args.extend(params)

    if quality:
        placeholders = ",".join("?" * len(quality))
        where.append(f"m.quality_flag IN ({placeholders})")
        args.extend(quality)

    if start:
        where.append("m.timestamp_utc >= ?")
        args.append(start)
    else:
        where.append("m.timestamp_utc >= datetime('now','-7 days')")

    if end:
        where.append("m.timestamp_utc <= ?")
        args.append(end)

    offset = (page - 1) * limit
    args_count = args.copy()

    count = scalar(
        f"SELECT COUNT(*) FROM measurements m "
        f"JOIN stations s ON s.station_id = m.station_id "
        f"JOIN parameters pa ON pa.parameter_id = m.parameter_id "
        f"WHERE {' AND '.join(where)}",
        args_count
    )

    args += [limit, offset]
    rows, ms = query(f"""
        SELECT
            m.timestamp_utc,
            s.station_code,
            s.name        AS station_name,
            s.region_id   AS city_id,
            pa.code       AS param,
            pa.unit,
            ROUND(m.value, 3) AS value,
            m.quality_flag
        FROM   measurements m
        JOIN   stations   s  ON s.station_id  = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
        ORDER BY m.timestamp_utc {order.upper()}, s.station_code, pa.code
        LIMIT  ? OFFSET ?
    """, args)

    return _ok(rows, {
        "total": count,
        "page": page,
        "per_page": limit,
        "pages": max(1, -(-count // limit)),  # ceil
        "query_ms": ms,
    })


# ── GET /api/v1/aqi/latest ────────────────────────────────────────────────────
@bp.get("/aqi/latest")
def aqi_latest():
    """
    Latest AQI reading per station.

    Query params:
      city  — filter by region_id
    """
    city = request.args.get("city")
    where = "s.region_id = ?" if city else "1=1"
    args  = (city,) if city else ()

    rows, ms = query(f"""
        SELECT
            s.station_code,
            s.name      AS station_name,
            s.region_id AS city_id,
            s.lat,
            s.lng,
            a.aqi_value,
            a.aqi_category,
            a.dominant_param,
            a.timestamp_utc
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  {where}
          AND  a.timestamp_utc = (
              SELECT MAX(a2.timestamp_utc)
              FROM   aqi_readings a2
              WHERE  a2.station_id = a.station_id
          )
        ORDER BY a.aqi_value DESC
    """, args)

    return _ok(rows, {"total": len(rows), "query_ms": ms})


# ── GET /api/v1/aqi/history ───────────────────────────────────────────────────
@bp.get("/aqi/history")
def aqi_history():
    """
    Hourly AQI trend for a city (mean across all active stations).

    Query params:
      city    — required
      start   — default 7 days ago
      end     — default now
      bin     — hour (default) | day | month
    """
    city  = request.args.get("city")
    start = request.args.get("start", "")
    end   = request.args.get("end", "")
    bin_  = request.args.get("bin", "hour")

    if not city:
        return _err("'city' is required")

    BIN_SQL = {
        "hour":  "strftime('%Y-%m-%dT%H:00:00Z', a.timestamp_utc)",
        "day":   "DATE(a.timestamp_utc)",
        "month": "strftime('%Y-%m', a.timestamp_utc)",
    }
    if bin_ not in BIN_SQL:
        return _err("bin must be hour | day | month")

    where = ["s.region_id = ?"]
    args  = [city]

    if start:
        where.append("a.timestamp_utc >= ?"); args.append(start)
    else:
        where.append("a.timestamp_utc >= datetime('now','-7 days')")

    if end:
        where.append("a.timestamp_utc <= ?"); args.append(end)

    rows, ms = query(f"""
        SELECT
            {BIN_SQL[bin_]}        AS ts,
            ROUND(AVG(a.aqi_value),0) AS mean_aqi,
            MIN(a.aqi_value)       AS min_aqi,
            MAX(a.aqi_value)       AS max_aqi,
            COUNT(*)               AS readings
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  {' AND '.join(where)}
        GROUP BY {BIN_SQL[bin_]}
        ORDER BY ts
    """, args)

    return _ok(rows, {"city": city, "bin": bin_, "total": len(rows), "query_ms": ms})

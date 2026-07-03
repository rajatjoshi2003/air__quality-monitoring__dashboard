"""
/api/v1/cities   — list cities with latest AQI
/api/v1/cities/<id>  — single city stats
/api/v1/stations — list stations (filterable by city)
"""
from flask import Blueprint, request, jsonify, current_app
from db import query, scalar
from models import CITY_IDS

bp = Blueprint("cities", __name__, url_prefix="/api/v1")


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})


def _err(msg, code=400):
    return jsonify({"error": msg}), code


# ── GET /api/v1/cities ────────────────────────────────────────────────────────
@bp.get("/cities")
def list_cities():
    """
    Return all cities with latest AQI and dominant parameter.

    Query params:
      country   — filter by country code (default IN)
    """
    country = request.args.get("country", "IN")

    rows, ms = query("""
        SELECT
            r.region_id   AS city_id,
            r.name        AS city_name,
            r.lat,
            r.lng,
            p.region_id   AS state_id,
            p.name        AS state_name,
            (SELECT a.aqi_value
             FROM   aqi_readings a
             JOIN   stations s ON s.station_id = a.station_id
             WHERE  s.region_id = r.region_id
             ORDER BY a.timestamp_utc DESC
             LIMIT  1)    AS latest_aqi,
            (SELECT a.aqi_category
             FROM   aqi_readings a
             JOIN   stations s ON s.station_id = a.station_id
             WHERE  s.region_id = r.region_id
             ORDER BY a.timestamp_utc DESC
             LIMIT  1)    AS aqi_category,
            (SELECT a.timestamp_utc
             FROM   aqi_readings a
             JOIN   stations s ON s.station_id = a.station_id
             WHERE  s.region_id = r.region_id
             ORDER BY a.timestamp_utc DESC
             LIMIT  1)    AS last_updated,
            (SELECT COUNT(*) FROM stations s2
             WHERE  s2.region_id = r.region_id AND s2.is_active = 1) AS station_count
        FROM   regions r
        LEFT JOIN regions p ON p.region_id = r.parent_id
        WHERE  r.region_type = 'city'
          AND  r.country_code = ?
        ORDER BY r.name
    """, (country,))

    return _ok(rows, {"total": len(rows), "query_ms": ms})


# ── GET /api/v1/cities/<city_id> ──────────────────────────────────────────────
@bp.get("/cities/<city_id>")
def city_detail(city_id):
    """City metadata + 24-h parameter summary."""
    city, ms = query(
        "SELECT region_id,name,lat,lng FROM regions WHERE region_id=? AND region_type='city'",
        (city_id,), one=True
    )
    if not city:
        return _err(f"City '{city_id}' not found", 404)

    # 24-h averages by parameter
    param_avgs, ms2 = query("""
        SELECT
            pa.code        AS param,
            pa.name        AS param_name,
            pa.unit,
            pa.who_guideline,
            pa.naaqs_standard,
            ROUND(AVG(m.value), 2) AS mean_24h,
            ROUND(MIN(m.value), 2) AS min_24h,
            ROUND(MAX(m.value), 2) AS max_24h,
            COUNT(m.value)         AS readings
        FROM   measurements m
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        JOIN   stations s    ON s.station_id = m.station_id
        WHERE  s.region_id = ?
          AND  m.timestamp_utc >= datetime('now','-24 hours')
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY pa.code
        ORDER BY pa.code
    """, (city_id,))

    latest_aqi, ms3 = query("""
        SELECT a.aqi_value, a.aqi_category, a.timestamp_utc
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
        ORDER BY a.timestamp_utc DESC
        LIMIT  1
    """, (city_id,), one=True)

    return _ok({
        **city,
        "parameters_24h": param_avgs,
        "latest_aqi": latest_aqi,
    }, {"query_ms": round(ms + ms2 + ms3, 2)})


# ── GET /api/v1/stations ──────────────────────────────────────────────────────
@bp.get("/stations")
def list_stations():
    """
    List monitoring stations.

    Query params:
      city      — filter by region_id (city)
      active    — 1 (default) or 0 to include inactive
      limit     — default 100
    """
    city    = request.args.get("city")
    active  = request.args.get("active", "1")
    limit   = min(int(request.args.get("limit", 200)), 500)

    where  = ["1=1"]
    params = []
    if city:
        where.append("s.region_id = ?")
        params.append(city)
    if active in ("0", "1"):
        where.append("s.is_active = ?")
        params.append(int(active))

    params.append(limit)
    rows, ms = query(f"""
        SELECT
            s.station_id,
            s.station_code,
            s.name,
            s.region_id  AS city_id,
            r.name       AS city_name,
            s.lat,
            s.lng,
            s.station_type,
            s.is_active,
            (SELECT a.aqi_value
             FROM   aqi_readings a
             WHERE  a.station_id = s.station_id
             ORDER BY a.timestamp_utc DESC LIMIT 1) AS latest_aqi,
            (SELECT a.aqi_category
             FROM   aqi_readings a
             WHERE  a.station_id = s.station_id
             ORDER BY a.timestamp_utc DESC LIMIT 1) AS aqi_category
        FROM   stations s
        LEFT JOIN regions r ON r.region_id = s.region_id
        WHERE  {' AND '.join(where)}
        ORDER BY r.name, s.name
        LIMIT  ?
    """, params)

    return _ok(rows, {"total": len(rows), "query_ms": ms})


# ── GET /api/v1/stations/<station_code> ───────────────────────────────────────
@bp.get("/stations/<station_code>")
def station_detail(station_code):
    stn, ms = query(
        """SELECT s.*, r.name AS city_name FROM stations s
           LEFT JOIN regions r ON r.region_id = s.region_id
           WHERE s.station_code = ?""",
        (station_code,), one=True
    )
    if not stn:
        return _err(f"Station '{station_code}' not found", 404)

    # 7-day AQI trend (daily mean)
    trend, ms2 = query("""
        SELECT  DATE(timestamp_utc) AS date,
                ROUND(AVG(aqi_value),0) AS mean_aqi
        FROM    aqi_readings
        WHERE   station_id = ?
          AND   timestamp_utc >= datetime('now','-7 days')
        GROUP BY DATE(timestamp_utc)
        ORDER BY date
    """, (stn["station_id"],))

    return _ok({**stn, "aqi_trend_7d": trend}, {"query_ms": round(ms + ms2, 2)})

"""
/api/v1/aggregations/hourly   — hourly means for a city / station
/api/v1/aggregations/daily    — daily aggregates
/api/v1/aggregations/monthly  — monthly aggregates (CPCB data)
/api/v1/aggregations/compare  — multi-city parameter comparison
"""
from flask import Blueprint, request, jsonify
from db import query

bp = Blueprint("aggregations", __name__, url_prefix="/api/v1/aggregations")

VALID_PARAMS = {"pm25","pm10","no2","so2","o3","co","temperature","humidity"}
AGG_FNS      = {"mean","min","max","count"}


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})

def _err(msg, code=400):
    return jsonify({"error": msg}), code


def _time_filter(start: str, end: str, col: str = "m.timestamp_utc"):
    """Return (extra_where_clauses, extra_args) for time range."""
    where, args = [], []
    if start:
        where.append(f"{col} >= ?"); args.append(start)
    if end:
        where.append(f"{col} <= ?"); args.append(end)
    return where, args


# ── GET /api/v1/aggregations/hourly ──────────────────────────────────────────
@bp.get("/hourly")
def hourly():
    """
    Hourly mean ± std for one or more parameters.

    Query params:
      city    — required unless station provided
      station — station_code
      param   — comma-sep (default: pm25,pm10,no2,so2,o3,co)
      start   — default: 7 days ago
      end     — default: now
      quality — comma-sep flags (default: VALID,ESTIMATED)
    """
    city    = request.args.get("city")
    station = request.args.get("station")
    params  = [p.strip() for p in request.args.get("param","pm25,pm10,no2,so2,o3,co").split(",") if p.strip()]
    start   = request.args.get("start","")
    end     = request.args.get("end","")
    quality = [q.strip() for q in request.args.get("quality","VALID,ESTIMATED").split(",") if q.strip()]

    if not city and not station:
        return _err("Provide 'city' or 'station'")

    bad = set(params) - VALID_PARAMS
    if bad:
        return _err(f"Unknown parameters: {', '.join(bad)}")

    where, args = [], []

    if station:
        where.append("s.station_code = ?"); args.append(station)
    else:
        where.append("s.region_id = ?"); args.append(city)

    p_ph = ",".join("?" * len(params))
    where.append(f"pa.code IN ({p_ph})"); args.extend(params)

    if quality:
        q_ph = ",".join("?" * len(quality))
        where.append(f"m.quality_flag IN ({q_ph})"); args.extend(quality)

    tw, ta = _time_filter(start, end)
    where.extend(tw); args.extend(ta)
    if not start:
        where.append("m.timestamp_utc >= datetime('now','-7 days')")

    rows, ms = query(f"""
        SELECT
            strftime('%Y-%m-%dT%H:00:00Z', m.timestamp_utc) AS hour,
            pa.code  AS param,
            pa.unit,
            ROUND(AVG(m.value), 3)  AS mean,
            ROUND(MIN(m.value), 3)  AS min,
            ROUND(MAX(m.value), 3)  AS max,
            COUNT(m.value)          AS count,
            ROUND(
              SQRT(AVG(m.value*m.value) - AVG(m.value)*AVG(m.value)), 3
            )                       AS std
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
        GROUP BY hour, pa.code
        ORDER BY hour, pa.code
    """, args)

    return _ok(rows, {"total": len(rows), "query_ms": ms})


# ── GET /api/v1/aggregations/daily ───────────────────────────────────────────
@bp.get("/daily")
def daily():
    """
    Daily aggregates.

    Query params: same as /hourly except start defaults to 30 days ago.
    Extra:
      group   — station (default) | city
    """
    city    = request.args.get("city")
    station = request.args.get("station")
    params  = [p.strip() for p in request.args.get("param","pm25,pm10,no2,so2,o3,co").split(",") if p.strip()]
    start   = request.args.get("start","")
    end     = request.args.get("end","")
    quality = [q.strip() for q in request.args.get("quality","VALID,ESTIMATED").split(",") if q.strip()]
    group   = request.args.get("group","station")

    if not city and not station:
        return _err("Provide 'city' or 'station'")

    bad = set(params) - VALID_PARAMS
    if bad:
        return _err(f"Unknown parameters: {', '.join(bad)}")

    where, args = [], []
    if station:
        where.append("s.station_code = ?"); args.append(station)
    else:
        where.append("s.region_id = ?"); args.append(city)

    p_ph = ",".join("?" * len(params))
    where.append(f"pa.code IN ({p_ph})"); args.extend(params)

    if quality:
        q_ph = ",".join("?" * len(quality))
        where.append(f"m.quality_flag IN ({q_ph})"); args.extend(quality)

    tw, ta = _time_filter(start, end)
    where.extend(tw); args.extend(ta)
    if not start:
        where.append("m.timestamp_utc >= datetime('now','-30 days')")

    group_col = "s.region_id" if group == "city" else "s.station_code"

    rows, ms = query(f"""
        SELECT
            DATE(m.timestamp_utc) AS date,
            {group_col}           AS group_key,
            pa.code               AS param,
            pa.unit,
            ROUND(AVG(m.value), 3) AS mean,
            ROUND(MIN(m.value), 3) AS min,
            ROUND(MAX(m.value), 3) AS max,
            COUNT(m.value)         AS count,
            SUM(CASE WHEN pa.who_guideline IS NOT NULL AND m.value > pa.who_guideline THEN 1 ELSE 0 END) AS hours_exceeding_who,
            SUM(CASE WHEN pa.naaqs_standard IS NOT NULL AND m.value > pa.naaqs_standard THEN 1 ELSE 0 END) AS hours_exceeding_naaqs
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
        GROUP BY DATE(m.timestamp_utc), {group_col}, pa.code
        ORDER BY date, {group_col}, pa.code
    """, args)

    return _ok(rows, {"total": len(rows), "group": group, "query_ms": ms})


# ── GET /api/v1/aggregations/monthly ─────────────────────────────────────────
@bp.get("/monthly")
def monthly():
    """
    Monthly CPCB aggregates (2019–2023).

    Query params:
      city    — required
      param   — comma-sep (default: pm25,pm10,no2,so2,o3,co)
      year    — 2019 | 2020 | 2021 | 2022 | 2023  (omit = all)
      station — restrict to specific station_code
    """
    city    = request.args.get("city")
    station = request.args.get("station")
    params  = [p.strip() for p in request.args.get("param","pm25,pm10,no2,so2,o3,co").split(",") if p.strip()]
    year    = request.args.get("year","")

    if not city and not station:
        return _err("Provide 'city' or 'station'")

    bad = set(params) - VALID_PARAMS
    if bad:
        return _err(f"Unknown parameters: {', '.join(bad)}")

    where, args = [], []
    if station:
        where.append("s.station_code = ?"); args.append(station)
    else:
        where.append("s.region_id = ?"); args.append(city)

    p_ph = ",".join("?" * len(params))
    where.append(f"pa.code IN ({p_ph})"); args.extend(params)

    if year:
        try: year_int = int(year)
        except ValueError: return _err("year must be an integer")
        where.append("ma.year = ?"); args.append(year_int)

    rows, ms = query(f"""
        SELECT
            ma.year,
            ma.month,
            s.station_code,
            s.name         AS station_name,
            s.region_id    AS city_id,
            pa.code        AS param,
            pa.unit,
            ROUND(ma.mean_value, 2) AS mean,
            ROUND(ma.min_value,  2) AS min,
            ROUND(ma.max_value,  2) AS max,
            ma.record_count        AS count
        FROM   monthly_aggregates ma
        JOIN   stations   s  ON s.station_id    = ma.station_id
        JOIN   parameters pa ON pa.parameter_id = ma.parameter_id
        WHERE  {' AND '.join(where)}
        ORDER BY ma.year, ma.month, pa.code
    """, args)

    return _ok(rows, {"total": len(rows), "query_ms": ms})


# ── GET /api/v1/aggregations/compare ─────────────────────────────────────────
@bp.get("/compare")
def compare():
    """
    Compare the same parameter across multiple cities over a time range.

    Query params:
      cities  — comma-sep city ids (e.g. delhi,mumbai,bangalore)
      param   — single parameter (default pm25)
      start   — default 30 days ago
      end     — default now
      bin     — day (default) | month | hour
    """
    cities_raw = request.args.get("cities","delhi,mumbai,bangalore,kolkata,chennai,hyderabad")
    cities     = [c.strip() for c in cities_raw.split(",") if c.strip()]
    param      = request.args.get("param", "pm25")
    start      = request.args.get("start", "")
    end        = request.args.get("end", "")
    bin_       = request.args.get("bin", "day")

    if param not in VALID_PARAMS:
        return _err(f"Unknown parameter: {param}")

    BIN_SQL = {
        "hour":  "strftime('%Y-%m-%dT%H:00:00Z', m.timestamp_utc)",
        "day":   "DATE(m.timestamp_utc)",
        "month": "strftime('%Y-%m', m.timestamp_utc)",
    }
    if bin_ not in BIN_SQL:
        return _err("bin must be hour | day | month")

    c_ph = ",".join("?" * len(cities))
    where = [f"s.region_id IN ({c_ph})", "pa.code = ?"]
    args  = cities + [param]

    tw, ta = _time_filter(start, end)
    where.extend(tw); args.extend(ta)
    if not start:
        where.append("m.timestamp_utc >= datetime('now','-30 days')")

    rows, ms = query(f"""
        SELECT
            {BIN_SQL[bin_]}         AS ts,
            s.region_id            AS city_id,
            r.name                 AS city_name,
            ROUND(AVG(m.value),3)  AS mean,
            ROUND(MIN(m.value),3)  AS min,
            ROUND(MAX(m.value),3)  AS max,
            COUNT(m.value)         AS count
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   regions    r  ON r.region_id     = s.region_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  {' AND '.join(where)}
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY ts, s.region_id
        ORDER BY ts, s.region_id
    """, args)

    return _ok(rows, {"cities": cities, "param": param, "bin": bin_, "total": len(rows), "query_ms": ms})

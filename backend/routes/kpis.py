"""
KPI endpoints — pre-computed analytics for a city + time period.

GET /api/v1/kpis/overview       — 6 headline KPI cards + sparklines
GET /api/v1/kpis/peak-hours     — hour-of-day pollution profile (0-23)
GET /api/v1/kpis/day-categories — Safe / Moderate / Hazardous day counts
GET /api/v1/kpis/trends         — per-parameter trend analysis with slope
GET /api/v1/kpis/health-index   — composite Pollution Load Index + risk days
GET /api/v1/kpis/full           — all of the above in one round-trip
"""
import math
from collections import defaultdict
from flask import Blueprint, request, jsonify
from db import query, scalar

bp = Blueprint("kpis", __name__, url_prefix="/api/v1/kpis")

# AQI category thresholds
AQI_CATEGORIES = [
    (0,   50,  "Good",                    "#22c55e"),
    (51,  100, "Moderate",                "#eab308"),
    (101, 150, "Unhealthy for Sensitive", "#f97316"),
    (151, 200, "Unhealthy",               "#ef4444"),
    (201, 300, "Very Unhealthy",          "#8b5cf6"),
    (301, 999, "Hazardous",               "#991b1b"),
]

# WHO 2021 24-h guidelines (μg/m³)
WHO_24H = {"pm25": 15, "pm10": 45, "no2": 25, "so2": 40, "o3": 100, "co": 4000}
# India NAAQS 24-h (μg/m³)
NAAQS_24H = {"pm25": 60, "pm10": 100, "no2": 80, "so2": 80, "o3": 180, "co": 10_000}

POLLUTANT_PARAMS = ["pm25","pm10","no2","so2","o3","co"]
VALID_PERIODS = {7, 14, 30, 90}


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})

def _err(msg, code=400):
    return jsonify({"error": msg}), code


# ── Math helpers ──────────────────────────────────────────────────────────────

def _safe_mean(lst):
    vals = [v for v in lst if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


def _linreg_slope(ys):
    """Return the slope of a simple linear regression over evenly-spaced ys."""
    n = len(ys)
    if n < 2:
        return 0.0
    mx = (n - 1) / 2.0
    my = sum(ys) / n
    numer = sum((i - mx) * (y - my) for i, y in enumerate(ys))
    denom = sum((i - mx) ** 2 for i in range(n))
    return numer / denom if denom else 0.0


def _trend_direction(slope, baseline):
    """Classify slope as up / down / stable relative to baseline mean."""
    if baseline is None or baseline == 0:
        return "stable"
    rel = slope / baseline * 100  # % change per step
    if rel > 2:
        return "up"
    if rel < -2:
        return "down"
    return "stable"


def _aqi_category(aqi):
    if aqi is None:
        return "Unknown"
    for lo, hi, cat, _ in AQI_CATEGORIES:
        if lo <= aqi <= hi:
            return cat
    return "Hazardous"


def _pollution_load_index(means):
    """Geometric mean of (concentration / WHO_guideline) for available params."""
    ratios = []
    for p, who in WHO_24H.items():
        v = means.get(p)
        if v is not None and who and v > 0:
            ratios.append(v / who)
    if not ratios:
        return None
    log_sum = sum(math.log(r) for r in ratios)
    return round(math.exp(log_sum / len(ratios)), 3)


def _pli_category(pli):
    if pli is None:
        return "Unknown"
    if pli <= 0.5:  return "Excellent"
    if pli <= 1.0:  return "Good"
    if pli <= 2.0:  return "Moderate"
    if pli <= 5.0:  return "Unhealthy"
    return "Hazardous"


# ── Shared data fetch ─────────────────────────────────────────────────────────

def _fetch_hourly(city, period):
    """Return hourly measurement rows for the period."""
    rows, _ = query("""
        SELECT
            strftime('%Y-%m-%dT%H:00:00Z', m.timestamp_utc) AS hour,
            DATE(m.timestamp_utc)                             AS date,
            CAST(strftime('%H', m.timestamp_utc) AS INTEGER)  AS hr,
            pa.code   AS param,
            ROUND(AVG(m.value), 3) AS mean_val
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  s.region_id = ?
          AND  m.timestamp_utc >= datetime('now', ?)
          AND  pa.code IN ('pm25','pm10','no2','so2','o3','co')
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY hour, pa.code
        ORDER BY hour
    """, (city, f"-{period} days"))
    return rows


def _fetch_aqi(city, period):
    """Return hourly AQI rows for the period."""
    rows, _ = query("""
        SELECT
            strftime('%Y-%m-%dT%H:00:00Z', a.timestamp_utc) AS hour,
            DATE(a.timestamp_utc)                             AS date,
            CAST(strftime('%H', a.timestamp_utc) AS INTEGER)  AS hr,
            ROUND(AVG(a.aqi_value), 0)                        AS mean_aqi
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
          AND  a.timestamp_utc >= datetime('now', ?)
        GROUP BY hour
        ORDER BY hour
    """, (city, f"-{period} days"))
    return rows


# ── GET /api/v1/kpis/overview ─────────────────────────────────────────────────
@bp.get("/overview")
def overview():
    """
    Six headline KPI cards + daily AQI sparkline.

    Query params:
      city    — required
      period  — 7 | 14 | 30 (default 30)
    """
    city   = request.args.get("city")
    period = int(request.args.get("period", 30))
    if not city:
        return _err("'city' is required")
    if period not in VALID_PERIODS:
        return _err(f"period must be one of {sorted(VALID_PERIODS)}")

    aqi_rows = _fetch_aqi(city, period)
    meas_rows = _fetch_hourly(city, period)

    # Previous period for trend comparison
    prev_aqi, _ = query("""
        SELECT ROUND(AVG(a.aqi_value), 1) AS mean_aqi
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
          AND  a.timestamp_utc >= datetime('now', ?)
          AND  a.timestamp_utc <  datetime('now', ?)
    """, (city, f"-{2*period} days", f"-{period} days"), one=True)
    prev_mean_aqi = (prev_aqi or {}).get("mean_aqi")

    if not aqi_rows:
        return _ok({}, {"city": city, "period": period, "warning": "No AQI data in period"})

    # ── KPI 1: Average AQI ────────────────────────────────────────────────────
    all_aqi_vals = [r["mean_aqi"] for r in aqi_rows if r["mean_aqi"] is not None]
    avg_aqi = round(sum(all_aqi_vals) / len(all_aqi_vals), 1) if all_aqi_vals else None
    aqi_pct_change = None
    if prev_mean_aqi and avg_aqi:
        aqi_pct_change = round((avg_aqi - prev_mean_aqi) / prev_mean_aqi * 100, 1)

    # ── KPI 2: Peak AQI ───────────────────────────────────────────────────────
    peak_row = max(aqi_rows, key=lambda r: r["mean_aqi"] or 0, default=None)
    peak_aqi  = peak_row["mean_aqi"] if peak_row else None
    peak_hour = peak_row["hr"] if peak_row else None
    peak_date = peak_row["date"] if peak_row else None

    # ── KPI 3 & 4: Safe / Hazardous day counts ─────────────────────────────
    by_date = defaultdict(list)
    for r in aqi_rows:
        if r["mean_aqi"] is not None:
            by_date[r["date"]].append(r["mean_aqi"])
    day_means = {d: round(sum(v)/len(v), 1) for d,v in by_date.items()}
    total_days      = len(day_means)
    safe_days       = sum(1 for v in day_means.values() if v <= 100)
    moderate_days   = sum(1 for v in day_means.values() if 51 <= v <= 100)
    usg_days        = sum(1 for v in day_means.values() if 101 <= v <= 150)
    unhealthy_days  = sum(1 for v in day_means.values() if 151 <= v <= 200)
    hazardous_days  = sum(1 for v in day_means.values() if v > 200)

    # ── KPI 5: WHO / NAAQS compliance (PM2.5) ───────────────────────────────
    pm25_rows  = [r for r in meas_rows if r["param"] == "pm25"]
    pm25_vals  = [r["mean_val"] for r in pm25_rows if r["mean_val"] is not None]
    who_ok     = sum(1 for v in pm25_vals if v <= WHO_24H["pm25"])
    naaqs_ok   = sum(1 for v in pm25_vals if v <= NAAQS_24H["pm25"])
    who_pct    = round(who_ok / len(pm25_vals) * 100, 1) if pm25_vals else None
    naaqs_pct  = round(naaqs_ok / len(pm25_vals) * 100, 1) if pm25_vals else None

    # ── KPI 6: Dominant pollutant ─────────────────────────────────────────────
    # Param that most often has ratio > 1× its WHO guideline
    exceedance_counts = {}
    by_param = defaultdict(list)
    for r in meas_rows:
        if r["mean_val"] is not None:
            by_param[r["param"]].append(r["mean_val"])
    for p, vals in by_param.items():
        if p in WHO_24H:
            exceedance_counts[p] = sum(1 for v in vals if v > WHO_24H[p])
    dominant_param = max(exceedance_counts, key=exceedance_counts.get) if exceedance_counts else "pm25"
    dominant_pct = round(exceedance_counts.get(dominant_param, 0) / max(len(by_param.get(dominant_param,[])),1) * 100, 1)

    # ── Sparkline: daily mean AQI ──────────────────────────────────────────
    sparkline = [{"date": d, "aqi": v} for d, v in sorted(day_means.items())]

    return _ok({
        "avg_aqi":         avg_aqi,
        "avg_aqi_category":_aqi_category(int(avg_aqi) if avg_aqi else None),
        "prev_avg_aqi":    round(prev_mean_aqi, 1) if prev_mean_aqi else None,
        "aqi_pct_change":  aqi_pct_change,
        "peak_aqi":        peak_aqi,
        "peak_aqi_category": _aqi_category(int(peak_aqi) if peak_aqi else None),
        "peak_hour":       peak_hour,
        "peak_date":       peak_date,
        "total_days":      total_days,
        "safe_days":       safe_days,
        "moderate_days":   moderate_days,
        "usg_days":        usg_days,
        "unhealthy_days":  unhealthy_days,
        "hazardous_days":  hazardous_days,
        "who_compliance_pct":   who_pct,
        "naaqs_compliance_pct": naaqs_pct,
        "dominant_param":  dominant_param,
        "dominant_exceedance_pct": dominant_pct,
        "sparkline":       sparkline,
    }, {"city": city, "period": period})


# ── GET /api/v1/kpis/peak-hours ───────────────────────────────────────────────
@bp.get("/peak-hours")
def peak_hours():
    """
    Average AQI and pollutant concentrations for each hour of the day (0-23).
    Identifies top-3 worst and top-3 cleanest hours.

    Query params:
      city   — required
      period — 7 | 14 | 30 (default 30)
    """
    city   = request.args.get("city")
    period = int(request.args.get("period", 30))
    if not city:
        return _err("'city' is required")

    # AQI by hour
    aqi_by_hour, ms1 = query("""
        SELECT
            CAST(strftime('%H', a.timestamp_utc) AS INTEGER) AS hr,
            ROUND(AVG(a.aqi_value), 1) AS mean_aqi,
            ROUND(MIN(a.aqi_value), 0) AS min_aqi,
            ROUND(MAX(a.aqi_value), 0) AS max_aqi,
            COUNT(*) AS readings
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
          AND  a.timestamp_utc >= datetime('now', ?)
        GROUP BY hr
        ORDER BY hr
    """, (city, f"-{period} days"))

    # PM2.5 by hour
    pm25_by_hour, ms2 = query("""
        SELECT
            CAST(strftime('%H', m.timestamp_utc) AS INTEGER) AS hr,
            ROUND(AVG(m.value), 2) AS mean_pm25
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  s.region_id = ? AND pa.code = 'pm25'
          AND  m.timestamp_utc >= datetime('now', ?)
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY hr
    """, (city, f"-{period} days"))

    # Weekend vs weekday split
    weekday_aqi, _ = query("""
        SELECT
            CAST(strftime('%H', a.timestamp_utc) AS INTEGER) AS hr,
            ROUND(AVG(CASE WHEN strftime('%w', a.timestamp_utc) IN ('0','6')
                           THEN a.aqi_value END), 1) AS weekend_aqi,
            ROUND(AVG(CASE WHEN strftime('%w', a.timestamp_utc) NOT IN ('0','6')
                           THEN a.aqi_value END), 1) AS weekday_aqi
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
          AND  a.timestamp_utc >= datetime('now', ?)
        GROUP BY hr
        ORDER BY hr
    """, (city, f"-{period} days"))

    pm25_map  = {r["hr"]: r["mean_pm25"] for r in pm25_by_hour}
    wd_map    = {r["hr"]: r for r in weekday_aqi}

    hours = []
    for h in range(24):
        row = next((r for r in aqi_by_hour if r["hr"] == h), None)
        wd  = wd_map.get(h, {})
        hours.append({
            "hour":        h,
            "label":       f"{'12' if h==0 else h if h<=12 else h-12} {'AM' if h<12 else 'PM'}",
            "mean_aqi":    row["mean_aqi"] if row else None,
            "min_aqi":     row["min_aqi"]  if row else None,
            "max_aqi":     row["max_aqi"]  if row else None,
            "mean_pm25":   pm25_map.get(h),
            "weekend_aqi": wd.get("weekend_aqi"),
            "weekday_aqi": wd.get("weekday_aqi"),
            "aqi_category":_aqi_category(int(row["mean_aqi"]) if row and row["mean_aqi"] else None),
            "readings":    row["readings"] if row else 0,
        })

    sorted_by_aqi = sorted([h for h in hours if h["mean_aqi"] is not None], key=lambda h: h["mean_aqi"])
    return _ok({
        "hours":      hours,
        "worst_3":    [h["hour"] for h in sorted_by_aqi[-3:][::-1]],
        "cleanest_3": [h["hour"] for h in sorted_by_aqi[:3]],
    }, {"city": city, "period": period, "query_ms": round(ms1+ms2, 2)})


# ── GET /api/v1/kpis/day-categories ──────────────────────────────────────────
@bp.get("/day-categories")
def day_categories():
    """
    Classify each day by its mean AQI category.
    Returns counts per category and a full day-by-day breakdown.

    Query params:
      city   — required
      period — 7 | 14 | 30 (default 30)
    """
    city   = request.args.get("city")
    period = int(request.args.get("period", 30))
    if not city:
        return _err("'city' is required")

    rows, ms = query("""
        SELECT
            DATE(a.timestamp_utc)              AS date,
            ROUND(AVG(a.aqi_value), 1)         AS mean_aqi,
            ROUND(MIN(a.aqi_value), 0)         AS min_aqi,
            ROUND(MAX(a.aqi_value), 0)         AS max_aqi,
            COUNT(*)                           AS readings
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
          AND  a.timestamp_utc >= datetime('now', ?)
        GROUP BY DATE(a.timestamp_utc)
        ORDER BY date
    """, (city, f"-{period} days"))

    cats = {"Good":0,"Moderate":0,"Unhealthy for Sensitive":0,
            "Unhealthy":0,"Very Unhealthy":0,"Hazardous":0}
    by_day = []
    for r in rows:
        cat = _aqi_category(int(r["mean_aqi"]) if r["mean_aqi"] else None)
        if cat in cats:
            cats[cat] += 1
        by_day.append({**r, "category": cat})

    total = len(by_day)
    return _ok({
        "counts":    cats,
        "total_days": total,
        "safe_pct":  round((cats["Good"]+cats["Moderate"])/total*100, 1) if total else 0,
        "hazardous_pct": round((cats["Very Unhealthy"]+cats["Hazardous"])/total*100, 1) if total else 0,
        "by_day":    by_day,
    }, {"city": city, "period": period, "query_ms": ms})


# ── GET /api/v1/kpis/trends ───────────────────────────────────────────────────
@bp.get("/trends")
def trends():
    """
    Per-parameter trend analysis: slope, direction, period-over-period change,
    WHO/NAAQS ratios, and exceedance rates.

    Query params:
      city   — required
      period — 7 | 14 | 30 (default 30)
    """
    city   = request.args.get("city")
    period = int(request.args.get("period", 30))
    if not city:
        return _err("'city' is required")

    result = []
    for param in POLLUTANT_PARAMS:
        # Daily means for current period (for slope)
        daily, _ = query("""
            SELECT DATE(m.timestamp_utc) AS date,
                   ROUND(AVG(m.value), 3) AS mean_val
            FROM   measurements m
            JOIN   stations   s  ON s.station_id    = m.station_id
            JOIN   parameters pa ON pa.parameter_id = m.parameter_id
            WHERE  s.region_id = ? AND pa.code = ?
              AND  m.timestamp_utc >= datetime('now', ?)
              AND  m.quality_flag IN ('VALID','ESTIMATED')
            GROUP BY DATE(m.timestamp_utc)
            ORDER BY date
        """, (city, param, f"-{period} days"))

        # Previous period mean for % change
        prev_mean, _ = query("""
            SELECT ROUND(AVG(m.value), 3) AS mean_val
            FROM   measurements m
            JOIN   stations   s  ON s.station_id    = m.station_id
            JOIN   parameters pa ON pa.parameter_id = m.parameter_id
            WHERE  s.region_id = ? AND pa.code = ?
              AND  m.timestamp_utc >= datetime('now', ?)
              AND  m.timestamp_utc <  datetime('now', ?)
              AND  m.quality_flag IN ('VALID','ESTIMATED')
        """, (city, param, f"-{2*period} days", f"-{period} days"), one=True)

        # Total readings + exceedance counts
        exc, _ = query("""
            SELECT
                COUNT(*)    AS total,
                ROUND(AVG(m.value), 3) AS mean_val,
                ROUND(MIN(m.value), 3) AS min_val,
                ROUND(MAX(m.value), 3) AS max_val,
                SUM(CASE WHEN pa.who_guideline  IS NOT NULL AND m.value > pa.who_guideline  THEN 1 ELSE 0 END) AS who_exc,
                SUM(CASE WHEN pa.naaqs_standard IS NOT NULL AND m.value > pa.naaqs_standard THEN 1 ELSE 0 END) AS naaqs_exc,
                pa.unit, pa.who_guideline, pa.naaqs_standard
            FROM   measurements m
            JOIN   stations   s  ON s.station_id    = m.station_id
            JOIN   parameters pa ON pa.parameter_id = m.parameter_id
            WHERE  s.region_id = ? AND pa.code = ?
              AND  m.timestamp_utc >= datetime('now', ?)
              AND  m.quality_flag IN ('VALID','ESTIMATED')
        """, (city, param, f"-{period} days"), one=True)

        if not exc or exc["total"] == 0:
            continue

        vals     = [r["mean_val"] for r in daily if r["mean_val"] is not None]
        slope    = _linreg_slope(vals)
        cur_mean = exc["mean_val"]
        prev_m   = (prev_mean or {}).get("mean_val")
        pct_chg  = round((cur_mean - prev_m) / prev_m * 100, 1) if prev_m and cur_mean else None
        who      = exc["who_guideline"]
        naaqs    = exc["naaqs_standard"]
        total    = exc["total"]

        result.append({
            "param":          param,
            "unit":           exc["unit"],
            "mean_current":   cur_mean,
            "mean_previous":  round(prev_m, 3) if prev_m else None,
            "min_value":      exc["min_val"],
            "max_value":      exc["max_val"],
            "pct_change":     pct_chg,
            "slope":          round(slope, 4),
            "direction":      _trend_direction(slope, cur_mean),
            "who_guideline":  who,
            "naaqs_standard": naaqs,
            "who_ratio":      round(cur_mean / who, 2) if who and cur_mean else None,
            "naaqs_ratio":    round(cur_mean / naaqs, 2) if naaqs and cur_mean else None,
            "who_exceedance_pct":   round(exc["who_exc"] / total * 100, 1) if total else None,
            "naaqs_exceedance_pct": round(exc["naaqs_exc"] / total * 100, 1) if total else None,
            "daily_series":   [{"date": r["date"], "value": r["mean_val"]} for r in daily],
        })

    return _ok(result, {"city": city, "period": period})


# ── GET /api/v1/kpis/health-index ─────────────────────────────────────────────
@bp.get("/health-index")
def health_index():
    """
    Composite Pollution Load Index (geometric mean of param/WHO ratios)
    plus day-level health risk breakdown.

    PLI > 1 = unhealthy, > 5 = hazardous.

    Query params:
      city   — required
      period — 7 | 14 | 30 (default 30)
    """
    city   = request.args.get("city")
    period = int(request.args.get("period", 30))
    if not city:
        return _err("'city' is required")

    # Overall means for PLI
    means_rows, _ = query("""
        SELECT pa.code AS param, ROUND(AVG(m.value), 3) AS mean_val
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  s.region_id = ? AND pa.code IN ('pm25','pm10','no2','so2','o3','co')
          AND  m.timestamp_utc >= datetime('now', ?)
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY pa.code
    """, (city, f"-{period} days"))

    means = {r["param"]: r["mean_val"] for r in means_rows}
    pli   = _pollution_load_index(means)

    components = []
    for p, who in WHO_24H.items():
        v = means.get(p)
        if v is not None and who:
            ratio = round(v / who, 3)
            components.append({
                "param": p,
                "mean":  v,
                "who":   who,
                "ratio": ratio,
                "log_contribution": round(math.log(ratio) if ratio > 0 else 0, 4),
            })
    components.sort(key=lambda c: c["ratio"], reverse=True)

    # Daily PLI timeseries
    daily_pli_rows, _ = query("""
        SELECT DATE(m.timestamp_utc) AS date, pa.code, ROUND(AVG(m.value),3) AS mean_val
        FROM   measurements m
        JOIN   stations   s  ON s.station_id    = m.station_id
        JOIN   parameters pa ON pa.parameter_id = m.parameter_id
        WHERE  s.region_id = ? AND pa.code IN ('pm25','pm10','no2','so2','o3','co')
          AND  m.timestamp_utc >= datetime('now', ?)
          AND  m.quality_flag IN ('VALID','ESTIMATED')
        GROUP BY DATE(m.timestamp_utc), pa.code
        ORDER BY date
    """, (city, f"-{period} days"))

    daily_by_date = defaultdict(dict)
    for r in daily_pli_rows:
        daily_by_date[r["date"]][r["param"]] = r["mean_val"]

    risk_counts = {"Low":0,"Moderate":0,"High":0,"Very High":0,"Extreme":0}
    daily_series = []
    for date, pm in sorted(daily_by_date.items()):
        d_pli = _pollution_load_index(pm)
        if d_pli is None:
            continue
        cat = "Low" if d_pli<=0.5 else "Moderate" if d_pli<=1 else "High" if d_pli<=2 else "Very High" if d_pli<=5 else "Extreme"
        risk_counts[cat] += 1
        daily_series.append({"date": date, "pli": d_pli, "risk": cat})

    return _ok({
        "pli":          pli,
        "category":     _pli_category(pli),
        "components":   components,
        "risk_counts":  risk_counts,
        "daily_series": daily_series,
    }, {"city": city, "period": period})


# ── GET /api/v1/kpis/full ─────────────────────────────────────────────────────
@bp.get("/full")
def full():
    """
    All KPIs in one round-trip (calls each sub-handler internally).

    Query params:
      city   — required
      period — 7 | 14 | 30 (default 30)
    """
    city   = request.args.get("city")
    period = request.args.get("period", "30")
    if not city:
        return _err("'city' is required")

    from flask import current_app
    with current_app.test_request_context(
        f"/api/v1/kpis/overview?city={city}&period={period}"
    ):
        pass  # only used for validation above

    # Directly call functions to avoid HTTP overhead
    import sys
    import json

    def _call(fn):
        try:
            resp = fn()
            if hasattr(resp, 'get_json'):
                return resp.get_json()
            return json.loads(resp[0].get_data()) if isinstance(resp, tuple) else resp.get_json()
        except Exception as e:
            return {"error": str(e)}

    # Patch request.args for sub-calls
    from flask import request as req
    from werkzeug.test import EnvironBuilder
    from werkzeug.wrappers import Request

    def _sub(fn):
        try:
            with current_app.test_request_context(f"/?city={city}&period={period}"):
                from flask import request as _r
                return fn()
        except Exception as e:
            return jsonify({"error": str(e)})

    ov   = _sub(overview)
    ph   = _sub(peak_hours)
    dc   = _sub(day_categories)
    tr   = _sub(trends)
    hi   = _sub(health_index)

    def _extract(r):
        if hasattr(r, 'get_json'):
            return r.get_json().get("data")
        return None

    return jsonify({
        "overview":       _extract(ov),
        "peak_hours":     _extract(ph),
        "day_categories": _extract(dc),
        "trends":         _extract(tr),
        "health_index":   _extract(hi),
        "meta": {"city": city, "period": int(period)},
    })

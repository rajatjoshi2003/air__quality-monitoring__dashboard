"""
/api/v1/forecast/models  — available forecasting models
/api/v1/forecast/aqi     — short-term AQI forecast for a city
"""
from datetime import datetime, timedelta, timezone
from flask import Blueprint, request, jsonify
from db import query
import forecaster

bp = Blueprint("forecast", __name__, url_prefix="/api/v1/forecast")

MAX_HORIZON  = 168     # cap projection at 7 days
MIN_LOOKBACK = 48      # need at least 2 days for seasonality
MAX_LOOKBACK = 720     # up to 30 days of training history


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})

def _err(msg, code=400):
    return jsonify({"error": msg}), code


# ── GET /api/v1/forecast/models ───────────────────────────────────────────────
@bp.get("/models")
def models():
    """List the available forecasting models."""
    return _ok([{"id": k, **v} for k, v in forecaster.MODELS.items()])


# ── GET /api/v1/forecast/aqi ──────────────────────────────────────────────────
@bp.get("/aqi")
def forecast_aqi():
    """
    Short-term hourly AQI forecast for a city.

    Pulls the recent hourly AQI trend (mean across the city's stations),
    fits the chosen model, and projects `horizon` hours ahead with a
    90% prediction band and a hold-out backtest accuracy.

    Query params:
      city     — required (region_id, e.g. delhi)
      method   — movingAverage | seasonalNaive | linear | holt | holtWinters
                 (default: holtWinters)
      horizon  — hours ahead (default 24, max 168)
      lookback — hours of history to train on (default 168, 48–720)
    """
    city = request.args.get("city")
    if not city:
        return _err("'city' is required")

    method = request.args.get("method", "holtWinters")
    if method not in forecaster.MODELS:
        return _err(f"Unknown method: {method}. Valid: {', '.join(forecaster.MODELS)}")

    try:
        horizon = int(request.args.get("horizon", 24))
    except ValueError:
        return _err("horizon must be an integer")
    horizon = max(1, min(horizon, MAX_HORIZON))

    try:
        lookback = int(request.args.get("lookback", 168))
    except ValueError:
        return _err("lookback must be an integer")
    lookback = max(MIN_LOOKBACK, min(lookback, MAX_LOOKBACK))

    # Hourly mean AQI across the city's stations
    rows, ms = query("""
        SELECT strftime('%Y-%m-%dT%H:00:00Z', a.timestamp_utc) AS ts,
               ROUND(AVG(a.aqi_value), 1)                        AS aqi
        FROM   aqi_readings a
        JOIN   stations s ON s.station_id = a.station_id
        WHERE  s.region_id = ?
          AND  a.timestamp_utc >= datetime('now', ?)
        GROUP BY ts
        ORDER BY ts
    """, (city, f"-{lookback} hours"))

    if len(rows) < 3:
        return _err(f"Not enough AQI history for '{city}' to forecast", 404)

    values = [r["aqi"] for r in rows]
    try:
        result = forecaster.run(values, method=method, horizon=horizon)
    except ValueError as e:
        return _err(str(e))

    # Map each forecast step onto a real hourly timestamp after the last bucket
    last_ts = datetime.strptime(rows[-1]["ts"], "%Y-%m-%dT%H:00:00Z").replace(tzinfo=timezone.utc)
    for p in result["points"]:
        ft = last_ts + timedelta(hours=p["step"])
        p["timestamp"] = ft.strftime("%Y-%m-%dT%H:00:00Z")

    history = [{"timestamp": r["ts"], "value": r["aqi"]} for r in rows]

    return _ok({
        "city":     city,
        "method":   result["method"],
        "label":    result["label"],
        "horizon":  result["horizon"],
        "sigma":    result["sigma"],
        "accuracy": result["accuracy"],
        "history":  history,
        "points":   result["points"],
    }, {"history_points": len(rows), "lookback_hours": lookback, "query_ms": ms})

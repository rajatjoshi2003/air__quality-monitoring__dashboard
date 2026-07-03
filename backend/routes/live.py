"""
/api/v1/live/aqi   — real-time CPCB AQI proxied from data.gov.in

Proxies the Government of India "Real time Air Quality Index from various
locations" dataset (resource 3b01bcb8-…) so the browser can read live CPCB
station data without tripping CORS. The source returns per-pollutant
concentrations only, so we compute the National AQI from CPCB sub-index
breakpoints (overall AQI = worst sub-index across pollutants).

Requires a free data.gov.in API key in the DATAGOV_API_KEY environment
variable (register at https://data.gov.in/help/how-use-datasets-apis). The old
public demo key is no longer authorised, so there is intentionally no fallback
key baked in.
"""
import os
import json
import time
from urllib.parse import urlencode
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

from flask import Blueprint, request, jsonify

bp = Blueprint("live", __name__, url_prefix="/api/v1/live")

DATAGOV_RESOURCE = "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69"
DATAGOV_BASE = "https://api.data.gov.in/resource"

# Our city ids → the city name strings CPCB/data.gov.in uses.
CITY_NAMES = {
    "delhi": "Delhi",
    "mumbai": "Mumbai",
    "bangalore": "Bengaluru",
    "kolkata": "Kolkata",
    "chennai": "Chennai",
    "hyderabad": "Hyderabad",
    "pune": "Pune",
    "jaipur": "Jaipur",
    "lucknow": "Lucknow",
    "ahmedabad": "Ahmedabad",
}

# dataset pollutant_id (normalised: upper-case, spaces stripped) → our key
POLLUTANT_MAP = {
    "PM2.5": "pm25", "PM25": "pm25",
    "PM10": "pm10",
    "NO2": "no2",
    "SO2": "so2",
    "CO": "co",
    "OZONE": "o3", "O3": "o3",
    "NH3": "nh3",
}

# CPCB National AQI sub-index breakpoints: param → [(Clow, Chigh, Ilow, Ihigh), …]
# Concentrations in µg/m³ except CO (mg/m³). Averaging periods per CPCB.
CPCB_BREAKPOINTS = {
    "pm25": [(0, 30, 0, 50), (30, 60, 51, 100), (60, 90, 101, 200),
             (90, 120, 201, 300), (120, 250, 301, 400), (250, 500, 401, 500)],
    "pm10": [(0, 50, 0, 50), (50, 100, 51, 100), (100, 250, 101, 200),
             (250, 350, 201, 300), (350, 430, 301, 400), (430, 600, 401, 500)],
    "no2":  [(0, 40, 0, 50), (40, 80, 51, 100), (80, 180, 101, 200),
             (180, 280, 201, 300), (280, 400, 301, 400), (400, 1000, 401, 500)],
    "so2":  [(0, 40, 0, 50), (40, 80, 51, 100), (80, 380, 101, 200),
             (380, 800, 201, 300), (800, 1600, 301, 400), (1600, 2000, 401, 500)],
    "co":   [(0, 1, 0, 50), (1, 2, 51, 100), (2, 10, 101, 200),
             (10, 17, 201, 300), (17, 34, 301, 400), (34, 50, 401, 500)],
    "o3":   [(0, 50, 0, 50), (50, 100, 51, 100), (100, 168, 101, 200),
             (168, 208, 201, 300), (208, 748, 301, 400), (748, 1000, 401, 500)],
    "nh3":  [(0, 200, 0, 50), (200, 400, 51, 100), (400, 800, 101, 200),
             (800, 1200, 201, 300), (1200, 1800, 301, 400), (1800, 2400, 401, 500)],
}

AQI_CATEGORIES = [
    (0, 50, "Good"), (51, 100, "Satisfactory"), (101, 200, "Moderate"),
    (201, 300, "Poor"), (301, 400, "Very Poor"), (401, 500, "Severe"),
]


def _f(val):
    """Parse a possibly-'NA' string to float, or None."""
    try:
        if val is None:
            return None
        s = str(val).strip()
        if s == "" or s.upper() in ("NA", "N/A", "NONE", "-"):
            return None
        return float(s)
    except (ValueError, TypeError):
        return None


def sub_index(param, conc):
    """CPCB sub-index for one pollutant concentration (linear within band)."""
    bps = CPCB_BREAKPOINTS.get(param)
    if bps is None or conc is None or conc < 0:
        return None
    for clow, chigh, ilow, ihigh in bps:
        if clow <= conc <= chigh:
            return round((ihigh - ilow) / (chigh - clow) * (conc - clow) + ilow)
    # above the top breakpoint → cap at 500
    return 500 if conc > bps[-1][1] else None


def aqi_category(aqi):
    for lo, hi, label in AQI_CATEGORIES:
        if lo <= aqi <= hi:
            return label
    return "Severe"


def _pollutant_value(rec):
    """Average concentration across the dataset's historical/renamed field names."""
    for k in ("pollutant_avg", "avg_value", "pollutant_avg_value", "avg"):
        v = _f(rec.get(k))
        if v is not None:
            return v
    return None


def stations_from_records(records):
    """Group flat per-pollutant rows into per-station objects with computed AQI."""
    stations = {}
    for rec in records:
        sid = rec.get("station") or rec.get("station_name") or "Unknown"
        st = stations.setdefault(sid, {
            "station": sid,
            "city": rec.get("city"),
            "state": rec.get("state"),
            "lat": _f(rec.get("latitude")),
            "lng": _f(rec.get("longitude")),
            "last_update": rec.get("last_update"),
            "pollutants": {},
            "subindices": {},
        })
        raw_pid = (rec.get("pollutant_id") or "").upper().replace(" ", "")
        param = POLLUTANT_MAP.get(raw_pid)
        if not param:
            continue
        conc = _pollutant_value(rec)
        if conc is None:
            continue
        st["pollutants"][param] = conc
        si = sub_index(param, conc)
        if si is not None:
            st["subindices"][param] = si

    # Overall station AQI = worst (max) sub-index, per CPCB — but only when at
    # least one PM pollutant is present. India's AQI is PM-dominated, so an AQI
    # derived solely from O3/NO2/etc. (e.g. a station whose PM sensor is down)
    # is misleading; such stations are reported with aqi=null and excluded from
    # the city figure rather than skewing it.
    out = []
    for st in stations.values():
        subs = st["subindices"]
        has_pm = "pm25" in subs or "pm10" in subs
        if subs and has_pm:
            worst_param = max(subs, key=subs.get)
            st["aqi"] = subs[worst_param]
            st["dominant_pollutant"] = worst_param
            st["category"] = aqi_category(st["aqi"])
        else:
            st["aqi"] = None
            st["dominant_pollutant"] = None
            st["category"] = None
            if subs and not has_pm:
                st["note"] = "no PM data — AQI not computed"
        out.append(st)
    return out


@bp.get("/aqi")
def live_aqi():
    """
    Real-time CPCB AQI for a city, proxied from data.gov.in.

    Query params:
      city — one of delhi|mumbai|bangalore|kolkata|chennai|hyderabad (default delhi)
    """
    city = (request.args.get("city") or "delhi").lower()
    city_name = CITY_NAMES.get(city, city.title())

    api_key = os.environ.get("DATAGOV_API_KEY", "").strip()
    if not api_key:
        return jsonify({
            "error": "DATAGOV_API_KEY not set on the server. Register a free key "
                     "at https://data.gov.in/help/how-use-datasets-apis and set "
                     "the DATAGOV_API_KEY environment variable before starting the backend.",
            "source": "datagov",
        }), 503

    params = {
        "api-key": api_key,
        "format": "json",
        "limit": "500",
        "filters[city]": city_name,
    }
    url = f"{DATAGOV_BASE}/{DATAGOV_RESOURCE}?{urlencode(params)}"

    t0 = time.time()
    try:
        req = Request(url, headers={"Accept": "application/json",
                                    "User-Agent": "AirWatch/1.0"})
        with urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        code = "key not authorised — check DATAGOV_API_KEY" if e.code == 403 else f"HTTP {e.code}"
        return jsonify({"error": f"data.gov.in {code}", "source": "datagov"}), 502
    except (URLError, TimeoutError) as e:
        return jsonify({"error": f"data.gov.in unreachable: {e}", "source": "datagov"}), 502
    except json.JSONDecodeError:
        return jsonify({"error": "data.gov.in returned non-JSON", "source": "datagov"}), 502

    records = payload.get("records", []) or []
    stations = stations_from_records(records)
    rated = [s for s in stations if s["aqi"] is not None]

    city_aqi = max((s["aqi"] for s in rated), default=None)
    city_mean = round(sum(s["aqi"] for s in rated) / len(rated)) if rated else None

    return jsonify({
        "data": {
            "city": city,
            "city_name": city_name,
            "aqi": city_aqi,                  # worst station = official city AQI
            "aqi_mean": city_mean,
            "category": aqi_category(city_aqi) if city_aqi is not None else None,
            "station_count": len(stations),
            "stations": sorted(stations, key=lambda s: (s["aqi"] is None, -(s["aqi"] or 0))),
            "last_update": rated[0]["last_update"] if rated else None,
        },
        "meta": {
            "source": "data.gov.in / CPCB",
            "resource": DATAGOV_RESOURCE,
            "fetch_ms": round((time.time() - t0) * 1000, 1),
            "total_records": len(records),
        },
    })

"""
/api/v1/etl/upload  — upload CSV, get cleaned + typed preview back
/api/v1/etl/run     — run a named transformation pipeline on uploaded data
/api/v1/etl/ingest  — ingest JSON body rows into measurements table
"""
import io
import csv
import math
import statistics
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app
from db import query, execute, execute_many, scalar
from models import calc_aqi

bp = Blueprint("etl", __name__, url_prefix="/api/v1/etl")

ALLOWED_EXTS = {".csv", ".tsv", ".txt"}
MAX_ROWS     = 50_000
VALID_PARAMS = {"pm25","pm10","no2","so2","o3","co","temperature","humidity","aqi"}


def _ok(data, meta=None):
    return jsonify({"data": data, "meta": meta or {}})

def _err(msg, code=400):
    return jsonify({"error": msg}), code


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _sniff_delimiter(sample: str) -> str:
    for d in [",", "\t", ";", "|"]:
        counts = [line.count(d) for line in sample.split("\n")[:5] if line.strip()]
        if counts and min(counts) > 0 and max(counts) == min(counts):
            return d
    return ","


def _parse_number(val):
    if val in (None, "", "NA", "N/A", "-", "nan"):
        return None
    try:
        return float(str(val).replace(",",""))
    except (ValueError, TypeError):
        return None


def _parse_ts(val):
    if not val:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
                "%d-%m-%Y %H:%M:%S", "%d-%m-%Y", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
        try:
            d = datetime.strptime(val.strip(), fmt)
            return d.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    return None


PARAM_ALIASES = {
    "pm25":        ["pm2.5","pm25","pm_2_5","pm2_5","fine_pm"],
    "pm10":        ["pm10","pm_10","coarse_pm"],
    "no2":         ["no2","no_2","nitrogen_dioxide"],
    "so2":         ["so2","so_2","sulfur_dioxide","sulphur_dioxide"],
    "o3":          ["o3","ozone"],
    "co":          ["co","carbon_monoxide"],
    "temperature": ["temp","temperature","air_temp","t_air"],
    "humidity":    ["rh","humidity","relative_humidity"],
    "timestamp":   ["timestamp","time","date","datetime","ts","measurement_date"],
    "station_code":["station","station_code","station_id","site","location","site_id"],
    "city":        ["city","district","region","zone"],
    "aqi":         ["aqi","air_quality_index"],
}


def _auto_map(headers: list[str]) -> list[dict]:
    mapping = []
    for h in headers:
        norm = h.lower().replace(" ","_").replace("-","_").replace(".","_")
        found = None
        conf  = 0
        for field, aliases in PARAM_ALIASES.items():
            norm_aliases = [a.replace(".","_") for a in aliases]
            if norm in norm_aliases:
                found = field; conf = 1.0; break
            if any(a in norm or norm in a for a in norm_aliases):
                found = field; conf = 0.7; break
        mapping.append({"source": h, "target": found, "confidence": conf})
    return mapping


def _infer_types(headers: list[str], rows: list[dict]) -> list[dict]:
    sample = rows[:200]
    result = []
    for h in headers:
        vals = [r[h] for r in sample if r.get(h) not in (None,"","NA","N/A","-")]
        if not vals:
            result.append({"col": h, "type": "string", "null_rate": 1.0, "samples": []})
            continue
        null_rate = 1 - len(vals) / len(sample)
        num_ok = sum(1 for v in vals if _parse_number(v) is not None)
        date_ok= sum(1 for v in vals if _parse_ts(str(v)) is not None)
        if num_ok / len(vals) > 0.85:
            dtype = "number"
        elif date_ok / len(vals) > 0.85:
            dtype = "timestamp"
        else:
            dtype = "string"
        result.append({"col": h, "type": dtype, "null_rate": round(null_rate,3), "samples": [str(v) for v in vals[:5]]})
    return result


def _quality_check(rows: list[dict], mapping: dict) -> dict:
    """Return per-parameter quality statistics."""
    stats = {}
    BOUNDS = {"pm25":(0,900),"pm10":(0,1500),"no2":(0,500),"so2":(0,500),
              "o3":(0,500),"co":(0,50),"temperature":(-20,60),"humidity":(0,100)}
    for target, source_col in mapping.items():
        if target not in VALID_PARAMS or not source_col:
            continue
        vals = [_parse_number(r.get(source_col)) for r in rows]
        total   = len(vals)
        missing = sum(1 for v in vals if v is None)
        valid_v = [v for v in vals if v is not None]
        lo, hi  = BOUNDS.get(target, (None,None))
        outliers= sum(1 for v in valid_v if lo is not None and (v < lo or v > hi))
        mean    = statistics.mean(valid_v) if valid_v else None
        std     = statistics.stdev(valid_v) if len(valid_v) > 1 else 0
        stats[target] = {
            "total": total,
            "missing": missing,
            "missing_pct": round(missing/total*100, 1) if total else 0,
            "outliers": outliers,
            "mean": round(mean, 3) if mean is not None else None,
            "std":  round(std, 3),
            "min":  round(min(valid_v), 3) if valid_v else None,
            "max":  round(max(valid_v), 3) if valid_v else None,
        }
    return stats


# ── POST /api/v1/etl/upload ───────────────────────────────────────────────────
@bp.post("/upload")
def upload():
    """
    Upload a CSV file.  Returns schema, auto-mapping, type info, quality stats,
    and a 50-row preview — all without touching the database.

    Form fields:
      file       — the CSV/TSV file
      delimiter  — optional override (auto-sniffed if omitted)
    """
    if "file" not in request.files:
        return _err("No file in request (field name: 'file')")

    f = request.files["file"]
    if not f.filename:
        return _err("Empty filename")

    ext = "." + f.filename.rsplit(".",1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXTS:
        return _err(f"Unsupported file type '{ext}'. Allowed: {', '.join(ALLOWED_EXTS)}")

    raw = f.stream.read().decode("utf-8-sig", errors="replace")
    if not raw.strip():
        return _err("File is empty")

    delimiter = request.form.get("delimiter") or _sniff_delimiter(raw[:2000])

    reader = csv.DictReader(io.StringIO(raw), delimiter=delimiter)
    try:
        rows = []
        for i, row in enumerate(reader):
            if i >= MAX_ROWS:
                break
            rows.append(dict(row))
    except Exception as e:
        return _err(f"CSV parse error: {e}")

    if not rows:
        return _err("File contains no data rows")

    headers = list(rows[0].keys())
    mapping = _auto_map(headers)
    types   = _infer_types(headers, rows)

    # Build flat mapping dict for quality_check
    flat_map = {m["target"]: m["source"] for m in mapping if m["target"]}
    quality  = _quality_check(rows, flat_map)

    return _ok({
        "row_count":  len(rows),
        "headers":    headers,
        "delimiter":  delimiter,
        "mapping":    mapping,
        "type_info":  types,
        "quality":    quality,
        "preview":    rows[:50],
    }, {"filename": f.filename, "truncated": len(rows) >= MAX_ROWS})


# ── POST /api/v1/etl/run ──────────────────────────────────────────────────────
@bp.post("/run")
def run_etl():
    """
    Apply a named transformation pipeline to JSON-body rows.

    Body (JSON):
    {
      "rows":    [...],          # array of objects
      "mapping": {"timestamp":"Date","pm25":"PM2.5", ...},
      "steps":   ["timestamp_norm","unit_convert","enrich_aqi","deduplicate"],
      "preview_only": false      # if true, don't write to DB
    }

    Returns transformed rows + audit log.
    """
    body = request.get_json(silent=True)
    if not body or "rows" not in body:
        return _err("Body must be JSON with a 'rows' array")

    raw_rows = body["rows"]
    if not isinstance(raw_rows, list) or not raw_rows:
        return _err("'rows' must be a non-empty array")
    if len(raw_rows) > MAX_ROWS:
        return _err(f"Too many rows (max {MAX_ROWS})")

    mapping      = body.get("mapping", {})   # {target_field: source_column}
    steps        = body.get("steps", ["field_map","timestamp_norm","enrich_aqi"])
    preview_only = body.get("preview_only", True)

    log   = []
    rows  = [dict(r) for r in raw_rows]

    # ── Step: field_map ───────────────────────────────────────────────────────
    if "field_map" in steps and mapping:
        mapped_rows = []
        for r in rows:
            nr = {}
            for tgt, src in mapping.items():
                if src and src in r:
                    nr[tgt] = r[src]
            # carry unknown columns through
            for k,v in r.items():
                if k not in mapping.values():
                    nr[k] = v
            mapped_rows.append(nr)
        rows = mapped_rows
        log.append({"step":"field_map","status":"ok","rows":len(rows),"mapped_cols":len(mapping)})

    # ── Step: timestamp_norm ──────────────────────────────────────────────────
    if "timestamp_norm" in steps:
        ts_col = next((c for c in ["timestamp","timestamp_utc","date","time"] if c in (rows[0] if rows else {})), None)
        changed = 0
        for r in rows:
            raw_ts = r.get(ts_col or "timestamp","")
            norm   = _parse_ts(str(raw_ts)) if raw_ts else None
            if norm:
                r["timestamp_utc"] = norm; changed += 1
        log.append({"step":"timestamp_norm","status":"ok","normalized":changed})

    # ── Step: type_coerce ─────────────────────────────────────────────────────
    if "type_coerce" in steps:
        coerced = 0
        for r in rows:
            for param in VALID_PARAMS:
                if param in r and r[param] is not None:
                    v = _parse_number(r[param])
                    if v is not None:
                        r[param] = round(v, 3); coerced += 1
        log.append({"step":"type_coerce","status":"ok","coerced":coerced})

    # ── Step: unit_convert (ppb → μg/m³) ─────────────────────────────────────
    if "unit_convert" in steps:
        # Simple MW-based conversion factors for common pollutants at 25°C
        PPB_TO_UGM3 = {"no2": 1.88, "so2": 2.62, "o3": 1.96, "co": 1.145}
        converted = 0
        for r in rows:
            for param, factor in PPB_TO_UGM3.items():
                v = r.get(param)
                if v is not None and isinstance(v, (int,float)) and v < 5000:
                    r[param] = round(v * factor, 3); converted += 1
        log.append({"step":"unit_convert","status":"ok","converted":converted})

    # ── Step: filter (remove negative / physically impossible values) ─────────
    if "filter" in steps:
        BOUNDS = {"pm25":(0,900),"pm10":(0,1500),"no2":(0,500),"so2":(0,500),
                  "o3":(0,500),"co":(0,50),"temperature":(-20,60),"humidity":(0,100)}
        before = len(rows)
        def _row_ok(r):
            for p, (lo,hi) in BOUNDS.items():
                v = r.get(p)
                if v is not None and isinstance(v,(int,float)):
                    if v < lo or v > hi:
                        r["quality_flag"] = "OUTLIER"; return False
            return True
        rows = [r for r in rows if _row_ok(r)]
        log.append({"step":"filter","status":"ok","removed":before - len(rows),"remaining":len(rows)})

    # ── Step: enrich_aqi ──────────────────────────────────────────────────────
    if "enrich_aqi" in steps:
        enriched = 0
        for r in rows:
            pm25 = r.get("pm25")
            if pm25 is not None and isinstance(pm25, (int,float)):
                aqi_val, aqi_cat = calc_aqi(float(pm25), "pm25")
                r["aqi"] = aqi_val; r["aqi_category"] = aqi_cat; enriched += 1
        log.append({"step":"enrich_aqi","status":"ok","enriched":enriched})

    # ── Step: deduplicate (by station + timestamp) ────────────────────────────
    if "deduplicate" in steps:
        seen = {}
        for r in rows:
            key = (r.get("station_code",""), r.get("timestamp_utc",""))
            seen[key] = r
        before = len(rows)
        rows = list(seen.values())
        log.append({"step":"deduplicate","status":"ok","removed":before - len(rows),"remaining":len(rows)})

    # ── Step: quality_score ────────────────────────────────────────────────────
    if "quality_score" in steps:
        param_cols = [p for p in VALID_PARAMS if p not in ("aqi","temperature","humidity")]
        for r in rows:
            filled = sum(1 for p in param_cols if r.get(p) is not None)
            r["completeness_pct"] = round(filled / len(param_cols) * 100, 1)
            r.setdefault("quality_flag", "VALID")
        log.append({"step":"quality_score","status":"ok","rows":len(rows)})

    # ── DB write ──────────────────────────────────────────────────────────────
    inserted = 0
    if not preview_only and rows:
        param_ids = {r["code"]: r["parameter_id"]
                     for r in (query("SELECT code, parameter_id FROM parameters")[0])}
        stn_ids   = {r["station_code"]: r["station_id"]
                     for r in (query("SELECT station_code, station_id FROM stations")[0])}

        insert_rows = []
        for r in rows:
            stn  = r.get("station_code"); ts = r.get("timestamp_utc")
            if not stn or not ts or stn not in stn_ids:
                continue
            stn_id = stn_ids[stn]
            for param in param_cols:
                v = r.get(param)
                if v is None or param not in param_ids:
                    continue
                insert_rows.append((stn_id, param_ids[param], ts, v, r.get("quality_flag","VALID")))

        if insert_rows:
            inserted = execute_many(
                "INSERT OR IGNORE INTO measurements (station_id,parameter_id,timestamp_utc,value,quality_flag) VALUES (?,?,?,?,?)",
                insert_rows
            )
        log.append({"step":"db_write","status":"ok","inserted":inserted})

    return _ok({
        "rows_in":   len(raw_rows),
        "rows_out":  len(rows),
        "preview":   rows[:100],
        "audit_log": log,
    }, {"preview_only": preview_only, "steps_run": steps})


# ── POST /api/v1/etl/ingest ───────────────────────────────────────────────────
@bp.post("/ingest")
def ingest():
    """
    Directly ingest pre-formatted rows (already mapped to standard field names).

    Body (JSON):
    {
      "rows": [
        {"station_code":"DL001","timestamp_utc":"2024-01-01T00:00:00Z","pm25":120.5, ...},
        ...
      ]
    }
    """
    body = request.get_json(silent=True)
    if not body or "rows" not in body:
        return _err("Body must be JSON with 'rows' array")

    raw = body["rows"]
    if len(raw) > MAX_ROWS:
        return _err(f"Too many rows (max {MAX_ROWS})")

    param_map = {r["code"]: r["parameter_id"]
                 for r in query("SELECT code, parameter_id FROM parameters")[0]}
    stn_map   = {r["station_code"]: r["station_id"]
                 for r in query("SELECT station_code, station_id FROM stations")[0]}

    PARAMS = ["pm25","pm10","no2","so2","o3","co","temperature","humidity"]
    insert_rows = []; skipped = 0

    for r in raw:
        stn  = r.get("station_code"); ts = r.get("timestamp_utc")
        if not stn or not ts:
            skipped += 1; continue
        stn_id = stn_map.get(stn)
        if not stn_id:
            skipped += 1; continue
        for p in PARAMS:
            v = _parse_number(r.get(p))
            if v is None or p not in param_map:
                continue
            insert_rows.append((stn_id, param_map[p], ts, round(v,4), r.get("quality_flag","VALID")))

    inserted = execute_many(
        "INSERT OR IGNORE INTO measurements (station_id,parameter_id,timestamp_utc,value,quality_flag) VALUES (?,?,?,?,?)",
        insert_rows
    ) if insert_rows else 0

    return _ok({"inserted": inserted, "skipped": skipped, "attempted": len(insert_rows)})

# AirWatch — Power BI Dashboard

An interactive Power BI build over the same AirWatch data that powers the web
dashboard. Power BI Desktop is a GUI app, so this folder gives you everything
*up to* the visual assembly: a clean star-schema data export, a DAX measures
pack, and the step-by-step layout below.

## Contents
| File | What it is |
|------|------------|
| `export_powerbi.py` | Exports the SQLite DB to star-schema CSVs in `data/` |
| `data/*.csv` | Generated tables (git-ignored — regenerate any time) |
| `measures.dax` | DAX measures to paste into the model |
| `README.md` | This build guide |

## 0. Prerequisites
- **Power BI Desktop** (free). Install: `winget install --id Microsoft.PowerBI -e`
  or get it from the Microsoft Store ("Power BI Desktop").
- Python (already set up here) to generate the data.

## 1. Generate the data
```powershell
python powerbi/export_powerbi.py
```
Produces in `powerbi/data/`:

**Dimensions:** `dim_region`, `dim_station`, `dim_parameter`, `dim_date`
**Facts:** `fact_measurements` (hourly raw, ~121k), `fact_aqi` (hourly AQI, ~15k), `fact_monthly` (2019–2023 monthly)

## 2. Load into Power BI
`Home → Get Data → Text/CSV`, import each CSV in `powerbi/data/` (load all 7).
First row is the header; let Power BI auto-detect types. Confirm:
- `*_id` columns → Whole Number
- `value`, `lat`, `lng`, `*_value` → Decimal Number
- `date` (in `dim_date`, `fact_*`) → Date
- `timestamp_utc` → keep as Text (ISO) or Date/Time

## 3. Build the model (Model view → drag to create relationships)
All relationships are **one-to-many, single direction** (dim → fact):

| From (one) | To (many) |
|------------|-----------|
| `dim_station[station_id]` | `fact_measurements[station_id]` |
| `dim_station[station_id]` | `fact_aqi[station_id]` |
| `dim_station[station_id]` | `fact_monthly[station_id]` |
| `dim_parameter[parameter_id]` | `fact_measurements[parameter_id]` |
| `dim_parameter[parameter_id]` | `fact_monthly[parameter_id]` |
| `dim_region[region_id]` | `dim_station[city_id]` |
| `dim_date[date]` | `fact_measurements[date]` |
| `dim_date[date]` | `fact_aqi[date]` |

Then select `dim_date` → **Table tools → Mark as date table** (column `date`).

> Note: `fact_monthly` is keyed by `year` + `month`, not `dim_date`. Use its own
> `year`/`month` fields on the historical-trend page.

## 4. Add measures
Create a blank table named **Measures** (`Home → Enter data` → rename to
`Measures`, leave empty), then add each measure from **`measures.dax`** via
`New measure`. Key ones: `Avg AQI`, `Latest AQI`, `% WHO Exceedance`,
`% Unhealthy Hours`, `Avg Value` (pair with a parameter slicer).

## 5. Suggested pages (mirrors the web dashboard)

**Page 1 — Overview**
- Card: `Latest AQI` (conditional colour by `AQI Category`)
- Cards: `Avg AQI`, `Max AQI`, `% Unhealthy Hours`
- Line chart: `Avg AQI` by `dim_date[date]` (axis) — recent trend
- Map: `dim_station` by `lat`/`lng`, bubble size = `Avg AQI`
- Slicer: `dim_region[region_name]` (city)

**Page 2 — Pollutant Trends**
- Slicer: `dim_parameter[param_code]`
- Line chart: `Avg Value` by `dim_date[date]`
- Clustered column: `Avg Value` by `dim_parameter[param_name]`
- Cards: `% WHO Exceedance`, `% NAAQS Exceedance`

**Page 3 — City Comparison**
- Bar chart: `Avg AQI` by `dim_region[region_name]` (sorted desc)
- Matrix: rows `dim_region[region_name]`, values `Avg AQI`, `% WHO Exceedance`
- Bar: `Avg Value` by city, with `param_code` slicer

**Page 4 — Heatmap / Patterns**
- Matrix: rows `dim_station[station_name]`, columns `fact_aqi[hour]`,
  values `Avg AQI`, with conditional-format background (green→red)
- Historical: line of `fact_monthly[mean_value]` by `year`/`month_num`
  (parameter slicer)

Add a top slicer panel (city + date range + parameter) and enable
cross-filtering so the whole report stays interactive.

## Refreshing
Re-run `python powerbi/export_powerbi.py`, then `Home → Refresh` in Power BI.
(For live refresh against the running Flask API instead of CSVs, use
`Get Data → Web` on `http://localhost:5000/api/v1/...` endpoints — but the CSV
star schema above is the simplest path to a fast, fully-interactive model.)

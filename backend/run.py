#!/usr/bin/env python3
"""
Entry point.  Run from the project root:

    python backend/run.py
    python backend/run.py --port 5001
    python backend/run.py --seed   # force re-seed and exit
"""
import argparse
import os
import sys

# Make sure the backend package is importable when run as a script
sys.path.insert(0, os.path.dirname(__file__))

# On Windows the default console encoding (cp1252) can't render the box-drawing
# banner below; force UTF-8 so startup doesn't crash with UnicodeEncodeError.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app import create_app

BANNER = """
  ╔══════════════════════════════════════════════════╗
  ║   Air Quality Dashboard — Backend API v1.0       ║
  ║                                                  ║
  ║   Base URL : http://localhost:{port}/api/v1        ║
  ║                                                  ║
  ║   Endpoints:                                     ║
  ║   GET  /health                                   ║
  ║   GET  /cities                                   ║
  ║   GET  /cities/<id>                              ║
  ║   GET  /stations                                 ║
  ║   GET  /parameters                               ║
  ║   GET  /measurements                             ║
  ║   GET  /aqi/latest                               ║
  ║   GET  /aqi/history                              ║
  ║   GET  /aggregations/hourly                      ║
  ║   GET  /aggregations/daily                       ║
  ║   GET  /aggregations/monthly                     ║
  ║   GET  /aggregations/compare                     ║
  ║   GET  /stats/summary                            ║
  ║   GET  /stats/exceedances                        ║
  ║   GET  /stats/rankings                           ║
  ║   GET  /stats/diurnal                            ║
  ║   GET  /stats/trend                              ║
  ║   GET  /forecast/models                          ║
  ║   GET  /forecast/aqi                             ║
  ║   POST /etl/upload                               ║
  ║   POST /etl/run                                  ║
  ║   POST /etl/ingest                               ║
  ╚══════════════════════════════════════════════════╝
"""


def main():
    parser = argparse.ArgumentParser(description="AQI Dashboard API server")
    parser.add_argument("--port",  type=int, default=5000,    help="Port (default 5000)")
    parser.add_argument("--host",  default="127.0.0.1",       help="Bind host (default 127.0.0.1)")
    parser.add_argument("--env",   default="development",     help="Config env: development | production")
    parser.add_argument("--seed",  action="store_true",       help="Force re-seed the database and exit")
    args = parser.parse_args()

    app = create_app(args.env)

    if args.seed:
        with app.app_context():
            from seeder import seed_all
            print("Force-seeding database…")
            result = seed_all(force=True)
            for tbl, n in result.items():
                print(f"  {tbl}: {n} rows")
        return

    print(BANNER.format(port=args.port))
    app.run(host=args.host, port=args.port, debug=(args.env == "development"))


if __name__ == "__main__":
    main()

"""
Flask application factory.
"""
import time
import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_caching import Cache

from config import configs
from db import init_db
from routes import register_blueprints

cache = Cache()


def create_app(env: str = None) -> Flask:
    app = Flask(__name__)

    # ── Config ────────────────────────────────────────────────────────────────
    env = env or os.environ.get("FLASK_ENV", "development")
    app.config.from_object(configs.get(env, configs["default"]))

    # ── Extensions ────────────────────────────────────────────────────────────
    CORS(app, resources={r"/api/*": {"origins": "*"}})
    cache.init_app(app)

    # ── Database ──────────────────────────────────────────────────────────────
    init_db(app)

    # ── Auto-seed on first run ────────────────────────────────────────────────
    with app.app_context():
        from db import scalar
        if scalar("SELECT COUNT(*) FROM parameters") == 0:
            from seeder import seed_all
            app.logger.info("Database is empty — seeding…")
            result = seed_all()
            for tbl, n in result.items():
                app.logger.info(f"  {tbl}: {n} rows")

    # ── Blueprints ────────────────────────────────────────────────────────────
    register_blueprints(app)

    # ── Health endpoint ───────────────────────────────────────────────────────
    @app.get("/api/v1/health")
    def health():
        from db import scalar, query
        db_ok  = scalar("SELECT 1") == 1
        counts, _ = query("""
            SELECT
              (SELECT COUNT(*) FROM measurements)     AS measurements,
              (SELECT COUNT(*) FROM monthly_aggregates) AS monthly,
              (SELECT COUNT(*) FROM aqi_readings)     AS aqi_readings,
              (SELECT COUNT(*) FROM stations)         AS stations
        """, one=True)
        return jsonify({
            "status": "ok" if db_ok else "degraded",
            "db": db_ok,
            "counts": counts or {},
        })

    # ── Request timing header ─────────────────────────────────────────────────
    @app.before_request
    def _start_timer():
        request._start = time.perf_counter()

    @app.after_request
    def _add_timing(response):
        if hasattr(request, "_start"):
            ms = round((time.perf_counter() - request._start) * 1000, 2)
            response.headers["X-Response-Time-ms"] = ms
        response.headers["X-API-Version"] = "1.0"
        return response

    # ── Error handlers ────────────────────────────────────────────────────────
    @app.errorhandler(400)
    def bad_request(e):
        return jsonify({"error": str(e), "code": 400}), 400

    @app.errorhandler(404)
    def not_found(e):
        return jsonify({"error": "Not found", "code": 404}), 404

    @app.errorhandler(405)
    def method_not_allowed(e):
        return jsonify({"error": "Method not allowed", "code": 405}), 405

    @app.errorhandler(500)
    def server_error(e):
        app.logger.exception(e)
        return jsonify({"error": "Internal server error", "code": 500}), 500

    @app.errorhandler(413)
    def too_large(e):
        return jsonify({"error": "File too large (max 16 MB)", "code": 413}), 413

    return app

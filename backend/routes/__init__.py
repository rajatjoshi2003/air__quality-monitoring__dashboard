from .cities       import bp as cities_bp
from .measurements import bp as measurements_bp
from .aggregations import bp as aggregations_bp
from .stats        import bp as stats_bp
from .etl          import bp as etl_bp
from .kpis         import bp as kpis_bp
from .forecast     import bp as forecast_bp
from .live         import bp as live_bp


def register_blueprints(app):
    app.register_blueprint(cities_bp)
    app.register_blueprint(measurements_bp)
    app.register_blueprint(aggregations_bp)
    app.register_blueprint(stats_bp)
    app.register_blueprint(etl_bp)
    app.register_blueprint(kpis_bp)
    app.register_blueprint(forecast_bp)
    app.register_blueprint(live_bp)

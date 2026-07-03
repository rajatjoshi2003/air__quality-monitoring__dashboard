"""
forecaster.py — Short-term AQI forecasting models (server-side).

Pure, dependency-free port of the browser engine in `js/forecast.js`.
Keeping the two in lock-step means browser mode and backend mode produce
the same numbers for the same input series.

Each model shares the signature (y, horizon, period) so they can be
dispatched uniformly; model-specific smoothing constants live inside.
Each returns (forecast, fitted):
  forecast — list of `horizon` future point estimates
  fitted   — in-sample one-step-ahead predictions (for residual sigma)
"""
import math

PERIOD = 24            # hourly data -> 24-step daily seasonality
Z_90   = 1.645         # ~90% prediction interval

MODELS = {
    "movingAverage": {"label": "Moving Average",        "desc": "Mean of the recent window, held flat"},
    "seasonalNaive": {"label": "Seasonal Naive",        "desc": "Repeats the last 24-hour cycle"},
    "linear":        {"label": "Linear Trend",          "desc": "Least-squares trend extrapolation"},
    "holt":          {"label": "Holt (Exp. Smoothing)", "desc": "Level + trend exponential smoothing"},
    "holtWinters":   {"label": "Holt-Winters",          "desc": "Level + trend + 24-hour seasonality"},
}


# ── small math helpers ──────────────────────────────────────────────────────
def _mean(a):
    return sum(a) / len(a) if a else 0.0

def _clamp(v):
    return max(0.0, min(500.0, v))

def _std(arr):
    if len(arr) < 2:
        return 0.0
    m = _mean(arr)
    return math.sqrt(_mean([(x - m) ** 2 for x in arr]))


# ── core model implementations ──────────────────────────────────────────────
def moving_average(y, horizon, period=PERIOD):
    window = 12
    w = min(window, len(y))
    fitted = [None if i == 0 else _mean(y[max(0, i - w):i]) for i in range(len(y))]
    level = _mean(y[-w:])
    return [level] * horizon, fitted


def seasonal_naive(y, horizon, period=PERIOD):
    n = len(y)
    p = min(period, n)
    fitted = [None if i < p else y[i - p] for i in range(n)]
    forecast = [y[n - p + ((h - 1) % p)] for h in range(1, horizon + 1)]
    return forecast, fitted


def linear(y, horizon, period=PERIOD):
    n = len(y)
    xs = list(range(n))
    mx, my = _mean(xs), _mean(y)
    num = sum((xs[i] - mx) * (y[i] - my) for i in range(n))
    den = sum((xs[i] - mx) ** 2 for i in range(n))
    slope = num / den if den else 0.0
    intercept = my - slope * mx
    fitted = [intercept + slope * x for x in xs]
    forecast = [intercept + slope * (n - 1 + h) for h in range(1, horizon + 1)]
    return forecast, fitted


def holt(y, horizon, period=PERIOD):
    alpha, beta = 0.5, 0.15
    n = len(y)
    if n < 2:
        return moving_average(y, horizon)
    level = y[0]
    trend = y[1] - y[0]
    fitted = [None]
    for t in range(1, n):
        fitted.append(level + trend)            # one-step forecast made at t-1
        prev_level = level
        level = alpha * y[t] + (1 - alpha) * (level + trend)
        trend = beta * (level - prev_level) + (1 - beta) * trend
    forecast = [level + h * trend for h in range(1, horizon + 1)]
    return forecast, fitted


def holt_winters(y, horizon, period=PERIOD):
    alpha, beta, gamma = 0.4, 0.05, 0.3
    n = len(y)
    if n < 2 * period:
        return holt(y, horizon, period)         # not enough data for seasonality

    first_cycle  = y[:period]
    second_cycle = y[period:2 * period]
    level = _mean(first_cycle)
    trend = (_mean(second_cycle) - _mean(first_cycle)) / period
    seasonal = [v - level for v in first_cycle]

    fitted = [None] * n
    for t in range(period, n):
        s = seasonal[t % period]
        fitted[t] = level + trend + s           # one-step forecast made at t-1
        prev_level = level
        level = alpha * (y[t] - s) + (1 - alpha) * (level + trend)
        trend = beta * (level - prev_level) + (1 - beta) * trend
        seasonal[t % period] = gamma * (y[t] - level) + (1 - gamma) * s

    forecast = [level + h * trend + seasonal[(n - 1 + h) % period]
                for h in range(1, horizon + 1)]
    return forecast, fitted


FNS = {
    "movingAverage": moving_average,
    "seasonalNaive": seasonal_naive,
    "linear":        linear,
    "holt":          holt,
    "holtWinters":   holt_winters,
}


# ── residual sigma + hold-out backtest ──────────────────────────────────────
def _residual_std(y, fitted):
    errs = [y[i] - fitted[i] for i in range(len(y)) if fitted[i] is not None]
    return _std(errs)


def backtest(values, method, horizon, period=PERIOD):
    n = len(values)
    H = min(horizon, period, n // 4)
    if H < 1:
        return None
    train = values[:n - H]
    test  = values[n - H:]
    forecast, _ = FNS[method](train, H, period)

    abs_sum = sq_sum = pct_sum = 0.0
    pct_n = 0
    for i in range(H):
        err = test[i] - forecast[i]
        abs_sum += abs(err)
        sq_sum  += err * err
        if test[i] != 0:
            pct_sum += abs(err / test[i])
            pct_n += 1
    return {
        "mae":  round(abs_sum / H, 1),
        "rmse": round(math.sqrt(sq_sum / H), 1),
        "mape": round((pct_sum / pct_n) * 100, 1) if pct_n else None,
        "samples": H,
    }


# ── public entry point ──────────────────────────────────────────────────────
def run(values, method="holtWinters", horizon=24, period=PERIOD, z=Z_90):
    """
    Forecast a numeric series.

    @param values   chronological list of numbers (oldest -> newest)
    @returns dict with method, label, horizon, sigma, accuracy and
             points=[{step, value, lower, upper}].  Timestamps are left to
             the caller (the route maps `step` -> a real timestamp).
    """
    if method not in FNS:
        method = "holtWinters"
    horizon = max(1, horizon)
    if len(values) < 3:
        raise ValueError("Need at least 3 historical points to forecast")

    forecast, fitted = FNS[method](values, horizon, period)
    sigma = _residual_std(values, fitted) or _std(values) * 0.15

    points = []
    for i, v in enumerate(forecast):
        h = i + 1
        margin = z * sigma * math.sqrt(h)       # widens with horizon
        points.append({
            "step":  h,
            "value": round(_clamp(v)),
            "lower": round(_clamp(v - margin)),
            "upper": round(_clamp(v + margin)),
        })

    return {
        "method":   method,
        "label":    MODELS[method]["label"],
        "horizon":  horizon,
        "sigma":    round(sigma, 1),
        "points":   points,
        "accuracy": backtest(values, method, horizon, period),
    }

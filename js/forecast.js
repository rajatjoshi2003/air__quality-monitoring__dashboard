// ============================================================
// forecast.js — Short-term AQI forecasting models
// ============================================================
//
// Pure, dependency-free time-series forecasting for the dashboard.
// All models operate on a chronological (oldest → newest) array of
// { timestamp, value } samples at a fixed interval (hourly by default).
//
// Usage:
//   const result = Forecaster.run(history, { method: 'holtWinters', horizon: 24 });
//   result.points    -> [{ timestamp, value, lower, upper }]
//   result.accuracy  -> { mae, rmse, mape }  (from hold-out backtest)
//
// Models:
//   movingAverage  — flat forecast = mean of last window (baseline)
//   seasonalNaive  — repeat the last full daily cycle (captures diurnal shape)
//   linear         — least-squares trend line, extrapolated
//   holt           — double exponential smoothing (level + trend)
//   holtWinters    — additive level + trend + 24-h seasonal (default)
//
const Forecaster = (() => {

  const PERIOD = 24;              // hourly data → 24-step daily seasonality
  const Z_90   = 1.645;          // ~90% prediction interval

  const MODELS = {
    movingAverage: { label: 'Moving Average', desc: 'Mean of the recent window, held flat' },
    seasonalNaive: { label: 'Seasonal Naive', desc: 'Repeats the last 24-hour cycle' },
    linear:        { label: 'Linear Trend',   desc: 'Least-squares trend extrapolation' },
    holt:          { label: 'Holt (Exp. Smoothing)', desc: 'Level + trend exponential smoothing' },
    holtWinters:   { label: 'Holt-Winters',   desc: 'Level + trend + 24-hour seasonality' },
  };

  // ── small math helpers ─────────────────────────────────────
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const clampAqi = v => Math.max(0, Math.min(500, v));

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
  }

  // ── core model implementations ─────────────────────────────
  // Each model shares the signature (y, horizon, period) so they can be
  // dispatched uniformly; model-specific smoothing constants live inside.
  // Each returns { forecast:number[], fitted:(number|null)[] }
  //   forecast — `horizon` future point estimates
  //   fitted   — in-sample one-step-ahead predictions (for residual σ)

  function movingAverage(y, horizon, _period) {
    const window = 12;
    const w = Math.min(window, y.length);
    const fitted = y.map((_, i) =>
      i === 0 ? null : mean(y.slice(Math.max(0, i - w), i)));
    const level = mean(y.slice(-w));
    return { forecast: Array(horizon).fill(level), fitted };
  }

  function seasonalNaive(y, horizon, period = PERIOD) {
    const p = Math.min(period, y.length);
    const fitted = y.map((v, i) => (i < p ? null : y[i - p]));
    const forecast = [];
    for (let h = 1; h <= horizon; h++) forecast.push(y[y.length - p + ((h - 1) % p)]);
    return { forecast, fitted };
  }

  function linear(y, horizon, _period) {
    const n = y.length;
    const xs = y.map((_, i) => i);
    const mx = mean(xs), my = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (y[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den ? num / den : 0;
    const intercept = my - slope * mx;
    const fitted = xs.map(x => intercept + slope * x);
    const forecast = [];
    for (let h = 1; h <= horizon; h++) forecast.push(intercept + slope * (n - 1 + h));
    return { forecast, fitted };
  }

  function holt(y, horizon, _period) {
    const alpha = 0.5, beta = 0.15;
    const n = y.length;
    if (n < 2) return movingAverage(y, horizon);
    let level = y[0];
    let trend = y[1] - y[0];
    const fitted = [null];
    for (let t = 1; t < n; t++) {
      fitted.push(level + trend);                 // one-step forecast made at t-1
      const prevLevel = level;
      level = alpha * y[t] + (1 - alpha) * (level + trend);
      trend = beta * (level - prevLevel) + (1 - beta) * trend;
    }
    const forecast = [];
    for (let h = 1; h <= horizon; h++) forecast.push(level + h * trend);
    return { forecast, fitted };
  }

  function holtWinters(y, horizon, period = PERIOD) {
    const alpha = 0.4, beta = 0.05, gamma = 0.3;
    const n = y.length;
    if (n < 2 * period) return holt(y, horizon, period);   // not enough data for seasonality

    // Seed level, trend, seasonal from the first two cycles
    const firstCycle  = y.slice(0, period);
    const secondCycle = y.slice(period, 2 * period);
    let level = mean(firstCycle);
    let trend = (mean(secondCycle) - mean(firstCycle)) / period;
    const seasonal = firstCycle.map(v => v - level);

    const fitted = new Array(n).fill(null);
    for (let t = period; t < n; t++) {
      const s = seasonal[t % period];
      fitted[t] = level + trend + s;               // one-step forecast made at t-1
      const prevLevel = level;
      level = alpha * (y[t] - s) + (1 - alpha) * (level + trend);
      trend = beta * (level - prevLevel) + (1 - beta) * trend;
      seasonal[t % period] = gamma * (y[t] - level) + (1 - gamma) * s;
    }

    const forecast = [];
    for (let h = 1; h <= horizon; h++) {
      forecast.push(level + h * trend + seasonal[(n - 1 + h) % period]);
    }
    return { forecast, fitted };
  }

  const FNS = { movingAverage, seasonalNaive, linear, holt, holtWinters };

  // ── residual σ from in-sample one-step errors ──────────────
  function residualStd(y, fitted) {
    const errs = [];
    for (let i = 0; i < y.length; i++) {
      if (fitted[i] != null) errs.push(y[i] - fitted[i]);
    }
    return std(errs);
  }

  // ── hold-out backtest for accuracy ─────────────────────────
  function backtest(values, method, horizon, period) {
    const n = values.length;
    const H = Math.min(horizon, period, Math.floor(n / 4));
    if (H < 1) return null;
    const train = values.slice(0, n - H);
    const test  = values.slice(n - H);
    const { forecast } = FNS[method](train, H, period);

    let absSum = 0, sqSum = 0, pctSum = 0, pctN = 0;
    for (let i = 0; i < H; i++) {
      const err = test[i] - forecast[i];
      absSum += Math.abs(err);
      sqSum  += err * err;
      if (test[i] !== 0) { pctSum += Math.abs(err / test[i]); pctN++; }
    }
    return {
      mae:  +(absSum / H).toFixed(1),
      rmse: +Math.sqrt(sqSum / H).toFixed(1),
      mape: pctN ? +((pctSum / pctN) * 100).toFixed(1) : null,
      samples: H,
    };
  }

  // ── public entry point ─────────────────────────────────────
  /**
   * @param {{timestamp:number, value:number}[]} history  chronological samples
   * @param {object} opts
   * @param {string} [opts.method='holtWinters']
   * @param {number} [opts.horizon=24]   steps to forecast
   * @param {number} [opts.period=24]    seasonal period (hourly→24)
   * @param {number} [opts.z=1.645]      prediction-interval multiplier
   */
  function run(history, opts = {}) {
    const method  = FNS[opts.method] ? opts.method : 'holtWinters';
    const horizon = Math.max(1, opts.horizon || 24);
    const period  = opts.period || PERIOD;
    const z       = opts.z || Z_90;

    const values = history.map(d => d.value);
    if (values.length < 3) {
      throw new Error('Need at least 3 historical points to forecast');
    }

    const { forecast, fitted } = FNS[method](values, horizon, period);
    const sigma = residualStd(values, fitted) || std(values) * 0.15;

    // Determine the cadence from the history (fallback: 1 hour)
    const last = history[history.length - 1];
    const step = history.length > 1
      ? last.timestamp - history[history.length - 2].timestamp
      : 3_600_000;

    const points = forecast.map((v, i) => {
      const h = i + 1;
      const margin = z * sigma * Math.sqrt(h);     // widens with horizon
      const value = clampAqi(Math.round(v));
      return {
        timestamp: last.timestamp + h * step,
        value,
        lower: clampAqi(Math.round(v - margin)),
        upper: clampAqi(Math.round(v + margin)),
      };
    });

    return {
      method,
      label: MODELS[method].label,
      horizon,
      sigma: +sigma.toFixed(1),
      points,
      accuracy: backtest(values, method, horizon, period),
    };
  }

  return { run, MODELS, PERIOD };
})();

if (typeof window !== 'undefined') window.Forecaster = Forecaster;
if (typeof module !== 'undefined') module.exports = Forecaster;

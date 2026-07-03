/*
 * filters.js — Global filter state + UI
 *
 * Provides:
 *   Filters.getFilteredData()       → date + AQI-category filtered slice of state.data
 *   Filters.getActivePollutants()   → array of selected pollutant codes
 *   Filters.subscribe(fn)           → called every time filters are applied
 *   Filters.init()                  → bind UI (idempotent)
 *   Filters.sync()                  → update count display without re-rendering
 */

const Filters = (() => {
  'use strict';

  // ── AQI helpers ─────────────────────────────────────────────────────────────
  const AQI_DEFS = [
    { label:'Good',                    lo:0,   hi:50,  color:'#22c55e' },
    { label:'Moderate',                lo:51,  hi:100, color:'#eab308' },
    { label:'Unhealthy for Sensitive', lo:101, hi:150, color:'#f97316' },
    { label:'Unhealthy',               lo:151, hi:200, color:'#ef4444' },
    { label:'Very Unhealthy',          lo:201, hi:300, color:'#8b5cf6' },
    { label:'Hazardous',               lo:301, hi:999, color:'#991b1b' },
  ];
  const ALL_CATS   = AQI_DEFS.map(c => c.label);
  const ALL_PARAMS = ['pm25','pm10','no2','so2','o3','co'];

  const CITIES = [
    { id:'delhi',     label:'Delhi'     },
    { id:'mumbai',    label:'Mumbai'    },
    { id:'bangalore', label:'Bangalore' },
    { id:'kolkata',   label:'Kolkata'   },
    { id:'chennai',   label:'Chennai'   },
    { id:'hyderabad', label:'Hyderabad' },
    { id:'pune',      label:'Pune'      },
    { id:'jaipur',    label:'Jaipur'    },
    { id:'lucknow',   label:'Lucknow'   },
    { id:'ahmedabad', label:'Ahmedabad' },
  ];

  // ── Filter state ─────────────────────────────────────────────────────────────
  const _fs = {
    days:     7,       // 0 = custom range
    fromDate: '',      // YYYY-MM-DD (used when days===0)
    toDate:   '',
    params:   new Set(ALL_PARAMS),
    cats:     new Set(ALL_CATS),
  };

  const _subs = [];
  function subscribe(fn) { _subs.push(fn); }
  function _notify()     { _subs.forEach(fn => { try { fn(); } catch(e) { console.warn('Filter subscriber error:', e); } }); }

  // ── Core filter logic ────────────────────────────────────────────────────────
  function _aqiLabel(v) {
    if (v == null) return null;
    return (AQI_DEFS.find(c => v >= c.lo && v <= c.hi) || AQI_DEFS[AQI_DEFS.length - 1]).label;
  }

  function getFilteredData(src) {
    const data = src || window.state?.data || [];
    let out = data;

    // Date filter
    if (_fs.days > 0) {
      const cutoff = Date.now() - _fs.days * 86_400_000;
      out = out.filter(d => d.timestamp >= cutoff);
    } else if (_fs.fromDate && _fs.toDate) {
      const from = new Date(_fs.fromDate + 'T00:00:00').getTime();
      const to   = new Date(_fs.toDate   + 'T23:59:59').getTime();
      out = out.filter(d => d.timestamp >= from && d.timestamp <= to);
    }

    // AQI category filter
    if (_fs.cats.size < ALL_CATS.length) {
      out = out.filter(d => {
        if (d.aqi == null) return true;
        return _fs.cats.has(_aqiLabel(d.aqi));
      });
    }

    return out;
  }

  function getActivePollutants() {
    return ALL_PARAMS.filter(p => _fs.params.has(p));
  }

  function getState() {
    return {
      days: _fs.days, fromDate: _fs.fromDate, toDate: _fs.toDate,
      params: [..._fs.params], cats: [..._fs.cats],
    };
  }

  // ── UI helpers ────────────────────────────────────────────────────────────────
  function _updateCount() {
    const el = document.getElementById('gfb-count');
    if (!el) return;
    const filtered = getFilteredData().length;
    const total    = (window.state?.data || []).length;
    el.textContent = total
      ? `${filtered.toLocaleString()} / ${total.toLocaleString()} readings`
      : 'No data loaded';
    el.style.color = filtered < total ? 'var(--aqi-moderate)' : 'var(--text-muted)';
  }

  function _updateBadge() {
    const badge = document.getElementById('gfb-badge');
    if (!badge) return;
    let n = 0;
    if (_fs.days !== 7) n++;
    if (_fs.params.size < ALL_PARAMS.length) n++;
    if (_fs.cats.size   < ALL_CATS.length)   n++;
    badge.textContent    = n || '';
    badge.style.display  = n ? 'inline-flex' : 'none';
  }

  function sync() {
    _updateCount();
    _updateBadge();
  }

  function _syncCheckboxes() {
    document.querySelectorAll('#gfb-params input[type=checkbox]').forEach(cb => {
      cb.checked = _fs.params.has(cb.value);
    });
    document.querySelectorAll('#gfb-cats input[type=checkbox]').forEach(cb => {
      cb.checked = _fs.cats.has(cb.value);
    });
    document.querySelectorAll('.gfb-preset').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.days) === _fs.days);
    });
    const customEl = document.getElementById('gfb-custom-dates');
    if (customEl) customEl.style.display = _fs.days === 0 ? 'flex' : 'none';
    const fromEl = document.getElementById('gfb-from');
    const toEl   = document.getElementById('gfb-to');
    if (fromEl) fromEl.value = _fs.fromDate;
    if (toEl)   toEl.value   = _fs.toDate;
    sync();
  }

  // ── Reset ─────────────────────────────────────────────────────────────────────
  function reset() {
    _fs.days     = 7;
    _fs.fromDate = '';
    _fs.toDate   = '';
    _fs.params   = new Set(ALL_PARAMS);
    _fs.cats     = new Set(ALL_CATS);
    _syncCheckboxes();
    _notify();
  }

  // ── City change helper (syncs header dropdown + reloads data) ────────────────
  function _changeCity(cityId) {
    // Sync header city-select
    const sel = document.getElementById('city-select');
    if (sel && sel.value !== cityId) sel.value = cityId;
    // Trigger the existing city-change handler if available
    sel?.dispatchEvent(new Event('change'));
  }

  // ── Init (idempotent) ─────────────────────────────────────────────────────────
  function init() {
    const bar = document.getElementById('gfb');
    if (!bar || bar._gfbBound) return;
    bar._gfbBound = true;

    // ── Collapse toggle ────────────────────────────────────────────────────────
    const toggle = document.getElementById('gfb-toggle');
    toggle?.addEventListener('click', () => {
      bar.classList.toggle('gfb-open');
      toggle.setAttribute('aria-expanded', bar.classList.contains('gfb-open'));
    });

    // ── City selector ──────────────────────────────────────────────────────────
    const cityEl = document.getElementById('gfb-city');
    cityEl?.addEventListener('change', () => _changeCity(cityEl.value));

    // Keep gfb-city in sync if user changes the header city-select
    document.getElementById('city-select')?.addEventListener('change', e => {
      if (cityEl && cityEl.value !== e.target.value) cityEl.value = e.target.value;
    });

    // ── Date presets ───────────────────────────────────────────────────────────
    document.querySelectorAll('.gfb-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.gfb-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _fs.days = parseInt(btn.dataset.days);
        const customEl = document.getElementById('gfb-custom-dates');
        if (customEl) customEl.style.display = _fs.days === 0 ? 'flex' : 'none';
        sync();
      });
    });

    // ── Custom date inputs ─────────────────────────────────────────────────────
    document.getElementById('gfb-from')?.addEventListener('change', e => {
      _fs.fromDate = e.target.value;
      if (_fs.toDate && _fs.fromDate) { _fs.days = 0; _syncCheckboxes(); }
      sync();
    });
    document.getElementById('gfb-to')?.addEventListener('change', e => {
      _fs.toDate = e.target.value;
      if (_fs.fromDate && _fs.toDate) { _fs.days = 0; _syncCheckboxes(); }
      sync();
    });

    // ── Pollutant checkboxes ───────────────────────────────────────────────────
    document.querySelectorAll('#gfb-params input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _fs.params.add(cb.value);
        else            _fs.params.delete(cb.value);
        sync();
      });
    });
    document.getElementById('gfb-params-all')?.addEventListener('click', () => {
      _fs.params = new Set(ALL_PARAMS);
      document.querySelectorAll('#gfb-params input').forEach(cb => cb.checked = true);
      sync();
    });
    document.getElementById('gfb-params-none')?.addEventListener('click', () => {
      _fs.params.clear();
      document.querySelectorAll('#gfb-params input').forEach(cb => cb.checked = false);
      sync();
    });

    // ── AQI category checkboxes ────────────────────────────────────────────────
    document.querySelectorAll('#gfb-cats input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _fs.cats.add(cb.value);
        else            _fs.cats.delete(cb.value);
        sync();
      });
    });
    document.getElementById('gfb-cats-all')?.addEventListener('click', () => {
      _fs.cats = new Set(ALL_CATS);
      document.querySelectorAll('#gfb-cats input').forEach(cb => cb.checked = true);
      sync();
    });
    document.getElementById('gfb-cats-none')?.addEventListener('click', () => {
      _fs.cats.clear();
      document.querySelectorAll('#gfb-cats input').forEach(cb => cb.checked = false);
      sync();
    });

    // ── Apply ──────────────────────────────────────────────────────────────────
    document.getElementById('gfb-apply')?.addEventListener('click', () => {
      _updateBadge();
      _notify();
    });

    // ── Reset ──────────────────────────────────────────────────────────────────
    document.getElementById('gfb-reset')?.addEventListener('click', reset);

    // ── Keyboard shortcut: Alt+F to toggle ────────────────────────────────────
    document.addEventListener('keydown', e => {
      if (e.altKey && e.key === 'f') { e.preventDefault(); toggle?.click(); }
    });

    sync();
  }

  return { init, subscribe, getFilteredData, getActivePollutants, getState, sync, reset };
})();

window.Filters = Filters;

/*
 * analytics.js — Interactive Analytics Studio
 *
 * Tab 1  Timeline     — Plotly: multi-series AQI/pollutant line + range-slider
 *                       Plotly: city PM2.5 box-plot comparison
 * Tab 2  Distribution — Plotly: parallel coordinates (multi-pollutant)
 *                       D3 v7: 24-hour radial AQI clock
 * Tab 3  Geo Map      — D3 v7: India bubble map (Mercator projection)
 *                       City AQI ranking sidebar
 * Tab 4  Correlations — D3 v7: diverging correlation heat-map matrix
 *                       D3 v7: force-directed correlation network
 * Tab 5  3D Explorer  — Plotly: 3-D surface (hour × day-of-week × AQI)
 */

const Analytics = (() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const PARAMS = ['pm25','pm10','no2','so2','o3','co'];
  const PLABELS = { pm25:'PM2.5', pm10:'PM10', no2:'NO₂',  so2:'SO₂', o3:'O₃',   co:'CO',   aqi:'AQI', temperature:'Temp', humidity:'RH' };
  const PUNITS  = { pm25:'μg/m³', pm10:'μg/m³', no2:'μg/m³', so2:'μg/m³', o3:'μg/m³', co:'mg/m³', aqi:'', temperature:'°C', humidity:'%' };
  const PCOLORS = { pm25:'#f97316', pm10:'#fb923c', no2:'#8b5cf6', so2:'#f59e0b', o3:'#22d3ee', co:'#94a3b8', aqi:'#ef4444' };

  const AQI_CATS = [
    { lo:  0, hi:  50, color:'#22c55e', label:'Good'                   },
    { lo: 51, hi: 100, color:'#eab308', label:'Moderate'               },
    { lo:101, hi: 150, color:'#f97316', label:'Unhealthy for Sensitive' },
    { lo:151, hi: 200, color:'#ef4444', label:'Unhealthy'              },
    { lo:201, hi: 300, color:'#8b5cf6', label:'Very Unhealthy'         },
    { lo:301, hi: 999, color:'#991b1b', label:'Hazardous'              },
  ];

  const CITY_COORDS = {
    delhi:     { lat:28.6139, lng:77.2090, label:'Delhi'     },
    mumbai:    { lat:19.0760, lng:72.8777, label:'Mumbai'    },
    bangalore: { lat:12.9716, lng:77.5946, label:'Bangalore' },
    chennai:   { lat:13.0827, lng:80.2707, label:'Chennai'   },
    kolkata:   { lat:22.5726, lng:88.3639, label:'Kolkata'   },
    hyderabad: { lat:17.3850, lng:78.4867, label:'Hyderabad' },
    pune:      { lat:18.5204, lng:73.8567, label:'Pune'      },
    ahmedabad: { lat:23.0225, lng:72.5714, label:'Ahmedabad' },
    jaipur:    { lat:26.9124, lng:75.7873, label:'Jaipur'    },
    lucknow:   { lat:26.8467, lng:80.9462, label:'Lucknow'   },
  };

  // Simplified India polygon — GeoJSON Feature [lng, lat] pairs
  const INDIA_FEATURE = {
    type:'Feature', properties:{ name:'India' },
    geometry:{
      type:'Polygon',
      coordinates:[[
        [68.1,23.6],[70.3,20.1],[72.8,19.1],[73.1,15.2],
        [74.9,12.0],[77.5, 8.3],[80.2, 8.1],[80.3,11.4],
        [80.9,13.2],[81.8,16.5],[82.2,17.1],[82.9,18.3],
        [83.9,18.3],[85.0,19.6],[86.5,20.5],[87.3,21.4],
        [88.5,22.7],[88.4,23.6],[90.2,23.4],[92.1,24.4],
        [92.2,26.1],[94.4,27.7],[96.1,27.4],[97.3,28.2],
        [97.4,29.1],[95.2,29.0],[93.5,28.7],[92.7,27.5],
        [91.6,27.8],[90.4,27.1],[89.1,27.0],[88.9,27.3],
        [88.0,27.9],[86.6,28.0],[85.3,28.0],[83.9,28.4],
        [81.1,30.0],[79.3,31.0],[78.7,31.9],[77.8,32.6],
        [76.5,32.7],[75.7,32.6],[74.7,33.9],[73.6,34.5],
        [73.0,36.2],[72.5,36.5],[71.5,35.7],[70.1,35.2],
        [69.2,34.6],[68.4,35.0],[67.5,34.2],[69.3,31.9],
        [68.9,29.0],[68.1,28.0],[68.2,26.7],[68.8,25.5],
        [68.7,24.3],[68.1,23.6],
      ]],
    },
  };

  // ── Module state ───────────────────────────────────────────────────────────
  const _rendered = {};
  let   _sim      = null;    // D3 force simulation — stopped on re-render

  // ── Math helpers ───────────────────────────────────────────────────────────
  function _mean(arr) {
    const v = arr.filter(x => x != null && !isNaN(x));
    return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;
  }
  function _pearson(xs, ys) {
    const pairs = xs.map((x,i)=>[x,ys[i]]).filter(([a,b])=>a!=null&&b!=null&&!isNaN(a)&&!isNaN(b));
    if (pairs.length < 4) return 0;
    const mx = _mean(pairs.map(p=>p[0])), my = _mean(pairs.map(p=>p[1]));
    const num = pairs.reduce((s,[x,y])=>s+(x-mx)*(y-my), 0);
    const den = Math.sqrt(
      pairs.reduce((s,[x])=>s+(x-mx)**2,0) *
      pairs.reduce((s,[,y])=>s+(y-my)**2,0)
    );
    return den ? +(num/den).toFixed(3) : 0;
  }
  function _aqiColor(v) {
    if (v==null) return '#64748b';
    const cat = AQI_CATS.find(c=>v>=c.lo&&v<=c.hi) || AQI_CATS[AQI_CATS.length-1];
    return cat.color;
  }
  function _sample(arr, n) {
    if (arr.length <= n) return arr;
    const step = Math.ceil(arr.length/n);
    return arr.filter((_,i)=>i%step===0).slice(0,n);
  }

  // ── Data accessors ─────────────────────────────────────────────────────────
  function _data() {
    const raw = window.Filters
      ? window.Filters.getFilteredData()
      : (window.state?.data || []);
    return raw.filter(d => d.aqi != null);
  }
  function _regional(){ return window.state?.regional || {}; }

  function _groupByHour(data) {
    const b = Array.from({length:24},()=>[]);
    data.forEach(d => b[new Date(d.timestamp).getHours()].push(d));
    return b;
  }
  function _gridHourWeekday(data) {
    const g = Array.from({length:7},()=>Array.from({length:24},()=>[]));
    data.forEach(d=>{
      const dt=new Date(d.timestamp);
      if(d.aqi!=null) g[dt.getDay()][dt.getHours()].push(d.aqi);
    });
    return g;
  }

  // ── Plotly dark theme base ─────────────────────────────────────────────────
  const PL = {
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font:{ color:'rgba(255,255,255,.6)', family:'Inter,system-ui,sans-serif', size:11 },
    xaxis:{ gridcolor:'rgba(255,255,255,.06)', zerolinecolor:'rgba(255,255,255,.1)', linecolor:'rgba(255,255,255,.08)' },
    yaxis:{ gridcolor:'rgba(255,255,255,.06)', zerolinecolor:'rgba(255,255,255,.1)', linecolor:'rgba(255,255,255,.08)' },
    legend:{ bgcolor:'rgba(0,0,0,0)', bordercolor:'rgba(255,255,255,.12)', borderwidth:1 },
    hoverlabel:{ bgcolor:'#1e293b', bordercolor:'rgba(255,255,255,.2)', font:{color:'#fff',size:12} },
    margin:{ t:36, r:18, b:52, l:62 },
  };
  const PC = {
    displaylogo:false, responsive:true,
    modeBarButtonsToRemove:['select2d','lasso2d','autoScale2d'],
    toImageButtonOptions:{ format:'png', scale:2, filename:'aqi-analytics' },
  };

  // ── Tab init & switching ───────────────────────────────────────────────────
  function init() {
    const view = document.getElementById('view-analytics');
    if (!view) return;
    if (!view._anBound) {
      view._anBound = true;
      document.querySelectorAll('.an-tab').forEach(b =>
        b.addEventListener('click', () => _switch(b.dataset.tab)));
      document.getElementById('an-refresh-btn')?.addEventListener('click', () => {
        Object.keys(_rendered).forEach(k=>delete _rendered[k]);
        _switch(_currentTab());
      });
    }
    _switch(_currentTab());
  }

  function _currentTab() {
    return document.querySelector('.an-tab.active')?.dataset.tab || 'timeline';
  }

  function _switch(tab) {
    document.querySelectorAll('.an-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
    document.querySelectorAll('.an-panel').forEach(p=>p.classList.toggle('active',p.id===`an-panel-${tab}`));
    if (_rendered[tab]) return;
    _rendered[tab] = true;
    requestAnimationFrame(() => {
      switch(tab) {
        case 'timeline':     _timeline(); _boxplot();     break;
        case 'distribution': _parallel(); _radialClock(); break;
        case 'geo':          _geoMap();   _geoSidebar();  break;
        case 'correlations': _corrMatrix(); _forceNet();  break;
        case '3d':           _surface3d();                break;
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PLOTLY CHARTS
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1. AQI + Pollutant Timeline ───────────────────────────────────────────
  function _timeline() {
    const el = document.getElementById('an-timeline');
    if (!el || typeof Plotly==='undefined') return;
    const data = _data();
    if (!data.length) { el.innerHTML='<div class="an-empty">No time-series data loaded</div>'; return; }

    const ts = data.map(d=>new Date(d.timestamp).toISOString());

    // Compute rolling 6-point mean for AQI
    function rollingMean(arr,w) {
      return arr.map((_,i)=>{
        const sl=arr.slice(Math.max(0,i-w+1),i+1).filter(v=>v!=null);
        return sl.length?_mean(sl):null;
      });
    }

    const activeParams = window.Filters ? window.Filters.getActivePollutants() : PARAMS;

    const traces = [
      // Background AQI area
      {
        x:ts, y:data.map(d=>d.aqi),
        name:'AQI', type:'scatter', mode:'none',
        fill:'tozeroy',
        fillcolor:'rgba(239,68,68,.08)',
        showlegend:false, hoverinfo:'skip',
      },
      // Rolling AQI line
      {
        x:ts, y:rollingMean(data.map(d=>d.aqi),6),
        name:'AQI (6h avg)', type:'scatter', mode:'lines',
        line:{color:'#ef4444',width:2.5},
        hovertemplate:'%{x|%d %b %H:%M}<br>AQI: %{y:.0f}<extra></extra>',
      },
      // Pollutants — only selected ones
      ...PARAMS.filter(f=>activeParams.includes(f)).map(f=>({
        x:ts, y:data.map(d=>d[f]),
        name:PLABELS[f], type:'scatter', mode:'lines',
        line:{color:PCOLORS[f],width:1.5},
        visible:['pm25'].includes(f)?true:'legendonly',
        yaxis:'y2',
        hovertemplate:`%{x|%d %b %H:%M}<br>${PLABELS[f]}: %{y:.1f} ${PUNITS[f]}<extra></extra>`,
      })),
    ];

    // AQI category band annotations
    const shapes = AQI_CATS.map(c=>({
      type:'rect', xref:'paper', yref:'y',
      x0:0, x1:1, y0:c.lo, y1:Math.min(c.hi,500),
      fillcolor:c.color+'0a', line:{width:0},
      layer:'below',
    }));

    Plotly.react(el, traces, {
      ...PL,
      margin:{t:20,r:60,b:80,l:62},
      xaxis:{
        ...PL.xaxis,
        rangeslider:{ bgcolor:'rgba(255,255,255,.04)', thickness:0.06 },
        rangeselector:{
          bgcolor:'rgba(255,255,255,.06)', activecolor:'rgba(59,130,246,.6)',
          bordercolor:'rgba(255,255,255,.1)', borderwidth:1,
          font:{color:'rgba(255,255,255,.55)'},
          buttons:[
            {count:12,label:'12h',step:'hour',stepmode:'backward'},
            {count:3,label:'3d',step:'day',stepmode:'backward'},
            {count:7,label:'7d',step:'day',stepmode:'backward'},
            {count:1,label:'1mo',step:'month',stepmode:'backward'},
            {step:'all',label:'All'},
          ],
        },
      },
      yaxis:{...PL.yaxis,title:{text:'AQI',font:{size:10}}, range:[0,null]},
      yaxis2:{
        overlaying:'y', side:'right',
        gridcolor:'rgba(255,255,255,.03)',
        tickfont:{color:'rgba(255,255,255,.35)',size:9},
        title:{text:'Concentration',font:{size:9,color:'rgba(255,255,255,.35)'}},
        showgrid:false, zeroline:false,
      },
      shapes,
      legend:{...PL.legend, orientation:'h', y:1.12, x:0, font:{size:10}},
      hovermode:'x unified',
    }, PC);
  }

  // ── 2. City Box / Violin Plot ─────────────────────────────────────────────
  function _boxplot() {
    const el = document.getElementById('an-boxplot');
    if (!el || typeof Plotly==='undefined') return;
    const reg = _regional();

    const cities = Object.entries(CITY_COORDS)
      .map(([id,c])=>({ id, label:c.label, pm25:reg[id]?.pm25 }))
      .filter(c=>c.pm25!=null);

    if (!cities.length) { el.innerHTML='<div class="an-empty">No multi-city data — city data generated from CPCB baseline</div>'; return; }

    const RNG = (seed) => {
      let s=seed; return ()=>{ s=(s*16807)%2147483647; return (s-1)/2147483646; };
    };

    const traces = cities.map((c,i)=>{
      const rnd = RNG(c.pm25*100+i*7);
      const base=c.pm25, std=base*0.32;
      const vals=[];
      // Try CPCB monthly data first
      if (typeof window.getCPCBValueAt === 'function') {
        for(let yr=2020;yr<=2023;yr++) for(let mo=1;mo<=12;mo++) {
          const v=window.getCPCBValueAt(c.id,'pm25',new Date(yr,mo-1,15));
          if(v!=null) vals.push(v);
        }
      }
      if (!vals.length) {
        for(let j=0;j<60;j++){
          const u1=Math.max(1e-9,rnd()), u2=rnd();
          vals.push(Math.max(2, base + Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)*std));
        }
      }
      return {
        type:'violin', name:c.label,
        y: vals,
        box:{visible:true, fillcolor:'rgba(0,0,0,.3)', width:0.4},
        line:{color:_aqiColor(base), width:1.5},
        fillcolor:_aqiColor(base)+'40',
        meanline:{visible:true, color:'rgba(255,255,255,.7)', width:1.5},
        points:'outliers',
        marker:{color:_aqiColor(base)+'cc', size:4},
        spanmode:'soft',
        hovertemplate:`${c.label}<br>PM2.5: %{y:.1f} μg/m³<extra></extra>`,
      };
    });

    Plotly.react(el, traces, {
      ...PL,
      margin:{t:16,r:10,b:76,l:55},
      yaxis:{...PL.yaxis, title:{text:'PM2.5 (μg/m³)',font:{size:10}}, rangemode:'tozero'},
      showlegend:false,
      violinmode:'group',
      shapes:[
        {type:'line',xref:'paper',x0:0,x1:1,y0:15,y1:15,line:{color:'#22c55e',width:1.5,dash:'dot'}},
        {type:'line',xref:'paper',x0:0,x1:1,y0:60,y1:60,line:{color:'#ef4444',width:1.5,dash:'dot'}},
      ],
      annotations:[
        {xref:'paper',yref:'y',x:1,y:15,text:'WHO 15',showarrow:false,font:{color:'#22c55e',size:9},xanchor:'right'},
        {xref:'paper',yref:'y',x:1,y:60,text:'NAAQS 60',showarrow:false,font:{color:'#ef4444',size:9},xanchor:'right'},
      ],
    }, PC);
  }

  // ── 3. Parallel Coordinates ───────────────────────────────────────────────
  function _parallel() {
    const el = document.getElementById('an-parallel');
    if (!el || typeof Plotly==='undefined') return;
    const raw = _data();
    if (raw.length < 20) { el.innerHTML='<div class="an-empty">Load more data to use parallel coordinates</div>'; return; }

    const sampled = _sample(raw, 800);
    const activeP = window.Filters ? window.Filters.getActivePollutants() : PARAMS;
    const fields  = [...activeP,'aqi'];

    const aqiVals = sampled.map(d=>d.aqi||0);
    const maxAQI  = Math.max(...aqiVals, 200);

    const dimensions = fields.map(f=>{
      const vals  = sampled.map(d=>+(d[f]||0).toFixed(2));
      const mn    = Math.min(...vals), mx = Math.max(...vals,1);
      return {
        label: PLABELS[f]+(PUNITS[f]?`\n(${PUNITS[f]})`:''),
        values: vals,
        range: [mn, mx * 1.02],
        tickformat: '.1f',
      };
    });

    Plotly.react(el, [{
      type:'parcoords',
      line:{
        color: aqiVals,
        colorscale:[
          [0,'#22c55e'],[0.2,'#eab308'],[0.4,'#f97316'],
          [0.6,'#ef4444'],[0.8,'#8b5cf6'],[1,'#991b1b'],
        ],
        cmin:0, cmax:maxAQI, showscale:true,
        colorbar:{
          title:{text:'AQI',font:{color:'rgba(255,255,255,.5)',size:10}},
          tickfont:{color:'rgba(255,255,255,.4)',size:9},
          thickness:12, len:0.75,
        },
      },
      dimensions,
      labelangle: -22,
      labelfont: {color:'rgba(255,255,255,.55)',size:10},
      tickfont:  {color:'rgba(255,255,255,.35)',size:8},
      rangefont: {color:'rgba(255,255,255,.25)',size:8},
    }], {
      ...PL,
      margin:{t:70,r:90,b:20,l:60},
    }, PC);
  }

  // ── 4. 3D Surface (hour × weekday × mean AQI) ─────────────────────────────
  function _surface3d() {
    const el = document.getElementById('an-3d');
    if (!el || typeof Plotly==='undefined') return;
    const data = _data();
    if (data.length < 50) { el.innerHTML='<div class="an-empty">Insufficient data for 3D surface</div>'; return; }

    const grid = _gridHourWeekday(data);
    const z    = grid.map(dayArr=>dayArr.map(hrs=>{ const m=_mean(hrs); return m!=null?+m.toFixed(1):0; }));

    const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const hours = Array.from({length:24},(_,h)=>`${h===0?12:h>12?h-12:h}${h<12?'a':'p'}`);
    const zMax  = Math.max(...z.flat().filter(v=>v>0), 200);

    Plotly.react(el, [{
      type:'surface', z, x:hours, y:days,
      colorscale:[
        [0,'#22c55e'],[0.25,'#86efac'],[0.4,'#eab308'],
        [0.55,'#f97316'],[0.7,'#ef4444'],[0.85,'#8b5cf6'],[1,'#991b1b'],
      ],
      cmin:0, cmax:zMax,
      contours:{
        z:{show:true,usecolormap:true,highlightcolor:'rgba(255,255,255,.8)',
           project:{z:true},width:1,color:'rgba(255,255,255,.15)'},
      },
      lighting:{ambient:0.8,diffuse:0.9,roughness:0.5,specular:0.3,fresnel:0.2},
      colorbar:{
        title:{text:'AQI',font:{color:'rgba(255,255,255,.5)',size:10}},
        tickfont:{color:'rgba(255,255,255,.4)',size:9},
        thickness:12, len:0.75,
      },
      hovertemplate:'%{y} %{x}<br>Avg AQI: <b>%{z:.0f}</b><extra></extra>',
    }], {
      ...PL,
      margin:{t:28,r:20,b:24,l:20},
      scene:{
        xaxis:{title:{text:'Hour of Day',font:{color:'rgba(255,255,255,.4)',size:10}},
               gridcolor:'rgba(255,255,255,.06)',zerolinecolor:'rgba(0,0,0,0)',
               linecolor:'rgba(255,255,255,.1)',tickfont:{color:'rgba(255,255,255,.35)',size:8},
               backgroundcolor:'rgba(0,0,0,0)'},
        yaxis:{title:{text:'Day of Week',font:{color:'rgba(255,255,255,.4)',size:10}},
               gridcolor:'rgba(255,255,255,.06)',zerolinecolor:'rgba(0,0,0,0)',
               linecolor:'rgba(255,255,255,.1)',tickfont:{color:'rgba(255,255,255,.35)',size:9},
               backgroundcolor:'rgba(0,0,0,0)'},
        zaxis:{title:{text:'Mean AQI',font:{color:'rgba(255,255,255,.4)',size:10}},
               gridcolor:'rgba(255,255,255,.06)',zerolinecolor:'rgba(0,0,0,0)',
               linecolor:'rgba(255,255,255,.1)',tickfont:{color:'rgba(255,255,255,.35)',size:9},
               backgroundcolor:'rgba(0,0,0,0)'},
        bgcolor:'rgba(0,0,0,0)',
        camera:{eye:{x:1.6,y:-1.6,z:1.1}},
        aspectmode:'cube',
      },
    }, {...PC, modeBarButtonsToRemove:['select2d','lasso2d']});
  }

  // ════════════════════════════════════════════════════════════════════════════
  // D3 CHARTS
  // ════════════════════════════════════════════════════════════════════════════

  function _d3tip(container) {
    return d3.select(container).append('div')
      .attr('class','an-tooltip')
      .style('position','absolute').style('pointer-events','none')
      .style('opacity',0).style('transition','opacity .12s');
  }
  function _tipOn(tip, html, event, container) {
    const r = container.getBoundingClientRect();
    tip.style('opacity',1).html(html)
       .style('left',(event.clientX-r.left+14)+'px')
       .style('top', (event.clientY-r.top -36)+'px');
  }
  function _tipOff(tip) { tip.style('opacity',0); }

  // ── 5. India Bubble Geo Map ───────────────────────────────────────────────
  function _geoMap() {
    const container = document.getElementById('an-geomap');
    if (!container || typeof d3==='undefined') return;
    container.innerHTML='';
    container.style.position='relative';

    const W = container.clientWidth || 480;
    const H = +container.style.height.replace('px','') || 520;

    const svg = d3.select(container).append('svg')
      .attr('width',W).attr('height',H).style('overflow','visible');

    // Projection fitted to India
    const proj = d3.geoMercator().fitExtent([[20,20],[W-20,H-20]], INDIA_FEATURE);
    const path = d3.geoPath().projection(proj);

    // Graticule
    svg.append('path')
      .datum(d3.geoGraticule().step([5,5])())
      .attr('d',path)
      .attr('fill','none')
      .attr('stroke','rgba(255,255,255,.04)')
      .attr('stroke-width',0.5);

    // India outline
    svg.append('path')
      .datum(INDIA_FEATURE)
      .attr('d',path)
      .attr('fill','rgba(30,41,59,.75)')
      .attr('stroke','rgba(148,163,184,.35)')
      .attr('stroke-width',1.5)
      .attr('stroke-linejoin','round');

    // Glow filter
    const defs = svg.append('defs');
    const flt  = defs.append('filter').attr('id','bubble-glow').attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
    flt.append('feGaussianBlur').attr('in','SourceGraphic').attr('stdDeviation','5').attr('result','blur');
    const feMerge = flt.append('feMerge');
    feMerge.append('feMergeNode').attr('in','blur');
    feMerge.append('feMergeNode').attr('in','SourceGraphic');

    const reg = _regional();
    const cityData = Object.entries(CITY_COORDS).map(([id,c])=>{
      const aqi  = reg[id]?.aqi  ?? null;
      const pm25 = reg[id]?.pm25 ?? null;
      const [px,py] = proj([c.lng, c.lat]);
      return {id, label:c.label, aqi, pm25, px, py};
    });

    const maxAQI = Math.max(...cityData.map(c=>c.aqi||0),300);
    const rScale = d3.scaleSqrt().domain([0,maxAQI]).range([7,34]);

    const tip = _d3tip(container);

    const cg = svg.append('g').selectAll('g')
      .data(cityData).join('g')
      .attr('transform',d=>`translate(${d.px},${d.py})`)
      .style('cursor','pointer');

    // Pulse ring
    cg.append('circle')
      .attr('r',d=>d.aqi?rScale(d.aqi)+8:0)
      .attr('fill','none')
      .attr('stroke',d=>_aqiColor(d.aqi))
      .attr('stroke-width',1)
      .attr('opacity',.3);

    // Main bubble
    cg.append('circle')
      .attr('r',d=>d.aqi?rScale(d.aqi):9)
      .attr('fill',d=>_aqiColor(d.aqi)+'bb')
      .attr('stroke',d=>_aqiColor(d.aqi))
      .attr('stroke-width',1.5)
      .attr('filter','url(#bubble-glow)')
      .attr('class','an-geo-bubble');

    // AQI value inside bubble
    cg.append('text')
      .text(d=>d.aqi!=null?Math.round(d.aqi):'?')
      .attr('text-anchor','middle').attr('dy','0.35em')
      .attr('fill','#fff').attr('font-weight','900')
      .attr('font-size',d=>d.aqi&&rScale(d.aqi)>16?'11px':'8.5px')
      .attr('font-family','Inter,sans-serif')
      .attr('pointer-events','none');

    // City label
    cg.append('text')
      .text(d=>d.label)
      .attr('text-anchor','middle')
      .attr('dy',d=>d.aqi?(rScale(d.aqi)+16)+'px':'22px')
      .attr('fill','rgba(255,255,255,.7)').attr('font-size','9.5px')
      .attr('font-weight','700').attr('font-family','Inter,sans-serif')
      .attr('pointer-events','none');

    cg.on('mouseover',(event,d)=>{
        d3.select(event.currentTarget).select('.an-geo-bubble').attr('opacity',.75);
        _tipOn(tip,`<strong>${d.label}</strong><br>AQI: ${d.aqi!=null?Math.round(d.aqi):'—'} (${d.aqi!=null?AQI_CATS.find(c=>d.aqi>=c.lo&&d.aqi<=c.hi)?.label||'Hazardous':'—'})<br>PM2.5: ${d.pm25!=null?d.pm25.toFixed(1):' —'} μg/m³`,event,container);
      })
      .on('mousemove',(event,d)=>{
        const r=container.getBoundingClientRect();
        tip.style('left',(event.clientX-r.left+14)+'px').style('top',(event.clientY-r.top-40)+'px');
      })
      .on('mouseout', (event)=>{
        d3.select(event.currentTarget).select('.an-geo-bubble').attr('opacity',1);
        _tipOff(tip);
      });

    // AQI legend
    const lg = svg.append('g').attr('transform',`translate(12,${H-130})`);
    lg.append('rect').attr('width',130).attr('height',118).attr('rx',6)
      .attr('fill','rgba(15,23,42,.82)').attr('stroke','rgba(255,255,255,.1)');
    lg.append('text').text('AQI SCALE').attr('x',9).attr('y',15)
      .attr('fill','rgba(255,255,255,.4)').attr('font-size','8.5px').attr('font-weight','800')
      .attr('letter-spacing','0.1em').attr('font-family','Inter,sans-serif');
    AQI_CATS.forEach((c,i)=>{
      lg.append('circle').attr('cx',18).attr('cy',28+i*15).attr('r',5)
        .attr('fill',c.color+'bb').attr('stroke',c.color).attr('stroke-width',1);
      lg.append('text').text(c.label).attr('x',30).attr('y',32+i*15)
        .attr('fill','rgba(255,255,255,.55)').attr('font-size','9px').attr('font-family','Inter,sans-serif');
    });
  }

  function _geoSidebar() {
    const el = document.getElementById('an-geo-sidebar');
    if (!el) return;
    const reg = _regional();
    const cities = Object.entries(CITY_COORDS)
      .map(([id,c])=>({id,label:c.label,aqi:reg[id]?.aqi}))
      .filter(c=>c.aqi!=null).sort((a,b)=>b.aqi-a.aqi);

    if(!cities.length) { el.innerHTML='<p class="an-empty">No cross-city data</p>'; return; }
    const maxAQI = cities[0].aqi || 300;

    el.innerHTML=`
      <div class="an-ranking-hdr">Current AQI Ranking</div>
      ${cities.map((c,i)=>`
        <div class="an-rank-row">
          <span class="an-rank-num" style="color:${_aqiColor(c.aqi)}">${i+1}</span>
          <div class="an-rank-body">
            <div class="an-rank-label">${c.label}</div>
            <div class="an-rank-bar-bg">
              <div class="an-rank-bar" style="width:${Math.min(c.aqi/maxAQI*100,100).toFixed(1)}%;background:${_aqiColor(c.aqi)}"></div>
            </div>
          </div>
          <span class="an-rank-val" style="color:${_aqiColor(c.aqi)}">${Math.round(c.aqi)}</span>
        </div>`).join('')}
    `;
  }

  // ── 6. 24-Hour Radial AQI Clock ───────────────────────────────────────────
  function _radialClock() {
    const container = document.getElementById('an-radial');
    if (!container || typeof d3==='undefined') return;
    container.innerHTML=''; container.style.position='relative';

    const W = container.clientWidth || 500;
    const H = +container.style.height.replace('px','') || 340;
    const cx=W/2, cy=H/2+10;
    const outerR = Math.min(cx, cy-20)-20;
    const innerR = outerR*0.22;

    const svg = d3.select(container).append('svg').attr('width',W).attr('height',H);
    const data = _data();
    const byHour = _groupByHour(data);
    const hourData = byHour.map((hrs,h)=>({
      h,
      aqi:  _mean(hrs.map(d=>d.aqi)),
      pm25: _mean(hrs.map(d=>d.pm25)),
      n:    hrs.length,
    }));

    const maxAQI = Math.max(...hourData.map(h=>h.aqi||0),200);
    const rScale = d3.scaleLinear().domain([0,maxAQI]).range([innerR,outerR]);
    const arc    = d3.arc();

    // Reference rings
    [100,200,300].forEach(v=>{
      const r=rScale(Math.min(v,maxAQI));
      svg.append('circle').attr('cx',cx).attr('cy',cy).attr('r',r)
        .attr('fill','none').attr('stroke','rgba(255,255,255,.06)').attr('stroke-dasharray','3,5');
      if(r<outerR) svg.append('text').text(v)
        .attr('x',cx+r+3).attr('y',cy+4)
        .attr('fill','rgba(255,255,255,.18)').attr('font-size','7.5px').attr('font-family','Inter,sans-serif');
    });

    const tip = _d3tip(container);

    hourData.forEach((h,i)=>{
      if(h.aqi==null) return;
      const frac=0.88;
      const startA = (i/24)*2*Math.PI;
      const endA   = ((i+frac)/24)*2*Math.PI;
      const r = rScale(h.aqi);
      const color=_aqiColor(h.aqi);
      const lbl = i===0?'12a':i===12?'12p':i>12?`${i-12}p`:`${i}a`;

      svg.append('path')
        .datum(h)
        .attr('d', arc({innerRadius:innerR, outerRadius:r, startAngle:startA, endAngle:endA}))
        .attr('transform',`translate(${cx},${cy})`)
        .attr('fill',color+'cc').attr('stroke',color).attr('stroke-width',.5)
        .style('cursor','pointer')
        .on('mouseover',(event,d)=>{
          _tipOn(tip,`<strong>${lbl}</strong><br>Mean AQI: <b>${Math.round(d.aqi)}</b><br>PM2.5: ${d.pm25!=null?d.pm25.toFixed(1):' —'} μg/m³<br>Samples: ${d.n}`,event,container);
          d3.select(event.currentTarget).attr('opacity',.6);
        })
        .on('mousemove',(event)=>{
          const r2=container.getBoundingClientRect();
          tip.style('left',(event.clientX-r2.left+12)+'px').style('top',(event.clientY-r2.top-36)+'px');
        })
        .on('mouseout',(event)=>{ _tipOff(tip); d3.select(event.currentTarget).attr('opacity',1); });
    });

    // Cardinal hour labels
    [0,3,6,9,12,15,18,21].forEach(i=>{
      const a  = (i/24)*2*Math.PI - Math.PI/2;
      const lr = outerR+22;
      const lbl= i===0?'12a':i===12?'12p':i>12?`${i-12}p`:`${i}a`;
      svg.append('text').text(lbl)
        .attr('x',cx+Math.cos(a)*lr).attr('y',cy+Math.sin(a)*lr+4)
        .attr('text-anchor','middle').attr('fill','rgba(255,255,255,.38)')
        .attr('font-size','9.5px').attr('font-family','Inter,sans-serif');
    });

    // Inner label
    const avg=_mean(hourData.map(h=>h.aqi));
    svg.append('text').text('AQI')
      .attr('x',cx).attr('y',cy-12).attr('text-anchor','middle')
      .attr('fill','rgba(255,255,255,.25)').attr('font-size','9px').attr('font-family','Inter,sans-serif');
    svg.append('text').text(avg?Math.round(avg):'—')
      .attr('x',cx).attr('y',cy+12).attr('text-anchor','middle')
      .attr('fill',avg?_aqiColor(avg):'rgba(255,255,255,.4)')
      .attr('font-size','22px').attr('font-weight','900').attr('font-family','Inter,sans-serif');
    svg.append('text').text('24h avg')
      .attr('x',cx).attr('y',cy+26).attr('text-anchor','middle')
      .attr('fill','rgba(255,255,255,.2)').attr('font-size','8px').attr('font-family','Inter,sans-serif');
  }

  // ── 7. Correlation Matrix (D3 diverging heat-map) ─────────────────────────
  function _corrMatrix() {
    const container = document.getElementById('an-corr-matrix');
    if (!container || typeof d3==='undefined') return;
    container.innerHTML=''; container.style.position='relative';

    const data = _data();
    if (data.length < 10) { container.innerHTML='<div class="an-empty">Need more data for correlation</div>'; return; }

    const fields = [...PARAMS,'aqi'];
    const n      = fields.length;
    const corr   = fields.map(a=>fields.map(b=>a===b?1:_pearson(data.map(d=>d[a]),data.map(d=>d[b]))));

    const W=container.clientWidth||360, H=+container.style.height.replace('px','')||380;
    const pad={t:44,r:30,b:10,l:58};
    const side=Math.min((W-pad.l-pad.r)/n,(H-pad.t-pad.b)/n);

    const svg=d3.select(container).append('svg').attr('width',W).attr('height',H);
    const g  =svg.append('g').attr('transform',`translate(${pad.l},${pad.t})`);

    const color=d3.scaleDiverging().domain([-1,0,1]).interpolator(d3.interpolateRdBu);

    // Gradient colorbar using linearGradient
    const defs=svg.append('defs');
    const grad=defs.append('linearGradient').attr('id','corr-grad').attr('x1','0%').attr('x2','0%').attr('y1','100%').attr('y2','0%');
    d3.range(0,1.01,0.1).forEach(t=>grad.append('stop').attr('offset',`${t*100}%`).attr('stop-color',color(t*2-1)));

    const cbX=pad.l+side*n+6, cbH=side*n;
    svg.append('rect').attr('x',cbX).attr('y',pad.t).attr('width',10).attr('height',cbH).attr('fill','url(#corr-grad)').attr('rx',2);
    ['+1','0','-1'].forEach((lbl,i)=>{
      svg.append('text').text(lbl).attr('x',cbX+14).attr('y',pad.t+[0,cbH/2,cbH][i]+4)
        .attr('fill','rgba(255,255,255,.35)').attr('font-size','8px').attr('font-family','Inter,sans-serif');
    });

    const tip=_d3tip(container);

    corr.forEach((row,i)=>row.forEach((r,j)=>{
      const cg=g.append('g').attr('transform',`translate(${j*side},${i*side})`).style('cursor','default');
      cg.append('rect').attr('width',side-1.5).attr('height',side-1.5).attr('rx',2)
        .attr('fill',color(r)).attr('opacity',.9);
      if(side>24){
        cg.append('text').text(r===1?'1':r.toFixed(2))
          .attr('x',(side-1.5)/2).attr('y',(side-1.5)/2+3.5)
          .attr('text-anchor','middle')
          .attr('fill',Math.abs(r)>.55?'rgba(255,255,255,.9)':'rgba(0,0,0,.8)')
          .attr('font-size','8.5px').attr('font-weight','700').attr('font-family','Inter,sans-serif');
      }
      cg.on('mouseover',event=>{
          const strength=Math.abs(r)>.7?'Strong':Math.abs(r)>.4?'Moderate':'Weak';
          const dir=r>0?'positive':'negative';
          _tipOn(tip,`<strong>${PLABELS[fields[i]]} × ${PLABELS[fields[j]]}</strong><br>r = ${r.toFixed(3)}<br>${strength} ${dir} correlation`,event,container);
        })
        .on('mousemove',event=>{
          const rc=container.getBoundingClientRect();
          tip.style('left',(event.clientX-rc.left+12)+'px').style('top',(event.clientY-rc.top-44)+'px');
        })
        .on('mouseout',()=>_tipOff(tip));
    }));

    // Axis labels
    fields.forEach((f,i)=>{
      g.append('text').text(PLABELS[f]).attr('x',i*side+side/2).attr('y',-7)
        .attr('text-anchor','middle').attr('fill','rgba(255,255,255,.45)')
        .attr('font-size','9px').attr('font-weight','700').attr('font-family','Inter,sans-serif');
      g.append('text').text(PLABELS[f]).attr('x',-6).attr('y',i*side+side/2+4)
        .attr('text-anchor','end').attr('fill','rgba(255,255,255,.45)')
        .attr('font-size','9px').attr('font-weight','700').attr('font-family','Inter,sans-serif');
    });
  }

  // ── 8. Force-Directed Correlation Network ─────────────────────────────────
  function _forceNet() {
    const container=document.getElementById('an-force-network');
    if (!container || typeof d3==='undefined') return;
    if (_sim) { _sim.stop(); _sim=null; }
    container.innerHTML=''; container.style.position='relative';

    const data=_data();
    if (data.length<10) { container.innerHTML='<div class="an-empty">Insufficient data for network</div>'; return; }

    const fields=[...PARAMS,'aqi'];
    const W=container.clientWidth||360, H=+container.style.height.replace('px','')||380;
    const NR=20;

    const links=[];
    for(let i=0;i<fields.length;i++) for(let j=i+1;j<fields.length;j++){
      const r=_pearson(data.map(d=>d[fields[i]]),data.map(d=>d[fields[j]]));
      if(Math.abs(r)>=0.2) links.push({source:fields[i],target:fields[j],r,abs:Math.abs(r)});
    }

    const means={};
    fields.forEach(f=>{means[f]=_mean(data.map(d=>d[f]).filter(v=>v!=null))||0;});

    const nodes=fields.map(f=>({id:f,label:PLABELS[f],mean:means[f],color:PCOLORS[f]||'#64748b'}));

    const svg=d3.select(container).append('svg').attr('width',W).attr('height',H);

    // Defs: arrow markers
    const defs=svg.append('defs');
    ['pos','neg'].forEach(t=>{
      defs.append('marker').attr('id',`net-arr-${t}`).attr('viewBox','0 0 6 6')
        .attr('refX',NR+6).attr('refY',3).attr('markerWidth',5).attr('markerHeight',5)
        .attr('orient','auto')
        .append('path').attr('d','M0,0L6,3L0,6z')
        .attr('fill',t==='pos'?'rgba(34,197,94,.6)':'rgba(239,68,68,.6)');
    });

    const linkG=svg.append('g');
    const nodeG=svg.append('g');

    const linkEls=linkG.selectAll('line').data(links).join('line')
      .attr('stroke',d=>d.r>=0?'rgba(34,197,94,.55)':'rgba(239,68,68,.55)')
      .attr('stroke-width',d=>d.abs*5+0.5)
      .attr('stroke-opacity',.8)
      .attr('marker-end',d=>`url(#net-arr-${d.r>=0?'pos':'neg'})`);

    const nodeEls=nodeG.selectAll('g').data(nodes).join('g').style('cursor','grab');

    nodeEls.append('circle').attr('r',NR)
      .attr('fill',d=>d.color+'2a').attr('stroke',d=>d.color).attr('stroke-width',2);

    nodeEls.append('text').text(d=>d.label)
      .attr('text-anchor','middle').attr('dy','0.35em')
      .attr('fill','rgba(255,255,255,.85)').attr('font-size','9.5px')
      .attr('font-weight','800').attr('font-family','Inter,sans-serif');

    const tip=_d3tip(container);

    nodeEls
      .on('mouseover',(event,d)=>{
        const connCount=links.filter(l=>l.source.id===d.id||l.target.id===d.id).length;
        _tipOn(tip,`<strong>${d.label}</strong><br>Mean: ${d.mean.toFixed(2)}<br>Connections: ${connCount}`,event,container);
        d3.select(event.currentTarget).select('circle').attr('stroke-width',3.5);
      })
      .on('mousemove',event=>{
        const rc=container.getBoundingClientRect();
        tip.style('left',(event.clientX-rc.left+12)+'px').style('top',(event.clientY-rc.top-40)+'px');
      })
      .on('mouseout',event=>{ _tipOff(tip); d3.select(event.currentTarget).select('circle').attr('stroke-width',2); });

    // Legend
    const lgG=svg.append('g').attr('transform',`translate(10,${H-50})`);
    lgG.append('rect').attr('width',148).attr('height',42).attr('rx',4)
      .attr('fill','rgba(15,23,42,.82)').attr('stroke','rgba(255,255,255,.1)');
    lgG.append('line').attr('x1',10).attr('y1',14).attr('x2',30).attr('y2',14).attr('stroke','rgba(34,197,94,.7)').attr('stroke-width',3);
    lgG.append('text').text('Positive correlation').attr('x',35).attr('y',18).attr('fill','rgba(255,255,255,.45)').attr('font-size','9px').attr('font-family','Inter,sans-serif');
    lgG.append('line').attr('x1',10).attr('y1',30).attr('x2',30).attr('y2',30).attr('stroke','rgba(239,68,68,.7)').attr('stroke-width',3);
    lgG.append('text').text('Negative correlation').attr('x',35).attr('y',34).attr('fill','rgba(255,255,255,.45)').attr('font-size','9px').attr('font-family','Inter,sans-serif');

    _sim=d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d=>d.id).distance(95).strength(d=>d.abs*0.8))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(W/2,H/2))
      .force('collide', d3.forceCollide(NR+10))
      .on('tick',()=>{
        const clamp=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));
        linkEls
          .attr('x1',d=>clamp(d.source.x,NR,W-NR))
          .attr('y1',d=>clamp(d.source.y,NR,H-NR))
          .attr('x2',d=>clamp(d.target.x,NR,W-NR))
          .attr('y2',d=>clamp(d.target.y,NR,H-NR));
        nodeEls.attr('transform',d=>`translate(${clamp(d.x,NR,W-NR)},${clamp(d.y,NR,H-NR)})`);
      });

    nodeEls.call(d3.drag()
      .on('start',(event,d)=>{ if(!event.active) _sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag', (event,d)=>{ d.fx=event.x; d.fy=event.y; })
      .on('end',  (event,d)=>{ if(!event.active) _sim.alphaTarget(0); d.fx=null; d.fy=null; })
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function _clearCache() { Object.keys(_rendered).forEach(k => delete _rendered[k]); }

  return { init, _clearCache };
})();

window.Analytics = Analytics;

/**
 * IoT Sensor Network Simulator
 *
 * Models a city-wide network of low-cost air quality sensors with:
 *   - Multiple sensor nodes per city (zoned: traffic, industrial, residential, ambient)
 *   - Per-sensor calibration bias, Gaussian noise, and temporal drift
 *   - Sensor health metadata (battery, signal, last calibration)
 *   - Temperature & humidity co-sensors (affects PM optical readings)
 *   - Data quality flags: VALID, SUSPECT, MISSING, OUTLIER
 *   - Realistic multi-pollutant correlation matrix
 */

// ── Sensor Model Specifications ────────────────────────────
const SENSOR_MODELS = {
  'Plantower PMS7003': { type:'optical',    pm25_noise:3.5,  pm10_noise:5.0,  drift_rate:0.08, cost:'low'  },
  'Honeywell HPMA115': { type:'optical',    pm25_noise:4.0,  pm10_noise:6.0,  drift_rate:0.10, cost:'low'  },
  'Alphasense OPC-N3': { type:'optical',    pm25_noise:2.0,  pm10_noise:3.5,  drift_rate:0.05, cost:'mid'  },
  'Teledyne API T200': { type:'chemilum',   no2_noise:1.0,   so2_noise:0.8,   drift_rate:0.02, cost:'high' },
  'TE Connectivity HTU31': { type:'ht',     temp_noise:0.2,  hum_noise:1.5,   drift_rate:0.01, cost:'low'  },
  'Bosch BME680':      { type:'ht+voc',    temp_noise:0.3,  hum_noise:2.0,   drift_rate:0.03, cost:'low'  },
  'Alphasense CO-B4':  { type:'ec',         co_noise:0.05,                    drift_rate:0.04, cost:'mid'  },
  'Alphasense NO2-B43F':{ type:'ec',        no2_noise:1.5,                    drift_rate:0.04, cost:'mid'  },
  'Alphasense O3-B4':  { type:'ec',         o3_noise:2.0,                     drift_rate:0.05, cost:'mid'  },
};

// ── Sensor Node Definitions (per city) ────────────────────
const IOT_NETWORK = {
  delhi: [
    { id:'DL-IOT-01', name:'Connaught Place',      zone:'Commercial',   lat:28.6315, lng:77.2167, sensors:['Plantower PMS7003','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'DL-IOT-02', name:'NH-48 Traffic Node',   zone:'Traffic',      lat:28.5665, lng:77.1012, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'DL-IOT-03', name:'Wazirpur Industrial',  zone:'Industrial',   lat:28.7004, lng:77.1680, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'DL-IOT-04', name:'Lodhi Garden',         zone:'Ambient',      lat:28.5930, lng:77.2200, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
    { id:'DL-IOT-05', name:'Shahdara Residential', zone:'Residential',  lat:28.6745, lng:77.2935, sensors:['Honeywell HPMA115','Alphasense CO-B4','Bosch BME680'] },
  ],
  mumbai: [
    { id:'MH-IOT-01', name:'Dharavi Industrial',   zone:'Industrial',   lat:19.0437, lng:72.8553, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'MH-IOT-02', name:'Western Expressway',   zone:'Traffic',      lat:19.1136, lng:72.8697, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'MH-IOT-03', name:'Goregaon Residential', zone:'Residential',  lat:19.1663, lng:72.8526, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'MH-IOT-04', name:'Marine Drive Ambient', zone:'Ambient',      lat:18.9440, lng:72.8233, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  bangalore: [
    { id:'KA-IOT-01', name:'Peenya Industrial',    zone:'Industrial',   lat:13.0290, lng:77.5184, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'KA-IOT-02', name:'Outer Ring Road',      zone:'Traffic',      lat:12.9344, lng:77.6854, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'KA-IOT-03', name:'Koramangala Res.',     zone:'Residential',  lat:12.9352, lng:77.6245, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'KA-IOT-04', name:'Cubbon Park Ambient',  zone:'Ambient',      lat:12.9763, lng:77.5929, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  kolkata: [
    { id:'WB-IOT-01', name:'Howrah Industrial',    zone:'Industrial',   lat:22.5958, lng:88.2636, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'WB-IOT-02', name:'EM Bypass Traffic',    zone:'Traffic',      lat:22.5145, lng:88.4025, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'WB-IOT-03', name:'Salt Lake Residential',zone:'Residential',  lat:22.5766, lng:88.4189, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'WB-IOT-04', name:'Botanical Garden',     zone:'Ambient',      lat:22.5085, lng:88.2765, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  chennai: [
    { id:'TN-IOT-01', name:'SIDCO Industrial',     zone:'Industrial',   lat:13.0600, lng:80.2170, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'TN-IOT-02', name:'Anna Salai Traffic',   zone:'Traffic',      lat:13.0646, lng:80.2520, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'TN-IOT-03', name:'Adyar Residential',    zone:'Residential',  lat:13.0012, lng:80.2565, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'TN-IOT-04', name:'Elliot Beach Ambient', zone:'Ambient',      lat:12.9990, lng:80.2707, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  hyderabad: [
    { id:'TS-IOT-01', name:'JNTU Industrial',      zone:'Industrial',   lat:17.4934, lng:78.3882, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'TS-IOT-02', name:'Outer Ring Road HYD',  zone:'Traffic',      lat:17.4065, lng:78.5592, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'TS-IOT-03', name:'Banjara Hills Res.',   zone:'Residential',  lat:17.4126, lng:78.4480, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'TS-IOT-04', name:'KBR Park Ambient',     zone:'Ambient',      lat:17.4239, lng:78.4737, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  pune: [
    { id:'PN-IOT-01', name:'Bhosari Industrial',   zone:'Industrial',   lat:18.6298, lng:73.8474, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'PN-IOT-02', name:'Swargate Traffic',     zone:'Traffic',      lat:18.5018, lng:73.8585, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'PN-IOT-03', name:'Kothrud Residential',  zone:'Residential',  lat:18.5074, lng:73.8077, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'PN-IOT-04', name:'Pashan Ambient',       zone:'Ambient',      lat:18.5380, lng:73.7898, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  jaipur: [
    { id:'JP-IOT-01', name:'Vishwakarma Indl.',    zone:'Industrial',   lat:26.9962, lng:75.7670, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'JP-IOT-02', name:'Tonk Road Traffic',    zone:'Traffic',      lat:26.8505, lng:75.8010, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'JP-IOT-03', name:'Malviya Nagar Res.',   zone:'Residential',  lat:26.8535, lng:75.8113, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'JP-IOT-04', name:'Central Park Ambient', zone:'Ambient',      lat:26.9050, lng:75.8060, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  lucknow: [
    { id:'LK-IOT-01', name:'Amausi Industrial',    zone:'Industrial',   lat:26.7606, lng:80.8893, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'LK-IOT-02', name:'Hazratganj Traffic',   zone:'Traffic',      lat:26.8487, lng:80.9462, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'LK-IOT-03', name:'Gomti Nagar Res.',     zone:'Residential',  lat:26.8540, lng:81.0000, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'LK-IOT-04', name:'Janeshwar Park Amb.',  zone:'Ambient',      lat:26.8470, lng:81.0150, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
  ahmedabad: [
    { id:'AH-IOT-01', name:'Naroda Industrial',    zone:'Industrial',   lat:23.0809, lng:72.6593, sensors:['Plantower PMS7003','Teledyne API T200','Bosch BME680'] },
    { id:'AH-IOT-02', name:'SG Highway Traffic',   zone:'Traffic',      lat:23.0300, lng:72.5100, sensors:['Alphasense OPC-N3','Alphasense CO-B4','TE Connectivity HTU31'] },
    { id:'AH-IOT-03', name:'Satellite Residential',zone:'Residential',  lat:23.0300, lng:72.5200, sensors:['Honeywell HPMA115','Alphasense NO2-B43F','Bosch BME680'] },
    { id:'AH-IOT-04', name:'Kankaria Ambient',     zone:'Ambient',      lat:22.9985, lng:72.6000, sensors:['Alphasense OPC-N3','Alphasense O3-B4','TE Connectivity HTU31'] },
  ],
};

// Zone-based offsets (additive bias on top of city baseline)
const ZONE_OFFSETS = {
  Industrial:  { pm25: 30, pm10: 55, no2: 18, so2: 12, co: 0.8,  o3: -10 },
  Traffic:     { pm25: 15, pm10: 28, no2: 25, so2:  5, co: 1.2,  o3: -8  },
  Commercial:  { pm25:  8, pm10: 15, no2: 12, so2:  3, co: 0.5,  o3: -4  },
  Residential: { pm25:  0, pm10:  0, no2:  0, so2:  0, co: 0.0,  o3:  0  },
  Ambient:     { pm25: -8, pm10:-12, no2: -8, so2: -4, co: -0.3, o3:  8  },
};

// ── Sensor State Store ─────────────────────────────────────
// Persists across calls within a session; keys = node id
const _sensorState = {};

function _getSensorState(nodeId, numSensors) {
  if (!_sensorState[nodeId]) {
    _sensorState[nodeId] = {
      battery:          75 + Math.random() * 25,
      signal:           60 + Math.random() * 40,
      failureProb:      0.01 + Math.random() * 0.03,
      calibrationDays:  Math.floor(Math.random() * 90),
      driftAccum:       (Math.random() - 0.5) * 5,
      installDaysAgo:   60 + Math.floor(Math.random() * 600),
      uptime:           95 + Math.random() * 5,
      sensorOffsets:    Array.from({ length: numSensors }, () => ({
        pm25:  (Math.random() - 0.5) * 8,
        pm10:  (Math.random() - 0.5) * 12,
        no2:   (Math.random() - 0.5) * 5,
        so2:   (Math.random() - 0.5) * 3,
        co:    (Math.random() - 0.5) * 0.3,
        o3:    (Math.random() - 0.5) * 5,
        temp:  (Math.random() - 0.5) * 1.5,
        hum:   (Math.random() - 0.5) * 4,
      })),
    };
  }
  return _sensorState[nodeId];
}

// ── Noise Generator (Box-Muller Gaussian) ─────────────────
function gaussianNoise(mean, std) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

// ── Humidity Correction for PM (hygroscopic growth) ───────
function humidityCorrection(pm, hum) {
  if (hum < 40) return pm;
  const kappa = 0.11;
  const aw    = (hum / 100) / (1 - hum / 100 + 1e-6);
  return pm * (1 + kappa * aw);
}

// ── Generate reading for a single sensor node ──────────────
function readSensorNode(nodeId, cityId, baseAQI, basePollutants, baseMet) {
  const node    = IOT_NETWORK[cityId].find(n => n.id === nodeId);
  if (!node) return null;

  const ss      = _getSensorState(nodeId, node.sensors.length);
  const zone    = node.zone;
  const offsets = ZONE_OFFSETS[zone] || ZONE_OFFSETS.Residential;

  // Drift correction factor (increases with calibration age)
  const driftFactor = 1 + ss.driftAccum * (ss.calibrationDays / 180) * 0.01;

  // Decide if node is online
  const isOnline = Math.random() > ss.failureProb;

  if (!isOnline) {
    return {
      nodeId, name: node.name, zone, lat: node.lat, lng: node.lng,
      status: 'OFFLINE',
      battery: Math.max(0, ss.battery - 0.5),
      signal: 0,
      timestamp: Date.now(),
      data: null,
    };
  }

  // Temperature & Humidity (from the HT sensor on the node)
  const temp = gaussianNoise(baseMet.temperature + ss.sensorOffsets[0]?.temp || 0, 0.4);
  const hum  = Math.max(5, Math.min(99,
    gaussianNoise(baseMet.humidity + ss.sensorOffsets[0]?.hum || 0, 2.0)
  ));

  // Generate raw pollutant readings per installed sensor
  const readings = {};

  // PM (optical sensors)
  const rawPM25 = basePollutants.pm25 + offsets.pm25 + ss.sensorOffsets[0]?.pm25 || 0;
  const rawPM10 = basePollutants.pm10 + offsets.pm10 + ss.sensorOffsets[0]?.pm10 || 0;
  readings.pm25 = Math.max(0, gaussianNoise(humidityCorrection(rawPM25, hum) * driftFactor, 3.5));
  readings.pm10 = Math.max(0, gaussianNoise(humidityCorrection(rawPM10, hum) * driftFactor, 5.5));

  // Gaseous pollutants
  readings.no2  = Math.max(0, gaussianNoise((basePollutants.no2 + offsets.no2)  * driftFactor + (ss.sensorOffsets[0]?.no2 || 0), 2.0));
  readings.so2  = Math.max(0, gaussianNoise((basePollutants.so2 + offsets.so2)  * driftFactor + (ss.sensorOffsets[0]?.so2 || 0), 1.2));
  readings.co   = Math.max(0, gaussianNoise((basePollutants.co  + offsets.co)   * driftFactor + (ss.sensorOffsets[0]?.co  || 0), 0.08));
  readings.o3   = Math.max(0, gaussianNoise((basePollutants.o3  + offsets.o3)   * driftFactor + (ss.sensorOffsets[0]?.o3  || 0), 2.5));
  readings.temperature = +temp.toFixed(1);
  readings.humidity    = +hum.toFixed(1);

  // Round
  ['pm25','pm10','no2','so2','o3'].forEach(k => { readings[k] = +readings[k].toFixed(1); });
  readings.co = +readings.co.toFixed(2);

  // Data quality flag
  let quality = 'VALID';
  if (readings.pm25 > 500 || readings.no2 > 400 || readings.so2 > 300) quality = 'OUTLIER';
  else if (ss.calibrationDays > 90) quality = 'SUSPECT';
  else if (hum > 90) quality = 'SUSPECT'; // high humidity degrades optical PM sensor

  // Update battery decay
  ss.battery = Math.max(5, ss.battery - 0.002);

  return {
    nodeId,
    name:     node.name,
    zone,
    lat:      node.lat,
    lng:      node.lng,
    sensors:  node.sensors,
    status:   quality === 'VALID' ? 'ONLINE' : quality === 'SUSPECT' ? 'DEGRADED' : 'ONLINE',
    quality,
    battery:  +ss.battery.toFixed(1),
    signal:   +ss.signal.toFixed(0),
    calibrationDays: ss.calibrationDays,
    installDaysAgo:  ss.installDaysAgo,
    uptime:   +ss.uptime.toFixed(1),
    timestamp: Date.now(),
    data: readings,
  };
}

// ── Aggregate sensor network for a city ───────────────────
function readCityNetwork(cityId, baseAQI, basePollutants, baseMet) {
  const nodes   = IOT_NETWORK[cityId] || [];
  const results = nodes.map(n =>
    readSensorNode(n.id, cityId, baseAQI, basePollutants, baseMet)
  );

  // Compute network aggregates (mean of VALID/DEGRADED readings)
  const valid = results.filter(r => r.data !== null);
  const agg   = {};
  if (valid.length > 0) {
    const params = ['pm25','pm10','no2','so2','co','o3','temperature','humidity'];
    params.forEach(p => {
      const vals = valid.map(r => r.data[p]).filter(v => v != null && !isNaN(v));
      if (vals.length > 0) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const min  = Math.min(...vals);
        const max  = Math.max(...vals);
        const std  = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
        agg[p] = { mean: +mean.toFixed(2), min: +min.toFixed(2), max: +max.toFixed(2), std: +std.toFixed(2), n: vals.length };
      }
    });
  }

  return {
    cityId,
    networkSize:   nodes.length,
    onlineCount:   valid.length,
    offlineCount:  results.length - valid.length,
    dataQuality:   valid.length === 0 ? 0 : +(valid.filter(r => r.quality === 'VALID').length / valid.length * 100).toFixed(0),
    aggregates:    agg,
    nodes:         results,
    timestamp:     Date.now(),
  };
}

// ── Metropolitan temperature/humidity baseline ─────────────
const METRO_MET = {
  delhi:     { monthlyTemp: [14.5,17.2,23.8,30.2,35.8,38.1,33.5,31.9,30.0,25.5,19.3,13.8],
               monthlyHum:  [70,  60,  43,  33,  29,  40,  74,  80,  70,  50,  50,  65 ] },
  mumbai:    { monthlyTemp: [24.2,24.8,27.2,30.1,32.5,30.8,29.0,28.5,29.2,30.0,28.5,25.5],
               monthlyHum:  [68,  68,  72,  75,  72,  82,  87,  86,  82,  78,  72,  68 ] },
  bangalore: { monthlyTemp: [20.5,22.8,26.5,29.8,30.5,25.8,22.5,22.0,23.2,23.8,21.5,19.2],
               monthlyHum:  [55,  48,  40,  30,  48,  68,  78,  74,  72,  68,  58,  58 ] },
  kolkata:   { monthlyTemp: [18.5,21.8,27.5,31.5,33.8,32.5,30.2,30.0,30.5,29.2,24.5,19.5],
               monthlyHum:  [65,  60,  52,  60,  68,  80,  86,  85,  80,  72,  62,  65 ] },
  chennai:   { monthlyTemp: [25.2,26.8,29.5,32.5,36.2,34.5,32.0,31.5,31.8,29.5,26.8,24.5],
               monthlyHum:  [72,  72,  65,  60,  55,  50,  55,  62,  72,  82,  80,  75 ] },
  hyderabad: { monthlyTemp: [21.5,24.2,28.8,33.5,37.0,32.5,27.8,27.0,27.5,27.8,23.5,20.5],
               monthlyHum:  [48,  40,  35,  28,  32,  50,  72,  74,  70,  58,  42,  45 ] },
  pune:      { monthlyTemp: [20.8,22.8,26.5,29.5,29.8,26.5,24.5,24.0,24.8,24.8,22.5,20.5],
               monthlyHum:  [58,  50,  42,  38,  46,  70,  82,  80,  74,  64,  58,  60 ] },
  jaipur:    { monthlyTemp: [15.2,18.5,24.2,30.5,34.2,33.8,30.5,28.8,28.5,26.0,20.8,16.2],
               monthlyHum:  [54,  46,  37,  28,  30,  44,  68,  72,  62,  46,  46,  52 ] },
  lucknow:   { monthlyTemp: [16.0,19.5,25.2,31.0,35.2,34.0,30.2,29.5,29.0,26.2,21.0,17.0],
               monthlyHum:  [72,  64,  52,  40,  42,  58,  78,  80,  76,  66,  64,  70 ] },
  ahmedabad: { monthlyTemp: [21.2,24.0,28.8,33.0,35.8,33.8,30.2,29.0,30.0,30.2,26.0,22.2],
               monthlyHum:  [50,  45,  40,  38,  46,  60,  78,  80,  72,  52,  46,  48 ] },
};

/** Get current met conditions for a city. */
function getMetConditions(cityId) {
  const met   = METRO_MET[cityId];
  const month = new Date().getMonth();
  const hour  = new Date().getHours();
  if (!met) return { temperature: 28, humidity: 60 };

  const baseTemp = met.monthlyTemp[month];
  const baseHum  = met.monthlyHum[month];

  // Diurnal temperature variation: ±5°C over 24 h
  const tempDiurnal = 5 * Math.sin(((hour - 14) / 24) * 2 * Math.PI);
  // Humidity inverse relationship with temperature
  const humDiurnal  = -10 * Math.sin(((hour - 14) / 24) * 2 * Math.PI);

  return {
    temperature: +(baseTemp + tempDiurnal + gaussianNoise(0, 0.5)).toFixed(1),
    humidity:    +Math.max(10, Math.min(99, baseHum + humDiurnal + gaussianNoise(0, 2))).toFixed(1),
  };
}

/** Convenience: read all cities' sensor networks at once. */
function readAllNetworks(allCitiesData) {
  return Object.fromEntries(
    Object.entries(allCitiesData).map(([cityId, d]) => {
      const met = getMetConditions(cityId);
      return [cityId, readCityNetwork(cityId, d.aqi, d, met)];
    })
  );
}

// Expose
window.IOT_NETWORK       = IOT_NETWORK;
window.SENSOR_MODELS     = SENSOR_MODELS;
window.METRO_MET         = METRO_MET;
window.readSensorNode    = readSensorNode;
window.readCityNetwork   = readCityNetwork;
window.readAllNetworks   = readAllNetworks;
window.getMetConditions  = getMetConditions;

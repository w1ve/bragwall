'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const REGIONS = [
  'E. North America',
  'C. North America',
  'W. North America',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
];
const REGION_KEYS = ['ENA', 'CNA', 'WNA', 'SA', 'EU', 'AF', 'AS', 'OC'];

const BANDS = [
  { label: '160m', min: 1800,  max: 2000  },
  { label: '80m',  min: 3500,  max: 4000  },
  { label: '40m',  min: 7000,  max: 7300  },
  { label: '30m',  min: 10100, max: 10150 },  // WARC
  { label: '20m',  min: 14000, max: 14350 },
  { label: '17m',  min: 18068, max: 18168 },  // WARC
  { label: '15m',  min: 21000, max: 21450 },
  { label: '12m',  min: 24890, max: 24990 },  // WARC
  { label: '10m',  min: 28000, max: 29700 },
  { label: '6m',   min: 50000, max: 54000 },
];

const MAX_SNR    = 50.0;
const EMA_ALPHA  = 0.08;
const POLL_MS    = 15000;
const SEG_COUNT  = 15;

const SSB_SNR_THRESHOLD = 20.0;  // min median SNR (dB) for SSB to be considered workable
const KNOWN_MODES = ['CW', 'RTTY', 'FT8', 'FT4'];

const PROXY_BASE = '';   // empty = same origin as the PWA
const REGION_INDEX_BY_KEY = REGION_KEYS.reduce((acc, key, idx) => {
  acc[key] = idx;
  return acc;
}, {});

const SEG_COLORS = {
  live: ['#00d250','#00d250','#00d250','#00d250','#00d250','#00d250','#00d250','#00d250','#00d250',
         '#e6c800','#e6c800','#e6c800','#ff8c00','#dc1e1e','#dc1e1e'],
  peak: ['#005a22','#005a22','#005a22','#005a22','#005a22','#005a22','#005a22','#005a22','#005a22',
         '#645500','#645500','#645500','#723c00','#641212','#641212'],
};

let pskByRegion = {};
let pskMeta = { age: null, cached: false, stale: false };

// ── Mode normalisation ────────────────────────────────────────────────────────
function normaliseMode(raw) {
  const u = (raw || '').toUpperCase();
  if (u === 'CW')   return 'CW';
  if (u === 'RTTY') return 'RTTY';
  if (u === 'FT8')  return 'FT8';
  if (u === 'FT4')  return 'FT4';
  if (u.startsWith('PSK')) return 'PSK';
  return u;
}

// ── Settings persistence ──────────────────────────────────────────────────────
const Settings = {
  KEY: 'rbn_smeter_settings',
  defaults: { mode: 'region', regionIndex: 0, grid: '', radiusIndex: 2, unit: 'auto', autoUpdate: false },
  load() {
    try { return { ...this.defaults, ...JSON.parse(localStorage.getItem(this.KEY) || '{}') }; }
    catch { return { ...this.defaults }; }
  },
  save(obj) {
    try { localStorage.setItem(this.KEY, JSON.stringify(obj)); } catch {}
  },
};

// ── Maidenhead grid → lat/lon ─────────────────────────────────────────────────
function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const f1 = g.charCodeAt(0) - 65;
  const f2 = g.charCodeAt(1) - 65;
  const s1 = parseInt(g[2]);
  const s2 = parseInt(g[3]);
  if (f1 < 0 || f1 > 17 || f2 < 0 || f2 > 17 || isNaN(s1) || isNaN(s2)) return null;
  let lon = f1 * 20 - 180 + s1 * 2 + 1;
  let lat = f2 * 10 - 90  + s2     + 0.5;
  if (g.length >= 6) {
    const ss1 = g.charCodeAt(4) - 65;
    const ss2 = g.charCodeAt(5) - 65;
    if (ss1 >= 0 && ss1 < 24 && ss2 >= 0 && ss2 < 24) {
      lon = f1 * 20 - 180 + s1 * 2 + ss1 * (2/24) + 1/24;
      lat = f2 * 10 - 90  + s2     + ss2 * (1/24) + 0.5/24;
    }
  }
  return { lat, lon };
}

function isValidGrid(g) { return !!gridToLatLon(g); }

function latLonToGrid(lat, lon) {
  lon += 180; lat += 90;
  const f1 = Math.floor(lon / 20);
  const f2 = Math.floor(lat / 10);
  const s1 = Math.floor((lon % 20) / 2);
  const s2 = Math.floor(lat % 10);
  if (f1 < 0 || f1 > 17 || f2 < 0 || f2 > 17) return '';
  return String.fromCharCode(65+f1, 65+f2) + s1 + s2;
}

// ── Haversine distance (miles) ────────────────────────────────────────────────
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── S-unit label ──────────────────────────────────────────────────────────────
function snrToSUnit(snr) {
  if (snr <  1) return 'S0';
  if (snr <  5) return 'S1';
  if (snr <  9) return 'S2';
  if (snr < 13) return 'S3';
  if (snr < 17) return 'S4';
  if (snr < 21) return 'S5';
  if (snr < 25) return 'S6';
  if (snr < 31) return 'S7';
  if (snr < 37) return 'S8';
  if (snr < 43) return 'S9';
  if (snr < 53) return 'S9+10';
  if (snr < 63) return 'S9+20';
  return 'S9+30';
}

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function qualityColorForSnr(snr) {
  if (snr == null) return null;
  const frac = Math.max(0, Math.min(snr / MAX_SNR, 1));
  if (frac < 0.60) return '#00d250';
  if (frac < 0.80) return '#e6c800';
  if (frac < 0.90) return '#ff8c00';
  return '#dc1e1e';
}

function qualityFractionForMode(modeKey, snr) {
  if (snr == null || Number.isNaN(snr)) return 0;
  if (modeKey === 'FTx') {
    // PSK-derived FTx quality is weak-signal centric; map roughly -20..+20 dB to 0..100%.
    const minDb = -20;
    const maxDb = 20;
    return Math.max(0, Math.min((snr - minDb) / (maxDb - minDb), 1));
  }
  // CW/RTTY/SSB use the same 0..50 dB scale as the main S-meter.
  return Math.max(0, Math.min(snr / MAX_SNR, 1));
}

function regionKeyForIndex(idx) {
  return REGION_KEYS[idx] || REGION_KEYS[0];
}

function createModeSampleCube() {
  return Array.from({ length: REGIONS.length }, () =>
    Array.from({ length: BANDS.length }, () => ({ CW: [], RTTY: [], FT8: [], FT4: [] }))
  );
}

function createModeQualityCube() {
  return Array.from({ length: REGIONS.length }, () =>
    Array.from({ length: BANDS.length }, () => ({
      CW: null, RTTY: null, FT8: null, FT4: null, FTx: null, SSB: null,
    }))
  );
}

function addModeSample(modeCube, regionIdx, bandIdx, rawMode, snr) {
  const nm = normaliseMode(rawMode);
  if (!KNOWN_MODES.includes(nm)) return;
  modeCube[regionIdx][bandIdx][nm].push(snr);
}

function collapseModeSamples(modeCube, meterState) {
  const out = createModeQualityCube();
  for (let ri = 0; ri < REGIONS.length; ri++) {
    for (let bi = 0; bi < BANDS.length; bi++) {
      const bucket = modeCube[ri][bi];
      const ftAll = bucket.FT8.concat(bucket.FT4);
      out[ri][bi].CW = median(bucket.CW);
      out[ri][bi].RTTY = median(bucket.RTTY);
      out[ri][bi].FT8 = median(bucket.FT8);
      out[ri][bi].FT4 = median(bucket.FT4);
      out[ri][bi].FTx = median(ftAll);
      out[ri][bi].SSB = (meterState[ri].hasValue[bi] && meterState[ri].ema[bi] >= SSB_SNR_THRESHOLD)
        ? Math.round(meterState[ri].ema[bi] * 10) / 10
        : null;
    }
  }
  return out;
}

// ── Region classifier ─────────────────────────────────────────────────────────
const PREFIX_TABLE = [
  ['W1',0],['W2',0],['W3',0],['W4',0],['W8',0],['W9',0],
  ['K1',0],['K2',0],['K3',0],['K4',0],['K8',0],['K9',0],
  ['N1',0],['N2',0],['N3',0],['N4',0],['N8',0],['N9',0],
  ['VE1',0],['VE2',0],['VE3',0],['VE9',0],['VA1',0],['VA2',0],['VA3',0],['VY2',0],
  ['KP2',0],['KP4',0],['WP4',0],['NP4',0],['VP9',0],['CO',0],['CM',0],['HH',0],['HI',0],
  ['W0',1],['W5',1],['K0',1],['K5',1],['N0',1],['N5',1],
  ['VE4',1],['VE5',1],['VA4',1],['VA5',1],['XE',1],['XF',1],
  ['TI',1],['YN',1],['HR',1],['TG',1],['YS',1],
  ['W6',2],['W7',2],['K6',2],['K7',2],['N6',2],['N7',2],
  ['VE6',2],['VE7',2],['VA6',2],['VA7',2],['VY1',2],
  ['KH6',2],['NH6',2],['WH6',2],['KL',2],['WL',2],['NL',2],['AL',2],
  ['PY',3],['PP',3],['LU',3],['CE',3],['OA',3],['HC',3],['HK',3],
  ['YV',3],['YW',3],['CX',3],['ZP',3],['CP',3],['GY',3],['PZ',3],['FY',3],['VP8',3],
  ['G',4],['M',4],['GM',4],['GW',4],['GI',4],['GD',4],['GJ',4],['GU',4],
  ['F',4],['DL',4],['DJ',4],['DK',4],['OE',4],['PA',4],['ON',4],
  ['SM',4],['SA',4],['OH',4],['LA',4],['OZ',4],['TF',4],['EI',4],
  ['HB',4],['LX',4],['I',4],['IK',4],['IW',4],['IZ',4],
  ['EA',4],['CT',4],['SP',4],['OK',4],['OM',4],['HA',4],
  ['YO',4],['LZ',4],['SV',4],['TA',4],['UR',4],['EU',4],['EW',4],
  ['RA',4],['RU',4],['UA1',4],['UA2',4],['UA3',4],['UA4',4],['UA6',4],
  ['YU',4],['9A',4],['S5',4],['Z3',4],['E7',4],['YL',4],['LY',4],['ES',4],['ER',4],
  ['ZS',5],['ZT',5],['ZU',5],['EA8',5],['EA9',5],['CN',5],['7X',5],['TS',5],
  ['SU',5],['SS',5],['ST',5],['ET',5],['5Z',5],['5X',5],['9J',5],['9I',5],
  ['V5',5],['7P',5],['7Q',5],['C9',5],['D2',5],['TY',5],['TZ',5],['5U',5],
  ['9G',5],['9L',5],['TU',5],['TR',5],['TN',5],['9Q',5],['5B',5],
  ['JA',6],['JH',6],['JK',6],['JR',6],['HL',6],['DS',6],
  ['BY',6],['BG',6],['BT',6],['BV',6],['VR',6],
  ['UA9',6],['UA0',6],['R9',6],['R0',6],
  ['4X',6],['4Z',6],['9K',6],['HZ',6],['A6',6],['A4',6],['A7',6],
  ['AP',6],['VU',6],['AT',6],['9M',6],['HS',6],['XV',6],['YB',6],['PK',6],
  ['VK',7],['ZL',7],['ZM',7],['DU',7],['DV',7],['DW',7],['DX',7],
  ['YJ',7],['3D2',7],['FO',7],['FK',7],['A3',7],['E5',7],['P2',7],['H4',7],
  ['KH8',7],['5W',7],['V6',7],['V7',7],['T8',7],
].sort((a, b) => b[0].length - a[0].length);

function classifyCallsign(call) {
  if (!call) return -1;
  let c = call.toUpperCase();
  const slash = c.indexOf('/');
  if (slash > 0) c = c.slice(0, slash);
  for (const [pfx, region] of PREFIX_TABLE) {
    if (c.startsWith(pfx)) return region;
  }
  const c0 = c[0];
  if (c0 === 'W' || c0 === 'K' || c0 === 'N') {
    for (const ch of c) {
      if (ch >= '0' && ch <= '9') {
        const d = parseInt(ch);
        if (d === 0 || d === 5) return 1;
        if (d === 6 || d === 7) return 2;
        return 0;
      }
    }
  }
  return -1;
}

function regionFromLatLon(lat, lon) {
  if (lat > 15 && lon >= -170 && lon <= -50) {
    if (lon >= -85)  return 0;
    if (lon >= -105) return 1;
    return 2;
  }
  if (lat >= -60 && lat <= 15 && lon >= -82 && lon <= -34) return 3;
  if (lat >= 35  && lat <= 72 && lon >= -12 && lon <= 45)  return 4;
  if (lat >= -35 && lat <= 40 && lon >= -20 && lon <= 55)  return 5;
  if (lat >= -10 && lat <= 75 && lon >= 45)                return 6;
  if (lat <= 0   && lon >= 100)                            return 7;
  return 0;
}

function regionKeyFromLatLon(lat, lon) {
  return regionKeyForIndex(regionFromLatLon(lat, lon));
}

// ── Spotter cache ─────────────────────────────────────────────────────────────
const SpotterCache = {
  get(call) {
    try {
      const v = sessionStorage.getItem('sc_' + call);
      if (v === null) return null;
      if (v === '')   return false;
      return JSON.parse(v);
    } catch { return null; }
  },
  put(call, latLon) {
    try { sessionStorage.setItem('sc_' + call, latLon ? JSON.stringify(latLon) : ''); }
    catch {}
  },
};

// ── Country centroids ─────────────────────────────────────────────────────────
const CENTROIDS = [
  ['KH0',[15.18,145.75]],['KH2',[13.45,144.79]],['KH6',[20.8,-156.3]],
  ['KL',[64.2,-153]],['KP2',[17.73,-64.73]],['KP4',[18.22,-66.59]],
  ['TI',[9.75,-83.75]],['XE',[23.63,-102.55]],['TG',[15.78,-90.23]],
  ['YN',[12.87,-85.21]],['HR',[15.2,-86.24]],
  ['CO',[22,-79.52]],['HH',[18.97,-72.29]],['HI',[18.74,-70.16]],
  ['VP9',[32.31,-64.75]],['6Y',[18.11,-77.3]],['8P',[13.19,-59.54]],
  ['9Y',[10.69,-61.22]],['J3',[12.12,-61.68]],['J6',[13.91,-60.98]],
  ['PY',[-14.24,-51.93]],['LU',[-34,-64]],['CE',[-35.68,-71.54]],
  ['OA',[-10,-76]],['HC',[-1.83,-78.18]],['HK',[4.57,-74.3]],
  ['YV',[6.42,-66.59]],['CX',[-32.52,-55.77]],['ZP',[-23.44,-58.44]],
  ['CP',[-16.29,-63.59]],['GY',[4.86,-58.93]],['VP8',[-51.7,-57.85]],
  ['G',[51.51,-1]],['GM',[56.82,-4.18]],['GW',[52.13,-3.78]],
  ['GI',[54.6,-6.74]],['GD',[54.24,-4.53]],['GJ',[49.21,-2.13]],
  ['GU',[49.46,-2.59]],['F',[46.23,2.21]],['DL',[51.17,10.45]],
  ['OE',[47.52,14.55]],['PA',[52.13,5.29]],['ON',[50.5,4.47]],
  ['SM',[60.13,18.64]],['OH',[64,26]],['LA',[64.57,17]],
  ['OZ',[56.26,9.5]],['TF',[64.96,-19.02]],['EI',[53.41,-8.24]],
  ['HB',[46.82,8.22]],['LX',[49.62,6.13]],['I',[42.5,12.57]],
  ['IK',[42.5,12.57]],['IW',[42.5,12.57]],['IZ',[42.5,12.57]],
  ['EA',[40.42,-3.7]],['CT',[39.4,-8.22]],['SP',[51.92,19.15]],
  ['OK',[49.82,15.47]],['OM',[48.67,19.7]],['HA',[47.16,19.4]],
  ['YO',[45.94,24.97]],['LZ',[42.73,25.49]],['SV',[39.07,21.82]],
  ['TA',[39.06,35.24]],['UR',[49,31.48]],['EU',[53.71,27.97]],
  ['EW',[53.71,27.97]],['RA',[61.52,60]],['UA1',[64,40]],
  ['UA3',[56,40]],['UA4',[52,48]],['UA6',[44,43]],
  ['YL',[56.88,24.6]],['LY',[55.17,23.88]],['ES',[58.6,25.01]],
  ['ER',[47.41,28.37]],['YU',[44.02,21.01]],['9A',[45.1,15.2]],
  ['S5',[46.12,14.8]],['3A',[43.73,7.4]],['9H',[35.9,14.51]],
  ['TK',[42.04,9.01]],['ZA',[41.15,20.17]],['HV',[41.9,12.45]],
  ['T7',[43.94,12.46]],['ZB',[36.14,-5.35]],
  ['ZS',[-29,25.08]],['EA8',[28.29,-15.63]],['CN',[31.79,-7.09]],
  ['7X',[28,3]],['TS',[33.89,9.54]],['SU',[26.82,30.8]],
  ['ST',[12.86,30.22]],['ET',[9.15,40.49]],['5Z',[-0.02,37.91]],
  ['5H',[-6.37,34.89]],['5X',[1.37,32.29]],['9J',[-13.13,27.85]],
  ['Z2',[-20,30]],['C9',[-18.67,35.53]],['7P',[-29.61,28.23]],
  ['7Q',[-13.25,34.3]],['V5',[-22.96,18.49]],['A2',[-22.33,24.68]],
  ['D2',[-11.2,17.87]],['TY',[9.31,2.32]],['5U',[17.61,8.08]],
  ['9G',[7.95,-1.02]],['9L',[8.46,-11.78]],['TU',[7.54,-5.55]],
  ['5N',[9.08,8.68]],['6W',[14.5,-14.45]],['TR',[-0.8,11.61]],
  ['TN',[-4.27,15.28]],['9Q',[-4.03,21.76]],['5B',[35.13,33.43]],
  ['4X',[31.05,34.85]],['4Z',[31.05,34.85]],['YK',[34.8,38.99]],
  ['OD',[33.85,35.86]],['YI',[33.22,43.68]],['9K',[29.33,47.5]],
  ['HZ',[23.86,45.08]],['A7',[25.35,51.18]],['A9',[26.03,50.55]],
  ['A4',[21.47,55.97]],['A6',[23.42,53.85]],
  ['JA',[36.2,138.25]],['JH',[36.2,138.25]],['JR',[36.2,138.25]],
  ['HL',[36.49,127.98]],['DS',[36.49,127.98]],
  ['P5',[39.03,125.75]],['BY',[35.86,104.2]],['BG',[35.86,104.2]],
  ['BT',[35.86,104.2]],['BV',[25.03,121.56]],['VR',[22.32,114.18]],
  ['UA9',[62,80]],['UA0',[62,130]],['R9',[55,73]],
  ['EX',[41.2,74.77]],['EY',[38.86,71.28]],['EZ',[40,59.56]],
  ['UK',[41.38,64.59]],['UN',[48.02,66.92]],
  ['AP',[30.38,69.35]],['VU',[20.59,78.96]],['AT',[20.59,78.96]],
  ['S2',[23.68,90.36]],['9N',[28.39,84.12]],['9M',[3.82,108.33]],
  ['XV',[16.11,107.96]],['XW',[17.97,102.62]],['XU',[12.57,104.99]],
  ['HS',[15.87,100.99]],['YB',[-2.51,118.01]],['PK',[-2.51,118.01]],
  ['VK',[-25.27,133.78]],['ZL',[-41.29,174.78]],
  ['DU',[12.88,121.77]],['YJ',[-15.38,166.96]],['3D2',[-17.71,178.06]],
  ['FO',[-17.68,-149.41]],['FK',[-21.26,165.62]],['A3',[-21.18,-175.2]],
  ['E5',[-21.24,-159.82]],['P2',[-6.31,143.96]],['H4',[-9.6,160.16]],
  ['V6',[6.92,158.19]],['V7',[7.1,171.38]],['T8',[7.51,134.58]],
  ['5W',[-13.76,-172.1]],['KH8',[-14.28,-170.7]],
].sort((a, b) => b[0].length - a[0].length);

function centroidForCall(call) {
  let c = call.toUpperCase();
  const slash = c.indexOf('/');
  if (slash > 0) c = c.slice(0, slash);
  for (const [pfx, ll] of CENTROIDS) {
    if (c.startsWith(pfx)) return { lat: ll[0], lon: ll[1] };
  }
  return null;
}

// ── Spotter resolution ────────────────────────────────────────────────────────
async function resolveSpotter(call) {
  const upper = call.toUpperCase().split('/')[0];
  const cached = SpotterCache.get(upper);
  if (cached === false) return null;
  if (cached)           return cached;

  if (/^[WKN]/.test(upper) || upper.startsWith('VE') || upper.startsWith('VA')) {
    try {
      const resp = await fetch(`${PROXY_BASE}/hamdb/${upper}`);
      const data = await resp.json();
      const cs   = data?.hamdb?.callsign;
      if (cs) {
        if (cs.grid) {
          const ll = gridToLatLon(cs.grid);
          if (ll) { SpotterCache.put(upper, ll); return ll; }
        }
        const lat = parseFloat(cs.lat), lon = parseFloat(cs.lon);
        if (lat && lon) {
          const ll = { lat, lon };
          SpotterCache.put(upper, ll);
          return ll;
        }
      }
    } catch {}
  }

  const ll = centroidForCall(upper);
  if (ll) { SpotterCache.put(upper, ll); return ll; }
  SpotterCache.put(upper, null);
  return null;
}

// ── RegionMeter ───────────────────────────────────────────────────────────────
class RegionMeter {
  constructor() { this.reset(); }

  reset() {
    this.hasValue     = new Array(BANDS.length).fill(false);
    this.ema          = new Array(BANDS.length).fill(0);
    this.peak         = new Array(BANDS.length).fill(0);
    this.spotCount    = new Array(BANDS.length).fill(0);
    this.currentModes = Array.from({length: BANDS.length}, () => new Set());
  }

  // Call at start of each poll cycle — clears mode sets, preserves EMA/peak
  beginPollCycle() {
    this.currentModes = Array.from({length: BANDS.length}, () => new Set());
  }

  addSample(bandIdx, snr, mode) {
    if (!this.hasValue[bandIdx]) {
      this.ema[bandIdx]      = snr;
      this.hasValue[bandIdx] = true;
    } else {
      this.ema[bandIdx] = EMA_ALPHA * snr + (1 - EMA_ALPHA) * this.ema[bandIdx];
    }
    if (this.ema[bandIdx] > this.peak[bandIdx])
      this.peak[bandIdx] = this.ema[bandIdx];
    this.spotCount[bandIdx]++;
    const nm = normaliseMode(mode);
    if (nm) this.currentModes[bandIdx].add(nm);
  }

  // Drain stale readings when a band receives no samples this poll
  decayBand(bandIdx) {
    if (!this.hasValue[bandIdx]) return;
    this.ema[bandIdx]  *= (1 - EMA_ALPHA);
    this.peak[bandIdx] *= (1 - EMA_ALPHA);
    if (this.ema[bandIdx] < 0.5) {
      this.ema[bandIdx]  = 0;
      this.peak[bandIdx] = 0;
      this.hasValue[bandIdx] = false;
    }
  }

  activeModes(bandIdx) {
    const modes = new Set(this.currentModes[bandIdx]);
    if (this.hasValue[bandIdx] && this.ema[bandIdx] >= SSB_SNR_THRESHOLD)
      modes.add('SSB');
    return modes;
  }

  get totalSpots() { return this.spotCount.reduce((a,b) => a+b, 0); }
  get hasAnyData()  { return this.hasValue.some(Boolean); }
}

// ── Canvas bar drawing ────────────────────────────────────────────────────────
function drawBar(canvas, hasData, snr, peak) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const gapW   = 1;
  const segW   = (w - gapW * (SEG_COUNT - 1)) / SEG_COUNT;
  const liveN  = hasData ? Math.min(snr  / MAX_SNR, 1) : 0;
  const peakN  = Math.min(peak / MAX_SNR, 1);
  const litSeg = Math.round(liveN * SEG_COUNT);
  const pkSeg  = Math.round(peakN * SEG_COUNT);
  for (let i = 0; i < SEG_COUNT; i++) {
    const x    = i * (segW + gapW);
    const lit  = i < litSeg;
    const inPk = !lit && i < pkSeg;
    if (!hasData)   ctx.fillStyle = '#1c1c32';
    else if (lit)   ctx.fillStyle = SEG_COLORS.live[i];
    else if (inPk)  ctx.fillStyle = SEG_COLORS.peak[i];
    else            ctx.fillStyle = '#1c1c32';
    ctx.fillRect(x, 0, segW, h);
  }
}

// ── Mode row builder ──────────────────────────────────────────────────────────
// Abbreviated labels to fit narrow panel columns
// Display slots: CW, SSB, RY (RTTY), FTx (FT8+FT4)
const DISPLAY_MODES = [
  { abbr: 'CW',  sources: ['CW'],        isSSB: false },
  { abbr: 'SSB', sources: ['SSB'],       isSSB: true  },
  { abbr: 'RY',  sources: ['RTTY'],      isSSB: false },
  { abbr: 'FTx', sources: ['FT8','FT4'], isSSB: false },
];
const MODE_QUALITY_KEY = { CW: 'CW', RY: 'RTTY', FTx: 'FTx', SSB: 'SSB' };
const MODE_QUALITY_COLORS = ['#00d250', '#e6c800', '#ff8c00', '#dc1e1e'];

function buildQualityTrack(frac, enabled) {
  const track = document.createElement('span');
  track.className = 'mode-quality-track';
  for (let i = 0; i < 4; i++) {
    const seg = document.createElement('span');
    seg.className = 'mode-quality-seg';
    const fillEl = document.createElement('span');
    fillEl.className = 'mode-quality-fill';
    let fill = 0;
    if (enabled && frac > 0) {
      const start = i * 0.25;
      const end = start + 0.25;
      if (frac >= end) fill = 1;
      else if (frac > start) fill = (frac - start) / 0.25;
    }
    const fillPct = Math.round(fill * 100);
    const c = MODE_QUALITY_COLORS[i];
    fillEl.style.width = `${fillPct}%`;
    fillEl.style.backgroundColor = c;
    seg.appendChild(fillEl);
    track.appendChild(seg);
  }
  return track;
}

function buildModeRow(el, hasData, activeModes, modeSnr = {}) {
  el.innerHTML = '';
  DISPLAY_MODES.forEach(({ abbr, sources, isSSB }) => {
    const span   = document.createElement('span');
    const active = sources.some(s => activeModes.has(s));
    const txt = document.createElement('span');
    txt.className = 'mode-label-text';
    const qKey = MODE_QUALITY_KEY[abbr];
    const qSnr = modeSnr[qKey] ?? null;
    const frac = qualityFractionForMode(qKey, qSnr);
    const qTrack = buildQualityTrack(frac, hasData && active);
    if (!hasData) {
      span.className   = 'mode-label mode-dim';
      txt.textContent = abbr;
    } else if (active && isSSB) {
      span.className   = 'mode-label mode-ssb';
      txt.textContent = '\u2713' + abbr;
    } else if (active) {
      span.className   = 'mode-label mode-active';
      txt.textContent = '\u2713' + abbr;
    } else if (isSSB) {
      span.className   = 'mode-label mode-dim';
      txt.textContent = abbr;
    } else {
      span.className   = 'mode-label mode-absent';
      txt.textContent = '\u2717' + abbr;
    }
    span.appendChild(qTrack);
    span.appendChild(txt);
    el.appendChild(span);
  });
}

// ── Phone detection ───────────────────────────────────────────────────────────
function isPhone() { return window.innerWidth < 600; }

// ── UI: meters state ──────────────────────────────────────────────────────────
const meters = REGIONS.map(() => new RegionMeter());

// Desktop refs
const canvases     = []; // [regionIdx][bandIdx]
const sUnits       = []; // [regionIdx][bandIdx]
const footers      = []; // [regionIdx]
const deskModeRows = []; // [regionIdx][bandIdx]

// Phone refs
const accCanvases = []; // [regionIdx][bandIdx]
const accSUnits   = []; // [regionIdx][bandIdx]
const accFooters  = []; // [regionIdx]
const accPills    = []; // [regionIdx][bandIdx]
const accModeRows = []; // [regionIdx][bandIdx]

// ── Build desktop panels ──────────────────────────────────────────────────────
function buildDesktopPanels() {
  const grid = document.getElementById('meters-grid');
  grid.innerHTML = '';
  canvases.length = 0; sUnits.length = 0; footers.length = 0; deskModeRows.length = 0;

  REGIONS.forEach((name, ri) => {
    const panel = document.createElement('div');
    panel.className = 'region-panel';

    const hdr = document.createElement('div');
    hdr.className   = 'region-header';
    hdr.textContent = name;
    panel.appendChild(hdr);

    const rows = document.createElement('div');
    rows.className = 'band-rows';

    const rc = [], rs = [], rmDesk = [];
    BANDS.forEach((band, bi) => {
      const row = document.createElement('div');
      row.className = 'band-row';

      const lbl = document.createElement('span');
      lbl.className   = 'band-label';
      lbl.textContent = band.label;

      const wrap = document.createElement('div');
      wrap.className = 'bar-wrap';

      const cv = document.createElement('canvas');
      cv.className = 'bar-canvas';
      wrap.appendChild(cv);

      const su = document.createElement('span');
      su.className   = 's-unit no-data';
      su.textContent = '--';

      // Per-band mode indicator row
      const bmr = document.createElement('div');
      bmr.className = 'band-mode-row';
      buildModeRow(bmr, false, new Set());

      row.appendChild(lbl);
      row.appendChild(wrap);
      row.appendChild(su);
      rows.appendChild(row);
      rows.appendChild(bmr);
      rc.push(cv);
      rs.push(su);
      rmDesk.push(bmr);
    });

    const ftr = document.createElement('div');
    ftr.className   = 'region-footer';
    ftr.textContent = 'no data';

    panel.appendChild(rows);
    panel.appendChild(ftr);
    grid.appendChild(panel);
    canvases.push(rc);
    sUnits.push(rs);
    footers.push(ftr);
    deskModeRows.push(rmDesk);
  });

  requestAnimationFrame(() => {
    canvases.forEach(rc => rc.forEach(cv => {
      cv.width  = cv.offsetWidth  || 80;
      cv.height = cv.offsetHeight || 14;
      drawBar(cv, false, 0, 0);
    }));
  });
}

// ── Build phone accordion ─────────────────────────────────────────────────────
function buildPhoneAccordion() {
  const acc = document.getElementById('phone-accordion');
  acc.innerHTML = '';
  accCanvases.length = 0; accSUnits.length = 0; accFooters.length = 0;
  accPills.length = 0;    accModeRows.length = 0;

  REGIONS.forEach((name, ri) => {
    const row = document.createElement('div');
    row.className = 'acc-row';

    const hdr = document.createElement('div');
    hdr.className = 'acc-header';
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('aria-expanded', 'false');

    const nameEl = document.createElement('span');
    nameEl.className   = 'acc-region-name';
    nameEl.textContent = name;

    const summary = document.createElement('div');
    summary.className = 'acc-summary';

    const rp = [];
    BANDS.forEach((band) => {
      const pill = document.createElement('span');
      pill.className   = 'acc-pill no-data';
      pill.textContent = band.label;
      summary.appendChild(pill);
      rp.push(pill);
    });
    accPills.push(rp);

    const chevron = document.createElement('span');
    chevron.className   = 'acc-chevron';
    chevron.textContent = '▼';

    hdr.appendChild(nameEl);
    hdr.appendChild(summary);
    hdr.appendChild(chevron);

    const body = document.createElement('div');
    body.className = 'acc-body';

    const rc = [], rs = [], rmAcc = [];
    BANDS.forEach((band, bi) => {
      const brow = document.createElement('div');
      brow.className = 'acc-band-row';

      const lbl = document.createElement('span');
      lbl.className   = 'acc-band-label';
      lbl.textContent = band.label;

      const wrap = document.createElement('div');
      wrap.className = 'acc-bar-wrap';

      const cv = document.createElement('canvas');
      cv.className = 'acc-bar-canvas';
      wrap.appendChild(cv);

      const su = document.createElement('span');
      su.className   = 'acc-s-unit no-data';
      su.textContent = '--';

      // Per-band mode indicator row
      const abmr = document.createElement('div');
      abmr.className = 'band-mode-row band-mode-row-phone';
      buildModeRow(abmr, false, new Set());

      brow.appendChild(lbl);
      brow.appendChild(wrap);
      brow.appendChild(su);
      body.appendChild(brow);
      body.appendChild(abmr);
      rc.push(cv);
      rs.push(su);
      rmAcc.push(abmr);
    });

    const ftr = document.createElement('div');
    ftr.className   = 'acc-footer';
    ftr.textContent = 'no data';
    body.appendChild(ftr);

    row.appendChild(hdr);
    row.appendChild(body);
    acc.appendChild(row);

    accCanvases.push(rc);
    accSUnits.push(rs);
    accFooters.push(ftr);
    accModeRows.push(rmAcc);

    hdr.addEventListener('click', () => {
      const open = row.classList.toggle('open');
      hdr.setAttribute('aria-expanded', String(open));
      if (open) {
        requestAnimationFrame(() => {
          rc.forEach(cv => {
            cv.width  = cv.offsetWidth  || 200;
            cv.height = cv.offsetHeight || 16;
            const bi2 = rc.indexOf(cv);
            const m   = meters[ri];
            drawBar(cv, m.hasValue[bi2], m.ema[bi2], m.peak[bi2]);
          });
        });
      }
    });
  });
}

function buildPanels() {
  buildDesktopPanels();
  buildPhoneAccordion();
}

// ── Refresh both layouts ──────────────────────────────────────────────────────
function refreshUI(modeQualityByBand = null) {
  meters.forEach((m, ri) => {
    BANDS.forEach((_, bi) => {
      const hasData = m.hasValue[bi];
      const snr     = m.ema[bi];
      const peak    = m.peak[bi];

      // Desktop
      if (canvases[ri]) {
        const cv = canvases[ri][bi];
        if (cv.width === 0) { cv.width = cv.offsetWidth || 80; cv.height = cv.offsetHeight || 14; }
        drawBar(cv, hasData, snr, peak);
        const su = sUnits[ri][bi];
        su.textContent = hasData ? snrToSUnit(snr) : '--';
        su.className   = hasData ? 's-unit' : 's-unit no-data';
      }

      // Phone
      if (accCanvases[ri]) {
        const cv = accCanvases[ri][bi];
        const cw = cv.offsetWidth;
        if (cw > 0) {
          cv.width  = cw;
          cv.height = cv.offsetHeight || 16;
          drawBar(cv, hasData, snr, peak);
        }
        const su = accSUnits[ri][bi];
        su.textContent = hasData ? snrToSUnit(snr) : '--';
        su.className   = hasData ? 'acc-s-unit' : 'acc-s-unit no-data';

        const pill = accPills[ri][bi];
        if (hasData) {
          pill.textContent = `${BANDS[bi].label} ${snrToSUnit(snr)}`;
          pill.className   = 'acc-pill';
        } else {
          pill.textContent = BANDS[bi].label;
          pill.className   = 'acc-pill no-data';
        }
      }

      // Per-band mode rows
      const bModes = m.activeModes(bi);
      const q = modeQualityByBand?.[ri]?.[bi] || {};
      // Let PSKReporter drive FTx activity even when RBN has no digital spots.
      if (q.FTx != null) bModes.add('FT8');
      const bHasData = m.hasValue[bi] || q.FTx != null;
      if (deskModeRows[ri]?.[bi]) buildModeRow(deskModeRows[ri][bi], bHasData, bModes, q);
      if (accModeRows[ri]?.[bi])  buildModeRow(accModeRows[ri][bi],  bHasData, bModes, q);
    });

    const txt = m.hasAnyData ? `${m.totalSpots} spots` : 'no data';
    if (footers[ri])    footers[ri].textContent    = txt;
    if (accFooters[ri]) accFooters[ri].textContent = txt;
  });
}

// ── Polling ───────────────────────────────────────────────────────────────────
let pollTimer    = null;
let isRunning    = false;
let geoWatchId   = null;
let skimmerCount = 0;

function bandForFreq(khz) {
  const i = BANDS.findIndex(b => khz >= b.min && khz <= b.max);
  return i >= 0 ? i : -1;
}

async function fetchPsk() {
  try {
    const resp = await fetch(PROXY_BASE + '/psk', { signal: AbortSignal.timeout(25000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    pskByRegion = data?.byRegion && typeof data.byRegion === 'object' ? data.byRegion : {};
    pskMeta = {
      age: typeof data?.age === 'number' ? data.age : null,
      cached: !!data?.cached,
      stale: !!data?.stale,
    };
  } catch {
    // Keep previous PSK snapshot on transient failures.
  }
}

async function pollOnce() {
  const mode = document.querySelector('input[name="vantage-mode"]:checked').value;

  // Clear per-cycle mode sets
  meters.forEach(m => m.beginPollCycle());

  let data;
  try {
    const resp = await fetch(PROXY_BASE + '/rbn', { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) { setStatus(`HTTP ${resp.status}`, 'error'); return; }
    data = await resp.json();
  } catch (e) {
    setStatus(`Fetch error: ${e.message}`, 'error');
    return;
  }

  const vantageRegion = parseInt(document.getElementById('region-select').value);
  const vantageGrid   = document.getElementById('grid-input').value.trim().toUpperCase();
  const radiusMiles   = getRadiusMiles();

  let gridLL = null;
  if (mode === 'grid') {
    gridLL = gridToLatLon(vantageGrid);
    if (!gridLL) { setStatus('Invalid grid square', 'error'); return; }
  }

  let totalSpots = 0, spotsFromVantage = 0, spotsProcessed = 0, spotsUnknown = 0;
  const pendingGrid = [];
  const sampled = Array.from({length: REGIONS.length}, () => new Uint8Array(BANDS.length));
  const regionSkimmers = new Set();
  const modeSamples = createModeSampleCube();

  for (const [spotCall, spot] of Object.entries(data)) {
    if (!spot.lsn || typeof spot.lsn !== 'object') continue;
    if ((spot.age ?? 0) > 120) continue;
    const freq = parseFloat(String(spot.freq).replace(/\s/g, ''));
    if (!freq) continue;
    const bi = bandForFreq(freq);
    if (bi < 0) continue;
    totalSpots++;

    const dxRegion = classifyCallsign(spotCall);

    for (const [listenerCall, snrVal] of Object.entries(spot.lsn)) {
      const snr = parseFloat(snrVal);
      if (isNaN(snr)) continue;

      if (mode === 'region') {
        const spotterRegion = classifyCallsign(listenerCall);
        if (spotterRegion !== vantageRegion) continue;
        regionSkimmers.add(listenerCall.toUpperCase().split('/')[0]);
        spotsFromVantage++;
        if (dxRegion < 0) { spotsUnknown++; continue; }
        meters[dxRegion].addSample(bi, snr, spot.mode || '');
        addModeSample(modeSamples, dxRegion, bi, spot.mode || '', snr);
        sampled[dxRegion][bi] = 1;
        spotsProcessed++;
      } else {
        pendingGrid.push({ listenerCall, bi, snr, dxRegion, spotMode: spot.mode || '' });
      }
    }
  }

  // Grid mode — resolve spotters asynchronously
  if (mode === 'grid' && gridLL) {
    const skimmersInRadius = new Set();
    for (const { listenerCall, bi, snr, dxRegion, spotMode } of pendingGrid) {
      if (!isRunning) break;
      const ll = await resolveSpotter(listenerCall);
      if (!ll) continue;
      const dist = distanceMiles(gridLL.lat, gridLL.lon, ll.lat, ll.lon);
      if (dist > radiusMiles) continue;
      skimmersInRadius.add(listenerCall.toUpperCase().split('/')[0]);
      spotsFromVantage++;
      if (dxRegion < 0) { spotsUnknown++; continue; }
      meters[dxRegion].addSample(bi, snr, spotMode);
      addModeSample(modeSamples, dxRegion, bi, spotMode, snr);
      sampled[dxRegion][bi] = 1;
      spotsProcessed++;
    }
    skimmerCount = skimmersInRadius.size;
    updateSkimmerCount(skimmerCount, true);

    // If no skimmers heard within radius, clear all meters immediately
    // (don't rely on slow EMA decay — give instant feedback)
    if (skimmerCount === 0) {
      meters.forEach(m => m.reset());
    }
  }

  // Region mode skimmer count
  if (mode === 'region') {
    skimmerCount = regionSkimmers.size;
    updateSkimmerCount(skimmerCount, false);
  }

  // Fetch PSKReporter aggregate in parallel with final UI composition.
  await fetchPsk();

  // Decay bands that received no samples
  for (let ri = 0; ri < REGIONS.length; ri++)
    for (let bi = 0; bi < BANDS.length; bi++)
      if (!sampled[ri][bi]) meters[ri].decayBand(bi);

  const modeQualityByBand = collapseModeSamples(modeSamples, meters);

  // Overlay FTx quality from PSKReporter by from/to region + band.
  const fromKey = mode === 'region'
    ? regionKeyForIndex(vantageRegion)
    : (gridLL ? regionKeyForIndex(regionFromLatLon(gridLL.lat, gridLL.lon)) : null);
  if (fromKey && pskByRegion[fromKey]) {
    for (let ri = 0; ri < REGIONS.length; ri++) {
      const toKey = regionKeyForIndex(ri);
      for (let bi = 0; bi < BANDS.length; bi++) {
        const pskEntry = pskByRegion[fromKey]?.[toKey]?.[BANDS[bi].label];
        if (pskEntry && typeof pskEntry.snr === 'number') {
          modeQualityByBand[ri][bi].FTx = pskEntry.snr;
        }
      }
    }
  }

  refreshUI(modeQualityByBand);

  const ts = new Date().toLocaleTimeString();
  const pskInfo = pskMeta.age == null ? 'psk=na' : `psk=${pskMeta.age}s${pskMeta.stale ? ' stale' : ''}`;
  setStatus(
    `Poll ${ts}  |  spots=${totalSpots}  vantage=${spotsFromVantage}  mapped=${spotsProcessed}  unk=${spotsUnknown}  ${pskInfo}`,
    spotsProcessed > 0 ? 'ok' : 'warn'
  );
}

function startPolling() {
  if (isRunning) return;
  const mode = document.querySelector('input[name="vantage-mode"]:checked').value;
  if (mode === 'grid') {
    const g = document.getElementById('grid-input').value.trim();
    if (!isValidGrid(g)) {
      setStatus('Please enter a valid grid square before starting.', 'error');
      return;
    }
  }
  isRunning = true;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled  = false;
  setStatus('Polling started — waiting for first data…', 'ok');
  saveSettings();
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function stopPolling() {
  isRunning = false;
  clearInterval(pollTimer);
  pollTimer = null;
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled  = true;
  setStatus('Polling stopped.', 'warn');
}

function resetMeters() {
  meters.forEach(m => m.reset());
  skimmerCount = 0;
  const resetEl = document.getElementById('skimmer-count');
  if (resetEl) { resetEl.textContent = ''; resetEl.className = 'skimmer-count'; }
  refreshUI();
  setStatus('Meters reset.', 'warn');
}

function setStatus(msg, cls = '') {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className   = cls;
}

// ── Skimmer count display ─────────────────────────────────────────────────────
function updateSkimmerCount(n, isGrid) {
  const el = document.getElementById('skimmer-count');
  if (!el) return;
  if (n === 0) {
    // In grid mode with no hits, warn the user; in region mode just clear
    el.textContent = isGrid ? 'no skimmers' : '';
    el.className   = isGrid ? 'skimmer-count skimmer-none' : 'skimmer-count';
  } else {
    el.textContent = n === 1 ? '1 skimmer' : `${n} skimmers`;
    el.className   = n < 3 ? 'skimmer-count skimmer-few' : 'skimmer-count skimmer-ok';
  }
}

// ── Auto-update grid from GPS ─────────────────────────────────────────────────
function startAutoUpdate() {
  if (!('geolocation' in navigator)) {
    setStatus('Geolocation not available on this device.', 'error');
    document.getElementById('autoupdate-cb').checked = false;
    return;
  }
  geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      const newGrid = latLonToGrid(pos.coords.latitude, pos.coords.longitude);
      if (!newGrid) return;
      const current = document.getElementById('grid-input').value.trim().toUpperCase().slice(0, 4);
      if (newGrid.slice(0, 4) !== current) {
        document.getElementById('grid-input').value = newGrid;
        saveSettings();
        if (isRunning) { stopPolling(); resetMeters(); startPolling(); }
      }
    },
    err => {
      setStatus(`GPS error: ${err.message}`, 'error');
      stopAutoUpdate();
      document.getElementById('autoupdate-cb').checked = false;
    },
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 10000 }
  );
}

function stopAutoUpdate() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
const RADIUS_VALUES = [125, 250, 500, 1000, 1500, 2000, 5000];
let unitPref = 'auto';

function getUnit() {
  if (unitPref === 'mi') return 'mi';
  if (unitPref === 'km') return 'km';
  const ri = parseInt(document.getElementById('region-select').value);
  return ri <= 2 ? 'mi' : 'km';
}

function updateRadiusLabels() {
  const u   = getUnit();
  const sel = document.getElementById('radius-select');
  RADIUS_VALUES.forEach((v, i) => { if (sel.options[i]) sel.options[i].text = `${v} ${u}`; });
  const btn = document.getElementById('unit-toggle');
  if (btn) { btn.textContent = u; btn.dataset.auto = (unitPref === 'auto') ? '1' : '0'; }
}

function getRadiusMiles() {
  const idx = document.getElementById('radius-select').selectedIndex;
  const v   = RADIUS_VALUES[idx] ?? 500;
  return getUnit() === 'km' ? v * 0.621371 : v;
}

function saveSettings() {
  const mode = document.querySelector('input[name="vantage-mode"]:checked').value;
  Settings.save({
    mode,
    regionIndex:  parseInt(document.getElementById('region-select').value),
    grid:         document.getElementById('grid-input').value.trim().toUpperCase(),
    radiusIndex:  document.getElementById('radius-select').selectedIndex,
    unit:         unitPref,
    autoUpdate:   document.getElementById('autoupdate-cb')?.checked || false,
  });
}

function applySettings(s) {
  document.querySelector(`input[name="vantage-mode"][value="${s.mode}"]`).checked = true;
  document.getElementById('region-select').value = s.regionIndex;
  document.getElementById('grid-input').value    = s.grid || '';
  document.getElementById('radius-select').selectedIndex = s.radiusIndex ?? 2;
  unitPref = s.unit ?? 'auto';
  if (document.getElementById('autoupdate-cb'))
    document.getElementById('autoupdate-cb').checked = s.autoUpdate || false;
  updateRadiusLabels();
  updateModeUI(s.mode);
}

function updateModeUI(mode) {
  const isGrid = mode === 'grid';
  document.getElementById('region-select').disabled  = isGrid;
  document.getElementById('grid-input').disabled     = !isGrid;
  document.getElementById('radius-select').disabled  = !isGrid;
  document.getElementById('unit-toggle').disabled    = !isGrid;

  // Skimmer count — always visible, dimmed when not in grid mode
  const sc = document.getElementById('skimmer-count');
  if (sc) sc.classList.remove('skimmer-disabled');

  // Auto-update — visible always; only enabled on mobile AND in grid mode
  const al = document.getElementById('autoupdate-label');
  const cb = document.getElementById('autoupdate-cb');
  const mobileAndGrid = isGrid && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  if (al) al.classList.toggle('check-disabled', !mobileAndGrid);
  if (cb) { cb.disabled = !mobileAndGrid; if (!mobileAndGrid) cb.checked = false; }

  // Also enable/disable the radius label
  const rl = document.getElementById('radius-label');
  if (rl) rl.classList.toggle('ctrl-label-disabled', !isGrid);

  if (!isGrid) stopAutoUpdate();
}

// ── Geo auto-detect ───────────────────────────────────────────────────────────
function applyLocation(lat, lon) {
  const ri   = regionFromLatLon(lat, lon);
  const grid = latLonToGrid(lat, lon);
  const sel  = document.getElementById('region-select');
  if (parseInt(sel.value) !== ri) {
    sel.value = ri;
    sel.dispatchEvent(new Event('change'));
  }
  if (grid && !document.getElementById('grid-input').value) {
    document.getElementById('grid-input').value = grid;
    setStatus(`Location detected: ${grid} — press Start to begin.`, 'ok');
    saveSettings();
  }
}

async function autoDetect() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => applyLocation(pos.coords.latitude, pos.coords.longitude),
      () => autoDetectByIP()
    );
  } else {
    autoDetectByIP();
  }
}

async function autoDetectByIP() {
  try {
    const resp = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    if (data.latitude && data.longitude) applyLocation(data.latitude, data.longitude);
  } catch {}
}

// ── Wire up events ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildPanels();

  const s = Settings.load();
  applySettings(s);

  if (!s.grid) autoDetect(); else autoDetect();

  // Restore auto-update if it was enabled
  if (s.autoUpdate && s.mode === 'grid') startAutoUpdate();

  document.querySelectorAll('input[name="vantage-mode"]').forEach(rb => {
    rb.addEventListener('change', () => {
      updateModeUI(rb.value);
      saveSettings();
      if (isRunning) { stopPolling(); resetMeters(); startPolling(); }
    });
  });

  document.getElementById('region-select').addEventListener('change', () => {
    if (unitPref === 'auto') updateRadiusLabels();
    saveSettings();
    if (isRunning) { stopPolling(); resetMeters(); startPolling(); }
  });

  document.getElementById('radius-select').addEventListener('change', () => {
    saveSettings();
    if (isRunning) { stopPolling(); resetMeters(); startPolling(); }
  });

  document.getElementById('unit-toggle').addEventListener('click', () => {
    const current = getUnit();
    unitPref = current === 'mi' ? 'km' : 'mi';
    updateRadiusLabels();
    saveSettings();
    if (isRunning) { stopPolling(); resetMeters(); startPolling(); }
  });

  const gi = document.getElementById('grid-input');
  gi.addEventListener('input', () => { gi.style.borderColor = ''; saveSettings(); });
  gi.addEventListener('blur', () => {
    const g = gi.value.trim();
    if (g && !isValidGrid(g)) {
      gi.style.borderColor = '#dc4a4a';
      setStatus(`'${g}' is not a valid Maidenhead grid square (e.g. FN42).`, 'error');
    } else {
      gi.style.borderColor = '';
      if (isRunning) { stopPolling(); resetMeters(); startPolling(); }
    }
  });

  // Auto-update checkbox
  const cb = document.getElementById('autoupdate-cb');
  if (cb) {
    cb.addEventListener('change', e => {
      saveSettings();
      if (e.target.checked) startAutoUpdate(); else stopAutoUpdate();
    });
  }

  document.getElementById('btn-start').addEventListener('click', startPolling);
  document.getElementById('btn-stop').addEventListener('click', stopPolling);
  document.getElementById('btn-reset').addEventListener('click', resetMeters);

  // Space weather + UTC clock
  updateUTC();
  setInterval(updateUTC, 1000);
  fetchSolar();
  setInterval(fetchSolar, 5 * 60 * 1000);
});

// ── Space weather + UTC ───────────────────────────────────────────────────────
function updateUTC() {
  const n = new Date();
  const pad = v => String(v).padStart(2, '0');
  document.getElementById('sw-utc').textContent =
    `${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:${pad(n.getUTCSeconds())}`;
}

async function fetchSolar() {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp  = await fetch('/solar', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return;
    const d = await resp.json();
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = (val != null) ? val : '—';
    };
    set('sw-sfi',  d.sfi);
    set('sw-ssn',  d.ssn);
    set('sw-a',    d.a);
    set('sw-k',    d.k);
    set('sw-wind', d.wind != null ? `${d.wind} km/s` : '—');
    set('sw-bz',   d.bz  != null ? `${d.bz > 0 ? '+' : ''}${d.bz} nT` : '—');
  } catch (e) {
    console.warn('fetchSolar failed:', e.message);
  }
}

// ── Register service worker ───────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

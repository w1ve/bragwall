'use strict';

/**
 * HFSignals.live Badge API  — v2
 *
 * ── Region-meter badge (new unified size) ────────────────────────────────────
 *   GET /badge/region?from=ENA&to=EU&theme=dark|light|cr
 *   GET /badge/grid?grid=FN42&radius=500&to=EU&theme=dark|light|cr
 *   (also /badges/* and /hfsignals/* aliases kept for backward compat)
 *
 * ── History map ──────────────────────────────────────────────────────────────
 *   GET /historymap?vantage=ENA&size=sm|md|lg&theme=dark|light|cr
 *
 * ── Legacy small/full size badges (backward compat) ──────────────────────────
 *   Appending &size=small|full|large still works on the old /badge/* paths.
 *
 * Themes:  dark (default), light, cr (colorblind-friendly)
 * Returns: PNG image
 */

const http    = require('http');
const https   = require('https');
const url     = require('url');
const { createCanvas } = require('canvas');

const PORT         = process.env.PORT || 3002;
const DATA_TTL_MS  = 60  * 1000;        // re-fetch spot data every 60s
const CACHE_TTL_MS = 10  * 60 * 1000;   // reuse rendered PNG for 10 min
const MAX_AGE_MS   = 30  * 60 * 1000;   // evict cached PNGs older than 30 min

const RBN_URL  = process.env.RBN_PROXY_URL  || 'http://rbn-smeter:3001/rbn';
const PSK_URL  = process.env.PSK_PROXY_URL  || 'http://rbn-smeter:3001/psk';
const HIST_URL = process.env.HIST_PROXY_URL || 'http://rbn-smeter:3001/history';

// ── Shared data state ─────────────────────────────────────────────────────────
let rbnData       = null;
let rbnFetchedAt  = 0;
let rbnFetching   = false;

let pskData       = null;
let pskFetchedAt  = 0;
let pskFetching   = false;

// ── PNG cache ─────────────────────────────────────────────────────────────────
const pngCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pngCache) if (now - v.createdAt > MAX_AGE_MS) pngCache.delete(k);
}, 5 * 60 * 1000);

// ── Band definitions ──────────────────────────────────────────────────────────
const BANDS = [
  { label: '160m', min: 1800,  max: 2000  },
  { label: '80m',  min: 3500,  max: 4000  },
  { label: '40m',  min: 7000,  max: 7300  },
  { label: '30m',  min: 10100, max: 10150 },
  { label: '20m',  min: 14000, max: 14350 },
  { label: '17m',  min: 18068, max: 18168 },
  { label: '15m',  min: 21000, max: 21450 },
  { label: '12m',  min: 24890, max: 24990 },
  { label: '10m',  min: 28000, max: 29700 },
  { label: '6m',   min: 50000, max: 54000 },
];

// ── Regions ───────────────────────────────────────────────────────────────────
const REGIONS = [
  { key: 'ENA', label: 'E.N.America' },
  { key: 'CNA', label: 'C.N.America' },
  { key: 'WNA', label: 'W.N.America' },
  { key: 'CAR', label: 'Caribbean'   },
  { key: 'SA',  label: 'S.America'   },
  { key: 'EU',  label: 'Europe'      },
  { key: 'AF',  label: 'Africa'      },
  { key: 'AS',  label: 'Asia'        },
  { key: 'OC',  label: 'Oceania'     },
];

const REGION_ALIASES = {
  'NA':'ENA','ENA':'ENA','CNA':'CNA','WNA':'WNA',
  'CAR':'CAR','CARIBBEAN':'CAR',
  'SA':'SA','EU':'EU','AF':'AF','AS':'AS','OC':'OC',
  'E.NA':'ENA','W.NA':'WNA','C.NA':'CNA',
  'E.N.AMERICA':'ENA','C.N.AMERICA':'CNA','W.N.AMERICA':'WNA',
  'EASTERN NORTH AMERICA':'ENA','CENTRAL NORTH AMERICA':'CNA','WESTERN NORTH AMERICA':'WNA',
};

// ── Themes — matches PWA CSS variables ───────────────────────────────────────
const THEMES = {
  dark: {
    bg:       '#0d0d1a',
    bg2:      '#1a1a2e',
    bg3:      '#12122a',
    border:   '#00d4aa',
    accent:   '#00d4aa',
    text:     '#c8d0e8',
    textDim:  '#6a7490',
    noData:   '#41465f',
    green:    '#00d250',
    yellow:   '#e6c800',
    orange:   '#ff8c00',
    red:      '#dc1e1e',
    dimSeg:   '#1c1c32',
    modeX:    '#7a2020',
    // branding bar
    brandBg:  '#0a0a14',
    brandFg:  '#00d4aa',
  },
  light: {
    bg:       '#f4f7fb',
    bg2:      '#ffffff',
    bg3:      '#eef3f8',
    border:   '#00886a',
    accent:   '#00886a',
    text:     '#1a1a2e',
    textDim:  '#5f6f8c',
    noData:   '#8a94a8',
    green:    '#008830',
    yellow:   '#886600',
    orange:   '#884400',
    red:      '#880010',
    dimSeg:   '#e2e8f0',
    modeX:    '#cc3333',
    brandBg:  '#e8f0ec',
    brandFg:  '#006650',
  },
  cr: {
    bg:       '#0f1222',
    bg2:      '#151a31',
    bg3:      '#1b2140',
    border:   '#4fd7ff',
    accent:   '#4fd7ff',
    text:     '#e8f3ff',
    textDim:  '#9fb0c9',
    noData:   '#6f7f99',
    green:    '#39b8ff',
    yellow:   '#f6d84a',
    orange:   '#ff9f1a',
    red:      '#d94fb2',
    dimSeg:   '#1f2750',
    modeX:    '#8f2065',
    brandBg:  '#0a0e1a',
    brandFg:  '#4fd7ff',
  },
};

// ── History chart band colors — matches app.js exactly ───────────────────────
const HIST_BAND_COLORS = [
  '#ff6b6b', // 160m
  '#ff9f43', // 80m
  '#ffd93d', // 40m
  '#6bcb77', // 30m
  '#00d4aa', // 20m
  '#4ecdc4', // 17m
  '#45aaf2', // 15m
  '#a29bfe', // 12m
  '#fd79a8', // 10m
  '#b2bec3', // 6m
];
const HIST_BANDS      = BANDS.map(b => b.label);
const HIST_SNR_MAX    = 60;
const HIST_WINDOW_S   = 24 * 60 * 60;

// ── Dimensions — region meter badge ──────────────────────────────────────────
// Matches PWA .region-panel exactly:
//   width: 168px
//   header: 28px
//   band row: 26px × 10 = 260px
//   footer (skimmer count): 20px
//   branding bar: 22px
//   total: 330px
const RM_W    = 168;
const RM_HDR  = 46;
const RM_ROW  = 26;
const RM_FTR  = 20;
const RM_BRD  = 22;
const RM_PAD  = 5;
const RM_H    = RM_HDR + BANDS.length * RM_ROW + RM_FTR + RM_BRD;

// Bar area within a row (matches .bar-wrap height: 14px)
const RM_BAR_H  = 14;
const RM_LABEL_W = 34; // .band-label width
const RM_SUNIT_W = 36; // .s-unit width
const RM_SEG     = 15; // segments in bar

// ── History map sizes ─────────────────────────────────────────────────────────
const HISTMAP_SIZES = {
  sm: { W: 300, H: 160 },
  md: { W: 480, H: 220 },
  lg: { W: 700, H: 300 },
};

// ── Misc constants ────────────────────────────────────────────────────────────
const SSB_THRESHOLD = 20.0;
const MAX_SNR       = 50.0;

// ── Callsign → region ─────────────────────────────────────────────────────────
const PREFIX_TABLE = [
  ['W1','ENA'],['W2','ENA'],['W3','ENA'],['W4','ENA'],['W8','ENA'],
  ['K1','ENA'],['K2','ENA'],['K3','ENA'],['K4','ENA'],['K8','ENA'],
  ['N1','ENA'],['N2','ENA'],['N3','ENA'],['N4','ENA'],['N8','ENA'],
  ['VE1','ENA'],['VE2','ENA'],['VE3','ENA'],['VE9','ENA'],['VA1','ENA'],['VA2','ENA'],['VA3','ENA'],
  ['KP2','CAR'],['KP4','CAR'],['WP2','CAR'],['WP4','CAR'],['NP2','CAR'],['NP4','CAR'],['VP9','CAR'],
  ['VP2E','CAR'],['VP2V','CAR'],['VP2M','CAR'],['VP5','CAR'],['PJ','CAR'],['ZF','CAR'],['C6','CAR'],
  ['V2','CAR'],['V3','CAR'],['V4','CAR'],['J3','CAR'],['J6','CAR'],['J7','CAR'],['J8','CAR'],['6Y','CAR'],
  ['8P','CAR'],['9Y','CAR'],['9Z','CAR'],['FG','CAR'],['FM','CAR'],['FS','CAR'],['FJ','CAR'],
  ['CO','CAR'],['CL','CAR'],['CM','CAR'],['T4','CAR'],['HH','CAR'],['HI','CAR'],
  ['W0','CNA'],['W5','CNA'],['W9','CNA'],['K0','CNA'],['K5','CNA'],['K9','CNA'],['N0','CNA'],['N5','CNA'],['N9','CNA'],
  ['VE4','CNA'],['VE5','CNA'],['VE6','CNA'],['VA4','CNA'],['VA5','CNA'],['VA6','CNA'],
  ['XE','CNA'],['TI','CNA'],['YN','CNA'],['HR','CNA'],['TG','CNA'],['YS','CNA'],
  ['W6','WNA'],['W7','WNA'],['K6','WNA'],['K7','WNA'],['N6','WNA'],['N7','WNA'],
  ['VE7','WNA'],['VA7','WNA'],['VY1','WNA'],['KH6','WNA'],['KL','WNA'],['WL','WNA'],['NL','WNA'],['AL','WNA'],
  ['PY','SA'],['PP','SA'],['LU','SA'],['CE','SA'],['OA','SA'],['HC','SA'],['HK','SA'],
  ['YV','SA'],['YY','SA'],['CX','SA'],['ZP','SA'],['CP','SA'],['GY','SA'],['PZ','SA'],['FY','SA'],['VP8','SA'],
  ['GM','EU'],['GW','EU'],['GI','EU'],['GD','EU'],['GJ','EU'],['GU','EU'],['G','EU'],['M','EU'],
  ['F','EU'],['DL','EU'],['DJ','EU'],['DK','EU'],['OE','EU'],['PA','EU'],['ON','EU'],
  ['SM','EU'],['SA','EU'],['OH','EU'],['LA','EU'],['OZ','EU'],['TF','EU'],['EI','EU'],
  ['HB','EU'],['LX','EU'],['IK','EU'],['IW','EU'],['IZ','EU'],['I','EU'],
  ['EA','EU'],['CT','EU'],['SP','EU'],['OK','EU'],['OM','EU'],['HA','EU'],
  ['YO','EU'],['LZ','EU'],['SV','EU'],['TA','EU'],['UR','EU'],['EU','EU'],['EW','EU'],
  ['RA','EU'],['RU','EU'],['UA1','EU'],['UA2','EU'],['UA3','EU'],['UA4','EU'],['UA6','EU'],
  ['YU','EU'],['9A','EU'],['S5','EU'],['Z3','EU'],['E7','EU'],['YL','EU'],['LY','EU'],['ES','EU'],['ER','EU'],
  ['ZS','AF'],['ZT','AF'],['ZU','AF'],['EA8','AF'],['EA9','AF'],['CN','AF'],['7X','AF'],['TS','AF'],
  ['SU','AF'],['ST','AF'],['ET','AF'],['5Z','AF'],['5X','AF'],['9J','AF'],
  ['V5','AF'],['7P','AF'],['7Q','AF'],['C9','AF'],['D2','AF'],['TY','AF'],['5U','AF'],
  ['9G','AF'],['9L','AF'],['TU','AF'],['TR','AF'],['TN','AF'],['9Q','AF'],['5B','AF'],
  ['JA','AS'],['JH','AS'],['JK','AS'],['JR','AS'],['HL','AS'],['DS','AS'],
  ['BY','AS'],['BG','AS'],['BT','AS'],['BV','AS'],['VR','AS'],
  ['UA9','AS'],['UA0','AS'],['R9','AS'],['R0','AS'],
  ['4X','AS'],['4Z','AS'],['9K','AS'],['HZ','AS'],['A6','AS'],['A4','AS'],['A7','AS'],
  ['AP','AS'],['VU','AS'],['AT','AS'],['9M','AS'],['HS','AS'],['XV','AS'],['YB','AS'],['PK','AS'],
  ['VK','OC'],['ZL','OC'],['ZM','OC'],['DU','OC'],['YJ','OC'],['3D2','OC'],['FO','OC'],
  ['FK','OC'],['A3','OC'],['E5','OC'],['P2','OC'],['H4','OC'],['KH8','OC'],['5W','OC'],['V6','OC'],['V7','OC'],
].sort((a, b) => b[0].length - a[0].length);

function classifyCall(call) {
  if (!call) return null;
  const raw = String(call).toUpperCase().trim();
  const parts = raw.split('/').map(s => s.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const candidates = parts.length ? parts : [raw];
  for (const c of candidates) {
    for (const [pfx, key] of PREFIX_TABLE) if (c.startsWith(pfx)) return key;
  }
  for (const c of candidates) {
    if (!/^[WKN]/.test(c)) continue;
    for (const ch of c) {
      if (ch >= '0' && ch <= '9') {
        const d = parseInt(ch);
        if (d === 0 || d === 5 || d === 9) return 'CNA';
        if (d === 6 || d === 7) return 'WNA';
        return 'ENA';
      }
    }
  }
  return null;
}

// ── Grid → lat/lon ────────────────────────────────────────────────────────────
function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const f1 = g.charCodeAt(0) - 65, f2 = g.charCodeAt(1) - 65;
  const s1 = parseInt(g[2]), s2 = parseInt(g[3]);
  if (f1 < 0 || f1 > 17 || f2 < 0 || f2 > 17 || isNaN(s1) || isNaN(s2)) return null;
  let lon = f1 * 20 - 180 + s1 * 2 + 1;
  let lat = f2 * 10 - 90  + s2 * 1 + 0.5;
  if (g.length >= 6) {
    const ss1 = g.charCodeAt(4) - 65, ss2 = g.charCodeAt(5) - 65;
    if (ss1 >= 0 && ss1 < 24 && ss2 >= 0 && ss2 < 24) {
      lon += ss1 * (2/24) - (1 - 1/24);
      lat += ss2 * (1/24) - (0.5 - 1/48);
    }
  }
  return { lat, lon };
}

// ── Haversine distance ────────────────────────────────────────────────────────
function haversineMiles(la1, lo1, la2, lo2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (la2 - la1) * toR, dLon = (lo2 - lo1) * toR;
  const a = Math.sin(dLat/2)**2 + Math.cos(la1*toR)*Math.cos(la2*toR)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Country centroids ─────────────────────────────────────────────────────────
const CENTROIDS = [
  ['G',[51.5,-1]],['F',[46.2,2.2]],['DL',[51.2,10.5]],['OE',[47.5,14.5]],
  ['PA',[52.1,5.3]],['ON',[50.5,4.5]],['SM',[60.1,18.6]],['OH',[64,26]],
  ['LA',[64.6,17]],['OZ',[56.3,9.5]],['TF',[65,-19]],['EI',[53.4,-8.2]],
  ['HB',[46.8,8.2]],['I',[42.5,12.6]],['EA',[40.4,-3.7]],['CT',[39.4,-8.2]],
  ['SP',[51.9,19.2]],['OK',[49.8,15.5]],['OM',[48.7,19.7]],['HA',[47.2,19.4]],
  ['YO',[45.9,25]],['LZ',[42.7,25.5]],['SV',[39.1,21.8]],['TA',[39.1,35.2]],
  ['UR',[49,31.5]],['RA',[61.5,60]],['UA9',[62,80]],['JA',[36.2,138.3]],
  ['HL',[36.5,128]],['BY',[35.9,104.2]],['BG',[35.9,104.2]],['VU',[20.6,79.1]],
  ['9M',[3.8,108.3]],['HS',[15.9,101]],['YB',[-2.5,118]],['VK',[-25.3,133.8]],
  ['ZL',[-41.3,174.8]],['DU',[12.9,121.8]],['PY',[-14.2,-51.9]],['LU',[-34,-64]],
  ['CE',[-35.7,-71.5]],['HK',[4.6,-74.3]],['YV',[6.4,-66.6]],
  ['ZS',[-29,25.1]],['ET',[9.2,40.5]],['5Z',[-0.02,37.9]],
  ['KH6',[20.8,-156.3]],['KL',[64.2,-153]],['W1',[42.4,-71]],['W2',[40.7,-74]],
  ['W3',[39.9,-75.2]],['W4',[35,-85]],['W5',[35,-98]],['W6',[37,-120]],
  ['W7',[44,-113]],['W8',[40,-83]],['W9',[41.9,-87.6]],['W0',[39,-98]],
  ['VE1',[45,-63]],['VE2',[52,-72]],['VE3',[44,-79]],['VE4',[50,-98]],
  ['VE5',[52,-106]],['VE6',[54,-115]],['VE7',[50,-123]],
].sort((a,b) => b[0].length - a[0].length);

function centroidFor(call) {
  const c = call.toUpperCase().split('/')[0];
  for (const [pfx, ll] of CENTROIDS) if (c.startsWith(pfx)) return { lat: ll[0], lon: ll[1] };
  return null;
}

// ── Mode quality helpers ──────────────────────────────────────────────────────
function emptyModeQuality() {
  return { CW: null, SSB: null, RTTY: null, FTx: null };
}

function qualityFractionForMode(metric, snr) {
  if (metric === 'SSB') return Math.min(snr / SSB_THRESHOLD, 1);
  return Math.min(snr / MAX_SNR, 1);
}

function snrToSUnit(snr) {
  if (!Number.isFinite(snr) || snr < 0) return 'S0';
  const units = [
    [0,3,'S0'],[3,6,'S1'],[6,9,'S2'],[9,12,'S3'],[12,15,'S4'],
    [15,18,'S5'],[18,21,'S6'],[21,24,'S7'],[24,27,'S8'],[27,30,'S9'],
    [30,36,'S9+10'],[36,42,'S9+20'],[42,48,'S9+30'],[48,Infinity,'S9+40'],
  ];
  for (const [lo, hi, label] of units) if (snr >= lo && snr < hi) return label;
  return 'S9+40';
}

// ── PSK / FTx helpers ─────────────────────────────────────────────────────────
function ftxSnrToRbnScale(ftxSnr) {
  if (!Number.isFinite(ftxSnr)) return null;
  return ((ftxSnr + 24) / 48) * 35 + 3;
}

function pskEntryForQuery(pskSnapshot, queryCtx, band) {
  if (!pskSnapshot) return null;
  const { mode, fromKey, toKey, grid, gridLL, radiusMiles } = queryCtx;
  if (mode === 'region') return pskSnapshot?.[fromKey]?.[toKey]?.[band] || null;
  if (!gridLL) return null;
  let best = null, bestD = Infinity;
  for (const [pfx, [lat, lon]] of CENTROIDS) {
    const d = haversineMiles(gridLL.lat, gridLL.lon, lat, lon);
    if (d < radiusMiles && d < bestD) { bestD = d; best = pfx; }
  }
  if (!best) return null;
  const fromRegion = classifyCall(best);
  if (!fromRegion) return null;
  return pskSnapshot?.[fromRegion]?.[toKey]?.[band] || null;
}

function mergePskIntoResult(baseResult, pskEntry, queryCtx) {
  if (!pskEntry || !Number.isFinite(pskEntry.snr)) return baseResult;
  const ftxScaled = ftxSnrToRbnScale(pskEntry.snr);
  if (!Number.isFinite(ftxScaled)) return baseResult;
  const r = { ...baseResult };
  if (r.hasData) {
    r.snr = r.snr * 0.85 + ftxScaled * 0.15;
  } else {
    r.snr     = ftxScaled;
    r.hasData = true;
  }
  r.snr = Math.max(0, r.snr);
  r.modes = new Set(r.modes);
  r.modes.add('FT8');
  r.ftxCount = (pskEntry.count || 1);
  if (r.modeQuality) r.modeQuality.FTx = pskEntry.snr;
  return r;
}

// ── RBN data fetch ────────────────────────────────────────────────────────────
function fetchRbn() {
  const transport = RBN_URL.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(RBN_URL, { headers: { 'User-Agent': 'hfsignals-badge/2.0' }, timeout: 12000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          // Proxy returns a flat object keyed by "dxcall|band" (spotMap format)
          // OR the raw HamQTH passthrough (same shape but freq has spaces: "14 039.5").
          // Normalise both to { spots: [ { dxCall, freq, mode, lsn }, ... ] }
          if (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.spots) {
            const spots = Object.values(raw).map(s => ({
              dxCall: s.dxcall || s.dxCall || '',
              // HamQTH freq may have spaces ("14 039.5") — strip them before parsing
              freq:   parseFloat(String(s.freq).replace(/\s/g, '')),
              mode:   s.mode  || '',
              lsn:    s.lsn   || {},
            })).filter(s => s.dxCall && Number.isFinite(s.freq));
            console.log(`[badge] fetchRbn: ${spots.length} spots normalised`);
            if (spots.length > 0) {
              const s0 = spots[0];
              console.log(`[badge] sample spot: dxCall=${s0.dxCall} freq=${s0.freq} mode=${s0.mode} lsn_keys=${Object.keys(s0.lsn||{}).slice(0,3).join(',')}`);
            }
            resolve({ spots });
          } else {
            console.log('[badge] fetchRbn: raw already has spots array, len=', (raw.spots||[]).length);
            resolve(raw);
          }
        }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('RBN fetch timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function getRbnData() {
  const now = Date.now();
  if (rbnData && (now - rbnFetchedAt) < DATA_TTL_MS) return rbnData;
  if (rbnFetching) {
    await new Promise(r => setTimeout(r, 500));
    return rbnData;
  }
  rbnFetching = true;
  try {
    rbnData     = await fetchRbn();
    rbnFetchedAt = Date.now();
    return rbnData;
  } catch (e) {
    console.error('RBN fetch failed:', e.message);
    return rbnData;
  } finally { rbnFetching = false; }
}

// ── PSK data fetch ────────────────────────────────────────────────────────────
function fetchPsk() {
  const transport = PSK_URL.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(PSK_URL, { headers: { 'User-Agent': 'hfsignals-badge/2.0' }, timeout: 25000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('PSK fetch timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function getPskData() {
  const now = Date.now();
  if (pskData && (now - pskFetchedAt) < DATA_TTL_MS * 5) return pskData;
  if (pskFetching) { await new Promise(r => setTimeout(r, 500)); return pskData; }
  pskFetching = true;
  try {
    pskData     = await fetchPsk();
    pskFetchedAt = Date.now();
    return pskData;
  } catch (e) {
    console.error('PSK fetch failed:', e.message);
    return pskData;
  } finally { pskFetching = false; }
}

// ── History data fetch ────────────────────────────────────────────────────────
async function fetchHistory(vantage) {
  const u = `${HIST_URL}?vantage=${encodeURIComponent(vantage)}`;
  const transport = u.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(u, { headers: { 'User-Agent': 'hfsignals-badge/2.0' }, timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('history fetch timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Compute band result from RBN data ─────────────────────────────────────────
function bandForFreq(freqKhz) {
  for (const b of BANDS) if (freqKhz >= b.min && freqKhz <= b.max) return b.label;
  return null;
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}

function computeRegionBand(data, fromKey, toKey, bandLabel) {
  const spots = data?.spots || [];
  console.log(`[badge] computeRegionBand ${fromKey}→${toKey} ${bandLabel}: total spots=${spots.length}`);
  let dbgBand=0, dbgTo=0;
  for (const sp of spots) {
    if (bandForFreq(sp.freq) === bandLabel) {
      dbgBand++;
      if (classifyCall(sp.dxCall) === toKey) dbgTo++;
    }
  }
  console.log(`[badge]   band match=${dbgBand} toKey match=${dbgTo}`);
  const snrs  = [], modes = new Set();
  const modeQuality = emptyModeQuality();
  const modeSnrs    = { CW: [], SSB: [], RTTY: [], FTx: [] };
  let rbnCount = 0;

  for (const spot of spots) {
    if (bandForFreq(spot.freq) !== bandLabel) continue;
    if (classifyCall(spot.dxCall) !== toKey) continue;
    for (const [spotter, snrVal] of Object.entries(spot.lsn || {})) {
      if (classifyCall(spotter) !== fromKey) continue;
      const snr = Number(snrVal);
      if (!Number.isFinite(snr)) continue;
      snrs.push(snr); rbnCount++;
      const m = (spot.mode || '').toUpperCase();
      if (m.includes('CW'))   { modes.add('CW');   modeSnrs.CW.push(snr);   }
      else if (m.includes('SSB')) { modes.add('SSB');  modeSnrs.SSB.push(snr);  }
      else if (m.includes('RTTY')){ modes.add('RTTY'); modeSnrs.RTTY.push(snr); }
    }
  }

  const med = median(snrs);
  if (Number.isFinite(modeSnrs.CW.length   && median(modeSnrs.CW  ))) modeQuality.CW   = median(modeSnrs.CW);
  if (Number.isFinite(modeSnrs.SSB.length  && median(modeSnrs.SSB ))) modeQuality.SSB  = median(modeSnrs.SSB);
  if (Number.isFinite(modeSnrs.RTTY.length && median(modeSnrs.RTTY))) modeQuality.RTTY = median(modeSnrs.RTTY);
  ['CW','SSB','RTTY'].forEach(k => {
    const v = median(modeSnrs[k]);
    if (Number.isFinite(v)) modeQuality[k] = v;
  });

  return {
    snr: Number.isFinite(med) ? Math.max(0, med) : 0,
    hasData: Number.isFinite(med),
    modes,
    modeQuality,
    rbnCount,
    ftxCount: 0,
  };
}

function computeGridBand(data, grid, radiusMiles, toKey, bandLabel) {
  const gridLL = gridToLatLon(grid);
  if (!gridLL) return { snr: 0, hasData: false, modes: new Set(), modeQuality: emptyModeQuality(), rbnCount: 0, ftxCount: 0 };

  const spots = data?.spots || [];
  const snrs  = [], modes = new Set();
  const modeQuality = emptyModeQuality();
  const modeSnrs    = { CW: [], SSB: [], RTTY: [] };
  let rbnCount = 0;

  for (const spot of spots) {
    if (bandForFreq(spot.freq) !== bandLabel) continue;
    if (classifyCall(spot.dxCall) !== toKey) continue;
    for (const [spotter, snrVal] of Object.entries(spot.lsn || {})) {
      const cen = centroidFor(spotter);
      if (!cen) continue;
      if (haversineMiles(gridLL.lat, gridLL.lon, cen.lat, cen.lon) > radiusMiles) continue;
      const snr = Number(snrVal);
      if (!Number.isFinite(snr)) continue;
      snrs.push(snr); rbnCount++;
      const m = (spot.mode || '').toUpperCase();
      if (m.includes('CW'))    { modes.add('CW');   modeSnrs.CW.push(snr);   }
      else if (m.includes('SSB'))  { modes.add('SSB');  modeSnrs.SSB.push(snr);  }
      else if (m.includes('RTTY')) { modes.add('RTTY'); modeSnrs.RTTY.push(snr); }
    }
  }

  const med = median(snrs);
  ['CW','SSB','RTTY'].forEach(k => {
    const v = median(modeSnrs[k]);
    if (Number.isFinite(v)) modeQuality[k] = v;
  });
  return {
    snr: Number.isFinite(med) ? Math.max(0, med) : 0,
    hasData: Number.isFinite(med),
    modes,
    modeQuality,
    rbnCount,
    ftxCount: 0,
  };
}

// ── Seg bar color (matches PWA) ───────────────────────────────────────────────
function segColor(i, t) {
  const frac = (i + 1) / RM_SEG;
  if (frac < 0.60) return t.green;
  if (frac < 0.80) return t.yellow;
  return t.red;
}

// ── Draw one band row ─────────────────────────────────────────────────────────
// y = top of this row within the canvas
function drawBandRow(ctx, y, bandLabel, result, t) {
  const { snr, hasData } = result;
  const rowX = 0;
  const W    = RM_W;

  // Row background (alternating) — subtle, not in CSS but nice for readability
  // (just use bg, no alternating)

  // Band label — left column, accent colored, bold 11px, width 34px
  ctx.fillStyle    = t.accent;
  ctx.font         = 'bold 11px "DejaVu Sans Mono"';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(bandLabel, rowX + RM_PAD, y + RM_ROW / 2);

  // S-unit — right column, 36px wide
  const sStr = hasData ? snrToSUnit(snr) : '--';
  ctx.fillStyle    = hasData ? t.green : t.noData;
  ctx.font         = 'bold 9px "DejaVu Sans Mono"';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(sStr, W - RM_PAD, y + RM_ROW / 2);

  // Bar — between label and s-unit
  const barX = RM_PAD + RM_LABEL_W;
  const barW = W - RM_PAD * 2 - RM_LABEL_W - RM_SUNIT_W;
  const barY = y + (RM_ROW - RM_BAR_H) / 2;

  // Bar background + border (matches .bar-wrap)
  ctx.fillStyle = t.dimSeg;
  ctx.fillRect(barX, barY, barW, RM_BAR_H);
  ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.25)`;
  ctx.lineWidth   = 1;
  ctx.strokeRect(barX - 0.5, barY - 0.5, barW + 1, RM_BAR_H + 1);

  if (hasData) {
    const gap  = 1;
    const segW = (barW - gap * (RM_SEG - 1)) / RM_SEG;
    const lit  = Math.round(Math.min(snr / MAX_SNR, 1) * RM_SEG);
    for (let i = 0; i < RM_SEG; i++) {
      const sx = barX + i * (segW + gap);
      ctx.fillStyle = i < lit ? segColor(i, t) : t.dimSeg;
      ctx.fillRect(sx, barY, segW, RM_BAR_H);
    }
  }
}

// Helper: parse "#rrggbb" → "r,g,b" string for rgba()
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0,2),16);
  const g = parseInt(h.slice(2,4),16);
  const b = parseInt(h.slice(4,6),16);
  return `${r},${g},${b}`;
}

// ── Render region-meter badge ─────────────────────────────────────────────────
function renderRegionMeter(params) {
  const {
    allResults, fromLabel, toLabel, vantageDesc, theme, dataAge, rbnCount, ftxCount,
  } = params;
  const t      = THEMES[theme] || THEMES.dark;
  const canvas = createCanvas(RM_W, RM_H);
  const ctx    = canvas.getContext('2d');

  // ── Background ──────────────────────────────────────────────────────────
  ctx.fillStyle = t.bg2;
  ctx.fillRect(0, 0, RM_W, RM_H);

  // ── Header (46px) — two-line: destination + vantage description ────────
  ctx.fillStyle = t.bg2;
  ctx.fillRect(0, 0, RM_W, RM_HDR);
  // header bottom border
  ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.30)`;
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(0, RM_HDR - 0.5); ctx.lineTo(RM_W, RM_HDR - 0.5); ctx.stroke();

  // Line 1: destination region name — bold accent 12px
  ctx.fillStyle    = t.accent;
  ctx.font         = 'bold 12px "DejaVu Sans Mono"';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(toLabel, RM_W / 2, 13, RM_W - 8);

  // Line 2: vantage description — dimmer, 9px
  ctx.fillStyle    = t.text;
  ctx.font         = '9px "DejaVu Sans Mono"';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(vantageDesc, RM_W / 2, 32, RM_W - 8);

  // ── Band rows (10 × 26px) ────────────────────────────────────────────────
  const bandRowsY = RM_HDR;
  for (let i = 0; i < BANDS.length; i++) {
    const y = bandRowsY + i * RM_ROW;
    // subtle row separator
    if (i > 0) {
      ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.08)`;
      ctx.lineWidth   = 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(RM_W, y); ctx.stroke();
    }
    drawBandRow(ctx, y, BANDS[i].label, allResults[i], t);
  }

  // ── Footer (20px) — skimmer/FTx counts ───────────────────────────────────
  const ftrY = RM_HDR + BANDS.length * RM_ROW;
  ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.15)`;
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(0, ftrY + 0.5); ctx.lineTo(RM_W, ftrY + 0.5); ctx.stroke();
  ctx.fillStyle    = t.textDim;
  ctx.font         = '8px "DejaVu Sans Mono"';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  const ageStr  = dataAge < 120 ? `${dataAge}s ago` : `${Math.floor(dataAge/60)}m ago`;
  const ftrText = rbnCount || ftxCount
    ? `RBN:${rbnCount}  FTx:${ftxCount}  · ${ageStr}`
    : `no data · ${ageStr}`;
  ctx.fillText(ftrText, RM_W / 2, ftrY + RM_FTR / 2, RM_W - 8);

  // ── Branding bar (22px) — HFSIGNALS.LIVE prominent ───────────────────────
  const brdY = ftrY + RM_FTR;
  ctx.fillStyle = t.brandBg;
  ctx.fillRect(0, brdY, RM_W, RM_BRD);
  // top border of branding bar
  ctx.strokeStyle = t.border;
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(0, brdY + 0.5); ctx.lineTo(RM_W, brdY + 0.5); ctx.stroke();
  ctx.fillStyle    = t.brandFg;
  ctx.font         = 'bold 11px "DejaVu Sans Mono"';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('HFSIGNALS.LIVE', RM_W / 2, brdY + RM_BRD / 2);

  // ── Outer border ─────────────────────────────────────────────────────────
  ctx.strokeStyle = t.border;
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, RM_W - 1, RM_H - 1);

  return canvas.toBuffer('image/png');
}

// ── Render warming/no-data region meter ──────────────────────────────────────
function renderRegionMeterWarmup(theme, vantageDesc = '', msg = 'Warming up… retry in ~30s') {
  const t      = THEMES[theme] || THEMES.dark;
  const canvas = createCanvas(RM_W, RM_H);
  const ctx    = canvas.getContext('2d');

  ctx.fillStyle = t.bg2;
  ctx.fillRect(0, 0, RM_W, RM_H);

  // Empty band rows
  for (let i = 0; i < BANDS.length; i++) {
    const y = RM_HDR + i * RM_ROW;
    ctx.fillStyle = t.noData;
    ctx.font      = '8px "DejaVu Sans Mono"';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(BANDS[i].label, RM_PAD, y + RM_ROW / 2);
    ctx.fillStyle = t.dimSeg;
    ctx.fillRect(RM_PAD + RM_LABEL_W, y + (RM_ROW - RM_BAR_H) / 2, RM_W - RM_PAD * 2 - RM_LABEL_W - RM_SUNIT_W, RM_BAR_H);
  }

  ctx.fillStyle = t.textDim; ctx.font = '9px "DejaVu Sans Mono"';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle    = t.textDim;
  ctx.font         = '9px "DejaVu Sans Mono"';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  if (vantageDesc) ctx.fillText(vantageDesc, RM_W / 2, 32, RM_W - 8);
  ctx.fillText(msg, RM_W / 2, RM_HDR + (BANDS.length * RM_ROW) / 2);

  const brdY = RM_HDR + BANDS.length * RM_ROW + RM_FTR;
  ctx.fillStyle = t.brandBg;
  ctx.fillRect(0, brdY, RM_W, RM_BRD);
  ctx.strokeStyle = t.border; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, brdY + 0.5); ctx.lineTo(RM_W, brdY + 0.5); ctx.stroke();
  ctx.fillStyle = t.brandFg; ctx.font = 'bold 11px "DejaVu Sans Mono"';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('HFSIGNALS.LIVE', RM_W / 2, brdY + RM_BRD / 2);
  ctx.strokeStyle = t.border;
  ctx.strokeRect(0.5, 0.5, RM_W - 1, RM_H - 1);

  return canvas.toBuffer('image/png');
}

// ── Render history map ────────────────────────────────────────────────────────
function renderHistoryMap(histData, theme, sizeKey) {
  const t  = THEMES[theme] || THEMES.dark;
  const sz = HISTMAP_SIZES[sizeKey] || HISTMAP_SIZES.md;
  const W  = sz.W, H = sz.H;

  // Margins — same ratio as app.js HM
  const pl = 32, pr = 8, pt = 10, pb = 30;
  const cw = W - pl - pr;
  const ch = H - pt - pb;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);

  const pts  = (histData && histData.points) || [];
  const now  = Math.floor(Date.now() / 1000);
  const start = now - HIST_WINDOW_S;

  // ── Y-axis grid lines + labels ───────────────────────────────────────────
  ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.18)`;
  ctx.lineWidth   = 0.5;
  ctx.font        = '8px "DejaVu Sans Mono"';
  ctx.fillStyle   = t.textDim;
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';
  for (const db of [0, 15, 30, 45, 60]) {
    const y = pt + ch - (db / HIST_SNR_MAX) * ch;
    ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(pl + cw, y); ctx.stroke();
    ctx.fillText(String(db), pl - 3, y);
  }

  // ── X-axis time ticks ────────────────────────────────────────────────────
  const TICK_IV = 4 * 3600;
  const firstTick = Math.ceil(start / TICK_IV) * TICK_IV;
  ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.30)`;
  ctx.lineWidth   = 0.5;
  ctx.fillStyle   = t.textDim;
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'top';
  for (let ts = firstTick; ts <= now; ts += TICK_IV) {
    const x = pl + ((ts - start) / HIST_WINDOW_S) * cw;
    ctx.beginPath(); ctx.moveTo(x, pt + ch); ctx.lineTo(x, pt + ch + 3); ctx.stroke();
    const d  = new Date(ts * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    ctx.fillText(`${hh}:00`, x, pt + ch + 4);
  }

  // ── Axes ─────────────────────────────────────────────────────────────────
  ctx.strokeStyle = `rgba(${hexToRgb(t.border)},0.55)`;
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(pl, pt); ctx.lineTo(pl, pt + ch); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pl, pt + ch); ctx.lineTo(pl + cw, pt + ch); ctx.stroke();

  // ── Data lines ───────────────────────────────────────────────────────────
  const byBand = {};
  for (const b of HIST_BANDS) byBand[b] = [];
  for (const p of pts) {
    if (byBand[p.band]) {
      byBand[p.band].push({ ts: p.ts, snr: Math.max(0, Math.min(p.snr, HIST_SNR_MAX)) });
    }
  }

  for (let bi = 0; bi < HIST_BANDS.length; bi++) {
    const band   = HIST_BANDS[bi];
    const color  = HIST_BAND_COLORS[bi];
    const series = byBand[band];
    if (series.length < 2) continue;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    let first = true;
    for (const { ts, snr } of series) {
      const x = pl + ((ts - start) / HIST_WINDOW_S) * cw;
      const y = pt + ch - (snr / HIST_SNR_MAX) * ch;
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const legendY   = pt + ch + 18;
  const itemW     = 38;
  const maxPerRow = Math.max(1, Math.floor(cw / itemW));
  ctx.font        = '8px "DejaVu Sans Mono"';
  for (let i = 0; i < HIST_BANDS.length; i++) {
    const band    = HIST_BANDS[i];
    const color   = HIST_BAND_COLORS[i];
    const col     = i % maxPerRow;
    const row     = Math.floor(i / maxPerRow);
    const lx      = pl + col * itemW;
    const ly      = legendY + row * 11;
    const hasData = byBand[band].length >= 2;
    ctx.globalAlpha = hasData ? 1 : 0.3;
    ctx.fillStyle   = color;
    ctx.fillRect(lx, ly - 5, 8, 4);
    ctx.fillStyle    = t.text;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(band, lx + 10, ly - 1);
    ctx.globalAlpha  = 1;
  }

  if (pts.length === 0) {
    ctx.fillStyle    = t.textDim;
    ctx.font         = '10px "DejaVu Sans Mono"';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No history yet — collecting data…', pl + cw / 2, pt + ch / 2);
  }

  // ── Outer border ──────────────────────────────────────────────────────────
  ctx.strokeStyle = t.border;
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  return canvas.toBuffer('image/png');
}

// ── Legacy small/full badge (backward compat) ─────────────────────────────────
const SIZE_ALIASES = { small:'small',sm:'small',full:'full',large:'full',lg:'full' };

function renderLegacyBadge(params) {
  const {
    snr, modes, hasData, modeQuality, rbnCount, ftxCount,
    fromLabel, toLabel, bandLabel, theme, size, dataAge,
  } = params;
  const t = THEMES[theme] || THEMES.dark;
  const small = size === 'small';
  const W = small ? 220 : 380, H = small ? 56 : 80;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  drawLegacyPanel(ctx, {
    snr, modes, hasData, modeQuality, rbnCount, ftxCount,
    fromLabel, toLabel, bandLabel, dataAge, t, small, W, H, x: 0, y: 0,
  });
  return canvas.toBuffer('image/png');
}

function renderLegacyAllBands(params) {
  const { allResults, fromLabel, toLabel, theme, dataAge } = params;
  const t = THEMES[theme] || THEMES.dark;
  const CW = 220, CH = 56, COLS = 5, ROWS = 2;
  const W = CW * COLS, H = CH * ROWS;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
  BANDS.forEach((band, i) => {
    const r = allResults[i] || { snr:0, modes:new Set(), hasData:false, modeQuality:emptyModeQuality(), rbnCount:0, ftxCount:0 };
    drawLegacyPanel(ctx, {
      snr:r.snr, modes:r.modes, hasData:r.hasData, modeQuality:r.modeQuality,
      rbnCount:r.rbnCount, ftxCount:r.ftxCount,
      fromLabel, toLabel, bandLabel:band.label,
      dataAge, t, small:true, W:CW, H:CH, x:(i%COLS)*CW, y:Math.floor(i/COLS)*CH,
    });
  });
  ctx.strokeStyle = t.border; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W-1, H-1);
  return canvas.toBuffer('image/png');
}

function drawLegacyPanel(ctx, { snr, modes, hasData, modeQuality, rbnCount, ftxCount, fromLabel, toLabel, bandLabel, dataAge, t, small, W, H, x, y }) {
  const PAD=small?5:8, titleH=small?13:18, modeH=small?11:13, barH=small?12:16, gap=small?2:3;
  ctx.fillStyle=t.bg; ctx.fillRect(x,y,W,H);
  ctx.strokeStyle=t.border; ctx.lineWidth=1; ctx.strokeRect(x+0.5,y+0.5,W-1,H-1);
  ctx.fillStyle=t.bg2; ctx.fillRect(x+1,y+1,W-2,titleH);
  ctx.fillStyle=t.accent; ctx.font=`bold ${small?8:10}px "DejaVu Sans Mono"`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(`SNR ${fromLabel} to ${toLabel} on ${bandLabel}`, x+W/2, y+1+titleH/2, W-4);
  const modeY=y+titleH+gap+1;
  drawLegacyModeBadges(ctx,x+PAD,modeY,W-PAD*2,modeH,modes,hasData,modeQuality,t,small);
  const barY=modeY+modeH+gap, barW=W-PAD*2;
  drawLegacyBar(ctx,x+PAD,barY,barW,barH,snr,hasData,t);
  ctx.fillStyle=hasData?t.green:t.textDim; ctx.font=`bold ${small?9:12}px "DejaVu Sans Mono"`;
  ctx.textAlign='right'; ctx.textBaseline='middle';
  ctx.fillText(hasData?snrToSUnit(snr):'--',x+W-PAD+(small?0:2),barY+barH/2);
  const ageStr=dataAge<120?`${dataAge}s ago`:`${Math.floor(dataAge/60)}m ago`;
  ctx.fillStyle=t.textDim; ctx.font=`${small?6:7}px "DejaVu Sans Mono"`;
  ctx.textAlign='right'; ctx.textBaseline='alphabetic';
  ctx.fillText(`hfsignals.live · ${ageStr}`,x+W-3,y+H-2);
}

function drawLegacyModeBadges(ctx,x,y,w,h,modes,hasData,modeQuality,t,small) {
  const slots=[
    {label:'CW',sources:['CW'],isSSB:false,metric:'CW'},
    {label:'SSB',sources:['SSB'],isSSB:true,metric:'SSB'},
    {label:'RY',sources:['RTTY'],isSSB:false,metric:'RTTY'},
    {label:'FTx',sources:['FT8','FT4'],isSSB:false,metric:'FTx'},
  ];
  const badgeW=small?28:40, badgeH=h, gapB=small?3:4;
  const totalW=slots.length*badgeW+(slots.length-1)*gapB;
  let bx=x+Math.max(0,(w-totalW)/2);
  ctx.font=`bold ${small?7:9}px "DejaVu Sans Mono"`; ctx.textBaseline='middle';
  slots.forEach(({label,sources,isSSB,metric})=>{
    const active=hasData&&sources.some(s=>modes.has(s));
    let bg,border,fg;
    if(!hasData){bg='transparent';border=t.modeX;fg=t.textDim;}
    else if(active&&isSSB){bg='#7a5500';border='#ffd000';fg='#ffffff';}
    else if(active){bg='#006e3a';border='#00ff99';fg='#ffffff';}
    else if(isSSB){bg='transparent';border=t.textDim;fg=t.textDim;}
    else{bg='transparent';border=t.modeX;fg=t.modeX;}
    if(bg!=='transparent'){ctx.fillStyle=bg;ctx.fillRect(bx,y,badgeW,badgeH);}
    ctx.strokeStyle=border; ctx.lineWidth=0.75; ctx.strokeRect(bx+0.5,y+0.5,badgeW-1,badgeH-1);
    ctx.fillStyle=fg; ctx.textAlign='center';
    let txt=!hasData?label:active?'\u2713'+label:!isSSB?'\u2717'+label:label;
    ctx.fillText(txt,bx+badgeW/2,y+badgeH/2);
    bx+=badgeW+gapB;
  });
}

function drawLegacyBar(ctx,x,y,w,h,snr,hasData,t) {
  ctx.fillStyle=t.dimSeg; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle=t.border; ctx.lineWidth=0.5; ctx.strokeRect(x-0.5,y-0.5,w+1,h+1);
  if(!hasData) return;
  const SEG=15,gap=1,segW=(w-gap*(SEG-1))/SEG;
  const lit=Math.round(Math.min(snr/MAX_SNR,1)*SEG);
  for(let i=0;i<SEG;i++){
    ctx.fillStyle=i<lit?segColor(i,t):t.dimSeg;
    ctx.fillRect(x+i*(segW+gap),y,segW,h);
  }
}

function renderLegacyWarmup(theme,size) {
  const t=THEMES[theme]||THEMES.dark;
  const W=size==='small'?220:380, H=size==='small'?56:80;
  const canvas=createCanvas(W,H); const ctx=canvas.getContext('2d');
  ctx.fillStyle=t.bg; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle=t.border; ctx.lineWidth=1; ctx.strokeRect(0.5,0.5,W-1,H-1);
  ctx.fillStyle=t.bg2; ctx.fillRect(1,1,W-2,size==='small'?13:18);
  ctx.fillStyle=t.accent; ctx.font=`bold ${size==='small'?8:10}px "DejaVu Sans Mono"`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('HFSIGNALS.LIVE',W/2,size==='small'?7:10);
  ctx.fillStyle=t.textDim; ctx.font='9px "DejaVu Sans Mono"';
  ctx.textBaseline='middle';
  ctx.fillText('Warming up… retry in ~30s',W/2,H/2+4);
  return canvas.toBuffer('image/png');
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    res.end(); return;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const q        = parsed.query;

  // ── Health ───────────────────────────────────────────────────────────────
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rbnAge: Math.round((Date.now() - rbnFetchedAt) / 1000),
      pskAge: pskFetchedAt ? Math.round((Date.now() - pskFetchedAt) / 1000) : null,
    })); return;
  }

  // ── History map endpoint ─────────────────────────────────────────────────
  if (pathname === '/historymap') {
    const theme   = parseTheme(q.theme);
    const sizeKey = (['sm','md','lg'].includes(q.size)) ? q.size : 'md';
    const vantage = (q.vantage || 'ENA').toUpperCase();
    const cacheKey = `hmap|${vantage}|${theme}|${sizeKey}`;

    const now    = Date.now();
    const cached = pngCache.get(cacheKey);
    if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
      sendPng(res, cached.png, now - cached.createdAt, false); return;
    }

    let histData = null;
    try { histData = await fetchHistory(vantage); } catch (e) { console.warn('history fetch:', e.message); }
    const png = renderHistoryMap(histData, theme, sizeKey);
    pngCache.set(cacheKey, { png, createdAt: now });
    sendPng(res, png, 0, false); return;
  }

  // ── Region-meter badge (new) + legacy aliases ────────────────────────────
  const isRegionPath = ['/badge/region','/badges/region','/hfsignals/region'].includes(pathname);
  const isGridPath   = ['/badge/grid',  '/badges/grid',  '/hfsignals/grid'  ].includes(pathname);

  if (!isRegionPath && !isGridPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found.\n  /badge/region?from=ENA&to=EU&theme=dark|light|cr\n  /badge/grid?grid=FN42&radius=500&to=EU&theme=dark|light|cr\n  /historymap?vantage=ENA&size=sm|md|lg&theme=dark|light|cr');
    return;
  }

  const theme  = parseTheme(q.theme);
  const bandRaw = (q.band || '20m').toLowerCase();
  const isAllBands = bandRaw === 'all';
  const band    = isAllBands ? 'all' : bandRaw.replace('m','') + 'm';
  const validBands = BANDS.map(b => b.label);
  if (!isAllBands && !validBands.includes(band)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Invalid band. Use: ${validBands.join(', ')}, all`); return;
  }

  // Legacy size param — if present and valid, fall through to legacy renderer
  const sizeRaw  = q.size ? String(q.size).toLowerCase() : null;
  const legacySize = sizeRaw ? SIZE_ALIASES[sizeRaw] : null;
  const useLegacy  = !!legacySize;

  let fromKey, toKey, cacheKey, queryCtx;

  if (isRegionPath) {
    const fromRaw = (q.from || 'ENA').toUpperCase();
    const toRaw   = (q.to   || 'EU' ).toUpperCase();
    fromKey = REGION_ALIASES[fromRaw];
    toKey   = REGION_ALIASES[toRaw];
    if (!fromKey || !toKey) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Invalid region. Use: ${Object.keys(REGION_ALIASES).join(', ')}`); return;
    }
    cacheKey   = useLegacy
      ? `legacy|region|${fromKey}|${toKey}|${band}|${theme}|${legacySize}`
      : `rm|region|${fromKey}|${toKey}|${band}|${theme}`;
    queryCtx = { mode: 'region', fromKey, toKey };
  } else {
    const grid   = (q.grid || '').toUpperCase();
    const radius = parseInt(q.radius) || 500;
    const toRaw  = (q.to || 'EU').toUpperCase();
    toKey        = REGION_ALIASES[toRaw];
    if (!gridToLatLon(grid)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing grid parameter (e.g. ?grid=FN42)'); return;
    }
    if (!toKey) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid to region.'); return;
    }
    fromKey  = `GRID:${grid}:${radius}`;
    cacheKey = useLegacy
      ? `legacy|grid|${grid}|${radius}|${toKey}|${band}|${theme}|${legacySize}`
      : `rm|grid|${grid}|${radius}|${toKey}|${band}|${theme}`;
    queryCtx = { mode:'grid', toKey, grid, gridLL:gridToLatLon(grid), radiusMiles:radius };
  }

  // Cache hit?
  const now    = Date.now();
  const cached = pngCache.get(cacheKey);
  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    sendPng(res, cached.png, now - cached.createdAt, false); return;
  }

  // Fetch data
  const data        = await getRbnData();
  const pskSnapshot = await getPskData();
  const dataAge     = Math.round((now - rbnFetchedAt) / 1000);

  if (!data) {
    const png = useLegacy
      ? renderLegacyWarmup(theme, legacySize)
      : renderRegionMeterWarmup(theme);
    sendPng(res, png, 0, true); return;
  }

  // ── Legacy small/full path ────────────────────────────────────────────────
  if (useLegacy) {
    if (isAllBands) {
      const fromLabel = isRegionPath
        ? (REGIONS.find(r => r.key === fromKey)?.label || fromKey)
        : `Grid ${q.grid?.toUpperCase()}`;
      const toLabel = REGIONS.find(r => r.key === toKey)?.label || toKey;
      const allResults = BANDS.map(b => {
        const base = isRegionPath
          ? computeRegionBand(data, fromKey, toKey, b.label)
          : computeGridBand(data, queryCtx.grid, queryCtx.radiusMiles, toKey, b.label);
        return mergePskIntoResult(base, pskEntryForQuery(pskSnapshot, queryCtx, b.label), queryCtx);
      });
      const png = renderLegacyAllBands({ allResults, fromLabel, toLabel, theme, dataAge });
      pngCache.set(cacheKey, { png, createdAt: now });
      sendPng(res, png, 0, false); return;
    }
    const base   = isRegionPath
      ? computeRegionBand(data, fromKey, toKey, band)
      : computeGridBand(data, queryCtx.grid, queryCtx.radiusMiles, toKey, band);
    const result = mergePskIntoResult(base, pskEntryForQuery(pskSnapshot, queryCtx, band), queryCtx);
    const fromLabel = isRegionPath
      ? (REGIONS.find(r => r.key === fromKey)?.label || fromKey)
      : `Grid ${q.grid?.toUpperCase()}`;
    const toLabel = REGIONS.find(r => r.key === toKey)?.label || toKey;
    const png = renderLegacyBadge({ ...result, fromLabel, toLabel, bandLabel: band, theme, size: legacySize, dataAge });
    pngCache.set(cacheKey, { png, createdAt: now });
    sendPng(res, png, 0, false); return;
  }

  // ── New region-meter path — always shows all 10 bands ────────────────────
  const fromLabel = isRegionPath
    ? (REGIONS.find(r => r.key === fromKey)?.label || fromKey)
    : `Grid ${(q.grid || '').toUpperCase()}`;
  const toLabel = REGIONS.find(r => r.key === toKey)?.label || toKey;

  const allResults = BANDS.map(b => {
    const base = isRegionPath
      ? computeRegionBand(data, fromKey, toKey, b.label)
      : computeGridBand(data, queryCtx.grid, queryCtx.radiusMiles, toKey, b.label);
    return mergePskIntoResult(base, pskEntryForQuery(pskSnapshot, queryCtx, b.label), queryCtx);
  });

  const totals = allResults.reduce((acc, r) => {
    acc.rbn += r.rbnCount || 0;
    acc.ftx += r.ftxCount || 0;
    return acc;
  }, { rbn: 0, ftx: 0 });

  const vantageDesc = queryCtx.mode === 'region'
    ? `Signals heard in ${fromLabel}`
    : `Within ${queryCtx.radiusMiles} mi of ${(q.grid || '').toUpperCase()}`;
  const png = renderRegionMeter({
    allResults, fromLabel, toLabel, vantageDesc, theme, dataAge,
    rbnCount: totals.rbn, ftxCount: totals.ftx,
  });
  pngCache.set(cacheKey, { png, createdAt: now });
  sendPng(res, png, 0, false, { rbnCount: totals.rbn, ftxCount: totals.ftx, pskUsed: !!pskSnapshot });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseTheme(raw) {
  const s = (raw || '').toLowerCase().trim();
  if (s === 'light') return 'light';
  if (s === 'cr' || s === 'cb') return 'cr';  // cb = public alias for cr
  return 'dark';
}

function sendPng(res, png, ageMs, warming, extra = {}) {
  res.writeHead(200, {
    'Content-Type':                'image/png',
    'Content-Length':              png.length,
    'Cache-Control':               'public, max-age=60',
    'Access-Control-Allow-Origin': '*',
    'X-HFSIGNALS-Status':          warming ? 'warming' : 'live',
    'X-HFSIGNALS-Cache-Age':       Math.round(ageMs / 1000),
    'X-HFSIGNALS-RBN-Count':       Number(extra.rbnCount || 0),
    'X-HFSIGNALS-FTx-Count':       Number(extra.ftxCount || 0),
    'X-HFSIGNALS-PSK':             extra.pskUsed ? '1' : '0',
  });
  res.end(png);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`hfsignals badge API v2 listening on 0.0.0.0:${PORT}`);
  getRbnData().then(() => console.log('Initial RBN data fetched.'));
  getPskData().then(() => console.log('Initial PSK data fetched.'));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

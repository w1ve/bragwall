'use strict';

/**
 * RBN S-Meter Badge API
 *
 * Endpoints:
 *   GET /badge/region?from=NA&to=EU&band=20m&theme=dark|light&size=small|full
 *   GET /badge/grid?grid=FN42&radius=500&to=EU&band=20m&theme=dark|light&size=small|full
 *
 * Returns a PNG image suitable for embedding in web pages via <img> tags.
 *
 * Caching:
 *   - RBN data is fetched once and shared across all requests
 *   - Data is refreshed every 60 seconds
 *   - Rendered PNGs are cached per parameter set for up to 10 minutes
 *   - Images older than 30 minutes are deleted
 *
 * Theme:
 *   dark  — #0d0d1a background, teal accent (default)
 *   light — #ffffff background, dark text
 */

const http    = require('http');
const https   = require('https');
const url     = require('url');
const { createCanvas } = require('canvas');

const PORT         = process.env.PORT || 3002;
const DATA_TTL_MS  = 60  * 1000;   // re-fetch RBN data every 60s
const CACHE_TTL_MS = 10  * 60 * 1000;  // reuse rendered PNG for 10 min
const MAX_AGE_MS   = 30  * 60 * 1000;  // delete cached images older than 30 min

// Use the internal proxy which has live RBN telnet feed data
const RBN_URL = process.env.RBN_PROXY_URL || 'http://rbn-smeter:3001/rbn';

// ── Shared RBN data state ─────────────────────────────────────────────────────
let rbnData       = null;   // parsed JSON from last fetch
let rbnFetchedAt  = 0;      // timestamp of last successful fetch
let rbnFetching   = false;  // prevent concurrent fetches

// ── PNG cache ─────────────────────────────────────────────────────────────────
// Map<cacheKey, { png: Buffer, createdAt: number }>
const pngCache = new Map();

setInterval(evictOldCache, 5 * 60 * 1000); // run cleanup every 5 min

function evictOldCache() {
  const now = Date.now();
  for (const [key, entry] of pngCache) {
    if (now - entry.createdAt > MAX_AGE_MS) pngCache.delete(key);
  }
}

// ── Band definitions ──────────────────────────────────────────────────────────
const BANDS = [
  { label: '160m', min: 1800,  max: 2000  },
  { label: '80m',  min: 3500,  max: 4000  },
  { label: '40m',  min: 7000,  max: 7300  },
  { label: '20m',  min: 14000, max: 14350 },
  { label: '15m',  min: 21000, max: 21450 },
  { label: '10m',  min: 28000, max: 29700 },
  { label: '6m',   min: 50000, max: 54000 },
];

// Full prefix table matching the PWA classifier
const PREFIX_TABLE = [
  ['W1','ENA'],['W2','ENA'],['W3','ENA'],['W4','ENA'],['W8','ENA'],['W9','ENA'],
  ['K1','ENA'],['K2','ENA'],['K3','ENA'],['K4','ENA'],['K8','ENA'],['K9','ENA'],
  ['N1','ENA'],['N2','ENA'],['N3','ENA'],['N4','ENA'],['N8','ENA'],['N9','ENA'],
  ['VE1','ENA'],['VE2','ENA'],['VE3','ENA'],['VE9','ENA'],['VA1','ENA'],['VA2','ENA'],['VA3','ENA'],
  ['KP2','ENA'],['KP4','ENA'],['WP4','ENA'],['NP4','ENA'],['VP9','ENA'],['CO','ENA'],['HH','ENA'],['HI','ENA'],
  ['W0','CNA'],['W5','CNA'],['K0','CNA'],['K5','CNA'],['N0','CNA'],['N5','CNA'],
  ['VE4','CNA'],['VE5','CNA'],['XE','CNA'],['TI','CNA'],['YN','CNA'],['HR','CNA'],['TG','CNA'],['YS','CNA'],
  ['W6','WNA'],['W7','WNA'],['K6','WNA'],['K7','WNA'],['N6','WNA'],['N7','WNA'],
  ['VE6','WNA'],['VE7','WNA'],['KH6','WNA'],['KL','WNA'],['WL','WNA'],['NL','WNA'],
  ['PY','SA'],['PP','SA'],['LU','SA'],['CE','SA'],['OA','SA'],['HC','SA'],['HK','SA'],
  ['YV','SA'],['CX','SA'],['ZP','SA'],['CP','SA'],['GY','SA'],['VP8','SA'],
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

const REGIONS = [
  { key: 'ENA', label: 'E. N. America' },
  { key: 'CNA', label: 'C. N. America' },
  { key: 'WNA', label: 'W. N. America' },
  { key: 'SA',  label: 'S. America'    },
  { key: 'EU',  label: 'Europe'        },
  { key: 'AF',  label: 'Africa'        },
  { key: 'AS',  label: 'Asia'          },
  { key: 'OC',  label: 'Oceania'       },
];

// Region key aliases the API accepts
const REGION_ALIASES = {
  'NA': 'ENA', 'ENA': 'ENA', 'CNA': 'CNA', 'WNA': 'WNA',
  'SA': 'SA',  'EU': 'EU',   'AF': 'AF',   'AS': 'AS', 'OC': 'OC',
  'E.NA': 'ENA', 'W.NA': 'WNA', 'C.NA': 'CNA',
};

const SSB_THRESHOLD = 20.0;
const MAX_SNR       = 50.0;
const EMA_ALPHA     = 0.08;

// ── Callsign → region classifier (simplified) ─────────────────────────────────
function classifyCall(call) {
  if (!call) return null;
  const c = call.toUpperCase().split('/')[0];
  for (const [pfx, key] of PREFIX_TABLE) {
    if (c.startsWith(pfx)) return key;
  }
  // US fallback
  if (/^[WKN]/.test(c)) {
    for (const ch of c) {
      if (ch >= '0' && ch <= '9') {
        const d = parseInt(ch);
        if (d === 0 || d === 5) return 'CNA';
        if (d === 6 || d === 7) return 'WNA';
        return 'ENA';
      }
    }
  }
  return null;
}

// ── Country centroids for grid-mode spotter resolution ────────────────────────
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
  for (const [pfx, ll] of CENTROIDS) {
    if (c.startsWith(pfx)) return { lat: ll[0], lon: ll[1] };
  }
  return null;
}

function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const f1 = g.charCodeAt(0) - 65, f2 = g.charCodeAt(1) - 65;
  const s1 = parseInt(g[2]),        s2 = parseInt(g[3]);
  if (f1 < 0 || f1 > 17 || f2 < 0 || f2 > 17 || isNaN(s1) || isNaN(s2)) return null;
  return { lat: f2*10 - 90 + s2 + 0.5, lon: f1*20 - 180 + s1*2 + 1 };
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function snrToSUnit(snr) {
  if (snr < 1)  return 'S0';
  if (snr < 5)  return 'S1';
  if (snr < 9)  return 'S2';
  if (snr < 13) return 'S3';
  if (snr < 17) return 'S4';
  if (snr < 21) return 'S5';
  if (snr < 25) return 'S6';
  if (snr < 31) return 'S7';
  if (snr < 37) return 'S8';
  if (snr < 43) return 'S9';
  if (snr < 53) return 'S9+10';
  return 'S9+20';
}

function normMode(raw) {
  const u = (raw||'').toUpperCase();
  if (u==='CW') return 'CW'; if (u==='RTTY') return 'RTTY';
  if (u==='FT8') return 'FT8'; if (u==='FT4') return 'FT4';
  return '';
}

// ── Fetch RBN data (shared, cached 60s) ───────────────────────────────────────
function fetchRbn() {
  const transport = RBN_URL.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(RBN_URL, { headers: { 'User-Agent': 'RbnSMeter-Badge/1.0' }, timeout: 12000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function getRbnData() {
  const now = Date.now();
  if (rbnData && (now - rbnFetchedAt) < DATA_TTL_MS) return rbnData;
  if (rbnFetching) {
    // Wait for in-progress fetch
    await new Promise(r => setTimeout(r, 500));
    return rbnData;
  }
  rbnFetching = true;
  try {
    rbnData      = await fetchRbn();
    rbnFetchedAt = Date.now();
  } catch(e) {
    console.error('RBN fetch failed:', e.message);
  } finally {
    rbnFetching = false;
  }
  return rbnData;
}

// ── Compute SNR metrics from raw RBN data ─────────────────────────────────────
function computeRegionBand(data, fromRegionKey, toRegionKey, bandLabel) {
  // Returns { snr, modes, hasData }
  const band = BANDS.find(b => b.label === bandLabel);
  if (!band || !data) return { snr: 0, modes: new Set(), hasData: false };

  const samples = [], modes = new Set();
  for (const [spotCall, spot] of Object.entries(data)) {
    const freq = parseFloat(String(spot.freq||'').replace(/\s/g,''));
    if (freq < band.min || freq > band.max) continue;
    if (!spot.lsn) continue;
    const dxReg = classifyCall(spotCall);
    if (dxReg !== toRegionKey) continue;
    for (const [lstCall, snrVal] of Object.entries(spot.lsn)) {
      const fromReg = classifyCall(lstCall);
      if (fromReg !== fromRegionKey) continue;
      const snr = parseFloat(snrVal);
      if (!isNaN(snr)) {
        samples.push(snr);
        const m = normMode(spot.mode);
        if (m) modes.add(m);
      }
    }
  }
  if (!samples.length) return { snr: 0, modes, hasData: false };
  const median = samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)];
  if (median >= SSB_THRESHOLD) modes.add('SSB');
  return { snr: median, modes, hasData: true };
}

function computeGridBand(data, gridStr, radiusMiles, toRegionKey, bandLabel) {
  const band = BANDS.find(b => b.label === bandLabel);
  const gridLL = gridToLatLon(gridStr);
  if (!band || !data || !gridLL) return { snr: 0, modes: new Set(), hasData: false };

  const samples = [], modes = new Set();
  for (const [spotCall, spot] of Object.entries(data)) {
    const freq = parseFloat(String(spot.freq||'').replace(/\s/g,''));
    if (freq < band.min || freq > band.max) continue;
    if (!spot.lsn) continue;
    const dxReg = classifyCall(spotCall);
    if (dxReg !== toRegionKey) continue;
    for (const [lstCall, snrVal] of Object.entries(spot.lsn)) {
      const ll = centroidFor(lstCall);
      if (!ll) continue;
      const dist = distanceMiles(gridLL.lat, gridLL.lon, ll.lat, ll.lon);
      if (dist > radiusMiles) continue;
      const snr = parseFloat(snrVal);
      if (!isNaN(snr)) {
        samples.push(snr);
        const m = normMode(spot.mode);
        if (m) modes.add(m);
      }
    }
  }
  if (!samples.length) return { snr: 0, modes, hasData: false };
  const median = samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)];
  if (median >= SSB_THRESHOLD) modes.add('SSB');
  return { snr: median, modes, hasData: true };
}

// ── PNG rendering ─────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg:       '#0d0d1a',
    bg2:      '#1a1a2e',
    border:   '#00d4aa',
    accent:   '#00d4aa',
    text:     '#c8d0e8',
    textDim:  '#6a7490',
    green:    '#00d250',
    yellow:   '#e6c800',
    orange:   '#ff8c00',
    red:      '#dc1e1e',
    dimSeg:   '#1c1c32',
    modeX:    '#7a2020',
    modeSSB:  '#c8a830',
  },
  light: {
    bg:       '#ffffff',
    bg2:      '#f0f4f8',
    border:   '#00886a',
    accent:   '#007a5e',
    text:     '#1a1a2e',
    textDim:  '#7a8090',
    green:    '#008830',
    yellow:   '#886600',
    orange:   '#884400',
    red:      '#880010',
    dimSeg:   '#e0e4ec',
    modeX:    '#cc3333',
    modeSSB:  '#886600',
  },
};

function segColor(i, bright, t) {
  const frac = (i+1)/15;
  if (bright) {
    if (frac < 0.60) return t.green;
    if (frac < 0.80) return t.yellow;
    if (frac < 0.90) return t.orange;
    return t.red;
  }
  // Peak hold — dimmed versions
  if (frac < 0.60) return t.dimSeg;
  if (frac < 0.80) return t.dimSeg;
  return t.dimSeg;
}

function renderBadge(params) {
  const { snr, modes, hasData, fromLabel, toLabel, bandLabel, theme, size, dataAge } = params;
  const t = THEMES[theme] || THEMES.dark;

  // Dimensions
  const W = size === 'small' ? 220 : 380;
  const H = size === 'small' ? 72  : 100;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);

  // Border
  ctx.strokeStyle = t.border;
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, W-1, H-1);

  // Title bar
  ctx.fillStyle = t.bg2;
  ctx.fillRect(1, 1, W-2, size === 'small' ? 16 : 20);

  // Title text
  ctx.fillStyle = t.accent;
  ctx.font      = `bold ${size === 'small' ? 9 : 11}px "DejaVu Sans Mono"`;
  ctx.textAlign = 'center';
  ctx.fillText('RBN S-METER', W/2, size === 'small' ? 11 : 14);

  const titleH = size === 'small' ? 18 : 22;

  if (size === 'small') {
    // ── Small: single band compact layout ──────────────────────────────
    ctx.fillStyle = t.textDim;
    ctx.font      = '8px "DejaVu Sans Mono"';
    ctx.textAlign = 'left';
    ctx.fillText(`${fromLabel} → ${toLabel}`, 6, titleH + 10);

    ctx.fillStyle = t.text;
    ctx.font      = 'bold 8px "DejaVu Sans Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(bandLabel, W - 6, titleH + 10);

    // Bar
    const barX = 6, barY = titleH + 14, barW = W-12, barH = 12;
    drawBar(ctx, barX, barY, barW, barH, snr, 0, hasData, t);

    // S-unit
    ctx.fillStyle = hasData ? t.green : t.textDim;
    ctx.font      = `bold ${size === 'small' ? 10 : 13}px "DejaVu Sans Mono"`;
    ctx.textAlign = 'center';
    ctx.fillText(hasData ? snrToSUnit(snr) : '--', W/2, titleH + 40);

    // Mode row
    drawModeRow(ctx, 6, titleH + 44, W-12, 12, modes, hasData, t, true);

  } else {
    // ── Full: with labels and bigger bar ───────────────────────────────
    ctx.fillStyle = t.textDim;
    ctx.font      = '9px "DejaVu Sans Mono"';
    ctx.textAlign = 'left';
    ctx.fillText(`From: ${fromLabel}`, 8, titleH + 12);
    ctx.fillText(`To:   ${toLabel}`,   8, titleH + 24);

    ctx.fillStyle = t.accent;
    ctx.font      = 'bold 18px "DejaVu Sans Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(bandLabel, W - 8, titleH + 22);

    // Bar
    const barX = 8, barY = titleH + 30, barW = W-80, barH = 16;
    drawBar(ctx, barX, barY, barW, barH, snr, 0, hasData, t);

    // S-unit
    ctx.fillStyle = hasData ? t.green : t.textDim;
    ctx.font      = 'bold 14px "DejaVu Sans Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(hasData ? snrToSUnit(snr) : '--', W-8, barY + barH - 1);

    // Mode row
    drawModeRow(ctx, 8, titleH + 52, W-16, 12, modes, hasData, t, false);
  }

  // Attribution + data age (bottom right)
  const ageStr = dataAge < 120 ? `${dataAge}s ago` : `${Math.floor(dataAge/60)}m ago`;
  ctx.fillStyle = t.textDim;
  ctx.font      = '7px "DejaVu Sans Mono"';
  ctx.textAlign = 'right';
  ctx.fillText(`by W1VE · ${ageStr}`, W - 4, H - 3);

  return canvas.toBuffer('image/png');
}

function drawBar(ctx, x, y, w, h, snr, peak, hasData, t) {
  // Background
  ctx.fillStyle = t.dimSeg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = t.border;
  ctx.lineWidth   = 0.5;
  ctx.strokeRect(x-0.5, y-0.5, w+1, h+1);

  if (!hasData) return;

  const SEG = 15, gap = 1;
  const segW = (w - gap*(SEG-1)) / SEG;
  const lit  = Math.round(Math.min(snr/MAX_SNR, 1) * SEG);

  for (let i = 0; i < SEG; i++) {
    const sx = x + i*(segW+gap);
    ctx.fillStyle = i < lit ? segColor(i, true, t) : t.dimSeg;
    ctx.fillRect(sx, y, segW, h);
  }
}

function drawModeRow(ctx, x, y, w, h, modes, hasData, t, small) {
  const labels = ['CW','RTTY','FT8','FT4','SSB'];
  const colW   = w / labels.length;
  ctx.font      = `${small ? 7 : 8}px "DejaVu Sans Mono"`;
  ctx.textAlign = 'center';

  labels.forEach((mode, i) => {
    const cx     = x + (i + 0.5) * colW;
    const isSSB  = mode === 'SSB';
    const active = modes.has(mode);

    if (!hasData) {
      ctx.fillStyle = t.textDim;
      ctx.fillText(isSSB ? '(SSB)' : mode, cx, y + h);
    } else if (active && isSSB) {
      ctx.fillStyle = t.modeSSB;
      ctx.fillText('(\u2713SSB)', cx, y + h);
    } else if (active) {
      ctx.fillStyle = t.accent;
      ctx.fillText('\u2713' + mode, cx, y + h);
    } else if (isSSB) {
      ctx.fillStyle = t.textDim;
      ctx.fillText('(SSB)', cx, y + h);
    } else {
      ctx.fillStyle = t.modeX;
      ctx.fillText('\u2717' + mode, cx, y + h);
    }
  });
}

function renderWarmup(theme, size) {
  const t = THEMES[theme] || THEMES.dark;
  const W = size === 'small' ? 220 : 380;
  const H = size === 'small' ? 72  : 100;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = t.border; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W-1, H-1);
  ctx.fillStyle = t.bg2;
  ctx.fillRect(1, 1, W-2, size === 'small' ? 16 : 20);
  ctx.fillStyle = t.accent; ctx.font = `bold ${size === 'small' ? 9 : 11}px "DejaVu Sans Mono"`;
  ctx.textAlign = 'center';
  ctx.fillText('RBN S-METER', W/2, size === 'small' ? 11 : 14);
  ctx.fillStyle = t.textDim; ctx.font = '9px "DejaVu Sans Mono"';
  ctx.fillText('Warming up...', W/2, H/2);
  ctx.fillText('retry in ~30s', W/2, H/2 + 13);
  ctx.fillStyle = t.textDim; ctx.font = '7px "DejaVu Sans Mono"';
  ctx.textAlign = 'right';
  ctx.fillText('by W1VE', W-4, H-3);
  return canvas.toBuffer('image/png');
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const q        = parsed.query;

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rbnAge: Math.round((Date.now()-rbnFetchedAt)/1000) }));
    return;
  }

  if (pathname !== '/badge/region' && pathname !== '/badge/grid') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Use /badge/region or /badge/grid');
    return;
  }

  // Parse common params
  const theme  = (q.theme === 'light') ? 'light' : 'dark';
  const size   = (q.size  === 'full')  ? 'full'  : 'small';
  const band   = (q.band  || '20m').toLowerCase().replace('m','') + 'm';
  const validBands = BANDS.map(b => b.label);
  if (!validBands.includes(band)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Invalid band. Use one of: ${validBands.join(', ')}`);
    return;
  }

  let fromKey, toKey, cacheKey;

  if (pathname === '/badge/region') {
    const fromRaw = (q.from || 'ENA').toUpperCase();
    const toRaw   = (q.to   || 'EU' ).toUpperCase();
    fromKey       = REGION_ALIASES[fromRaw];
    toKey         = REGION_ALIASES[toRaw];
    if (!fromKey || !toKey) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Invalid region. Use: ${Object.keys(REGION_ALIASES).join(', ')}`);
      return;
    }
    cacheKey = `region|${fromKey}|${toKey}|${band}|${theme}|${size}`;
  } else {
    const grid   = (q.grid   || '').toUpperCase();
    const radius = parseInt(q.radius) || 500;
    const toRaw  = (q.to     || 'EU').toUpperCase();
    toKey        = REGION_ALIASES[toRaw];
    if (!gridToLatLon(grid)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing grid parameter (e.g. ?grid=FN42)');
      return;
    }
    if (!toKey) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Invalid to region.`);
      return;
    }
    fromKey  = `GRID:${grid}:${radius}`;
    cacheKey = `grid|${grid}|${radius}|${toKey}|${band}|${theme}|${size}`;
  }

  // Check PNG cache
  const now = Date.now();
  const cached = pngCache.get(cacheKey);
  if (cached && (now - cached.createdAt) < CACHE_TTL_MS) {
    sendPng(res, cached.png, now - cached.createdAt, false);
    return;
  }

  // Get RBN data
  const data = await getRbnData();

  if (!data) {
    // Data not yet available — return warming-up image
    const png = renderWarmup(theme, size);
    sendPng(res, png, 0, true);
    return;
  }

  // Compute metrics
  let result;
  if (pathname === '/badge/region') {
    result = computeRegionBand(data, fromKey, toKey, band);
  } else {
    const grid   = (q.grid || '').toUpperCase();
    const radius = parseInt(q.radius) || 500;
    result = computeGridBand(data, grid, radius, toKey, band);
  }

  // Get display labels
  const fromLabel = pathname === '/badge/region'
    ? (REGIONS.find(r => r.key === fromKey)?.label || fromKey)
    : `Grid ${q.grid?.toUpperCase()}`;
  const toLabel = REGIONS.find(r => r.key === toKey)?.label || toKey;

  // Render PNG
  const dataAge = Math.round((now - rbnFetchedAt) / 1000);
  const png = renderBadge({
    snr: result.snr,
    modes: result.modes,
    hasData: result.hasData,
    fromLabel,
    toLabel,
    bandLabel: band,
    theme,
    size,
    dataAge,
  });

  pngCache.set(cacheKey, { png, createdAt: now });
  sendPng(res, png, 0, false);
});

function sendPng(res, png, ageMs, warming) {
  res.writeHead(200, {
    'Content-Type':              'image/png',
    'Content-Length':            png.length,
    'Cache-Control':             'public, max-age=60',
    'Access-Control-Allow-Origin': '*',
    'X-RBN-Status':              warming ? 'warming' : 'live',
    'X-RBN-Cache-Age':           Math.round(ageMs / 1000),
  });
  res.end(png);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RBN Badge API listening on 0.0.0.0:${PORT}`);
  // Pre-fetch data on startup
  getRbnData().then(() => console.log('Initial RBN data fetched.'));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

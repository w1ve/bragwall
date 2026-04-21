'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3001;

const SPOT_KEEP_MS  = 2 * 60 * 1000;
const PSK_CACHE_MS  = parseInt(process.env.PSK_CACHE_MS || String(15 * 60 * 1000), 10);
const PSK_URL_BASE  = 'https://retrieve.pskreporter.info/query';
const PSK_FLOW_SEC  = parseInt(process.env.PSK_FLOW_SECONDS || '1800', 10);
const PSK_CONTACT   = process.env.PSK_APP_CONTACT || 'gerry@remote.radio';
const PSK_MODES     = (process.env.PSK_MODES || 'FT8')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const PSK_COOLDOWN_MS = parseInt(process.env.PSK_COOLDOWN_MS || String(30 * 60 * 1000), 10);

const spotMap = new Map();
const REGION_KEYS = ['ENA', 'CNA', 'WNA', 'SA', 'EU', 'AF', 'AS', 'OC', 'CAR'];
const CARIBBEAN_CENTER = { lat: 17.0, lon: -72.0, radiusMiles: 950 };
const MAX_PSK_CALLS_PER_CELL = parseInt(process.env.PSK_MAX_CALLS_PER_CELL || '120', 10);
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

let pskCacheData     = null;
let pskCacheFetched  = 0;
let pskFetchPromise  = null;
let pskBlockedUntil  = 0;
let pskLastError     = null;

function pruneSpots() {
  const cutoff = Date.now() - SPOT_KEEP_MS;
  for (const [k, v] of spotMap) { if (v.lastSeen < cutoff) spotMap.delete(k); }
}

function addSpot(spotter, freq, dxCall, mode, snr) {
  const now = Date.now();
  if (!spotMap.has(dxCall)) {
    spotMap.set(dxCall, { freq, mode, firstSeen: now, lastSeen: now, lsn: {} });
  }
  const s = spotMap.get(dxCall);
  s.lsn[spotter] = snr;
  s.lastSeen = now;
  s.freq = freq;
}

function buildRbnResponse() {
  pruneSpots();
  const now = Date.now();
  const out = {};
  for (const [dxCall, s] of spotMap) {
    out[dxCall] = {
      dxcall: dxCall,
      freq:   s.freq.toFixed(1),
      mode:   s.mode,
      age:    Math.round((now - s.lastSeen) / 1000),
      lsn:    { ...s.lsn },
    };
  }
  return JSON.stringify(out);
}

// ── RBN feed subscriber ───────────────────────────────────────────────────────
const WebSocket = require('ws');
const FEED_URL  = process.env.FEED_URL || 'ws://rbn-feed:3003';

let telnetReady = false;
let feedWs      = null;

const DX_RE = /^DX de\s+(\S+?)\s*:\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+dB/i;

function handleLine(line) {
  const m = line.match(DX_RE);
  if (!m) return;
  const spotter = m[1].replace(/-[^A-Z0-9].*$/, '');
  const freq    = parseFloat(m[2]);
  const dxCall  = m[3];
  const mode    = m[4].toUpperCase();
  const snr     = parseInt(m[5]);
  if (!freq || !dxCall || isNaN(snr)) return;
  addSpot(spotter, freq, dxCall, mode, snr);
  if (!telnetReady) { console.log('[feed] first spot received — live'); telnetReady = true; }
}

function connectFeed() {
  if (feedWs) { try { feedWs.terminate(); } catch {} feedWs = null; }
  console.log(`[feed] connecting to ${FEED_URL}`);
  feedWs = new WebSocket(FEED_URL);
  feedWs.on('open',    () => console.log('[feed] connected to rbn-feed'));
  feedWs.on('message', (data) => handleLine(data.toString().trim()));
  feedWs.on('close',   () => { console.log('[feed] disconnected — retry 10s'); feedWs=null; telnetReady=false; setTimeout(connectFeed,10000); });
  feedWs.on('error',   (e) => { console.error('[feed] error:', e.message); feedWs=null; setTimeout(connectFeed,10000); });
}

connectFeed();

// ── Hamqth backup ─────────────────────────────────────────────────────────────
const HAMQTH_URL =
  'https://www.hamqth.com/rbn_data.php' +
  '?data=1&band=160,80,40,30,20,17,15,12,10,6' +
  '&fromcont=AF,AN,AS,EU,NA,OC,SA' +
  '&mode=CW,RTTY,FT8,PSK31,PSK63' +
  '&cont=AF,AN,AS,EU,NA,OC,SA' +
  '&waz=*&itu=*&age=3600&order=3';

const HAMDB_BASE  = 'https://api.hamdb.org/v1/';
const CALLSIGN_RE = /^[A-Z0-9/]{3,12}$/i;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, ...CORS });
  res.end(body);
}

function fetchRaw(targetUrl, timeoutMs = 8000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.path, method: 'GET',
        headers: { 'User-Agent': 'RbnSMeter-Proxy/1.0', ...extraHeaders }, timeout: timeoutMs },
      upstream => {
        const chunks = [];
        upstream.on('data', c => chunks.push(c));
        upstream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function proxyGet(targetUrl, res, timeoutMs = 10000) {
  const parsed = url.parse(targetUrl);
  const req = https.request(
    { hostname: parsed.hostname, path: parsed.path, method: 'GET',
      headers: { 'User-Agent': 'RbnSMeter-Proxy/1.0' }, timeout: timeoutMs },
    upstream => {
      const chunks = [];
      upstream.on('data', chunk => chunks.push(chunk));
      upstream.on('end', () => {
        const body        = Buffer.concat(chunks).toString('utf8');
        const contentType = upstream.headers['content-type'] || 'application/json';
        send(res, upstream.statusCode, contentType, body);
      });
    }
  );
  req.on('timeout', () => { req.destroy(); send(res, 504, 'text/plain', 'Gateway timeout'); });
  req.on('error',   () => send(res, 502, 'text/plain', 'Bad gateway'));
  req.end();
}

function parseWWV(text) {
  const m = re => { const r = text.match(re); return r ? r[1] : null; };
  return {
    sfi: m(/Solar flux\s+(\d+)/i),
    a:   m(/planetary A-index\s+(\d+)/i),
    k:   m(/K-index at \d+\s+UTC[^.]+was\s+([\d.]+)/i),
  };
}

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  const g = grid.toUpperCase();
  const f1 = g.charCodeAt(0) - 65;
  const f2 = g.charCodeAt(1) - 65;
  const s1 = parseInt(g[2], 10);
  const s2 = parseInt(g[3], 10);
  if (f1 < 0 || f1 > 17 || f2 < 0 || f2 > 17 || Number.isNaN(s1) || Number.isNaN(s2)) return null;

  let lon = f1 * 20 - 180 + s1 * 2 + 1;
  let lat = f2 * 10 - 90 + s2 + 0.5;
  if (g.length >= 6) {
    const ss1 = g.charCodeAt(4) - 65;
    const ss2 = g.charCodeAt(5) - 65;
    if (ss1 >= 0 && ss1 < 24 && ss2 >= 0 && ss2 < 24) {
      lon = f1 * 20 - 180 + s1 * 2 + ss1 * (2 / 24) + 1 / 24;
      lat = f2 * 10 - 90 + s2 + ss2 * (1 / 24) + 0.5 / 24;
    }
  }
  return { lat, lon };
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function regionFromLatLon(lat, lon) {
  const dCar = distanceMiles(lat, lon, CARIBBEAN_CENTER.lat, CARIBBEAN_CENTER.lon);
  if (dCar <= CARIBBEAN_CENTER.radiusMiles && lat >= 8 && lat <= 30 && lon >= -92 && lon <= -56) return 'CAR';
  if (lat > 15 && lon >= -170 && lon <= -50) {
    if (lon >= -85)  return 'ENA';
    if (lon >= -105) return 'CNA';
    return 'WNA';
  }
  if (lat >= -60 && lat <= 15 && lon >= -82 && lon <= -34) return 'SA';
  if (lat >= 35  && lat <= 72 && lon >= -12 && lon <= 45)  return 'EU';
  if (lat >= -35 && lat <= 40 && lon >= -20 && lon <= 55)  return 'AF';
  if (lat >= -10 && lat <= 75 && lon >= 45)                return 'AS';
  if (lat <= 0   && lon >= 100)                            return 'OC';
  return 'ENA';
}

function bandForFrequencyKhz(freqKhz) {
  for (const band of BANDS) {
    if (freqKhz >= band.min && freqKhz <= band.max) return band.label;
  }
  return null;
}

function parseAttributes(attrString) {
  const attrs = {};
  let m;
  const re = /([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g;
  while ((m = re.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function parsePskReports(xmlText) {
  const reports = [];
  if (!xmlText || typeof xmlText !== 'string') return reports;
  let m;
  const rr = /<receptionReport\b([^>]*?)\/?>/gi;
  while ((m = rr.exec(xmlText)) !== null) {
    const attrs = parseAttributes(m[1]);
    const rxGrid = attrs.receiverLocator || attrs.receiverlocator || attrs.rxLocator || '';
    const txGrid = attrs.senderLocator   || attrs.senderlocator   || attrs.txLocator || '';
    const rxCall = String(attrs.receiverCallsign || attrs.receiverCall || attrs.receiver || '').trim().toUpperCase();
    const txCall = String(attrs.senderCallsign || attrs.senderCall || attrs.sender || '').trim().toUpperCase();
    const snrRaw = attrs.sNR || attrs.SNR || attrs.snr;
    const freqRaw = attrs.frequency || attrs.freq;
    const snr = parseFloat(snrRaw);
    const freq = parseFloat(freqRaw);
    if (!rxGrid || !txGrid || Number.isNaN(snr) || Number.isNaN(freq)) continue;
    reports.push({ rxGrid, txGrid, rxCall, txCall, snr, freq });
  }
  return reports;
}

function foldPskReports(reports) {
  const bySample = {};
  for (const r of reports) {
    const rxLL = gridToLatLon(r.rxGrid);
    const txLL = gridToLatLon(r.txGrid);
    if (!rxLL || !txLL) continue;
    const fromRegion = regionFromLatLon(rxLL.lat, rxLL.lon);
    const toRegion = regionFromLatLon(txLL.lat, txLL.lon);
    if (!REGION_KEYS.includes(fromRegion) || !REGION_KEYS.includes(toRegion)) continue;

    const freqKhz = r.freq >= 100000 ? r.freq / 1000 : r.freq;
    const band = bandForFrequencyKhz(freqKhz);
    if (!band) continue;

    const correctedSnr = r.snr + 7.0; // 2500Hz -> ~500Hz bandwidth normalization
    bySample[fromRegion] ??= {};
    bySample[fromRegion][toRegion] ??= {};
    bySample[fromRegion][toRegion][band] ??= { snrValues: [], txCalls: new Set(), rxCalls: new Set() };
    const bucket = bySample[fromRegion][toRegion][band];
    bucket.snrValues.push(correctedSnr);
    if (r.txCall) bucket.txCalls.add(r.txCall);
    if (r.rxCall) bucket.rxCalls.add(r.rxCall);
  }

  const out = {};
  for (const [fromRegion, toMap] of Object.entries(bySample)) {
    out[fromRegion] = {};
    for (const [toRegion, bandMap] of Object.entries(toMap)) {
      out[fromRegion][toRegion] = {};
      for (const [band, bucket] of Object.entries(bandMap)) {
        const snr = median(bucket.snrValues);
        if (snr == null) continue;
        out[fromRegion][toRegion][band] = {
          snr: Math.round(snr * 10) / 10,
          count: bucket.snrValues.length,
          txCalls: Array.from(bucket.txCalls).sort().slice(0, MAX_PSK_CALLS_PER_CELL),
          rxCalls: Array.from(bucket.rxCalls).sort().slice(0, MAX_PSK_CALLS_PER_CELL),
        };
      }
    }
  }
  return out;
}

async function fetchPskMode(mode) {
  const query = `${PSK_URL_BASE}?rronly=1&flowStartSeconds=-${PSK_FLOW_SEC}&nolocator=0&mode=${encodeURIComponent(mode)}&appcontact=${encodeURIComponent(PSK_CONTACT)}`;
  const browserLikeHeaders = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'close',
  };

  const raw = await fetchRaw(query, 30000, browserLikeHeaders);
  if (/too many queries|made too many queries/i.test(raw)) {
    const e = new Error('psk_rate_limited');
    e.code = 'PSK_RATE_LIMIT';
    throw e;
  }
  if (/just a moment|attention required|cloudflare/i.test(raw) && !/<receptionReport\b/i.test(raw)) {
    const e = new Error('psk_challenge');
    e.code = 'PSK_RATE_LIMIT';
    throw e;
  }
  const reports = parsePskReports(raw);
  return reports;
}

async function servePsk(res) {
  const now = Date.now();
  if (pskCacheData && (now - pskCacheFetched) < PSK_CACHE_MS) {
    send(res, 200, 'application/json', JSON.stringify({
      age: Math.round((now - pskCacheFetched) / 1000),
      fetchedAt: new Date(pskCacheFetched).toISOString(),
      byRegion: pskCacheData,
      cached: true,
    }));
    return;
  }
  if (now < pskBlockedUntil) {
    const retryIn = Math.max(0, Math.round((pskBlockedUntil - now) / 1000));
    if (pskCacheData) {
      send(res, 200, 'application/json', JSON.stringify({
        age: Math.round((now - pskCacheFetched) / 1000),
        fetchedAt: new Date(pskCacheFetched).toISOString(),
        byRegion: pskCacheData,
        cached: true,
        stale: true,
        retryIn,
        error: pskLastError || 'psk_throttled',
      }));
      return;
    }
    send(res, 429, 'application/json', JSON.stringify({
      error: pskLastError || 'psk_throttled',
      retryIn,
    }));
    return;
  }

  if (!pskFetchPromise) {
    pskFetchPromise = (async () => {
      const modeFetches = await Promise.allSettled(PSK_MODES.map(fetchPskMode));
      const reports = [];
      for (const mr of modeFetches) {
        if (mr.status === 'fulfilled') reports.push(...mr.value);
      }
      const hardErrors = modeFetches
        .filter(mr => mr.status === 'rejected')
        .map(mr => mr.reason?.code || mr.reason?.message || 'psk_mode_error');
      if (reports.length === 0) throw new Error('no_psk_reports');
      pskCacheData = foldPskReports(reports);
      pskCacheFetched = Date.now();
      pskLastError = null;
      pskBlockedUntil = 0;
      if (hardErrors.length > 0) {
        console.warn('[psk] partial fetch errors:', hardErrors.join(','));
      }
      return pskCacheData;
    })().finally(() => { pskFetchPromise = null; });
  }

  try {
    const byRegion = await pskFetchPromise;
    send(res, 200, 'application/json', JSON.stringify({
      age: Math.round((Date.now() - pskCacheFetched) / 1000),
      fetchedAt: new Date(pskCacheFetched).toISOString(),
      byRegion,
      cached: false,
    }));
  } catch (e) {
    if (pskCacheData) {
      send(res, 200, 'application/json', JSON.stringify({
        age: Math.round((Date.now() - pskCacheFetched) / 1000),
        fetchedAt: new Date(pskCacheFetched).toISOString(),
        byRegion: pskCacheData,
        cached: true,
        stale: true,
      }));
      return;
    }
    pskLastError = e?.code || e?.message || 'psk_fetch_error';
    pskBlockedUntil = Date.now() + PSK_COOLDOWN_MS;
    send(res, 502, 'application/json', JSON.stringify({
      error: 'PSK fetch error',
      reason: pskLastError,
      retryIn: Math.round(PSK_COOLDOWN_MS / 1000),
    }));
  }
}

async function serveSolar(res) {
  const [wwvR, cycleR, plasmaR, magR] = await Promise.allSettled([
    fetchRaw('https://services.swpc.noaa.gov/text/wwv.txt'),
    fetchRaw('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json'),
    fetchRaw('https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json'),
    fetchRaw('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json'),
  ]);

  let sfi = null, a = null, k = null;
  if (wwvR.status === 'fulfilled') {
    const w = parseWWV(wwvR.value);
    sfi = w.sfi ? parseInt(w.sfi)             : null;
    a   = w.a   ? parseInt(w.a)               : null;
    k   = w.k   ? Math.round(parseFloat(w.k)) : null;
  }

  let ssn = null;
  if (cycleR.status === 'fulfilled') {
    try {
      const arr  = JSON.parse(cycleR.value);
      const last = arr.filter(x => x && x.ssn != null).pop();
      if (last) {
        ssn = Math.round(parseFloat(last.ssn || last.observed_swpc_ssn));
        if (!sfi && last['f10.7']) sfi = Math.round(parseFloat(last['f10.7']));
      }
    } catch (_) {}
  }

  let wind = null;
  if (plasmaR.status === 'fulfilled') {
    try {
      const rows = JSON.parse(plasmaR.value).slice(1);
      for (let i = rows.length - 1; i >= 0; i--) {
        const v = parseFloat(rows[i][2]);
        if (!isNaN(v) && v > 0) { wind = Math.round(v); break; }
      }
    } catch (_) {}
  }

  let bz = null;
  if (magR.status === 'fulfilled') {
    try {
      const arr = JSON.parse(magR.value);
      for (let i = arr.length - 1; i >= 0; i--) {
        const v = parseFloat(arr[i].bz_gsm);
        if (!isNaN(v)) { bz = parseFloat(v.toFixed(1)); break; }
      }
    } catch (_) {}
  }

  send(res, 200, 'application/json', JSON.stringify({ sfi, ssn, a, k, wind, bz }));
}

async function serveRbn(res) {
  pruneSpots();
  if (spotMap.size > 0) {
    send(res, 200, 'application/json', buildRbnResponse());
    return;
  }
  try {
    const raw = await fetchRaw(HAMQTH_URL, 12000);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
      send(res, 200, 'application/json', raw);
      return;
    }
  } catch (_) {}
  send(res, 200, 'application/json', '{}');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method !== 'GET') { send(res, 405, 'text/plain', 'Method not allowed'); return; }

  const parsed = url.parse(req.url, true);
  const parts  = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');

  if (parts[0] === 'rbn' && parts.length === 1) {
    try { await serveRbn(res); } catch (_) { send(res, 502, 'text/plain', 'RBN fetch error'); }
    return;
  }
  if (parts[0] === 'hamdb' && parts.length === 2) {
    const call = parts[1].toUpperCase();
    if (!CALLSIGN_RE.test(call)) { send(res, 400, 'text/plain', 'Invalid callsign'); return; }
    proxyGet(`${HAMDB_BASE}${call}/json`, res, 8000);
    return;
  }
  if (parts[0] === 'solar' && parts.length === 1) {
    try { await serveSolar(res); } catch (_) { send(res, 502, 'text/plain', 'Solar fetch error'); }
    return;
  }
  if (parts[0] === 'psk' && parts.length === 1) {
    try { await servePsk(res); } catch (_) { send(res, 502, 'text/plain', 'PSK fetch error'); }
    return;
  }
  if (parts[0] === 'health') {
    send(res, 200, 'application/json', JSON.stringify({
      status: 'ok', telnet: telnetReady,
      feed: feedWs ? feedWs.readyState === 1 : false,
      spots: spotMap.size,
      pskAge: pskCacheFetched ? Math.round((Date.now() - pskCacheFetched) / 1000) : null,
      pskRetryIn: pskBlockedUntil > Date.now() ? Math.round((pskBlockedUntil - Date.now()) / 1000) : 0,
      pskModes: PSK_MODES,
    }));
    return;
  }
  send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RBN proxy listening on 0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3001;

const SPOT_KEEP_MS  = 2 * 60 * 1000;

const spotMap = new Map();

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

function fetchRaw(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.path, method: 'GET',
        headers: { 'User-Agent': 'RbnSMeter-Proxy/1.0' }, timeout: timeoutMs },
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
  if (parts[0] === 'health') {
    send(res, 200, 'application/json', JSON.stringify({
      status: 'ok', telnet: telnetReady,
      feed: feedWs ? feedWs.readyState === 1 : false,
      spots: spotMap.size,
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

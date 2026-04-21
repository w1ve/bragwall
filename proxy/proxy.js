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
const CALLSIGN_REGION_PREFIXES = [
  // Caribbean
  ['VP2E', 'CAR'], ['VP2V', 'CAR'], ['VP2M', 'CAR'], ['VP5', 'CAR'], ['VP9', 'CAR'],
  ['KP2', 'CAR'], ['NP2', 'CAR'], ['WP2', 'CAR'], ['KP4', 'CAR'], ['NP4', 'CAR'], ['WP4', 'CAR'],
  ['PJ2', 'CAR'], ['PJ4', 'CAR'], ['PJ', 'CAR'], ['C6', 'CAR'], ['ZF', 'CAR'],
  ['V2', 'CAR'], ['V3', 'CAR'], ['V4', 'CAR'], ['J3', 'CAR'], ['J6', 'CAR'], ['J7', 'CAR'], ['J8', 'CAR'],
  ['8P', 'CAR'], ['9Y', 'CAR'], ['9Z', 'CAR'], ['6Y', 'CAR'], ['4V', 'CAR'],
  ['HH', 'CAR'], ['HI', 'CAR'], ['CL', 'CAR'], ['CM', 'CAR'], ['CO', 'CAR'], ['T4', 'CAR'],
  ['FG', 'CAR'], ['FM', 'CAR'], ['FS', 'CAR'], ['FJ', 'CAR'],
  // East North America
  ['VO1', 'ENA'], ['VO2', 'ENA'], ['VY2', 'ENA'],
  ['VE1', 'ENA'], ['VE2', 'ENA'], ['VE3', 'ENA'], ['VE9', 'ENA'],
  ['VA1', 'ENA'], ['VA2', 'ENA'], ['VA3', 'ENA'],
  ['W1', 'ENA'], ['W2', 'ENA'], ['W3', 'ENA'], ['W4', 'ENA'], ['W8', 'ENA'],
  ['K1', 'ENA'], ['K2', 'ENA'], ['K3', 'ENA'], ['K4', 'ENA'], ['K8', 'ENA'],
  ['N1', 'ENA'], ['N2', 'ENA'], ['N3', 'ENA'], ['N4', 'ENA'], ['N8', 'ENA'],
  // Central North America
  ['VE4', 'CNA'], ['VE5', 'CNA'], ['VE6', 'CNA'],
  ['VA4', 'CNA'], ['VA5', 'CNA'], ['VA6', 'CNA'],
  ['W0', 'CNA'], ['W5', 'CNA'], ['W9', 'CNA'],
  ['K0', 'CNA'], ['K5', 'CNA'], ['K9', 'CNA'],
  ['N0', 'CNA'], ['N5', 'CNA'], ['N9', 'CNA'],
  ['XE', 'CNA'], ['XF', 'CNA'], ['TI', 'CNA'], ['YN', 'CNA'], ['HR', 'CNA'], ['TG', 'CNA'], ['YS', 'CNA'],
  // West North America
  ['VE7', 'WNA'], ['VA7', 'WNA'], ['VY1', 'WNA'],
  ['W6', 'WNA'], ['W7', 'WNA'], ['K6', 'WNA'], ['K7', 'WNA'], ['N6', 'WNA'], ['N7', 'WNA'],
  ['KL', 'WNA'], ['AL', 'WNA'], ['WL', 'WNA'], ['NL', 'WNA'],
  // South America
  ['VP8', 'SA'], ['FY', 'SA'], ['PZ', 'SA'], ['8R', 'SA'], ['OA', 'SA'], ['OC', 'SA'],
  ['AY', 'SA'], ['AZ', 'SA'], ['LU', 'SA'], ['LO', 'SA'], ['LW', 'SA'],
  ['PP', 'SA'], ['PQ', 'SA'], ['PR', 'SA'], ['PS', 'SA'], ['PT', 'SA'], ['PU', 'SA'], ['PV', 'SA'], ['PW', 'SA'], ['PX', 'SA'], ['PY', 'SA'],
  ['CA', 'SA'], ['CB', 'SA'], ['CC', 'SA'], ['CD', 'SA'], ['CE', 'SA'], ['CF', 'SA'], ['CK', 'SA'],
  ['XQ', 'SA'], ['XR', 'SA'], ['CP', 'SA'], ['ZY', 'SA'], ['ZZ', 'SA'],
  ['HK', 'SA'], ['HJ', 'SA'], ['HC', 'SA'], ['HD', 'SA'], ['ZP', 'SA'], ['CV', 'SA'], ['CX', 'SA'],
  ['YV', 'SA'], ['YY', 'SA'],
  // Europe
  ['1A0', 'EU'], ['3A', 'EU'], ['4O', 'EU'], ['9A', 'EU'], ['9H', 'EU'], ['CT', 'EU'], ['C31', 'EU'],
  ['DL', 'EU'], ['E7', 'EU'], ['EA6', 'EU'], ['EA', 'EU'], ['EI', 'EU'], ['ES', 'EU'], ['F', 'EU'],
  ['GD', 'EU'], ['GI', 'EU'], ['GJ', 'EU'], ['GM', 'EU'], ['GU', 'EU'], ['GW', 'EU'], ['G', 'EU'],
  ['HB0', 'EU'], ['HB', 'EU'], ['HV', 'EU'], ['I', 'EU'], ['JW', 'EU'], ['JX', 'EU'], ['LA', 'EU'],
  ['LZ', 'EU'], ['OE', 'EU'], ['OH0', 'EU'], ['OH', 'EU'], ['OK', 'EU'], ['OM', 'EU'], ['ON', 'EU'],
  ['OY', 'EU'], ['OZ', 'EU'], ['PA', 'EU'], ['S5', 'EU'], ['SM', 'EU'],
  ['SV5', 'EU'], ['SV9', 'EU'], ['SV', 'EU'], ['T7', 'EU'], ['TA', 'EU'], ['TF', 'EU'], ['TK', 'EU'],
  ['UR', 'EU'], ['YL', 'EU'], ['YO', 'EU'], ['YU', 'EU'], ['ZA', 'EU'], ['ZB', 'EU'], ['ZC4', 'EU'],
  ['5B', 'EU'], ['C4', 'EU'], ['H2', 'EU'], ['P3', 'EU'],
  // Africa
  ['EA8', 'AF'], ['EH8', 'AF'], ['EA9', 'AF'], ['EB9', 'AF'], ['EC9', 'AF'], ['ED9', 'AF'], ['EE9', 'AF'], ['EF9', 'AF'], ['EG9', 'AF'], ['EH9', 'AF'],
  ['CT3', 'AF'], ['CT9', 'AF'], ['CQ3', 'AF'], ['CQ9', 'AF'], ['CR3', 'AF'], ['CR9', 'AF'], ['CS3', 'AF'], ['CS9', 'AF'],
  ['7R', 'AF'], ['7T', 'AF'], ['7U', 'AF'], ['7V', 'AF'], ['7W', 'AF'], ['7X', 'AF'], ['7Y', 'AF'],
  ['6AA', 'AF'], ['6AB', 'AF'], ['6AC', 'AF'], ['6AD', 'AF'], ['6AE', 'AF'], ['6AF', 'AF'], ['6AG', 'AF'], ['6AH', 'AF'], ['6AI', 'AF'], ['6AJ', 'AF'], ['6AK', 'AF'], ['6AL', 'AF'], ['6AM', 'AF'], ['6AN', 'AF'], ['6AO', 'AF'], ['6AP', 'AF'], ['6AQ', 'AF'], ['6AR', 'AF'], ['6AS', 'AF'], ['6AT', 'AF'], ['6AU', 'AF'], ['6AV', 'AF'], ['6AW', 'AF'], ['6AX', 'AF'], ['6AY', 'AF'], ['6AZ', 'AF'],
  ['6BA', 'AF'], ['6BB', 'AF'], ['6BC', 'AF'], ['6BD', 'AF'], ['6BE', 'AF'], ['6BF', 'AF'], ['6BG', 'AF'], ['6BH', 'AF'], ['6BI', 'AF'], ['6BJ', 'AF'], ['6BK', 'AF'], ['6BL', 'AF'], ['6BM', 'AF'], ['6BN', 'AF'], ['6BO', 'AF'], ['6BP', 'AF'], ['6BQ', 'AF'], ['6BR', 'AF'], ['6BS', 'AF'], ['6BT', 'AF'], ['6BU', 'AF'], ['6BV', 'AF'], ['6BW', 'AF'], ['6BX', 'AF'], ['6BY', 'AF'], ['6BZ', 'AF'],
  ['SSA', 'AF'], ['SSB', 'AF'], ['SSC', 'AF'], ['SSD', 'AF'], ['SSE', 'AF'], ['SSF', 'AF'], ['SSG', 'AF'], ['SSH', 'AF'], ['SSI', 'AF'], ['SSJ', 'AF'], ['SSK', 'AF'], ['SSL', 'AF'], ['SSM', 'AF'], ['SSN', 'AF'],
  ['5A', 'AF'], ['CN', 'AF'], ['5C', 'AF'], ['5D', 'AF'], ['5E', 'AF'], ['5F', 'AF'], ['5G', 'AF'],
  ['Z8', 'AF'], ['ST', 'AF'], ['3V', 'AF'], ['TS', 'AF'], ['S0', 'AF'],
  ['TY', 'AF'], ['XT', 'AF'], ['TJ', 'AF'], ['D4', 'AF'], ['TL', 'AF'], ['TT', 'AF'], ['TU', 'AF'],
  ['9O', 'AF'], ['9P', 'AF'], ['9Q', 'AF'], ['9R', 'AF'], ['9S', 'AF'], ['9T', 'AF'],
  ['3C0', 'AF'], ['3C', 'AF'], ['TR', 'AF'], ['C5', 'AF'], ['9G', 'AF'], ['3X', 'AF'], ['J5', 'AF'],
  ['A8', 'AF'], ['D5', 'AF'], ['EL', 'AF'], ['5L', 'AF'], ['5M', 'AF'], ['6Z', 'AF'], ['TZ', 'AF'], ['5T', 'AF'], ['5U', 'AF'],
  ['5N', 'AF'], ['5O', 'AF'], ['TN', 'AF'], ['S9', 'AF'], ['6V', 'AF'], ['6W', 'AF'], ['9L', 'AF'], ['ZD7', 'AF'], ['ZD8', 'AF'], ['5V', 'AF'],
  ['D2', 'AF'], ['D3', 'AF'], ['A2', 'AF'], ['8O', 'AF'], ['9U', 'AF'], ['D6', 'AF'], ['J2', 'AF'], ['E3', 'AF'], ['3DA0', 'AF'],
  ['ET', 'AF'], ['9E', 'AF'], ['9F', 'AF'], ['5Y', 'AF'], ['5Z', 'AF'], ['7P', 'AF'], ['5R', 'AF'], ['5S', 'AF'], ['6X', 'AF'],
  ['7Q', 'AF'], ['3B', 'AF'], ['C8', 'AF'], ['C9', 'AF'], ['V5', 'AF'], ['9X', 'AF'], ['S7', 'AF'], ['6O', 'AF'], ['T5', 'AF'],
  ['ZR', 'AF'], ['ZS', 'AF'], ['ZT', 'AF'], ['ZU', 'AF'], ['5H', 'AF'], ['5I', 'AF'], ['ZD9', 'AF'], ['5X', 'AF'], ['9I', 'AF'], ['9J', 'AF'], ['Z2', 'AF'],
  // Asia (incl. Middle East)
  ['A9', 'AS'], ['EP', 'AS'], ['EQ', 'AS'], ['9B', 'AS'], ['9C', 'AS'], ['9D', 'AS'], ['YI', 'AS'], ['HN', 'AS'],
  ['4X', 'AS'], ['4Z', 'AS'], ['JY', 'AS'], ['9K', 'AS'], ['OD', 'AS'], ['A4', 'AS'], ['E4', 'AS'], ['A7', 'AS'],
  ['HZ', 'AS'], ['7Z', 'AS'], ['8Z', 'AS'], ['YK', 'AS'], ['6C', 'AS'], ['7O', 'AS'],
  ['T6', 'AS'], ['YA', 'AS'], ['S2', 'AS'], ['S3', 'AS'], ['A5', 'AS'], ['V8', 'AS'], ['XU', 'AS'],
  ['XS', 'AS'], ['3H', 'AS'], ['3I', 'AS'], ['3J', 'AS'], ['3K', 'AS'], ['3L', 'AS'], ['3M', 'AS'], ['3N', 'AS'], ['3O', 'AS'], ['3P', 'AS'], ['3Q', 'AS'], ['3R', 'AS'], ['3S', 'AS'], ['3T', 'AS'], ['3U', 'AS'],
  ['B', 'AS'], ['VR', 'AS'], ['XX', 'AS'], ['AT', 'AS'], ['AU', 'AS'], ['AV', 'AS'], ['AW', 'AS'], ['VT', 'AS'], ['VU', 'AS'], ['VW', 'AS'], ['8T', 'AS'], ['8Y', 'AS'],
  ['7A', 'AS'], ['7B', 'AS'], ['7C', 'AS'], ['7D', 'AS'], ['7E', 'AS'], ['7F', 'AS'], ['7G', 'AS'], ['7H', 'AS'], ['7I', 'AS'],
  ['8A', 'AS'], ['8B', 'AS'], ['8C', 'AS'], ['8D', 'AS'], ['8E', 'AS'], ['8F', 'AS'], ['8G', 'AS'], ['8H', 'AS'], ['8I', 'AS'],
  ['YB', 'AS'], ['YC', 'AS'], ['YD', 'AS'], ['YE', 'AS'], ['YF', 'AS'], ['YG', 'AS'], ['YH', 'AS'],
  ['JA', 'AS'], ['JB', 'AS'], ['JC', 'AS'], ['JD', 'AS'], ['JE', 'AS'], ['JF', 'AS'], ['JG', 'AS'], ['JH', 'AS'], ['JI', 'AS'], ['JJ', 'AS'], ['JK', 'AS'], ['JL', 'AS'], ['JM', 'AS'], ['JN', 'AS'], ['JO', 'AS'], ['JP', 'AS'], ['JQ', 'AS'], ['JR', 'AS'], ['JS', 'AS'],
  ['7J', 'AS'], ['7K', 'AS'], ['7L', 'AS'], ['7M', 'AS'], ['7N', 'AS'], ['8J', 'AS'], ['8K', 'AS'], ['8L', 'AS'], ['8M', 'AS'], ['8N', 'AS'],
  ['UN', 'AS'], ['UO', 'AS'], ['UP', 'AS'], ['UQ', 'AS'], ['EX', 'AS'], ['XW', 'AS'], ['9M', 'AS'], ['9W', 'AS'], ['8Q', 'AS'],
  ['JT', 'AS'], ['JU', 'AS'], ['JV', 'AS'], ['XY', 'AS'], ['XZ', 'AS'], ['9N', 'AS'],
  ['HM', 'AS'], ['P5', 'AS'], ['P6', 'AS'], ['P7', 'AS'], ['P8', 'AS'], ['P9', 'AS'],
  ['AP', 'AS'], ['AQ', 'AS'], ['AR', 'AS'], ['AS', 'AS'], ['6P', 'AS'], ['6Q', 'AS'], ['6R', 'AS'], ['6S', 'AS'],
  ['DU', 'AS'], ['DV', 'AS'], ['DW', 'AS'], ['DX', 'AS'], ['DY', 'AS'], ['DZ', 'AS'], ['4D', 'AS'], ['4E', 'AS'], ['4F', 'AS'], ['4G', 'AS'], ['4H', 'AS'], ['4I', 'AS'],
  ['9V', 'AS'], ['S6', 'AS'],
  ['HL', 'AS'], ['DS', 'AS'], ['DT', 'AS'], ['D7', 'AS'], ['D8', 'AS'], ['D9', 'AS'], ['6K', 'AS'], ['6L', 'AS'], ['6M', 'AS'], ['6N', 'AS'],
  ['4P', 'AS'], ['4Q', 'AS'], ['4R', 'AS'], ['4S', 'AS'], ['BV', 'AS'], ['EY', 'AS'], ['HS', 'AS'], ['E2', 'AS'],
  ['4W', 'AS'], ['EZ', 'AS'], ['UJ', 'AS'], ['UK', 'AS'], ['UL', 'AS'], ['UM', 'AS'],
  ['XV', 'AS'], ['3W', 'AS'], ['UA9', 'AS'], ['UA0', 'AS'], ['R9', 'AS'], ['R0', 'AS'],
  // Oceania
  ['AH8', 'OC'], ['KH8', 'OC'], ['NH8', 'OC'], ['WH8', 'OC'], ['AH1', 'OC'], ['KH1', 'OC'], ['NH1', 'OC'], ['WH1', 'OC'],
  ['ZL7', 'OC'], ['3D2', 'OC'], ['ZK1', 'OC'], ['T32', 'OC'], ['CE0', 'OC'], ['XQ0', 'OC'], ['XR0', 'OC'],
  ['V6', 'OC'], ['FO', 'OC'], ['TX', 'OC'], ['AH2', 'OC'], ['KH2', 'OC'], ['NH2', 'OC'], ['WH2', 'OC'],
  ['AH6', 'OC'], ['AH7', 'OC'], ['KH6', 'OC'], ['KH7', 'OC'], ['NH6', 'OC'], ['NH7', 'OC'], ['WH6', 'OC'], ['WH7', 'OC'],
  ['AH3', 'OC'], ['KH3', 'OC'], ['NH3', 'OC'], ['WH3', 'OC'], ['ZL8', 'OC'], ['KH5K', 'OC'],
  ['T33', 'OC'], ['T3', 'OC'], ['KH7K', 'OC'], ['VK0', 'OC'], ['V7', 'OC'], ['C2', 'OC'], ['FK', 'OC'],
  ['ZL', 'OC'], ['E6', 'OC'], ['AH0', 'OC'], ['KH0', 'OC'], ['NH0', 'OC'], ['WH0', 'OC'],
  ['T8', 'OC'], ['P2', 'OC'], ['VP6', 'OC'], ['5W', 'OC'], ['H4', 'OC'], ['H40', 'OC'], ['A3', 'OC'],
  ['T2', 'OC'], ['YJ', 'OC'], ['AH9', 'OC'], ['KH9', 'OC'], ['NH9', 'OC'], ['WH9', 'OC'], ['FW', 'OC'], ['VK', 'OC'],
].sort((a, b) => b[0].length - a[0].length);
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
let pskCacheReports  = null;
const MAX_PSK_REPORTS_RESPONSE = parseInt(process.env.PSK_MAX_REPORTS_RESPONSE || '8000', 10);

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
  return null;
}

function callsignCandidates(call) {
  const raw = String(call || '').toUpperCase().trim();
  if (!raw) return [];
  const parts = raw.split('/').map((s) => s.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  if (parts.length === 0) return [];
  const preferred = [];
  const appended = [];
  for (const p of parts) {
    // Portable markers should not drive region selection.
    if (p === 'P' || p === 'QRP' || p === 'QRP/P' || p === 'M' || p === 'MM' || p === 'AM') continue;
    // Prefer likely base calls over one-letter or numeric add-ons.
    if (/[A-Z]/.test(p) && /\d/.test(p) && p.length >= 3) preferred.push(p);
    else appended.push(p);
  }
  const seen = new Set();
  const ordered = [];
  for (const p of preferred.concat(appended)) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  return ordered;
}

function regionFromUsCallsign(baseCall) {
  const c = String(baseCall || '');
  if (!/^(?:[WKN][0-9]|A[A-L][0-9])/.test(c)) return null;
  for (const ch of c) {
    if (ch < '0' || ch > '9') continue;
    const d = parseInt(ch, 10);
    if (d === 0 || d === 5 || d === 9) return 'CNA';
    if (d === 6 || d === 7) return 'WNA';
    return 'ENA';
  }
  return null;
}

function classifyCallsignRegion(call) {
  const candidates = callsignCandidates(call);
  for (const c of candidates) {
    for (const [pfx, region] of CALLSIGN_REGION_PREFIXES) {
      if (c.startsWith(pfx)) return region;
    }
    const usRegion = regionFromUsCallsign(c);
    if (usRegion) return usRegion;
  }
  return null;
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
    if (Number.isNaN(snr) || Number.isNaN(freq)) continue;
    reports.push({ rxGrid, txGrid, rxCall, txCall, snr, freq });
  }
  return reports;
}

function foldPskReports(reports) {
  const bySample = {};
  for (const r of reports) {
    const rxLL = gridToLatLon(r.rxGrid);
    const txLL = gridToLatLon(r.txGrid);
    const fromRegion = classifyCallsignRegion(r.rxCall) || (rxLL ? regionFromLatLon(rxLL.lat, rxLL.lon) : null);
    const toRegion = classifyCallsignRegion(r.txCall) || (txLL ? regionFromLatLon(txLL.lat, txLL.lon) : null);
    if (!REGION_KEYS.includes(fromRegion) || !REGION_KEYS.includes(toRegion)) continue;

    const freqKhz = r.freq >= 100000 ? r.freq / 1000 : r.freq;
    const band = bandForFrequencyKhz(freqKhz);
    if (!band) continue;

    const correctedSnr = r.snr + 7.0; // 2500Hz -> ~500Hz bandwidth normalization
    bySample[fromRegion] ??= {};
    bySample[fromRegion][toRegion] ??= {};
    bySample[fromRegion][toRegion][band] ??= {
      snrValues: [],
      txCalls: new Set(),
      rxCalls: new Set(),
      rxGridCounts: new Map(),
    };
    const bucket = bySample[fromRegion][toRegion][band];
    bucket.snrValues.push(correctedSnr);
    if (r.txCall) bucket.txCalls.add(r.txCall);
    if (r.rxCall) bucket.rxCalls.add(r.rxCall);
    const rxGridCell = String(r.rxGrid || '').toUpperCase().slice(0, 4);
    if (rxGridCell.length === 4) {
      bucket.rxGridCounts.set(rxGridCell, (bucket.rxGridCounts.get(rxGridCell) || 0) + 1);
    }
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
          rxGridCounts: Array.from(bucket.rxGridCounts.entries()).sort((a, b) => b[1] - a[1]),
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

function compactPskReports(reports) {
  if (!Array.isArray(reports)) return [];
  return reports
    .slice(0, MAX_PSK_REPORTS_RESPONSE)
    .map((r) => ({
      rxGrid: r.rxGrid || '',
      txGrid: r.txGrid || '',
      rxCall: r.rxCall || '',
      txCall: r.txCall || '',
      snr: Number.isFinite(r.snr) ? r.snr : null,
      freq: Number.isFinite(r.freq) ? r.freq : null,
    }));
}

async function servePsk(res, query = {}) {
  const includeReports = query?.includeReports === '1' || query?.includeReports === 'true';
  const now = Date.now();
  if (pskCacheData && (now - pskCacheFetched) < PSK_CACHE_MS) {
    const payload = {
      age: Math.round((now - pskCacheFetched) / 1000),
      fetchedAt: new Date(pskCacheFetched).toISOString(),
      byRegion: pskCacheData,
      cached: true,
    };
    if (includeReports && pskCacheReports) payload.reports = pskCacheReports;
    send(res, 200, 'application/json', JSON.stringify({
      ...payload,
    }));
    return;
  }
  if (now < pskBlockedUntil) {
    const retryIn = Math.max(0, Math.round((pskBlockedUntil - now) / 1000));
    if (pskCacheData) {
      const payload = {
        age: Math.round((now - pskCacheFetched) / 1000),
        fetchedAt: new Date(pskCacheFetched).toISOString(),
        byRegion: pskCacheData,
        cached: true,
        stale: true,
        retryIn,
        error: pskLastError || 'psk_throttled',
      };
      if (includeReports && pskCacheReports) payload.reports = pskCacheReports;
      send(res, 200, 'application/json', JSON.stringify({
        ...payload,
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
      pskCacheReports = compactPskReports(reports);
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
    const payload = {
      age: Math.round((Date.now() - pskCacheFetched) / 1000),
      fetchedAt: new Date(pskCacheFetched).toISOString(),
      byRegion,
      cached: false,
    };
    if (includeReports && pskCacheReports) payload.reports = pskCacheReports;
    send(res, 200, 'application/json', JSON.stringify({
      ...payload,
    }));
  } catch (e) {
    if (pskCacheData) {
      const payload = {
        age: Math.round((Date.now() - pskCacheFetched) / 1000),
        fetchedAt: new Date(pskCacheFetched).toISOString(),
        byRegion: pskCacheData,
        cached: true,
        stale: true,
      };
      if (includeReports && pskCacheReports) payload.reports = pskCacheReports;
      send(res, 200, 'application/json', JSON.stringify({
        ...payload,
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
    try { await servePsk(res, parsed.query || {}); } catch (_) { send(res, 502, 'text/plain', 'PSK fetch error'); }
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

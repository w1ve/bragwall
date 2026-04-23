'use strict';

const http  = require('http');
const Database  = require('better-sqlite3');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

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
const SSB_SNR_THRESHOLD = parseFloat(process.env.SSB_SNR_THRESHOLD || '20');

const AUDIO_CACHE_MS = parseInt(process.env.AUDIO_CACHE_MS || String(15 * 60 * 1000), 10);
const AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || '/tmp/hfsignals-audio-cache';
const WAITING_AUDIO_PATH = path.join(AUDIO_CACHE_DIR, 'waiting-message.mp3');
const OUTRO_AUDIO_PATH   = path.join(AUDIO_CACHE_DIR, 'outro-static.mp3');
const OUTRO_TEXT = 'We depend on free data sources for this site. Thanks to N O A A, the Reverse Beacon Network, and PSKReporter for their free real-time data. This is a hobby site created by Gerry, W 1 V E. Enjoy!';
const AUDIO_GRID_LOOKUP_LIMIT = parseInt(process.env.AUDIO_GRID_LOOKUP_LIMIT || '240', 10);
const AUDIO_HAMDB_CACHE_MS = parseInt(process.env.AUDIO_HAMDB_CACHE_MS || String(24 * 60 * 60 * 1000), 10);
const AUDIO_HAMDB_NEG_CACHE_MS = parseInt(process.env.AUDIO_HAMDB_NEG_CACHE_MS || String(3 * 60 * 60 * 1000), 10);

const ASYNC_API_BASE = process.env.ASYNC_API_BASE || 'https://api.async.com';
const ASYNC_API_KEY = process.env.ASYNC_API_KEY || '';
const ASYNC_API_VERSION = process.env.ASYNC_API_VERSION || 'v1';
const ASYNC_MODEL_ID = process.env.ASYNC_MODEL_ID || 'async_flash_v1.0';
const ASYNC_VOICE_NAME = (process.env.ASYNC_VOICE_NAME || 'tucker').trim();
const ASYNC_VOICE_ID = (process.env.ASYNC_VOICE_ID || '').trim();
const ASYNC_MP3_SAMPLE_RATE = parseInt(process.env.ASYNC_MP3_SAMPLE_RATE || '44100', 10);
const ASYNC_MP3_BIT_RATE = parseInt(process.env.ASYNC_MP3_BIT_RATE || '128000', 10);

const AUDIO_SUPPORTED_TTS_LANGS = new Set(['en', 'fr', 'es', 'de', 'it', 'pt', 'ar', 'ru', 'ro', 'ja', 'he', 'hy', 'tr', 'hi', 'zh']);

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
const REGION_NAME_BY_KEY = {
  ENA: 'Eastern North America',
  CNA: 'Central North America',
  WNA: 'Western North America',
  CAR: 'Caribbean',
  SA: 'South America',
  EU: 'Europe',
  AF: 'Africa',
  AS: 'Asia',
  OC: 'Oceania',
};
const BAND_LABELS = BANDS.map((b) => b.label);
const BAND_LABEL_SET = new Set(BAND_LABELS);

// ── Signal history DB ─────────────────────────────────────────────────────────
const HISTORY_DB_PATH     = process.env.HISTORY_DB_PATH || '/data/history.db';
const HISTORY_SNAPSHOT_MS = 5 * 60 * 1000;        // 5-minute cadence
const HISTORY_KEEP_MS     = 24 * 60 * 60 * 1000;  // 24-hour retention

let histDb     = null;
let histInsert = null;

function initHistoryDb() {
  try {
    const dir = require('path').dirname(HISTORY_DB_PATH);
    require('fs').mkdirSync(dir, { recursive: true });
    histDb = new Database(HISTORY_DB_PATH);
    histDb.pragma('journal_mode = WAL');
    histDb.pragma('synchronous = NORMAL');
    histDb.exec(`
      CREATE TABLE IF NOT EXISTS band_snr (
        ts          INTEGER NOT NULL,
        vantage_key TEXT    NOT NULL,
        band        TEXT    NOT NULL,
        snr         REAL    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_band_snr_vantage_ts
        ON band_snr(vantage_key, ts);
    `);
    histInsert = histDb.prepare(
      'INSERT INTO band_snr(ts, vantage_key, band, snr) VALUES (?,?,?,?)'
    );
    console.log('[history] DB ready:', HISTORY_DB_PATH);
  } catch (e) {
    console.warn('[history] DB init failed:', e.message);
    histDb = null;
  }
}

function pruneHistory() {
  if (!histDb) return;
  try {
    const cutoff = Math.floor((Date.now() - HISTORY_KEEP_MS) / 1000);
    const r = histDb.prepare('DELETE FROM band_snr WHERE ts < ?').run(cutoff);
    if (r.changes > 0) console.log('[history] pruned', r.changes, 'rows');
  } catch (e) {
    console.warn('[history] prune error:', e.message);
  }
}

// Snapshot all 9 region vantages every 5 minutes.
// For each vantage (from-region), collect SNR values across ALL destination
// regions per band, then take the median — giving a single "how's the band
// sounding from here" number independent of direction.
function snapshotHistory() {
  if (!histDb || !histInsert) return;
  const ts             = Math.floor(Date.now() / 1000);
  const spotAgeCutoff  = Date.now() - 120_000;

  try {
    const insertMany = histDb.transaction((rows) => {
      for (const r of rows) histInsert.run(r.ts, r.vantage_key, r.band, r.snr);
    });

    const rows = [];

    for (const fromRegion of REGION_KEYS) {
      // band -> [snr values from all destinations]
      const bandSnrVals = {};
      for (const b of BAND_LABELS) bandSnrVals[b] = [];

      // Gather all RBN spots heard by skimmers in fromRegion
      for (const [, spot] of spotMap) {
        if (spot.lastSeen < spotAgeCutoff) continue;
        const band = bandForFrequencyKhz(spot.freq);
        if (!band) continue;
        for (const [spotter, snrVal] of Object.entries(spot.lsn || {})) {
          if (classifyCallsignRegion(spotter) !== fromRegion) continue;
          const snr = Number(snrVal);
          if (!Number.isFinite(snr)) continue;
          bandSnrVals[band].push(snr);
        }
      }

      // Merge PSK data: for each band, collect all PSK SNR values
      // across every destination region for this vantage
      if (pskCacheData && pskCacheData[fromRegion]) {
        for (const toRegion of REGION_KEYS) {
          const toData = pskCacheData[fromRegion][toRegion];
          if (!toData) continue;
          for (const band of BAND_LABELS) {
            const entry = toData[band];
            if (!entry || !Number.isFinite(entry.snr)) continue;
            const scaled = ftxSnrToRbnScale(entry.snr);
            if (Number.isFinite(scaled)) bandSnrVals[band].push(scaled);
          }
        }
      }

      // Compute median per band and store
      for (const band of BAND_LABELS) {
        const vals = bandSnrVals[band];
        if (vals.length === 0) continue;
        const snr = Math.max(0, Math.round(median(vals) * 10) / 10);
        rows.push({ ts, vantage_key: fromRegion, band, snr });
      }
    }

    if (rows.length > 0) insertMany(rows);
    pruneHistory();
  } catch (e) {
    console.warn('[history] snapshot error:', e.message);
  }
}

// GET /history?vantage=ENA
// vantage is a region key. Grid mode on the client maps to the nearest region.
function serveHistory(res, query) {
  if (!histDb) {
    sendJson(res, 503, { error: 'history_unavailable' });
    return;
  }

  const vantage = (query.vantage || 'ENA').toUpperCase();
  if (!REGION_KEY_SET.has(vantage)) {
    sendJson(res, 400, { error: 'bad_vantage', valid: Array.from(REGION_KEY_SET) });
    return;
  }

  const cutoff = Math.floor((Date.now() - HISTORY_KEEP_MS) / 1000);
  let rows, earliest;
  try {
    rows = histDb.prepare(
      'SELECT ts, band, snr FROM band_snr WHERE vantage_key=? AND ts>=? ORDER BY ts ASC'
    ).all(vantage, cutoff);
    const r = histDb.prepare(
      'SELECT MIN(ts) AS mn FROM band_snr WHERE vantage_key=?'
    ).get(vantage);
    earliest = r?.mn ?? null;
  } catch (e) {
    sendJson(res, 500, { error: 'db_error', message: e.message });
    return;
  }

  sendJson(res, 200, { vantage, bands: BAND_LABELS, earliest, points: rows });
}

// ── Waiting audio (plays immediately while TTS is generating) ─────────────────
let waitingAudioGenerating = false;

async function ensureWaitingAudio() {
  if (waitingAudioGenerating) return;
  try {
    await fs.promises.access(WAITING_AUDIO_PATH);
    return; // already exists — nothing to do
  } catch {}
  if (!ASYNC_API_KEY) return;
  waitingAudioGenerating = true;
  try {
    await ensureAudioCacheDir();
    await streamAsyncTtsToFile('One moment while we generate your custom report.', 'en', WAITING_AUDIO_PATH);
    console.log('[audio] waiting message generated');
  } catch (e) {
    console.warn('[audio] waiting message generation failed:', e?.message || e);
  } finally {
    waitingAudioGenerating = false;
  }
}

async function serveWaitingAudio(res) {
  try {
    await fs.promises.access(WAITING_AUDIO_PATH);
  } catch {
    // Not yet generated — trigger generation in background, return 404
    ensureWaitingAudio().catch(() => {});
    sendJson(res, 404, { error: 'waiting_audio_not_ready' });
    return;
  }
  sendAudioFile(res, WAITING_AUDIO_PATH, false, 'en');
}

async function serveAudioPropReport(req, res, query = {}) {
  if (!ASYNC_API_KEY) {
    sendJson(res, 503, { error: 'audio_unavailable', reason: 'ASYNC_API_KEY missing' });
    return;
  }
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || null;
  const params = await parseAudioQuery(query, req.headers || {}, clientIp);
  if (params.mode === 'grid' && !params.grid) {
    sendJson(res, 400, { error: 'invalid_grid', message: 'grid mode requires valid 4-char grid parameter' });
    return;
  }

  await ensureAudioCacheDir();

  // --- CACHE CHECK (before any expensive work) ---
  const keyHash = hashText(stableAudioParamKey(params));
  const bucket  = bucketForNow(AUDIO_CACHE_MS);
  const prefix  = `${keyHash}-`;
  const fileName = `${prefix}${bucket}.mp3`;
  const outPath  = path.join(AUDIO_CACHE_DIR, fileName);

  try {
    const st = await fs.promises.stat(outPath);
    if ((Date.now() - st.mtimeMs) < AUDIO_CACHE_MS) {
      console.log('[audio] cache hit:', fileName);
      sendAudioFile(res, outPath, false, params.lang);
      return;
    }
  } catch {}
  // --- END CACHE CHECK ---

  await ensurePskForAudio();
  if (params.mode === 'grid' && params.grid) {
    const geo = await reverseGeoGrid(params.grid);
    params.gridPlaceName = geo.spoken;
  }
  const regionResults = await collectBandResultsPerRegion(params);
  const solar = await fetchSolarDataForAudio();
  const sourceStats = countSourceStats(params);
  const englishText = buildAudioReportText(params, regionResults, solar, sourceStats);
  const translatedText = await translateTextIfNeeded(englishText, params.lang);
  const transcript = translatedText && translatedText.trim() ? translatedText : englishText;

  try {
    await deleteMatchingAudio(prefix);
    // Generate the dynamic portion first
    const dynamicPath = `${outPath}.dynamic-tmp`;
    await streamAsyncTtsToFile(transcript, params.lang, dynamicPath);

    // Stitch static outro (English only — skip for translated reports)
    let finalPath = dynamicPath;
    if (params.lang === 'en' || !params.lang) {
      try {
        await ensureOutroAudio();
        await concatMp3Files(dynamicPath, OUTRO_AUDIO_PATH, outPath);
        await fs.promises.unlink(dynamicPath).catch(() => {});
        finalPath = outPath;
      } catch (stitchErr) {
        console.warn('[audio] outro stitch failed, serving dynamic only:', stitchErr?.message);
        await fs.promises.rename(dynamicPath, outPath).catch(() => {});
        finalPath = outPath;
      }
    } else {
      await fs.promises.rename(dynamicPath, outPath).catch(() => {});
    }

    sendAudioFile(res, finalPath, true, params.lang);
  } catch (e) {
    console.error('[audio] generation failed:', e?.message || e);
    sendJson(res, 502, { error: 'audio_generation_failed', reason: String(e?.message || e || 'unknown') });
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
  if (parts[0] === 'audio' && parts[1] === 'tooltip') {
    const q = parsed.query || {};
    const lang = normalizeLanguageCode(q.lang || q.language || req.headers['accept-language'] || 'en');
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || null;
    // Geo-detect language if not supplied
    let resolvedLang = lang;
    if (!q.lang && !q.language && clientIp) {
      try {
        const geoInfo = await countryFromIp(clientIp);
        if (geoInfo && geoInfo.countryCode) {
          // Map country code to language (best-effort)
          const CC_LANG = { FR:'fr', ES:'es', MX:'es', AR:'es', CO:'es', CL:'es', PE:'es',
            DE:'de', AT:'de', CH:'de', IT:'it', PT:'pt', BR:'pt', RU:'ru', JP:'ja',
            CN:'zh', TW:'zh', HK:'zh', SA:'ar', EG:'ar', IL:'he', TR:'tr', RO:'ro',
            IN:'hi', HY:'hy', AM:'hy' };
          resolvedLang = CC_LANG[geoInfo.countryCode] || lang;
        }
      } catch {}
    }
    sendJson(res, 200, { tooltip: audioTooltipText(resolvedLang), lang: outputLanguage(resolvedLang) });
    return;
  }
  if (parts[0] === 'gridinfo') {
    const grid4 = ((parsed.query || {}).grid || '').toUpperCase().slice(0, 4);
    if (!grid4 || grid4.length < 4) { sendJson(res, 400, { error: 'bad_grid' }); return; }
    const ll = gridToLatLon(grid4);
    if (!ll) { sendJson(res, 400, { error: 'invalid_grid' }); return; }
    const geo = await reverseGeoGrid(grid4);
    sendJson(res, 200, { grid: grid4, lat: ll.lat, lon: ll.lon, place: geo.display });
    return;
  }
  if (parts[0] === 'audio' && parts[1] === 'waiting') {
    try { await serveWaitingAudio(res); } catch (e) {
      sendJson(res, 502, { error: 'waiting_audio_error' });
    }
    return;
  }
  if (parts[0] === 'audio' && (parts[1] === 'propreport' || parts[1] === 'report')) {
    try { await serveAudioPropReport(req, res, parsed.query || {}); } catch (e) {
      console.error('[audio] report error:', e?.message || e);
      sendJson(res, 502, { error: 'audio_report_error', reason: String(e?.message || e || 'unknown') });
    }
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
  if (parts[0] === 'history') {
    serveHistory(res, parsed.query || {});
    return;
  }
  send(res, 404, 'text/plain', 'Not found');
});

// ── Static outro audio (attribution + W1VE sign-off) ────────────────────────
let outroAudioGenerating = false;

async function ensureOutroAudio() {
  if (outroAudioGenerating) return;
  try {
    await fs.promises.access(OUTRO_AUDIO_PATH);
    return; // already exists
  } catch {}
  if (!ASYNC_API_KEY) return;
  outroAudioGenerating = true;
  try {
    await ensureAudioCacheDir();
    await streamAsyncTtsToFile(OUTRO_TEXT, 'en', OUTRO_AUDIO_PATH);
    console.log('[audio] outro generated');
  } catch (e) {
    console.warn('[audio] outro generation failed:', e?.message || e);
  } finally {
    outroAudioGenerating = false;
  }
}

// Concatenate two MP3 files by simple byte concatenation (valid for CBR/same-format MP3s)
async function concatMp3Files(part1Path, part2Path, outPath) {
  const [a, b] = await Promise.all([
    fs.promises.readFile(part1Path),
    fs.promises.readFile(part2Path),
  ]);
  const tmp = `${outPath}.concat-tmp`;
  await fs.promises.writeFile(tmp, Buffer.concat([a, b]));
  await fs.promises.rename(tmp, outPath);
}

// Pre-generate waiting audio in background at startup
ensureAudioCacheDir().then(() => ensureWaitingAudio()).catch(() => {});

// Pre-generate static outro in background at startup
ensureAudioCacheDir().then(() => ensureOutroAudio()).catch(() => {});

// ── History DB startup ───────────────────────────────────────────────────────
initHistoryDb();
setInterval(snapshotHistory, HISTORY_SNAPSHOT_MS);
// Take an initial snapshot after 60s (proxy may not have data yet at startup)
setTimeout(snapshotHistory, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RBN proxy listening on 0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));




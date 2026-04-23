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

// Last grid vantage seen from a client poll — {grid, rangeKm}
let lastGridVantage = null;

function initHistoryDb() {
  try {
    const dir = require('path').dirname(HISTORY_DB_PATH);
    require('fs').mkdirSync(dir, { recursive: true });
    histDb = new Database(HISTORY_DB_PATH);
    histDb.pragma('journal_mode = WAL');
    histDb.pragma('synchronous = NORMAL');

    // ── Schema migration: drop old from_rgn/to_rgn layout ──────────────────
    // Earlier versions stored per-direction rows; current code uses vantage_key.
    // If the table exists with the old schema, drop it so it gets recreated.
    const cols = histDb.prepare(
      "SELECT name FROM pragma_table_info('band_snr')"
    ).all().map(r => r.name);
    if (cols.length > 0 && !cols.includes('vantage_key')) {
      console.log('[history] old schema detected — dropping band_snr for migration');
      histDb.exec('DROP TABLE IF EXISTS band_snr; DROP INDEX IF EXISTS idx_band_snr_vantage_ts;');
    }
    // ───────────────────────────────────────────────────────────────────────

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

    // ── Grid vantage snapshot ──────────────────────────────────────
    // Uses region-based approximation: classify grid center → region, then
    // use same RBN+PSK data as the region snapshot for that region.
    // This avoids async HamDB lookups during a background timer.
    if (lastGridVantage) {
      const { grid, rangeKm } = lastGridVantage;
      const vkey = `GRID:${grid}:${rangeKm}`;
      const gridLL = gridToLatLon(grid);
      if (gridLL) {
        const gridRegion = regionFromLatLon(gridLL.lat, gridLL.lon);
        if (gridRegion) {
          const gridBandSnr = {};
          for (const b of BAND_LABELS) gridBandSnr[b] = [];

          // RBN: spotters whose region matches the grid's region
          for (const [, spot] of spotMap) {
            if (spot.lastSeen < spotAgeCutoff) continue;
            const band = bandForFrequencyKhz(spot.freq);
            if (!band) continue;
            for (const [spotter, snrVal] of Object.entries(spot.lsn || {})) {
              if (classifyCallsignRegion(spotter) !== gridRegion) continue;
              const snr = Number(snrVal);
              if (Number.isFinite(snr)) gridBandSnr[band].push(snr);
            }
          }

          // PSK: aggregate all toRegions from the grid's fromRegion
          if (pskCacheData && pskCacheData[gridRegion]) {
            for (const toData of Object.values(pskCacheData[gridRegion])) {
              for (const [band, entry] of Object.entries(toData || {})) {
                if (!BAND_LABELS.includes(band)) continue;
                if (!entry || !Number.isFinite(entry.snr)) continue;
                gridBandSnr[band].push(entry.snr);
              }
            }
          }

          for (const band of BAND_LABELS) {
            const vals = gridBandSnr[band];
            if (vals.length === 0) continue;
            const snr = Math.max(0, Math.round(median(vals) * 10) / 10);
            rows.push({ ts, vantage_key: vkey, band, snr });
          }
        }
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
  // Accept both region keys (ENA) and grid keys (GRID:FN42:500)
  if (!REGION_KEY_SET.has(vantage) && !vantage.startsWith('GRID:')) {
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
const REGION_KEY_SET = new Set(REGION_KEYS);

const hamdbAudioCache = new Map();
const gridPlaceCache = new Map();     // grid4 → { name, expiresAt }
const GRID_PLACE_CACHE_MS = 24 * 60 * 60 * 1000; // 24 h
let asyncVoiceIdCache = ASYNC_VOICE_ID || null;
let asyncVoiceLookupPromise = null;
let audioCacheDirReady = false;

function pruneSpots() {
  const cutoff = Date.now() - SPOT_KEEP_MS;
  for (const [k, v] of spotMap) { if (v.lastSeen < cutoff) spotMap.delete(k); }
}

function addSpot(spotter, freq, dxCall, mode, snr) {
  const now = Date.now();
  const band = bandForFrequencyKhz(freq);
  if (!band) return; // ignore out-of-band spots
  const key = `${dxCall}|${band}`;
  if (!spotMap.has(key)) {
    spotMap.set(key, { freq, mode, dxCall, firstSeen: now, lastSeen: now, lsn: {} });
  }
  const s = spotMap.get(key);
  s.lsn[spotter] = snr;
  s.lastSeen = now;
  s.freq = freq;
  s.mode = mode;
}

function buildRbnResponse() {
  pruneSpots();
  const now = Date.now();
  const out = {};
  for (const [, s] of spotMap) {
    // Key includes band so each DX station can appear on multiple bands simultaneously.
    const outKey = `${s.dxCall}|${bandForFrequencyKhz(s.freq)}`;
    out[outKey] = {
      dxcall: s.dxCall,
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

function sendJson(res, status, obj) {
  send(res, status, 'application/json', JSON.stringify(obj));
}

function safeUpper(v) {
  return String(v || '').trim().toUpperCase();
}

function normalizeLanguageCode(raw) {
  const source = String(raw || '').trim();
  if (!source) return 'en';
  const first = source.split(',')[0].trim();
  const primary = first.split('-')[0].toLowerCase();
  if (!primary) return 'en';
  return primary;
}

function normalizeRegionKey(raw) {
  const u = safeUpper(raw);
  if (!u) return null;
  if (REGION_KEY_SET.has(u)) return u;
  if (u === 'NA') return 'ENA';
  return null;
}

function parseToRegions(raw) {
  const u = safeUpper(raw);
  if (!u || u === 'ALL' || u === '*') return REGION_KEYS.slice();
  const out = [];
  const seen = new Set();
  for (const part of u.split(/[,\s]+/g).filter(Boolean)) {
    const key = normalizeRegionKey(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length ? out : REGION_KEYS.slice();
}

function parseBandSelection(rawBand, rawBands) {
  const value = String(rawBands || rawBand || '').trim();
  if (!value || /^all$/i.test(value)) return BAND_LABELS.slice();
  const out = [];
  const seen = new Set();
  for (const p of value.split(/[,\s]+/g).filter(Boolean)) {
    const band = p.toLowerCase().endsWith('m') ? p.toLowerCase() : `${p.toLowerCase()}m`;
    if (!BAND_LABEL_SET.has(band) || seen.has(band)) continue;
    seen.add(band);
    out.push(band);
  }
  return out.length ? out : BAND_LABELS.slice();
}

function sanitizeGrid(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return '';
  return g.slice(0, 4);
}

function parseBoolean(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parsePositive(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function utcTimeLabel() {
  const d = new Date();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function countryFromIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  try {
    const raw = await fetchRaw(`https://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode,timezone`, 4000);
    const data = JSON.parse(raw);
    if (data && data.countryCode) return { countryCode: data.countryCode, timezone: data.timezone || null };
  } catch {}
  return null;
}

function localHourFromTimezone(timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone });
    const parts = fmt.formatToParts(new Date());
    const h = parts.find(p => p.type === 'hour');
    return h ? Number(h.value) : null;
  } catch {}
  return null;
}

function timeOfDayFromLocalHour(localHour) {
  if (localHour === null) return null;
  if (localHour < 12) return 'morning';
  if (localHour < 18) return 'afternoon';
  return 'evening';
}

function pronounceUtc(utcStr) {
  // utcStr = "HH:MM" → "Zero Nine Thirty Seven" or "Twenty Three Twenty Five"
  if (!/^\d{2}:\d{2}$/.test(utcStr)) return utcStr;
  const ones = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
  const teens = ['Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty'];

  function sayTwoDigit(n) {
    if (n < 10) return 'Zero ' + ones[n];
    if (n < 20) return teens[n - 10];
    const t = Math.floor(n / 10);
    const u = n % 10;
    return u === 0 ? tens[t] : tens[t] + ' ' + ones[u];
  }

  const hh = Number(utcStr.slice(0, 2));
  const mm = Number(utcStr.slice(3, 5));
  const hhText = sayTwoDigit(hh);
  const mmText = mm === 0 ? 'Hundred' : sayTwoDigit(mm);
  return hhText + ' ' + mmText;
}

function pickTimeOfDay(raw, utcLabel, localHour) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'morning' || v === 'afternoon' || v === 'evening') return v;
  // Prefer local hour from IP geo if available
  if (localHour !== null && localHour !== undefined) return timeOfDayFromLocalHour(localHour);
  let hh = 12;
  if (typeof utcLabel === 'string' && /^\d{2}:\d{2}$/.test(utcLabel)) hh = Number(utcLabel.slice(0, 2));
  if (hh < 12) return 'morning';
  if (hh < 18) return 'afternoon';
  return 'evening';
}

function greetingForTimeOfDay(tod) {
  if (tod === 'morning') return 'Good Morning';
  if (tod === 'afternoon') return 'Good Afternoon';
  return 'Good Evening';
}

function regionName(key) {
  return REGION_NAME_BY_KEY[key] || key;
}

function snrToSUnit(snr) {
  if (!Number.isFinite(snr)) return '0dB';
  const db = Math.round(snr);
  return (db >= 0 ? '+' : '') + db + 'dB';
}

function ftxSnrToRbnScale(ftxSnr) {
  if (!Number.isFinite(ftxSnr)) return null;
  const minDb = -20;
  const maxDb = 20;
  const frac = Math.max(0, Math.min((ftxSnr - minDb) / (maxDb - minDb), 1));
  return 2 + frac * 20;
}

async function ensureAudioCacheDir() {
  if (audioCacheDirReady) return;
  await fs.promises.mkdir(AUDIO_CACHE_DIR, { recursive: true });
  // Purge stale dynamic cache files on startup (static waiting/outro are exempt)
  const staticFiles = new Set([
    path.basename(WAITING_AUDIO_PATH),
    path.basename(OUTRO_AUDIO_PATH),
  ]);
  try {
    const files = await fs.promises.readdir(AUDIO_CACHE_DIR);
    await Promise.all(
      files
        .filter(f => f.endsWith('.mp3') && !staticFiles.has(f))
        .map(f => fs.promises.unlink(path.join(AUDIO_CACHE_DIR, f)).catch(() => {}))
    );
    if (files.filter(f => f.endsWith('.mp3') && !staticFiles.has(f)).length > 0)
      console.log('[audio] startup cache purge complete');
  } catch {}
  audioCacheDirReady = true;
}

function stableAudioParamKey(params) {
  // NOTE: timeOfDay/utc/greeting are NOT included — they are cosmetic and must
  // not bust the cache. The cache key is purely the signal-data parameters.
  // NOTE: cw/rtty/ftx/ssb are NOT included — the server always uses all modes
  // from live data. Including them caused cache misses on every request because
  // the frontend computed them from live signal state (changed each click).
  const obj = {
    mode: params.mode,
    fromRegion: params.fromRegion || null,
    grid: params.grid || null,
    radius: params.radius || null,
    unit: params.unit || 'mi',
    toRegions: params.toRegions.slice().sort(),
    bands: params.bands.slice(),
    lang: params.lang,
  };
  return JSON.stringify(obj);
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function bucketForNow(msWindow) {
  return Math.floor(Date.now() / msWindow);
}

async function deleteMatchingAudio(prefix) {
  try {
    const files = await fs.promises.readdir(AUDIO_CACHE_DIR);
    await Promise.all(
      files
        .filter((f) => f.startsWith(prefix))
        .map((f) => fs.promises.unlink(path.join(AUDIO_CACHE_DIR, f)).catch(() => {}))
    );
  } catch {}
}

function outputLanguage(ttsLang) {
  if (!ttsLang || !AUDIO_SUPPORTED_TTS_LANGS.has(ttsLang)) return 'en';
  return ttsLang;
}

const AUDIO_TOOLTIP_TRANSLATIONS = {
  en: 'Audio Radio Conditions Report (updated every 15 minutes)',
  fr: 'Rapport audio sur les conditions radio (mis à jour toutes les 15 minutes)',
  es: 'Informe de condiciones de radio en audio (actualizado cada 15 minutos)',
  de: 'Audio-Funkbedingungsbericht (alle 15 Minuten aktualisiert)',
  it: 'Rapporto audio sulle condizioni radio (aggiornato ogni 15 minuti)',
  pt: 'Relatório de condições de rádio em áudio (atualizado a cada 15 minutos)',
  ar: 'تقرير صوتي لأحوال الراديو (يُحدَّث كل 15 دقيقة)',
  ru: 'Аудиоотчёт о состоянии радиосвязи (обновляется каждые 15 минут)',
  ro: 'Raport audio privind condițiile radio (actualizat la fiecare 15 minute)',
  ja: '無線コンディション音声レポート（15分ごとに更新）',
  he: 'דוח קולי על מצב הרדיו (מתעדכן כל 15 דקות)',
  hy: 'Ռադիոյի պայմանների ձայնային զեկույց (թարմացվում է ամեն 15 րոպեն)',
  tr: 'Sesli Radyo Koşulları Raporu (her 15 dakikada bir güncellenir)',
  hi: 'ऑडियो रेडियो स्थितियाँ रिपोर्ट (हर 15 मिनट में अपडेट होती है)',
  zh: '无线电条件音频报告（每15分钟更新一次）',
};

function audioTooltipText(lang) {
  const code = outputLanguage(lang);
  return AUDIO_TOOLTIP_TRANSLATIONS[code] || AUDIO_TOOLTIP_TRANSLATIONS['en'];
}

function bandResultTemplate() {
  return {
    rbnSnrValues: [],
    rbnModes: new Set(),
    ftxSnrValues: [],
  };
}

async function parseAudioQuery(query = {}, headers = {}, clientIp = null) {
  const modeFromQuery = String(query.mode || '').trim().toLowerCase();
  const mode = modeFromQuery === 'grid' ? 'grid' : 'region';
  const grid = sanitizeGrid(query.grid || query.sourceGrid || '');
  // For grid mode, derive fromRegion from the grid square's lat/lon (same as UI)
  let fromRegion;
  if (mode === 'grid' && grid) {
    const gll = gridToLatLon(grid);
    fromRegion = (gll ? regionFromLatLon(gll.lat, gll.lon) : null) || 'ENA';
  } else {
    fromRegion = normalizeRegionKey(query.from || query.region || query.source || 'ENA') || 'ENA';
  }
  const unit = String(query.unit || 'mi').toLowerCase() === 'km' ? 'km' : 'mi';
  const radius = parsePositive(query.radius || query.range, unit === 'km' ? 500 : 500);
  const radiusMiles = unit === 'km' ? radius * 0.621371 : radius;
  const toRegions = parseToRegions(query.to || query.destination || 'all');
  const bands = parseBandSelection(query.band, query.bands);
  const lang = 'en'; // Always English — never inherit browser accept-language
  const utc = String(query.utc || utcTimeLabel()).trim();

  // IP geo-detect country & local time for accurate greeting
  let localHour = null;
  const ip = clientIp || (headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  if (ip) {
    const geoInfo = await countryFromIp(ip);
    if (geoInfo && geoInfo.timezone) localHour = localHourFromTimezone(geoInfo.timezone);
  }
  const timeOfDay = pickTimeOfDay(query.timeOfDay || query.tod, utc, localHour);

  const ssb = parseBoolean(query.ssb || query.includeSsb || query.ssbChecked);
  // solar=0 suppresses the solar/geomagnetic block (useful for automated/API calls)
  const includeSolar = query.solar !== undefined ? parseBoolean(query.solar) : true;
  // Mode flags (kept for cache key stability; mode reporting now derives from data)
  const cwChecked   = query.cw   !== undefined ? parseBoolean(query.cw)   : true;
  const rttyChecked = query.rtty !== undefined ? parseBoolean(query.rtty) : true;
  const ftxChecked  = query.ftx  !== undefined ? parseBoolean(query.ftx)  : true;
  return {
    mode,
    fromRegion,
    grid,
    unit,
    radius,
    radiusMiles,
    toRegions,
    bands,
    lang,
    utc,
    timeOfDay,
    ssb,
    includeSolar,
    cwChecked,
    rttyChecked,
    ftxChecked,
  };
}

async function resolveSpotterLatLonAudio(call) {
  const upper = safeUpper(call).split('/')[0];
  if (!upper || !CALLSIGN_RE.test(upper)) return null;
  const cached = hamdbAudioCache.get(upper);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.latLon;
  try {
    const raw = await fetchRaw(`${HAMDB_BASE}${upper}/json`, 8000);
    const data = JSON.parse(raw);
    const cs = data?.hamdb?.callsign || null;
    let latLon = null;
    if (cs) {
      if (cs.grid) {
        const ll = gridToLatLon(String(cs.grid).trim().toUpperCase());
        if (ll) latLon = ll;
      }
      if (!latLon) {
        const lat = parseFloat(cs.lat);
        const lon = parseFloat(cs.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) latLon = { lat, lon };
      }
    }
    hamdbAudioCache.set(upper, {
      latLon,
      expiresAt: now + (latLon ? AUDIO_HAMDB_CACHE_MS : AUDIO_HAMDB_NEG_CACHE_MS),
    });
    return latLon;
  } catch {
    hamdbAudioCache.set(upper, { latLon: null, expiresAt: now + AUDIO_HAMDB_NEG_CACHE_MS });
    return null;
  }
}

async function ensurePskForAudio() {
  if (pskCacheData && (Date.now() - pskCacheFetched) < PSK_CACHE_MS) return;
  if (!pskFetchPromise) {
    pskFetchPromise = (async () => {
      const modeFetches = await Promise.allSettled(PSK_MODES.map(fetchPskMode));
      const reports = [];
      for (const mr of modeFetches) {
        if (mr.status === 'fulfilled') reports.push(...mr.value);
      }
      if (reports.length === 0) throw new Error('no_psk_reports');
      pskCacheData = foldPskReports(reports);
      pskCacheReports = compactPskReports(reports);
      pskCacheFetched = Date.now();
      pskLastError = null;
      pskBlockedUntil = 0;
      return pskCacheData;
    })().finally(() => { pskFetchPromise = null; });
  }
  try {
    await pskFetchPromise;
  } catch {
    // Keep stale cache fallback behavior.
  }
}

async function collectRbnBandResults(params) {
  pruneSpots(); // ensure stale entries are removed before audio processing
  const bandState = {};
  for (const b of params.bands) bandState[b] = bandResultTemplate();

  const gridLL = params.mode === 'grid' ? gridToLatLon(params.grid) : null;
  const spotterKeys = new Set();
  if (params.mode === 'grid') {
    for (const s of spotMap.values()) {
      for (const spotter of Object.keys(s.lsn || {})) {
        spotterKeys.add(spotter);
        if (spotterKeys.size >= AUDIO_GRID_LOOKUP_LIMIT) break;
      }
      if (spotterKeys.size >= AUDIO_GRID_LOOKUP_LIMIT) break;
    }
  }
  const spotterLL = {};
  if (params.mode === 'grid' && gridLL) {
    await Promise.all(Array.from(spotterKeys).map(async (spotter) => {
      const ll = await resolveSpotterLatLonAudio(spotter);
      if (ll) spotterLL[spotter] = ll;
    }));
  }

  const spotAgeCutoff = Date.now() - 120_000; // match UI 120-second freshness window
  for (const [, spot] of spotMap) {
    if (spot.lastSeen < spotAgeCutoff) continue; // skip stale spots, same as UI
    const band = bandForFrequencyKhz(spot.freq);
    if (!band || !bandState[band]) continue;
    const toRegion = classifyCallsignRegion(spot.dxCall);
    if (!toRegion || !params.toRegions.includes(toRegion)) continue;
    for (const [spotter, snr] of Object.entries(spot.lsn || {})) {
      let sourceOk = false;
      if (params.mode === 'region') {
        sourceOk = classifyCallsignRegion(spotter) === params.fromRegion;
      } else if (gridLL) {
        const ll = spotterLL[spotter];
        if (ll) sourceOk = distanceMiles(gridLL.lat, gridLL.lon, ll.lat, ll.lon) <= params.radiusMiles;
      }
      if (!sourceOk) continue;
      const nSNR = Number(snr);
      if (!Number.isFinite(nSNR)) continue;
      bandState[band].rbnSnrValues.push(nSNR);
      bandState[band].rbnModes.add(safeUpper(spot.mode));
    }
  }

  return bandState;
}

function augmentWithPskBandResults(params, bandState) {
  // Both region and grid modes use pskCacheData[fromRegion][toRegion][band].
  // fromRegion is derived from grid lat/lon in parseAudioQuery for grid mode,
  // so this lookup is identical to what the UI does.
  if (!pskCacheData) return;
  for (const toRegion of params.toRegions) {
    for (const band of params.bands) {
      const entry = pskCacheData?.[params.fromRegion]?.[toRegion]?.[band];
      if (!entry || !Number.isFinite(entry.snr)) continue;
      bandState[band].ftxSnrValues.push(entry.snr);
    }
  }
}

function finalizeBandResults(params, bandState) {
  const out = {};
  for (const band of params.bands) {
    const b = bandState[band] || bandResultTemplate();
    const rbnSnr = median(b.rbnSnrValues);
    const ftxSnr = median(b.ftxSnrValues);
    const ftxScaled = ftxSnrToRbnScale(ftxSnr);
    let combined = null;
    if (Number.isFinite(rbnSnr) && Number.isFinite(ftxScaled)) combined = (rbnSnr * 0.85) + (ftxScaled * 0.15);
    else if (Number.isFinite(rbnSnr)) combined = rbnSnr;
    else if (Number.isFinite(ftxScaled)) combined = ftxScaled;
    const hasSignal = Number.isFinite(combined);
    // Build mode set from RBN data — only add PSK-sourced modes if PSK_MODES includes them
    const modes = new Set(Array.from(b.rbnModes || []));
    // PSKReporter feed is FT8-only (no FT4 in this pipeline); add FT8 only if PSK data present
    if (Number.isFinite(ftxSnr)) {
      modes.add('FT8');
      // Note: FT4 is NOT added — PSKReporter rronly feed does not surface FT4 via this integration
    }
    // Apply mode filters from params (respect UI checkbox state)
    if (!params.cwChecked)   modes.delete('CW');
    if (!params.rttyChecked) modes.delete('RTTY');
    if (!params.ftxChecked) { modes.delete('FT8'); modes.delete('FT4'); }
    out[band] = {
      hasSignal,
      snr: hasSignal ? Math.round(combined * 10) / 10 : null,
      sUnit: hasSignal ? snrToSUnit(combined) : null,
      modes: modes,
      cwRttyFtx: hasSignal && (modes.has('CW') || modes.has('RTTY') || modes.has('FT8') || modes.has('FT4')),
      ssbOk: hasSignal && combined >= SSB_SNR_THRESHOLD, // per-band threshold
    };
  }
  return out;
}

function bandLabelSpoken(band) {
  // "20m" => "20 meters", "160m" => "160 meters"
  return band.replace(/m$/, ' meters');
}

function bandNumberOnly(band) {
  // "20m" => "20", "160m" => "160"
  return band.replace(/m$/, '');
}

function bandListSpoken(bands) {
  // Produces compact speech: "20, 15, and 10 meters" instead of repeating "meters"
  if (bands.length === 0) return '';
  if (bands.length === 1) return bandLabelSpoken(bands[0]);
  const nums = bands.map(bandNumberOnly);
  if (nums.length === 2) return `${nums[0]} and ${nums[1]} meters`;
  return nums.slice(0, -1).join(', ') + `, and ${nums[nums.length - 1]} meters`;
}

function spokenSnr(snr) {
  // returns e.g. "plus 6 decibels" or "minus 2 decibels"
  if (!Number.isFinite(snr)) return 'unknown';
  const db = Math.round(snr);
  const sign = db >= 0 ? 'plus' : 'minus';
  return `${sign} ${Math.abs(db)} decibels`;
}

function pronounceGrid(grid) {
  // "FN34" => "F N Three Four", "EM72" => "E M Seven Two"
  if (!grid || grid.length < 4) return grid || 'unknown';
  const g = grid.toUpperCase().slice(0, 6);
  const NATO = {
    A:'Alpha', B:'Bravo', C:'Charlie', D:'Delta', E:'Echo', F:'Foxtrot',
    G:'Golf', H:'Hotel', I:'India', J:'Juliet', K:'Kilo', L:'Lima',
    M:'Mike', N:'November', O:'Oscar', P:'Papa', Q:'Quebec', R:'Romeo',
    S:'Sierra', T:'Tango', U:'Uniform', V:'Victor', W:'Whiskey',
    X:'X-ray', Y:'Yankee', Z:'Zulu'
  };
  const DIGITS = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
  return g.split('').map(ch => {
    if (ch >= 'A' && ch <= 'Z') return NATO[ch] || ch;
    if (ch >= '0' && ch <= '9') return DIGITS[parseInt(ch, 10)];
    return ch;
  }).join(' ');
}

// Sample 4 quadrant-center points within the grid square, resolve each via Nominatim,
// then pick the best result: drop ocean/null, prefer US over CA, then plurality vote.
async function reverseGeoGrid(grid) {
  const key = grid.toUpperCase().slice(0, 4);
  const cached = gridPlaceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const ll = gridToLatLon(key);
  if (!ll) {
    const r = { display: null, spoken: null };
    gridPlaceCache.set(key, { result: r, expiresAt: Date.now() + GRID_PLACE_CACHE_MS });
    return r;
  }

  // Compute the 4 quadrant-center sample points (25%/75% offsets)
  // Grid size depends on precision: 4-char = 2°lon × 1°lat, 6-char = 2/24°lon × 1/24°lat
  const is6char = key.length >= 6;
  const halfLon = is6char ? (2/24)/2 : 0.5;   // half the grid width
  const halfLat = is6char ? (1/24)/2 : 0.25;  // half the grid height
  const samplePoints = [
    { lat: ll.lat - halfLat/2, lon: ll.lon - halfLon/2 },  // SW quadrant
    { lat: ll.lat + halfLat/2, lon: ll.lon - halfLon/2 },  // NW quadrant
    { lat: ll.lat - halfLat/2, lon: ll.lon + halfLon/2 },  // SE quadrant
    { lat: ll.lat + halfLat/2, lon: ll.lon + halfLon/2 },  // NE quadrant
  ];

  function parseAddr(addr) {
    if (!addr) return null;
    const cc = (addr.country_code || '').toLowerCase();
    if (!cc) return null; // ocean / no result
    const isNorthAmerica = (cc === 'us' || cc === 'ca');
    const stateCode = addr['ISO3166-2-lvl4']
      ? addr['ISO3166-2-lvl4'].split('-').pop() : null;
    const stateFull = addr.state
      ? addr.state.split(' / ')[0].trim() : null;
    const city = addr.city || addr.town || addr.village || addr.hamlet
              || addr.county || addr.state_district || null;
    const countryLabel = isNorthAmerica ? null : (addr.country || null);
    // For non-NA countries, ignore stateCode so we never display a region code instead of the country name
    return { cc, isNorthAmerica, stateCode: isNorthAmerica ? stateCode : null, stateFull: isNorthAmerica ? stateFull : null, city, countryLabel };
  }

  function buildStrings(p) {
    if (!p) return { display: null, spoken: null };
    let display = null, spoken = null;
    if (p.city) {
      const suffix = p.isNorthAmerica ? (p.stateCode || null) : p.countryLabel;
      display = suffix ? `${p.city}, ${suffix}` : p.city;
      const spokenSuffix = p.isNorthAmerica ? (p.stateFull || p.stateCode) : p.countryLabel;
      spoken = spokenSuffix ? `${p.city}, ${spokenSuffix}` : p.city;
    } else if (p.stateFull) {
      display = p.stateFull;
      spoken = p.stateFull;
    } else if (p.countryLabel) {
      display = p.countryLabel;
      spoken = p.countryLabel;
    }
    return { display, spoken };
  }

  try {
    // Fetch all 4 sample points in parallel
    const fetches = samplePoints.map(({ lat, lon }) => {
      const nomUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=8&addressdetails=1`;
      return fetchRaw(nomUrl, 8000, { 'User-Agent': 'hfsignals-proxy/1.0 (hfsignals.live)' })
        .then(raw => parseAddr(JSON.parse(raw)?.address))
        .catch(() => null);
    });
    const parsed = await Promise.all(fetches);
    const valid = parsed.filter(Boolean).filter(p => p.cc);

    let best = null;
    if (valid.length > 0) {
      // Prefer US results (hams name coastal grids after the nearest US state)
      const usResults = valid.filter(p => p.cc === 'us');
      const pool = usResults.length > 0 ? usResults : valid;

      // Plurality vote on (stateFull, cc)
      const tally = {};
      for (const p of pool) {
        const k = `${p.stateFull || p.countryLabel}|${p.cc}`;
        if (!tally[k]) tally[k] = { p, count: 0 };
        tally[k].count++;
        // Prefer results with a city name
        if (p.city && !tally[k].p.city) tally[k].p = p;
      }
      const winner = Object.values(tally).sort((a, b) =>
        b.count - a.count || (b.p.city ? 1 : 0) - (a.p.city ? 1 : 0)
      )[0];
      best = winner.p;
    }

    const result = buildStrings(best);
    gridPlaceCache.set(key, { result, expiresAt: Date.now() + GRID_PLACE_CACHE_MS });
    return result;
  } catch (e) {
    const r = { display: null, spoken: null };
    gridPlaceCache.set(key, { result: r, expiresAt: Date.now() + 30 * 60 * 1000 });
    return r;
  }
}


function joinBands(bandList) {
  const spoken = bandList.map(bandLabelSpoken);
  if (spoken.length === 0) return '';
  if (spoken.length === 1) return spoken[0];
  if (spoken.length === 2) return spoken.join(' and ');
  return spoken.slice(0, -1).join(', ') + ', and ' + spoken[spoken.length - 1];
}

async function fetchSolarDataForAudio() {
  try {
    const [wwvR, cycleR, plasmaR, magR] = await Promise.allSettled([
      fetchRaw('https://services.swpc.noaa.gov/text/wwv.txt'),
      fetchRaw('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json'),
      fetchRaw('https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json'),
      fetchRaw('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json'),
    ]);
    const m = (re) => { const t = wwvR.status === 'fulfilled' ? wwvR.value : ''; const x = re.exec(t); return x ? x[1] : null; };
    let sfi = m(/Solar flux\s+(\d+)/i) ? parseInt(m(/Solar flux\s+(\d+)/i)) : null;
    let a   = m(/A index\s+(\d+)/i)    ? parseInt(m(/A index\s+(\d+)/i))    : null;
    let k   = m(/K index\s+(\d+)/i)    ? parseInt(m(/K index\s+(\d+)/i))    : null;
    let ssn = null;
    if (cycleR.status === 'fulfilled') {
      try {
        const arr = JSON.parse(cycleR.value);
        const last = Array.isArray(arr) ? arr[arr.length - 1] : null;
        if (last) {
          ssn = Math.round(parseFloat(last.ssn || last.observed_swpc_ssn));
          if (!sfi && last['f10.7']) sfi = Math.round(parseFloat(last['f10.7']));
        }
      } catch {}
    }
    let wind = null;
    if (plasmaR.status === 'fulfilled') {
      try {
        const rows = JSON.parse(plasmaR.value);
        for (let i = rows.length - 1; i >= 1; i--) {
          const v = parseFloat(rows[i][2]);
          if (!isNaN(v) && v > 0) { wind = Math.round(v); break; }
        }
      } catch {}
    }
    let bz = null;
    if (magR.status === 'fulfilled') {
      try {
        const arr = JSON.parse(magR.value);
        for (let i = arr.length - 1; i >= 0; i--) {
          const v = parseFloat(arr[i].bz_gsm);
          if (!isNaN(v)) { bz = parseFloat(v.toFixed(1)); break; }
        }
      } catch {}
    }
    return { sfi, ssn, a, k, wind, bz };
  } catch { return {}; }
}

function buildAudioReportText(params, bandResults, solar = {}, sourceStats = {}) {
  const lines = [];

  // ── 1. Header (once) ─────────────────────────────────────────────────────
  const MONTH_NAMES = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const ORDINALS = (n) => {
    const s = ['th','st','nd','rd'];
    const v = n % 100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
  };
  const now = new Date();
  const utcDateSpoken = `${MONTH_NAMES[now.getUTCMonth()]} ${ORDINALS(now.getUTCDate())}, ${now.getUTCFullYear()}`;
  const utcSpoken = pronounceUtc(params.utc);
  lines.push(`${greetingForTimeOfDay(params.timeOfDay)}. H F Signals dot live. ${utcSpoken} U T C, ${utcDateSpoken}.`);

  // ── 2. Solar / geomagnetic (once) ────────────────────────────────────────
  if (params.includeSolar !== false) {
    const { sfi, ssn, a: aIdx, k: kIdx, wind, bz } = solar;
    const parts = [];
    if (sfi  != null) parts.push(`Solar Flux ${sfi}`);
    if (ssn  != null) parts.push(`Sunspot Number ${ssn}`);
    if (aIdx != null) parts.push(`A index ${aIdx}`);
    if (kIdx != null) parts.push(`K index ${kIdx}`);
    if (wind != null) parts.push(`Solar wind ${wind} kilometers per second`);
    if (bz   != null) parts.push(`B Z ${bz < 0 ? 'negative' : 'positive'} ${Math.abs(bz)} nanotesla`);
    if (parts.length) lines.push(parts.join('. ') + '.');
  }

  // ── 3. Vantage point (once) ──────────────────────────────────────────────
  if (params.mode === 'grid' && params.grid) {
    const radiusNum  = Math.round(params.radius);
    const unitWord   = params.unit === 'km' ? 'kilometer' : 'mile';
    const unitPlural = radiusNum === 1 ? unitWord : unitWord + 's';
    const place      = params.gridPlaceName ? `, ${params.gridPlaceName}` : '';
    lines.push(`Vantage point: ${radiusNum} ${unitPlural} around grid ${pronounceGrid(params.grid)}${place}.`);
  } else {
    lines.push(`Vantage point: ${REGION_NAME_BY_KEY[params.fromRegion] || params.fromRegion}.`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function oxfordList(items) {
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return items.slice(0, -1).join(', ') + `, and ${items[items.length - 1]}`;
  }

  // Short SNR for the per-band rundown: "plus 18" — no "decibels", unit stated by intro.
  // Uses "X meters" prefix to avoid TTS misreading "160, plus 18" as "1600 plus 18".
  function snrEntry(band, snr) {
    if (!Number.isFinite(snr)) return `${bandLabelSpoken(band)} unknown`;
    const db = Math.round(snr);
    return `${bandLabelSpoken(band)} ${db >= 0 ? 'plus' : 'minus'} ${Math.abs(db)}`;
  }

  // ── 4. Per-region blocks in canonical order ───────────────────────────────
  // Each active region gets:
  //   "Signals from X." (omitted for local/vantage region)
  //   "Strongest signal plus 28 decibels on 20 meters."   ← per-region strongest
  //   "Signal to Noise Ratios on the bands: 80 meters plus 18, 40 meters plus 24, ..."
  //   "CW, Digital, and SSB active."
  const silentRegions = [];

  for (const region of REGION_KEYS) {
    const bandData = bandResults[region];
    if (!bandData) continue;

    const activeBands = params.bands.filter(b => bandData[b]?.hasSignal);
    if (activeBands.length === 0) {
      silentRegions.push(REGION_NAME_BY_KEY[region] || region);
      continue;
    }

    // "Signals from X." — skip for local/vantage region (already stated as vantage point)
    if (region !== params.fromRegion) {
      lines.push(`Signals from ${REGION_NAME_BY_KEY[region] || region}.`);
    }

    // Per-region strongest band
    let regionBestSnr = -Infinity, regionBestBand = null;
    for (const band of activeBands) {
      const s = bandData[band].snr;
      if (Number.isFinite(s) && s > regionBestSnr) { regionBestSnr = s; regionBestBand = band; }
    }
    if (regionBestBand) {
      lines.push(`Strongest signal ${spokenSnr(regionBestSnr)} on ${bandLabelSpoken(regionBestBand)}.`);
    }

    // Per-band SNR + inline modes
    // e.g. "Signal to Noise Ratios on the bands: 80 meters plus 18, CW active.
    //        40 meters plus 24, CW and Digital active. 20 meters plus 28, CW, Digital, and SSB active."
    lines.push('Signal to Noise Ratios on the bands:');
    for (const band of activeBands) {
      const b = bandData[band];
      const snrStr = snrEntry(band, b.snr);
      // Build mode labels for this specific band
      const bandModes = [];
      if (b.modes && b.modes.has('CW'))                              bandModes.push('CW');
      if (b.modes && (b.modes.has('FT8') || b.modes.has('FT4')))    bandModes.push('Digital');
      if (b.modes && b.modes.has('RTTY'))                            bandModes.push('RTTY');
      if (b.ssbOk)                                                   bandModes.push('SSB');
      const modeStr = bandModes.length ? `, ${oxfordList(bandModes)} active` : '';
      lines.push(`${snrStr}${modeStr}.`);
    }
  }

  // ── 5. Silent regions batched (once) ─────────────────────────────────────
  if (silentRegions.length === 1) lines.push(`No signals from ${silentRegions[0]}.`);
  else if (silentRegions.length > 1) lines.push(`No signals from ${oxfordList(silentRegions)}.`);

  // ── 6. Closing (once) ────────────────────────────────────────────────────
  const skimmers = sourceStats.skimmers || 0;
  const ftxCount = sourceStats.ftxCount || 0;
  lines.push(`${skimmers} skimmers, ${ftxCount} F T x reports. Visit H F Signals dot live for live data.`);

  return lines.join(' ');
}

function requestText(method, targetUrl, bodyText, extraHeaders = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'hfsignals-audio/1.0', ...extraHeaders };
    if (bodyText != null && !Object.prototype.hasOwnProperty.call(headers, 'Content-Length')) {
      headers['Content-Length'] = Buffer.byteLength(bodyText);
    }
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method,
        headers,
        timeout: timeoutMs,
      },
      (upstream) => {
        const chunks = [];
        upstream.on('data', (c) => chunks.push(c));
        upstream.on('end', () => {
          resolve({
            statusCode: upstream.statusCode || 0,
            headers: upstream.headers || {},
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (bodyText != null) req.write(bodyText);
    req.end();
  });
}

async function translateTextIfNeeded(sourceText, lang) {
  const target = outputLanguage(lang);
  if (target === 'en') return sourceText;
  try {
    const trUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(sourceText)}`;
    const raw = await fetchRaw(trUrl, 12000, { 'User-Agent': 'hfsignals-audio/1.0' });
    const parsed = JSON.parse(raw);
    const text = Array.isArray(parsed?.[0]) ? parsed[0].map((row) => String(row?.[0] || '')).join('') : '';
    if (text && text.trim()) return text.trim();
  } catch {}
  return sourceText;
}

async function listAsyncVoices(afterCursor = '') {
  const payload = { limit: 100, model_id: ASYNC_MODEL_ID };
  if (afterCursor) payload.after = afterCursor;
  const rsp = await requestText(
    'POST',
    `${ASYNC_API_BASE.replace(/\/+$/, '')}/voices`,
    JSON.stringify(payload),
    {
      'x-api-key': ASYNC_API_KEY,
      'version': ASYNC_API_VERSION,
      'Content-Type': 'application/json',
    },
    15000
  );
  if (rsp.statusCode !== 200) {
    throw new Error(`voice_list_${rsp.statusCode}`);
  }
  return JSON.parse(rsp.bodyText);
}

async function resolveAsyncVoiceId() {
  if (asyncVoiceIdCache) return asyncVoiceIdCache;
  if (!ASYNC_API_KEY) throw new Error('ASYNC_API_KEY not configured');
  if (asyncVoiceLookupPromise) return asyncVoiceLookupPromise;
  asyncVoiceLookupPromise = (async () => {
    const wanted = ASYNC_VOICE_NAME.toLowerCase();
    let cursor = '';
    for (let i = 0; i < 30; i++) {
      const page = await listAsyncVoices(cursor);
      const voices = Array.isArray(page?.voices) ? page.voices : [];
      const exact = voices.find((v) => String(v?.name || '').trim().toLowerCase() === wanted);
      const partial = voices.find((v) => String(v?.name || '').trim().toLowerCase().includes(wanted));
      const match = exact || partial;
      if (match?.voice_id) {
        asyncVoiceIdCache = String(match.voice_id);
        return asyncVoiceIdCache;
      }
      const next = String(page?.next_cursor || '').trim();
      if (!next || next === cursor) break;
      cursor = next;
    }
    throw new Error(`voice_not_found:${ASYNC_VOICE_NAME}`);
  })().finally(() => { asyncVoiceLookupPromise = null; });
  return asyncVoiceLookupPromise;
}

async function streamAsyncTtsToFile(transcript, lang, outPath) {
  const voiceId = await resolveAsyncVoiceId();
  const ttsLang = outputLanguage(lang);
  const payload = {
    model_id: ASYNC_MODEL_ID,
    transcript,
    voice: { mode: 'id', id: voiceId },
    output_format: {
      container: 'mp3',
      sample_rate: Math.max(8000, Math.min(48000, ASYNC_MP3_SAMPLE_RATE)),
      bit_rate: Math.max(32000, Math.min(320000, ASYNC_MP3_BIT_RATE)),
    },
  };
  if (ttsLang !== 'en') payload.language = ttsLang;

  const targetUrl = `${ASYNC_API_BASE.replace(/\/+$/, '')}/text_to_speech/streaming`;
  const parsed = url.parse(targetUrl);
  const bodyText = JSON.stringify(payload);
  const tmpPath = `${outPath}.tmp-${Date.now()}`;
  const ws = fs.createWriteStream(tmpPath);
  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method: 'POST',
        timeout: 30000,
        headers: {
          'x-api-key': ASYNC_API_KEY,
          'version': ASYNC_API_VERSION,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
        },
      },
      (upstream) => {
        if ((upstream.statusCode || 0) !== 200) {
          const chunks = [];
          upstream.on('data', (c) => chunks.push(c));
          upstream.on('end', () => {
            ws.destroy();
            fs.promises.unlink(tmpPath).catch(() => {});
            reject(new Error(`tts_${upstream.statusCode}:${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`));
          });
          return;
        }
        upstream.pipe(ws);
      }
    );
    req.on('timeout', () => { req.destroy(); });
    req.on('error', (e) => {
      ws.destroy();
      fs.promises.unlink(tmpPath).catch(() => {});
      reject(e);
    });
    ws.on('finish', resolve);
    ws.on('error', (e) => {
      fs.promises.unlink(tmpPath).catch(() => {});
      reject(e);
    });
    req.end(bodyText);
  });
  await fs.promises.rename(tmpPath, outPath);
}

function sendAudioFile(res, filePath, generated, lang) {
  fs.promises.stat(filePath).then((st) => {
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=60',
      'X-HFSIGNALS-Audio': generated ? 'generated' : 'cached',
      'X-HFSIGNALS-Language': outputLanguage(lang),
      'X-HFSIGNALS-Tooltip': audioTooltipText(lang),
      'Access-Control-Expose-Headers': 'X-HFSIGNALS-Audio, X-HFSIGNALS-Language, X-HFSIGNALS-Tooltip',
    });
    fs.createReadStream(filePath).pipe(res);
  }).catch(() => {
    sendJson(res, 500, { error: 'audio_file_missing' });
  });
}

async function collectBandResultsPerRegion(params) {
  // Returns { regionKey: { band: bandResult } } for ALL toRegions (even silent ones)
  const results = {};
  for (const toRegion of params.toRegions) {
    const singleParams = { ...params, toRegions: [toRegion] };
    const bandState = await collectRbnBandResults(singleParams);
    augmentWithPskBandResults(singleParams, bandState);
    results[toRegion] = finalizeBandResults(singleParams, bandState);
  }
  return results;
}

// Count unique RBN skimmers and total FTx reports used across all source spots
function countSourceStats(params) {
  const skimmers = new Set();
  let ftxCount = 0;

  // RBN skimmers: unique spotter callsigns that contributed to the data
  for (const [, spot] of spotMap) {
    for (const spotter of Object.keys(spot.lsn || {})) {
      skimmers.add(spotter);
    }
  }

  // FTx reports: count entries in pskCacheData for the relevant regions/bands
  if (pskCacheData) {
    for (const toRegion of params.toRegions) {
      for (const band of params.bands) {
        const entry = pskCacheData?.[params.fromRegion]?.[toRegion]?.[band];
        if (entry && Number.isFinite(entry.snr)) ftxCount += entry.count || 1;
      }
    }
  }

  return { skimmers: skimmers.size, ftxCount };
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
  // Feed not yet warmed up — return empty object; badge server shows warmup screen
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
  if (parts[0] === 'vantage') {
    // PWA reports current vantage on every poll so grid history can be snapshotted
    const q = parsed.query || {};
    if (q.mode === 'grid' && q.grid && q.grid.length >= 4) {
      const rangeKm = Math.max(50, Math.min(5000, parseInt(q.range || '500', 10)));
      const grid    = q.grid.toUpperCase().slice(0, 6);
      lastGridVantage = { grid, rangeKm };
    } else {
      lastGridVantage = null;
    }
    sendJson(res, 200, { ok: true });
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




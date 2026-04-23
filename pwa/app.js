'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const REGIONS = [
  'E. North America',
  'C. North America',
  'W. North America',
  'Caribbean',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
];
const REGION_KEYS = ['ENA', 'CNA', 'WNA', 'CAR', 'SA', 'EU', 'AF', 'AS', 'OC'];
const DESKTOP_REGION_TITLES = [
  'Eastern North America',
  'Central North America',
  'Western North America',
  'Caribbean',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
];
const DESKTOP_REGION_TITLE_LINES = [
  'Eastern\nNorth America',
  'Central\nNorth America',
  'Western\nNorth America',
  'Caribbean',
  'South\nAmerica',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
];

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
const TOOLTIP_CALLSIGN_LIMIT = 120;

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
const DEFAULT_MODE_QUALITY_COLORS = ['#00d250', '#e6c800', '#ff8c00', '#dc1e1e'];
const SUPPORTED_THEMES = new Set(['dark', 'light', 'cb']);
const THEME_META_COLORS = { dark: '#0d0d1a', light: '#f4f7fb', cb: '#0f1222' };
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
let currentTheme = 'dark';
let meterPalette = {
  live: SEG_COLORS.live.slice(),
  peak: SEG_COLORS.peak.slice(),
  quality: DEFAULT_MODE_QUALITY_COLORS.slice(),
  dimmed: '#1c1c32',
};

let pskByRegion = {};
let pskMeta = { age: null, cached: false, stale: false };
let latestModeQualityByBand = createModeQualityCube();
let audioPlayback = null;
let audioRequestInFlight = false;
let audioElement = null;
let audioAbortCtrl = null;
let suppressAudioStopOnVantageUpdate = false;

function normalizeLanguageCode(raw) {
  const source = String(raw || '').trim();
  if (!source) return 'en';
  const first = source.split(',')[0].trim();
  const primary = first.split('-')[0].toLowerCase();
  return primary || 'en';
}

const VANTAGE_GRID_COLOR = '#ffffff';
const SOURCE_REGION_NAMES = [
  'E. North America',
  'C. North America',
  'W. North America',
  'Caribbean',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
];
const SOURCE_REGION_KEYS = ['ENA', 'CNA', 'WNA', 'CAR', 'SA', 'EU', 'AF', 'AS', 'OC'];
const CARIBBEAN_REGION_INDEX = 3;
const CARIBBEAN_CENTER = { lat: 17.0, lon: -72.0, radiusMiles: 950 };
const REGION_LAND_KEY = ['NA', 'NA', 'NA', 'CAR', 'SA', 'EU', 'AF', 'AS', 'OC'];
const WORLD_GEOJSON_SOURCES = [
  'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json',
  'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson',
];
const US_STATES_GEOJSON_SOURCES = [
  'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json',
];
const CANADA_PROVINCES_GEOJSON_SOURCES = [
  'https://raw.githubusercontent.com/codeforgermany/click_that_hood/main/public/data/canada.geojson',
];
let detailedWorldPolygons = null;
let detailedWorldRegionPolygons = null;
let detailedNorthAmericaSplitPolygons = null;
let detailedWorldLoadPromise = null;
let detailedWorldLoadFailed = false;
const CARIBBEAN_COUNTRIES = new Set([
  'The Bahamas', 'Cuba', 'Jamaica', 'Haiti', 'Dominican Republic', 'Puerto Rico',
  'Trinidad and Tobago', 'Barbados', 'Antigua and Barbuda', 'Dominica',
  'Saint Lucia', 'Saint Vincent and the Grenadines', 'Grenada',
  'Saint Kitts and Nevis', 'Aruba', 'Curacao', 'Curaçao', 'Guadeloupe', 'Martinique',
  'Belize', 'Bermuda',
]);
const SOUTH_AMERICA_COUNTRIES = new Set([
  'Argentina', 'Bolivia', 'Brazil', 'Chile', 'Colombia', 'Ecuador', 'Guyana',
  'Paraguay', 'Peru', 'Suriname', 'Uruguay', 'Venezuela', 'French Guiana',
]);
const NORTH_AMERICA_COUNTRIES = new Set([
  'USA', 'Canada', 'Mexico', 'Greenland', 'Belize', 'Guatemala', 'Honduras',
  'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama',
]);
const EUROPE_COUNTRIES = new Set([
  'Albania', 'Andorra', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herzegovina',
  'Bulgaria', 'Croatia', 'Czech Republic', 'Denmark', 'Estonia', 'Finland',
  'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy',
  'Kosovo', 'Latvia', 'Lithuania', 'Luxembourg', 'Macedonia', 'Moldova', 'Monaco',
  'Montenegro', 'Netherlands', 'Norway', 'Poland', 'Portugal', 'Romania',
  'Russia', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland',
  'Ukraine', 'United Kingdom', 'Northern Cyprus', 'Cyprus', 'Turkey', 'San Marino',
  'Vatican', 'Vatican City', 'Faroe Islands', 'Gibraltar', 'Isle of Man', 'Jersey', 'Guernsey',
]);
const AFRICA_COUNTRIES = new Set([
  'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cameroon',
  'Central African Republic', 'Chad', 'Democratic Republic of the Congo',
  'Republic of the Congo', 'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea',
  'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea', 'Guinea Bissau', 'Ivory Coast',
  'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar', 'Malawi', 'Mali',
  'Mauritania', 'Morocco', 'Mozambique', 'Namibia', 'Niger', 'Nigeria', 'Rwanda',
  'Senegal', 'Sierra Leone', 'Somalia', 'Somaliland', 'South Africa',
  'South Sudan', 'Sudan', 'Swaziland', 'eSwatini', 'Tanzania', 'Togo', 'Tunisia',
  'Uganda', 'Western Sahara', 'Zambia', 'Zimbabwe',
]);
const OCEANIA_COUNTRIES = new Set([
  'Australia', 'New Zealand', 'Papua New Guinea', 'Fiji',
  'Solomon Islands', 'Vanuatu', 'New Caledonia',
]);
const ENA_US_STATES = new Set([
  'Maine', 'New Hampshire', 'Vermont', 'Massachusetts', 'Rhode Island', 'Connecticut',
  'New York', 'New Jersey', 'Pennsylvania', 'Delaware', 'Maryland', 'District of Columbia',
  'Alabama', 'Florida', 'Georgia', 'Kentucky', 'North Carolina', 'South Carolina', 'Tennessee',
  'Virginia', 'Michigan', 'Ohio', 'West Virginia',
]);
const CNA_US_STATES = new Set([
  'Illinois', 'Indiana', 'Wisconsin',
  'Colorado', 'Iowa', 'Kansas', 'Minnesota', 'Missouri', 'Nebraska', 'North Dakota', 'South Dakota',
  'Arkansas', 'Louisiana', 'Mississippi', 'New Mexico', 'Oklahoma', 'Texas',
]);
const WNA_US_STATES = new Set([
  'Alaska', 'Arizona', 'California', 'Hawaii', 'Idaho', 'Montana',
  'Nevada', 'Oregon', 'Utah', 'Washington', 'Wyoming',
]);
const ENA_CANADA_PROVINCES = new Set([
  'Nova Scotia', 'New Brunswick', 'Prince Edward Island',
  'Quebec', 'Ontario', 'Newfoundland and Labrador',
]);
const CNA_CANADA_PROVINCES = new Set([
  'Manitoba', 'Saskatchewan', 'Alberta',
]);
const WNA_CANADA_PROVINCES = new Set([
  'British Columbia', 'Yukon Territory', 'Northwest Territories', 'Nunavut',
]);
const CNA_NORTH_AMERICA_COUNTRIES = new Set([
  'Mexico', 'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama',
]);
const COUNTRY_NAME_ALIASES = new Map([
  ['United States of America', 'USA'],
  ['Russian Federation', 'Russia'],
  ['The Gambia', 'Gambia'],
  ['Cote d\'Ivoire', 'Ivory Coast'],
  ['Côte d\'Ivoire', 'Ivory Coast'],
  ['Eswatini', 'eSwatini'],
  ['Swaziland', 'eSwatini'],
  ['United Republic of Tanzania', 'Tanzania'],
  ['Republic of the Congo', 'Republic of the Congo'],
]);
const CARIBBEAN_SOURCE_PREFIXES = [
  'KP1', 'KP2', 'KP4', 'WP4', 'NP4', 'VP9', 'CO', 'CM', 'HH', 'HI',
  '6Y', '8P', '9Y', 'J3', 'J6', 'V2', 'V4', 'FG', 'FM', 'FS', 'PJ2', 'PJ4',
].sort((a, b) => b.length - a.length);
const WORLD_LANDMASSES = {
  NA: [
    [-168, 72], [-152, 62], [-135, 56], [-122, 50], [-108, 50], [-96, 46],
    [-84, 30], [-82, 24], [-96, 16], [-112, 22], [-128, 30], [-138, 42],
    [-152, 54], [-165, 66],
  ],
  SA: [
    [-82, 12], [-74, 8], [-68, -2], [-64, -15], [-60, -28], [-62, -42],
    [-70, -55], [-76, -46], [-80, -30], [-82, -12],
  ],
  EU: [
    [-11, 36], [0, 43], [12, 49], [22, 53], [34, 58], [30, 66],
    [16, 64], [6, 58], [-2, 52], [-9, 44],
  ],
  AF: [
    [-18, 35], [2, 35], [20, 30], [35, 20], [46, 4], [42, -17],
    [32, -35], [12, -35], [-2, -29], [-11, -12], [-16, 8], [-18, 24],
  ],
  AS: [
    [35, 5], [50, 10], [66, 20], [82, 24], [98, 20], [112, 30],
    [126, 40], [142, 50], [162, 58], [172, 50], [162, 34], [148, 20],
    [132, 10], [114, 2], [96, -4], [76, -1], [60, 1], [46, 3],
  ],
  OC: [
    [110, -11], [124, -16], [138, -24], [153, -31], [150, -42], [134, -45],
    [120, -40], [112, -29],
  ],
  CAR: [
    [-88, 24], [-82, 28], [-70, 27], [-61, 22], [-60, 14], [-66, 10],
    [-76, 10], [-84, 15], [-88, 20],
  ],
};

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
  defaults: {
    mode: 'region',
    regionIndex: 0,
    grid: '',
    radiusIndex: 2,
    unit: 'auto',
    theme: 'dark',
    autoUpdate: false,
    desktopCollapsed: [],
  },
  load() {
    try { return { ...this.defaults, ...JSON.parse(localStorage.getItem(this.KEY) || '{}') }; }
    catch { return { ...this.defaults }; }
  },
  save(obj) {
    try { localStorage.setItem(this.KEY, JSON.stringify(obj)); } catch {}
  },
};

function readThemeColorVar(varName, fallback) {
  if (!document.body) return fallback;
  const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return v || fallback;
}

function buildThemeMeterPalette() {
  const green = readThemeColorVar('--green', '#00d250');
  const yellow = readThemeColorVar('--yellow', '#e6c800');
  const orange = readThemeColorVar('--orange', '#ff8c00');
  const red = readThemeColorVar('--red', '#dc1e1e');
  const pkGreen = readThemeColorVar('--pk-green', '#005a22');
  const pkYellow = readThemeColorVar('--pk-yellow', '#645500');
  const pkOrange = readThemeColorVar('--pk-orange', '#723c00');
  const pkRed = readThemeColorVar('--pk-red', '#641212');
  const dimmed = readThemeColorVar('--dimmed', '#1c1c32');
  return {
    live: [green, green, green, green, green, green, green, green, green, yellow, yellow, yellow, orange, red, red],
    peak: [pkGreen, pkGreen, pkGreen, pkGreen, pkGreen, pkGreen, pkGreen, pkGreen, pkGreen, pkYellow, pkYellow, pkYellow, pkOrange, pkRed, pkRed],
    quality: [green, yellow, orange, red],
    dimmed,
  };
}

function applyMeterPalette() {
  meterPalette = buildThemeMeterPalette();
  if (Array.isArray(meters) && meters.length) refreshUI(latestModeQualityByBand);
}

function applyTheme(themeName) {
  const nextTheme = SUPPORTED_THEMES.has(themeName) ? themeName : 'dark';
  if (!document.body) return;
  document.body.classList.remove('theme-dark', 'theme-light', 'theme-cb');
  document.body.classList.add(`theme-${nextTheme}`);
  const darkBtn = document.getElementById('theme-dark');
  const lightBtn = document.getElementById('theme-light');
  const cbBtn = document.getElementById('theme-cb');
  if (darkBtn) darkBtn.classList.toggle('active', nextTheme === 'dark');
  if (lightBtn) lightBtn.classList.toggle('active', nextTheme === 'light');
  if (cbBtn) cbBtn.classList.toggle('active', nextTheme === 'cb');
  if (themeColorMeta) themeColorMeta.setAttribute('content', THEME_META_COLORS[nextTheme] || THEME_META_COLORS.dark);
  currentTheme = nextTheme;
  applyMeterPalette();
}

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

function normalizeLonDelta(delta) {
  let out = delta;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

function prepareHiDPICanvas(canvas) {
  if (!canvas) return null;
  const cssW = Math.max(1, Math.round(canvas.clientWidth));
  const cssH = Math.max(1, Math.round(canvas.clientHeight));
  if (cssW < 2 || cssH < 2) return null;
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, w: cssW, h: cssH };
}

function drawMapBackground(ctx, w, h) {
  ctx.fillStyle = 'rgba(10, 16, 28, 0.92)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0, 212, 170, 0.16)';
  ctx.lineWidth = 1;
}

function drawGeoGrid(ctx, w, h, project, lonStep, latStep) {
  ctx.strokeStyle = 'rgba(0, 212, 170, 0.12)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += lonStep) {
    const a = project(lon, -85);
    const b = project(lon, 85);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += latStep) {
    const a = project(-180, lat);
    const b = project(180, lat);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawPolygon(ctx, points, project, fillStyle, strokeStyle, lineWidth = 1) {
  if (!points || points.length < 3) return;
  ctx.beginPath();
  points.forEach(([lon, lat], i) => {
    const p = project(lon, lat);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function flattenGeoCoordinates(coords, out = []) {
  if (!Array.isArray(coords) || coords.length === 0) return out;
  if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') {
    const ring = coords
      .map(([lon, lat]) => [Number(lon), Number(lat)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (ring.length >= 3) out.push(ring);
    return out;
  }
  coords.forEach((child) => flattenGeoCoordinates(child, out));
  return out;
}

function extractDetailedPolygons(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const polygons = [];
  features.forEach((feature) => {
    const coords = feature?.geometry?.coordinates;
    if (!coords) return;
    flattenGeoCoordinates(coords, polygons);
  });
  return polygons.length > 0 ? polygons : null;
}

function countryNameForFeature(feature) {
  return String(
    feature?.properties?.name ||
    feature?.properties?.NAME ||
    feature?.properties?.admin ||
    feature?.properties?.ADMIN ||
    ''
  ).trim();
}

function canonicalCountryName(name) {
  const raw = String(name || '').trim();
  return COUNTRY_NAME_ALIASES.get(raw) || raw;
}

function pushRegionPolygons(regionMap, regionKey, rings) {
  if (!regionMap[regionKey]) regionMap[regionKey] = [];
  rings.forEach((ring) => regionMap[regionKey].push(ring));
}

function assignRegionKeyForCountry(name) {
  const canon = canonicalCountryName(name);
  if (!canon) return null;
  if (CARIBBEAN_COUNTRIES.has(canon)) return 'CAR';
  if (SOUTH_AMERICA_COUNTRIES.has(canon)) return 'SA';
  if (NORTH_AMERICA_COUNTRIES.has(canon)) return 'NA';
  if (EUROPE_COUNTRIES.has(canon)) return 'EU';
  if (AFRICA_COUNTRIES.has(canon)) return 'AF';
  if (OCEANIA_COUNTRIES.has(canon)) return 'OC';
  return 'AS';
}

function extractNamedPolygons(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const named = {};
  features.forEach((feature) => {
    const coords = feature?.geometry?.coordinates;
    if (!coords) return;
    const rings = flattenGeoCoordinates(coords, []);
    if (!rings.length) return;
    const name = canonicalCountryName(countryNameForFeature(feature));
    if (!name) return;
    named[name] ??= [];
    rings.forEach((ring) => named[name].push(ring));
  });
  return named;
}

async function fetchGeoJsonFromSources(sources, timeoutMs = 7000) {
  for (const url of sources) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (Array.isArray(data?.features) && data.features.length > 0) return data;
    } catch {}
  }
  return null;
}

function collectPolygonsForNames(namedPolygons, names) {
  const out = [];
  names.forEach((name) => {
    const canon = canonicalCountryName(name);
    if (namedPolygons[canon]) out.push(...namedPolygons[canon]);
  });
  return out;
}

function extractRegionPolygons(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const regionMap = { NA: [], SA: [], EU: [], AF: [], AS: [], OC: [], CAR: [] };
  features.forEach((feature) => {
    const coords = feature?.geometry?.coordinates;
    if (!coords) return;
    const rings = flattenGeoCoordinates(coords, []);
    if (!rings.length) return;
    const country = countryNameForFeature(feature);
    const regionKey = assignRegionKeyForCountry(country);
    if (!regionKey) return;
    pushRegionPolygons(regionMap, regionKey, rings);
  });
  return regionMap;
}

async function loadDetailedNorthAmericaSplitPolygons(worldGeojson) {
  const worldNamed = extractNamedPolygons(worldGeojson);
  const split = { ENA: [], CNA: [], WNA: [] };

  // Country-level portions of North America in this model.
  split.CNA.push(...collectPolygonsForNames(worldNamed, CNA_NORTH_AMERICA_COUNTRIES));
  split.WNA.push(...collectPolygonsForNames(worldNamed, new Set(['Greenland'])));

  const [usStatesGeo, canadaGeo] = await Promise.all([
    fetchGeoJsonFromSources(US_STATES_GEOJSON_SOURCES),
    fetchGeoJsonFromSources(CANADA_PROVINCES_GEOJSON_SOURCES),
  ]);

  if (usStatesGeo) {
    const usNamed = extractNamedPolygons(usStatesGeo);
    split.ENA.push(...collectPolygonsForNames(usNamed, ENA_US_STATES));
    split.CNA.push(...collectPolygonsForNames(usNamed, CNA_US_STATES));
    split.WNA.push(...collectPolygonsForNames(usNamed, WNA_US_STATES));
  }
  if (canadaGeo) {
    const caNamed = extractNamedPolygons(canadaGeo);
    split.ENA.push(...collectPolygonsForNames(caNamed, ENA_CANADA_PROVINCES));
    split.CNA.push(...collectPolygonsForNames(caNamed, CNA_CANADA_PROVINCES));
    split.WNA.push(...collectPolygonsForNames(caNamed, WNA_CANADA_PROVINCES));
  }

  if (split.ENA.length === 0 || split.CNA.length === 0 || split.WNA.length === 0) return null;
  return split;
}

async function loadDetailedWorldPolygons() {
  if (detailedWorldPolygons) return detailedWorldPolygons;
  if (detailedWorldLoadPromise) return detailedWorldLoadPromise;
  if (detailedWorldLoadFailed) return null;

  detailedWorldLoadPromise = (async () => {
    for (const url of WORLD_GEOJSON_SOURCES) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(7000) });
        if (!resp.ok) continue;
        const data = await resp.json();
        const polygons = extractDetailedPolygons(data);
        if (polygons && polygons.length > 0) {
          detailedWorldPolygons = polygons;
          detailedWorldRegionPolygons = extractRegionPolygons(data);
          detailedNorthAmericaSplitPolygons = await loadDetailedNorthAmericaSplitPolygons(data);
          detailedWorldLoadFailed = false;
          return detailedWorldPolygons;
        }
      } catch {}
    }
    detailedWorldLoadFailed = true;
    return null;
  })().finally(() => {
    detailedWorldLoadPromise = null;
  });

  return detailedWorldLoadPromise;
}

function drawWorldLandmasses(ctx, project, fillAlpha = 0.24, strokeAlpha = 0.46) {
  const polygons = detailedWorldPolygons || Object.values(WORLD_LANDMASSES);
  polygons.forEach((points) => {
    drawPolygon(
      ctx,
      points,
      project,
      `rgba(0, 210, 80, ${fillAlpha})`,
      `rgba(0, 169, 107, ${strokeAlpha})`,
      1,
    );
  });
}

function drawHighlightedRegion(ctx, project, regionKey, regionIdx, w, h) {
  const regionPolys = detailedWorldRegionPolygons?.[regionKey] || null;
  const highlightFill = 'rgba(0, 210, 80, 0.78)';
  const highlightStroke = 'rgba(0, 169, 107, 0.95)';
  const sourceRegionKey = SOURCE_REGION_KEYS[regionIdx];
  const naSplitPolys = (sourceRegionKey === 'ENA' || sourceRegionKey === 'CNA' || sourceRegionKey === 'WNA')
    ? detailedNorthAmericaSplitPolygons?.[sourceRegionKey]
    : null;
  const naLonSplitByRegion = {
    2: [-130, -103], // W. North America (unchanged right edge relative to prior split)
    1: [-103, -85],  // C. North America (~300 miles wider)
    0: [-85, -52],   // E. North America (left edge moved east ~500 miles, extends to coast/ocean)
  };

  if (naSplitPolys && naSplitPolys.length > 0) {
    naSplitPolys.forEach((ring) => drawPolygon(ctx, ring, project, highlightFill, highlightStroke, 1.6));
    return;
  }

  if (regionPolys && regionPolys.length > 0) {
    if (regionKey === 'NA' && regionIdx >= 0 && regionIdx <= 2) {
      const split = naLonSplitByRegion[regionIdx];
      if (split) {
        const [lo, hi] = split;
        const xLo = project(lo, 0).x;
        const xHi = project(hi, 0).x;
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.min(xLo, xHi), 0, Math.abs(xHi - xLo), h);
        ctx.clip();
        regionPolys.forEach((ring) => drawPolygon(ctx, ring, project, highlightFill, highlightStroke, 1.6));
        ctx.restore();
      } else {
        regionPolys.forEach((ring) => drawPolygon(ctx, ring, project, highlightFill, highlightStroke, 1.6));
      }
    } else {
      regionPolys.forEach((ring) => drawPolygon(ctx, ring, project, highlightFill, highlightStroke, 1.6));
    }
    return;
  }

  const points = WORLD_LANDMASSES[regionKey];
  if (!points) return;
  if (regionKey === 'NA' && regionIdx >= 0 && regionIdx <= 2) {
    const split = naLonSplitByRegion[regionIdx];
    if (split) {
      const [lo, hi] = split;
      const xLo = project(lo, 0).x;
      const xHi = project(hi, 0).x;
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.min(xLo, xHi), 0, Math.abs(xHi - xLo), h);
      ctx.clip();
      drawPolygon(ctx, points, project, highlightFill, highlightStroke, 1.6);
      ctx.restore();
      return;
    }
  }
  drawPolygon(ctx, points, project, highlightFill, highlightStroke, 1.6);
}

function drawRegionVantageMap(canvas, regionIdx) {
  const setup = prepareHiDPICanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const project = (lon, lat) => ({
    x: ((lon + 180) / 360) * w,
    y: ((90 - lat) / 180) * h,
  });
  drawMapBackground(ctx, w, h);
  drawGeoGrid(ctx, w, h, project, 30, 20);
  drawWorldLandmasses(ctx, project, 0.15, 0.25);
  const landKey = REGION_LAND_KEY[regionIdx] || 'NA';
  drawHighlightedRegion(ctx, project, landKey, regionIdx, w, h);
}

function drawGridVantageMap(canvas, grid, radiusMiles, radiusLabel) {
  const setup = prepareHiDPICanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const center = gridToLatLon(grid);
  drawMapBackground(ctx, w, h);

  if (!center) {
    const project = (lon, lat) => ({ x: ((lon + 180) / 360) * w, y: ((90 - lat) / 180) * h });
    drawGeoGrid(ctx, w, h, project, 60, 30);
    drawWorldLandmasses(ctx, project, 0.22, 0.38);
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Enter valid grid square', w / 2, h / 2);
    return;
  }

  const radiusDegLat = Math.max(0.5, radiusMiles / 69);
  const radiusPxAt1x = radiusDegLat * (h / 180);
  const targetRadiusPx = Math.max(26, Math.min(78, h * 0.24));
  const zoom = Math.max(1, Math.min(7, targetRadiusPx / Math.max(radiusPxAt1x, 1)));
  const lonScale = (w / 360) * zoom;
  const latScale = (h / 180) * zoom;
  const project = (lon, lat) => ({
    x: w / 2 + normalizeLonDelta(lon - center.lon) * lonScale,
    y: h / 2 - (lat - center.lat) * latScale,
  });

  const lonStep = zoom >= 3.2 ? 15 : (zoom >= 1.8 ? 30 : 60);
  const latStep = zoom >= 3.2 ? 10 : (zoom >= 1.8 ? 20 : 30);
  drawGeoGrid(ctx, w, h, project, lonStep, latStep);
  drawWorldLandmasses(ctx, project, 0.26, 0.42);

  const radiusPx = Math.max(4, radiusDegLat * latScale);
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, radiusPx, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = VANTAGE_GRID_COLOR;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const lx = Math.min(w - 8, w / 2 + radiusPx + 10);
  const ly = Math.max(14, h / 2 - 8);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = 'bold 12px "Share Tech Mono", monospace';
  ctx.fillText(grid.toUpperCase(), lx, ly);
  ctx.font = '11px "Share Tech Mono", monospace';
  ctx.fillText(radiusLabel, lx, ly + 14);
}

// ── SNR dB label ─────────────────────────────────────────────────────────────
function snrToSUnit(snr) {
  const db = Math.round(snr);
  if (db >= 0) return '+' + db + 'dB';
  return db + 'dB';
}

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function qualityColorForSnr(snr) {
  if (snr == null) return null;
  const frac = Math.max(0, Math.min(snr / MAX_SNR, 1));
  const q = meterPalette.quality || DEFAULT_MODE_QUALITY_COLORS;
  if (frac < 0.60) return q[0] || DEFAULT_MODE_QUALITY_COLORS[0];
  if (frac < 0.80) return q[1] || DEFAULT_MODE_QUALITY_COLORS[1];
  if (frac < 0.90) return q[2] || DEFAULT_MODE_QUALITY_COLORS[2];
  return q[3] || DEFAULT_MODE_QUALITY_COLORS[3];
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

function ftxSnrToRbnScale(ftxSnr) {
  if (ftxSnr == null || Number.isNaN(ftxSnr)) return null;
  // PSK FTx values are normalized (+7 dB) but still represent digital weak-signal behavior.
  // Map -20..+20 dB to a conservative 2..22 dB contribution on the main 0..50 RBN meter.
  const minDb = -20;
  const maxDb = 20;
  const frac = Math.max(0, Math.min((ftxSnr - minDb) / (maxDb - minDb), 1));
  return 2 + frac * 20;
}

function sourceRegionKeyForIndex(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= SOURCE_REGION_KEYS.length) return null;
  return SOURCE_REGION_KEYS[idx];
}

function targetRegionKeyForIndex(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= REGION_KEYS.length) return null;
  return REGION_KEYS[idx];
}

function sourceRegionKeyForCallsign(call) {
  const regionIdx = classifyCallsign(call);
  if (regionIdx < 0) return null;
  if (regionIdx === 0 && isCaribbeanSourceCallsign(call)) return 'CAR';
  return REGION_KEYS[regionIdx] || null;
}

function gridCellKeyFromLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Same granularity as Maidenhead 4-char cells used in PSK reports.
  const lonCell = Math.floor((lon + 180) / 2);
  const latCell = Math.floor((lat + 90) / 1);
  if (!Number.isFinite(lonCell) || !Number.isFinite(latCell)) return null;
  return `${lonCell},${latCell}`;
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
  ['W1',0],['W2',0],['W3',0],['W4',0],['W8',0],
  ['K1',0],['K2',0],['K3',0],['K4',0],['K8',0],
  ['N1',0],['N2',0],['N3',0],['N4',0],['N8',0],
  ['VE1',0],['VE2',0],['VE3',0],['VE9',0],['VA1',0],['VA2',0],['VA3',0],['VY2',0],
  ['KP2',0],['KP4',0],['WP4',0],['NP4',0],['VP9',0],['CO',0],['CM',0],['HH',0],['HI',0],
  ['W0',1],['W5',1],['W9',1],['K0',1],['K5',1],['K9',1],['N0',1],['N5',1],['N9',1],
  ['VE4',1],['VE5',1],['VE6',1],['VA4',1],['VA5',1],['VA6',1],['XE',1],['XF',1],
  ['TI',1],['YN',1],['HR',1],['TG',1],['YS',1],
  ['W6',2],['W7',2],['K6',2],['K7',2],['N6',2],['N7',2],
  ['VE7',2],['VA7',2],['VY1',2],
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
        if (d === 0 || d === 5 || d === 9) return 1;
        if (d === 6 || d === 7) return 2;
        return 0;
      }
    }
  }
  return -1;
}

function isCaribbeanSourceCallsign(call) {
  const u = String(call || '').toUpperCase();
  if (!u) return false;
  const base = u.includes('/') ? u.split('/')[0] : u;
  return CARIBBEAN_SOURCE_PREFIXES.some((pfx) => base.startsWith(pfx));
}

function regionFromLatLon(lat, lon) {
  const dCar = distanceMiles(lat, lon, CARIBBEAN_CENTER.lat, CARIBBEAN_CENTER.lon);
  if (dCar <= CARIBBEAN_CENTER.radiusMiles && lat >= 8 && lat <= 30 && lon >= -92 && lon <= -56) return CARIBBEAN_REGION_INDEX;
  if (lat > 15 && lon >= -170 && lon <= -50) {
    if (lon >= -85)  return 0;
    if (lon >= -105) return 1;
    return 2;
  }
  if (lat >= -60 && lat <= 15 && lon >= -82 && lon <= -34) return 4;
  if (lat >= 35  && lat <= 72 && lon >= -12 && lon <= 45)  return 5;
  if (lat >= -35 && lat <= 40 && lon >= -20 && lon <= 55)  return 6;
  if (lat >= -10 && lat <= 75 && lon >= 45)                return 7;
  if (lat <= 0   && lon >= 100)                            return 8;
  return -1;
}

function regionKeyFromLatLon(lat, lon) {
  return sourceRegionKeyForIndex(regionFromLatLon(lat, lon));
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
    this.hasValue       = new Array(BANDS.length).fill(false);
    this.ema            = new Array(BANDS.length).fill(0);
    this.peak           = new Array(BANDS.length).fill(0);
    this.spotCount      = new Array(BANDS.length).fill(0);
    this.currentModes   = Array.from({length: BANDS.length}, () => new Set());
    this.modeAbsence    = Array.from({length: BANDS.length}, () => ({}));
    this._seenThisCycle = Array.from({length: BANDS.length}, () => new Set());
  }

  // Call at start of each poll cycle — reset per-cycle "seen" tracker only; modes persist
  beginPollCycle() {
    this._seenThisCycle = Array.from({length: BANDS.length}, () => new Set());
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
    if (nm) {
      this.currentModes[bandIdx].add(nm);
      this._seenThisCycle[bandIdx].add(nm);
      this.modeAbsence[bandIdx][nm] = 0;
    }
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

  // Call after each poll cycle to age out modes that haven't appeared recently
  endPollCycle() {
    const MODE_DECAY_CYCLES = 4; // keep badge alive for ~4 missed polls before clearing
    for (let bi = 0; bi < BANDS.length; bi++) {
      const seen    = this._seenThisCycle[bi];
      const absence = this.modeAbsence[bi];
      for (const m of Array.from(this.currentModes[bi])) {
        if (!seen.has(m)) {
          absence[m] = (absence[m] || 0) + 1;
          if (absence[m] >= MODE_DECAY_CYCLES) {
            this.currentModes[bi].delete(m);
            delete absence[m];
          }
        }
      }
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
  const dimmedColor = meterPalette.dimmed || '#1c1c32';
  const liveColors = Array.isArray(meterPalette.live) && meterPalette.live.length === SEG_COUNT
    ? meterPalette.live
    : SEG_COLORS.live;
  const peakColors = Array.isArray(meterPalette.peak) && meterPalette.peak.length === SEG_COUNT
    ? meterPalette.peak
    : SEG_COLORS.peak;
  for (let i = 0; i < SEG_COUNT; i++) {
    const x    = i * (segW + gapW);
    const lit  = i < litSeg;
    const inPk = !lit && i < pkSeg;
    if (!hasData)   ctx.fillStyle = dimmedColor;
    else if (lit)   ctx.fillStyle = liveColors[i];
    else if (inPk)  ctx.fillStyle = peakColors[i];
    else            ctx.fillStyle = dimmedColor;
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
  { abbr: 'DIG', sources: ['FT8','FT4'], isSSB: false },
];
const MODE_QUALITY_KEY = { CW: 'CW', RY: 'RTTY', DIG: 'FTx', FTx: 'FTx', SSB: 'SSB' };

function buildQualityTrack(frac, enabled) {
  const track = document.createElement('span');
  track.className = 'mode-quality-track';
  const qualityColors = Array.isArray(meterPalette.quality) && meterPalette.quality.length === 4
    ? meterPalette.quality
    : DEFAULT_MODE_QUALITY_COLORS;
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
    const c = qualityColors[i] || DEFAULT_MODE_QUALITY_COLORS[i];
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
const deskPanels   = []; // [regionIdx]
const deskHeaders  = []; // [regionIdx]
const deskHeaderNames = []; // [regionIdx]
const deskPills    = []; // [regionIdx][bandIdx]

// Phone refs
const accCanvases = []; // [regionIdx][bandIdx]
const accSUnits   = []; // [regionIdx][bandIdx]
const accFooters  = []; // [regionIdx]
const accPills    = []; // [regionIdx][bandIdx]
const accModeRows = []; // [regionIdx][bandIdx]

let desktopCollapsed = Array.from({ length: REGIONS.length }, () => false);

function normaliseDesktopCollapsed(raw) {
  const out = Array.from({ length: REGIONS.length }, () => false);
  if (!Array.isArray(raw)) return out;
  raw.forEach((idx) => {
    const i = Number(idx);
    if (Number.isInteger(i) && i >= 0 && i < REGIONS.length) out[i] = true;
  });
  return out;
}

function collapsedDesktopIndexes() {
  const out = [];
  desktopCollapsed.forEach((v, idx) => { if (v) out.push(idx); });
  return out;
}

function setDesktopPanelCollapsed(regionIdx, collapsed, shouldSave = true) {
  desktopCollapsed[regionIdx] = !!collapsed;
  const panel = deskPanels[regionIdx];
  const hdr = deskHeaders[regionIdx];
  const hdrName = deskHeaderNames[regionIdx];
  const longName = DESKTOP_REGION_TITLES[regionIdx] || REGIONS[regionIdx] || '';
  const twoLineName = DESKTOP_REGION_TITLE_LINES[regionIdx] || longName;
  if (panel) panel.classList.toggle('collapsed', desktopCollapsed[regionIdx]);
  if (hdr) hdr.setAttribute('aria-expanded', String(!desktopCollapsed[regionIdx]));
  if (hdrName) {
    hdrName.textContent = desktopCollapsed[regionIdx] ? (REGION_KEYS[regionIdx] || longName) : twoLineName;
    hdrName.title = longName;
  }
  if (shouldSave) saveSettings();
}

function applyDesktopCollapseState() {
  for (let ri = 0; ri < REGIONS.length; ri++) {
    setDesktopPanelCollapsed(ri, desktopCollapsed[ri], false);
  }
}

function updateSummaryPill(pill, bandIdx, hasData, snr, className) {
  if (!pill) return;
  const bandFull = BANDS[bandIdx].label;
  const compactBand = bandFull.endsWith('m') ? bandFull.slice(0, -1) : bandFull;
  const pillBand = className === 'desk-pill' ? compactBand : bandFull;
  if (hasData) {
    pill.textContent = `${pillBand} ${snrToSUnit(snr)}`;
    pill.className = className;
  } else {
    pill.textContent = pillBand;
    pill.className = `${className} no-data`;
  }
}

// ── Build desktop panels ──────────────────────────────────────────────────────
function buildDesktopPanels() {
  const grid = document.getElementById('meters-grid');
  grid.innerHTML = '';
  canvases.length = 0; sUnits.length = 0; footers.length = 0; deskModeRows.length = 0;
  deskPanels.length = 0; deskHeaders.length = 0; deskHeaderNames.length = 0; deskPills.length = 0;

  REGIONS.forEach((_, ri) => {
    const title = DESKTOP_REGION_TITLES[ri] || REGIONS[ri];
    const titleTwoLine = DESKTOP_REGION_TITLE_LINES[ri] || title;
    const panel = document.createElement('div');
    panel.className = 'region-panel';

    const hdr = document.createElement('div');
    hdr.className = 'region-header';
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('tabindex', '0');
    const hdrName = document.createElement('span');
    hdrName.className = 'region-header-name';
    hdrName.textContent = titleTwoLine;
    hdrName.title = title;
    const hdrChevron = document.createElement('span');
    hdrChevron.className = 'region-header-chevron';
    hdrChevron.textContent = '▼';
    hdr.appendChild(hdrName);
    hdr.appendChild(hdrChevron);
    panel.appendChild(hdr);

    const summary = document.createElement('div');
    summary.className = 'desk-summary';
    const rp = [];
    BANDS.forEach((band) => {
      const pill = document.createElement('span');
      pill.className = 'desk-pill no-data';
      pill.textContent = band.label;
      summary.appendChild(pill);
      rp.push(pill);
    });
    panel.appendChild(summary);

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
    deskPanels.push(panel);
    deskHeaders.push(hdr);
    deskHeaderNames.push(hdrName);
    deskPills.push(rp);

    const toggleCollapse = () => setDesktopPanelCollapsed(ri, !desktopCollapsed[ri]);
    hdr.addEventListener('click', toggleCollapse);
    hdr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCollapse();
      }
    });
    setDesktopPanelCollapsed(ri, desktopCollapsed[ri], false);
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
  if (modeQualityByBand) latestModeQualityByBand = modeQualityByBand;
  else modeQualityByBand = latestModeQualityByBand;
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
          updateSummaryPill(pill, bi, true, snr, 'acc-pill');
        } else {
          updateSummaryPill(pill, bi, false, snr, 'acc-pill');
        }
      }

      // Desktop collapsed summary pills
      if (deskPills[ri]) {
        const dp = deskPills[ri][bi];
        updateSummaryPill(dp, bi, hasData, snr, 'desk-pill');
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
let pollInFlight = false;
let pollPending = false;
let refreshDebounceTimer = null;
let refreshRevision = 0;

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

async function pollOnce(revisionAtRequest = refreshRevision) {
  if (!isRunning) return;
  if (revisionAtRequest !== refreshRevision) return;
  if (pollInFlight) {
    pollPending = true;
    return;
  }
  pollInFlight = true;
  const activeRevision = revisionAtRequest;

  try {
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
  const rbnVantageRegionKey = sourceRegionKeyForIndex(vantageRegion);
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
  const ftxCallsigns = new Set();
  let skimmerCallsigns = [];

  for (const [spotCall, spot] of Object.entries(data)) {
    if (!spot.lsn || typeof spot.lsn !== 'object') continue;
    if ((spot.age ?? 0) > 120) continue;
    const freq = parseFloat(String(spot.freq).replace(/\s/g, ''));
    if (!freq) continue;
    const bi = bandForFreq(freq);
    if (bi < 0) continue;
    totalSpots++;

    const dxRegion = classifyCallsign(spot.dxcall || spotCall);

    for (const [listenerCall, snrVal] of Object.entries(spot.lsn)) {
      const snr = parseFloat(snrVal);
      if (isNaN(snr)) continue;

      if (mode === 'region') {
        if (!rbnVantageRegionKey) continue;
        const spotterRegionKey = sourceRegionKeyForCallsign(listenerCall);
        if (spotterRegionKey !== rbnVantageRegionKey) continue;
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
    skimmerCallsigns = Array.from(skimmersInRadius).sort();

    // If no skimmers heard within radius, clear all meters immediately
    // (don't rely on slow EMA decay — give instant feedback)
    if (skimmerCount === 0) {
      meters.forEach(m => m.reset());
    }
  }

  // Region mode skimmer count
  if (mode === 'region') {
    skimmerCount = regionSkimmers.size;
    skimmerCallsigns = Array.from(regionSkimmers).sort();
  }

  // Fetch PSKReporter aggregate in parallel with final UI composition.
  await fetchPsk();

  // Decay bands that received no samples
  for (let ri = 0; ri < REGIONS.length; ri++)
    for (let bi = 0; bi < BANDS.length; bi++)
      if (!sampled[ri][bi]) meters[ri].decayBand(bi);

  // Age out modes that weren't seen this cycle
  meters.forEach(m => m.endPollCycle());

  const modeQualityByBand = collapseModeSamples(modeSamples, meters);

  // Overlay FTx quality from PSKReporter by from/to region + band.
  const fromKey = mode === 'region'
    ? sourceRegionKeyForIndex(vantageRegion)
    : (gridLL ? sourceRegionKeyForIndex(regionFromLatLon(gridLL.lat, gridLL.lon)) : null);
  let ftxReportsInQuery = 0;
  const gridPskCallIncluded = new Set();
  const pskGridCallCounts = {};
  if (fromKey && pskByRegion[fromKey]) {
    for (let ri = 0; ri < REGIONS.length; ri++) {
      const toKey = targetRegionKeyForIndex(ri);
      for (let bi = 0; bi < BANDS.length; bi++) {
        const pskEntry = pskByRegion[fromKey]?.[toKey]?.[BANDS[bi].label];
        if (pskEntry && typeof pskEntry.snr === 'number') {
          modeQualityByBand[ri][bi].FTx = pskEntry.snr;
          if (typeof pskEntry.count === 'number' && pskEntry.count > 0 && mode !== 'grid')
            ftxReportsInQuery += pskEntry.count;
          if (mode === 'grid' && gridLL && Array.isArray(pskEntry.rxGridCounts)) {
            pskEntry.rxGridCounts.forEach((entry) => {
              if (!Array.isArray(entry) || entry.length < 2) return;
              const cell = String(entry[0] || '').toUpperCase();
              const count = Number(entry[1] || 0);
              if (cell.length < 4 || !Number.isFinite(count) || count <= 0) return;
              const ll = gridToLatLon(cell);
              if (!ll) return;
              const dist = distanceMiles(gridLL.lat, gridLL.lon, ll.lat, ll.lon);
              if (dist > radiusMiles) return;
              pskGridCallCounts[cell] = (pskGridCallCounts[cell] || 0) + count;
            });
          }
          // For the Vantage FTx tooltip we want reporting receiver stations
          // (same conceptual side as "skimmers"), never DX sender fallbacks.
          const reporterCalls = Array.isArray(pskEntry.rxCalls) ? pskEntry.rxCalls : [];
          if (Array.isArray(reporterCalls)) {
            reporterCalls.forEach((c) => {
              const s = String(c || '').trim().toUpperCase();
              if (s) ftxCallsigns.add(s);
            });
          }

          // Feed PSK FTx into the main S-meter: full fallback when RBN is absent,
          // and a light blend when RBN data exists for the same cell.
          const pskScaled = ftxSnrToRbnScale(pskEntry.snr);
          if (pskScaled != null) {
            const meter = meters[ri];
            if (!sampled[ri][bi]) {
              if (!meter.hasValue[bi] || meter.ema[bi] < pskScaled) meter.ema[bi] = pskScaled;
              meter.hasValue[bi] = true;
              if (meter.ema[bi] > meter.peak[bi]) meter.peak[bi] = meter.ema[bi];
            } else if (meter.hasValue[bi]) {
              const blended = meter.ema[bi] * 0.85 + pskScaled * 0.15;
              meter.ema[bi] = blended;
              if (blended > meter.peak[bi]) meter.peak[bi] = blended;
            }
          }
        }
      }
    }
  }
  if (mode === 'grid') {
    ftxReportsInQuery = 0;
    Object.entries(pskGridCallCounts).forEach(([cell, count]) => {
      if (gridPskCallIncluded.has(cell)) return;
      gridPskCallIncluded.add(cell);
      ftxReportsInQuery += count;
    });
  }

  if (activeRevision !== refreshRevision) return;
  updateSkimmerCount(
    skimmerCount,
    mode === 'grid',
    ftxReportsInQuery,
    skimmerCallsigns,
    Array.from(ftxCallsigns).sort(),
  );
  refreshUI(modeQualityByBand);

  const ts = new Date().toLocaleTimeString();
  const pskInfo = pskMeta.age == null ? 'psk=na' : `psk=${pskMeta.age}s${pskMeta.stale ? ' stale' : ''}`;
  setStatus(
    `Poll ${ts}  |  spots=${totalSpots}  vantage=${spotsFromVantage}  mapped=${spotsProcessed}  unk=${spotsUnknown}  ${pskInfo}`,
    spotsProcessed > 0 ? 'ok' : 'warn'
  );
  } finally {
    pollInFlight = false;
    if (pollPending) {
      pollPending = false;
      queueMicrotask(() => pollOnce());
    }
  }
}

function startPolling() {
  if (isRunning) return;
  isRunning = true;
  setStatus('Auto polling started.', 'ok');
  saveSettings();
  pollOnce(refreshRevision);
  pollTimer = setInterval(() => pollOnce(), POLL_MS);
}

function hardResetVantageData() {
  meters.forEach(m => m.reset());
  skimmerCount = 0;
  updateSkimmerCount(0, currentVantageState().mode === 'grid', 0, [], []);
  refreshUI(createModeQualityCube());
}

function scheduleRefresh(delayMs = 150) {
  if (!isRunning) return;
  refreshRevision++;
  const revision = refreshRevision;
  hardResetVantageData();
  setStatus('Refreshing vantage data...', 'warn');
  if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(async () => {
    refreshDebounceTimer = null;
    await pollOnce(revision);
  }, delayMs);
}

function setStatus(msg, cls = '') {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className   = cls;
}

// ── Skimmer count display ─────────────────────────────────────────────────────
function formatTooltipList(title, calls) {
  const fullList = Array.isArray(calls) ? calls : [];
  if (fullList.length === 0) return `${title} (0)\nnone`;
  const shown = fullList.slice(0, TOOLTIP_CALLSIGN_LIMIT);
  const remaining = fullList.length - shown.length;
  let out = `${title} (${fullList.length})\n${shown.join(', ')}`;
  if (remaining > 0) out += `\n...and ${remaining} more`;
  return out;
}

function updateSkimmerCount(n, isGrid, ftxReports = 0, skimmerCalls = [], ftxCalls = []) {
  const skimmerLabel = document.getElementById('vantage-skimmer-label');
  const ftxLabel = document.getElementById('vantage-ftx-label');
  const combinedLabel = document.getElementById('skimmer-count');
  if (!skimmerLabel && !combinedLabel) return;
  const skimmerClass = n === 0
    ? (isGrid ? 'skimmer-none' : 'skimmer-few')
    : (n < 3 ? 'skimmer-few' : 'skimmer-ok');
  const ftxClass = ftxReports === 0 ? 'skimmer-few' : 'skimmer-ok';

  if (skimmerLabel) {
    skimmerLabel.textContent = `${n} skimmer${n === 1 ? '' : 's'}`;
    skimmerLabel.setAttribute('title', formatTooltipList('Skimmers', skimmerCalls));
    skimmerLabel.className = `skimmer-count vantage-count-label ${skimmerClass}`;
  }

  if (ftxLabel) {
    ftxLabel.textContent = `${ftxReports} Digital report${ftxReports === 1 ? '' : 's'}`;
    ftxLabel.setAttribute('title', formatTooltipList('FTx calls', ftxCalls));
    ftxLabel.className = `skimmer-count vantage-count-label ${ftxClass}`;
  }

  // Backward compatibility / accessibility mirror text.
  if (combinedLabel) {
    combinedLabel.textContent = `${n} skimmer${n === 1 ? '' : 's'} / ${ftxReports} Digital report${ftxReports === 1 ? '' : 's'}`;
    if (!skimmerLabel) {
      combinedLabel.className = `skimmer-count vantage-count-label ${skimmerClass}`;
    }
    combinedLabel.setAttribute(
      'title',
      `${formatTooltipList('Skimmers', skimmerCalls)}\n\n${formatTooltipList('FTx calls', ftxCalls)}`,
    );
  }
}

function currentVantageState() {
  const mode = document.querySelector('input[name="vantage-mode"]:checked')?.value || 'region';
  if (mode === 'grid') {
    const grid = document.getElementById('grid-input').value.trim().toUpperCase();
    const radiusSelect = document.getElementById('radius-select');
    const radius = radiusSelect ? (RADIUS_VALUES[radiusSelect.selectedIndex] ?? 500) : 500;
    const unit = getUnit();
    const radiusMiles = getRadiusMiles();
    return {
      mode,
      grid,
      radius,
      unit,
      radiusMiles,
      radiusLabel: `${radius} ${unit}`,
      regionIdx: parseInt(document.getElementById('region-select').value, 10) || 0,
    };
  }
  return {
    mode,
    regionIdx: parseInt(document.getElementById('region-select').value, 10) || 0,
    grid: '',
    radius: 0,
    unit: getUnit(),
    radiusMiles: getRadiusMiles(),
    radiusLabel: '',
  };
}

function buildAudioUrl(vantage = currentVantageState()) {
  const q = new URLSearchParams();
  // Remove browser language — server will use IP geo for greeting time-of-day
  q.set('to', 'all');
  q.set('bands', 'all');
  q.set('utc', new Date().toISOString().slice(11, 16));

  // Mode flags: always request all modes — the server derives active modes from
  // live data. Sending dynamic flags busted the cache (key changed each request).

  if (vantage.mode === 'grid') {
    if (!vantage.grid || !isValidGrid(vantage.grid)) return null;
    q.set('mode', 'grid');
    q.set('grid', vantage.grid.toUpperCase().slice(0, 4));
    q.set('radius', String(vantage.radius || 500));
    q.set('unit', String(vantage.unit || 'mi').toLowerCase());
  } else {
    q.set('mode', 'region');
    const key = SOURCE_REGION_KEYS[vantage.regionIdx] || SOURCE_REGION_KEYS[0];
    q.set('from', key);
  }
  return `/audio/propreport?${q.toString()}`;
}

function stopAudioPlayback() {
  if (audioAbortCtrl) {
    try { audioAbortCtrl.abort(); } catch {}
    audioAbortCtrl = null;
  }
  if (audioElement) {
    try { audioElement.pause(); } catch {}
    audioElement.src = '';
    audioElement = null;
  }
  if (audioPlayback && audioPlayback.url) {
    try { URL.revokeObjectURL(audioPlayback.url); } catch {}
  }
  audioPlayback = null;
  audioRequestInFlight = false;
  const btn = document.getElementById('vantage-audio-btn');
  if (btn) {
    btn.classList.remove('playing');
    btn.classList.remove('loading');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Play audio propagation report');
    btn.title = 'Play audio propagation report';
  }
}


function setAudioButtonState(state) {
  const btn = document.getElementById('vantage-audio-btn');
  if (!btn) return;
  btn.classList.remove('playing', 'loading');
  if (state === 'loading') {
    btn.classList.add('loading');
    btn.disabled = true;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Buffering audio report');
    btn.title = 'Buffering audio report...';
    return;
  }
  if (state === 'playing') {
    btn.classList.add('playing');
    btn.disabled = false;
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', 'Stop audio propagation report');
    btn.title = 'Stop audio propagation report';
    return;
  }
  btn.disabled = false;
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', 'Play audio propagation report');
  btn.title = 'Play audio propagation report';
}

async function requestAudioReport() {
  if (audioRequestInFlight) return;
  const btn = document.getElementById('vantage-audio-btn');
  if (!btn) return;
  if (audioPlayback || (audioElement && !audioElement.paused)) {
    stopAudioPlayback();
    setStatus('Audio report stopped.', 'warn');
    return;
  }
  const url = buildAudioUrl();
  if (!url) {
    setStatus('Enter a valid grid square before requesting audio report.', 'error');
    return;
  }

  audioRequestInFlight = true;
  setAudioButtonState('loading');
  suppressAudioStopOnVantageUpdate = true;
  setStatus('Requesting audio report...', 'warn');

  // Use a dedicated ?info=1 request to sniff cache status without triggering
  // a second concurrent audio generation (which caused race conditions on the
  // .dynamic-tmp file and mid-stream language corruption).
  fetch(url + (url.includes('?') ? '&' : '?') + 'info=1').then((r) => {
    if (!r.ok) return;
    const audioMode = r.headers.get('X-HFSIGNALS-Audio') || '';
    const filename  = r.headers.get('X-HFSIGNALS-Filename') || '';
    const label     = filename ? ` (${filename})` : '';
    if (audioMode === 'cached') {
      console.log(`[audio] playing from cache${label}`);
      setStatus(`Playing from cache${label}`, 'ok');
    } else if (audioMode === 'streaming') {
      console.log(`[audio] streaming live TTS${label}`);
      setStatus(`Streaming audio report${label}`, 'warn');
    }
  }).catch(() => {});

  const audio = new Audio(url);
  audioElement = audio;

  // As soon as the browser has enough data to start playback, flip to "playing"
  audio.addEventListener('canplay', () => {
    if (audioRequestInFlight) {
      audioRequestInFlight = false;
      setAudioButtonState('playing');
      // Status line already set by the HEAD response; only update if it hasn't been yet
    }
  }, { once: true });

  audio.addEventListener('ended', () => {
    stopAudioPlayback();
    setStatus('Audio report completed.', 'ok');
  });

  audio.addEventListener('error', () => {
    audioRequestInFlight = false;
    suppressAudioStopOnVantageUpdate = false;
    stopAudioPlayback();
    setStatus('Audio report failed.', 'error');
  });

  try {
    await audio.play();
    audioPlayback = { url: null }; // streaming — no object URL to revoke
  } catch (e) {
    audioRequestInFlight = false;
    suppressAudioStopOnVantageUpdate = false;
    if (e?.name !== 'AbortError') {
      setStatus(`Audio report failed: ${e.message || 'unknown error'}`, 'error');
    }
    stopAudioPlayback();
  }
}

function wireAudioControls() {
  const btn = document.getElementById('vantage-audio-btn');
  if (!btn) return;
  setAudioButtonState('idle');
  btn.addEventListener('click', () => { requestAudioReport(); });
}

// ── Grid place-name cache (fetched from /gridinfo) ───────────────────────────
const _gridPlaceCache = {};  // grid4 → placeName | null | 'pending'
let _gridPlaceFetchTimer = null;

async function fetchGridPlaceName(grid4) {
  const key = grid4.toUpperCase().slice(0, 4);
  if (key in _gridPlaceCache) return _gridPlaceCache[key];
  _gridPlaceCache[key] = 'pending';
  try {
    const r = await fetch(`/gridinfo?grid=${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error('http ' + r.status);
    const d = await r.json();
    _gridPlaceCache[key] = d.place || null;
  } catch {
    _gridPlaceCache[key] = null;
  }
  return _gridPlaceCache[key] === 'pending' ? null : _gridPlaceCache[key];
}

function vantagePointText() {
  const v = currentVantageState();
  if (v.mode === 'grid') {
    const label = v.grid || '--';
    return `${label} (${v.radius} ${v.unit})`;
  }
  return SOURCE_REGION_NAMES[v.regionIdx] || SOURCE_REGION_NAMES[0];
}

function updateVantageDisplay() {
  const el = document.getElementById('vantage-point-text');
  const canvas = document.getElementById('vantage-map-canvas');
  if (!el) return;
  const v = currentVantageState();
  el.textContent = vantagePointText();

  // Update place-name sub-line for grid mode
  const placeEl = document.getElementById('vantage-place-name');
  if (placeEl) {
    const grid4 = (v.mode === 'grid' && v.grid && v.grid.length >= 4)
      ? v.grid.toUpperCase().slice(0, 4) : null;

    if (grid4 && isValidGrid(grid4)) {
      const cached = _gridPlaceCache[grid4];
      if (cached !== undefined && cached !== 'pending') {
        // Already in cache — show immediately
        placeEl.textContent = cached || '';
        placeEl.style.display = cached ? '' : 'none';
      } else if (cached === undefined) {
        // Not yet fetched — keep existing text, debounce the fetch
        if (_gridPlaceFetchTimer) clearTimeout(_gridPlaceFetchTimer);
        _gridPlaceFetchTimer = setTimeout(() => {
          _gridPlaceFetchTimer = null;
          const cur = currentVantageState();
          const curGrid4 = (cur.mode === 'grid' && cur.grid && cur.grid.length >= 4)
            ? cur.grid.toUpperCase().slice(0, 4) : null;
          if (curGrid4 !== grid4) return; // grid changed while waiting
          fetchGridPlaceName(grid4).then(name => {
            const plEl = document.getElementById('vantage-place-name');
            const now = currentVantageState();
            const nowGrid4 = (now.mode === 'grid' && now.grid && now.grid.length >= 4)
              ? now.grid.toUpperCase().slice(0, 4) : null;
            if (plEl && nowGrid4 === grid4) {
              plEl.textContent = name || '';
              plEl.style.display = name ? '' : 'none';
            }
          });
        }, 600); // 600 ms after last keystroke
      }
      // if 'pending' — leave display as-is while fetch is in flight
    } else {
      // Not grid mode or incomplete/invalid grid
      if (_gridPlaceFetchTimer) { clearTimeout(_gridPlaceFetchTimer); _gridPlaceFetchTimer = null; }
      placeEl.textContent = '';
      placeEl.style.display = 'none';
    }
  }
  if (canvas) {
    const hasDetailed = Array.isArray(detailedWorldPolygons) && detailedWorldPolygons.length > 0;
    canvas.classList.toggle('loading', !hasDetailed);
    if (!hasDetailed && !detailedWorldLoadPromise && !detailedWorldLoadFailed) {
      loadDetailedWorldPolygons().then(() => {
        updateVantageDisplay();
      }).catch(() => {});
    }
    if (v.mode === 'grid') drawGridVantageMap(canvas, v.grid, v.radiusMiles, v.radiusLabel);
    else drawRegionVantageMap(canvas, v.regionIdx);
  }
  if (!suppressAudioStopOnVantageUpdate) stopAudioPlayback();
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
        if (isRunning) scheduleRefresh(120);
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
  updateVantageDisplay();
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
    theme:        currentTheme,
    autoUpdate:   document.getElementById('autoupdate-cb')?.checked || false,
    desktopCollapsed: collapsedDesktopIndexes(),
  });
}

function applySettings(s) {
  desktopCollapsed = normaliseDesktopCollapsed(s.desktopCollapsed);
  document.querySelector(`input[name="vantage-mode"][value="${s.mode}"]`).checked = true;
  document.getElementById('region-select').value = s.regionIndex;
  document.getElementById('grid-input').value    = s.grid || '';
  document.getElementById('radius-select').selectedIndex = s.radiusIndex ?? 2;
  unitPref = s.unit ?? 'auto';
  if (document.getElementById('autoupdate-cb'))
    document.getElementById('autoupdate-cb').checked = s.autoUpdate || false;
  applyTheme(s.theme || 'dark');
  updateRadiusLabels();
  updateModeUI(s.mode);
  applyDesktopCollapseState();
  updateVantageDisplay();
}

function updateModeUI(mode) {
  const isGrid = mode === 'grid';
  document.getElementById('region-select').disabled  = isGrid;
  document.getElementById('grid-input').disabled     = !isGrid;
  document.getElementById('radius-select').disabled  = !isGrid;
  document.getElementById('unit-toggle').disabled    = !isGrid;

  // Skimmer count always visible in vantage panel.

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
  updateVantageDisplay();
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
    setStatus(`Location detected: ${grid}.`, 'ok');
    saveSettings();
    scheduleRefresh(100);
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

  const themeDarkBtn = document.getElementById('theme-dark');
  const themeLightBtn = document.getElementById('theme-light');
  const themeCbBtn = document.getElementById('theme-cb');
  if (themeDarkBtn) themeDarkBtn.addEventListener('click', () => { applyTheme('dark'); saveSettings(); });
  if (themeLightBtn) themeLightBtn.addEventListener('click', () => { applyTheme('light'); saveSettings(); });
  if (themeCbBtn) themeCbBtn.addEventListener('click', () => { applyTheme('cb'); saveSettings(); });
  wireAudioControls();

  if (!s.grid) autoDetect(); else autoDetect();

  // Restore auto-update if it was enabled
  if (s.autoUpdate && s.mode === 'grid') startAutoUpdate();

  document.querySelectorAll('input[name="vantage-mode"]').forEach(rb => {
    rb.addEventListener('change', () => {
      updateModeUI(rb.value);
      saveSettings();
      scheduleRefresh();
    });
  });

  document.getElementById('region-select').addEventListener('change', () => {
    if (unitPref === 'auto') updateRadiusLabels();
    updateVantageDisplay();
    saveSettings();
    scheduleRefresh();
  });

  document.getElementById('radius-select').addEventListener('change', () => {
    updateVantageDisplay();
    saveSettings();
    scheduleRefresh();
  });

  document.getElementById('unit-toggle').addEventListener('click', () => {
    const current = getUnit();
    unitPref = current === 'mi' ? 'km' : 'mi';
    updateRadiusLabels();
    updateVantageDisplay();
    saveSettings();
    scheduleRefresh();
  });

  const gi = document.getElementById('grid-input');
  gi.addEventListener('input', () => {
    gi.style.borderColor = '';
    updateVantageDisplay();
    saveSettings();
  });
  gi.addEventListener('blur', () => {
    const g = gi.value.trim();
    if (g && !isValidGrid(g)) {
      gi.style.borderColor = '#dc4a4a';
      setStatus(`'${g}' is not a valid Maidenhead grid square (e.g. FN42).`, 'error');
    } else {
      gi.style.borderColor = '';
      scheduleRefresh();
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

  // Keep vantage graphics crisp whenever viewport dimensions change.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => updateVantageDisplay(), 80);
  });
  requestAnimationFrame(updateVantageDisplay);

  // Space weather + UTC clock
  updateUTC();
  setInterval(updateUTC, 1000);
  fetchSolar();
  setInterval(fetchSolar, 5 * 60 * 1000);

  startPolling();
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



// ═══════════════════════════════════════════════════════════════════════════════
// ── Signal History Chart ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const HISTORY_BANDS = ['160m','80m','40m','30m','20m','17m','15m','12m','10m','6m'];

const HISTORY_BAND_COLORS = [
  '#ff6b6b', // 160m
  '#ff9f43', // 80m
  '#ffd93d', // 40m
  '#6bcb77', // 30m
  '#00d4aa', // 20m  (accent)
  '#4ecdc4', // 17m
  '#45aaf2', // 15m
  '#a29bfe', // 12m
  '#fd79a8', // 10m
  '#b2bec3', // 6m
];

const HISTORY_SNR_MAX  = 60;
const HISTORY_WINDOW_S = 24 * 60 * 60;

// SVG margins
const HM = { top: 10, right: 6,  bottom: 52, left: 30 };

let historyRefreshTimer  = null;
let historyLastVantage   = null; // last vantage key fetched — skip redundant fetches

// ── Derive vantage region key from current UI state ───────────────────────────
function historyVantageKey() {
  const mode = document.querySelector('input[name="vantage-mode"]:checked')?.value || 'region';
  if (mode === 'region') {
    const idx = parseInt(document.getElementById('region-select')?.value || '0', 10);
    return SOURCE_REGION_KEYS[idx] || 'ENA';
  }
  // Grid mode: map grid center to the nearest region
  const grid = (document.getElementById('grid-input')?.value || '').trim().toUpperCase();
  if (grid.length >= 4) {
    const ll = gridToLatLon(grid);
    if (ll) {
      const key = regionFromLatLon(ll.lat, ll.lon);
      if (key) return key;
    }
  }
  return 'ENA';
}

// ── Fetch + draw ──────────────────────────────────────────────────────────────
async function fetchAndDrawHistory({ force = false } = {}) {
  const svg  = document.getElementById('history-svg');
  const note = document.getElementById('history-note');
  if (!svg) return;

  const vantage = historyVantageKey();
  if (!force && vantage === historyLastVantage) return;
  historyLastVantage = vantage;

  try {
    const resp = await fetch(`${PROXY_BASE}/history?vantage=${vantage}`,
      { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    drawHistoryChart(svg, note, data);
  } catch (e) {
    drawHistoryEmpty(svg, note, 'History unavailable');
  }
}

// ── SVG helpers ───────────────────────────────────────────────────────────────
function makeSvgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function drawHistoryEmpty(svg, note, msg) {
  svg.innerHTML = '';
  const W = svg.clientWidth || 260;
  const H = svg.clientHeight || 160;
  const t = makeSvgEl('text', {
    x: W / 2, y: H / 2,
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: 'var(--text-dim)', 'font-size': '11',
    'font-family': 'Share Tech Mono, monospace'
  });
  t.textContent = msg;
  svg.appendChild(t);
  if (note) note.textContent = '';
}

// ── Main chart renderer ───────────────────────────────────────────────────────
function drawHistoryChart(svg, note, data) {
  svg.innerHTML = '';

  const W = svg.clientWidth  || 260;
  const H = svg.clientHeight || 160;
  if (W < 10 || H < 10) return;

  const pl = HM.left, pr = HM.right, pt = HM.top, pb = HM.bottom;
  const cw = W - pl - pr;
  const ch = H - pt - pb;

  const now   = Math.floor(Date.now() / 1000);
  const start = now - HISTORY_WINDOW_S;

  const pts = data.points || [];
  if (pts.length === 0) {
    drawHistoryEmpty(svg, note, 'No history yet — collecting data…');
    return;
  }

  // ── Y-axis grid lines + labels ────────────────────────────────────────────
  for (const db of [0, 15, 30, 45, 60]) {
    const y = pt + ch - (db / HISTORY_SNR_MAX) * ch;
    svg.appendChild(makeSvgEl('line', {
      x1: pl, y1: y, x2: pl + cw, y2: y, class: 'history-grid-line'
    }));
    const lbl = makeSvgEl('text', {
      x: pl - 4, y: y + 1,
      'text-anchor': 'end', 'dominant-baseline': 'middle',
      class: 'history-tick-label'
    });
    lbl.textContent = String(db);
    svg.appendChild(lbl);
  }

  // ── X-axis time ticks (every 4h UTC) ─────────────────────────────────────
  const TICK_INTERVAL = 4 * 3600;
  const firstTick = Math.ceil(start / TICK_INTERVAL) * TICK_INTERVAL;
  for (let ts = firstTick; ts <= now; ts += TICK_INTERVAL) {
    const x = pl + ((ts - start) / HISTORY_WINDOW_S) * cw;
    svg.appendChild(makeSvgEl('line', {
      x1: x, y1: pt + ch, x2: x, y2: pt + ch + 3, class: 'history-axis-line'
    }));
    const d = new Date(ts * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const lbl = makeSvgEl('text', {
      x, y: pt + ch + 14, 'text-anchor': 'middle', class: 'history-tick-label'
    });
    lbl.textContent = `${hh}:${mm}`;
    svg.appendChild(lbl);
  }

  // ── Axes ──────────────────────────────────────────────────────────────────
  svg.appendChild(makeSvgEl('line', { x1: pl, y1: pt, x2: pl, y2: pt + ch, class: 'history-axis-line' }));
  svg.appendChild(makeSvgEl('line', { x1: pl, y1: pt + ch, x2: pl + cw, y2: pt + ch, class: 'history-axis-line' }));

  // ── Build per-band series ─────────────────────────────────────────────────
  const byBand = {};
  for (const band of HISTORY_BANDS) byBand[band] = [];
  for (const p of pts) {
    if (byBand[p.band]) {
      byBand[p.band].push({ ts: p.ts, snr: Math.max(0, Math.min(p.snr, HISTORY_SNR_MAX)) });
    }
  }

  // ── Draw lines ────────────────────────────────────────────────────────────
  for (let bi = 0; bi < HISTORY_BANDS.length; bi++) {
    const band   = HISTORY_BANDS[bi];
    const color  = HISTORY_BAND_COLORS[bi];
    const series = byBand[band];
    if (series.length < 2) continue;

    const pointsStr = series.map(({ ts, snr }) => {
      const x = pl + ((ts - start) / HISTORY_WINDOW_S) * cw;
      const y = pt + ch - (snr / HISTORY_SNR_MAX) * ch;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    svg.appendChild(makeSvgEl('polyline', {
      points: pointsStr,
      fill: 'none', stroke: color,
      'stroke-width': '1.5',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: '0.9'
    }));
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const legendY    = pt + ch + 30;
  const itemW      = 44;
  const maxPerRow  = Math.max(1, Math.floor(cw / itemW));
  const totalRows  = Math.ceil(HISTORY_BANDS.length / maxPerRow);
  const rowH       = 15;
  // Centre the legend block horizontally
  const legendBlockW = Math.min(HISTORY_BANDS.length, maxPerRow) * itemW;
  const legendOffX   = Math.max(0, Math.floor((cw - legendBlockW) / 2));

  for (let i = 0; i < HISTORY_BANDS.length; i++) {
    const band  = HISTORY_BANDS[i];
    const color = HISTORY_BAND_COLORS[i];
    const col   = i % maxPerRow;
    const row   = Math.floor(i / maxPerRow);
    const lx    = pl + legendOffX + col * itemW;
    const ly    = legendY + row * rowH;
    const hasData = byBand[band].length >= 2;

    svg.appendChild(makeSvgEl('rect', {
      x: lx, y: ly - 5, width: 8, height: 4,
      fill: color, rx: 1, opacity: hasData ? '1' : '0.3'
    }));
    const lbl = makeSvgEl('text', {
      x: lx + 10, y: ly - 1,
      class: 'history-legend-text', opacity: hasData ? '1' : '0.3'
    });
    lbl.textContent = band;
    svg.appendChild(lbl);
  }

  // ── "Collecting since" note ───────────────────────────────────────────────
  if (note) {
    if (data.earliest && (now - data.earliest) < HISTORY_WINDOW_S - 600) {
      const d  = new Date(data.earliest * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      note.textContent = `Collecting since ${hh}:${mm} UTC`;
    } else {
      note.textContent = '';
    }
  }
}

// ── Auto-refresh aligned to 5-min clock boundary ─────────────────────────────
function startHistoryRefresh() {
  stopHistoryRefresh();
  fetchAndDrawHistory({ force: true });
  const snap = 5 * 60 * 1000;
  const next = snap - (Date.now() % snap);
  historyRefreshTimer = setTimeout(() => {
    fetchAndDrawHistory({ force: true });
    historyRefreshTimer = setInterval(() => fetchAndDrawHistory({ force: true }), snap);
  }, next);
}

function stopHistoryRefresh() {
  if (historyRefreshTimer != null) {
    clearTimeout(historyRefreshTimer);
    clearInterval(historyRefreshTimer);
    historyRefreshTimer = null;
  }
}

// ── Wire up vantage controls → chart refresh ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Region mode select
  document.getElementById('region-select')?.addEventListener('change', () => {
    historyLastVantage = null;
    fetchAndDrawHistory({ force: true });
  });

  // Grid input (on Enter or blur)
  const gridInput = document.getElementById('grid-input');
  if (gridInput) {
    gridInput.addEventListener('change', () => {
      historyLastVantage = null;
      fetchAndDrawHistory({ force: true });
    });
  }

  // Mode radio buttons (region ↔ grid switch)
  document.querySelectorAll('input[name="vantage-mode"]').forEach(rb => {
    rb.addEventListener('change', () => {
      historyLastVantage = null;
      fetchAndDrawHistory({ force: true });
    });
  });

  // Redraw on window resize
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      historyLastVantage = null; // force redraw with correct width
      fetchAndDrawHistory({ force: true });
    }, 200);
  });

  startHistoryRefresh();
});

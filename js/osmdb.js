// Local OSM building database (data/osm, built by tools/build_osm_tiles.py) and the Zensus 2022 age grid.
import { pointInPolygon, toLAEA } from './geo.js';
import { L, pick } from './i18n.js';

let INDEX = null;
const TILE_CACHE = new Map();
let ZENSUS = null;

export async function loadIndex(base = 'data/osm/') {
  if (!INDEX) INDEX = await (await fetch(base + 'index.json')).json();
  INDEX.base = base;
  return INDEX;
}

function tileKey(ix, iy) { return `${ix}_${iy}`; }

async function loadTile(ix, iy) {
  const key = tileKey(ix, iy);
  if (TILE_CACHE.has(key)) return TILE_CACHE.get(key);
  const p = (async () => {
    const res = await fetch(`${INDEX.base}t_${key}.json`);
    if (!res.ok) return [];
    const t = await res.json();
    const [ox, oy] = t.o;
    const dec = (flat) => {
      const ring = [];
      for (let i = 0; i < flat.length; i += 2) ring.push([(flat[i] + ox) / 1e6, (flat[i + 1] + oy) / 1e6]);
      return ring;
    };
    return t.b.map((b) => {
      const outer = dec(b.r);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return { id: b.i, outer, holes: (b.h || []).map(dec), tags: b.t || {}, part: !!b.p, bbox: [x0, y0, x1, y1] };
    });
  })();
  TILE_CACHE.set(key, p);
  return p;
}

function tileOf(lon, lat) {
  const [lx, ly] = INDEX.bbox;
  return [Math.floor((lon - lx) / INDEX.dlon), Math.floor((lat - ly) / INDEX.dlat)];
}

export function inCoverage(lon, lat) {
  const b = INDEX.bbox;
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

// All OSM buildings of the 3 × 3 tiles around a point (also used by js/walk.js for the street model).
export async function around(lon, lat) {
  const [ix, iy] = tileOf(lon, lat);
  const lists = await Promise.all([-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => loadTile(ix + dx, iy + dy))));
  return lists.flat();
}

// LoD2 records (data/lod2/t_<tile>.json, same tiles as data/osm) for the 3 × 3 tiles around a point: Map OSM id → array.
const LOD2_CACHE = new Map();
export async function lod2Around(lon, lat, base = 'data/lod2/') {
  const [ix, iy] = tileOf(lon, lat);
  const get = (k) => { if (!LOD2_CACHE.has(k)) LOD2_CACHE.set(k, fetch(`${base}t_${k}.json`).then((r) => (r.ok ? r.json() : { b: {} })).catch(() => ({ b: {} }))); return LOD2_CACHE.get(k); };
  const parts = await Promise.all([-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => get(tileKey(ix + dx, iy + dy)))));
  // m: OSM id → LoD2 record; m.structures: OSM id → [footprint m², height m] of OSM "buildings" judged to be structures;
  // m.noCover: OSM buildings inside the LoD2 area with no LoD2 building under them (both from tools/structures_scan.mjs)
  const m = new Map();
  m.structures = new Map(); m.noCover = new Set();
  for (const p of parts) {
    for (const [id, v] of Object.entries(p.b || {})) m.set(id, v);
    for (const [id, v] of Object.entries(p.st || {})) m.structures.set(id, v);
    for (const id of p.nc || []) m.noCover.add(id);
  }
  return m;
}

// Building (not building:part) containing the point; if none, the nearest within `snap` metres.
export async function buildingAt(lon, lat, snap = 6) {
  const all = await around(lon, lat);
  const cands = all.filter((b) => !b.part && lon >= b.bbox[0] - 1e-4 && lon <= b.bbox[2] + 1e-4 && lat >= b.bbox[1] - 1e-4 && lat <= b.bbox[3] + 1e-4);
  const hit = cands.filter((b) => pointInPolygon([lon, lat], b.outer, b.holes));
  if (hit.length) {
    hit.sort((a, b) => bboxArea(a) - bboxArea(b)); // innermost / smallest
    return hit[0];
  }
  // nearest edge within snap
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  let best = null, bd = snap;
  for (const b of all) {
    if (b.part) continue;
    const r = b.outer;
    for (let i = 0; i < r.length; i++) {
      const d = segDist([(lon - r[i][0]) * kx, (lat - r[i][1]) * ky], [(r[(i + 1) % r.length][0] - r[i][0]) * kx, (r[(i + 1) % r.length][1] - r[i][1]) * ky]);
      if (d < bd) { bd = d; best = b; }
    }
  }
  return best;
}

function bboxArea(b) { return (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]); }
function segDist(p, v) {
  const l2 = v[0] * v[0] + v[1] * v[1];
  const t = l2 > 0 ? Math.max(0, Math.min(1, (p[0] * v[0] + p[1] * v[1]) / l2)) : 0;
  return Math.hypot(p[0] - t * v[0], p[1] - t * v[1]);
}

export async function byId(id, lon, lat) {
  const all = await around(lon, lat);
  return all.find((b) => b.id === id) || null;
}

// Neighbours (buildings and parts) whose bbox comes within `radius` metres of the target bbox.
export async function neighbours(target, radius = 150) {
  const [cx, cy] = [(target.bbox[0] + target.bbox[2]) / 2, (target.bbox[1] + target.bbox[3]) / 2];
  const all = await around(cx, cy);
  const dLon = radius / (111320 * Math.cos((cy * Math.PI) / 180)), dLat = radius / 110540;
  return all.filter((b) => b.id !== target.id && b.bbox[2] >= target.bbox[0] - dLon && b.bbox[0] <= target.bbox[2] + dLon
    && b.bbox[3] >= target.bbox[1] - dLat && b.bbox[1] <= target.bbox[3] + dLat);
}

// ---------- Zensus 2022 construction-year distribution around a point ----------
export async function loadZensus(url = 'data/zensus/baujahr.json') {
  if (!ZENSUS) { ZENSUS = await (await fetch(url)).json(); ZENSUS.classes = pick(ZENSUS, 'classes'); }
  return ZENSUS;
}

// Returns { counts: [8], total, level: '100m' | '100m-3x3' | '1km', cells } with counts of residential buildings
// per Zensus class. Small 100 m cells are often all zero because of the cell-key confidentiality method, so we
// widen to the 3×3 neighbourhood and then to the 1 km cell.
export async function zensusAt(lon, lat) {
  const Z = await loadZensus();
  const [x, y] = toLAEA(lon, lat);
  const e = Math.floor(x / 100), n = Math.floor(y / 100);
  const get = (k) => Z.c100[k];
  const sum = (rows) => rows.reduce((acc, r) => acc.map((v, i) => v + r[i + 1]), [0, 0, 0, 0, 0, 0, 0, 0]);
  const c = get(`${e}_${n}`);
  if (c && c.slice(1).reduce((s, v) => s + v, 0) >= 5) return { counts: c.slice(1), total: c[0], level: L('100 m 网格', '100 m cell', 'Rasterzelle 100 m'), key: `${e}_${n}` };
  const rows = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const r = get(`${e + dx}_${n + dy}`); if (r) rows.push(r); }
  const s3 = sum(rows);
  if (s3.reduce((a, v) => a + v, 0) >= 10) return { counts: s3, total: rows.reduce((a, r) => a + r[0], 0), level: L('周边 300 m × 300 m', 'surrounding 300 m × 300 m', 'Umgebung 300 m × 300 m'), key: `${e}_${n}` };
  const k1 = `${Math.floor(x / 1000)}_${Math.floor(y / 1000)}`;
  const r1 = Z.c1k[k1];
  if (r1) return { counts: r1.slice(1), total: r1[0], level: L('1 km 网格', '1 km cell', 'Rasterzelle 1 km'), key: k1 };
  return null;
}

export function zensusClasses() { return ZENSUS ? ZENSUS.classes : []; }

// ---------- Zensus 2022 heating energy carrier around a point (dwellings, by the building's predominant carrier) ----------
let HEAT = null;
export async function loadHeating(url = 'data/zensus/heizung.json') {
  if (!HEAT) { try { HEAT = await (await fetch(url)).json(); } catch { HEAT = { carriers: [], c100: {}, c1k: {} }; } }
  return HEAT;
}
// Returns { p: {carrier: share}, n, level, key } or null. Same widening as zensusAt: 100 m cell, 3×3, then 1 km.
export async function heatingAt(lon, lat) {
  const Z = await loadHeating();
  if (!Z.carriers.length) return null;
  const [x, y] = toLAEA(lon, lat);
  const e = Math.floor(x / 100), n = Math.floor(y / 100);
  const known = (r) => r.slice(1, -1);   // drop the total and "kein Energieträger"
  const pack = (counts, level, key) => { const t = counts.reduce((a, v) => a + v, 0); return { p: Object.fromEntries(Z.carriers.slice(0, -1).map((c, i) => [c, counts[i] / t])), n: t, level, key }; };
  const c = Z.c100[`${e}_${n}`];
  if (c && known(c).reduce((a, v) => a + v, 0) >= 10) return pack(known(c), L('100 m 网格', '100 m cell', 'Rasterzelle 100 m'), `${e}_${n}`);
  let s3 = null;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const r = Z.c100[`${e + dx}_${n + dy}`]; if (r) s3 = s3 ? s3.map((v, i) => v + known(r)[i]) : known(r).slice(); }
  if (s3 && s3.reduce((a, v) => a + v, 0) >= 20) return pack(s3, L('周边 300 m × 300 m', 'surrounding 300 m × 300 m', 'Umgebung 300 m × 300 m'), `${e}_${n}`);
  const r1 = Z.c1k[`${Math.floor(x / 1000)}_${Math.floor(y / 1000)}`];
  if (r1 && known(r1).reduce((a, v) => a + v, 0) > 0) return pack(known(r1), L('1 km 网格', '1 km cell', 'Rasterzelle 1 km'), `${Math.floor(x / 1000)}_${Math.floor(y / 1000)}`);
  return null;
}


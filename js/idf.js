// EnergyPlus 24.2 input (IDF) export of a BModel (CONTRACT §5).
//   buildIDF(bmodel, opts) → string
//   planIDF(bmodel, opts)  → { surfaces, windows, zones, constructions, summary, warnings, … } (used by buildIDF and tests)
// Pure ES module, no dependencies besides ./epw.js; works in the browser and in Node.
//
// Modelling choices in short (full discussion and limitations: tools/export_notes.md):
// - One thermal zone per storey; with more than opts.maxExplicitStoreys (10) storeys: ground storey, one
//   representative middle storey (Zone Multiplier = floors − 2, placed at storey ⌊(n−1)/2⌋+1) and top storey.
// - Walls: one BuildingSurface:Detailed per ring edge × facade segment × storey. Exposed segments → Outdoors.
//   Party-wall segments → Adiabatic up to the neighbour height and Outdoors above it (same rule as
//   geometry.js facadeExposedArea, which feeds rc5.js); in a multiplier zone the split height is chosen so that the
//   exposed area over all represented storeys is conserved.
// - Floors/ceilings between storeys: interzone Surface pairs (symmetric construction, so each is its own reverse);
//   Adiabatic when zone multipliers are used. Horizontal polygons (with courtyard holes) are decomposed into
//   hole-free pieces (ear clipping with hole bridges + Hertel–Mehlhorn merge): convex for sunlit roofs, merged further
//   into simple polygons for floors and ceilings (not sunlit, no shading role).
// - Ground floor: OtherSideCoefficients "buffer" with T_other = F_floor·T_out + (1 − F_floor)·T_zone, which is exactly
//   the temperature-correction-factor definition used by rc5.js (default, opts.groundModel = 'ffactor');
//   opts.groundModel = 'ground' uses the Ground boundary with Site:GroundTemperature:BuildingSurface for slabs
//   (basement none/heated). An unheated attic uses the same buffer with F_roof on the top ceiling.
// - Constructions: Material:NoMass core + a concrete-like mass layer on the inside face; the mass thickness is set
//   building-wide so that ρ·c·d · (all inside faces) = Cm · A_net; the NoMass resistance closes the U-value with
//   EN ISO 6946 film resistances. Thermal bridges: H_tb = dU_tb · A_env is spread over the opaque envelope by adding
//   dU_tb · A_env/A_opaque to each opaque U (divided by F for buffer-coupled elements) — total H_tb as in rc5.js.
// - Windows: one centred window per Outdoors wall piece and storey (sill 0.9 m, 1.5 m high, widened/raised as
//   needed, ≥ 0.05 m margins). Window area per facade and storey = wwr × Outdoors wall area of that facade
//   (geometry.js definition); it is placed on fully exposed segments first. SimpleGlazingSystem with U_window and
//   SHGC = g_window · (1 − frameFrac).
// - Air: air changes refer to the net air volume 0.8 · V_e (as rc5.js) and are written as Flow/Zone (m³/s);
//   Zone Volume is autocalculated. Infiltration 0.07 · n50 always on. Ventilation as rc5.js: residential n_vent ·
//   (1 − hr_eff) always; non-residential window ventilation (DIN V 18599-2) max(0.1, n_vent · 3 m · A_net / V − n_inf)
//   during operating hours and 0.1 1/h outside (own schedule 'VentilationWindow'); with heat recovery n_vent ·
//   (1 − hr_eff) during operating hours and 10 % outside.
// - Internal gains: OtherEquipment (Fuel Type None). Residential: Q_int constant. Office/education/retail/other:
//   operating-hours schedule (1 in operation, 0.1 outside). opts.scheduleConvention:
//     'rc5' (default)  Q_int is the level during operating hours, set-back outside operating hours — identical to
//                      rc5.js and to data/archetypes_de.json, whose non-residential Q_int are DIN V 18599-10
//                      usage-hour values (office 9.1 W/m² over 11 h, 5 d/week);
//     'dailyMean'      the schedule is scaled so that its mean over the week equals Q_int and the set-back is
//                      22:00–06:00 every day (literal reading of the export brief; alias 'contract').
// - HVAC: ZoneHVAC:IdealLoadsAirSystem per zone; heating set point T_heat − (1 − heatedFrac)·4 K (rc5.js rule),
//   residential night set-back 22:00–06:00; cooling set point T_cool (only in operating hours for non-residential),
//   SingleHeating thermostat when T_cool is null. Pass opts.profile = archetype.js profileFor(usage) and
//   opts.weather (ground temperatures) for an exact match with the browser model.
// Ambiguities resolved here (CONTRACT: "pick the simplest reading and write the choice at the top"):
// - "Q_int: mean internal gains (schedule handled by profile)" is read as the mean over the profile's usage hours
//   (what rc5.js and the archetype data do), not as a 24 h mean, for non-residential uses.

import { monthlyMeanTemps, groundTemperatures, startWeekday, isLeapYear } from './epw.js';
import { daysOff, dateOf, TMY_YEAR } from './holidays.js';

export const IDF_VERSION = '24.2';

// EN ISO 6946 surface resistances (m²K/W) used to turn a BModel U-value into layer resistances.
export const FILMS = {
  wall: { rsi: 0.13, rse: 0.04 },     // exterior wall, horizontal heat flow
  roof: { rsi: 0.10, rse: 0.04 },     // roof to outdoors, heat flow upwards
  attic: { rsi: 0.10, rse: 0.10 },    // top ceiling to an unheated attic (internal resistances on both sides)
  basement: { rsi: 0.17, rse: 0.17 }, // floor to an unheated basement, heat flow downwards
  slab: { rsi: 0.17, rse: 0.04 },     // slab on ground with the F-factor buffer (U as tabulated incl. Rse 0.04)
  ground: { rsi: 0.17, rse: 0.0 },    // slab with EnergyPlus 'Ground' boundary (no outside film in EnergyPlus)
};
export const MASS_MATERIAL = { conductivity: 2.0, density: 2300, specificHeat: 1000 }; // normal concrete
export const INTFLOOR_R = 0.20;   // core resistance of inter-storey floors (m²K/W), not in the BModel
export const PARTYWALL_R = 0.30;  // core resistance of party walls (adiabatic, only the mass matters)
export const E_SHIELD = 0.07;     // n_inf = e · n50 (DIN V 18599-2 / EN 13790, moderate shielding), as rc5.js
export const AIR_VOLUME_FACTOR = 0.8; // net air volume / external volume, as rc5.js
export const BASE_FRACTION = 0.1; // internal gains and ventilation outside operating hours (as rc5.js)
export const WINDOW = { sill: 0.9, height: 1.5, margin: 0.05 };

const RESIDENTIAL = new Set(['sfh', 'th', 'mfh', 'ab']);
// Operating hours when the caller does not pass opts.profile (pass archetype.js profileFor(usage) to match rc5.js).
export const DEFAULT_PROFILES = {
  office: { start: 7, end: 18, daysPerWeek: 5 },
  education: { start: 7, end: 18, daysPerWeek: 5 },
  retail: { start: 8, end: 20, daysPerWeek: 6 },
  other: { start: 7, end: 18, daysPerWeek: 5 },
};
const PARAM_DEFAULTS = {
  U_wall: 1.0, U_roof: 0.8, U_floor: 1.0, U_window: 2.8, g_window: 0.6, frameFrac: 0.3, dU_tb: 0.1, n50: 4,
  n_vent: 0.5, hr_eff: 0, T_heat: 20, setback: 2, T_cool: null, Q_int: 3, heatedFrac: 1, Cm: 165000,
  F_floor: 0.6, F_roof: 1.0,
};

// ───────────────────────────── small 2D geometry kit ─────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross3 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const lerp = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
const samePos = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

export function signedArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; s += p[0] * q[1] - q[0] * p[1]; }
  return s / 2;
}
function pointInRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function distPointSeg(p, a, b) {
  const d = sub(b, a), L2 = d[0] * d[0] + d[1] * d[1];
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2)) : 0;
  return dist(p, lerp(a, b, t));
}
// Remove the closing duplicate and points closer than tol to their predecessor; optionally collinear points.
function cleanRing(ring, { tol = 0.01, collinear = false } = {}) {
  let pts = (ring || []).map((p) => [+p[0], +p[1]]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < tol) pts.pop();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      if (dist(a, b) < tol) { pts.splice(i, 1); changed = true; break; }
      if (collinear) {
        const lac = dist(a, c);
        if (lac > 0 && Math.abs(cross3(a, b, c)) / lac < 1e-3) { pts.splice(i, 1); changed = true; break; }
      }
    }
  }
  return pts;
}
const orientRing = (r, ccw) => ((signedArea(r) > 0) === ccw ? r.slice() : r.slice().reverse());

// Convex decomposition of a polygon with holes. outer CCW, holes CW → array of CCW convex polygons.
// convex: false merges the convex pieces further into as few simple (hole-free, possibly non-convex) polygons as
// the greedy edge merge finds: a footprint without holes becomes one polygon, a courtyard footprint two or three.
// Used for surfaces that are neither sunlit nor shading (floors, interior ceilings), where EnergyPlus does not
// need convexity.
export function convexDecompose(outer, holes = [], { convex = true } = {}) {
  let poly = outer.map((p) => [p[0], p[1]]);
  const hs = holes.filter((h) => h.length >= 3).map((h) => h.map((p) => [p[0], p[1]]));
  hs.sort((A, B) => Math.max(...B.map((p) => p[0])) - Math.max(...A.map((p) => p[0])));
  for (const h of hs) poly = bridgeHole(poly, h);
  const tris = earClip(poly).filter((t) => Math.abs(signedArea(t)) > 1e-9);
  let pcs = mergeConvex(tris);
  if (!convex) pcs = mergeConvex(pcs, false);
  return pcs.map((p) => cleanRing(p, { tol: 1e-6, collinear: true })).filter((p) => p.length >= 3 && signedArea(p) > 1e-6);
}
function isReflexAt(poly, j) {
  const n = poly.length;
  return cross3(poly[(j - 1 + n) % n], poly[j], poly[(j + 1) % n]) < 0;
}
function inCone(poly, j, M) {
  const n = poly.length, a = poly[(j - 1 + n) % n], v = poly[j], b = poly[(j + 1) % n];
  if (cross3(a, v, b) >= 0) return cross3(a, v, M) > 0 && cross3(v, b, M) > 0;
  return cross3(a, v, M) > 0 || cross3(v, b, M) > 0;
}
function bridgeHole(poly, hole) {
  let mi = 0;
  for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[mi][0] || (hole[i][0] === hole[mi][0] && hole[i][1] < hole[mi][1])) mi = i;
  const M = hole[mi], n = poly.length;
  let best = null;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    if ((p[1] > M[1]) === (q[1] > M[1])) continue;
    const x = p[0] + ((M[1] - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
    if (x < M[0] - 1e-9) continue;
    if (!best || x < best.x) best = { x, i };
  }
  if (!best) throw new Error('convexDecompose: hole is not inside the outer ring');
  const p = poly[best.i], q = poly[(best.i + 1) % n], I = [best.x, M[1]];
  let Pi;
  if (dist(I, p) < 1e-9) Pi = best.i;
  else if (dist(I, q) < 1e-9) Pi = (best.i + 1) % n;
  else {
    Pi = p[0] > q[0] ? best.i : (best.i + 1) % n;
    const P = poly[Pi];
    const tri = cross3(M, I, P) > 0 ? [M, I, P] : [M, P, I];
    let cand = null, bestAng = Infinity, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === Pi || !isReflexAt(poly, j)) continue;
      const R = poly[j];
      if (cross3(tri[0], tri[1], R) >= -1e-12 && cross3(tri[1], tri[2], R) >= -1e-12 && cross3(tri[2], tri[0], R) >= -1e-12) {
        const ang = Math.atan2(Math.abs(R[1] - M[1]), R[0] - M[0]), d = dist(M, R);
        if (ang < bestAng - 1e-12 || (Math.abs(ang - bestAng) <= 1e-12 && d < bestD)) { bestAng = ang; bestD = d; cand = j; }
      }
    }
    if (cand != null) Pi = cand;
  }
  // a bridge vertex can appear twice (earlier bridges): take the copy whose interior cone contains M
  for (let j = 0; j < n; j++) if (j !== Pi && samePos(poly[j], poly[Pi]) && inCone(poly, j, M) && !inCone(poly, Pi, M)) { Pi = j; break; }
  const out = poly.slice(0, Pi + 1);
  for (let j = 0; j <= hole.length; j++) out.push(hole[(mi + j) % hole.length]);
  out.push(poly[Pi]);
  for (let j = Pi + 1; j < n; j++) out.push(poly[j]);
  return out;
}
function earClip(poly) {
  const idx = poly.map((_, i) => i), tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    const n = idx.length;
    let done = false;
    for (let s = 0; s < n && !done; s++) {
      const a = poly[idx[(s - 1 + n) % n]], b = poly[idx[s]], c = poly[idx[(s + 1) % n]];
      const cr = cross3(a, b, c);
      if (Math.abs(cr) < 1e-10 && (dist(a, c) < 1e-9 || (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0)) {
        idx.splice(s, 1); done = true; break; // collinear vertex or zero-width spike: drop without a triangle
      }
      if (cr <= 0) continue;
      let ok = true;
      for (let t = 0; t < n && ok; t++) {
        const p = poly[idx[t]];
        if (samePos(p, a) || samePos(p, b) || samePos(p, c)) continue;
        if (cross3(a, b, p) >= -1e-12 && cross3(b, c, p) >= -1e-12 && cross3(c, a, p) >= -1e-12) ok = false;
      }
      if (!ok) continue;
      tris.push([a, b, c]); idx.splice(s, 1); done = true;
    }
    if (!done) { // degenerate input: clip the most convex vertex to guarantee progress
      let bs = 0, bc = -Infinity;
      for (let s = 0; s < n; s++) {
        const cr = cross3(poly[idx[(s - 1 + n) % n]], poly[idx[s]], poly[idx[(s + 1) % n]]);
        if (cr > bc) { bc = cr; bs = s; }
      }
      if (bc > 0) tris.push([poly[idx[(bs - 1 + n) % n]], poly[idx[bs]], poly[idx[(bs + 1) % n]]]);
      idx.splice(bs, 1);
    }
  }
  if (idx.length === 3) tris.push(idx.map((i) => poly[i]));
  return tris;
}
function isConvex(p) {
  const n = p.length;
  for (let i = 0; i < n; i++) if (cross3(p[i], p[(i + 1) % n], p[(i + 2) % n]) < -1e-9) return false;
  return true;
}
function mergeConvex(tris, convexOnly = true) {
  const key = (p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
  const pieces = new Map();
  const edges = new Map(); // "ku>kv" → piece id
  let nextId = 0;
  const add = (poly) => {
    const id = nextId++;
    pieces.set(id, poly);
    for (let i = 0; i < poly.length; i++) edges.set(key(poly[i]) + '>' + key(poly[(i + 1) % poly.length]), id);
    return id;
  };
  const remove = (id) => {
    const poly = pieces.get(id);
    for (let i = 0; i < poly.length; i++) {
      const k = key(poly[i]) + '>' + key(poly[(i + 1) % poly.length]);
      if (edges.get(k) === id) edges.delete(k);
    }
    pieces.delete(id);
  };
  tris.forEach(add);
  const diagonals = [];
  for (const k of edges.keys()) { const [u, v] = k.split('>'); if (u < v && edges.has(v + '>' + u)) diagonals.push([u, v]); }
  for (const [u, v] of diagonals) {
    const A = edges.get(u + '>' + v), B = edges.get(v + '>' + u);
    if (A == null || B == null || A === B) continue;
    const pa = pieces.get(A), pb = pieces.get(B);
    const ia = pa.findIndex((p, i) => key(p) === u && key(pa[(i + 1) % pa.length]) === v);
    const ib = pb.findIndex((p, i) => key(p) === v && key(pb[(i + 1) % pb.length]) === u);
    if (ia < 0 || ib < 0) continue;
    const ra = [...pa.slice(ia + 1), ...pa.slice(0, ia + 1)]; // v … u
    const rb = [...pb.slice(ib + 1), ...pb.slice(0, ib + 1)]; // u … v
    const merged = ra.concat(rb.slice(1, -1));
    if (convexOnly ? !isConvex(merged) : new Set(merged.map(key)).size !== merged.length) continue; // simple: no pinch vertex
    remove(A); remove(B); add(merged);
  }
  return [...pieces.values()];
}

// ───────────────────────────── formatting helpers ─────────────────────────────
function num(x, dp = 6) {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`buildIDF: non-finite number ${x}`);
  const v = +x.toFixed(dp);
  return String(Object.is(v, -0) ? 0 : v);
}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 100);
// Comments are kept ASCII (non-ASCII written as \uXXXX) so the file is safe for every EnergyPlus front end.
function asciiText(s, utf8 = false) {
  const t = String(s ?? '').replace(/[\r\n]+/g, ' ');
  return utf8 ? t : t.replace(/[^\x20-\x7E]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`;

class IdfWriter {
  constructor() { this.out = []; }
  comment(line = '') { this.out.push(line ? '! ' + line : '!'); }
  blank() { this.out.push(''); }
  // fields: array of [value, comment] or plain values; value: number | string
  obj(cls, fields) {
    const lines = [cls + ','];
    fields.forEach((f, i) => {
      const [v, c] = Array.isArray(f) ? f : [f, ''];
      const s = typeof v === 'number' ? num(v) : String(v ?? '');
      if (/[,;!]/.test(s)) throw new Error(`buildIDF: illegal character in field "${s}" of ${cls}`);
      const term = i === fields.length - 1 ? ';' : ',';
      const body = '  ' + s + term;
      lines.push(c ? body.padEnd(34) + '!- ' + c : body);
    });
    this.out.push(lines.join('\n'));
  }
  // BuildingSurface-style vertex list appended after the scalar fields
  objWithVertices(cls, fields, verts) {
    const vf = [];
    verts.forEach((v, i) => { vf.push([num(v[0]), '']); vf.push([num(v[1]), '']); vf.push([num(v[2]), `Vertex ${i + 1} X,Y,Z {m}`]); });
    const all = [...fields, [verts.length, 'Number of Vertices']];
    const lines = [cls + ','];
    all.forEach(([v, c]) => {
      const s = typeof v === 'number' ? num(v) : String(v ?? '');
      if (/[,;!]/.test(s)) throw new Error(`buildIDF: illegal character in field "${s}" of ${cls}`);
      lines.push(('  ' + s + ',').padEnd(34) + (c ? '!- ' + c : ''));
    });
    for (let i = 0; i < verts.length; i++) {
      const term = i === verts.length - 1 ? ';' : ',';
      lines.push(('  ' + vf[3 * i][0] + ', ' + vf[3 * i + 1][0] + ', ' + vf[3 * i + 2][0] + term).padEnd(34) + '!- ' + vf[3 * i + 2][1]);
    }
    this.out.push(lines.map((l) => l.trimEnd()).join('\n'));
  }
  toString() { return this.out.join('\n') + '\n'; }
}

// ───────────────────────────── planning ─────────────────────────────
function readParams(bm, warnings) {
  const p = {}, src = {};
  const params = bm.params || {};
  for (const [k, d] of Object.entries(PARAM_DEFAULTS)) {
    const e = params[k];
    let v = e && typeof e === 'object' && 'value' in e ? e.value : e;
    if (k === 'F_floor' && (e == null)) v = bm.basement === 'unheated' ? 0.6 : 0.5;
    if (k === 'F_roof' && (e == null)) v = bm.roof && bm.roof.attic === 'unheated' ? 0.8 : 1.0;
    if (v == null && k !== 'T_cool' && !(k === 'F_floor' || k === 'F_roof')) { warnings.push(`param ${k} missing → default ${d}`); v = d; }
    if (k !== 'T_cool' && (typeof v !== 'number' || !Number.isFinite(v))) { warnings.push(`param ${k}=${v} invalid → default ${d}`); v = d; }
    if (k === 'T_cool' && v != null && !Number.isFinite(v)) { warnings.push(`param T_cool=${v} invalid → no cooling`); v = null; }
    p[k] = v; src[k] = e && e.source ? e.source : 'default(export)';
  }
  return { p, src };
}

function normaliseSegments(fac, L, reversed) {
  let segs = (fac && Array.isArray(fac.segments) && fac.segments.length ? fac.segments : [{ t0: 0, t1: 1, exposed: true, neighborHeight: null }])
    .map((s) => ({ t0: +s.t0, t1: +s.t1, exposed: s.exposed !== false, nh: Number.isFinite(s.neighborHeight) ? s.neighborHeight : null }))
    .map((s) => (reversed ? { ...s, t0: 1 - s.t1, t1: 1 - s.t0 } : s))
    .map((s) => ({ ...s, t0: Math.max(0, Math.min(1, s.t0)), t1: Math.max(0, Math.min(1, s.t1)) }))
    .filter((s) => s.t1 > s.t0)
    .sort((a, b) => a.t0 - b.t0);
  // fill gaps (treated as exposed) and drop overlaps
  const full = [];
  let t = 0;
  for (const s of segs) {
    if (s.t0 > t + 1e-6) full.push({ t0: t, t1: s.t0, exposed: true, nh: null });
    const t0 = Math.max(t, s.t0);
    if (s.t1 > t0) full.push({ ...s, t0 });
    t = Math.max(t, s.t1);
  }
  if (t < 1 - 1e-6) full.push({ t0: t, t1: 1, exposed: true, nh: null });
  // merge pieces shorter than 0.05 m into a neighbour, then merge equal neighbours
  const minT = 0.05 / Math.max(L, 1e-9);
  let out = full;
  for (let guard = 0; guard < 50; guard++) {
    const i = out.findIndex((s) => s.t1 - s.t0 < minT);
    if (i < 0 || out.length === 1) break;
    const j = i > 0 ? i - 1 : i + 1;
    const lo = Math.min(i, j);
    const keep = out[j];
    out.splice(lo, 2, { ...keep, t0: out[lo].t0, t1: out[lo + 1].t1 });
  }
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.exposed === s.exposed && last.nh === s.nh) last.t1 = s.t1;
    else merged.push({ ...s });
  }
  return merged;
}

// Window rectangle in wall-local coordinates (u along the wall from P, z from the piece bottom).
function fitWindow(L, H, A) {
  const m = WINDOW.margin;
  const Wmax = L - 2 * m, Hmax = H - 2 * m;
  if (Wmax < 0.1 || Hmax < 0.1 || A < 0.02) return null;
  A = Math.min(A, Wmax * Hmax);
  let sill = WINDOW.sill, hw;
  if (H - sill - m >= 0.3) hw = Math.min(WINDOW.height, H - sill - m);
  else { sill = m; hw = Math.min(WINDOW.height, Hmax); }
  let w = A / hw;
  if (w > Wmax) {
    w = Wmax; hw = A / w;
    if (sill + hw > H - m) sill = Math.max(m, H - m - hw);
    if (hw > Hmax) hw = Hmax;
  }
  const u0 = (L - w) / 2;
  return { u0, u1: u0 + w, zb: sill, zt: sill + hw, area: w * hw };
}

export function planIDF(bm, opts = {}) {
  const o = {
    maxExplicitStoreys: 10, groundModel: 'ffactor', exposeAboveNeighbor: true, scheduleConvention: 'rc5',
    includeNeighbors: true, elevation: 520, timeZone: 1, groundDepth: 2.0,
    timestepsPerHour: 4, shadowUpdateDays: 20, maxShadowFigures: 15000, polygonClipping: 'SutherlandHodgman', ...opts,
  };
  const warnings = [];
  if (o.scheduleConvention === 'contract') o.scheduleConvention = 'dailyMean';
  if (bm.heated === false) warnings.push('BModel is marked as unheated (heated=false); exported with heating anyway');
  const { p, src } = readParams(bm, warnings);
  const usage = bm.usage || 'mfh';
  const residential = RESIDENTIAL.has(usage);

  // rings (walls use the rings as given, horizontal polygons additionally drop collinear points)
  const outer = orientRing(cleanRing(bm.outer), true);
  if (outer.length < 3) throw new Error('buildIDF: footprint needs at least 3 points');
  const holes = (bm.holes || []).map((h) => orientRing(cleanRing(h), false)).filter((h) => h.length >= 3 && Math.abs(signedArea(h)) > 0.05);
  const rings = [outer, ...holes];
  const hOuter = orientRing(cleanRing(outer, { collinear: true }), true);
  const hHoles = holes.map((h) => orientRing(cleanRing(h, { collinear: true }), false)).filter((h) => h.length >= 3);
  const pieces = convexDecompose(hOuter, hHoles);           // sunlit roofs: convex (EnergyPlus shading)
  // floors and interior ceilings are not sunlit and cast no shadow: simple polygons are enough, which removes most of
  // the horizontal surfaces of complex footprints (heat-balance cost) — opts.convexFloors = true keeps convex pieces
  const fpieces = o.convexFloors ? pieces : convexDecompose(hOuter, hHoles, { convex: false });
  const A_fp = pieces.reduce((s, q) => s + signedArea(q), 0);
  const A_fp2 = fpieces.reduce((s, q) => s + signedArea(q), 0);
  const A_fp_ref = signedArea(hOuter) + hHoles.reduce((s, h) => s + signedArea(h), 0);
  if (Math.abs(A_fp - A_fp_ref) > 0.001 * A_fp_ref + 0.01) warnings.push(`roof decomposition area ${A_fp.toFixed(2)} ≠ footprint ${A_fp_ref.toFixed(2)} m²`);
  if (Math.abs(A_fp2 - A_fp_ref) > 0.001 * A_fp_ref + 0.01) warnings.push(`floor decomposition area ${A_fp2.toFixed(2)} ≠ footprint ${A_fp_ref.toFixed(2)} m²`);

  const nF = Math.max(1, Math.round(bm.floors || 1));
  const H = Number.isFinite(bm.height) && bm.height > 0 ? bm.height : nF * (bm.floorHeight || 3);
  const h = H / nF;
  if (bm.floorHeight && Math.abs(bm.floorHeight - h) > 0.02 * h) warnings.push(`floorHeight ${bm.floorHeight} ≠ height/floors ${h.toFixed(2)}; using height/floors`);

  // zones
  const pad = (k) => String(k).padStart(2, '0');
  const zones = [];
  if (nF <= o.maxExplicitStoreys) {
    for (let k = 0; k < nF; k++) zones.push({ name: `S${pad(k + 1)}`, k, z0: k * h, z1: (k + 1) * h, Z0: k * h, Z1: (k + 1) * h, mult: 1, storeys: `${k + 1}` });
  } else {
    const km = Math.floor((nF - 1) / 2);
    zones.push({ name: 'S01', k: 0, z0: 0, z1: h, Z0: 0, Z1: h, mult: 1, storeys: '1' });
    zones.push({ name: `S${pad(2)}_S${pad(nF - 1)}_x${nF - 2}`, k: km, z0: km * h, z1: (km + 1) * h, Z0: h, Z1: (nF - 1) * h, mult: nF - 2, storeys: `2-${nF - 1} (geometry of storey ${km + 1})` });
    zones.push({ name: `S${pad(nF)}`, k: nF - 1, z0: (nF - 1) * h, z1: H, Z0: (nF - 1) * h, Z1: H, mult: 1, storeys: `${nF}` });
  }
  const interzone = zones.every((z) => z.mult === 1);

  // facade lookup by edge end points
  const facades = Array.isArray(bm.facades) ? bm.facades : [];
  const fkey = (a, b) => `${(+a[0]).toFixed(2)},${(+a[1]).toFixed(2)}|${(+b[0]).toFixed(2)},${(+b[1]).toFixed(2)}`;
  const fmap = new Map();
  for (const f of facades) if (f.a && f.b) fmap.set(fkey(f.a, f.b), f);
  const findFacade = (a, b) => {
    let f = fmap.get(fkey(a, b));
    if (f) return { f, reversed: false };
    f = fmap.get(fkey(b, a));
    if (f) return { f, reversed: true };
    for (const g of facades) {
      if (!g.a || !g.b) continue;
      if (dist(g.a, a) < 0.05 && dist(g.b, b) < 0.05) return { f: g, reversed: false };
      if (dist(g.a, b) < 0.05 && dist(g.b, a) < 0.05) return { f: g, reversed: true };
    }
    return null;
  };

  // walls: edges × segments, then per zone
  const edgeList = [];
  rings.forEach((ring, ri) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], L = dist(a, b);
      if (L < 0.02) continue;
      const az = ((Math.atan2(b[1] - a[1], -(b[0] - a[0])) * 180) / Math.PI + 360) % 360; // right-hand normal (dy, −dx)
      const hit = findFacade(a, b);
      const fid = hit ? safeName(hit.f.id) : `E${ri}_${i}`;
      if (hit && Number.isFinite(hit.f.azimuth)) {
        const d = Math.abs(((hit.f.azimuth - az + 540) % 360) - 180);
        if (d > 5) warnings.push(`facade ${fid}: BModel azimuth ${hit.f.azimuth}° vs geometry ${az.toFixed(1)}°`);
      }
      const segs = normaliseSegments(hit && hit.f, L, hit && hit.reversed);
      edgeList.push({ ring: ri, i, a, b, L, az, fid, wwr: hit && Number.isFinite(hit.f.wwr) ? Math.max(0, Math.min(0.95, hit.f.wwr)) : 0, segs, gap: !hit });
    }
  });

  const surfaces = [], windows = [];
  const tolH = 0.1;
  for (const z of zones) {
    for (const e of edgeList) {
      const pieces2 = [];
      e.segs.forEach((s, si) => {
        const P = lerp(e.a, e.b, s.t0), Q = lerp(e.a, e.b, s.t1), Ls = dist(P, Q);
        const base = { zone: z.name, mult: z.mult, facade: e.fid, az: e.az, P, Q, L: Ls };
        const nm = `${z.name}_${e.fid}_s${si}`;
        if (s.exposed) { pieces2.push({ ...base, name: nm + '_W', kind: e.gap ? 'gap' : 'exposed', bc: 'Outdoors', z0: z.z0, z1: z.z1 }); return; }
        const nh = s.nh;
        let f = 0; // exposed fraction above the neighbour over the represented span
        if (o.exposeAboveNeighbor && nh != null) f = Math.max(0, Math.min(1, (z.Z1 - Math.max(z.Z0, nh)) / (z.Z1 - z.Z0)));
        const zs = z.z0 + (1 - f) * (z.z1 - z.z0);
        if (zs - z.z0 < tolH && f > 0) pieces2.push({ ...base, name: nm + '_W', kind: 'firewall', bc: 'Outdoors', z0: z.z0, z1: z.z1 });
        else if (z.z1 - zs < tolH) pieces2.push({ ...base, name: nm + '_W', kind: 'party', bc: 'Adiabatic', z0: z.z0, z1: z.z1 });
        else {
          pieces2.push({ ...base, name: nm + '_Wlo', kind: 'party', bc: 'Adiabatic', z0: z.z0, z1: zs });
          pieces2.push({ ...base, name: nm + '_Whi', kind: 'firewall', bc: 'Outdoors', z0: zs, z1: z.z1 });
        }
      });
      for (const w of pieces2) {
        w.type = 'Wall';
        w.verts = [[w.P[0], w.P[1], w.z1], [w.P[0], w.P[1], w.z0], [w.Q[0], w.Q[1], w.z0], [w.Q[0], w.Q[1], w.z1]];
        w.area = w.L * (w.z1 - w.z0);
        surfaces.push(w);
      }
      // windows: wwr × Outdoors area of this facade in this zone, on fully exposed pieces first
      const out = pieces2.filter((w) => w.bc === 'Outdoors' && w.kind !== 'gap');
      let need = e.wwr * out.reduce((s, w) => s + w.area, 0);
      if (need < 0.02) continue;
      const target = need;
      for (const tier of [['exposed'], ['firewall']]) {
        const cand = out.filter((w) => tier.includes(w.kind));
        let pool = cand.reduce((s, w) => s + w.area, 0);
        for (const w of cand) {
          if (need < 0.02 || pool <= 0) break;
          const share = (need * w.area) / pool;
          pool -= w.area;
          const fit = fitWindow(w.L, w.z1 - w.z0, share);
          if (!fit) continue;
          const dir = [(w.Q[0] - w.P[0]) / w.L, (w.Q[1] - w.P[1]) / w.L];
          const U0 = [w.P[0] + dir[0] * fit.u0, w.P[1] + dir[1] * fit.u0], U1 = [w.P[0] + dir[0] * fit.u1, w.P[1] + dir[1] * fit.u1];
          const zb = w.z0 + fit.zb, zt = w.z0 + fit.zt;
          windows.push({
            name: w.name + '_Win', base: w.name, zone: w.zone, mult: w.mult, facade: w.facade, area: fit.area,
            verts: [[U0[0], U0[1], zt], [U0[0], U0[1], zb], [U1[0], U1[1], zb], [U1[0], U1[1], zt]],
          });
          need -= fit.area;
        }
      }
      if (need > 0.01 * target + 0.02) warnings.push(`${z.name} ${e.fid}: ${need.toFixed(2)} m² of window area did not fit (wwr too high for the wall)`);
    }
  }

  // horizontal surfaces
  const groundOSC = o.groundModel !== 'ground' || bm.basement === 'unheated';
  const atticOSC = bm.roof && bm.roof.attic === 'unheated';
  const atticHeated = bm.roof && bm.roof.attic === 'heated';
  zones.forEach((z, zi) => {
    fpieces.forEach((pc, pi) => {
      const fl = { zone: z.name, mult: z.mult, type: 'Floor', name: `${z.name}_Floor_${pi}`, verts: pc.slice().reverse().map((q) => [q[0], q[1], z.z0]), area: signedArea(pc) };
      if (zi === 0) { fl.kind = 'groundfloor'; fl.bc = groundOSC ? 'OtherSideCoefficients' : 'Ground'; fl.bcObj = groundOSC ? 'OSC_GroundFloor' : ''; }
      else if (interzone) { fl.kind = 'intfloor'; fl.bc = 'Surface'; fl.bcObj = `${zones[zi - 1].name}_Ceil_${pi}`; }
      else { fl.kind = 'intfloor'; fl.bc = 'Adiabatic'; }
      surfaces.push(fl);
    });
    const top = zi === zones.length - 1;
    // sunlit roofs keep convex pieces; the top ceiling to an unheated attic (OSC, no sun) and interior ceilings do not
    (top && !atticOSC ? pieces : fpieces).forEach((pc, pi) => {
      const cl = { zone: z.name, mult: z.mult, verts: pc.map((q) => [q[0], q[1], z.z1]), area: signedArea(pc) };
      if (top) Object.assign(cl, { type: 'Roof', name: `${z.name}_Roof_${pi}`, kind: 'roof', bc: atticOSC ? 'OtherSideCoefficients' : 'Outdoors', bcObj: atticOSC ? 'OSC_Attic' : '' });
      else if (interzone) Object.assign(cl, { type: 'Ceiling', name: `${z.name}_Ceil_${pi}`, kind: 'intceiling', bc: 'Surface', bcObj: `${zones[zi + 1].name}_Floor_${pi}` });
      else Object.assign(cl, { type: 'Ceiling', name: `${z.name}_Ceil_${pi}`, kind: 'intceiling', bc: 'Adiabatic' });
      surfaces.push(cl);
    });
  });

  // areas for the envelope policy (all × zone multiplier)
  const sumA = (arr, pred) => arr.filter(pred).reduce((s, x) => s + x.area * x.mult, 0);
  const A_wallOut = sumA(surfaces, (s) => s.type === 'Wall' && s.bc === 'Outdoors');
  const A_party = sumA(surfaces, (s) => s.type === 'Wall' && s.bc === 'Adiabatic');
  const A_win = windows.reduce((s, w) => s + w.area * w.mult, 0);
  const A_roof = sumA(surfaces, (s) => s.kind === 'roof');
  const A_gf = sumA(surfaces, (s) => s.kind === 'groundfloor');
  const areasBM = bm.areas || {};
  const rf = atticHeated && A_roof > 0 && areasBM.roof > A_roof ? areasBM.roof / A_roof : 1; // sloped / flat roof area
  const A_envTarget = A_wallOut + rf * A_roof + A_gf;
  const A_opqModel = A_wallOut - A_win + A_roof + A_gf;
  const kTB = A_opqModel > 0 ? A_envTarget / A_opqModel : 1;
  const dU = Math.max(0, p.dU_tb);
  const Fr = atticOSC ? Math.max(0.05, p.F_roof) : 1, Ff = groundOSC ? Math.max(0.05, p.F_floor) : 1;
  if (!atticOSC && Math.abs(p.F_roof - 1) > 1e-6) warnings.push(`F_roof=${p.F_roof} ignored: roof is exposed to outdoors (no unheated attic)`);
  if (!groundOSC) warnings.push(`F_floor=${p.F_floor} not used: slab coupled to Site:GroundTemperature:BuildingSurface (groundModel 'ground')`);
  const Ueff = {
    wall: p.U_wall + dU * kTB,
    roof: p.U_roof * rf + (dU * kTB) / Fr,
    floor: p.U_floor + (dU * kTB) / Ff,
  };

  // mass layer thickness
  const A_net = areasBM.netFloor > 0 ? areasBM.netFloor : 0.85 * A_fp * nF;
  const A_faces = (A_wallOut - A_win) + A_party + sumA(surfaces, (s) => s.type !== 'Wall');
  const rc = MASS_MATERIAL.density * MASS_MATERIAL.specificHeat;
  let dMass = (p.Cm * A_net) / (rc * Math.max(A_faces, 1e-6));
  if (dMass < 0.005 || dMass > 0.25) { warnings.push(`mass layer thickness ${dMass.toFixed(3)} m clipped to [0.005, 0.25]`); dMass = Math.min(0.25, Math.max(0.005, dMass)); }
  const Rmass = dMass / MASS_MATERIAL.conductivity;

  // constructions: {name, layers:[material names], element, films, Utarget}
  const materials = [], constructions = [];
  materials.push({ cls: 'Material', name: 'BM_Mass', roughness: 'MediumRough', thickness: dMass, ...MASS_MATERIAL, abs: [0.9, 0.6, 0.6] });
  const opaque = (cname, element, U, films, solarAbs) => {
    let R = 1 / U - films.rsi - films.rse - Rmass;
    let layers = [cname + '_R', 'BM_Mass'];
    if (R < 0.001) {
      const room = 1 / U - films.rsi - films.rse - 0.001;
      if (room > 0.0005) {
        const d2 = room * MASS_MATERIAL.conductivity;
        materials.push({ cls: 'Material', name: cname + '_Mass', roughness: 'MediumRough', thickness: d2, ...MASS_MATERIAL, abs: [0.9, 0.6, 0.6] });
        layers = [cname + '_R', cname + '_Mass'];
        R = 0.001;
        warnings.push(`${cname}: U=${U.toFixed(3)} leaves no room for the full mass layer; thinner mass layer ${d2.toFixed(4)} m used`);
      } else {
        R = 0.001; layers = [cname + '_R'];
        warnings.push(`${cname}: U=${U.toFixed(3)} exceeds 1/(Rsi+Rse); construction capped (U ≈ ${(1 / (films.rsi + films.rse + 0.001)).toFixed(2)})`);
      }
    }
    materials.push({ cls: 'Material:NoMass', name: cname + '_R', roughness: 'MediumRough', R, abs: [0.9, solarAbs, solarAbs] });
    constructions.push({ name: cname, layers, element, films, Utarget: U });
  };
  opaque('BM_Wall', 'wall', Ueff.wall, FILMS.wall, 0.5);
  opaque(atticOSC ? 'BM_AtticCeiling' : 'BM_Roof', atticOSC ? 'attic' : 'roof', Ueff.roof, atticOSC ? FILMS.attic : FILMS.roof, 0.6);
  const gFilms = groundOSC ? (bm.basement === 'unheated' ? FILMS.basement : FILMS.slab) : FILMS.ground;
  opaque(groundOSC && bm.basement === 'unheated' ? 'BM_BasementCeiling' : 'BM_GroundFloor', 'floor', Ueff.floor, gFilms, 0.6);
  materials.push({ cls: 'Material:NoMass', name: 'BM_PartyWall_R', roughness: 'MediumRough', R: PARTYWALL_R, abs: [0.9, 0.6, 0.6] });
  constructions.push({ name: 'BM_PartyWall', layers: ['BM_PartyWall_R', 'BM_Mass'], element: 'party' });
  materials.push({ cls: 'Material:NoMass', name: 'BM_IntFloor_R', roughness: 'MediumRough', R: INTFLOOR_R, abs: [0.9, 0.6, 0.6] });
  constructions.push({ name: 'BM_IntFloor', layers: ['BM_Mass', 'BM_IntFloor_R', 'BM_Mass'], element: 'intfloor' });
  let Uw = p.U_window;
  if (Uw > 7 || Uw < 0.3) { warnings.push(`U_window ${Uw} outside the SimpleGlazingSystem range, clipped to [0.3, 7]`); Uw = Math.min(7, Math.max(0.3, Uw)); }
  const shgc = Math.min(0.95, Math.max(0.02, p.g_window * (1 - Math.max(0, Math.min(0.9, p.frameFrac)))));
  materials.push({ cls: 'WindowMaterial:SimpleGlazingSystem', name: 'BM_Glazing', U: Uw, shgc });
  constructions.push({ name: 'BM_Window', layers: ['BM_Glazing'], element: 'window' });

  const cons = {
    wall: 'BM_Wall', party: 'BM_PartyWall', roof: atticOSC ? 'BM_AtticCeiling' : 'BM_Roof', intfloor: 'BM_IntFloor',
    floor: groundOSC && bm.basement === 'unheated' ? 'BM_BasementCeiling' : 'BM_GroundFloor', window: 'BM_Window',
  };
  for (const s of surfaces) {
    if (s.type === 'Wall') s.construction = s.bc === 'Adiabatic' ? cons.party : cons.wall;
    else if (s.kind === 'roof') s.construction = cons.roof;
    else if (s.kind === 'groundfloor') s.construction = cons.floor;
    else s.construction = cons.intfloor;
    const out = s.bc === 'Outdoors';
    s.sun = out ? 'SunExposed' : 'NoSun';
    s.wind = out ? 'WindExposed' : 'NoWind';
    if (s.bcObj == null) s.bcObj = '';
  }

  // operation
  const prof = residential ? { start: 0, end: 24, daysPerWeek: 7 } : { ...(DEFAULT_PROFILES[usage] || DEFAULT_PROFILES.office), ...(o.profile || {}) };
  const hoursOn = Math.max(0, Math.min(24, prof.end - prof.start));
  const occFrac = (hoursOn * Math.min(7, prof.daysPerWeek)) / 168;
  const meanFrac = residential ? 1 : occFrac + BASE_FRACTION * (1 - occFrac);
  const qintLevelPerM2 = residential || o.scheduleConvention !== 'dailyMean' ? p.Q_int : p.Q_int / meanFrac;
  const qintZone = (qintLevelPerM2 * A_net) / nF;
  const Tset = p.T_heat - (1 - Math.max(0, Math.min(1, p.heatedFrac))) * 4;
  let Tcool = p.T_cool;
  if (Tcool != null && Tcool < Tset + 1) { warnings.push(`T_cool ${Tcool} raised to T_set + 1 = ${(Tset + 1).toFixed(1)}`); Tcool = Tset + 1; }
  const nInf = E_SHIELD * p.n50;
  const winVent = !residential && !(p.hr_eff > 0);
  const nVent = winVent ? Math.max(0.1, (p.n_vent * 3 * A_net) / (AIR_VOLUME_FACTOR * (areasBM.volume > 0 ? areasBM.volume : A_fp * H)) - E_SHIELD * p.n50)
    : p.n_vent * (1 - Math.max(0, Math.min(1, p.hr_eff)));
  const ventOff = residential ? 1 : winVent ? 0.1 / nVent : BASE_FRACTION;   // fraction of the design flow outside operating hours
  const Ve = areasBM.volume > 0 ? areasBM.volume : A_fp * H;
  const zoneVolume = (AIR_VOLUME_FACTOR * Ve) / nF; // net air volume per storey: reference of all air flows
  // Air flows are written as Flow/Zone (m³/s) so that they do not depend on EnergyPlus' geometric zone volume
  // (Zone Volume = autocalculate; entering 0.8·V_e there triggers "Entered Zone Volumes differ" warnings).
  const infFlow = (nInf * zoneVolume) / 3600, ventFlow = (nVent * zoneVolume) / 3600;

  const asYear = (y) => (y != null && /^\d{4}$/.test(String(y).trim()) ? +y : null); // main.js passes '2023' / 'tmy'
  const year = asYear(o.year) ?? asYear(o.weather && o.weather.year);
  const monthly = monthlyMeanTemps(o.weather);
  const groundT = groundTemperatures(monthly, { depth: o.groundDepth });

  const summary = {
    zones: zones.length, storeys: nF, storeyHeight: h, interzone, pieces: pieces.length, floorPieces: fpieces.length, A_fp, A_wallOut, A_party, A_win, A_roof, A_gf,
    A_envTarget, A_opqModel, kTB, rf, Ueff, dMass, A_net, A_faces, Ve, zoneVolume, nInf, nVent, ventOff, winVent, infFlow, ventFlow, Tset, Tcool, qintLevelPerM2,
    qintZone, meanFrac, occFrac, profile: prof, residential, groundOSC, atticOSC, Fr, Ff, shgc, Uw, year, monthly, groundT,
  };
  return { bm, o, p, src, usage, residential, zones, surfaces, windows, materials, constructions, summary, warnings, shading: o.includeNeighbors ? buildShading(bm, rings, H, o, warnings) : { surfaces: [], stats: { neighbours: 0, of: (bm.neighbors || []).length, candidates: 0, skippedShared: 0 }, options: {} } };
}

// Neighbour context as Shading:Building:Detailed. EnergyPlus' shadow calculation cost grows with (receiving
// surfaces × shading surfaces), and every detached shading surface is also mirrored internally, so the set is pruned.
// Lossless steps (on by default; they do not change which sun rays are blocked) for neighbours that do not touch our
// footprint (distance ≥ 0.5 m; touching neighbours are written in full, since parts of our envelope may lie inside
// their prism, e.g. a low annex in front of a facade that the BModel marks as exposed):
//   - no roof pieces (opts.neighborRoofs = false): a ray from a point outside a neighbour prism towards the sun can
//     only enter it through a wall (points above the roof cannot be shaded by it at all), so with closed wall rings
//     the roofs never block an extra ray;
//   - front walls only (opts.frontWallsOnly): a ray crosses a wall plane once, so it can enter through a wall only if
//     it starts on the wall's outer side; walls with our whole footprint behind their plane are dropped;
//   - collinear consecutive walls of the same height range are merged (opts.mergeCollinear; ≤ 5 cm deviation);
//   - a neighbour wall on our own party wall keeps only the part above our eaves height (none if it is not taller),
//     and a wall shared by two neighbours keeps only the part of the taller one above the lower one (among the
//     neighbours that are finally written, opts.sharedAmongKept). Both keep the wall rings closed, which the
//     omission of roofs and back walls relies on.
// Lossy steps: walls < 0.3 m are dropped; neighbours beyond opts.shadingRadius or subtending less than
// opts.minShadingAltitude above our footprint are dropped; at most opts.maxShadingSurfaces surfaces are written
// (highest angular height first). The effect of the defaults on annual heating is quantified in qa/eplus_compare.md.
export const SHADING_DEFAULTS = {
  shadingRadius: 150, minShadingAltitude: 5, maxShadingSurfaces: 2000,
  neighborRoofs: false, frontWallsOnly: true, mergeCollinear: true, sharedAmongKept: true,
};
function buildShading(bm, ownRings, Hown, o, warnings) {
  const so = { ...SHADING_DEFAULTS };
  for (const k of Object.keys(SHADING_DEFAULTS)) if (o[k] != null) so[k] = o[k];
  const minAlt = so.minShadingAltitude * (Math.PI / 180), radius = so.shadingRadius, cap = so.maxShadingSurfaces;
  const segDist = (r1, r2) => {
    let d = Infinity;
    for (let i = 0; i < r1.length; i++) for (let j = 0; j < r2.length; j++) {
      d = Math.min(d, distPointSeg(r1[i], r2[j], r2[(j + 1) % r2.length]), distPointSeg(r2[j], r1[i], r1[(i + 1) % r1.length]));
    }
    return d;
  };
  const own = ownRings[0];
  const nbs = [];
  for (const nb of bm.neighbors || []) {
    const Hn = +nb.height;
    if (!Number.isFinite(Hn) || Hn <= 0.1) continue;
    const no = orientRing(cleanRing(nb.outer), true);
    if (no.length < 3) continue;
    const nh = (nb.holes || []).map((r) => orientRing(cleanRing(r), false)).filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 0.05);
    const inside = no.some((q) => pointInRing(q, own)) || own.some((q) => pointInRing(q, no));
    const d = inside ? 0 : segDist(no, own);
    if (d > radius || (d > 0 && Math.atan2(Hn, d) < minAlt)) continue;
    // touching neighbours (d < 0.5 m) can enclose parts of our envelope (e.g. a low annex in front of a facade that
    // the BModel marks as exposed); rays from there start inside their prism, so they keep roof and back walls
    nbs.push({ id: safeName(nb.id ?? 'nb'), Hn, rings: [no, ...nh], d, touch: d < 0.5, score: Math.atan2(Hn, Math.max(d, 0.5)) });
  }
  nbs.sort((a, b) => b.score - a.score);
  const ek = (a, b) => { const ka = `${a[0].toFixed(2)},${a[1].toFixed(2)}`, kb = `${b[0].toFixed(2)},${b[1].toFixed(2)}`; return ka < kb ? ka + '|' + kb : kb + '|' + ka; };
  const sharedMap = (idxs) => {
    const m = new Map();
    for (const ni of idxs) nbs[ni].rings.forEach((r) => r.forEach((a, i) => {
      const k = ek(a, r[(i + 1) % r.length]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ ni, H: nbs[ni].Hn });
    }));
    return m;
  };
  const onOwnEdge = (p, q) => ownRings.some((r) => r.some((u, i) => {
    const v = r[(i + 1) % r.length];
    return distPointSeg(p, u, v) < 0.1 && distPointSeg(q, u, v) < 0.1;
  }));
  // outward normal of a CCW outer ring / CW hole edge is the right-hand normal (dy, −dx)
  const facesUs = (a, b) => {
    const nx = b[1] - a[1], ny = -(b[0] - a[0]), L = Math.hypot(nx, ny);
    return own.some((q) => ((q[0] - a[0]) * nx + (q[1] - a[1]) * ny) / L > 0.01);
  };
  const stats = { skippedShared: 0, skippedBack: 0, merged: 0 };
  const surfacesOf = (ni, shared) => {
    const n = nbs[ni];
    const surf = [];
    n.rings.forEach((r, ri) => {
      let cur = null; // wall being extended along collinear edges
      const flush = () => { if (cur) surf.push({ name: `Shd_${n.id}_W${ri}_${cur.i}`, kind: 'nwall', verts: [[cur.a[0], cur.a[1], n.Hn], [cur.a[0], cur.a[1], cur.z0], [cur.b[0], cur.b[1], cur.z0], [cur.b[0], cur.b[1], n.Hn]] }); cur = null; };
      r.forEach((a, i) => {
        const b = r[(i + 1) % r.length];
        if (dist(a, b) < 0.3) { flush(); return; }
        // a wall on our own party wall is covered by our building up to our eaves height; a taller neighbour keeps
        // the part above it (rays from our roof enter its prism there; without it the ring would be open)
        const onOwn = onOwnEdge(a, b);
        if (onOwn && n.Hn <= Hown + 0.05) { flush(); return; }
        const others = (shared.get(ek(a, b)) || []).filter((e) => e.ni !== ni);
        const Hbelow = others.length ? Math.max(...others.map((e) => e.H)) : 0;
        // equal heights: the wall is interior to the block; keep it only once per pair if heights differ
        if (others.length && (Hbelow >= n.Hn - 0.05)) { stats.skippedShared++; flush(); return; }
        if (so.frontWallsOnly && !n.touch && !facesUs(a, b)) { stats.skippedBack++; flush(); return; }
        const z0 = Math.max(others.length ? Hbelow : 0, onOwn ? Hown : 0);
        if (cur && so.mergeCollinear && Math.abs(cur.z0 - z0) < 1e-6 && samePos(cur.b, a)) {
          const L = dist(cur.a, b), crossDev = L > 0 ? Math.abs(cross3(cur.a, b, a)) / L : Infinity;
          const along = (a[0] - cur.a[0]) * (b[0] - cur.a[0]) + (a[1] - cur.a[1]) * (b[1] - cur.a[1]);
          if (crossDev < 0.05 && along > 0 && along < L * L && (n.touch || !so.frontWallsOnly || facesUs(cur.a, b))) { cur.b = b; stats.merged++; return; }
        }
        flush();
        cur = { a, b, z0, i };
      });
      flush();
    });
    if (so.neighborRoofs || n.touch) {
      let pcs = [];
      try {
        pcs = convexDecompose(orientRing(cleanRing(n.rings[0], { collinear: true }), true), n.rings.slice(1).map((r) => orientRing(cleanRing(r, { collinear: true }), false)));
      } catch (e) { pcs = []; }
      pcs.forEach((pc, j) => surf.push({ name: `Shd_${n.id}_R${j}`, kind: 'nroof', verts: pc.map((q) => [q[0], q[1], n.Hn]) }));
    }
    return surf;
  };
  // pass 1: shared walls among all candidates, greedy selection under the cap (highest angular height first)
  const all = nbs.map((_, i) => i);
  let shared = sharedMap(all);
  let groups = all.map((ni) => ({ ni, surf: surfacesOf(ni, shared) }));
  const select = (gs) => { const keep = []; let nS = 0; for (const g of gs) { if (nS + g.surf.length > cap) continue; keep.push(g); nS += g.surf.length; } return keep; };
  let kept = select(groups);
  // pass 2: if neighbours were dropped, walls they shared with kept neighbours must be written again
  if (so.sharedAmongKept && kept.length < groups.length) {
    for (const k of Object.keys(stats)) stats[k] = 0;
    shared = sharedMap(kept.map((g) => g.ni));
    groups = kept.map((g) => ({ ni: g.ni, surf: surfacesOf(g.ni, shared) }));
    kept = select(groups);
  }
  const dropped = nbs.length - kept.length;
  const out = [];
  const used = new Set();
  for (const g of kept) for (const s of g.surf) { let nm = safeName(s.name), k = 1; while (used.has(nm)) nm = safeName(s.name) + '_' + k++; used.add(nm); out.push({ ...s, name: nm }); }
  if (dropped) warnings.push(`${dropped} low/distant neighbour(s) not written: shading surface cap ${cap} (opts.maxShadingSurfaces)`);
  return { surfaces: out, stats: { neighbours: kept.length, of: (bm.neighbors || []).length, candidates: nbs.length, ...stats }, options: so };
}

// ───────────────────────────── writing ─────────────────────────────
function fmtVal(v) {
  if (v == null) return 'n/a';
  if (typeof v === 'number') return Number.isFinite(v) ? String(+v.toPrecision(6)) : 'n/a';
  return String(v);
}
function fmtPrior(pr) {
  if (!pr || typeof pr !== 'object') return '';
  return ` | prior ${pr.dist}(${fmtVal(pr.a)}, ${fmtVal(pr.b)})`;
}

// Schedule:Compact day lines from [[untilHour, value], ...]
function dayFields(list) {
  const f = [];
  for (const [u, v] of list) { f.push(`Until: ${hhmm(u)}`); f.push(num(v, 4)); }
  return f;
}
function occupancyDays(prof) {
  const d = Math.min(7, Math.max(1, Math.round(prof.daysPerWeek)));
  if (d >= 7) return { on: 'AllDays', off: null };
  if (d === 6) return { on: 'Weekdays Saturday', off: 'AllOtherDays' };
  if (d === 5) return { on: 'Weekdays', off: 'AllOtherDays' };
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].slice(0, d);
  return { on: names.join(' '), off: 'AllOtherDays' };
}
function profileDay(prof, onVal, offVal) {
  const s = Math.max(0, Math.min(24, prof.start)), e = Math.max(s, Math.min(24, prof.end));
  const l = [];
  if (s > 0) l.push([s, offVal]);
  if (e > s) l.push([e, onVal]);
  if (e < 24) l.push([24, offVal]);
  return l;
}

export function buildIDF(bmodel, opts = {}) {
  const plan = planIDF(bmodel, opts);
  const { bm, o, p, src, zones, surfaces, windows, materials, constructions, summary: S, warnings, shading } = plan;
  const neighbors = shading.surfaces;
  const W = new IdfWriter();
  const utf8 = !!o.utf8Comments;
  const date = o.date || new Date().toISOString();

  // ── header with provenance
  W.comment(`EnergyPlus ${IDF_VERSION} input generated by Open Energy Map: Munich (js/idf.js) on ${date}`);
  W.comment(`Source BModel id: ${asciiText(bm.id, utf8)}`);
  W.comment(`Name: ${asciiText(bm.name ?? 'n/a', utf8)}   Address: ${asciiText(bm.address ?? 'n/a', utf8)}`);
  W.comment(`Centre (lat0, lon0): ${fmtVal(bm.center && bm.center.lat)}, ${fmtVal(bm.center && bm.center.lon)}; local frame x = east, y = north, z = up (m), CONTRACT 1`);
  W.comment(`Usage: ${bm.usage}; floors ${bm.floors}; eaves height ${fmtVal(bm.height)} m; roof ${bm.roof ? `${bm.roof.shape}, ridge ${fmtVal(bm.roof.ridgeHeight)} m, attic ${bm.roof.attic}` : 'n/a'}; basement ${bm.basement}`);
  W.comment(`Weather: ${asciiText(o.weatherName || (o.weather && o.weather.name) || 'n/a', utf8)}; year ${fmtVal(S.year ?? (o.weather && o.weather.year) ?? 'TMY')}`);
  W.comment('Runs in EnergyPlus 24.2 (checked with tools/eplus_compare.mjs, qa/eplus_compare.md); modelling choices: tools/export_notes.md.');
  W.comment();
  W.comment('BModel parameters (value unit | source | note | prior):');
  for (const [k, e] of Object.entries(bm.params || {})) {
    const v = e && typeof e === 'object' && 'value' in e ? e : { value: e };
    W.comment(`  ${k.padEnd(11)}= ${fmtVal(v.value)} ${asciiText(v.unit || '', utf8)} | ${asciiText(v.source || 'n/a', utf8)} | ${asciiText(v.note || '', utf8)}${fmtPrior(v.prior)}`);
  }
  for (const k of Object.keys(PARAM_DEFAULTS)) if (!(bm.params || {})[k]) W.comment(`  ${k.padEnd(11)}= ${fmtVal(p[k])} | default(export) | missing in BModel`);
  W.comment();
  W.comment('Facades (id azimuth orient length exposed-fraction wwr):');
  for (const f of bm.facades || []) W.comment(`  ${asciiText(f.id, utf8)} ${fmtVal(f.azimuth)} ${f.orient || ''} L=${fmtVal(f.length)} exposed=${fmtVal(f.exposed)} wwr=${fmtVal(f.wwr)}`);
  W.comment();
  const A = bm.areas || {};
  W.comment('Geometry check (export model vs BModel areas, m2):');
  W.comment(`  footprint ${num(S.A_fp, 1)} vs ${fmtVal(A.footprint)}; exposed wall ${num(S.A_wallOut, 1)} vs ${fmtVal(A.facadeExposed)}; window ${num(S.A_win, 1)} vs ${fmtVal(A.window)}`);
  W.comment(`  party wall (adiabatic) ${num(S.A_party, 1)}; roof ${num(S.A_roof, 1)} (x${num(S.rf, 3)} for U if heated attic); ground floor ${num(S.A_gf, 1)}; net floor A_net ${num(S.A_net, 1)}; V_e ${num(S.Ve, 1)}`);
  W.comment(`  zones ${S.zones} for ${S.storeys} storeys of ${num(S.storeyHeight, 3)} m; floors between storeys: ${S.interzone ? 'interzone surface pairs' : 'adiabatic (zone multiplier)'}; roof ${S.pieces} convex piece(s), floors/ceilings ${S.floorPieces} simple polygon(s)`);
  W.comment('Derived export values:');
  W.comment(`  thermal bridges: H_tb = dU_tb*A_env = ${num(p.dU_tb * S.A_envTarget, 2)} W/K spread on opaque area ${num(S.A_opqModel, 1)} m2 (k = A_env/A_opaque = ${num(S.kTB, 4)})`);
  W.comment(`  U_eff wall ${num(S.Ueff.wall, 4)}, roof/top ceiling ${num(S.Ueff.roof, 4)}, ground floor ${num(S.Ueff.floor, 4)} W/m2K (incl. EN ISO 6946 films)`);
  W.comment(`  buffer coupling: ground floor ${S.groundOSC ? `OSC F_floor=${num(S.Ff, 3)}` : 'Ground (BuildingSurface temperatures)'}; top ${S.atticOSC ? `OSC F_roof=${num(S.Fr, 3)}` : 'Outdoors'}`);
  W.comment(`  mass layer d = ${num(S.dMass, 4)} m concrete on ${num(S.A_faces, 1)} m2 inside faces = Cm*A_net = ${num(p.Cm * S.A_net / 1e6, 2)} MJ/K`);
  W.comment(`  window SHGC = g*(1-frameFrac) = ${num(S.shgc, 4)}, U ${num(S.Uw, 3)}`);
  W.comment(`  infiltration ${num(S.nInf, 4)} 1/h, ventilation ${num(S.nVent, 4)} 1/h on the net air volume 0.8*V_e/storey = ${num(S.zoneVolume, 2)} m3,`);
  W.comment(`  written as Flow/Zone ${num(S.infFlow, 6)} and ${num(S.ventFlow, 6)} m3/s per storey; Zone Volume is autocalculated (geometric, air heat capacity only)`);
  W.comment(`  heating set point ${num(S.Tset, 2)} C (T_heat - (1-heatedFrac)*4), set-back ${num(p.setback, 2)} K; cooling ${S.Tcool == null ? 'none' : num(S.Tcool, 2) + ' C'}`);
  W.comment(`  internal gains level ${num(S.qintLevelPerM2, 4)} W/m2 of A_net (${S.residential ? 'constant' : `operating hours ${S.profile.start}-${S.profile.end} h, ${S.profile.daysPerWeek} d/week, base ${BASE_FRACTION}, mean fraction ${num(S.meanFrac, 4)}, convention ${o.scheduleConvention}`}); per storey ${num(S.qintZone, 1)} W`);
  W.comment('  results: zone output variables are per single zone (not multiplied); meters and tables include multipliers.');
  W.comment('  E+ floor area = gross footprint per storey; divide energies by A_net to compare with the browser (kWh/m2 A_net).');
  if (warnings.length) { W.comment('Warnings:'); for (const w of warnings) W.comment('  ' + asciiText(w, utf8)); }
  W.blank();

  // ── simulation setup
  W.obj('Version', [[IDF_VERSION, 'Version Identifier']]);
  W.obj('SimulationControl', [['No', 'Do Zone Sizing Calculation'], ['No', 'Do System Sizing Calculation'], ['No', 'Do Plant Sizing Calculation'],
    ['No', 'Run Simulation for Sizing Periods'], ['Yes', 'Run Simulation for Weather File Run Periods'], ['No', 'Do HVAC Sizing Simulation for Sizing Periods'], [1, 'Maximum Number of HVAC Sizing Simulation Passes']]);
  W.obj('Building', [[safeName(bm.id || 'BModel'), 'Name'], [0, 'North Axis {deg}'], ['City', 'Terrain'], [0.04, 'Loads Convergence Tolerance Value {W}'],
    [0.4, 'Temperature Convergence Tolerance Value {deltaC}'], ['FullExterior', 'Solar Distribution'], [25, 'Maximum Number of Warmup Days'], [6, 'Minimum Number of Warmup Days']]);
  W.obj('Timestep', [[o.timestepsPerHour, 'Number of Timesteps per Hour']]);
  W.obj('ShadowCalculation', [['PolygonClipping', 'Shading Calculation Method'], ['Periodic', 'Shading Calculation Update Frequency Method'],
    [o.shadowUpdateDays, 'Shading Calculation Update Frequency {days}'], [o.maxShadowFigures, 'Maximum Figures in Shadow Overlap Calculations'],
    [o.polygonClipping, 'Polygon Clipping Algorithm'], [512, 'Pixel Counting Resolution'], ['SimpleSkyDiffuseModeling', 'Sky Diffuse Modeling Algorithm']]);
  const lat = bm.center && Number.isFinite(bm.center.lat) ? bm.center.lat : 48.137;
  const lon = bm.center && Number.isFinite(bm.center.lon) ? bm.center.lon : 11.575;
  W.obj('Site:Location', [['Munich_' + safeName(bm.id || ''), 'Name'], [+lat.toFixed(5), 'Latitude {deg}'], [+lon.toFixed(5), 'Longitude {deg}'], [o.timeZone, 'Time Zone {hr}'], [o.elevation, 'Elevation {m}']]);
  const gtText = S.groundT.map((t) => t.toFixed(1)).join(' ');
  if (surfaces.some((s) => s.bc === 'Ground')) {
    W.comment(`Ground temperatures: monthly means of ${o.weather ? 'the weather object' : 'Munich climatology (approx.)'} damped and lagged as in soil at ${o.groundDepth} m`);
    W.comment(`(Kusuda-type, diffusivity 0.0648 m2/day; amplitude x${num(Math.exp(-o.groundDepth * Math.sqrt(Math.PI / (0.0648 * 365))), 3)}). Used by the slab surfaces with a 'Ground' boundary.`);
    W.comment('These are undisturbed-soil values (conservative), below the 15-25 C that EnergyPlus expects under a conditioned');
    W.comment('building, so EnergyPlus warns "Some values fall outside the range of 15-25C"; this is intended (tools/export_notes.md).');
    W.obj('Site:GroundTemperature:BuildingSurface', S.groundT.map((t, i) => [+t.toFixed(2), ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i] + ' Ground Temperature {C}']));
  } else {
    W.comment(`No surface uses a 'Ground' boundary (ground floor = F-factor buffer), so Site:GroundTemperature:BuildingSurface is not written.`);
    W.comment(`Ground temperatures at ${o.groundDepth} m for groundModel 'ground' would be (C, Jan-Dec): ${gtText}`);
  }
  const leap = isLeapYear(S.year);
  W.obj('RunPeriod', [['Annual', 'Name'], [1, 'Begin Month'], [1, 'Begin Day of Month'], [S.year && !leap ? S.year : '', 'Begin Year'],
    [12, 'End Month'], [31, 'End Day of Month'], [S.year && !leap ? S.year : '', 'End Year'], [S.year && !leap ? '' : startWeekday(S.year), 'Day of Week for Start Day'],
    ['Yes', 'Use Weather File Holidays and Special Days'], ['Yes', 'Use Weather File Daylight Saving Period'], ['No', 'Apply Weekend Holiday Rule'],
    ['Yes', 'Use Weather File Rain Indicators'], ['Yes', 'Use Weather File Snow Indicators'], ['No', 'Treat Weather as Actual']]);
  // non-residential days off as in rc5.js (public holidays, js/holidays.js); the schedules put them under 'AllOtherDays'
  if (!S.residential) {
    const yr = S.year || TMY_YEAR;
    for (const d of [...daysOff(S.profile, yr)].sort((a, b) => a - b)) {
      const [mo, da] = dateOf(yr, d);
      W.obj('RunPeriodControl:SpecialDays', [[`Day off ${mo}/${da}`, 'Name'], [`${mo}/${da}`, 'Start Date'], [1, 'Duration'], ['Holiday', 'Special Day Type']]);
    }
  }
  W.obj('GlobalGeometryRules', [['UpperLeftCorner', 'Starting Vertex Position'], ['Counterclockwise', 'Vertex Entry Direction'], ['Relative', 'Coordinate System'],
    ['Relative', 'Daylighting Reference Point Coordinate System'], ['Relative', 'Rectangular Surface Coordinate System']]);
  W.blank();

  // ── schedules
  W.obj('ScheduleTypeLimits', [['Fraction', 'Name'], [0, 'Lower Limit Value'], [1, 'Upper Limit Value'], ['Continuous', 'Numeric Type']]);
  W.obj('ScheduleTypeLimits', [['Temperature', 'Name'], [-60, 'Lower Limit Value'], [200, 'Upper Limit Value'], ['Continuous', 'Numeric Type'], ['Temperature', 'Unit Type']]);
  W.obj('ScheduleTypeLimits', [['ControlType', 'Name'], [0, 'Lower Limit Value'], [4, 'Upper Limit Value'], ['Discrete', 'Numeric Type']]);
  W.obj('ScheduleTypeLimits', [['OnOff', 'Name'], [0, 'Lower Limit Value'], [1, 'Upper Limit Value'], ['Discrete', 'Numeric Type']]);
  const compact = (name, limits, fields, cmt) => { if (cmt) W.comment(cmt); W.obj('Schedule:Compact', [[name, 'Name'], [limits, 'Schedule Type Limits Name'], ...fields.map((f) => [f, ''])]); };
  compact('AlwaysOn', 'Fraction', ['Through: 12/31', 'For: AllDays', 'Until: 24:00', '1']);
  compact('AlwaysOff', 'OnOff', ['Through: 12/31', 'For: AllDays', 'Until: 24:00', '0']);
  const prof = S.profile;
  const occ = occupancyDays(prof);
  if (!S.residential) {
    const f = ['Through: 12/31', `For: ${occ.on} SummerDesignDay WinterDesignDay`, ...dayFields(profileDay(prof, 1, BASE_FRACTION))];
    if (occ.off) f.push(`For: ${occ.off}`, ...dayFields([[24, BASE_FRACTION]]));
    compact('Occupancy', 'Fraction', f, `Operating hours ${prof.start}-${prof.end} h, ${prof.daysPerWeek} days/week; ${BASE_FRACTION} outside (internal gains${S.winVent ? '' : ' and ventilation'})`);
    if (S.winVent) {
      const v = ['Through: 12/31', `For: ${occ.on} SummerDesignDay WinterDesignDay`, ...dayFields(profileDay(prof, 1, S.ventOff))];
      if (occ.off) v.push(`For: ${occ.off}`, ...dayFields([[24, S.ventOff]]));
      compact('VentilationWindow', 'Fraction', v, `Window ventilation (DIN V 18599-2): design flow during operating hours, 0.1 1/h outside (fraction ${num(S.ventOff, 4)})`);
    }
  }
  const sb = Math.max(0, p.setback || 0);
  const nightSetback = S.residential || o.scheduleConvention === 'dailyMean';
  if (nightSetback) {
    compact('HeatingSetpoint', 'Temperature', ['Through: 12/31', 'For: AllDays', ...dayFields(sb > 0 ? [[6, S.Tset - sb], [22, S.Tset], [24, S.Tset - sb]] : [[24, S.Tset]])],
      `Heating set point ${num(S.Tset, 2)} C with night set-back ${sb} K from 22:00 to 06:00`);
  } else {
    const f = ['Through: 12/31', `For: ${occ.on} SummerDesignDay WinterDesignDay`, ...dayFields(profileDay(prof, S.Tset, S.Tset - sb))];
    if (occ.off) f.push(`For: ${occ.off}`, ...dayFields([[24, S.Tset - sb]]));
    compact('HeatingSetpoint', 'Temperature', f, `Heating set point ${num(S.Tset, 2)} C, set-back ${sb} K outside operating hours (rc5 convention)`);
  }
  if (S.Tcool != null) {
    if (S.residential) compact('CoolingSetpoint', 'Temperature', ['Through: 12/31', 'For: AllDays', 'Until: 24:00', num(S.Tcool, 3)]);
    else {
      const f = ['Through: 12/31', `For: ${occ.on} SummerDesignDay WinterDesignDay`, ...dayFields(profileDay(prof, S.Tcool, 50))];
      if (occ.off) f.push(`For: ${occ.off}`, ...dayFields([[24, 50]]));
      compact('CoolingSetpoint', 'Temperature', f, 'Cooling only in operating hours (50 C = off otherwise)');
    }
  }
  compact('ThermostatControlType', 'ControlType', ['Through: 12/31', 'For: AllDays', 'Until: 24:00', S.Tcool != null ? '4' : '1'],
    S.Tcool != null ? '4 = DualSetpoint' : '1 = SingleHeating');
  W.blank();

  // ── materials and constructions
  // only constructions that are used (EnergyPlus warns about unused ones) and their layers
  const usedCons = new Set([...surfaces.map((s) => s.construction), ...(windows.length ? ['BM_Window'] : [])]);
  const usedMats = new Set(constructions.filter((c) => usedCons.has(c.name)).flatMap((c) => c.layers));
  for (const m of materials) {
    if (!usedMats.has(m.name)) continue;
    if (m.cls === 'Material') W.obj('Material', [[m.name, 'Name'], [m.roughness, 'Roughness'], [m.thickness, 'Thickness {m}'], [m.conductivity, 'Conductivity {W/m-K}'],
      [m.density, 'Density {kg/m3}'], [m.specificHeat, 'Specific Heat {J/kg-K}'], [m.abs[0], 'Thermal Absorptance'], [m.abs[1], 'Solar Absorptance'], [m.abs[2], 'Visible Absorptance']]);
    else if (m.cls === 'Material:NoMass') W.obj('Material:NoMass', [[m.name, 'Name'], [m.roughness, 'Roughness'], [m.R, 'Thermal Resistance {m2-K/W}'],
      [m.abs[0], 'Thermal Absorptance'], [m.abs[1], 'Solar Absorptance'], [m.abs[2], 'Visible Absorptance']]);
    else W.obj('WindowMaterial:SimpleGlazingSystem', [[m.name, 'Name'], [m.U, 'U-Factor {W/m2-K}'], [m.shgc, 'Solar Heat Gain Coefficient']]);
  }
  for (const c of constructions) {
    if (!usedCons.has(c.name)) continue;
    if (c.Utarget != null) W.comment(`${c.name}: target U ${num(c.Utarget, 4)} W/m2K with Rsi ${c.films.rsi} + Rse ${c.films.rse}`);
    W.obj('Construction', [[c.name, 'Name'], ...c.layers.map((l, i) => [l, i === 0 ? 'Outside Layer' : `Layer ${i + 1}`])]);
  }
  if (S.groundOSC) {
    const F = S.Ff, fl = constructions.find((c) => c.element === 'floor');
    W.comment(`Unheated-buffer boundary for the ground floor: T = ${num(F, 3)}*T_out + ${num(1 - F, 3)}*T_zone (F_floor definition), film 1/Rse`);
    W.obj('SurfaceProperty:OtherSideCoefficients', [['OSC_GroundFloor', 'Name'], [+(1 / fl.films.rse).toFixed(4), 'Combined Convective/Radiative Film Coefficient {W/m2-K}'],
      [0, 'Constant Temperature {C}'], [0, 'Constant Temperature Coefficient'], [F, 'External Dry-Bulb Temperature Coefficient'], [0, 'Ground Temperature Coefficient'],
      [0, 'Wind Speed Coefficient'], [+(1 - F).toFixed(6), 'Zone Air Temperature Coefficient']]);
  }
  if (S.atticOSC) {
    const F = S.Fr;
    W.comment(`Unheated attic above the top ceiling: T = ${num(F, 3)}*T_out + ${num(1 - F, 3)}*T_zone (F_roof definition)`);
    W.obj('SurfaceProperty:OtherSideCoefficients', [['OSC_Attic', 'Name'], [+(1 / FILMS.attic.rse).toFixed(4), 'Combined Convective/Radiative Film Coefficient {W/m2-K}'],
      [0, 'Constant Temperature {C}'], [0, 'Constant Temperature Coefficient'], [F, 'External Dry-Bulb Temperature Coefficient'], [0, 'Ground Temperature Coefficient'],
      [0, 'Wind Speed Coefficient'], [+(1 - F).toFixed(6), 'Zone Air Temperature Coefficient']]);
  }
  W.blank();

  // ── zones and geometry
  for (const z of zones) {
    W.comment(`Zone ${z.name}: storey ${z.storeys}, z ${num(z.z0, 3)}-${num(z.z1, 3)} m${z.mult > 1 ? `, multiplier ${z.mult}` : ''}`);
    W.obj('Zone', [[z.name, 'Name'], [0, 'Direction of Relative North {deg}'], [0, 'X Origin {m}'], [0, 'Y Origin {m}'], [0, 'Z Origin {m}'], [1, 'Type'],
      [z.mult, 'Multiplier'], ['autocalculate', 'Ceiling Height {m}'], ['autocalculate', 'Volume {m3} (geometric; air flows use 0.8 V_e)'], ['autocalculate', 'Floor Area {m2}'],
      ['', 'Zone Inside Convection Algorithm'], ['', 'Zone Outside Convection Algorithm'], ['Yes', 'Part of Total Floor Area']]);
  }
  for (const s of surfaces) {
    W.objWithVertices('BuildingSurface:Detailed', [[s.name, 'Name'], [s.type, 'Surface Type'], [s.construction, 'Construction Name'], [s.zone, 'Zone Name'], ['', 'Space Name'],
      [s.bc, 'Outside Boundary Condition'], [s.bcObj, 'Outside Boundary Condition Object'], [s.sun, 'Sun Exposure'], [s.wind, 'Wind Exposure'], ['autocalculate', 'View Factor to Ground']], s.verts);
  }
  for (const w of windows) {
    W.objWithVertices('FenestrationSurface:Detailed', [[w.name, 'Name'], ['Window', 'Surface Type'], ['BM_Window', 'Construction Name'], [w.base, 'Building Surface Name'],
      ['', 'Outside Boundary Condition Object'], ['autocalculate', 'View Factor to Ground'], ['', 'Frame and Divider Name'], [1, 'Multiplier']], w.verts);
  }
  {
    const st = shading.stats, so = shading.options || {};
    W.comment(`Neighbour buildings as shading: ${st.neighbours} of ${st.of} neighbours (${st.candidates ?? st.neighbours} within ${so.shadingRadius ?? '-'} m and >= ${so.minShadingAltitude ?? '-'} deg), ${neighbors.length} surfaces (cap ${so.maxShadingSurfaces ?? '-'});`);
    W.comment(`  skipped: own party walls, ${st.skippedShared} walls shared between neighbours, ${st.skippedBack ?? 0} back walls (our footprint behind their plane); ${st.merged ?? 0} collinear edges merged; roofs ${so.neighborRoofs ? 'written' : 'omitted (cannot block a ray that a closed wall ring does not block)'}`);
  }
  for (const s of neighbors) W.objWithVertices('Shading:Building:Detailed', [[s.name, 'Name'], ['', 'Transmittance Schedule Name']], s.verts);
  W.blank();

  // ── internal loads and air
  for (const z of zones) {
    W.obj('OtherEquipment', [[`${z.name}_InternalGains`, 'Name'], ['None', 'Fuel Type'], [z.name, 'Zone or ZoneList or Space or SpaceList Name'],
      [S.residential ? 'AlwaysOn' : 'Occupancy', 'Schedule Name'], ['EquipmentLevel', 'Design Level Calculation Method'], [+S.qintZone.toFixed(3), 'Design Level {W}'],
      ['', 'Power per Zone Floor Area {W/m2}'], ['', 'Power per Person {W/person}'], [0, 'Fraction Latent'], [0.5, 'Fraction Radiant'], [0, 'Fraction Lost'],
      [0, 'Carbon Dioxide Generation Rate {m3/s-W}'], ['InternalGains', 'End-Use Subcategory']]);
    W.obj('ZoneInfiltration:DesignFlowRate', [[`${z.name}_Infiltration`, 'Name'], [z.name, 'Zone or ZoneList or Space or SpaceList Name'], ['AlwaysOn', 'Schedule Name'],
      ['Flow/Zone', 'Design Flow Rate Calculation Method'], [+S.infFlow.toFixed(7), `Design Flow Rate {m3/s} (${num(S.nInf, 4)} 1/h = 0.07*n50 on 0.8*V_e/storey)`], ['', 'Flow Rate per Floor Area {m3/s-m2}'],
      ['', 'Flow Rate per Exterior Surface Area {m3/s-m2}'], ['', 'Air Changes per Hour {1/hr}'], [1, 'Constant Term Coefficient'],
      [0, 'Temperature Term Coefficient'], [0, 'Velocity Term Coefficient'], [0, 'Velocity Squared Term Coefficient']]);
    if (S.nVent > 0) W.obj('ZoneVentilation:DesignFlowRate', [[`${z.name}_Ventilation`, 'Name'], [z.name, 'Zone or ZoneList or Space or SpaceList Name'],
      [S.residential ? 'AlwaysOn' : S.winVent ? 'VentilationWindow' : 'Occupancy', 'Schedule Name'], ['Flow/Zone', 'Design Flow Rate Calculation Method'], [+S.ventFlow.toFixed(7), `Design Flow Rate {m3/s} (${num(S.nVent, 4)} 1/h = ${S.winVent ? 'max(0.1, n_vent*3m*A_net/V - n_inf)' : 'n_vent*(1-hr_eff)'} on 0.8*V_e/storey)`],
      ['', 'Flow Rate per Floor Area {m3/s-m2}'], ['', 'Flow Rate per Person {m3/s-person}'], ['', 'Air Changes per Hour {1/hr}'],
      [p.hr_eff > 0 ? 'Balanced' : 'Natural', 'Ventilation Type'], [0, 'Fan Pressure Rise {Pa}'], [1, 'Fan Total Efficiency'], [1, 'Constant Term Coefficient'],
      [0, 'Temperature Term Coefficient'], [0, 'Velocity Term Coefficient'], [0, 'Velocity Squared Term Coefficient']]);
  }
  W.blank();

  // ── HVAC: ideal loads + thermostat
  if (S.Tcool != null) W.obj('ThermostatSetpoint:DualSetpoint', [['Thermostat_Dual', 'Name'], ['HeatingSetpoint', 'Heating Setpoint Temperature Schedule Name'], ['CoolingSetpoint', 'Cooling Setpoint Temperature Schedule Name']]);
  else W.obj('ThermostatSetpoint:SingleHeating', [['Thermostat_Heat', 'Name'], ['HeatingSetpoint', 'Setpoint Temperature Schedule Name']]);
  for (const z of zones) {
    const n = z.name;
    W.obj('ZoneControl:Thermostat', [[`${n}_Thermostat`, 'Name'], [n, 'Zone or ZoneList Name'], ['ThermostatControlType', 'Control Type Schedule Name'],
      [S.Tcool != null ? 'ThermostatSetpoint:DualSetpoint' : 'ThermostatSetpoint:SingleHeating', 'Control 1 Object Type'], [S.Tcool != null ? 'Thermostat_Dual' : 'Thermostat_Heat', 'Control 1 Name']]);
    W.obj('ZoneHVAC:IdealLoadsAirSystem', [[`${n}_IdealLoads`, 'Name'], ['', 'Availability Schedule Name'], [`${n}_Supply_Inlet`, 'Zone Supply Air Node Name'],
      ['', 'Zone Exhaust Air Node Name'], ['', 'System Inlet Air Node Name'], [50, 'Maximum Heating Supply Air Temperature {C}'], [13, 'Minimum Cooling Supply Air Temperature {C}'],
      [0.0156, 'Maximum Heating Supply Air Humidity Ratio {kgWater/kgDryAir}'], [0.0077, 'Minimum Cooling Supply Air Humidity Ratio {kgWater/kgDryAir}'],
      ['NoLimit', 'Heating Limit'], ['', 'Maximum Heating Air Flow Rate {m3/s}'], ['', 'Maximum Sensible Heating Capacity {W}'], ['NoLimit', 'Cooling Limit'],
      ['', 'Maximum Cooling Air Flow Rate {m3/s}'], ['', 'Maximum Total Cooling Capacity {W}'], ['', 'Heating Availability Schedule Name'],
      [S.Tcool != null ? '' : 'AlwaysOff', 'Cooling Availability Schedule Name'], ['None', 'Dehumidification Control Type'], ['', 'Cooling Sensible Heat Ratio'],
      ['None', 'Humidification Control Type']]);
    W.obj('ZoneHVAC:EquipmentList', [[`${n}_Equipment`, 'Name'], ['SequentialLoad', 'Load Distribution Scheme'], ['ZoneHVAC:IdealLoadsAirSystem', 'Zone Equipment 1 Object Type'],
      [`${n}_IdealLoads`, 'Zone Equipment 1 Name'], [1, 'Zone Equipment 1 Cooling Sequence'], [1, 'Zone Equipment 1 Heating or No-Load Sequence']]);
    W.obj('NodeList', [[`${n}_Inlets`, 'Name'], [`${n}_Supply_Inlet`, 'Node 1 Name']]);
    W.obj('ZoneHVAC:EquipmentConnections', [[n, 'Zone Name'], [`${n}_Equipment`, 'Zone Conditioning Equipment List Name'], [`${n}_Inlets`, 'Zone Air Inlet Node or NodeList Name'],
      ['', 'Zone Air Exhaust Node or NodeList Name'], [`${n}_Air_Node`, 'Zone Air Node Name'], [`${n}_Return_Outlet`, 'Zone Return Air Node or NodeList Name']]);
  }
  W.blank();

  // ── outputs
  for (const v of ['Zone Ideal Loads Zone Total Heating Energy', 'Zone Ideal Loads Zone Total Cooling Energy', 'Zone Ideal Loads Zone Sensible Heating Energy', 'Zone Mean Air Temperature', 'Zone Operative Temperature'])
    W.obj('Output:Variable', [['*', 'Key Value'], [v, 'Variable Name'], ['Hourly', 'Reporting Frequency']]);
  W.obj('Output:Variable', [['Environment', 'Key Value'], ['Site Outdoor Air Drybulb Temperature', 'Variable Name'], ['Hourly', 'Reporting Frequency']]);
  W.comment('Ideal loads energy is metered as district heating/cooling. Since EnergyPlus 23.1 the heating meter is');
  W.comment('DistrictHeatingWater:* (the pre-23.1 name DistrictHeating:* is rejected by 24.2 as an invalid key).');
  for (const m of ['DistrictHeatingWater:Facility', 'DistrictCooling:Facility'])
    for (const f of ['Monthly', 'Hourly']) W.obj('Output:Meter', [[m, 'Key Name'], [f, 'Reporting Frequency']]);
  W.obj('Output:Table:SummaryReports', [['AllSummary', 'Report 1 Name']]);
  W.obj('OutputControl:Table:Style', [['CommaAndHTML', 'Column Separator'], ['JtoKWH', 'Unit Conversion']]);
  W.obj('Output:VariableDictionary', [['IDF', 'Key Field']]);
  W.obj('Output:Surfaces:Drawing', [['DXF:WireFrame', 'Report Type (wireframe: no triangulation of non-convex floors)']]);
  W.comment('Uncomment for a more verbose eplusout.err on the first run:');
  W.comment('Output:Diagnostics, DisplayExtraWarnings;');
  return W.toString();
}

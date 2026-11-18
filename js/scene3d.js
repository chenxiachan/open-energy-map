// scene3d.js — 3D building viewer (CONTRACT §4).
//
// Coordinate mapping (local frame, CONTRACT §1 → three.js), a proper rotation without mirroring (as in pointsay):
//   local x (east) → three X,  local y (north) → three −Z,  local z (up) → three Y.
//   P2T(x, y, z) = (x, z, −y).
// All building geometry is generated directly in world coordinates (mesh transforms stay identity),
// except neighbours, which are centred on their own centroid so transparent sorting works.
//
// Interpretation choices where CONTRACT §4 leaves room (simplest reading, documented here):
//  - onPick(cb) replaces the previous callback and returns an unsubscribe function. Party-wall parts are
//    reported as { kind: "facade", id: "F<n>" } like the exposed wall of the same facade.
//  - The viewer never highlights on click by itself; the caller decides (e.g. onPick → highlight(id)).
//  - A party segment (exposed:false) is adiabatic only up to min(height, neighborHeight). Above the
//    neighbour it is normal external wall (same pickable mesh and colour as the facade, gets windows).
//    neighborHeight null on a party segment = party wall over the full height.
//  - wwr applies to the total exposed wall area of a facade, including those upper parts.
//  - setColoring also accepts an optional `format(value) → string` used in the hover tooltip.
//    Party-wall parts are never coloured (they do not lose heat in the model).
//  - The ground floor ("floor") cannot be seen from outside, so it is drawn as a plinth plate 0.35 m
//    wider than the footprint on exposed sides; its value colours that plate.
//  - Picking prefers the building over translucent neighbours in front of it (party walls lie inside the
//    neighbour outline and would otherwise be unreachable); a neighbour is picked where no building is behind.
//  - Pitched roof on a footprint whose area is ≥ 0.85 × its oriented minimum bounding rectangle (and
//    without courtyards): gable / hip over that rectangle ("other" → hip). Otherwise: a truncated hip
//    (weighted polygon inset): every exposed edge slopes inwards, party-wall edges rise vertically
//    (fire walls), and the inset ring carries a flat plateau at the ridge height. The inset distance is
//    the largest one (≤ ridgeHeight / tan 30°) for which the inset polygon stays simple; if none ≥ 0.3 m
//    exists, the roof falls back to a flat cap.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { L as tr } from './i18n.js';

const DEG = Math.PI / 180;
const P2T = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

// ───────────────────────────────────────── constants (metres)
const SILL = 0.9;           // window sill above storey floor
const SILL_LOW = 0.25;      // sill used when the target glazing does not fit with the normal sill
const LINTEL = 0.3;         // wall above window head up to next floor
const EDGE = 0.5;           // clear wall at both ends of an exposed region (scaled down on short regions)
const MIN_PANE_W = 0.4;     // narrowest pane we still draw (short jogs in OSM outlines)
const GAP = 0.5;            // preferred minimum pier between panes (for pane count)
const GAP_MIN = 0.25;       // absolute minimum pier
const PANE_W = 1.35, PANE_W_MIN = 1.2, PANE_H_PREF = 1.5, PANE_H_MIN = 0.6;
const GLASS_OFF = 0.02, FRAME_OFF = 0.012, FRAME_W = 0.06;
const BAND_OFF = 0.015, BAND_H = 0.12, CORNICE_OFF = 0.03, CORNICE_H = 0.22;
const PLINTH_OUT = 0.35, PLINTH_H = 0.15;
const RECT_RATIO = 0.85;

const THEMES = {
  light: {
    bg: '#f7f7f5', ground: '#f1f0ec', grid1: '#cfcec7', grid2: '#e0dfd9',
    wall: '#e6e1d8', band: '#cfc8bc', partyBase: '#c2bdb4', partyLine: '#958f86',
    glass: '#6a8595', frame: '#f6f4ef', roof: '#ae9b90', gable: '#ddd7cd', floor: '#a6a29b',
    nb: '#cfd3d7', nbOpacity: 0.26, nbEdge: '#8f969e', nbHover: '#9fb0c2', nbSel: '#7f9bb8',
    edge: '#6f6b64', compass: '#8a877f', compassN: '#c0392b', sun: '#f0a020',
    outline: '#0b57d0', hoverGlow: 0.09, selGlow: 0.16,
    hemiSky: '#ffffff', hemiGround: '#d8d5ce', hemi: 2.0, key: 1.6, hemiSun: 1.25, sunI: 2.7,
  },
  dark: {
    bg: '#16181b', ground: '#1c1f23', grid1: '#30343a', grid2: '#25282d',
    wall: '#8f939a', band: '#73777e', partyBase: '#4c5056', partyLine: '#33363b',
    glass: '#34495a', frame: '#b7babe', roof: '#73655d', gable: '#7d8187', floor: '#5a5f66',
    nb: '#3d434a', nbOpacity: 0.34, nbEdge: '#646b74', nbHover: '#5b6b7d', nbSel: '#62809f',
    edge: '#2b2e33', compass: '#7d838b', compassN: '#ff7262', sun: '#ffb733',
    outline: '#8ab4f8', hoverGlow: 0.07, selGlow: 0.13,
    hemiSky: '#d5dbe4', hemiGround: '#2c2e33', hemi: 1.6, key: 1.3, hemiSun: 0.95, sunI: 2.5,
  },
};

const DIR_ZH = tr({ N: '北', E: '东', S: '南', W: '西' }, { N: 'N', E: 'E', S: 'S', W: 'W' }, { N: 'N', E: 'O', S: 'S', W: 'W' });
const ROOF_ZH = tr({ flat: '平屋顶', gabled: '双坡屋顶', hipped: '四坡屋顶', other: '坡屋顶' }, { flat: 'Flat roof', gabled: 'Gable roof', hipped: 'Hipped roof', other: 'Pitched roof' }, { flat: 'Flachdach', gabled: 'Satteldach', hipped: 'Walmdach', other: 'Steildach' });
const ATTIC_ZH = tr({ heated: '阁楼采暖', unheated: '阁楼不采暖', none: '无阁楼' }, { heated: 'heated attic', unheated: 'unheated attic', none: 'no attic' }, { heated: 'beheiztes Dachgeschoss', unheated: 'unbeheiztes Dachgeschoss', none: 'kein Dachgeschoss' });
const BASEMENT_ZH = tr({ none: '无地下室', unheated: '地下室不采暖', heated: '地下室采暖' }, { none: 'no basement', unheated: 'unheated basement', heated: 'heated basement' }, { none: 'kein Keller', unheated: 'unbeheizter Keller', heated: 'beheizter Keller' });

// ───────────────────────────────────────── CSS (injected once)
const CSS = `
.s3d-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;
  font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
.s3d-labels{position:absolute;left:0;top:0;pointer-events:none}
.s3d-tip{position:absolute;left:0;top:0;padding:6px 9px;border-radius:6px;background:rgba(255,255,255,.97);color:#202327;
  box-shadow:0 2px 10px rgba(0,0,0,.16);opacity:0;transition:opacity .1s;white-space:nowrap;z-index:3;max-width:360px}
.s3d-tip.on{opacity:1}
.s3d-tip .t{font-weight:600}
.s3d-tip .m{color:#646972;font-size:11px;margin-top:1px}
.s3d-tip .v{color:#0b57d0;font-size:11px;margin-top:1px;font-variant-numeric:tabular-nums}
.s3d-dark .s3d-tip{background:rgba(34,37,42,.97);color:#e7e9ec;box-shadow:0 2px 12px rgba(0,0,0,.5)}
.s3d-dark .s3d-tip .m{color:#9aa1aa}
.s3d-dark .s3d-tip .v{color:#8ab4f8}
.s3d-lbl{font-size:12px;font-weight:600;color:#6c6962;text-shadow:0 0 3px #f7f7f5,0 0 3px #f7f7f5;user-select:none}
.s3d-lbl.n{font-size:15px;color:#c0392b}
.s3d-dark .s3d-lbl{color:#9aa0a8;text-shadow:0 0 3px #16181b,0 0 3px #16181b}
.s3d-dark .s3d-lbl.n{color:#ff7262}
.s3d-hud{position:absolute;left:12px;bottom:12px;width:58px;height:58px}
.s3d-hud svg{display:block;width:100%;height:100%;overflow:visible}
.s3d-hud .dial{fill:rgba(255,255,255,.88);stroke:rgba(60,60,60,.25);stroke-width:1}
.s3d-hud .n{fill:#c0392b}.s3d-hud .s{fill:#a9a59d}
.s3d-hud text{font-size:11px;font-weight:700;fill:#c0392b;text-anchor:middle;dominant-baseline:central}
.s3d-hud .sun{fill:#f0a020;stroke:#fff;stroke-width:1}
.s3d-dark .s3d-hud .dial{fill:rgba(34,37,42,.9);stroke:rgba(255,255,255,.15)}
.s3d-dark .s3d-hud .n{fill:#ff7262}.s3d-dark .s3d-hud .s{fill:#5d636b}
.s3d-dark .s3d-hud text{fill:#ff7262}
.s3d-sunlbl{font-size:11px;padding:2px 6px;border-radius:4px;background:rgba(255,248,230,.92);color:#7a4a00;
  border:1px solid rgba(240,160,32,.6);white-space:nowrap;font-variant-numeric:tabular-nums}
.s3d-dark .s3d-sunlbl{background:rgba(50,40,20,.92);color:#ffcf73;border-color:rgba(255,183,51,.5)}
`;
let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.dataset.s3d = '1';
  s.textContent = CSS;
  document.head.appendChild(s);
  cssInjected = true;
}

// ───────────────────────────────────────── 2D helpers (local plan coordinates)
function ringArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function cleanRing(ring) {
  const out = [];
  for (const p of ring || []) {
    if (!p) continue;
    const q = [+p[0], +p[1]];
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
    const l = out[out.length - 1];
    if (l && Math.hypot(l[0] - q[0], l[1] - q[1]) < 1e-3) continue;
    out.push(q);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-3) out.pop();
  return out.length >= 3 && Math.abs(ringArea(out)) > 1e-4 ? out : null;
}
const orientRing = (r, ccw) => ((ringArea(r) > 0) === ccw ? r : r.slice().reverse());
function pointInRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inFootprint = (p, outer, holes) => pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
const near = (a, b, tol = 0.05) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;

function convexHull(pts) {
  const p = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** Oriented minimum-area bounding rectangle (rotating calipers over hull edges). */
function minAreaRect(pts) {
  const h = convexHull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of h) {
      const s = x * ux + y * uy, t = -x * uy + y * ux;
      if (s < a0) a0 = s; if (s > a1) a1 = s; if (t < b0) b0 = t; if (t > b1) b1 = t;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area - 1e-9) best = { area, u: [ux, uy], v: [-uy, ux], ca: (a0 + a1) / 2, cb: (b0 + b1) / 2, hu: (a1 - a0) / 2, hv: (b1 - b0) / 2 };
  }
  if (!best) return null;
  best.c = [best.u[0] * best.ca + best.v[0] * best.cb, best.u[1] * best.ca + best.v[1] * best.cb];
  return best;
}
function segsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const e = 1e-9;
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

/**
 * Weighted offset of a ring. The ring is oriented so that the right-hand normal of every edge points out of
 * the material (outer ring CCW, holes CW). Edge i (v_i → v_i+1) moves inwards by w[i]·d (d < 0 = outwards).
 * Each vertex gets A (on the offset line of the previous edge) and B (on its own edge's offset line);
 * A ≠ B only where two nearly collinear edges have different offsets ("step").
 */
function offsetRing(ring, w, d) {
  const n = ring.length, U = [], N = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    U.push([ux, uy]);
    N.push([uy, -ux]);
  }
  const A = [], B = [];
  for (let i = 0; i < n; i++) {
    const ip = (i - 1 + n) % n, v = ring[i];
    const n1 = N[ip], n2 = N[i], o1 = w[ip] * d, o2 = w[i] * d;
    const cr = n1[0] * n2[1] - n1[1] * n2[0];
    const dt = n1[0] * n2[0] + n1[1] * n2[1];
    if (Math.abs(cr) < 0.17 && dt > 0) { // within ~10° of collinear
      if (Math.abs(o1 - o2) < 1e-9) {
        let mx = n1[0] + n2[0], my = n1[1] + n2[1];
        const ml = Math.hypot(mx, my);
        mx /= ml; my /= ml;
        const k = o1 / (ml / 2);
        const p = [v[0] - mx * k, v[1] - my * k];
        A.push(p); B.push(p);
      } else {
        A.push([v[0] - n1[0] * o1, v[1] - n1[1] * o1]);
        B.push([v[0] - n2[0] * o2, v[1] - n2[1] * o2]);
      }
      continue;
    }
    // solve n1·p = −o1, n2·p = −o2 (p relative to v)
    const px = (-o1 * n2[1] + o2 * n1[1]) / cr;
    const py = (-n1[0] * o2 + n2[0] * o1) / cr;
    const p = [v[0] + px, v[1] + py];
    A.push(p); B.push(p);
  }
  return { A, B, U, N };
}
/** Offset all rings and check the result is still a valid polygon set. Returns the offsets or null. */
function offsetRings(rings, ws, d) {
  const res = [], polys = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r], n = ring.length;
    const o = offsetRing(ring, ws[r], d);
    for (let i = 0; i < n; i++) {
      const s = o.B[i], e = o.A[(i + 1) % n];
      const ex = e[0] - s[0], ey = e[1] - s[1];
      const along = ex * o.U[i][0] + ey * o.U[i][1];
      if (!(along > 0.02)) return null;                          // edge collapsed or reversed
      if (Math.abs(-ex * o.U[i][1] + ey * o.U[i][0]) > 0.02 + 0.02 * Math.abs(along)) return null; // not parallel
    }
    const poly = [];
    for (let i = 0; i < n; i++) {
      poly.push(o.A[i]);
      if (!near(o.A[i], o.B[i], 1e-6)) poly.push(o.B[i]);
    }
    if (Math.sign(ringArea(poly)) !== Math.sign(ringArea(ring)) || Math.abs(ringArea(poly)) < 0.05) return null;
    res.push(o);
    polys.push(poly);
  }
  // simple-polygon test: no proper crossings among all edges (adjacent edges excluded)
  const segs = [];
  polys.forEach((p, r) => p.forEach((q, i) => segs.push({ r, i, n: p.length, a: q, b: p[(i + 1) % p.length] })));
  for (let x = 0; x < segs.length; x++) {
    for (let y = x + 1; y < segs.length; y++) {
      const s = segs[x], t = segs[y];
      if (s.r === t.r && (t.i === s.i + 1 || (s.i === 0 && t.i === s.n - 1))) continue;
      if (segsCross(s.a, s.b, t.a, t.b)) return null;
    }
  }
  return { offs: res, polys };
}

// ───────────────────────────────────────── geometry builder (local coordinates in, three.js out)
class GeoBuilder {
  constructor(groups = 1) {
    this.g = [];
    for (let i = 0; i < groups; i++) this.g.push({ p: [], n: [], uv: [] });
  }
  /** Triangle a,b,c (local [x,y,z]); its front face is turned towards `hint` (local direction) if given. */
  tri(a, b, c, hint, group = 0, ua = null, ub = null, uc = null) {
    const A = [a[0], a[2], -a[1]], B = [b[0], b[2], -b[1]], C = [c[0], c[2], -c[1]];
    const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
    const e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    let P = [A, B, C], T = [ua, ub, uc];
    if (hint && nx * hint[0] + ny * hint[2] - nz * hint[1] < 0) {
      P = [A, C, B]; T = [ua, uc, ub]; nx = -nx; ny = -ny; nz = -nz;
    }
    const g = this.g[group];
    for (let i = 0; i < 3; i++) {
      g.p.push(P[i][0], P[i][1], P[i][2]);
      g.n.push(nx, ny, nz);
      g.uv.push(T[i] ? T[i][0] : 0, T[i] ? T[i][1] : 0);
    }
  }
  quad(a, b, c, d, hint, group = 0, uv = null) {
    this.tri(a, b, c, hint, group, uv && uv[0], uv && uv[1], uv && uv[2]);
    this.tri(a, c, d, hint, group, uv && uv[0], uv && uv[2], uv && uv[3]);
  }
  /** Horizontal polygon with holes at height z (earcut via ShapeUtils). */
  polygon(contour, holes, z, up = true, group = 0) {
    const all = contour.concat(...holes);
    const faces = THREE.ShapeUtils.triangulateShape(
      contour.map(([x, y]) => new THREE.Vector2(x, y)),
      holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y))),
    );
    const hint = [0, 0, up ? 1 : -1];
    for (const [i, j, k] of faces) this.tri([all[i][0], all[i][1], z], [all[j][0], all[j][1], z], [all[k][0], all[k][1], z], hint, group);
  }
  get count() { return this.g.reduce((s, g) => s + g.p.length / 3, 0); }
  build() {
    const total = this.count;
    const P = new Float32Array(total * 3), N = new Float32Array(total * 3), UV = new Float32Array(total * 2);
    const geo = new THREE.BufferGeometry();
    let o = 0;
    this.g.forEach((g, i) => {
      const cnt = g.p.length / 3;
      P.set(g.p, o * 3); N.set(g.n, o * 3); UV.set(g.uv, o * 2);
      if (this.g.length > 1 && cnt) geo.addGroup(o, cnt, i);
      o += cnt;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// ───────────────────────────────────────── model preparation
function orientFromNormal(n) {
  const az = (Math.atan2(n[0], n[1]) / DEG + 360) % 360;
  return ['N', 'E', 'S', 'W'][Math.round(az / 90) % 4];
}
function deriveFacades(rings) {
  const out = [];
  rings.forEach((ring, r) => ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    out.push({ id: `F${out.length}`, ring: r, a, b, segments: [{ t0: 0, t1: 1, exposed: true, neighborHeight: null }], wwr: 0.25 });
  }));
  return out;
}
function prepFacades(src, outer, holes) {
  return src.map((f, idx) => {
    if (!f || !f.a || !f.b) return null;
    const a = [+f.a[0], +f.a[1]], b = [+f.b[0], +f.b[1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(L > 0.05)) return null;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let n = [u[1], -u[0]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const e = Math.min(0.05, L * 0.05);
    const outIn = inFootprint([mid[0] + n[0] * e, mid[1] + n[1] * e], outer, holes);
    const inIn = inFootprint([mid[0] - n[0] * e, mid[1] - n[1] * e], outer, holes);
    if (outIn && !inIn) n = [-n[0], -n[1]];
    let segs = Array.isArray(f.segments) && f.segments.length ? f.segments : [{ t0: 0, t1: 1, exposed: (f.exposed ?? 1) >= 0.5, neighborHeight: null }];
    segs = segs
      .map((s) => ({ t0: Math.max(0, Math.min(1, +s.t0 || 0)), t1: Math.max(0, Math.min(1, s.t1 == null ? 1 : +s.t1)), exposed: s.exposed !== false, neighborHeight: s.neighborHeight }))
      .filter((s) => s.t1 > s.t0 + 1e-6)
      .sort((p, q) => p.t0 - q.t0);
    const wwr = Math.max(0, Math.min(0.95, +f.wwr || 0));
    const orient = DIR_ZH[f.orient] ? f.orient : orientFromNormal(n);
    return { id: String(f.id ?? `F${idx}`), ring: +f.ring || 0, a, b, L, u, n, orient, segs, wwr, exposedFrac: f.exposed };
  }).filter(Boolean);
}
/** Exposed / party rectangles of a facade in (s along a→b, z) coordinates. */
function facadeRegions(f, H) {
  const exp = [], party = [];
  for (const s of f.segs) {
    const s0 = s.t0 * f.L, s1 = s.t1 * f.L;
    if (s.exposed) { exp.push({ s0, s1, z0: 0, z1: H }); continue; }
    const nhRaw = s.neighborHeight;
    const nh = nhRaw == null || !Number.isFinite(+nhRaw) ? H : Math.max(0, Math.min(H, +nhRaw));
    if (nh > 1e-3) party.push({ s0, s1, z0: 0, z1: nh, nh: nhRaw == null ? null : +nhRaw });
    if (nh < H - 1e-3) exp.push({ s0, s1, z0: nh, z1: H, above: true });
  }
  exp.sort((p, q) => p.s0 - q.s0);
  const merged = [];
  for (const r of exp) {
    const l = merged[merged.length - 1];
    if (l && Math.abs(l.s1 - r.s0) < 1e-3 && Math.abs(l.z0 - r.z0) < 1e-3 && Math.abs(l.z1 - r.z1) < 1e-3) l.s1 = r.s1;
    else merged.push({ ...r });
  }
  return { exp: merged, party };
}
function paneDims(A, u, hz) {
  const fitW = (n) => (u - (n - 1) * GAP_MIN) / n;
  const hp0 = Math.min(hz, PANE_H_PREF);
  const nMax = Math.max(1, Math.floor((u + GAP) / (PANE_W_MIN + GAP)));
  let n = Math.min(nMax, Math.max(1, Math.round(A / (PANE_W * hp0))));
  let wp = Math.min(PANE_W, fitW(n));
  let hp = A / (n * wp);
  while (hp > hz && n < nMax) { n++; wp = Math.min(PANE_W, fitW(n)); hp = A / (n * wp); }
  if (hp > hz) { hp = hz; wp = Math.min(A / (n * hp), fitW(n)); }
  else if (hp < PANE_H_MIN) { hp = Math.min(hz, PANE_H_MIN); wp = Math.min(A / (n * hp), fitW(n)); }
  return { n, wp, hp };
}
/** Window panes of one facade: total area ≈ wwr × exposed wall area, distributed over storeys. */
function layoutWindows(f, reg, H, floors, fh) {
  const Aexp = reg.exp.reduce((s, r) => s + (r.s1 - r.s0) * (r.z1 - r.z0), 0);
  const target = f.wwr * Aexp;
  const out = { panes: [], target, built: 0, Aexp };
  if (target < 0.05 || floors < 1) return out;
  const sill = Math.min(SILL, 0.3 * fh), lintel = Math.min(LINTEL, 0.12 * fh);
  const slots = [];
  for (const r of reg.exp) {
    const edge = Math.max(0.12, Math.min(EDGE, 0.15 * (r.s1 - r.s0)));
    const u = r.s1 - r.s0 - 2 * edge;
    for (let k = 0; k < floors; k++) {
      const zs = k * fh, ze = Math.min(H, (k + 1) * fh);
      const ov = Math.min(ze, r.z1) - Math.max(zs, r.z0);
      if (ov <= 1e-3) continue;
      const partial = r.z0 > zs + 1e-3;
      const zb = partial ? Math.max(zs + sill, r.z0 + 0.15) : zs + sill;
      const zt = Math.min(ze - lintel, r.z1 - 0.1);
      slots.push({ r, share: (r.s1 - r.s0) * ov, zb, zt, zs, partial, u, edge, ok: u >= MIN_PANE_W && zt - zb >= PANE_H_MIN });
    }
  }
  const sumOk = slots.reduce((s, q) => s + (q.ok ? q.share : 0), 0);
  if (sumOk <= 0) return out;
  for (const q of slots) {
    if (!q.ok) continue;
    const A = (target * q.share) / sumOk;
    let zb = q.zb;
    if (!q.partial && A > 0.85 * q.u * (q.zt - zb)) zb = q.zs + Math.min(SILL_LOW, 0.1 * fh); // floor-to-ceiling glazing
    const { n, wp, hp } = paneDims(A, q.u, q.zt - zb);
    for (let i = 0; i < n; i++) {
      out.panes.push({ c: q.r.s0 + q.edge + ((i + 0.5) * q.u) / n, w: wp, z0: zb, h: hp });
      out.built += wp * hp;
    }
  }
  return out;
}
function edgeFacade(facades, ringIdx, v, w) {
  return facades.find((f) => f.ring === ringIdx && near(f.a, v) && near(f.b, w))
    || facades.find((f) => near(f.a, v) && near(f.b, w))
    || facades.find((f) => near(f.a, w) && near(f.b, v));
}
/** Per-edge weights: 0 for edges that are mostly party wall, 1 otherwise. */
function ringWeights(ring, ringIdx, facades) {
  return ring.map((v, i) => {
    const f = edgeFacade(facades, ringIdx, v, ring[(i + 1) % ring.length]);
    if (!f) return 1;
    const party = f.segs.reduce((s, g) => s + (g.exposed ? 0 : g.t1 - g.t0), 0);
    return party >= 0.5 ? 0 : 1;
  });
}

// ───────────────────────────────────────── roofs
function rectRoof(gb, rect, H, R, gabled, ridgeAlongU) {
  let r, c, hr, hc;
  const alongU = gabled ? ridgeAlongU : rect.hu >= rect.hv;
  if (alongU) { r = rect.u; c = rect.v; hr = rect.hu; hc = rect.hv; } else { r = rect.v; c = rect.u; hr = rect.hv; hc = rect.hu; }
  const P = (s, t, z) => [rect.c[0] + r[0] * s + c[0] * t, rect.c[1] + r[1] * s + c[1] * t, z];
  const Z = H + R;
  const side = (sg) => [c[0] * sg * R, c[1] * sg * R, hc];
  if (gabled) {
    gb.quad(P(-hr, -hc, H), P(hr, -hc, H), P(hr, 0, Z), P(-hr, 0, Z), side(-1), 0);
    gb.quad(P(-hr, hc, H), P(hr, hc, H), P(hr, 0, Z), P(-hr, 0, Z), side(1), 0);
    gb.tri(P(-hr, -hc, H), P(-hr, hc, H), P(-hr, 0, Z), [-r[0], -r[1], 0], 1);
    gb.tri(P(hr, -hc, H), P(hr, hc, H), P(hr, 0, Z), [r[0], r[1], 0], 1);
  } else {
    const e = Math.max(0, hr - hc);
    gb.quad(P(-hr, -hc, H), P(hr, -hc, H), P(e, 0, Z), P(-e, 0, Z), side(-1), 0);
    gb.quad(P(-hr, hc, H), P(hr, hc, H), P(e, 0, Z), P(-e, 0, Z), side(1), 0);
    gb.tri(P(-hr, -hc, H), P(-hr, hc, H), P(-e, 0, Z), [-r[0] * R, -r[1] * R, hr - e], 0);
    gb.tri(P(hr, -hc, H), P(hr, hc, H), P(e, 0, Z), [r[0] * R, r[1] * R, hr - e], 0);
  }
}
/** Truncated weighted hip roof. Returns inset distance used, or 0 if no valid inset exists. */
function insetRoof(gb, rings, ws, H, R) {
  const dCap = R / Math.tan(30 * DEG);
  let d = dCap, res = offsetRings(rings, ws, d);
  if (!res) {
    let lo = 0, hi = dCap, best = 0;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (offsetRings(rings, ws, mid)) { best = mid; lo = mid; } else hi = mid;
    }
    if (best < 0.3) return 0;
    d = best * 0.92;
    res = offsetRings(rings, ws, d);
    if (!res) { d = best; res = offsetRings(rings, ws, d); }
    if (!res) return 0;
  }
  const Z = H + R;
  rings.forEach((ring, r) => {
    const { A, B, U, N } = res.offs[r];
    const w = ws[r], n = ring.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const v0 = [ring[i][0], ring[i][1], H], v1 = [ring[j][0], ring[j][1], H];
      const a1 = [A[j][0], A[j][1], Z], b0 = [B[i][0], B[i][1], Z];
      const slope = w[i] > 0;
      const hint = slope ? [N[i][0] * R, N[i][1] * R, d * w[i]] : [N[i][0], N[i][1], 0];
      gb.quad(v0, v1, a1, b0, hint, slope ? 0 : 1);
      if (!near(A[i], B[i], 1e-6)) {
        const ip = (i - 1 + n) % n;
        const k = w[i] - w[ip];
        gb.tri(v0, [A[i][0], A[i][1], Z], [B[i][0], B[i][1], Z], [U[i][0] * k, U[i][1] * k, 0], 1);
      }
    }
  });
  gb.polygon(res.polys[0], res.polys.slice(1), Z, true, 0);
  return d;
}

// ───────────────────────────────────────── misc helpers
function hatchCanvas(cv, base, line) {
  const s = 64;
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = line;
  g.lineWidth = 5;
  for (let c = -s; c <= s; c += s / 2) { g.beginPath(); g.moveTo(c, s); g.lineTo(c + s, 0); g.stroke(); }
}
const fmtNum = (v, d = 1) => (Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(d));
function lineGeo(arr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
  return g;
}
function pushLine(arr, a, b) { arr.push(a[0], a[2], -a[1], b[0], b[2], -b[1]); }
/**
 * Feature edges of a non-indexed triangle geometry (boundary edges + creases > thr°), each pushed `off`
 * metres along the mean normal of its faces so the line never sinks into its own (polygon-offset) surface.
 */
function outlineEdges(geo, out, thr = 25, off = 0.04, o = null) {
  const P = geo.attributes.position.array;
  const cosT = Math.cos(thr * DEG);
  const key = (i) => `${Math.round(P[i * 3] * 500)},${Math.round(P[i * 3 + 1] * 500)},${Math.round(P[i * 3 + 2] * 500)}`;
  const edges = new Map();
  for (let t = 0; t < P.length / 9; t++) {
    const i = t * 3;
    const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
    const e1 = [P[i * 3 + 3] - ax, P[i * 3 + 4] - ay, P[i * 3 + 5] - az], e2 = [P[i * 3 + 6] - ax, P[i * 3 + 7] - ay, P[i * 3 + 8] - az];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n);
    if (l < 1e-12) continue;
    n[0] /= l; n[1] /= l; n[2] /= l;
    for (const [p, q] of [[i, i + 1], [i + 1, i + 2], [i + 2, i]]) {
      const kp = key(p), kq = key(q);
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      let e = edges.get(k);
      if (!e) { e = { a: p, b: q, n: [] }; edges.set(k, e); }
      e.n.push(n);
    }
  }
  const ox = o ? o.x : 0, oy = o ? o.y : 0, oz = o ? o.z : 0;
  for (const e of edges.values()) {
    let keep = e.n.length === 1;
    for (let x = 0; !keep && x < e.n.length; x++) for (let y = x + 1; y < e.n.length; y++) {
      if (e.n[x][0] * e.n[y][0] + e.n[x][1] * e.n[y][1] + e.n[x][2] * e.n[y][2] < cosT) { keep = true; break; }
    }
    if (!keep) continue;
    let mx = 0, my = 0, mz = 0;
    for (const n of e.n) { mx += n[0]; my += n[1]; mz += n[2]; }
    const ml = Math.hypot(mx, my, mz) || 1;
    mx = (mx / ml) * off + ox; my = (my / ml) * off + oy; mz = (mz / ml) * off + oz;
    out.push(P[e.a * 3] + mx, P[e.a * 3 + 1] + my, P[e.a * 3 + 2] + mz, P[e.b * 3] + mx, P[e.b * 3 + 1] + my, P[e.b * 3 + 2] + mz);
  }
}

// ═════════════════════════════════════════ viewer
export function createViewer(container, opts = {}) {
  injectCss();
  let dark = !!opts.dark;
  let T = THEMES[dark ? 'dark' : 'light'];
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  // renderer + overlays
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
  container.appendChild(canvas);
  const root = document.createElement('div');
  root.className = 's3d-root' + (dark ? ' s3d-dark' : '');
  container.appendChild(root);
  const css2d = new CSS2DRenderer();
  css2d.domElement.className = 's3d-labels';
  root.appendChild(css2d.domElement);
  const tip = document.createElement('div');
  tip.className = 's3d-tip';
  root.appendChild(tip);
  // screen-space compass (always visible; the ground compass can be hidden behind the building)
  const hud = document.createElement('div');
  hud.className = 's3d-hud';
  hud.title = tr('指北针', 'Compass', 'Kompass');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const hudSvg = svgEl('svg', { viewBox: '-29 -29 58 58' });
  hudSvg.append(svgEl('circle', { class: 'dial', r: 21 }));
  const hudRot = svgEl('g', {});
  hudRot.append(svgEl('path', { class: 'n', d: 'M0,-17 L5.5,0 L-5.5,0 Z' }), svgEl('path', { class: 's', d: 'M0,17 L5.5,0 L-5.5,0 Z' }));
  const hudN = svgEl('text', { x: 0, y: -25 });
  hudN.textContent = DIR_ZH.N;
  const hudSun = svgEl('circle', { class: 'sun', r: 3.6 });
  hudSun.style.display = 'none';
  hudSvg.append(hudRot, hudN, hudSun);
  hud.appendChild(hudSvg);
  root.appendChild(hud);

  // scene, camera, controls
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(T.bg);
  scene.fog = new THREE.Fog(T.bg, 300, 1200);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 4000);
  camera.position.set(-50, 40, 50);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 3;
  controls.maxDistance = 1500;
  controls.screenSpacePanning = true;

  // lights
  const hemi = new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemi);
  const key = new THREE.DirectionalLight(0xffffff, T.key); // soft default light, no shadows
  key.position.copy(P2T(Math.sin(205 * DEG) * Math.cos(50 * DEG), Math.cos(205 * DEG) * Math.cos(50 * DEG), Math.sin(50 * DEG)).multiplyScalar(100));
  const sun = new THREE.DirectionalLight(0xfff8ee, T.sunI);
  sun.visible = false;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 2.5;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, key, key.target, sun, sun.target);

  // shared materials
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, ...extra });
  const hatchCv = document.createElement('canvas');
  hatchCanvas(hatchCv, T.partyBase, T.partyLine);
  const hatchTex = new THREE.CanvasTexture(hatchCv);
  hatchTex.wrapS = hatchTex.wrapT = THREE.RepeatWrapping;
  hatchTex.colorSpace = THREE.SRGBColorSpace;
  hatchTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const M = {
    band: std(T.band, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    frame: std(T.frame, { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    gable: std(T.gable),
    edge: new THREE.LineBasicMaterial({ color: T.edge, transparent: true, opacity: 0.45 }),
    nb: std(T.nb, { transparent: true, opacity: T.nbOpacity, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    nbHover: std(T.nbHover, { transparent: true, opacity: Math.min(1, T.nbOpacity + 0.2), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    nbSel: std(T.nbSel, { transparent: true, opacity: Math.min(1, T.nbOpacity + 0.3), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    nbEdge: new THREE.LineBasicMaterial({ color: T.nbEdge, transparent: true, opacity: 0.55 }),
    ground: new THREE.MeshStandardMaterial({ color: T.ground, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
    compass: new THREE.MeshBasicMaterial({ color: T.compass, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    compassN: new THREE.MeshBasicMaterial({ color: T.compassN, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    sunDisc: new THREE.MeshBasicMaterial({ color: T.sun, fog: false }),
    sunMark: new THREE.MeshBasicMaterial({ color: T.sun, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    sunLine: new THREE.LineDashedMaterial({ color: T.sun, dashSize: 1, gapSize: 0.6, transparent: true, opacity: 0.9, fog: false }),
    outline: new THREE.LineBasicMaterial({ color: T.outline, transparent: true, opacity: 1, depthTest: true }),
    outlineX: new THREE.LineBasicMaterial({ color: T.outline, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false }),
  };

  // static world: ground, grid, groups
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), M.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  let grid = null;
  const bld = new THREE.Group();      // building meshes (rebuilt per setBuilding)
  const nbg = new THREE.Group();      // neighbours
  const deco = new THREE.Group();     // compass (rebuilt per building)
  const sunG = new THREE.Group();     // sun indicator
  const outlineG = new THREE.Group(); // highlight outline
  scene.add(bld, nbg, deco, sunG, outlineG);

  // state
  let model = null, bounds = null, info = null;
  const elements = new Map();  // id → element record
  let pickables = [];
  let ownMats = [];            // per-building materials, disposed on rebuild
  let coloring = null, sunState = null, hoverId = null, selectedId = null, pickCb = null;
  let dirty = true, raf = 0, disposed = false, lastBuildMs = 0;
  const raycaster = new THREE.Raycaster();
  let occluders = [];          // opaque building meshes that hide ground labels
  const groundLabels = [];     // CSS2DObjects on the ground (compass letters)

  // ───────────────────────────── sizing / loop
  function resize() {
    if (disposed) return;
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    css2d.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  function onCameraChange() {
    const dist = camera.position.distanceTo(controls.target);
    const rs = bounds ? bounds.rScene : 100;
    camera.near = Math.max(0.1, Math.min(5, dist * 0.01));
    camera.far = dist + (bounds ? bounds.groundSize : 3000);
    camera.updateProjectionMatrix();
    scene.fog.near = dist + rs * 0.6 + 40;
    scene.fog.far = scene.fog.near + Math.max(350, rs * 3.5);
    updateHud();
    dirty = true;
  }
  const hudA = new THREE.Vector3(), hudB = new THREE.Vector3();
  /** Screen angle (rad, clockwise from screen-up) of a horizontal local direction at the orbit target. */
  function screenAngle(dx, dy) {
    hudA.copy(controls.target).project(camera);
    hudB.copy(controls.target).add(new THREE.Vector3(dx, 0, -dy)).project(camera);
    return Math.atan2((hudB.x - hudA.x) * camera.aspect, hudB.y - hudA.y);
  }
  function updateHud() {
    const a = screenAngle(0, 1);
    hudRot.setAttribute('transform', `rotate(${(a / DEG).toFixed(1)})`);
    hudN.setAttribute('x', (Math.sin(a) * 25.5).toFixed(1));
    hudN.setAttribute('y', (-Math.cos(a) * 25.5).toFixed(1));
    if (sunState && sunState.altitude > 0) {
      const b = screenAngle(Math.sin(sunState.azimuth * DEG), Math.cos(sunState.azimuth * DEG));
      const r = 21 * (1 - Math.min(1, sunState.altitude / 90) * 0.75);
      hudSun.setAttribute('cx', (Math.sin(b) * r).toFixed(1));
      hudSun.setAttribute('cy', (-Math.cos(b) * r).toFixed(1));
      hudSun.style.display = '';
    } else hudSun.style.display = 'none';
  }
  controls.addEventListener('change', onCameraChange);
  const occRay = new THREE.Raycaster();
  const occV = new THREE.Vector3();
  function occludeLabels() {
    // CSS2D labels are drawn on top of everything; hide ground labels that sit behind the building
    for (const o of groundLabels) {
      o.getWorldPosition(occV);
      const d = occV.distanceTo(camera.position);
      occRay.set(camera.position, occV.sub(camera.position).normalize());
      occRay.far = d - 0.3;
      const hidden = occluders.length > 0 && occRay.intersectObjects(occluders, false).length > 0;
      o.element.style.opacity = hidden ? '0' : '1';
    }
  }
  function loop() {
    raf = requestAnimationFrame(loop);
    const moved = controls.update();
    if (moved || dirty) {
      dirty = false;
      occludeLabels();
      renderer.render(scene, camera);
      css2d.render(scene, camera);
    }
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  resize();
  raf = requestAnimationFrame(loop);

  // ───────────────────────────── building
  function disposeObject(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isCSS2DObject && o.element) o.element.remove();
    });
  }
  function clearGroup(g) {
    for (const c of [...g.children]) { g.remove(c); disposeObject(c); }
  }
  function clearBuilding() {
    clearGroup(bld); clearGroup(nbg); clearGroup(deco); clearGroup(outlineG);
    ownMats.forEach((m) => m.dispose());
    ownMats = [];
    elements.clear();
    pickables = [];
    occluders = [];
    model = null; bounds = null; info = null;
    hoverId = null; selectedId = null;
    hideTip();
  }
  const own = (m) => { ownMats.push(m); return m; };

  function setBuilding(bm) {
    const t0 = performance.now();
    clearBuilding();
    if (!bm) { clearGroup(sunG); dirty = true; return; }
    const outer0 = cleanRing(bm.outer);
    if (!outer0) throw new Error('scene3d.setBuilding: model.outer needs at least 3 distinct points');
    const outer = orientRing(outer0, true);
    const holes = (bm.holes || []).map(cleanRing).filter(Boolean).map((h) => orientRing(h, false));
    const rings = [outer, ...holes];
    const H = Math.max(0.5, +bm.height || 10);
    const floors = Math.max(1, Math.round(+bm.floors || Math.max(1, H / 3)));
    const fhIn = +bm.floorHeight;
    const fh = fhIn > 0.5 && fhIn * floors <= H + 0.05 ? fhIn : H / floors; // storeys must fit below the eaves
    const shape = bm.roof?.shape || 'flat';
    const R = shape !== 'flat' ? Math.max(0, +bm.roof?.ridgeHeight || 0) : 0;
    const facades = prepFacades(Array.isArray(bm.facades) && bm.facades.length ? bm.facades : deriveFacades(rings), outer, holes);
    const footArea = Math.abs(ringArea(outer)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
    model = bm;
    info = { H, floors, fh, R, shape, footArea, facades: new Map(), roofMode: 'flat', roofInset: 0 };

    // ── walls, windows, bands, edge lines
    const bandB = new GeoBuilder();
    const lines = [];
    for (const f of facades) {
      const reg = facadeRegions(f, H);
      const P = (s, z, off = 0) => [f.a[0] + f.u[0] * s + f.n[0] * off, f.a[1] + f.u[1] * s + f.n[1] * off, z];
      const hint = [f.n[0], f.n[1], 0];
      const label = tr(`${f.ring > 0 ? '内院' : ''}${DIR_ZH[f.orient] || ''}立面 ${f.id}`, `${f.ring > 0 ? 'Courtyard ' : ''}${DIR_ZH[f.orient] ? DIR_ZH[f.orient] + ' ' : ''}facade ${f.id}`, `${f.ring > 0 ? 'Hoffassade ' : 'Fassade '}${DIR_ZH[f.orient] ? DIR_ZH[f.orient] + ' ' : ''}${f.id}`);
      const el = { id: f.id, kind: 'facade', label, f, meshes: [], outlineMeshes: [], colorMats: [], tintMats: [], neutral: 'wall', reg };
      const wallB = new GeoBuilder(), partyB = new GeoBuilder();
      for (const r of reg.exp) {
        wallB.quad(P(r.s0, r.z0), P(r.s1, r.z0), P(r.s1, r.z1), P(r.s0, r.z1), hint, 0);
        for (let k = 1; k < floors; k++) {
          const z = k * fh;
          if (z <= r.z0 + 0.15 || z >= r.z1 - 0.15) continue;
          bandB.quad(P(r.s0, z - BAND_H / 2, BAND_OFF), P(r.s1, z - BAND_H / 2, BAND_OFF), P(r.s1, z + BAND_H / 2, BAND_OFF), P(r.s0, z + BAND_H / 2, BAND_OFF), hint);
        }
        if (r.z1 >= H - 1e-3) bandB.quad(P(r.s0, H - CORNICE_H, CORNICE_OFF), P(r.s1, H - CORNICE_H, CORNICE_OFF), P(r.s1, H, CORNICE_OFF), P(r.s0, H, CORNICE_OFF), hint);
        if (r.above) pushLine(lines, P(r.s0, r.z0, 0.01), P(r.s1, r.z0, 0.01));
      }
      for (const r of reg.party) {
        const S = 1.6; // hatch repeat in metres
        partyB.quad(P(r.s0, 0), P(r.s1, 0), P(r.s1, r.z1), P(r.s0, r.z1), hint, 0,
          [[r.s0 / S, 0], [r.s1 / S, 0], [r.s1 / S, r.z1 / S], [r.s0 / S, r.z1 / S]]);
        for (const s of [r.s0, r.s1]) if (s > 1e-3 && s < f.L - 1e-3) pushLine(lines, P(s, 0, 0.01), P(s, H, 0.01));
      }
      if (wallB.count) {
        const mat = own(std(T.wall));
        const mesh = new THREE.Mesh(wallB.build(), mat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.pick = { kind: 'facade', id: f.id, part: 'wall' };
        bld.add(mesh);
        el.meshes.push(mesh); el.outlineMeshes.push(mesh); el.colorMats.push(mat);
      }
      if (partyB.count) {
        const mat = own(std('#ffffff', { map: hatchTex, roughness: 0.97 }));
        const mesh = new THREE.Mesh(partyB.build(), mat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.pick = { kind: 'facade', id: f.id, part: 'party' };
        bld.add(mesh);
        el.meshes.push(mesh); el.outlineMeshes.push(mesh); el.tintMats.push(mat);
      }
      elements.set(f.id, el);

      // windows
      const win = layoutWindows(f, reg, H, floors, fh);
      info.facades.set(f.id, { target: win.target, built: win.built, panes: win.panes.length, Aexp: win.Aexp, wwr: f.wwr });
      if (win.panes.length) {
        const gB = new GeoBuilder(), fB = new GeoBuilder();
        for (const p of win.panes) {
          const x0 = p.c - p.w / 2, x1 = p.c + p.w / 2, z0 = p.z0, z1 = p.z0 + p.h;
          gB.quad(P(x0, z0, GLASS_OFF), P(x1, z0, GLASS_OFF), P(x1, z1, GLASS_OFF), P(x0, z1, GLASS_OFF), hint);
          fB.quad(P(x0 - FRAME_W, z0 - FRAME_W, FRAME_OFF), P(x1 + FRAME_W, z0 - FRAME_W, FRAME_OFF), P(x1 + FRAME_W, z1 + FRAME_W, FRAME_OFF), P(x0 - FRAME_W, z1 + FRAME_W, FRAME_OFF), hint);
        }
        const gm = own(std(T.glass, { roughness: 0.35, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        const glass = new THREE.Mesh(gB.build(), gm);
        const frame = new THREE.Mesh(fB.build(), M.frame);
        const wid = `${f.id}:win`;
        for (const m of [glass, frame]) { m.receiveShadow = true; m.castShadow = false; m.userData.pick = { kind: 'window', id: wid }; bld.add(m); }
        elements.set(wid, { id: wid, kind: 'window', label: `${label}`, f, win, meshes: [glass, frame], outlineMeshes: [glass], colorMats: [gm], tintMats: [], neutral: 'glass' });
      }
    }
    if (bandB.count) {
      const bands = new THREE.Mesh(bandB.build(), M.band);
      bands.receiveShadow = true;
      bld.add(bands);
    }
    // building outline lines: vertical corners, eaves line, base line (1 cm outside the faces)
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[(i - 1 + n) % n], v = ring[i], q = ring[(i + 1) % n];
        const l1 = Math.hypot(v[0] - p[0], v[1] - p[1]), l2 = Math.hypot(q[0] - v[0], q[1] - v[1]);
        const n1 = [(v[1] - p[1]) / l1, -(v[0] - p[0]) / l1], n2 = [(q[1] - v[1]) / l2, -(q[0] - v[0]) / l2];
        let bx = n1[0] + n2[0], by = n1[1] + n2[1];
        const bl = Math.hypot(bx, by) || 1;
        bx = (bx / bl) * 0.012; by = (by / bl) * 0.012;
        pushLine(lines, [v[0] + bx, v[1] + by, 0], [v[0] + bx, v[1] + by, H]);
        const ox = n2[0] * 0.012, oy = n2[1] * 0.012;
        pushLine(lines, [v[0] + ox, v[1] + oy, H + 0.005], [q[0] + ox, q[1] + oy, H + 0.005]);
      }
    }

    // ── plinth = ground floor (kind "floor")
    {
      const ws = rings.map((r, k) => ringWeights(r, k, facades));
      let res = null;
      for (const d of [-PLINTH_OUT, -0.2, -0.1, -0.03]) { res = offsetRings(rings, ws, d); if (res) break; }
      const gb = new GeoBuilder();
      if (res) {
        res.polys.forEach((poly, k) => {
          const w = ws[k], { A, B, N } = res.offs[k], n = rings[k].length;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            if (w[i] > 0) gb.quad([B[i][0], B[i][1], 0], [A[j][0], A[j][1], 0], [A[j][0], A[j][1], PLINTH_H], [B[i][0], B[i][1], PLINTH_H], [N[i][0], N[i][1], 0]);
            if (!near(A[i], B[i], 1e-6)) {
              const u = res.offs[k].U[i], s = w[(i - 1 + n) % n] - w[i];
              gb.quad([A[i][0], A[i][1], 0], [B[i][0], B[i][1], 0], [B[i][0], B[i][1], PLINTH_H], [A[i][0], A[i][1], PLINTH_H], [u[0] * s, u[1] * s, 0]);
            }
          }
        });
        gb.polygon(res.polys[0], res.polys.slice(1), PLINTH_H, true);
      } else {
        gb.polygon(outer, holes, 0.03, true);
      }
      const mat = own(std(T.floor, { roughness: 0.95 }));
      const mesh = new THREE.Mesh(gb.build(), mat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.pick = { kind: 'floor', id: 'floor' };
      bld.add(mesh);
      elements.set('floor', { id: 'floor', kind: 'floor', label: tr('地面/底板', 'Ground floor / slab', 'Boden / Bodenplatte'), meshes: [mesh], outlineMeshes: [mesh], colorMats: [mat], tintMats: [], neutral: 'floor' });
    }

    // ── roof
    {
      let gb = new GeoBuilder(2);
      let mode = 'flat';
      if (R > 0.05) {
        try {
          if (!holes.length) {
            const rect = minAreaRect(outer);
            if (rect && footArea / (4 * rect.hu * rect.hv) >= RECT_RATIO) {
              // gable ends go to the rectangle sides that carry most party wall; else ridge along the long axis
              let pu = 0, pv = 0;
              for (const f of facades) {
                const party = f.segs.reduce((s, g) => s + (g.exposed ? 0 : (g.t1 - g.t0) * f.L), 0);
                if (Math.abs(f.n[0] * rect.u[0] + f.n[1] * rect.u[1]) > 0.8) pu += party;
                else if (Math.abs(f.n[0] * rect.v[0] + f.n[1] * rect.v[1]) > 0.8) pv += party;
              }
              const alongU = pu > pv + 0.5 ? true : pv > pu + 0.5 ? false : rect.hu >= rect.hv;
              rectRoof(gb, rect, H, R, shape === 'gabled', alongU);
              mode = shape === 'gabled' ? 'rect-gabled' : 'rect-hipped';
            }
          }
          if (mode === 'flat') {
            let ws = rings.map((r, k) => ringWeights(r, k, facades));
            if (ws.every((w) => w.every((x) => x === 0))) ws = ws.map((w) => w.map(() => 1));
            const d = insetRoof(gb, rings, ws, H, R);
            if (d > 0) { mode = 'inset'; info.roofInset = d; } else { gb = new GeoBuilder(2); mode = 'flat-fallback'; }
          }
        } catch (err) {
          console.warn('scene3d: pitched roof failed, using flat cap', err);
          gb = new GeoBuilder(2);
          mode = 'flat-fallback';
        }
      }
      if (mode === 'flat' || mode === 'flat-fallback') gb.polygon(outer, holes, H, true, 0);
      info.roofMode = mode;
      const mat = own(std(T.roof, { roughness: 0.85, side: THREE.FrontSide }));
      const geo = gb.build();
      const mesh = new THREE.Mesh(geo, [mat, M.gable]);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.pick = { kind: 'roof', id: 'roof' };
      bld.add(mesh);
      elements.set('roof', { id: 'roof', kind: 'roof', label: tr('屋顶', 'Roof', 'Dach'), meshes: [mesh], outlineMeshes: [mesh], colorMats: [mat], tintMats: [], neutral: 'roof' });
      const eg = new THREE.EdgesGeometry(geo, 20);
      const ea = eg.attributes.position.array;
      for (let i = 0; i < ea.length; i++) lines.push(ea[i]);
      eg.dispose();
    }
    const edgeLines = new THREE.LineSegments(lineGeo(lines), M.edge);
    bld.add(edgeLines);

    // ── neighbours
    let nbBox = null;
    const nbEdges = [];
    (bm.neighbors || []).forEach((nb, idx) => {
      const o = cleanRing(nb?.outer);
      if (!o) return;
      const no = orientRing(o, true);
      const nh = (nb.holes || []).map(cleanRing).filter(Boolean).map((h) => orientRing(h, false));
      const h = Math.max(0.5, +nb.height || 10);
      const gb = new GeoBuilder();
      for (const ring of [no, ...nh]) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          gb.quad([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], h], [(b[1] - a[1]) / L, -(b[0] - a[0]) / L, 0]);
        }
      }
      gb.polygon(no, nh, h, true);
      const geo = gb.build();
      const c = new THREE.Vector3();
      geo.boundingBox.getCenter(c);
      geo.translate(-c.x, -c.y, -c.z);
      const mesh = new THREE.Mesh(geo, M.nb);
      mesh.position.copy(c);
      mesh.castShadow = mesh.receiveShadow = true;
      const id = String(nb.id ?? `nb${idx}`);
      mesh.userData.pick = { kind: 'neighbor', id };
      nbg.add(mesh);
      elements.set(id, { id, kind: 'neighbor', label: tr(`邻楼 ${id}`, `Neighbour ${id}`, `Nachbargebäude ${id}`), nb: { height: h }, meshes: [mesh], outlineMeshes: [mesh], colorMats: [], tintMats: [] });
      const eg = new THREE.EdgesGeometry(geo, 30);
      const ea = eg.attributes.position.array;
      for (let i = 0; i < ea.length; i += 3) nbEdges.push(ea[i] + c.x, ea[i + 1] + c.y, ea[i + 2] + c.z);
      eg.dispose();
      for (const [x, y] of no) {
        if (!nbBox) nbBox = { x0: x, x1: x, y0: y, y1: y, z1: h };
        nbBox.x0 = Math.min(nbBox.x0, x); nbBox.x1 = Math.max(nbBox.x1, x);
        nbBox.y0 = Math.min(nbBox.y0, y); nbBox.y1 = Math.max(nbBox.y1, y);
        nbBox.z1 = Math.max(nbBox.z1, h);
      }
    });
    if (nbEdges.length) nbg.add(new THREE.LineSegments(lineGeo(nbEdges), M.nbEdge));

    pickables = [];
    for (const g of [bld, nbg]) g.traverse((o) => { if (o.isMesh && o.userData.pick) pickables.push(o); });
    occluders = bld.children.filter((o) => o.isMesh && (o.userData.pick?.kind === 'facade' || o.userData.pick?.kind === 'roof'));

    // ── bounds, ground, compass, camera
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, top = H + R;
    const rFoot = Math.max(...outer.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const rBuilding = Math.hypot(x1 - x0, y1 - y0, top) / 2;
    let rScene = rFoot + 20;
    const CAP = 220;
    const sb = { x0, x1, y0, y1, z1: top };
    if (nbBox) {
      sb.x0 = Math.max(cx - CAP, Math.min(sb.x0, nbBox.x0)); sb.x1 = Math.min(cx + CAP, Math.max(sb.x1, nbBox.x1));
      sb.y0 = Math.max(cy - CAP, Math.min(sb.y0, nbBox.y0)); sb.y1 = Math.min(cy + CAP, Math.max(sb.y1, nbBox.y1));
      sb.z1 = Math.max(sb.z1, nbBox.z1);
      rScene = Math.max(rScene, Math.hypot(sb.x1 - sb.x0, sb.y1 - sb.y0) / 2);
    }
    const rCompass = rFoot + Math.max(3, rFoot * 0.18);
    const groundSize = Math.max(1600, rScene * 10);
    bounds = { cx, cy, top, H, R, rFoot, rBuilding, rScene, rCompass, groundSize, shadowBox: sb };
    ground.scale.set(groundSize, groundSize, 1);
    ground.position.copy(P2T(cx, cy, 0));
    rebuildGrid();
    buildCompass();
    frameCamera();
    if (sunState) applySun(); else clearGroup(sunG);
    applyStyles();
    lastBuildMs = performance.now() - t0;
    dirty = true;
  }

  function rebuildGrid() {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
    if (!bounds) return;
    const size = Math.max(100, Math.ceil((bounds.rScene * 2.6) / 20) * 20);
    const step = size > 400 ? 10 : 5;
    grid = new THREE.GridHelper(size, size / step, T.grid1, T.grid2);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.material.depthWrite = false;
    grid.position.copy(P2T(Math.round(bounds.cx / step) * step, Math.round(bounds.cy / step) * step, 0.004));
    grid.renderOrder = -1;
    scene.add(grid);
  }

  function buildCompass() {
    clearGroup(deco);
    groundLabels.length = 0;
    if (!bounds) return;
    const { cx, cy, rCompass: rc } = bounds;
    const w = Math.max(0.08, rc * 0.006);
    const ringG = new THREE.RingGeometry(rc - w, rc + w, 128);
    ringG.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringG, M.compass);
    ring.position.copy(P2T(cx, cy, 0.02));
    ring.renderOrder = 1;
    deco.add(ring);
    // ticks
    const gb = new GeoBuilder();
    for (let a = 0; a < 360; a += 15) {
      const len = a % 90 === 0 ? rc * 0.07 : rc * 0.03;
      const s = Math.sin(a * DEG), c = Math.cos(a * DEG);
      const tw = a % 90 === 0 ? w * 1.4 : w * 0.8;
      const p0 = [cx + s * (rc - len), cy + c * (rc - len)], p1 = [cx + s * rc, cy + c * rc];
      const ox = c * tw, oy = -s * tw;
      gb.quad([p0[0] - ox, p0[1] - oy, 0.02], [p1[0] - ox, p1[1] - oy, 0.02], [p1[0] + ox, p1[1] + oy, 0.02], [p0[0] + ox, p0[1] + oy, 0.02], [0, 0, 1]);
    }
    const ticks = new THREE.Mesh(gb.build(), M.compass);
    ticks.renderOrder = 1;
    deco.add(ticks);
    // north arrow
    const ab = new GeoBuilder();
    const L = Math.max(1.6, rc * 0.12), W = L * 0.45;
    const tipP = [cx, cy + rc + L * 1.15, 0.025], bl = [cx - W / 2, cy + rc + L * 0.1, 0.025], br = [cx + W / 2, cy + rc + L * 0.1, 0.025], notch = [cx, cy + rc + L * 0.4, 0.025];
    ab.tri(bl, notch, tipP, [0, 0, 1]);
    ab.tri(notch, br, tipP, [0, 0, 1]);
    const arrow = new THREE.Mesh(ab.build(), M.compassN);
    arrow.renderOrder = 1;
    deco.add(arrow);
    const lbl = (txt, az, r, cls) => {
      const el = document.createElement('div');
      el.className = 's3d-lbl' + (cls ? ` ${cls}` : '');
      el.textContent = txt;
      const o = new CSS2DObject(el);
      o.position.copy(P2T(cx + Math.sin(az * DEG) * r, cy + Math.cos(az * DEG) * r, 0.05));
      deco.add(o);
      groundLabels.push(o);
    };
    lbl(DIR_ZH.N, 0, rc + L * 1.75, 'n');
    lbl(DIR_ZH.E, 90, rc + L * 0.7);
    lbl(DIR_ZH.S, 180, rc + L * 0.7);
    lbl(DIR_ZH.W, 270, rc + L * 0.7);
  }

  function frameCamera() {
    if (!bounds) return;
    const vfov = camera.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const r = Math.max(bounds.rBuilding, bounds.rCompass * 0.92);
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.45;
    const el = 28 * DEG, az = 225 * DEG;
    const tgt = [bounds.cx, bounds.cy, bounds.top * 0.3];
    controls.target.copy(P2T(...tgt));
    camera.position.copy(P2T(tgt[0] + Math.sin(az) * Math.cos(el) * dist, tgt[1] + Math.cos(az) * Math.cos(el) * dist, tgt[2] + Math.sin(el) * dist));
    controls.maxDistance = Math.max(300, dist * 8);
    controls.update();
    onCameraChange();
  }

  // ───────────────────────────── styles (coloring, hover, highlight, theme)
  const tmpC = new THREE.Color();
  const accent = new THREE.Color();
  function addGlow(m, glow, sel) {
    if (!glow) return;
    if (sel) { accent.set(T.outline); m.emissive.r += accent.r * glow * 2.2; m.emissive.g += accent.g * glow * 2.2; m.emissive.b += accent.b * glow * 2.2; m.emissive.addScalar(glow * 0.35); }
    else m.emissive.addScalar(glow);
  }
  function valueOf(id) {
    if (!coloring || !coloring.values || typeof coloring.colorFn !== 'function') return null;
    const v = coloring.values[id];
    if (v == null || v === '' || !Number.isFinite(+v)) return null;
    return +v;
  }
  function applyStyles() {
    for (const el of elements.values()) {
      const sel = el.id === selectedId;
      const glow = sel ? T.selGlow : el.id === hoverId ? T.hoverGlow : 0;
      if (el.kind === 'neighbor') {
        el.meshes[0].material = el.id === selectedId ? M.nbSel : el.id === hoverId ? M.nbHover : M.nb;
        continue;
      }
      const v = valueOf(el.id);
      let colored = false;
      if (v != null) {
        try { tmpC.set(coloring.colorFn(v)); colored = true; } catch (err) { colored = false; }
      }
      for (const m of el.colorMats) {
        if (colored) {
          m.color.copy(tmpC);
          m.emissive.copy(tmpC).multiplyScalar(0.22);
        } else {
          m.color.set(T[el.neutral]);
          m.emissive.setRGB(0, 0, 0);
        }
        addGlow(m, glow, sel);
      }
      for (const m of el.tintMats) { m.emissive.setRGB(0, 0, 0); addGlow(m, glow, sel); }
    }
    dirty = true;
  }
  function setColoring(c) {
    coloring = c && typeof c === 'object' ? { values: c.values || {}, colorFn: c.colorFn, format: c.format } : null;
    applyStyles();
  }
  function setHover(id) {
    if (hoverId === id) return;
    hoverId = id;
    applyStyles();
  }
  function highlight(id) {
    selectedId = id != null && elements.has(String(id)) ? String(id) : null;
    clearGroup(outlineG);
    if (selectedId) {
      const el = elements.get(selectedId);
      const pos = [];
      for (const mesh of el.outlineMeshes) outlineEdges(mesh.geometry, pos, 25, 0.04, mesh.position);
      const geo = lineGeo(pos);
      const front = new THREE.LineSegments(geo, M.outline);
      front.renderOrder = 20;
      const xray = new THREE.LineSegments(geo, M.outlineX);
      xray.renderOrder = 21;
      outlineG.add(front, xray);
    }
    applyStyles();
  }

  function setTheme(t) {
    dark = !!(t && t.dark);
    T = THEMES[dark ? 'dark' : 'light'];
    root.classList.toggle('s3d-dark', dark);
    scene.background.set(T.bg);
    scene.fog.color.set(T.bg);
    hemi.color.set(T.hemiSky);
    hemi.groundColor.set(T.hemiGround);
    sun.intensity = T.sunI;
    key.intensity = T.key;
    M.band.color.set(T.band); M.frame.color.set(T.frame); M.gable.color.set(T.gable);
    M.edge.color.set(T.edge); M.nbEdge.color.set(T.nbEdge);
    M.nb.color.set(T.nb); M.nb.opacity = T.nbOpacity;
    M.nbHover.color.set(T.nbHover); M.nbSel.color.set(T.nbSel);
    M.ground.color.set(T.ground);
    M.compass.color.set(T.compass); M.compassN.color.set(T.compassN);
    M.sunDisc.color.set(T.sun); M.sunMark.color.set(T.sun); M.sunLine.color.set(T.sun);
    M.outline.color.set(T.outline); M.outlineX.color.set(T.outline);
    hatchCanvas(hatchCv, T.partyBase, T.partyLine);
    hatchTex.needsUpdate = true;
    rebuildGrid();
    applySun(); // light levels + indicator colours depend on the theme
    applyStyles();
  }

  // ───────────────────────────── sun
  function setSun(s) {
    if (s && Number.isFinite(+s.azimuth) && Number.isFinite(+s.altitude)) sunState = { azimuth: +s.azimuth, altitude: +s.altitude };
    else sunState = null;
    applySun();
  }
  function applySun() {
    clearGroup(sunG);
    updateHud();
    if (!sunState) {
      sun.visible = false;
      key.visible = true;
      hemi.intensity = T.hemi;
      dirty = true;
      return;
    }
    const alt = Math.max(-90, Math.min(89.5, sunState.altitude)), az = sunState.azimuth;
    const up = alt > 0;
    const dl = [Math.sin(az * DEG) * Math.cos(alt * DEG), Math.cos(az * DEG) * Math.cos(alt * DEG), Math.sin(alt * DEG)];
    key.visible = false;
    sun.visible = up;
    // dim sky when the sun is low or below the horizon
    hemi.intensity = up ? T.hemiSun * (0.75 + 0.25 * Math.min(1, alt / 20)) : T.hemi * 0.7; // night stays readable
    if (bounds) {
      const b = bounds;
      const cT = P2T((b.shadowBox.x0 + b.shadowBox.x1) / 2, (b.shadowBox.y0 + b.shadowBox.y1) / 2, 0);
      if (up) fitShadow(dl, cT);
      // indicator: sun disc + dashed ray to the building, marker on the compass ring, label
      const centre = [b.cx, b.cy, b.top * 0.5];
      const Rs = Math.max(b.rBuilding * 1.35, b.rCompass * 1.05);
      const label = document.createElement('div');
      label.className = 's3d-sunlbl';
      label.textContent = up ? tr(`太阳 · 方位 ${Math.round(az)}° · 高度 ${Math.round(alt)}°`, `Sun · azimuth ${Math.round(az)}° · altitude ${Math.round(alt)}°`, `Sonne · Azimut ${Math.round(az)}° · Höhenwinkel ${Math.round(alt)}°`) : tr(`太阳在地平线以下 · 方位 ${Math.round(az)}° · 高度 ${Math.round(alt)}°`, `Sun below the horizon · azimuth ${Math.round(az)}° · altitude ${Math.round(alt)}°`, `Sonne unter dem Horizont · Azimut ${Math.round(az)}° · Höhenwinkel ${Math.round(alt)}°`);
      const lo = new CSS2DObject(label);
      if (up) {
        const sp = [centre[0] + dl[0] * Rs, centre[1] + dl[1] * Rs, centre[2] + dl[2] * Rs];
        const disc = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.5, b.rBuilding * 0.045), 24, 16), M.sunDisc);
        disc.position.copy(P2T(...sp));
        const lg = new THREE.BufferGeometry().setFromPoints([P2T(...sp), P2T(b.cx, b.cy, b.top)]);
        const ray = new THREE.Line(lg, M.sunLine);
        ray.computeLineDistances();
        M.sunLine.dashSize = Math.max(0.5, Rs * 0.04);
        M.sunLine.gapSize = M.sunLine.dashSize * 0.6;
        lo.position.copy(P2T(sp[0], sp[1], sp[2] + Math.max(1.2, b.rBuilding * 0.09)));
        sunG.add(disc, ray);
      } else {
        lo.position.copy(P2T(b.cx + Math.sin(az * DEG) * b.rCompass * 1.12, b.cy + Math.cos(az * DEG) * b.rCompass * 1.12, 0.1));
      }
      sunG.add(lo);
      // azimuth marker on the compass ring (triangle pointing at the building)
      const rc = b.rCompass, s = Math.sin(az * DEG), c = Math.cos(az * DEG), m = Math.max(0.7, rc * 0.06);
      const mb = new GeoBuilder();
      const tipM = [b.cx + s * (rc - m * 0.2), b.cy + c * (rc - m * 0.2), 0.03];
      const l = [b.cx + s * (rc + m) - c * m * 0.5, b.cy + c * (rc + m) + s * m * 0.5, 0.03];
      const r = [b.cx + s * (rc + m) + c * m * 0.5, b.cy + c * (rc + m) - s * m * 0.5, 0.03];
      mb.tri(tipM, l, r, [0, 0, 1]);
      const mark = new THREE.Mesh(mb.build(), M.sunMark);
      mark.renderOrder = 2;
      sunG.add(mark);
    }
    dirty = true;
  }
  function fitShadow(dl, cT) {
    const b = bounds, sb = b.shadowBox;
    const dir = new THREE.Vector3(dl[0], dl[2], -dl[1]).normalize();
    const span = Math.hypot(sb.x1 - sb.x0, sb.y1 - sb.y0, sb.z1) + 10;
    sun.position.copy(cT).addScaledVector(dir, span);
    sun.target.position.copy(cT);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.position.copy(sun.position);
    cam.lookAt(cT);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    const v = new THREE.Vector3();
    const sinA = Math.max(Math.sin(3 * DEG), dl[2]);
    const addP = (x, y, z) => {
      v.copy(P2T(x, y, z)).applyMatrix4(inv);
      mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x); mny = Math.min(mny, v.y); mxy = Math.max(mxy, v.y); mnz = Math.min(mnz, v.z); mxz = Math.max(mxz, v.z);
    };
    for (const x of [sb.x0, sb.x1]) for (const y of [sb.y0, sb.y1]) {
      addP(x, y, 0);
      addP(x, y, sb.z1);
      // where the top corner's shadow lands on the ground (extends only the depth range)
      const k = Math.min(600, sb.z1 / sinA);
      addP(x - dl[0] * k, y - dl[1] * k, 0);
    }
    const m = 2;
    cam.left = mnx - m; cam.right = mxx + m; cam.bottom = mny - m; cam.top = mxy + m;
    cam.near = Math.max(0.1, -mxz - m);
    cam.far = -mnz + m;
    cam.updateProjectionMatrix();
    const extent = Math.max(cam.right - cam.left, cam.top - cam.bottom);
    const size = extent > 140 ? 4096 : 2048;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    const texel = extent / size;
    sun.shadow.normalBias = Math.max(0.01, texel * 1.2);
    sun.shadow.bias = -0.0002;
    sun.shadow.needsUpdate = true;
  }

  // ───────────────────────────── picking + tooltip
  function ndc(x, y) {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }
  function raycast(x, y) {
    if (!pickables.length) return null;
    raycaster.setFromCamera(ndc(x, y), camera);
    const hits = raycaster.intersectObjects(pickables, false);
    // The building wins over (translucent) neighbours in front of it: party walls sit inside the
    // neighbour's outline and would otherwise never be reachable. Neighbours pick where no building is behind.
    let nb = null;
    for (const h of hits) {
      const p = h.object.userData.pick;
      if (!p) continue;
      if (p.kind !== 'neighbor') return { ...p, point: h.point };
      if (!nb) nb = { ...p, point: h.point };
    }
    return nb;
  }
  function describe(hit) {
    const el = elements.get(hit.id);
    if (!el) return null;
    const lines = [];
    let title = el.label;
    if (el.kind === 'facade') {
      const f = el.f;
      if (hit.part === 'party') {
        title += tr(' · 共用墙', ' · party wall', ' · Gebäudetrennwand');
        const hs = [...new Set(el.reg.party.map((r) => r.nh).filter((h) => h != null))];
        lines.push(tr(`与邻楼相接${hs.length ? `（邻楼高 ${hs.map((h) => fmtNum(h)).join(' / ')} m）` : ''}，此部分不计热损失`, `Joined to a neighbour${hs.length ? ` (neighbour height ${hs.map((h) => fmtNum(h)).join(' / ')} m)` : ''}. No heat loss is counted for this part.`, `An ein Nachbargebäude angebaut${hs.length ? ` (Höhe des Nachbargebäudes ${hs.map((h) => fmtNum(h)).join(' / ')} m)` : ''}. Für diesen Teil wird kein Wärmeverlust angesetzt.`));
      } else {
        title += tr(' · 外墙', ' · external wall', ' · Außenwand');
        const wi = info.facades.get(f.id);
        lines.push(tr(`外露墙面 ${fmtNum(wi ? wi.Aexp : 0)} m² · 窗墙比 ${Math.round(f.wwr * 100)}% · 朝向 ${Math.round((Math.atan2(f.n[0], f.n[1]) / DEG + 360) % 360)}°`, `Exposed wall ${fmtNum(wi ? wi.Aexp : 0)} m² · WWR ${Math.round(f.wwr * 100)}% · azimuth ${Math.round((Math.atan2(f.n[0], f.n[1]) / DEG + 360) % 360)}°`, `Freiliegende Wandfläche ${fmtNum(wi ? wi.Aexp : 0)} m² · Fensterflächenanteil ${Math.round(f.wwr * 100)} % · Azimut ${Math.round((Math.atan2(f.n[0], f.n[1]) / DEG + 360) % 360)}°`));
      }
    } else if (el.kind === 'window') {
      title += tr(' · 窗', ' · window', ' · Fenster');
      lines.push(tr(`窗面积 ${fmtNum(el.win.built)} m² · ${el.win.panes.length} 扇`, `Window area ${fmtNum(el.win.built)} m² · ${el.win.panes.length} panes`, `Fensterfläche ${fmtNum(el.win.built)} m² · ${el.win.panes.length} Fenster`));
    } else if (el.kind === 'roof') {
      const shp = ROOF_ZH[info.shape] || tr('屋顶', 'Roof', 'Dach');
      const approx = info.roofMode === 'inset' ? tr('（近似：截顶坡屋面）', ' (approximated as a truncated hip roof)', ' (angenähert als abgestumpftes Walmdach)') : info.roofMode === 'flat-fallback' ? tr('（近似为平顶）', ' (approximated as flat)', ' (angenähert als Flachdach)') : '';
      lines.push(`${shp}${approx}${info.R > 0 ? ` · ${tr('屋脊高', 'ridge height', 'Firsthöhe')} ${fmtNum(info.R)} m` : ''}${model.roof?.attic ? ` · ${ATTIC_ZH[model.roof.attic] || ''}` : ''}`);
    } else if (el.kind === 'floor') {
      lines.push(`${tr('底板', 'Floor slab', 'Bodenplatte')} ${fmtNum(info.footArea)} m²${model.basement ? ` · ${BASEMENT_ZH[model.basement] || ''}` : ''}`);
    } else if (el.kind === 'neighbor') {
      lines.push(`${tr('高', 'Height', 'Höhe')} ${fmtNum(el.nb.height)} m`);
    }
    let val = null;
    if (hit.part !== 'party') {
      const v = valueOf(el.id);
      if (v != null) {
        let s = null;
        try { s = coloring.format ? coloring.format(v) : null; } catch (err) { s = null; }
        val = s != null ? String(s) : `${tr('数值', 'Value', 'Wert')} ${fmtNum(v, 2)}`;
      }
    }
    return { title, lines, val };
  }
  function showTip(hit, x, y) {
    const d = describe(hit);
    if (!d) { hideTip(); return; }
    tip.replaceChildren();
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = d.title;
    tip.appendChild(t);
    for (const l of d.lines) { const m = document.createElement('div'); m.className = 'm'; m.textContent = l; tip.appendChild(m); }
    if (d.val) { const v = document.createElement('div'); v.className = 'v'; v.textContent = d.val; tip.appendChild(v); }
    const r = container.getBoundingClientRect();
    let px = x - r.left + 14, py = y - r.top + 16;
    tip.classList.add('on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (px + tw > r.width - 4) px = x - r.left - tw - 12;
    if (py + th > r.height - 4) py = y - r.top - th - 12;
    tip.style.transform = `translate(${Math.round(Math.max(4, px))}px, ${Math.round(Math.max(4, py))}px)`;
  }
  function hideTip() { tip.classList.remove('on'); }
  function hoverAt(x, y) {
    const hit = raycast(x, y);
    setHover(hit ? hit.id : null);
    canvas.style.cursor = hit ? 'pointer' : '';
    if (hit) showTip(hit, x, y); else hideTip();
    return hit;
  }
  function clickAt(x, y) {
    const hit = raycast(x, y);
    const pick = hit ? { kind: hit.kind, id: hit.id } : null;
    if (pickCb) { try { pickCb(pick); } catch (err) { console.error(err); } }
    return pick;
  }
  let down = null, pending = null, hoverRaf = 0;
  const onDown = (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const onUp = (e) => {
    if (e.button !== 0 || !down) return;
    const d = down;
    down = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5 && performance.now() - d.t < 800) clickAt(e.clientX, e.clientY);
  };
  const onMove = (e) => {
    if (e.buttons) { hideTip(); return; }
    pending = { x: e.clientX, y: e.clientY };
    if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; if (pending && !disposed) hoverAt(pending.x, pending.y); });
  };
  const onLeave = () => { pending = null; setHover(null); hideTip(); canvas.style.cursor = ''; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  function onPick(cb) {
    pickCb = typeof cb === 'function' ? cb : null;
    return () => { if (pickCb === cb) pickCb = null; };
  }

  // ───────────────────────────── dispose
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    controls.removeEventListener('change', onCameraChange);
    controls.dispose();
    clearBuilding();
    clearGroup(sunG);
    if (grid) { grid.geometry.dispose(); grid.material.dispose(); }
    ground.geometry.dispose();
    Object.values(M).forEach((m) => m.dispose());
    hatchTex.dispose();
    if (sun.shadow.map) sun.shadow.map.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    root.remove();
    pickCb = null;
  }

  // Non-contract hooks for QA pages (not part of CONTRACT §4; may change).
  const _debug = {
    stats() {
      renderer.render(scene, camera); // fresh frame so renderer.info reflects the current scene
      const facades = {};
      if (info) for (const [id, w] of info.facades) facades[id] = { ...w };
      return {
        buildMs: lastBuildMs, roofMode: info?.roofMode, roofInset: info?.roofInset,
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries, facades,
      };
    },
    project(x, y, z) {
      const v = P2T(x, y, z).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    hoverAt, clickAt, frameCamera,
    /** Place the camera in local coordinates. */
    view(pos, target) {
      controls.target.copy(P2T(...target));
      camera.position.copy(P2T(...pos));
      controls.update();
      onCameraChange();
    },
    /** Render n frames synchronously and wait for the GPU; returns ms per frame (rough). */
    benchmark(n = 30) {
      // readPixels after every frame forces the GPU to finish (pipeline stall → upper bound per frame)
      const gl = renderer.getContext(), px = new Uint8Array(4);
      renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.01); // move so nothing is cached
        camera.lookAt(controls.target);
        renderer.render(scene, camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / n;
    },
  };

  return { setBuilding, setColoring, setSun, onPick, highlight, setTheme, resize, dispose, _debug };
}

// Roof and geometry helpers shared with the street walk (js/walk.js)
export { GeoBuilder, minAreaRect, rectRoof, insetRoof, RECT_RATIO };

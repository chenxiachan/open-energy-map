// Geometry helpers: local frame (CONTRACT §1), polygons, EPSG:3035 (LAEA Europe) for the Zensus grid.
import { L } from './i18n.js';

export const M_PER_DEG_LAT = 110540;
export const M_PER_DEG_LON_EQ = 111320;

export function makeFrame(lat0, lon0) {
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0, lon0,
    toLocal: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLonLat: (x, y) => [lon0 + x / kx, lat0 + y / M_PER_DEG_LAT],
  };
}

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function perimeter(ring) {
  let p = 0;
  for (let i = 0, n = ring.length; i < n; i++) p += Math.hypot(ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]);
  return p;
}

export function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-300) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt, outer, holes = []) {
  if (!pointInRing(pt, outer)) return false;
  for (const h of holes) if (pointInRing(pt, h)) return false;
  return true;
}

export function orient(ring, ccw) {
  const a = signedArea(ring);
  return (a > 0) === ccw ? ring.slice() : ring.slice().reverse();
}

// Remove duplicate points, very short edges and nearly collinear vertices (OSM footprints often carry many).
export function simplifyRing(ring, minLen = 0.35, maxTurnDeg = 6) {
  let pts = ring.slice();
  let changed = true;
  const turn = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    if (lu < 1e-9 || lv < 1e-9) return 0;
    const cr = (u[0] * v[1] - u[1] * v[0]) / (lu * lv), dt = (u[0] * v[0] + u[1] * v[1]) / (lu * lv);
    return Math.abs((Math.atan2(cr, dt) * 180) / Math.PI);
  };
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 50) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const n = pts.length;
      const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      const lab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (lab < minLen || turn(a, b, c) < maxTurnDeg) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts;
}

// Outward normal azimuth (deg clockwise from north) of edge a→b of a CCW outer ring (or CW hole ring:
// for holes the "outside" of the building is the courtyard, which is to the right of a→b as well).
export function edgeAzimuth(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const nx = dy, ny = -dx; // right-hand normal
  let az = (Math.atan2(nx, ny) * 180) / Math.PI;
  if (az < 0) az += 360;
  return az;
}

export function azToOrient(az) {
  return ["N", "E", "S", "W"][Math.round(az / 90) % 4];
}

export const ORIENT_CN = L({ N: "北", E: "东", S: "南", W: "西" }, { N: "N", E: "E", S: "S", W: "W" }, { N: "N", E: "O", S: "S", W: "W" });

// Minimum-area oriented bounding rectangle (rotating calipers over hull edges, brute force is fine for footprints).
export function obb(points) {
  const hull = convexHull(points);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of hull) {
      const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { area, angle: ang, w: x1 - x0, h: y1 - y0 };
  }
  return best;
}

export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Merge [t0,t1] intervals.
export function mergeIntervals(iv) {
  const s = iv.filter(([a, b]) => b - a > 1e-4).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1] + 1e-3) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

// ---------- EPSG:3035 ETRS89-LAEA forward (EPSG Guidance Note 7-2, ellipsoidal) ----------
const A = 6378137.0, E2 = 0.00669438002290, E = Math.sqrt(E2);
const PHI0 = (52 * Math.PI) / 180, LAM0 = (10 * Math.PI) / 180, FE = 4321000, FN = 3210000;
const qf = (phi) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const QP = qf(Math.PI / 2), Q0 = qf(PHI0);
const RQ = A * Math.sqrt(QP / 2), BETA0 = Math.asin(Q0 / QP);
const DD = (A * (Math.cos(PHI0) / Math.sqrt(1 - E2 * Math.sin(PHI0) ** 2))) / (RQ * Math.cos(BETA0));

export function toLAEA(lon, lat) {
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const beta = Math.asin(qf(phi) / QP);
  const B = RQ * Math.sqrt(2 / (1 + Math.sin(BETA0) * Math.sin(beta) + Math.cos(BETA0) * Math.cos(beta) * Math.cos(lam - LAM0)));
  const x = FE + B * DD * Math.cos(beta) * Math.sin(lam - LAM0);
  const y = FN + (B / DD) * (Math.cos(BETA0) * Math.sin(beta) - Math.sin(BETA0) * Math.cos(beta) * Math.cos(lam - LAM0));
  return [x, y];
}

// EPSG:3035 inverse (same guidance note): grid corners of the Zensus cells for the city layer.
export function fromLAEA(x, y) {
  const dx = x - FE, dy = y - FN;
  const rho = Math.sqrt((dx / DD) ** 2 + (DD * dy) ** 2);
  if (rho < 1e-9) return [(LAM0 * 180) / Math.PI, (PHI0 * 180) / Math.PI];
  const C = 2 * Math.asin(rho / (2 * RQ));
  const betaP = Math.asin(Math.cos(C) * Math.sin(BETA0) + (DD * dy * Math.sin(C) * Math.cos(BETA0)) / rho);
  const lam = LAM0 + Math.atan2(dx * Math.sin(C), DD * rho * Math.cos(BETA0) * Math.cos(C) - DD * DD * dy * Math.sin(BETA0) * Math.sin(C));
  const e4 = E2 * E2, e6 = e4 * E2;
  const phi = betaP + (E2 / 3 + (31 * e4) / 180 + (517 * e6) / 5040) * Math.sin(2 * betaP) + ((23 * e4) / 360 + (251 * e6) / 3780) * Math.sin(4 * betaP) + ((761 * e6) / 45360) * Math.sin(6 * betaP);
  return [(lam * 180) / Math.PI, (phi * 180) / Math.PI];
}

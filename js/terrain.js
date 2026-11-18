// Terrain and orthophoto for the street walk (js/walk.js), from data/terrain (tools/terrain_build.py): Bavarian DGM1
// heights on a 2 m grid and DOP40 orthophotos at 0.5 m, in 1 km UTM32 tiles (EPSG:25832), both CC BY 4.0. Only the
// tiles that have been prepared exist (now the four around the TUM main building); elsewhere the ground stays flat.
// The walk's local frame (metres east and north of a point, js/geo.js makeFrame) is turned into UTM with an affine fit
// of three exact projections; over the 1.5 km of a walk it differs from the exact projection by well under 0.1 m.
import * as THREE from 'three';

// lat/lon (ETRS89 ~ WGS84) → UTM zone 32 easting, northing (Snyder's series)
export function utm32(lat, lon) {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), ep2 = e2 / (1 - e2), k0 = 0.9996, l0 = (9 * Math.PI) / 180;
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180, sp = Math.sin(p), cp = Math.cos(p), tp = Math.tan(p);
  const N = a / Math.sqrt(1 - e2 * sp * sp), T = tp * tp, C = ep2 * cp * cp, A = cp * (l - l0);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * p - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * p)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * p) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * p));
  const E = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const Nn = k0 * (M + N * tp * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return [E, Nn];
}

// The walk's frame F (js/geo.js makeFrame) against UTM32: an affine fit of three exact projections, both ways.
export function utmFrame(F) {
  const u0 = utm32(F.lat0, F.lon0);
  const ue = utm32(...F.toLonLat(1000, 0).reverse()), un = utm32(...F.toLonLat(0, 1000).reverse());
  const a = (ue[0] - u0[0]) / 1000, b = (un[0] - u0[0]) / 1000, c = (ue[1] - u0[1]) / 1000, d = (un[1] - u0[1]) / 1000, det = a * d - b * c;
  return {
    u0,
    toUTM: (x, y) => [u0[0] + a * x + b * y, u0[1] + c * x + d * y],
    fromUTM: (E, N) => { const dx = E - u0[0], dy = N - u0[1]; return [(d * dx - b * dy) / det, (-c * dx + a * dy) / det]; },
  };
}

// F: the walk's frame; R: m around its origin. Returns null without terrain data here, else
// { h(x, y): metres relative to the origin's ground, or 0 outside the tiles; dop: THREE texture or null; dopUV(x, y): [u, v]
//   in it (outside 0..1 where there is no photo); has(x, y); range: [min, max] relative heights; tiles: n }
export async function loadGround(F, R) {
  let idx;
  try { const r = await fetch('data/terrain/index.json'); if (!r.ok) return null; idx = await r.json(); } catch { return null; }
  const { u0, toUTM } = utmFrame(F);
  // tiles touching the walk area
  const cs = [[-R, -R], [R, -R], [R, R], [-R, R]].map(([x, y]) => toUTM(x, y));
  const E0 = Math.min(...cs.map((c) => c[0])), E1 = Math.max(...cs.map((c) => c[0])), N0 = Math.min(...cs.map((c) => c[1])), N1 = Math.max(...cs.map((c) => c[1]));
  const need = idx.tiles.filter((t) => t.E + 1000 > E0 && t.E < E1 && t.N + 1000 > N0 && t.N < N1);
  if (!need.length) return null;
  const n = idx.cells, s = idx.step_m, base = idx.base_m;
  const tiles = new Map();
  await Promise.all(need.map(async (t) => {
    const r = await fetch(`data/terrain/h_${t.key}.bin`);
    if (r.ok) tiles.set(t.key, { ...t, h: new Uint16Array(await r.arrayBuffer()) });
  }));
  if (!tiles.size) return null;
  const hUTM = (E, N) => {
    const t = tiles.get(`${Math.floor(E / 1000)}_${Math.floor(N / 1000)}`);
    if (!t) return null;
    const gx = Math.max(0, Math.min(n - 1.001, (E - t.E) / s - 0.5)), gy = Math.max(0, Math.min(n - 1.001, (t.N + 1000 - N) / s - 0.5));
    const i = Math.floor(gy), j = Math.floor(gx), fy = gy - i, fx = gx - j, H = t.h;
    const v = (H[i * n + j] * (1 - fx) + H[i * n + j + 1] * fx) * (1 - fy) + (H[(i + 1) * n + j] * (1 - fx) + H[(i + 1) * n + j + 1] * fx) * fy;
    return base + v / 100;
  };
  const h0 = hUTM(...u0) ?? [...tiles.values()].reduce((m, t) => m + (t.min + t.max) / 2, 0) / tiles.size;
  const has = (x, y) => hUTM(...toUTM(x, y)) != null;
  const h = (x, y) => { const v = hUTM(...toUTM(x, y)); return v == null ? 0 : v - h0; };

  // orthophoto mosaic of the tiles with a photo, north up
  let dop = null, dopUV = () => [-1, -1];
  const withDop = [...tiles.values()].filter((t) => t.dop);
  if (withDop.length) {
    const tx0 = Math.min(...withDop.map((t) => t.E)), tx1 = Math.max(...withDop.map((t) => t.E)) + 1000;
    const ty0 = Math.min(...withDop.map((t) => t.N)), ty1 = Math.max(...withDop.map((t) => t.N)) + 1000;
    const px = 1000 / idx.dop_px_m, scale = Math.min(1, 8192 / (((tx1 - tx0) / 1000) * px));   // keep the texture within 8192 px
    const cv = document.createElement('canvas');
    cv.width = Math.round(((tx1 - tx0) / 1000) * px * scale); cv.height = Math.round(((ty1 - ty0) / 1000) * px * scale);
    const g = cv.getContext('2d');
    g.fillStyle = '#8a877f'; g.fillRect(0, 0, cv.width, cv.height);
    await Promise.all(withDop.map((t) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { g.drawImage(im, ((t.E - tx0) / 1000) * px * scale, ((ty1 - t.N - 1000) / 1000) * px * scale, px * scale, px * scale); res(); };
      im.onerror = res;
      im.src = `data/terrain/dop_${t.key}.jpg`;
    })));
    dop = new THREE.CanvasTexture(cv);
    dop.colorSpace = THREE.SRGBColorSpace;
    dop.anisotropy = 8;
    dopUV = (x, y) => { const [E, N] = toUTM(x, y); return [(E - tx0) / (tx1 - tx0), (N - ty0) / (ty1 - ty0)]; };
  }
  let lo = Infinity, hi = -Infinity;
  for (const t of tiles.values()) { lo = Math.min(lo, t.min - h0); hi = Math.max(hi, t.max - h0); }
  return { h, has, dop, dopUV, range: [lo, hi], tiles: tiles.size, h0 };
}

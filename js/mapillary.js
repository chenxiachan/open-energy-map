// Mapillary street-level photos for the Overview card (js/photos.js): find the photos near the selected building whose
// camera looks at it, and the camera positions for the map. Images are CC BY-SA 4.0, © Mapillary and the photographer.
//
// Every API request needs a client token (registered app at https://www.mapillary.com/dashboard/developers). It is read
// from config.local.json in the project root, which git ignores (see config.local.example.json); without it only the
// link to the Mapillary web app works. The image details go with the token in the Authorization header; the coverage
// tiles accept it only as ?access_token= in the URL (the header gives 403), as the API documentation says, and the
// user agreed to that on 2026-11-09. Both go only to Mapillary.
// Candidates come from the coverage tiles (z14, layer "image": every photo with position, compass, panorama flag),
// because the bbox search of the Graph API returns a different, incomplete sample on each call (2026-11-09, TUM main
// building: 439, 642 and 829 of at least 1,924 photos, 83 in all three answers).
// API v4 facts used here (documentation read on 2026-11-09): tiles.mapillary.com/maps/vtp/mly1_computed_public/2/14/x/y
// (layer "image": id, compass_angle, is_pano, captured_at, sequence_id); graph.mapillary.com/<id>?fields=… for one image;
// captured_at in ms since epoch; computed_geometry / computed_compass_angle are the values after Mapillary's processing. v4 has no "look at" query,
// so the selection below compares each camera heading with the bearings to the building outline.
// Pure functions (pickViews) run in Node for tests/mapillary_pick.mjs.

import { decodeMVT, props, firstPoint, toLonLat } from './mvt.js';

const GRAPH = 'https://graph.mapillary.com';
const DETAIL = 'id,computed_geometry,computed_compass_angle,captured_at,is_pano,thumb_1024_url,creator,camera_type,camera_parameters,width,height';
const TILE = (x, y) => `https://tiles.mapillary.com/maps/vtp/mly1_computed_public/2/14/${x}/${y}`;

let tokenP = null;
export function token() {
  if (!tokenP) {
    tokenP = fetch('config.local.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => (c && typeof c.mapillaryToken === 'string' && c.mapillaryToken.trim()) || null)
      .catch(() => null);
  }
  return tokenP;
}

// Web app links (the pKey form is the documented one; lat/lng/z is the form the app itself uses)
export const appUrl = (lat, lon) => `https://www.mapillary.com/app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&z=18`;
// x, y: the viewport centre in the image (0..1; undocumented share-link parameters of the web app, forum 2022–2025)
export const imageUrl = (id, x, y) => `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo${x == null ? '' : `&x=${x.toFixed(4)}&y=${(y ?? 0.5).toFixed(4)}&zoom=0`}`;

// Where the building sits in the image, as an image x (0..1). A panorama spans 360° with its centre (x = 0.5) along the
// camera heading (MapillaryJS convention; checked 2026-11-09 on a panorama 51 m from the Siegestor, in our crop and in the
// web app). A normal photo uses its focal length (camera_parameters[0], relative to the longer image side, as in
// OpenSfM) when the API gives one, else a width of about 70°.
export function viewX(v) {
  if (v.look == null || v.heading == null) return 0.5;
  const d = wrap180(v.look - v.heading);
  if (v.pano) return (((0.5 + d / 360) % 1) + 1) % 1;
  const x = v.focal && v.w && v.h && Math.abs(d) < 80 ? 0.5 + (v.focal * Math.tan(d * D2R) * Math.max(v.w, v.h)) / v.w : 0.5 + d / 70;
  return Math.max(0.03, Math.min(0.97, x));
}

const D2R = Math.PI / 180;
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const bearing = (from, to) => (Math.atan2(to[0] - from[0], to[1] - from[1]) / D2R + 360) % 360;   // clockwise from north
function nearestOnSeg(p, a, b) {   // [distance, nearest point]
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return [Math.hypot(p[0] - x, p[1] - y), [x, y]];
}
function inside(p, P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if ((P[i][1] > p[1]) !== (P[j][1] > p[1]) && p[0] < ((P[j][0] - P[i][0]) * (p[1] - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
  }
  return c;
}

// Search box around a lon/lat ring: its bounds plus `pad` metres on every side, as minLon,minLat,maxLon,maxLat.
export function bboxAround(ring, pad = 60) {
  const lats = ring.map((p) => p[1]), lons = ring.map((p) => p[0]);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2, kx = 111320 * Math.cos(lat0 * D2R), ky = 110540;
  return [Math.min(...lons) - pad / kx, Math.min(...lats) - pad / ky, Math.max(...lons) + pad / kx, Math.max(...lats) + pad / ky];
}

// First hit of the ray q + t·d (t > 0, d a unit vector) on the edges of polygon P: { t, cos } with cos = |d · edge
// direction| (0 when the ray meets the wall square on, 1 when it grazes along it), or null.
function rayHit(q, d, P) {
  let best = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ey = b[1] - a[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const ax = a[0] - q[0], ay = a[1] - q[1];
    const t = (ax * ey - ay * ex) / den, u = (ax * d[1] - ay * d[0]) / den;
    if (t > 1e-6 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t, cos: Math.abs(d[0] * ex + d[1] * ey) / Math.hypot(ex, ey) };
  }
  return best;
}
const segHits = (q, p, P) => { const dx = p[0] - q[0], dy = p[1] - q[1], L = Math.hypot(dx, dy); const h = L > 0 ? rayHit(q, [dx / L, dy / L], P) : null; return !!h && h.t < L - 0.5; };

// Photos that show the building outlined by `ring` ([[lon, lat], …]); `neighbours` are the outlines around it (lon/lat
// rings), used for occlusion. A camera must stand outside the outline and within maxDist metres of it.
// - A normal photo is "centred" if the ray along its heading hits the building before any neighbour; `off` is then the
//   angle between the ray and the wall's normal (0 = square on). Otherwise it still counts as an "edge" view if the
//   building lies inside the angle it covers ± margin and the ray hits no neighbour first (a photo along the street);
//   edge views come after every centred one. 2026-11-09: a nearest-wall rule ranked such street photos first, because
//   past the end of a building the nearest point is the corner straight ahead (Schellingstraße 51).
// - A panorama counts if the line to the nearest wall point is not blocked by a neighbour.
// Ranked: panoramas first, then centred views by squareness, then edge views, each by distance and age; then up to n
// from different sides, taking only centred views and panoramas in that first pass, and cameras at least 8 m apart
// after it. `look` is the bearing to the middle of the building as seen from the camera (for viewX and the map).
export function pickViews(images, ring, { neighbours = [], maxDist = 60, margin = 20, n = 3, now = Date.now() } = {}) {
  if (!ring?.length || !images?.length) return [];
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length, lon0 = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const kx = 111320 * Math.cos(lat0 * D2R), ky = 110540;
  const xy = (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const P = ring.map(([lo, la]) => xy(lo, la));
  const C = [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
  const reach = maxDist + Math.max(...P.map((p) => Math.hypot(p[0] - C[0], p[1] - C[1])));
  const NB = (neighbours || []).map((r) => r.map(([lo, la]) => xy(lo, la)))
    .filter((Q) => Q.length > 2 && Q.some((p) => Math.hypot(p[0] - C[0], p[1] - C[1]) < reach + 60));
  const firstNb = (q, d) => { let t = Infinity; for (const Q of NB) { const h = rayHit(q, d, Q); if (h && h.t < t) t = h.t; } return t; };
  const cand = [];
  for (const im of images) {
    const g = (im.computed_geometry || im.geometry)?.coordinates;
    if (!g) continue;
    const q = xy(g[0], g[1]);
    if (inside(q, P)) continue;
    let d = Infinity, near = null;
    for (let i = 0; i < P.length; i++) { const [di, pi] = nearestOnSeg(q, P[i], P[(i + 1) % P.length]); if (di < d) { d = di; near = pi; } }
    if (d > maxDist) continue;
    const heading = im.computed_compass_angle ?? im.compass_angle;
    const pano = !!im.is_pano;
    let off = null, kind, pen = 0;
    const b0 = bearing(q, C), rel = P.map((p) => wrap180(bearing(q, p) - b0));
    const look = (b0 + (Math.min(...rel) + Math.max(...rel)) / 2 + 360) % 360;   // middle of the building as seen from here
    if (pano) {
      if (NB.some((Q) => segHits(q, near, Q))) continue;   // a neighbour stands between the camera and the building
      kind = 'pano';   // panoramas first (the user, 2026-11-09): they show the building from wherever it stands
    } else {
      if (typeof heading !== 'number') continue;
      const dir = [Math.sin(heading * D2R), Math.cos(heading * D2R)];
      const hit = rayHit(q, dir, P), tNb = firstNb(q, dir);
      if (hit && hit.t < tNb) {
        kind = 'centred'; off = 90 - Math.acos(Math.min(1, hit.cos)) / D2R; pen = 0.6 + off / 60;
      } else {
        const h = wrap180(heading - b0);
        if (h < Math.min(...rel) - margin || h > Math.max(...rel) + margin) continue;
        if (tNb < d + 2) continue;   // it looks at a neighbour
        kind = 'edge'; pen = 2;
      }
      if (im.computed_compass_angle == null) pen += 0.2;   // the raw compass is often far off (P90 56–120° here)
    }
    const years = im.captured_at ? Math.max(0, (now - im.captured_at) / 3.156e10) : 10;
    cand.push({
      id: String(im.id), lon: g[0], lat: g[1], heading: typeof heading === 'number' ? heading : null, pano, dist: d, kind, off, look,
      capturedAt: im.captured_at || null, thumb: im.thumb_1024_url || null, creator: im.creator?.username || null,
      focal: Array.isArray(im.camera_parameters) && im.camera_parameters[0] > 0 && im.camera_type !== 'spherical' ? im.camera_parameters[0] : null, w: im.width || null, h: im.height || null,
      side: bearing(C, q), score: d / maxDist + pen + 0.05 * years,
    });
  }
  cand.sort((a, b) => a.score - b.score);
  const out = [];
  for (const c of cand) { if (out.length >= n) break; if ((c.kind === 'pano' || (c.kind === 'centred' && c.off <= 45)) && out.every((o) => Math.abs(wrap180(o.side - c.side)) >= 45)) out.push(c); }
  // then the rest by score, skipping near-duplicates (the next frame of the same sequence) while others are left
  const apart = (c) => out.every((o) => Math.hypot((o.lon - c.lon) * kx, (o.lat - c.lat) * ky) >= 8);
  for (const c of cand) { if (out.length >= n) break; if (!out.includes(c) && apart(c)) out.push(c); }
  for (const c of cand) { if (out.length >= n) break; if (!out.includes(c)) out.push(c); }
  return out;
}

// z14 tile numbers covering a lon/lat box
function tilesFor([w, s, e, n]) {
  const z = 14, N = 2 ** z, tx = (lon) => Math.floor(((lon + 180) / 360) * N);
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N); };
  const out = [];
  for (let x = tx(w); x <= tx(e); x++) for (let y = ty(n); y <= ty(s); y++) out.push([x, y]);
  return out;
}
// Photos of one coverage tile as API-like records (computed position and compass), cached per tile for the session.
const tileCache = new Map();
function tileImages(x, y, tok) {
  const k = `${x}/${y}`;
  if (!tileCache.has(k)) {
    tileCache.set(k, fetch(`${TILE(x, y)}?access_token=${encodeURIComponent(tok)}`).then(async (r) => {
      if (!r.ok) throw new Error(`Mapillary ${r.status}`);
      const L = decodeMVT(new Uint8Array(await r.arrayBuffer())).image;
      return (L?.feats || []).map((F) => {
        const p = props(L, F), pt = firstPoint(F);
        return { id: String(p.id), computed_geometry: { coordinates: toLonLat(14, x, y, L.extent, pt[0], pt[1]) }, computed_compass_angle: p.compass_angle, captured_at: p.captured_at, is_pano: !!p.is_pano };
      });
    }).catch((e) => { tileCache.delete(k); throw e; }));
  }
  return tileCache.get(k);
}

// Photos of the building: candidates from the coverage tiles around it, ranked by pickViews; then the details of the
// chosen ones (thumbnail, photographer, camera) from the Graph API, and viewX recomputed with them. Throws on HTTP errors.
export async function viewsFor(ring, tok, opt = {}) {
  const box = bboxAround(ring, opt.maxDist || 60);
  const lists = await Promise.all(tilesFor(box).map(([x, y]) => tileImages(x, y, tok)));
  const [w, s, e, n] = box;
  const cand = lists.flat().filter((im) => { const [lo, la] = im.computed_geometry.coordinates; return lo >= w && lo <= e && la >= s && la <= n; });
  const views = pickViews(cand, ring, opt);
  const det = await Promise.all(views.map((v) => fetch(`${GRAPH}/${encodeURIComponent(v.id)}?fields=${DETAIL}`, { headers: { Authorization: `OAuth ${tok}` } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  return views.map((v, i) => {
    const d = det[i];
    if (!d) return v;
    return { ...v, thumb: d.thumb_1024_url || null, creator: d.creator?.username || null, capturedAt: d.captured_at || v.capturedAt,
      heading: typeof d.computed_compass_angle === 'number' ? d.computed_compass_angle : v.heading,
      focal: Array.isArray(d.camera_parameters) && d.camera_parameters[0] > 0 && d.camera_type !== 'spherical' ? d.camera_parameters[0] : null, w: d.width || null, h: d.height || null };
  }).filter((v) => v.thumb);
}

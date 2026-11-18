// Buildings of the street walk (js/walk.js): every OSM outline around the start, raised to the LoD2 or estimated
// heights, with roofs shaped from the roof type (the roof builders of js/scene3d.js), OSM material tags, the window
// pattern of the estimated window-to-wall ratio, and the selection and hover highlight as shader uniforms.
import * as THREE from 'three';
import { heightAndUsage, lod2Record } from './geometry.js';
import { signedArea, pointInPolygon } from './geo.js';
import { GeoBuilder, minAreaRect, rectRoof, insetRoof, RECT_RATIO } from './scene3d.js';
import { R_LOAD, col, hash, triangulate, inside, blank, GLSL_COMMON } from './walk-common.js';

export const WWR_DEFAULT = 0.22;    // window-to-wall ratio of the pattern on buildings the model has not estimated
const PLASTER = [0xe9e0cb, 0xe8d3a6, 0xf0ece4, 0xdcd8d0, 0xe7c7ad, 0xeee2ad, 0xd9d0bf].map(col);
const WALL_MAT = { brick: 0xa65d47, concrete: 0xbdb9b0, cement_block: 0xbdb9b0, wood: 0x9b7552, glass: 0x8da9b8, metal: 0xa9afb5, stone: 0xd9d0bc, limestone: 0xdcd3bf, sandstone: 0xcdb48c };
const TILES = [0xa3583f, 0x94503c, 0x8a4a3a, 0xa86446, 0x5a5e63].map(col);   // clay tiles, one in five slate grey
const ROOF_MAT = { metal: 0x7c868e, copper: 0x6f9e8c, grass: 0x6f8f56, green_roof: 0x6f8f56, gravel: 0x8d8a83, concrete: 0x8f8c86, cement: 0x8f8c86, tar_paper: 0x5d5e60, glass: 0x9cc0d2, slate: 0x50555b, eternit: 0x6a6c6e };
const FLAT = col(0x8d8a83);
const SHOP_AMENITY = /^(restaurant|cafe|bar|pub|fast_food|bank|pharmacy|ice_cream|bakery)$/;

// { list: [{ ring, holes, eaves, ridge, top, fh, bay, … }], grid: Map cell → indices, C, sel, roofs }
export function buildingList(recs, lod2, F, model, wwrSel, gh) {
  const list = [], seen = new Set();
  for (const b of recs) {
    if (b.part || seen.has(b.id)) continue;
    seen.add(b.id);
    const cx = (b.bbox[0] + b.bbox[2]) / 2, cy = (b.bbox[1] + b.bbox[3]) / 2;
    const [px, py] = F.toLocal(cx, cy);
    if (Math.hypot(px, py) > R_LOAD) continue;
    const loc = (r) => { const q = r.map(([lon, lat]) => F.toLocal(lon, lat)); const a = q[0], z = q[q.length - 1]; if (q.length > 1 && a[0] === z[0] && a[1] === z[1]) q.pop(); return q; };
    let ring = loc(b.outer);
    if (ring.length < 3) continue;
    if (signedArea(ring) < 0) ring = ring.reverse();
    const fp = Math.abs(signedArea(ring));
    if (fp < 4) continue;
    const holes = (b.holes || []).map(loc).filter((r) => r.length >= 3).map((r) => (signedArea(r) > 0 ? r.reverse() : r));
    const tags = b.tags || {}, sel = b.id === model.id;
    let eaves, ridge, floors, shape;
    const L2 = sel ? null : lod2Record(lod2.get(b.id));
    if (sel) { eaves = model.height; ridge = model.roof?.ridgeHeight || 0; floors = model.floors; shape = model.roof?.shape; }
    else if (L2 && L2.eaves > 0) { eaves = L2.eaves; ridge = L2.ridge || 0; floors = L2.storeys; shape = L2.shape; }
    else { const { H } = heightAndUsage(tags, ring, fp, cx, cy); eaves = H.height; ridge = H.roof?.ridgeHeight || 0; floors = H.floors; shape = tags['roof:shape'] || H.roof?.shape; }
    if (!(eaves > 0)) eaves = 6;
    floors = Math.max(1, Math.round(floors || eaves / 3));
    let fh = eaves / floors;
    if (fh < 2.5) { floors = Math.max(1, Math.floor(eaves / 2.8)); fh = eaves / floors; }   // an attic counted as a storey
    if (fh > 5.5) { floors = Math.max(1, Math.round(eaves / 3.5)); fh = eaves / floors; }   // halls: a pattern of 3.5 m
    const wallMat = tags['building:material'], roofMat = tags['roof:material'];
    const glass = wallMat === 'glass';
    const wwr = sel && wwrSel > 0 ? wwrSel : WWR_DEFAULT;
    const hw = fh - 1.35, ww = 1.25;
    const bay = eaves >= 2.6 && hw > 0.5 ? (ww * hw) / (wwr * fh) : 0;
    const shop = !!(tags.shop || SHOP_AMENITY.test(tags.amenity || '') || ['retail', 'commercial', 'supermarket', 'kiosk'].includes(tags.building));
    const seed = hash(b.id), pitched = ridge > 0.8 && shape !== 'flat';
    const base = WALL_MAT[wallMat] ? col(WALL_MAT[wallMat]) : PLASTER[Math.floor(seed * PLASTER.length)];   // the selection tint comes from the shader (uSel)
    const roofC = ROOF_MAT[roofMat] ? col(ROOF_MAT[roofMat]) : pitched ? TILES[Math.floor(((seed * 7.31) % 1) * TILES.length)] : FLAT;   // the tile index again below
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
    for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, gh(x, y)); }
    const tileI = Math.floor(((seed * 7.31) % 1) * TILES.length);
    const wallId = wallMat === 'brick' ? 1 : WALL_MAT[wallMat] ? 2 : 0;
    const green = ['grass', 'green_roof'].includes(roofMat);
    const roofId = green ? 4 : !pitched ? 3 : ['slate', 'eternit'].includes(roofMat) ? 1 : ['metal', 'copper', 'glass', 'zinc'].includes(roofMat) ? 2 : ROOF_MAT[roofMat] ? 2 : tileI === 4 ? 1 : 0;
    const label = tags.name || [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null;
    list.push({ id: b.id, label, ll: [cx, cy], ring, holes, fp, eaves, ridge, shape, pitched, top: eaves + Math.max(0, ridge) * (pitched ? 1 : 0.5), fh, bay, shop, glass, base, roofC, wallId, roofId, z0, sel, bbox: [x0, y0, x1, y1] });
  }
  const grid = new Map(), C = 25;
  list.forEach((b, i) => {
    for (let gx = Math.floor(b.bbox[0] / C); gx <= Math.floor(b.bbox[2] / C); gx++)
      for (let gy = Math.floor(b.bbox[1] / C); gy <= Math.floor(b.bbox[3] / C); gy++) { const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  });
  return { list, grid, C, sel: list.find((b) => b.sel) || null, roofs: { pitched: 0, shaped: 0 } };
}

// an edge is a party wall when a point 0.45 m outside its middle lies in another building at least 2.5 m high
// (weight 0: the roof gets a gable wall there instead of a slope)
export function partyWalls(B) {
  B.list.forEach((b, i) => {
    b.ws = [b.ring, ...b.holes].map((ring) => ring.map((a, k) => {
      const c = ring[(k + 1) % ring.length], len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 0.5) return 1;
      const mx = (a[0] + c[0]) / 2 + ((c[1] - a[1]) / len) * 0.45, my = (a[1] + c[1]) / 2 - ((c[0] - a[0]) / len) * 0.45;
      for (const j of B.grid.get(Math.floor(mx / B.C) + ',' + Math.floor(my / B.C)) || []) if (j !== i && B.list[j].eaves >= 2.5 && inside(mx, my, B.list[j])) return 0;
      return 1;
    }));
  });
}

// is the eye at (x, y, z) outside every building that reaches above it? (z relative to the start area's ground)
export function free(x, y, z, B) {
  const k = Math.floor(x / B.C) + ',' + Math.floor(y / B.C);
  for (const i of B.grid.get(k) || []) {
    const b = B.list[i];
    if (z > b.z0 + b.top + 0.3 || x < b.bbox[0] - 0.3 || x > b.bbox[2] + 0.3 || y < b.bbox[1] - 0.3 || y > b.bbox[3] + 0.3) continue;
    for (const [ox, oy] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) if (pointInPolygon([x + ox, y + oy], b.ring, b.holes)) return false;
  }
  return true;
}

// pitched roof of one building with the roof builders of the 3D view; null when none is valid
function roofOf(b) {
  const gb = new GeoBuilder(2), H = b.eaves, R = b.ridge;
  const gabled = /gabled|gambrel|skillion|saltbox|side_hipped/.test(b.shape || '');
  if (!b.holes.length) {
    const rect = minAreaRect(b.ring);
    if (rect && b.fp / (4 * rect.hu * rect.hv) >= RECT_RATIO) {
      // gable ends go to the sides that carry most party wall; else the ridge runs along the long axis
      let pu = 0, pv = 0;
      b.ring.forEach((a, k) => {
        if (b.ws[0][k]) return;
        const c = b.ring[(k + 1) % b.ring.length], len = Math.hypot(c[0] - a[0], c[1] - a[1]), nx = (c[1] - a[1]) / len, ny = -(c[0] - a[0]) / len;
        if (Math.abs(nx * rect.u[0] + ny * rect.u[1]) > 0.8) pu += len; else if (Math.abs(nx * rect.v[0] + ny * rect.v[1]) > 0.8) pv += len;
      });
      rectRoof(gb, rect, H, R, gabled, pu > pv + 0.5 ? true : pv > pu + 0.5 ? false : rect.hu >= rect.hv);
      return gb;
    }
  }
  let ws = b.ws;
  if (ws.every((w) => w.every((x) => x === 0))) ws = ws.map((w) => w.map(() => 1));
  return insetRoof(gb, [b.ring, ...b.holes], ws, H, R) > 0 ? gb : null;
}

export function buildingMesh(B, T, terr, selIdx) {
  const pos = [], nor = [], colr = [], uvw = [], bld = [], roofc = [], ext = [], mat = [], dop = [], idx = [];
  const SU = { uSel: { value: selIdx }, uHover: { value: -1 } };   // picked and hovered building, by index in B.list
  const v3 = (a, x, y, z) => a.push(x, y, z);
  const dopUV = terr?.dop ? terr.dopUV : () => [-1, -1];
  B.list.forEach((b, bi) => {
    let gb = null;
    if (b.pitched) { B.roofs.pitched++; try { gb = roofOf(b); } catch { gb = null; } if (gb) B.roofs.shaped++; }
    const wallTop = gb ? b.eaves : b.pitched ? b.eaves + b.ridge * 0.5 : b.top, z0 = b.z0;
    const add = (x, y, z, n, c, u, kind, roof = false) => {
      v3(pos, x, y + z0, z); v3(nor, n[0], n[1], n[2]); v3(colr, c.r, c.g, c.b); v3(uvw, u[0], u[1], u[2]);
      bld.push(b.fh, b.bay, b.eaves, kind); v3(roofc, b.roofC.r, b.roofC.g, b.roofC.b); ext.push(b.shop ? 1 : 0, b.glass ? 1 : 0);
      mat.push(b.wallId, b.roofId); dop.push(...(roof ? dopUV(x, -z) : [-1, -1])); idx.push(bi);
    };
    for (const ring of [b.ring, ...b.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length], len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (len < 0.05) continue;
        const n = [(c[1] - a[1]) / len, 0, (c[0] - a[0]) / len];   // outward for CCW outers and CW holes, in three.js axes
        // walls start 0.6 m below the lowest ground under the outline, so they never float on a slope
        for (const [p, z, u] of [[a, -0.6, 0], [c, -0.6, len], [c, wallTop, len], [a, -0.6, 0], [c, wallTop, len], [a, wallTop, 0]]) add(p[0], z, -p[1], n, b.base, [u, z, len], 0);
      }
    }
    if (gb) {
      for (const [g, kind, c] of [[gb.g[0], 1, b.roofC], [gb.g[1], 2, b.base]]) {
        for (let i = 0; i < g.p.length; i += 3) add(g.p[i], g.p[i + 1], g.p[i + 2], [g.n[i], g.n[i + 1], g.n[i + 2]], c, [0, g.p[i + 1], 0], kind, kind === 1);
      }
    } else {
      const pts = [...b.ring, ...b.holes.flat()];
      for (const t of triangulate(b.ring, b.holes)) for (const k of [t[0], t[2], t[1]]) add(pts[k][0], wallTop, -pts[k][1], [0, 1, 0], b.roofC, [0, wallTop, 0], 1, true);
    }
  });
  const g = new THREE.BufferGeometry();
  for (const [name, arr, k] of [['position', pos, 3], ['normal', nor, 3], ['color', colr, 3], ['aUVW', uvw, 3], ['aBld', bld, 4], ['aRoof', roofc, 3], ['aExt', ext, 2], ['aMat', mat, 2], ['aDop', dop, 2], ['aIdx', idx, 1]]) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, k));
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.customProgramCacheKey = () => 'walk-buildings';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, SU, { tPlC: { value: T.plC }, tPlN: { value: T.plN }, tBrC: { value: T.brC }, tBrN: { value: T.brN }, tTiC: { value: T.tiC }, tTiN: { value: T.tiN },
      tSlC: { value: T.slC }, tSlN: { value: T.slN }, tDop: { value: terr?.dop || blank }, uDop: { value: terr?.dop ? 1 : 0 } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aUVW; attribute vec4 aBld; attribute vec3 aRoof; attribute vec2 aExt; attribute vec2 aMat; attribute vec2 aDop; attribute float aIdx;\nvarying float vIdx; varying vec3 vUVW; varying vec4 vBld; varying vec3 vRoof; varying vec2 vExt; varying vec2 vMat; varying vec2 vDop; varying vec3 vPos; varying vec3 vNW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUVW = aUVW; vBld = aBld; vRoof = aRoof; vExt = aExt; vMat = aMat; vDop = aDop; vIdx = aIdx; vPos = position; vNW = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
      varying float vIdx; varying vec3 vUVW; varying vec4 vBld; varying vec3 vRoof; varying vec2 vExt; varying vec2 vMat; varying vec2 vDop; varying vec3 vPos; varying vec3 vNW;
      uniform float uSel, uHover; uniform sampler2D tPlC, tPlN, tBrC, tBrN, tTiC, tTiN, tSlC, tSlN, tDop; uniform float uDop;
      ${GLSL_COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      float wWin = 0.0, rough = 0.9, nK = 0.0;
      vec3 nW = normalize(vNW); if (dot(nW, cameraPosition - vPos) < 0.0) nW = -nW;
      vec3 Tg = cross(vec3(0.0, 1.0, 0.0), nW); Tg = length(Tg) < 0.05 ? vec3(1.0, 0.0, 0.0) : normalize(Tg);
      vec3 Bg = normalize(cross(nW, Tg));
      vec2 st2 = vec2(dot(vPos, Tg), dot(vPos, Bg));                                   // metres in the surface
      vec3 nMap = vec3(0.0, 0.0, 1.0);
      if (vBld.w < 0.5 || vBld.w > 1.5) {                                              // walls and gables
        bool brick = vMat.x > 0.5 && vMat.x < 1.5;
        vec2 uvw = brick ? st2 / 1.1 : st2 / 2.6;
        vec3 c = brick ? texture2D(tBrC, uvw).rgb : diffuseColor.rgb * mix(vec3(1.0), brick ? vec3(1.0) : detail(tPlC, uvw), 0.85);
        nMap = (brick ? texture2D(tBrN, uvw).xyz : texture2D(tPlN, uvw).xyz) * 2.0 - 1.0; nK = brick ? 1.0 : 0.7;
        float fh = vBld.x, bay = vBld.y, eav = vBld.z, len = vUVW.z, y = vUVW.y, u = vUVW.x;
        if (vBld.w < 0.5) {
          if (y > eav + 0.02) c = vRoof * (0.9 + 0.1 * vnoise(vec2(u, y) * 2.0));
          else {
            float st = floor(max(y, 0.0) / fh), vy = y - st * fh;
            c *= mix(0.78, 1.0, step(0.6, y));                                            // plinth
            c = mix(c, c * 1.1, step(eav - 0.45, y) * step(y, eav - 0.12));               // cornice
            c *= 1.0 - 0.2 * step(eav - 0.55, y) * step(y, eav - 0.45);                   // its shadow
            c *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.1, vy)) * step(1.0, st);           // a line at each floor
            if (vExt.y > 0.5) wWin = step(0.45, vy) * step(y, eav - 0.3) * step(0.0, y);  // glass facade
            else if (bay > 0.0 && len > 2.0) {
              float n = max(1.0, floor((len - 1.0) / bay)), b2 = len / n, bx = mod(u, b2) - 0.5 * b2;
              float shopF = step(0.5, vExt.x) * (1.0 - step(0.5, st));                    // shop front on the ground floor
              float ww = mix(min(1.25, b2 * 0.62), b2 * 0.82, shopF), y0 = mix(0.9, 0.35, shopF), y1 = mix(fh - 0.45, fh - 0.55, shopF);
              float win = step(abs(bx), 0.5 * ww) * step(y0, vy) * step(vy, y1) * step(y, eav - 0.5) * step(0.0, y);
              float glassA = win * step(abs(bx), 0.5 * ww - 0.07) * step(y0 + 0.07, vy) * step(vy, y1 - 0.07);
              float sill = step(abs(bx), 0.5 * ww + 0.08) * step(y0 - 0.09, vy) * step(vy, y0) * (1.0 - shopF) * step(y, eav - 0.5) * step(0.0, y);
              c = mix(c, vec3(0.88, 0.87, 0.84), win - glassA);                           // frames
              c = mix(c, min(c * 1.15, vec3(1.0)), sill);                                  // sills
              wWin = glassA;
              c = mix(c, c * 0.55, glassA * step(y1 - 0.25, vy));                          // lintel shadow on the glass
            }
            c = mix(c, vec3(0.05, 0.065, 0.08), wWin);
          }
        }
        diffuseColor.rgb = c;
      } else {                                                                          // roofs
        float rid = vMat.y; vec3 c = vRoof;
        if (rid < 0.5) { vec2 uv = st2 / 1.8; c = texture2D(tTiC, uv).rgb * mix(vec3(1.0), vRoof / max(textureLod(tTiC, vec2(0.5), 12.0).rgb, vec3(0.04)), 0.35); nMap = texture2D(tTiN, uv).xyz * 2.0 - 1.0; nK = 1.0; }
        else if (rid < 1.5) { vec2 uv = st2 / 1.8; c = texture2D(tSlC, uv).rgb; nMap = texture2D(tSlN, uv).xyz * 2.0 - 1.0; nK = 1.0; }
        else if (rid < 2.5) { rough = 0.35; }
        else c = inDop(vDop) ? texture2D(tDop, vDop).rgb : vRoof * (0.9 + 0.15 * vnoise(vPos.xz * 0.7));   // flat or green: the orthophoto
        diffuseColor.rgb = c;
      }
      { float isSel = 1.0 - step(0.5, abs(vIdx - uSel)), isHov = (1.0 - step(0.5, abs(vIdx - uHover))) * (1.0 - isSel);
        float wall = vBld.w < 0.5 || vBld.w > 1.5 ? 1.0 : 0.6;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.25, 0.72, 0.70), 0.5 * wall * isSel * (1.0 - wWin));   // the selection teal
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.22 * isHov * (1.0 - wWin)); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { vec3 nP = normalize(Tg * nMap.x * nK + Bg * nMap.y * nK + nW * mix(1.0, nMap.z, nK)); nP = normalize(mix(nP, nW, wWin));
        normal = normalize((viewMatrix * vec4(nP, 0.0)).xyz); }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(rough, 0.06, wWin);');
  };
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.U = SU;
  return mesh;
}

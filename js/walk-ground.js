// Ground of the street walk (js/walk.js): the base map's vector tiles (OpenFreeMap / OpenMapTiles, z14, decoded with
// js/mvt.js) for roads, paths, green and water, laid on one terrain grid (js/terrain.js heights, flat where there are
// none) that every other part of the scene uses as its ground.
import * as THREE from 'three';
import { signedArea } from './geo.js';
import { decodeMVT, props, featureGeometry, toLonLat } from './mvt.js';
import { R_LOAD, GROUND_PAD, GLSL_COMMON, blank } from './walk-common.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
// road half-widths in m by OpenMapTiles class (lines); paths by subclass
const ROAD_W = { motorway: 9, trunk: 7.5, primary: 6.5, secondary: 5.5, tertiary: 4.5, minor: 3.5, service: 2.3, track: 1.6, raceway: 4 };
const PATH_W = { pedestrian: 3, footway: 1.1, cycleway: 1, path: 1, steps: 1, bridleway: 1 };

export async function groundFeatures(F) {
  const tj = await (await fetch(TILEJSON)).json();
  const tpl = tj.tiles?.[0];
  if (!tpl) throw new Error('no tile URL');
  const z = 14, n = 2 ** z;
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  const [w, s] = F.toLonLat(-R_LOAD, -R_LOAD), [e, nn] = F.toLonLat(R_LOAD, R_LOAD);
  const tiles = [];
  for (let x = tx(w); x <= tx(e); x++) for (let y = ty(nn); y <= ty(s); y++) tiles.push([x, y]);
  const out = { polys: [], lines: [] };
  await Promise.all(tiles.map(async ([x, y]) => {
    const r = await fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    if (!r.ok) return;
    const Ls = decodeMVT(new Uint8Array(await r.arrayBuffer()));
    const loc = (L0, pts) => pts.map(([px, py]) => F.toLocal(...toLonLat(z, x, y, L0.extent, px, py)));
    const polysOf = (L0, f, kind) => {   // a counter-clockwise ring (north up) starts a polygon, clockwise rings are its holes
      let curP = null;
      for (const ring of featureGeometry(f)) {
        const q = loc(L0, ring); if (q.length < 4) continue; q.pop();
        if (signedArea(q) > 0) { curP = { kind, outer: q, holes: [] }; out.polys.push(curP); } else if (curP) curP.holes.push(q.reverse());
      }
    };
    for (const [name, kindOf] of [['landcover', (p) => (p.class === 'wood' ? 'wood' : 'grass')], ['park', () => 'grass'], ['water', () => 'water'],
      ['landuse', (p) => (['pitch', 'playground', 'cemetery'].includes(p.class) ? 'grass' : null)]]) {
      const L0 = Ls[name]; if (!L0) continue;
      for (const f of L0.feats) { if (f.type !== 3) continue; const k = kindOf(props(L0, f)); if (k) polysOf(L0, f, k); }
    }
    const T = Ls.transportation;
    for (const f of T?.feats || []) {
      const p = props(T, f);
      if (p.brunnel === 'tunnel' || ['rail', 'transit', 'ferry', 'aerialway'].includes(p.class)) continue;
      if (f.type === 3) { if (p.class === 'path') polysOf(T, f, 'plaza'); continue; }
      if (f.type !== 2) continue;
      const hw = p.class === 'path' ? PATH_W[p.subclass] : ROAD_W[p.class];
      if (!hw) continue;
      for (const line of featureGeometry(f)) out.lines.push({ kind: p.class === 'path' ? 'path' : 'road', hw, cls: p.class + (p.subclass ? '/' + p.subclass : '') + (p.service ? ':' + p.service : ''), pts: loc(T, line) });
    }
  }));
  return out;
}

// The ground: one terrain grid (flat where js/terrain.js has no data) coloured by the orthophoto where there is one,
// with paving and grass texture as detail; green and water come from a cover map painted from the base map's polygons
// (R green, G water), so they follow the terrain without meshes of their own. Roads and paths are draped meshes.
const GRID_STEP = 4;   // m between terrain vertices
const ROAD_COL = { road: 0x46494d, path: 0xb0a898 };
function coverMap(G, Rg) {
  const S = 2048, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), px = (x) => ((x + Rg) / (2 * Rg)) * S, py = (y) => ((Rg - y) / (2 * Rg)) * S;
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  for (const p of G?.polys || []) {
    const c = p.kind === 'grass' || p.kind === 'wood' ? '#ff0000' : p.kind === 'water' ? '#00ff00' : null;
    if (!c) continue;
    g.beginPath();
    for (const r of [p.outer, ...p.holes]) r.forEach(([x, y], i) => (i ? g.lineTo(px(x), py(y)) : g.moveTo(px(x), py(y))));
    g.fillStyle = c; g.fill('evenodd');
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
// key: three.js caches programs by the onBeforeCompile source, which is the same for every ground material, so each
// needs its own cache key (without it the roads reused the terrain's program and its samplers, and were not drawn)
function groundShader(m, T, terr, extra, body, key) {
  m.customProgramCacheKey = () => 'walk-ground-' + key;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tDop: { value: terr?.dop || blank }, uDop: { value: terr?.dop ? 1 : 0 } }, extra);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aDop; attribute vec2 aCls; attribute vec3 aRoad; varying vec2 vDop; varying vec2 vCls; varying vec3 vRoad; varying vec3 vPos; varying vec3 vNW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDop = aDop; vCls = aCls; vRoad = aRoad; vPos = position; vNW = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
      varying vec2 vDop; varying vec2 vCls; varying vec3 vRoad; varying vec3 vPos; varying vec3 vNW;
      uniform sampler2D tDop; uniform float uDop; ${Object.keys(extra).map((k) => `uniform sampler2D ${k};`).join(' ')}
      ${GLSL_COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      float rough = 0.95; vec3 nMap = vec3(0.0, 0.0, 1.0); float nK = 0.0; vec2 gp = vec2(vPos.x, -vPos.z);   // metres east, north
      ${body}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      { vec3 nG = normalize(vNW); if (nG.y < 0.0) nG = -nG; vec3 nP = normalize(vec3(1.0, 0.0, 0.0) * nMap.x * nK + vec3(0.0, 0.0, -1.0) * nMap.y * nK + nG * mix(1.0, nMap.z, nK));
        normal = normalize((viewMatrix * vec4(nP, 0.0)).xyz); }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = rough;');
  };
  return m;
}
// terrain heights on the grid nodes, and the same bilinear surface for every other use
export function terrainGrid(hRaw) {
  const Rg = R_LOAD + GROUND_PAD, n = Math.round((2 * Rg) / GRID_STEP) + 1, Z = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Z[i * n + j] = hRaw(-Rg + j * GRID_STEP, Rg - i * GRID_STEP);
  const h = (x, y) => {
    const gx = Math.max(0, Math.min(n - 1.0001, (x + Rg) / GRID_STEP)), gy = Math.max(0, Math.min(n - 1.0001, (Rg - y) / GRID_STEP));
    const j = Math.floor(gx), i = Math.floor(gy), fx = gx - j, fy = gy - i, k = i * n + j;
    return (Z[k] * (1 - fx) + Z[k + 1] * fx) * (1 - fy) + (Z[k + n] * (1 - fx) + Z[k + n + 1] * fx) * fy;
  };
  return { n, Z, Rg, h };
}
export function groundMesh(G, T, terr, gh, grid) {
  const grp = new THREE.Group(), Rg = grid.Rg, n = grid.n;
  const dopUV = terr?.dop ? terr.dopUV : () => [-1, -1];
  // terrain grid
  const P = new Float32Array(n * n * 3), D = new Float32Array(n * n * 2), Cc = new Float32Array(n * n * 2);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = -Rg + j * GRID_STEP, y = Rg - i * GRID_STEP, k = i * n + j, d = dopUV(x, y);
    P.set([x, grid.Z[k], -y], k * 3); D.set(d, k * 2); Cc.set([(x + Rg) / (2 * Rg), (y + Rg) / (2 * Rg)], k * 2);
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < n; j++) { const a = i * n + j, b = a + 1, c = a + n, d = c + 1; idx.set([a, c, b, b, c, d], q); q += 6; }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(P, 3)); tg.setAttribute('aDop', new THREE.BufferAttribute(D, 2)); tg.setAttribute('aCls', new THREE.BufferAttribute(Cc, 2));
  tg.setAttribute('aRoad', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
  tg.setIndex(new THREE.BufferAttribute(idx, 1)); tg.computeVertexNormals();
  const cover = coverMap(G, Rg);
  const tm = groundShader(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 }), T, terr,
    { tCls: { value: cover }, tPvC: { value: T.pvC }, tPvN: { value: T.pvN }, tGrC: { value: T.grC }, tGrN: { value: T.grN } }, `
      vec4 cl = texture2D(tCls, vCls); float wg = clamp(cl.r, 0.0, 1.0), ww = clamp(cl.g, 0.0, 1.0);
      vec2 uvP = gp / 2.2, uvG = gp / 3.0;
      bool d = inDop(vDop); vec3 dc = d ? texture2D(tDop, vDop).rgb : vec3(0.0);
      // the orthophoto gives the tone only: half weight and less colour, because tree crowns in it would otherwise
      // stain the ground under trees that are not modelled yet
      vec3 dcs = mix(vec3(dot(dc, vec3(0.299, 0.587, 0.114))), dc, 0.55);
      vec3 pvT = texture2D(tPvC, uvP).rgb * 0.95, grT = texture2D(tGrC, uvG).rgb;
      vec3 pav = d ? mix(pvT, dcs * detail(tPvC, uvP), 0.5) : pvT;
      vec3 grs = d ? mix(grT, dc * detail(tGrC, uvG), 0.5) : grT;
      vec3 c = mix(pav, grs, wg);
      c = mix(c, vec3(0.13, 0.2, 0.26), ww);                                      // water
      rough = mix(0.95, 0.06, ww);
      nMap = mix(texture2D(tPvN, uvP).xyz, texture2D(tGrN, uvG).xyz, wg) * 2.0 - 1.0; nK = 0.7 * (1.0 - ww);
      diffuseColor.rgb = c;`, 'terrain');
  const terrain = new THREE.Mesh(tg, tm);
  terrain.receiveShadow = true;
  grp.add(terrain);
  grp.userData.textures = [cover];
  if (!G) return grp;
  // roads and paths, cut into pieces of at most 6 m and laid on the terrain
  const by = {};
  const add = (kind, p, r, d) => { const o = (by[kind] ||= { p: [], r: [], d: [] }); o.p.push(...p); o.r.push(...r); o.d.push(...d); };
  for (const l of G.lines) {
    const lift = l.kind === 'road' ? 0.05 : 0.07;
    let s = 0;   // distance along the line, for the dashes
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = l.pts[i], b = l.pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, nx = -uy * l.hw, ny = ux * l.hw, e = l.hw * 0.5;
      const k = Math.max(1, Math.ceil((len + 2 * e) / 6));
      for (let m = 0; m < k; m++) {
        const t0 = -e + ((len + 2 * e) * m) / k, t1 = -e + ((len + 2 * e) * (m + 1)) / k;   // extended: joints overlap instead of gaping
        const A = [a[0] + ux * t0, a[1] + uy * t0], Bp = [a[0] + ux * t1, a[1] + uy * t1];
        const qd = [[A[0] + nx, A[1] + ny, 1, s + t0], [A[0] - nx, A[1] - ny, -1, s + t0], [Bp[0] - nx, Bp[1] - ny, -1, s + t1], [Bp[0] + nx, Bp[1] + ny, 1, s + t1]];
        for (const v of [0, 1, 2, 0, 2, 3]) { const [x, y, ac, al] = qd[v]; add(l.kind, [x, gh(x, y) + lift, -y], [ac, al, l.hw], dopUV(x, y)); }
      }
      s += len;
    }
  }
  for (const [kind, o] of Object.entries(by)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(o.r, 3));
    g.setAttribute('aDop', new THREE.Float32BufferAttribute(o.d, 2));
    g.setAttribute('aCls', new THREE.Float32BufferAttribute(new Float32Array((o.p.length / 3) * 2), 2));
    g.computeVertexNormals();
    const road = kind === 'road';
    const m = groundShader(new THREE.MeshStandardMaterial({ color: ROAD_COL[kind], roughness: 0.95, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: road ? -4 : -5, polygonOffsetUnits: road ? -16 : -20 }), T, terr,
      road ? { tAsC: { value: T.asC }, tAsN: { value: T.asN } } : { tPvC: { value: T.pvC }, tPvN: { value: T.pvN } }, road ? `
      vec2 uv = gp / 3.0;
      vec3 c = texture2D(tAsC, uv).rgb * 0.8;
      float hw = vRoad.z, a = abs(vRoad.x) * hw;
      c = mix(c, vec3(0.66, 0.65, 0.62), step(hw - 0.28, a));                                                 // kerb stones
      c = mix(c, vec3(0.86), step(4.4, hw) * step(a, 0.07) * step(fract(vRoad.y / 6.0), 0.5));               // dashed centre line
      c = mix(c, vec3(0.82), step(5.0, hw) * step(abs(a - (hw - 0.6)), 0.06));                                // edge lines
      nMap = texture2D(tAsN, uv).xyz * 2.0 - 1.0; nK = 0.8;
      diffuseColor.rgb = c;` : `
      vec2 uv = gp / 1.3;
      bool d = inDop(vDop);
      vec3 c = texture2D(tPvC, uv).rgb * 0.9;
      if (d) c = mix(c, texture2D(tDop, vDop).rgb * detail(tPvC, uv), 0.35);
      nMap = texture2D(tPvN, uv).xyz * 2.0 - 1.0; nK = 0.8;
      diffuseColor.rgb = c;`, kind);
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    grp.add(mesh);
  }
  return grp;
}

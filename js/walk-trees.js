// Trees of the street walk (js/walk.js): the Bavarian single-tree data (data/trees, tools/trees_build.py; Einzelbäume 2024, CC BY 4.0) give
// measured positions and heights; the data have no crown size, so the crown follows the height (treeMesh)
import * as THREE from 'three';
import { utmFrame } from './terrain.js';
import { inside } from './walk-common.js';

export async function loadTrees(F, R) {
  let idx;
  try { const r = await fetch('data/trees/index.json'); if (!r.ok) return []; idx = await r.json(); } catch { return []; }
  const { toUTM, fromUTM } = utmFrame(F);
  const cs = [[-R, -R], [R, -R], [R, R], [-R, R]].map(([x, y]) => toUTM(x, y));
  const e0 = Math.floor(Math.min(...cs.map((c) => c[0])) / 1000), e1 = Math.floor(Math.max(...cs.map((c) => c[0])) / 1000);
  const n0 = Math.floor(Math.min(...cs.map((c) => c[1])) / 1000), n1 = Math.floor(Math.max(...cs.map((c) => c[1])) / 1000);
  const have = new Set(idx.tiles.map((t) => t.key)), keys = [];
  for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) if (have.has(`${e}_${n}`)) keys.push([e, n]);
  const out = [];
  await Promise.all(keys.map(async ([e, n]) => {
    const r = await fetch(`data/trees/t_${e}_${n}.bin`);
    if (!r.ok) return;
    const dv = new DataView(await r.arrayBuffer());
    for (let o = 0; o + 5 <= dv.byteLength; o += 5) {
      const [x, y] = fromUTM(e * 1000 + dv.getUint16(o, true) / 65.535, n * 1000 + dv.getUint16(o + 2, true) / 65.535);
      if (Math.abs(x) <= R && Math.abs(y) <= R) out.push(x, y, dv.getUint8(o + 4) * 0.25);
    }
  }));
  return out;   // x, y, height, …
}
// A street tree as a trunk and 5 to 9 leaf clumps inside an ellipsoid crown: the crown takes the upper 55 to 70 % of
// the measured height and is about 0.32 h + 1.2 m wide (the data have no crown size; ratios of common street trees),
// so a 20 m lime gets a 4 to 6 m trunk and a 7.6 m crown. Trees are grouped in 150 m cells, so cells out of view are
// not drawn, not even into the shadow map.
const TREE_CELL = 150;
export function treeMesh(T, gh, B) {
  const grp = new THREE.Group(), n = T.length / 3;
  grp.userData.count = 0;
  if (!n) return grp;
  const trunkG = new THREE.CylinderGeometry(0.1, 0.17, 1, 6); trunkG.translate(0, 0.5, 0);
  const clumpG = new THREE.IcosahedronGeometry(1, 1);
  const trunkM = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 0.95 });
  const cm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
  cm.customProgramCacheKey = () => 'walk-crown';
  cm.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
      attribute float aShade; varying float vShade; varying float vUnder;
      float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float n3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      { vec3 seed = instanceMatrix[3].xyz * 0.41;
        transformed *= 0.8 + 0.45 * n3(position * 2.6 + seed); vUnder = position.y; vShade = aShade; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vShade; varying float vUnder;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.55, 1.08, vShade) * mix(0.72, 1.06, smoothstep(-0.8, 0.8, vUnder));');
  };
  const rnd = (i, k) => { const t = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return t - Math.floor(t); };
  const cells = new Map();
  const cell = (x, y) => { const key = Math.floor(x / TREE_CELL) + ',' + Math.floor(y / TREE_CELL); if (!cells.has(key)) cells.set(key, { trunk: [], clump: [], col: [], shade: [] }); return cells.get(key); };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), c = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = T[3 * i], y = T[3 * i + 1], h = Math.max(3, Math.min(40, T[3 * i + 2]));
    // a tree point inside a building taller than the tree is a data error (or a roof garden): leave it out
    let inB = false;
    for (const j of B.grid.get(Math.floor(x / B.C) + ',' + Math.floor(y / B.C)) || []) { const b = B.list[j]; if (b.top > h * 0.6 && inside(x, y, b)) { inB = true; break; } }
    if (inB) continue;
    const C = cell(x, y), g = gh(x, y);
    const chH = h * (0.55 + 0.15 * rnd(i, 1)), base = g + h - chH, R = Math.max(1, Math.min(6.5, 0.16 * h + 0.6)) * (0.85 + 0.3 * rnd(i, 2));
    const tw = 0.6 + h / 30;
    C.trunk.push(m4.compose(v.set(x, g - 0.2, -y), q.identity(), s.set(tw, h - chH * 0.7 + 0.2, tw)).clone());
    const hue = 0.24 + 0.07 * rnd(i, 3), sat = 0.4 + 0.2 * rnd(i, 4), lit = 0.13 + 0.07 * rnd(i, 5);
    const k = 5 + Math.floor(rnd(i, 6) * 5);
    for (let j = 0; j <= k; j++) {
      // clump 0 fills the middle; the others sit towards the outside of the crown, more of them up than down
      const u = rnd(i, 10 + j), w = rnd(i, 30 + j), z = rnd(i, 50 + j);
      const th = u * 6.283, cz = j ? 0.15 + 0.85 * w * 2 - 1 : 0, sz = Math.sqrt(Math.max(0, 1 - cz * cz)), rr = j ? 0.35 + 0.45 * z : 0;
      const cr = R * (j ? 0.36 + 0.22 * rnd(i, 70 + j) : 0.58);
      let py = base + chH / 2 + cz * (chH / 2) * rr;
      py = Math.min(py, g + h - cr * 0.8);
      v.set(x + Math.cos(th) * sz * R * rr, py, -y + Math.sin(th) * sz * R * rr);
      q.setFromAxisAngle(UP, rnd(i, 90 + j) * 6.283);
      C.clump.push(m4.compose(v, q, s.set(cr, cr * 0.82, cr * (0.85 + 0.3 * rnd(i, 110 + j)))).clone());
      c.setHSL(hue + 0.02 * (rnd(i, 130 + j) - 0.5), sat, lit * (0.92 + 0.16 * rnd(i, 150 + j)));
      C.col.push(c.r, c.g, c.b);
      C.shade.push(Math.max(0, Math.min(1, (py - base) / chH)));
    }
    count++;
  }
  for (const C of cells.values()) {
    const tr = new THREE.InstancedMesh(trunkG, trunkM, C.trunk.length);
    C.trunk.forEach((mm, k) => tr.setMatrixAt(k, mm));
    const g = clumpG.clone();
    g.setAttribute('aShade', new THREE.InstancedBufferAttribute(new Float32Array(C.shade), 1));
    const cl = new THREE.InstancedMesh(g, cm, C.clump.length);
    C.clump.forEach((mm, k) => cl.setMatrixAt(k, mm));
    cl.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(C.col), 3);
    for (const im of [tr, cl]) { im.castShadow = im.receiveShadow = true; im.computeBoundingSphere(); }
    grp.add(tr, cl);
  }
  grp.userData.count = count;
  return grp;
}

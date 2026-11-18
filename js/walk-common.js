// Shared by the street walk modules (js/walk.js and the js/walk-*.js it uses): the extent of the scene, small geometry
// helpers, the material textures and the GLSL that the building and ground shaders both use.
import * as THREE from 'three';
import { pointInPolygon } from './geo.js';

export const R_LOAD = 700;          // m around the start: buildings and ground
export const GROUND_PAD = 250;      // m of ground beyond the buildings, under the fog
export const EYE = 1.7;             // m
export const col = (c) => new THREE.Color(c);
export const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);   // stands in for a missing orthophoto
blank.needsUpdate = true;
export const hash = (s) => { let x = 2166136261; for (const ch of String(s)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return (x >>> 0) / 4294967296; };
export const triangulate = (outer, holes) => { try { return THREE.ShapeUtils.triangulateShape(outer.map(([x, y]) => new THREE.Vector2(x, y)), holes.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)))); } catch { return []; } };
export const inside = (x, y, b) => x >= b.bbox[0] && x <= b.bbox[2] && y >= b.bbox[1] && y <= b.bbox[3] && pointInPolygon([x, y], b.ring, b.holes);

// ---------- textures (assets/textures, ambientCG, CC0): colour and OpenGL normal maps, repeated in metres
const TEX_FILES = { pl: 'Plaster001', br: 'Bricks059', ti: 'RoofingTiles006', sl: 'RoofingTiles013A', pv: 'PavingStones070', gr: 'Grass004', as: 'Asphalt031' };
export function loadTextures(renderer) {
  const ld = new THREE.TextureLoader(), an = Math.min(8, renderer.capabilities.getMaxAnisotropy()), out = {};
  for (const [k, f] of Object.entries(TEX_FILES)) {
    for (const [t, cs] of [['color', THREE.SRGBColorSpace], ['normal', THREE.NoColorSpace]]) {
      const x = ld.load(`assets/textures/${f}_${t}.jpg`);
      x.wrapS = x.wrapT = THREE.RepeatWrapping; x.colorSpace = cs; x.anisotropy = an;
      out[k + (t === 'color' ? 'C' : 'N')] = x;
    }
  }
  return out;
}
// GLSL shared by the building and ground shaders: value noise, the orthophoto lookup and a detail tint (a texture's
// colour divided by its own mean, from the last mip level, so it adds texture without changing the base colour)
export const GLSL_COMMON = `
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
  vec3 detail(sampler2D t, vec2 uv) { return texture2D(t, uv).rgb / max(textureLod(t, vec2(0.5), 12.0).rgb, vec3(0.04)); }
  bool inDop(vec2 uv) { return uDop > 0.5 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0; }`;

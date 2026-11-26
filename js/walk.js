// Walk through the streets around the selected building in first person. The scene is a synthetic model built in the
// browser from data the tool already has, not photos:
//   buildings  every OSM outline within R_LOAD of the building (data/osm), raised to the LoD2 eaves height with the
//              LoD2 storeys (data/lod2); without LoD2, heightAndUsage of js/geometry.js (OSM tags and default rules),
//              the same heights as the neighbours of the energy model.
//   roofs      shaped from the roof type (LoD2, else the OSM roof:shape tag) with the roof builders of the 3D view
//              (js/scene3d.js): a gable or hip roof over a near-rectangular outline, else a hip roof inset from the
//              outline, with gable walls where a neighbour shares the wall; a flat top when no valid roof exists.
//   materials  the OSM building:material and roof:material tags where they exist (brick, glass, copper, green roof …),
//              else plaster in a few common light colours and clay tiles; procedural plaster, plinth, cornice, window
//              frames and sills, shop fronts on the ground floor of buildings tagged as shops, cafés and the like.
//   windows    a pattern per storey (sill 0.9 m, head 0.45 m below the next floor) spaced to an average window-to-wall
//              ratio (WWR_DEFAULT, or the model's own estimate for the selected building): the look of an estimate.
//   ground     the DGM1 terrain and the DOP40 orthophoto where data/terrain has them (js/terrain.js; now the four km
//              around the TUM main building), else flat; roads (kerbs, centre lines) and paths from the base map's
//              vector tiles (OpenFreeMap / OpenMapTiles, z14, js/mvt.js) laid on the terrain; green and water painted
//              into a cover map read by the ground shader.
//   trees      the Bavarian single-tree data (data/trees): measured position and height, crown estimated from the height.
//   textures   ambientCG materials (CC0, assets/textures): plaster, brick, clay and slate tiles, paving, grass, asphalt,
//              colour and normal maps, repeated in metres; flat roofs take the orthophoto.
//   light      a physical sky (three.js Sky, with clouds) for the month and hour chosen under the 3D view, sky light
//              as environment (windows reflect the sky), shadows, ambient occlusion (GTAO) and ACES tone mapping.
// Only the selected building is tinted (the selection teal); no building is coloured by its values.
// Controls: drag to look, W A S D or the arrow keys to walk, Shift to run, Q / E to lower or raise the eye, Esc to
// leave; buildings stop you unless you are above them. The map below follows with the cone of js/map.js
// setWalkCam; in full screen it becomes a small map in the corner.
// This file opens and closes the walk and runs the camera, controls and loop; the scene comes from js/walk-buildings.js,
// js/walk-ground.js and js/walk-trees.js, with the shared extent, textures and GLSL in js/walk-common.js.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { L } from './i18n.js';
import { CITY } from './city.js';
import { around, lod2Around } from './osmdb.js';
import { makeFrame } from './geo.js';
import { loadGround } from './terrain.js';
import { R_LOAD, GROUND_PAD, EYE, loadTextures } from './walk-common.js';
import { WWR_DEFAULT, buildingList, partyWalls, free, buildingMesh } from './walk-buildings.js';
import { groundFeatures, terrainGrid, groundMesh } from './walk-ground.js';
import { loadTrees, treeMesh } from './walk-trees.js';

let cur = null;
// the panel selected another building while the walk stays open (a pick in the walk, or the same building again)
export const walkSelect = (id) => cur?.setSelected?.(id);

export function closeWalk() {
  if (!cur) return;
  const c = cur; cur = null;
  cancelAnimationFrame(c.raf);
  for (const [t, ev, fn, o] of c.listeners) t.removeEventListener(ev, fn, o);
  c.ro?.disconnect();
  if (document.fullscreenElement === c.host) document.exitFullscreen().catch(() => {});
  c.host.classList.remove('walk-full');
  c.mapApi.miniMode(false);
  c.scene?.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  c.env?.dispose(); c.composer?.dispose?.();
  for (const t of Object.values(c.tex || {})) t.dispose();
  for (const t of c.groundTex || []) t.dispose();
  c.terrDop?.dispose();
  if (c.renderer) { c.renderer.dispose(); c.renderer.forceContextLoss(); }
  c.box.remove();
  c.mapApi.setWalkCam(null);
  c.mapApi.setTopInset(0);
  c.mapApi.resize();
  if (c.back?.isConnected) c.back.focus({ preventScroll: true });
}

// model: the selected building (id, lonlatOuter, center, height, floors, roof, …); ctx: { h, info, mapApi, host, sun
// ({ azimuth, altitude } or null), wwr (the model's window-to-wall ratio or null), and for a city other than Munich
// tipText (what the scene is made of) and heightOf (record → { eaves, floors } or null: the city's own heights) }
export async function openWalk(model, ctx) {
  closeWalk();
  const { h, mapApi, host } = ctx;
  const view = h('div', { class: 'walk-view' });
  const msg = h('p', { class: 'walk-msg', role: 'status' }, L('正在搭建街区…', 'Building the streets…', 'Straßen werden aufgebaut …'));
  const hint = h('p', { class: 'walk-hint' }, L('拖动转向 · 点楼选中 · W A S D 或方向键走 · Shift 快走 · Q / E 降低或升高视点 · Esc 退出',
    'Drag to look · click a building to select it · W A S D or arrow keys to walk · Shift to run · Q / E to lower or raise your eye · Esc to leave',
    'Ziehen zum Umsehen · Gebäude anklicken zum Auswählen · W A S D oder Pfeiltasten zum Gehen · Umschalt zum Laufen · Q / E Augenhöhe senken oder heben · Esc zum Verlassen'));
  const shut = h('button', { type: 'button', class: 'walk-btn walk-x', onclick: () => closeWalk(),
    'aria-label': L('离开街区', 'Leave the street model', 'Straßenmodell verlassen'), title: L('离开街区（Esc）', 'Leave the street model (Esc)', 'Straßenmodell verlassen (Esc)') }, '×');
  // full screen takes the whole map column, so the map can stay on as a small map in the corner
  const full = h('button', { type: 'button', class: 'walk-btn', title: L('全屏', 'Full screen', 'Vollbild'), 'aria-label': L('全屏', 'Full screen', 'Vollbild'),
    onclick: () => (document.fullscreenElement ? document.exitFullscreen() : host.requestFullscreen?.())?.catch?.(() => {}) }, '⛶');
  const tip = ctx.info?.(ctx.tipText || L(
    `合成的街区，不是照片。楼是 OSM 轮廓，高度和层数来自巴伐利亚 LoD2；没有 LoD2 的楼按 OSM 标签和默认规则估，和能耗模型里的邻楼一样。屋顶按屋顶类型生成（LoD2，否则 OSM 的 roof:shape）：近似矩形的楼做双坡或四坡，其他轮廓做内缩坡顶，和邻楼共墙的一侧做山墙，生成不了时退回平顶。墙面和屋面材料取 OSM 的材料标签（有标签的楼不多），其他楼用几种常见的浅色抹灰和陶瓦。窗按层高和平均窗墙比画出（进入漫游时所选的楼用模型估的 ${ctx.wwr ? Math.round(ctx.wwr * 100) + '%' : '值'}，其他楼 ${Math.round(WWR_DEFAULT * 100)}%），标了商铺的楼底层画成橱窗：都是估算的样子，不是真实的立面。地形和地面颜色来自巴伐利亚测绘局的 DGM1 和 DOP40 航拍（目前只有 TUM 主楼周围 4 km²，别处是平地），平屋顶直接用航拍；道路、绿地和水面来自底图（OpenFreeMap / OpenMapTiles）；墙、瓦、铺地、草和沥青的纹理来自 ambientCG（CC0）。树来自巴伐利亚单棵树数据（2024），位置和树高是实测的，树冠大小按常见行道树的比例从树高估算。天空和太阳取 3D 视图里选的月份和时刻。只有所选楼着青色；点一栋楼就选中它，右侧换成这栋楼的结果。`,
    `A synthetic street model, not photos. Buildings are OSM outlines with heights and storeys from the Bavarian LoD2; without LoD2 they are estimated from the OSM tags and default rules, as for the neighbours of the energy model. Roofs are shaped from the roof type (LoD2, else the OSM roof:shape tag): a gable or hip roof over near-rectangular outlines, an inset hip roof over other outlines, gable walls where a neighbour shares the wall, and a flat top where no valid roof can be built. Wall and roof materials come from the OSM material tags (few buildings have them); the others get a few common light plaster colours and clay tiles. Windows follow the storey height and an average window-to-wall ratio (${ctx.wwr ? Math.round(ctx.wwr * 100) + '%, the model’s estimate,' : 'the model’s estimate'} for the building selected on entry, ${Math.round(WWR_DEFAULT * 100)}% for the others), and buildings tagged as shops get shop fronts: the look of an estimate, not the real facades. Terrain and ground colour come from the DGM1 and the DOP40 orthophoto of the Bavarian surveying agency (so far only the 4 km² around the TUM main building, flat elsewhere), and flat roofs take the orthophoto; roads, green and water come from the base map (OpenFreeMap / OpenMapTiles); wall, tile, paving, grass and asphalt textures come from ambientCG (CC0). Trees come from the Bavarian single-tree data (2024): measured positions and heights, crowns estimated from the height. Sky and sun follow the month and hour chosen under the 3D view. Only the selected building is tinted; click a building to select it, and the panel switches to it.`,
    `Ein synthetisches Straßenmodell, keine Fotos. Gebäude sind OSM-Umrisse mit Höhen und Geschossen aus dem bayerischen LoD2; ohne LoD2 aus OSM-Tags und Standardregeln geschätzt, wie die Nachbarn im Energiemodell. Dächer entstehen aus der Dachform (LoD2, sonst das OSM-Tag roof:shape): Sattel- oder Walmdach über annähernd rechteckigen Umrissen, sonst ein eingerücktes Walmdach, Giebelwände dort, wo ein Nachbar die Wand teilt, und ein Flachdach, wo sich kein gültiges Dach bilden lässt. Wand- und Dachmaterialien stammen aus den OSM-Materialtags (nur wenige Gebäude haben sie); die übrigen erhalten einige übliche helle Putzfarben und Tonziegel. Fenster folgen der Geschosshöhe und einem mittleren Fensterflächenanteil (${ctx.wwr ? Math.round(ctx.wwr * 100) + ' %, die Schätzung des Modells,' : 'die Schätzung des Modells'} für das beim Betreten gewählte Gebäude, ${Math.round(WWR_DEFAULT * 100)} % für die übrigen), als Laden markierte Gebäude erhalten Schaufenster: das Bild einer Schätzung, nicht die echten Fassaden. Gelände und Bodenfarbe stammen aus dem DGM1 und dem Orthophoto DOP40 der Bayerischen Vermessungsverwaltung (bisher nur die 4 km² um das TUM-Hauptgebäude, sonst eben), Flachdächer zeigen das Orthophoto; Straßen, Grün und Wasser stammen aus der Grundkarte (OpenFreeMap / OpenMapTiles); Wand-, Ziegel-, Pflaster-, Gras- und Asphalttexturen von ambientCG (CC0). Bäume stammen aus den bayerischen Einzelbaumdaten (2024): gemessene Standorte und Höhen, Kronen aus der Höhe geschätzt. Himmel und Sonne folgen Monat und Uhrzeit unter der 3D-Ansicht. Nur das gewählte Gebäude ist eingefärbt; ein Klick auf ein Gebäude wählt es aus, und die Seitenleiste wechselt dorthin.`));
  const pad = h('div', { class: 'walk-pad' },
    h('button', { type: 'button', class: 'walk-btn', 'data-move': '1', 'aria-label': L('前进', 'Forward', 'Vorwärts') }, '▲'),
    h('button', { type: 'button', class: 'walk-btn', 'data-move': '-1', 'aria-label': L('后退', 'Back', 'Zurück') }, '▼'));
  const box = h('section', { class: 'walk', role: 'region', 'aria-label': L('街区漫游', 'Street walk', 'Straßenrundgang') }, view, msg, hint, pad, h('div', { class: 'walk-bar' }, tip, full, shut));
  host.append(box);
  const me = { box, host, mapApi, listeners: [], back: document.activeElement, raf: 0 };
  cur = me;
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); me.listeners.push([t, ev, fn, o]); };
  const isFull = () => document.fullscreenElement === host;
  mapApi.setTopInset(box.offsetHeight);
  const head = document.querySelector('.top')?.offsetHeight || 0;   // the sticky page header (stacked layout)
  const off = host.getBoundingClientRect().top - head;
  if (off < 0) window.scrollBy({ top: off, behavior: 'smooth' });
  shut.focus({ preventScroll: true });

  // ---- data
  const F = makeFrame(model.center.lat, model.center.lon);
  let recs, lod2, ground, terr, trees;
  try {
    // a city without LoD2, terrain or tree data (js/city.js layers, e.g. Singapore) keeps flat ground and no trees
    const lay = CITY.layers || {};
    [recs, lod2, ground, terr, trees] = await Promise.all([around(model.center.lon, model.center.lat), lay.lod2 ? lod2Around(model.center.lon, model.center.lat) : new Map(),
      groundFeatures(F).catch(() => null), lay.terrain ? loadGround(F, R_LOAD + GROUND_PAD).catch((e) => { console.warn('walk: no terrain', e); return null; }) : null,
      lay.trees ? loadTrees(F, R_LOAD).catch((e) => { console.warn('walk: no trees', e); return []; }) : []]);
  } catch (e) { if (cur === me) msg.textContent = L(`数据没有加载（${e.message}）`, `The data did not load (${e.message})`, `Die Daten wurden nicht geladen (${e.message})`); return; }
  if (cur !== me) return;
  // ground height in m relative to the start area, interpolated on the terrain grid itself, so roads, buildings and the
  // eye use exactly the surface that is drawn (the raw 2 m data have kerbs and steps that would poke through roads)
  const grid = terrainGrid(terr ? terr.h : () => 0);
  const gh = grid.h;
  const blds = buildingList(recs, lod2, F, model, ctx.wwr, gh, ctx.heightOf);   // ctx.heightOf: the city's own heights (Singapore)
  partyWalls(blds);

  // ---- renderer, sky and light
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  me.renderer = renderer;
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  view.append(renderer.domElement);
  const scene = new THREE.Scene();
  me.scene = scene;
  const sunIn = ctx.sun && ctx.sun.altitude > 4 ? ctx.sun : { azimuth: 180, altitude: 30 };
  const sa = (sunIn.azimuth * Math.PI) / 180, se = (sunIn.altitude * Math.PI) / 180;
  const sunDir = new THREE.Vector3(Math.sin(sa) * Math.cos(se), Math.sin(se), -Math.cos(sa) * Math.cos(se));
  const sky = new Sky();
  sky.scale.setScalar(2400);
  const U = sky.material.uniforms;
  U.turbidity.value = 3.2; U.rayleigh.value = 1.3; U.mieCoefficient.value = 0.004; U.mieDirectionalG.value = 0.8;
  U.cloudCoverage.value = 0.32; U.cloudDensity.value = 0.42; U.sunPosition.value.copy(sunDir);
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); envScene.add(new Sky().copy(sky));
  me.env = pm.fromScene(envScene, 0.02, 0.1, 3000);
  pm.dispose();
  scene.environment = me.env.texture;
  scene.environmentIntensity = 0.42;
  scene.add(sky);
  scene.fog = new THREE.Fog(new THREE.Color(0.9, 0.98, 1.08), 260, R_LOAD - 20);   // linear values near the sky's horizon
  const tex = loadTextures(renderer);
  me.tex = tex; me.terrDop = terr?.dop || null;
  const selIdx = blds.list.findIndex((b) => b.sel);
  const bmesh = buildingMesh(blds, tex, terr, selIdx);
  const treeG = treeMesh(trees, gh, blds);
  const gmesh = groundMesh(ground, tex, terr, gh, grid);
  me.groundTex = gmesh.userData.textures;   // the cover map, disposed on close
  scene.add(bmesh, gmesh, treeG);
  const sunL = new THREE.DirectionalLight(0xfff1dc, 3.4);
  sunL.castShadow = true;
  sunL.shadow.mapSize.set(2048, 2048);
  Object.assign(sunL.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 1, far: 900 });
  sunL.shadow.bias = -0.0004; sunL.shadow.normalBias = 0.35;
  scene.add(sunL, sunL.target);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 3000);
  camera.rotation.order = 'YXZ';
  // ambient occlusion and tone mapping as passes; the plain renderer is the fallback
  try {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const comp = new EffectComposer(renderer, rt);
    comp.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, 1, 1);
    ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.4, thickness: 2.5, scale: 1.2, samples: 12, distanceFallOff: 1 });
    ao.blendIntensity = 0.85;
    comp.addPass(ao);
    comp.addPass(new OutputPass());
    me.composer = comp;
  } catch (e) { console.warn('walk: no ambient occlusion', e); me.composer = null; }
  const size = () => {
    const w = view.clientWidth || 1, hh = view.clientHeight || 1;
    renderer.setSize(w, hh, false); me.composer?.setSize(w, hh);
    camera.aspect = w / hh; camera.updateProjectionMatrix();
  };
  me.ro = new ResizeObserver(() => { size(); if (!isFull()) mapApi.setTopInset(box.offsetHeight); });
  me.ro.observe(view);
  size();

  // ---- start: on the street about 22 m from the building, looking at it
  const P = { x: 0, y: 0, z: EYE, yaw: 0, pitch: -0.04 };
  const start = startPoint(blds.sel, ground, blds, gh);
  Object.assign(P, start);
  box.dataset.start = start.why || '';   // where the walk starts (for checks)
  box.dataset.roofs = `${blds.roofs.shaped}/${blds.roofs.pitched}`;
  box.dataset.trees = String(treeG.userData.count || 0);
  box.dataset.picked = model.id;
  box.dataset.terrain = terr ? `${terr.tiles} tiles, ${terr.range.map((v) => v.toFixed(1)).join(' to ')} m, dop ${!!terr.dop}` : 'flat';
  msg.remove();

  // ---- controls
  const keys = new Set();
  let drag = null, moved = false, padDir = 0;
  const isTyping = (e) => e.target.closest?.('input, textarea, select');
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') { if (!isFull()) closeWalk(); return; }   // in full screen the first Esc leaves full screen
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) { keys.add(e.code); e.preventDefault(); }
  }, true);
  on(document, 'keyup', (e) => keys.delete(e.code), true);
  on(window, 'blur', () => keys.clear());
  const cv = renderer.domElement;
  // a click (no drag) picks the building under the pointer: it turns teal here and the panel switches to it; hovering
  // a building lightens it and shows its name or address
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), SU = bmesh.userData.U, aIdx = bmesh.geometry.attributes.aIdx;
  ray.far = 450;
  const tag = h('div', { class: 'walk-tag', hidden: true });
  box.append(tag);
  const under = (e) => {
    const r = cv.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(bmesh, false)[0];
    return hit ? aIdx.getX(hit.face.a) : -1;
  };
  let down = null, lastHover = 0;
  on(cv, 'pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; down = { x: e.clientX, y: e.clientY, t: performance.now() }; cv.setPointerCapture(e.pointerId); });
  on(cv, 'pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 600) { down = null; return; }
    down = null;
    const i = under(e), b = blds.list[i];
    if (!b) return;
    SU.uSel.value = i; SU.uHover.value = -1; tag.hidden = true;
    box.dataset.picked = b.id;
    ctx.onPick?.(b.id, ...F.toLonLat((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2));
  });
  on(cv, 'pointerleave', () => { SU.uHover.value = -1; tag.hidden = true; });
  on(cv, 'pointermove', (e) => {
    if (!drag && e.pointerType === 'mouse' && performance.now() - lastHover > 90) {
      lastHover = performance.now();
      const i = under(e), b = blds.list[i];
      SU.uHover.value = b && i !== SU.uSel.value ? i : -1;
      if (b) {
        tag.textContent = (b.label || L('无名称的楼', 'Unnamed building', 'Gebäude ohne Namen')) + (i === SU.uSel.value ? '' : L(' · 点击选中', ' · click to select', ' · zum Auswählen klicken'));
        const r = box.getBoundingClientRect();
        tag.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 220)}px`; tag.style.top = `${e.clientY - r.top + 16}px`;
      }
      tag.hidden = !b;
      cv.style.cursor = b && i !== SU.uSel.value ? 'pointer' : '';
    }
    if (!drag || drag.id !== e.pointerId) return;
    P.yaw += (e.clientX - drag.x) * 0.0042;
    P.pitch = Math.max(-1.35, Math.min(1.35, P.pitch - (e.clientY - drag.y) * 0.0042));   // mouse up = look up
    drag.x = e.clientX; drag.y = e.clientY; moved = true;
  });
  const up = () => { drag = null; };
  on(cv, 'pointerup', up); on(cv, 'pointercancel', up);
  me.setSelected = (id) => { const i = blds.list.findIndex((b) => b.id === id); SU.uSel.value = i; box.dataset.picked = id; };
  for (const b of pad.querySelectorAll('button')) {
    on(b, 'pointerdown', (e) => { padDir = +b.dataset.move; b.setPointerCapture(e.pointerId); e.preventDefault(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) on(b, ev, () => { padDir = 0; });
  }
  // full screen: the map shrinks to a small map in the corner (CSS .walk-full) and keeps the camera in its centre
  on(document, 'fullscreenchange', () => {
    host.classList.toggle('walk-full', isFull());
    requestAnimationFrame(() => { size(); mapApi.resize(); mapApi.setTopInset(isFull() ? 0 : box.offsetHeight); mapApi.miniMode(isFull()); });
  });

  // ---- loop
  let last = performance.now(), lastSync = 0, lastFollow = 0;
  const step = (now) => {
    if (cur !== me) return;
    me.raf = requestAnimationFrame(step);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3.2 : 1;
    let fwd = padDir, side = 0, turn = 0, rise = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyD')) side += 1;
    if (keys.has('KeyA')) side -= 1;
    if (keys.has('ArrowRight')) turn += 1;
    if (keys.has('ArrowLeft')) turn -= 1;
    if (keys.has('KeyE')) rise += 1;
    if (keys.has('KeyQ')) rise -= 1;
    P.yaw += turn * 1.6 * dt;
    P.z = Math.max(EYE, Math.min(150, P.z + rise * 8 * run * dt));
    if (fwd || side) {
      const v = 4.2 * run * dt, s = Math.sin(P.yaw), c = Math.cos(P.yaw);
      const dx = (fwd * s + side * c) * v, dy = (fwd * c - side * s) * v;
      const zA = (x, y) => gh(x, y) + P.z;   // the eye above sea-level-relative ground
      if (free(P.x + dx, P.y + dy, zA(P.x + dx, P.y + dy), blds)) { P.x += dx; P.y += dy; }
      else if (free(P.x + dx, P.y, zA(P.x + dx, P.y), blds)) P.x += dx;       // slide along the wall
      else if (free(P.x, P.y + dy, zA(P.x, P.y + dy), blds)) P.y += dy;
      moved = true;
    }
    if (moved && !hint.classList.contains('gone')) setTimeout(() => hint.classList.add('gone'), 2500);
    const g0 = gh(P.x, P.y);
    camera.position.set(P.x, g0 + P.z, -P.y);
    camera.rotation.set(P.pitch, -P.yaw, 0);
    sky.position.copy(camera.position);
    sunL.position.set(P.x + sunDir.x * 400, g0 + sunDir.y * 400, -P.y + sunDir.z * 400);
    sunL.target.position.set(P.x, g0, -P.y);
    if (me.composer) me.composer.render(dt); else renderer.render(scene, camera);
    if (now - lastSync > 120) {
      lastSync = now;
      const [lon, lat] = F.toLonLat(P.x, P.y);
      const hfov = (2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect) * 180) / Math.PI;
      mapApi.setWalkCam({ lon, lat, bearing: ((P.yaw * 180) / Math.PI + 360) % 360, hfov });
      if (isFull()) mapApi.follow(lon, lat, { always: true });
      else if (now - lastFollow > 900) { lastFollow = now; mapApi.follow(lon, lat); }
    }
  };
  me.raf = requestAnimationFrame(step);
  setTimeout(() => hint.classList.add('gone'), 12000);
}

// ---------- start position: a point of a street about 22 m from the building (a path only when no street is near),
// outside every building, looking at the nearest wall
function startPoint(sel, G, B, gh) {
  const ring = sel?.ring;
  const cx = ring ? ring.reduce((s, p) => s + p[0], 0) / ring.length : 0, cy = ring ? ring.reduce((s, p) => s + p[1], 0) / ring.length : 0;
  const dRing = (x, y) => { let d = Infinity; if (!ring) return Math.hypot(x, y); for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(x, y, ring[i], ring[(i + 1) % ring.length])); return d; };
  let best = null;
  for (const l of G?.lines || []) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = l.pts[i], b = l.pts[i + 1];
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, d = dRing(x, y);
        if (d < 8 || d > 120 || !free(x, y, gh(x, y) + EYE, B)) continue;
        // wider streets first; service roads (courtyards, parking aisles) after them, a path last
        const score = Math.abs(d - 22) + (l.kind !== 'road' ? 40 : l.cls?.startsWith('service') ? 12 : -3 * l.hw);
        if (!best || score < best.score) best = { x, y, score, why: `${l.kind} ${l.hw} m, ${d.toFixed(0)} m`, cls: l.cls };
      }
    }
  }
  if (!best && ring) {   // no street in the tiles: step out from the longest wall
    let li = 0, ll = 0;
    for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > ll) { ll = l; li = i; } }
    const a = ring[li], b = ring[(li + 1) % ring.length];
    best = { x: (a[0] + b[0]) / 2 + ((b[1] - a[1]) / ll) * 14, y: (a[1] + b[1]) / 2 - ((b[0] - a[0]) / ll) * 14 };
  }
  best ||= { x: 0, y: -30 };
  let tx = cx, ty = cy, dn = Infinity;   // look at the nearest point of the outline
  if (ring) for (let i = 0; i < ring.length; i++) { const q = nearestOn(best.x, best.y, ring[i], ring[(i + 1) % ring.length]); const dd = Math.hypot(q[0] - best.x, q[1] - best.y); if (dd < dn) { dn = dd; tx = q[0]; ty = q[1]; } }
  const yaw = Math.atan2(tx - best.x, ty - best.y);
  const d = Math.hypot(tx - best.x, ty - best.y), top = sel ? sel.top : 15;
  return { why: best.why ? `${best.why}, ${best.cls}` : 'fallback', x: best.x, y: best.y, z: EYE, yaw, pitch: Math.max(-0.05, Math.min(0.4, Math.atan2(top * 0.4 - EYE, Math.max(8, d)))) };
}
function nearestOn(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}
function segDist(x, y, a, b) {
  const q = nearestOn(x, y, a, b);
  return Math.hypot(x - q[0], y - q[1]);
}

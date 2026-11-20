// App glue: map → building → model → simulation → panels.
import { loadIndex, buildingAt, byId, neighbours, zensusAt, loadZensus, inCoverage, heatingAt, loadHeating, lod2Around } from './osmdb.js';
import { buildGeometry, computeAreas, applyLoD2, lod2Record, openStructure } from './geometry.js';
import { livingArea } from './livingarea.js';
import {
  loadArchetypes, agePrior, assign, applyWWR, makePrior, rng, PARAM_META, SOURCE_CN, TYPE_CN, UNCERTAIN, profileFor, systemPrior,
} from './archetype.js';
import { computeShading, facadeIrradiance, sunPosition } from './solar.js';
import { prepare, run, paramValues } from './rc5.js';
import { setFactors, finalEnergy, factors } from './systems.js';
import { runChecks } from './checks.js';
import { scenarios } from './retrofit.js';
import * as C from './charts.js';
import { createMap } from './map.js';
import { L, LANG, pick, localize, setLang } from './i18n.js';
import { refsFor, setSources, ZENSUS } from './refs.js';
import { fromLAEA } from './geo.js';
import { fillPhotos, photoLink } from './photos.js';
import { openWalk, closeWalk, walkSelect } from './walk.js';
import { priorMC, varShares } from './prior.js';
import { PAIRS as VOI_PAIRS, known as voiKnown } from './voi.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const { fmt, fmtK } = C;

const S = {
  A: null, weather: null, weatherKey: 'tmy', weatherIndex: null, rec: null, nbRecs: null, model: null, ageInfo: null,
  state: { ageClass: null, refurb: { windows: 'unknown', wall: 'unknown', roof: 'unknown', floor: 'unknown' }, system: null, user: {}, geom: {} },
  shading: null, irr: null, ctx: null, res: null, fe: null, prior: null, prod: null, checks: null, calib: null, retroPrior: null,
  viewer: null, colorMode: 'loss', dark: false, sun: { month: 1, hour: 11 }, busy: false, truth: null,
};

// ---------- theme ----------
function initTheme() {
  const saved = (() => { try { return localStorage.getItem('em-theme'); } catch { return null; } })();
  const sys = window.matchMedia('(prefers-color-scheme: dark)').matches;
  S.dark = saved ? saved === 'dark' : sys;
  document.documentElement.dataset.theme = S.dark ? 'dark' : 'light';
  $('#theme').addEventListener('click', () => {
    S.dark = !S.dark;
    document.documentElement.dataset.theme = S.dark ? 'dark' : 'light';
    try { localStorage.setItem('em-theme', S.dark ? 'dark' : 'light'); } catch { /* ignore */ }
    S.mapApi?.setDark(S.dark);
    if (S.cityGrid) renderCityLegend();
    S.viewer?.setTheme({ dark: S.dark });
  });
}

// ---------- language ----------
// index.html carries the Chinese text; English mode overwrites the static parts here. The language is fixed per page
// load (setLang reloads and keeps the #b=… hash), so module-level strings can be built with L().
const DIR = L({ N: '北', E: '东', S: '南', W: '西' }, { N: 'N', E: 'E', S: 'S', W: 'W' }, { N: 'N', E: 'O', S: 'S', W: 'W' });
function initLang() {
  document.documentElement.lang = L('zh-CN', 'en', 'de');
  // the name carries no city: Munich is the first area covered, shown as the region next to the name (user, 2026-11-18)
  document.title = L('Open Energy Map · 慕尼黑', 'Open Energy Map · Munich', 'Open Energy Map · München');
  // 中 · EN · DE: the current language is pressed; another one saves the choice and reloads
  for (const b of document.querySelectorAll('#lang button[data-l]')) {
    b.setAttribute('aria-pressed', String(b.dataset.l === LANG));
    b.addEventListener('click', () => { if (b.dataset.l !== LANG) setLang(b.dataset.l); });
  }
  // index.html carries the English text, so the page does not flash another language before this runs
  $('#lang').setAttribute('aria-label', L('语言', 'Language', 'Sprache'));
  // the region and the word on the theme button give way at phone width (css: .top .region, #theme .tt)
  $('#region').textContent = L('慕尼黑', 'Munich', 'München');
  $('#region').title = L('目前覆盖慕尼黑及周边', 'Currently covers Munich and its surroundings', 'Derzeit München und Umgebung');
  $('#sub').textContent = L('正在加载数据…', 'Loading data…', 'Daten werden geladen …');
  $('#theme').innerHTML = '<svg class="ti" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>';
  $('#theme').append(h('span', { class: 'tt' }, L('明暗', 'Theme', 'Hell/Dunkel')));
  $('#home').title = L('Xia Chen 的个人主页', 'Homepage of Xia Chen', 'Homepage von Xia Chen');
  for (const k of ['title', 'aria-label']) $('#repo').setAttribute(k, L('GitHub 上的源代码', 'Source code on GitHub', 'Quellcode auf GitHub'));
  $('#theme').title = L('切换明暗', 'Switch between light and dark', 'Zwischen hell und dunkel wechseln');
  $('#q').placeholder = L('搜索地址或楼名', 'Search an address or building', 'Adresse oder Gebäude suchen');
  $('#q').setAttribute('aria-label', $('#q').placeholder);
  $('#mapbusy').textContent = L('正在建模…', 'Building the model…', 'Modell wird erstellt …');
  $('#presets').setAttribute('aria-label', L('精选楼', 'Featured buildings', 'Beispielgebäude'));
  $('#empty').innerHTML = `
        <h2>${L('选一栋楼', 'Pick a building', 'Gebäude wählen')}</h2>
        <ol class="steps">
          <li><b>1</b><span>${L('点地图、搜索，或选下方精选楼', 'Click the map, search, or choose a featured building below', 'Auf die Karte klicken, suchen oder unten ein Beispielgebäude wählen')}</span></li>
          <li><b>2</b><span>${L('自动建模，给出区间', 'The model builds itself and gives ranges', 'Das Modell entsteht automatisch und liefert Bandbreiten')}</span></li>
          <li><b>3</b><span>${L('有账单时标定', 'Calibrate with bills if you have them', 'Mit Abrechnungen kalibrieren, falls vorhanden')}</span></li>
        </ol>
        <div class="tierkey">${['osm', 'archetype', 'default', 'user', 'calibrated'].map((k) => `<span class="src ${k}">${TIER[k]}</span>`).join('')}</div>`;
  const TABS = {
    overview: L('概览', 'Overview', 'Übersicht'), params: L('参数与来源', 'Inputs & sources', 'Eingaben & Quellen'), balance: L('热平衡', 'Heat balance', 'Wärmebilanz'),
    calib: L('账单标定', 'Calibration', 'Kalibrierung'), retro: L('改造', 'Retrofit', 'Sanierung'), method: L('方法与导出', 'Method & export', 'Methode & Export'),
  };
  for (const t of document.querySelectorAll('#tabs button[data-tab]')) t.textContent = TABS[t.dataset.tab] || t.textContent;
  $('#bdisc').textContent = disclaimer();
}

// ---------- boot ----------
async function boot() {
  window.__em = S;   // for local QA in the console
  initLang();
  initTheme();
  const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [idx, A, wIndex, , , hsCity, lod2Index] = await Promise.all([loadIndex(), loadArchetypes(), fetch('data/weather/index.json').then((r) => r.json()), loadZensus(), loadHeating(),
    getJSON('data/heizspiegel_city.json'), getJSON('data/lod2/index.json')]);
  S.A = A; S.weatherIndex = wIndex; S.hsCity = hsCity; S.lod2Index = lod2Index;
  setFactors(A);
  setSources(A.meta && A.meta.sources);
  renderSources(A.meta && A.meta.sources);
  S.factorBase = JSON.parse(JSON.stringify(factors().carriers));
  S.weather = await loadWeather('tmy');
  $('#sub').textContent = '';   // data credits live in the Method tab
  S.osmInfo = { n: idx.buildings, date: (idx.timestamp || '').slice(0, 10) };
  S.mapApi = createMap($('#map'), { dark: S.dark, onClick: (lon, lat) => pickAt(lon, lat), onCityHover: cityHover });
  initCity();
  const presets = localize(await (await fetch('data/presets.json')).json());
  for (const p of presets) $('#presets').append(h('button', { class: 'chip', title: pick(p, 'note'), onclick: () => pickPreset(p) }, pick(p, 'label')));
  initSearch();
  initTabs();
  initDrill();
  const m = location.hash.match(/#b=([wr]\d+)@([\d.]+),([\d.]+)/);
  if (m) pickPreset({ id: m[1], lon: +m[3], lat: +m[2] });
}

async function loadWeather(key) {
  const file = key === 'tmy' ? S.weatherIndex.tmy.file : S.weatherIndex.years[key].file;
  const w = await (await fetch('data/weather/' + file)).json();
  w.T = Float32Array.from(w.T); w.GHI = Float32Array.from(w.GHI); w.DNI = Float32Array.from(w.DNI); w.DHI = Float32Array.from(w.DHI);
  return w;
}

// ---------- search ----------
let ADDR = null;
function norm(s) { return s.toLowerCase().replace(/ß/g, 'ss').replace(/straße|strasse/g, 'str').replace(/[.\-,]/g, ' ').replace(/\s+/g, ' ').trim(); }
function initSearch() {
  const q = $('#q'), out = $('#qres');
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = norm(q.value);
      out.innerHTML = '';
      if (v.length < 3) return;
      if (!ADDR) { out.append(h('div', { class: 'note', style: 'padding:8px 12px' }, L('正在载入地址索引…', 'Loading the address index…', 'Adressindex wird geladen …'))); ADDR = (await (await fetch('data/osm/addr.json')).json()).map((r) => [...r, norm(`${r[0]} ${r[1]} ${r[6]}`)]); out.innerHTML = ''; }
      const toks = v.split(' ');
      const hits = [];
      for (const r of ADDR) { if (toks.every((t) => r[7].includes(t))) { hits.push(r); if (hits.length > 12) break; } }
      if (!hits.length) out.append(h('div', { class: 'note', style: 'padding:8px 12px' }, L('本地 OSM 里没有找到', 'Not found in the local OSM data', 'In den lokalen OSM-Daten nicht gefunden')));
      for (const r of hits) out.append(h('button', { onclick: () => { out.innerHTML = ''; q.value = `${r[0]} ${r[1]}`.trim() || r[6]; pickPreset({ id: r[3], lon: r[4], lat: r[5] }); } },
        `${r[0]} ${r[1]}`.trim() || r[6], ' ', h('small', {}, [r[6], r[2]].filter(Boolean).join(' · '))));
    }, 180);
  });
}

// ---------- tabs ----------
function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    for (const x of $('#tabs').children) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.id === 'p-' + b.dataset.tab);
    const t = b.dataset.tab;
    if (!S.model) return;
    if (t === 'overview') setTimeout(() => { S.viewer?.resize(); renderOverview(); }, 0);
    if (t === 'retro') renderRetro();
    if (t === 'params') renderParams();
    if (t === 'balance') renderBalance();
    if (t === 'calib' && S.calib) renderCalibResult();
  });
}

// ---------- picking ----------
async function pickPreset(p) {
  S.mapApi.flyTo(p.lon, p.lat);
  const rec = await byId(p.id, p.lon, p.lat) || await buildingAt(p.lon, p.lat);
  if (rec) select(rec); else toast(L('本地数据里找不到这栋楼', 'This building is not in the local data', 'Dieses Gebäude ist nicht in den lokalen Daten enthalten'));
}
async function pickAt(lon, lat) {
  if (!inCoverage(lon, lat)) { toast(L('本地数据只覆盖慕尼黑市域', 'The local data covers only the city of Munich', 'Die lokalen Daten decken nur das Stadtgebiet München ab')); return; }
  const rec = await buildingAt(lon, lat);
  if (!rec) { toast(L('这里没有建筑轮廓', 'No building footprint here', 'Hier gibt es keinen Gebäudeumriss')); return; }
  select(rec);
}
function toast(msg) { const e = $('#maphint'); e.textContent = msg; e.style.color = 'var(--warn)'; clearTimeout(toast.t); toast.t = setTimeout(() => { e.textContent = ''; e.style.color = ''; }, 2600); }

// opts.keepWalk: the building was picked inside the street walk, which stays open
async function select(rec, opts = {}) {
  $('#mapbusy').hidden = false;
  if (!opts.keepWalk) closeWalk();
  S.mapApi.setPhotos(null);   // the previous building's Mapillary cameras
  try {
    S.rec = rec;
    S.nbRecs = await neighbours(rec, 150);
    S.lod2Map = await lod2Around((rec.bbox[0] + rec.bbox[2]) / 2, (rec.bbox[1] + rec.bbox[3]) / 2);
    const st = S.lod2Map.structures.get(rec.id);
    if (st) { showStructure(rec, st); return; }
    // an open structure (pavilion, garden temple, shelter; geometry.js openStructure): not modelled either
    const op = openStructure(rec.tags || {}, lod2Record(S.lod2Map.get(rec.id))?.fn);
    if (op) { showStructure(rec, null, op); return; }
    S.state = { ageClass: null, refurb: { windows: 'unknown', wall: 'unknown', roof: 'unknown', floor: 'unknown' }, system: null, user: {}, geom: {} };
    S.calib = null; S.retroPrior = null; S.truth = null; S.calibApplied = null; S.irrOpen = null;
    $('#tabs button[data-tab=calib]').textContent = L('账单标定', 'Calibration', 'Kalibrierung');
    await rebuild({ geometry: true });
    history.replaceState(null, '', `#b=${rec.id}@${S.model.center.lat.toFixed(6)},${S.model.center.lon.toFixed(6)}`);
  } catch (e) {
    console.error(e);
    toast(L('建模失败：', 'Modelling failed: ', 'Modellierung fehlgeschlagen: ') + e.message);
  } finally {
    $('#mapbusy').hidden = true;
  }
}

// ---------- city overview layer ----------
// data/city/grid.json (tools/city_run.mjs): model point values summed on the 100 m Zensus cells; a cell with fewer than
// minN heated buildings carries the sums of its 300 m or 500 m neighbourhood (r), so no colour belongs to a single
// address. One metric at a time; per-building values only after a click.
const ORANGE = { light: ['#ec8a55', '#e06a3a', '#c9502c', '#a83c25', '#84301f', '#5f2318'], dark: ['#9a4427', '#b9532d', '#d76435', '#ea7d45', '#f39c62', '#f8bf8c'] };
const BLUE = { light: ['#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'], dark: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'] };
const pick5 = (r) => ({ light: [0, 1, 2, 3, 5].map((i) => r.light[i]), dark: [0, 1, 2, 3, 5].map((i) => r.dark[i]) });   // validated as an ordinal 6-step ramp
// diverging, below ← neutral → above: steps of the same blue and orange ramps, matched in OKLCH lightness pairwise
// (light: 0.43 / 0.62–0.64 / 0.81–0.85 around a 0.88 grey; dark: lightness rises outward from a 0.41 grey)
const DIVERGE = { light: ['#184f95', '#3987e5', '#9ec5f4', '#d9d8d3', '#f8bf8c', '#d76435', '#84301f'], dark: ['#9ec5f4', '#6da7ec', '#256abf', '#4a4a46', '#b9532d', '#ea7d45', '#f8bf8c'] };
// the pilot layers (below): violet for the width of the range, categorical slots for the kind of data
const VIOLET = { light: ['#ac9eeb', '#8f78df', '#7455c7', '#5836a6', '#3d2178'], dark: ['#5a3fa0', '#7358c2', '#8c75db', '#a795ef', '#c5bafa'] };   // ordinal 5 steps, validated on both surfaces
const SLOTS = { light: ['#2a78d6', '#eb6834', '#1baf7a', '#b9b9b3'], dark: ['#3987e5', '#d95926', '#199e70', '#5b5d5a'] };   // the first three categorical slots (validated all-pairs), grey for the rest
const CITY_METRICS = {
  spec: { label: L('单位面积供暖需求', 'Heating demand per m²', 'Heizwärmebedarf pro m²'), unit: 'kWh/(m²·a)', breaks: [60, 85, 110, 135, 160], colors: ORANGE },   // about the P10–P90 of the 100 m cells (qa/city_run.md)
  dens: { label: L('热需求密度', 'Heat demand density', 'Wärmebedarfsdichte'), unit: 'MWh/(ha·a)', breaks: [70, 175, 415, 1050], colors: pick5(ORANGE),
    tip: L('供暖和热水的有用热 ÷ 网格面积。分档按 KEA-BW《地方热规划行动指南》（2020）表 5：70 以下没有热网的技术潜力，70–175 适合新区热网，175–415 适合既有建筑的低温热网，415–1050 适合常规热网。',
      'Useful heat for space heating and hot water ÷ cell area. Classes after table 5 of the KEA-BW guide to municipal heat planning (2020): below 70 no technical potential for heat networks, 70–175 networks in new developments, 175–415 low-temperature networks in existing areas, 415–1050 conventional networks.',
      'Nutzwärme für Raumheizung und Warmwasser ÷ Zellenfläche. Klassen nach Tab. 5 des KEA-BW-Handlungsleitfadens kommunale Wärmeplanung (2020): unter 70 kein technisches Potenzial für Wärmenetze, 70–175 Wärmenetze in Neubaugebieten, 175–415 Niedertemperaturnetze im Bestand, 415–1050 konventionelle Wärmenetze.') },
  bill: { label: L('比同类楼账单偏高或偏低', 'Above or below the bill mean', 'Über oder unter dem Abrechnungsmittel'),
    unit: L('模型 ÷ 同类楼账单均值', 'model ÷ mean bill of similar buildings', 'Modell ÷ Abrechnungsmittel ähnlicher Gebäude'), breaks: [0.67, 0.8, 0.95, 1.05, 1.25, 1.5], dec: 2, colors: DIVERGE,
    tip: () => { const r = fmt(S.cityGrid?.hs?.ratio, 2); return L(`只看格内集中供暖的多户住宅（燃气、燃油或区域供热，居住面积至少 100 m²）。按 2016 年实际气象算出终端能源（供暖和热水），用德国 2,857 栋楼的计算值与实测值统计关系（Loga 等 2019）换算到典型实测水平，再除以慕尼黑 Heizspiegel 2018 里同燃料、同规模楼的账单均值 Ø。1 表示和账单均值一样，蓝色低于，橙色高于。这是模型和同类楼账单的比较，不是这些楼自己的账单。全市合计为 ${r}。`,
      `Only the centrally heated multi-dwelling buildings in the cell (gas, oil or district heat, at least 100 m² living area). Final energy for heating and hot water with the actual weather of 2016, brought to the typical level of measured consumption with the statistical relation between calculated and metered values of 2,857 German buildings (Loga et al. 2019), divided by the mean bill Ø of buildings with the same fuel and size in the Heizspiegel München 2018. 1 means the same as the mean bill, blue below, orange above. This compares the model with bills of similar buildings; it is not these buildings' own bills. City-wide: ${r}.`,
      `Nur die zentral beheizten Mehrfamilienhäuser der Zelle (Gas, Öl oder Fernwärme, mindestens 100 m² Wohnfläche). Endenergie für Heizung und Warmwasser mit dem tatsächlichen Wetter 2016, mit dem statistischen Zusammenhang zwischen berechneten und gemessenen Werten von 2.857 deutschen Gebäuden (Loga et al. 2019) auf das typische Verbrauchsniveau umgerechnet und geteilt durch das Abrechnungsmittel Ø von Gebäuden gleichen Energieträgers und gleicher Größe im Heizspiegel München 2018. 1 heißt gleich dem Mittel, blau darunter, orange darüber. Das vergleicht das Modell mit Abrechnungen ähnlicher Gebäude; es sind nicht die Abrechnungen dieser Gebäude. Stadtweit: ${r}.`); } },
  lod2: { label: L('有 LoD2 实测几何的楼', 'Buildings with measured LoD2 geometry', 'Gebäude mit gemessener LoD2-Geometrie'), unit: '%', breaks: [50, 70, 85, 95], colors: BLUE,
    tip: L('格子里高度、屋顶和层数来自巴伐利亚 LoD2 的供暖楼所占比例。越高，几何越可靠；其余的楼用 OSM 标签或默认值。', 'Share of the heated buildings in the cell whose height, roof and storeys come from the Bavarian LoD2. Higher means more reliable geometry; the others use OSM tags or defaults.', 'Anteil der beheizten Gebäude der Zelle, deren Höhe, Dach und Geschosse aus dem bayerischen LoD2 stammen. Je höher, desto verlässlicher die Geometrie; die übrigen nutzen OSM-Tags oder Standardwerte.') },
  unc: { label: L('不确定性：区间宽度', 'Uncertainty: width of the range', 'Unsicherheit: Breite des Bereichs'), unit: L('典型楼 P10–P90 宽度，kWh/(m²·a)', 'P10–P90 width of a typical building, kWh/(m²·a)', 'P10–P90-Breite eines typischen Gebäudes, kWh/(m²·a)'),
    breaks: [40, 70, 100, 130], colors: VIOLET, pilot: true, tip: () => voiTip('unc') },
  voi: { label: L('不确定性：补哪项数据最值', 'Uncertainty: which data helps most', 'Unsicherheit: welche Daten am meisten helfen'), pilot: true, tip: () => voiTip('voi') },
  photo: { label: L('有可用实景照片的楼', 'Buildings with a usable street-level photo', 'Gebäude mit brauchbarem Straßenfoto'), unit: '%', breaks: [10, 25, 40, 60], colors: BLUE,
    tip: L('格子里的供暖楼中，60 m 内有 Mapillary 照片能看清这栋楼的比例：无遮挡的 360° 照片，或镜头正对这栋楼的照片。只拍到边上或没有照片的不算；树木遮挡没算。用来看哪里缺照片、该去补拍。',
      'Share of the heated buildings in the cell with a Mapillary photo within 60 m that shows the building clearly: a 360° photo with a clear line of sight, or a photo whose camera faces the building. Photos with the building only at the edge, or none, do not count; occlusion by trees is not counted. Shows where photos are missing and new ones would help.',
      'Anteil der beheizten Gebäude der Zelle mit einem Mapillary-Foto im Umkreis von 60 m, das das Gebäude deutlich zeigt: ein 360°-Foto mit freier Sicht oder ein Foto, dessen Kamera auf das Gebäude blickt. Fotos mit dem Gebäude nur am Rand oder gar keine zählen nicht; Verdeckung durch Bäume ist nicht berücksichtigt. Zeigt, wo Fotos fehlen und neue helfen würden.') },
};
// Pilot layers (data/city/voi_lit.json, tools/voi_pilot.mjs), only on the 4 km² around TUM so far. "unc": the range of a
// typical building in the cell, the area-weighted mean of the buildings' own relative P10–P90 widths of the model prior
// (not the range of the cell's total), with open data only or with one or two more data sources known; "voi": the single
// piece of information that would narrow it most. Same window rule as the city layer.
const VOI_NAME = {
  age: L('建成年代记录', 'Building records (year)', 'Bauakten (Baujahr)'), refurb: L('改造状态', 'Refurbishment state', 'Sanierungsstand'),
  bimConstr: L('BIM 构造', 'BIM construction', 'BIM-Konstruktion'), bimGeom: L('BIM 几何', 'BIM geometry', 'BIM-Geometrie'),
  windows: L('窗（LoD3、照片）', 'Windows (LoD3, photos)', 'Fenster (LoD3, Fotos)'), onsite: L('现场测试', 'On-site tests', 'Messungen vor Ort'),
  metered: L('运行数据', 'Metered operation', 'Betriebsdaten'), meter: L('热表读数', 'Heat meter reading', 'Wärmezählerstand'),
};
const VOI_WHAT = {   // what each source tells the model (tools/voi_pilot.mjs SOURCES)
  age: L('建成年代', 'the construction age', 'das Baualter'), refurb: L('窗、墙、屋顶、地面各自改造过没有', 'whether windows, wall, roof and floor were refurbished', 'ob Fenster, Wand, Dach und Boden saniert wurden'),
  bimConstr: L('各构件的 U 值、玻璃 g 值、改造状态和年代', 'the U-values of the elements, the glazing g-value, the refurbishment state and the age', 'die U-Werte der Bauteile, den g-Wert der Verglasung, den Sanierungsstand und das Baualter'),
  bimGeom: L('层高、参考面积和供暖面积比例', 'storey height, reference area and the heated share of the floor area', 'Geschosshöhe, Bezugsfläche und den beheizten Flächenanteil'),
  windows: L('窗墙比', 'the window-to-wall ratio', 'den Fensterflächenanteil'), onsite: L('气密性 n50 和热桥', 'air tightness n50 and thermal bridges', 'Luftdichtheit n50 und Wärmebrücken'),
  metered: L('室温、换气和内部得热', 'room temperature, ventilation and internal gains', 'Raumtemperatur, Lüftung und innere Gewinne'),
  meter: L('一年的实测供暖用热，误差约 15 %，只知道总量，不知道各输入', 'one year of metered heating energy, about 15 % error, the total only and none of the inputs', 'ein Jahr gemessene Heizwärme, etwa 15 % Fehler, nur die Summe, keine Eingangsgröße'),
};
const voiName = (k) => k.split('+').map((x, i) => { const n = VOI_NAME[x] || x; return i && LANG === 'en' && !n.startsWith('BIM') ? n[0].toLowerCase() + n.slice(1) : n; }).join(' + ');
const voiList = (keys) => keys.map((k) => L(`${VOI_NAME[k]}（${VOI_WHAT[k]}）`, `${VOI_NAME[k]} (${VOI_WHAT[k]})`, `${VOI_NAME[k]} (${VOI_WHAT[k]})`)).join(L('；', '; ', '; '));
// how often the colour of a cell survives the other prior (tools/voi_pilot.mjs `robust`)
function robustNote() {
  const r = S.cityVoi?.robust; if (!(r?.priors?.length > 1)) return '';
  const n = fmt(r.heat), nAll = fmt(r.cells), lead = fmt(100 * r.lead);
  return L(`用另一套先验（方法页第 10 节）重算，缩得最多的仍是同一项、而且两次都领先至少 ${lead} 个百分点的格子，看供暖需求只有 ${n} 个（共 ${nAll} 个）；颜色主要取决于先验怎么设，悬停时可以看各项相差多少。`,
    `Rerun with the other prior (Method tab, section 10), the same source narrows most, ahead by at least ${lead} points both times, in only ${n} of ${nAll} cells for the heating demand; the colours depend mainly on how the prior is set, and the hover shows how close the sources are.`,
    `Mit dem anderen Prior (Methodik, Abschnitt 10) neu gerechnet, grenzt dieselbe Quelle mit jeweils mindestens ${lead} Punkten Vorsprung nur in ${n} von ${nAll} Zellen für den Heizwärmebedarf am stärksten ein; die Farben hängen vor allem davon ab, wie der Prior gesetzt ist, und das Überfahren zeigt, wie nah die Quellen beieinander liegen.`);
}
// the meter reading and the saving target, when the data file has them
function meterNote() {
  const v = S.cityVoi, m = v.scen.includes('meter');
  return [m ? L('热表读数单独列在悬停里：它来自供热公司而不是楼本身，有读数的地方它几乎处处缩得最多。', 'The heat meter reading is listed apart on hover: it comes from the utility rather than the building, and where it exists it narrows most almost everywhere.', 'Der Wärmezählerstand steht beim Überfahren getrennt: er kommt vom Versorger, nicht vom Gebäude, und wo es ihn gibt, grenzt er fast überall am stärksten ein.') : '',
    v.save ? L('第二个菜单可以改看“整体改造能省多少”：应用里整体改造包（外墙、窗、屋顶、地面到 GEG 限值，n50 1.5，热回收通风）省下的供暖需求。', 'The second menu switches to “the saving of a deep retrofit”: the heating demand saved by the deep retrofit package of the app (wall, windows, roof and floor to the GEG limits, n50 1.5, ventilation with heat recovery).', 'Das zweite Menü wechselt zu „Einsparung einer Komplettsanierung“: der Heizwärmebedarf, den das umfassende Sanierungspaket der App spart (Wand, Fenster, Dach und Boden auf GEG-Grenzwerte, n50 1,5, Lüftung mit Wärmerückgewinnung).') : ''].filter(Boolean).join(' ');
}
function voiTip(kind) {
  const v = S.cityVoi, singles = v.scen.filter((k) => !k.includes('+') && !k.includes('@')), list = voiList(kind === 'voi' ? v.pieces : singles);
  const scope = L(`只覆盖 ${v.area} 的试点区。`, `Only the pilot area so far, ${v.area}.`, `Bisher nur das Pilotgebiet, ${v.area}.`);
  const bound = L('数据源都假定完全准确，所以每一项都是上限；只反映模型先验里的不确定性。', 'Each source is taken as exact, so every figure is an upper bound; only the uncertainty in the model prior counts.', 'Jede Quelle gilt als exakt, jeder Wert ist also eine Obergrenze; es zählt nur die Unsicherheit im Prior des Modells.');
  const lit = v.prior === 'lit' ? L('这两个图层用按文献核实过的先验宽度（方法页第 10 节）；单栋面板仍用现用的先验，点开一栋楼看到的区间和排序可能不同。', 'These two layers use the prior spreads checked against the literature (Method tab, section 10); the building panel keeps the current prior, so the range and ranking of a single building may differ.', 'Diese beiden Ebenen nutzen die an der Literatur geprüften Streuungen (Methodik, Abschnitt 10); das Gebäudepanel behält den aktuellen Prior, Bereich und Reihenfolge eines einzelnen Gebäudes können daher abweichen.') : '';
  if (kind === 'voi') return [scope, L(`对每栋楼，分别假设下面某一项已知，看单位面积供暖需求的 P10–P90 区间还剩多少；颜色是格内（按面积平均）缩得最多的那一项。${list}。BIM 构造是几项的组合，不参与比较，悬停时单列。`,
    `For each building, one of the following is taken as known at a time, and the remaining P10–P90 range of heating demand per m² is measured; the colour is the one that narrows it most in the cell (area-weighted). ${list}. BIM construction combines several of them and is shown on hover, not compared.`,
    `Für jedes Gebäude gilt jeweils eine der folgenden Angaben als bekannt, und der verbleibende P10–P90-Bereich des Heizwärmebedarfs pro m² wird gemessen; die Farbe ist die Angabe, die ihn in der Zelle (flächengewichtet) am stärksten eingrenzt. ${list}. BIM-Konstruktion fasst mehrere zusammen und erscheint beim Überfahren, nicht im Vergleich.`), robustNote(), meterNote(), bound, lit].filter(Boolean).join(' ');
  return [scope, L(`每栋楼按模型的先验抽样，得到单位面积供暖需求的 P10、中位数和 P90；格子取格内楼按参考面积的加权平均，即一栋典型楼的范围，颜色是它的 P10–P90 宽度。这不是全格合计的范围：各楼共有的误差（同一年代的构造取值、同一套使用假设、模型本身）不会因为楼多而抵消。第二个菜单假设某类数据已知，看宽度还剩多少：${list}。具体一栋楼点开后在概览里看。`,
    `Each building is sampled from the model prior, giving the P10, median and P90 of its heating demand per m²; a cell takes the area-weighted mean of its buildings, the range of a typical building, coloured by its P10–P90 width. It is not the range of the cell's total: errors the buildings share (the construction values of an age class, one set of use assumptions, the model itself) do not cancel with more buildings. The second menu takes one kind of data as known and shows the width left: ${list}. Click a building for its own figures on the overview.`,
    `Jedes Gebäude wird aus dem Prior des Modells gezogen, mit P10, Median und P90 seines Heizwärmebedarfs pro m²; eine Zelle nimmt das flächengewichtete Mittel ihrer Gebäude, den Bereich eines typischen Gebäudes, gefärbt nach seiner P10–P90-Breite. Das ist nicht der Bereich der Zellensumme: Fehler, die die Gebäude teilen (die Bauteilwerte einer Altersklasse, dieselben Nutzungsannahmen, das Modell selbst), heben sich mit mehr Gebäuden nicht auf. Das zweite Menü nimmt eine Datenart als bekannt an und zeigt die verbleibende Breite: ${list}. Die Werte eines Gebäudes zeigt die Übersicht nach einem Klick.`), bound, lit].filter(Boolean).join(' ');
}
const photoProps = (c) => (c ? { photo: Math.round((100 * (c[1] + c[2])) / c[0]), nPh: c[0], rPh: c[4] } : { photo: null });
// the pilot cells: { r, n, width, unknownAge, remain: {scenario: relative width}, ratio: {heat|save: {scenario: remaining
// share}}, best: {heat|save: piece} }. Targets: heating demand, and the saving of the deep retrofit package if computed.
function prepVoi(v) {
  if (!v?.c100 || Object.values(v.c100).some(Array.isArray)) return null;   // an older file format: no pilot layers
  const S0 = v.scen, cells = {}, best = (ratio) => v.pieces.reduce((b, p) => (ratio[p] < ratio[b] ? p : b), v.pieces[0]);
  v.targets = v.save ? ['heat', 'save'] : ['heat'];
  for (const [key, a] of Object.entries(v.c100)) {
    const at = (arr) => Object.fromEntries(S0.map((s, i) => [s, arr[i]]));
    const ratio = { heat: at(a.ratio), ...(a.ratioS ? { save: at(a.ratioS) } : {}) };
    cells[key] = { r: a.r, n: a.n, q: a.q, w: a.w, rem: at(a.rem), ratio, best: Object.fromEntries(Object.entries(ratio).map(([t, x]) => [t, best(x)])) };
  }
  v.cells = cells;
  return v;
}
// categories in one fixed order over both targets, so a colour keeps its source when the target changes: the most
// frequent first, three slots, the rest grey
function voiOrder(v) {
  const cnt = {};
  for (const c of Object.values(v.cells)) for (const b of Object.values(c.best)) cnt[b] = (cnt[b] || 0) + 1;
  v.order = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
}
const voiProps = (c) => (c ? { unc: Math.round(c.w), ...Object.fromEntries(Object.entries(c.rem).map(([s, y]) => [`u_${s}`, Math.round(y)])), voi: c.best.heat, voi_save: c.best.save ?? null } : { unc: null, voi: null, voi_save: null });
// the data scenarios offered in the menu: the single sources and the meter reading, the pairs, each single source with the
// reading (the variants of pairs with the reading and the small-sample check stay in qa/voi_pilot.md)
const isMeterVariant = (k) => k.endsWith('+meter');
function voiMenu(v) {
  const single = v.scen.filter((k) => !k.includes('+') && !k.includes('@')), pairs = v.scen.filter((k) => k.includes('+') && !isMeterVariant(k));
  const withM = v.scen.filter((k) => isMeterVariant(k) && k.split('+').length === 2);
  return [[L('单项', 'One source', 'Eine Quelle'), single], [L('两项', 'Two sources', 'Zwei Quellen'), pairs], [L('再加热表读数', 'With the heat meter reading', 'Mit dem Wärmezählerstand'), withM]].filter(([, a]) => a.length);
}
async function initCity() {
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // the pilot layers use the literature prior (data/city/voi_lit.json), the app's prior (data/city/voi.json) only if that
  // file is missing; the public release has neither (user, 2026-11-17)
  let pilot = Promise.resolve(null);
  const [g, ph, vo] = await Promise.all([get('data/city/grid.json'), get('data/city/photo.json'), pilot]);
  if (!g) return;
  S.cityGrid = g; S.cityPhoto = ph;   // ph: tools/mapillary_coverage.mjs, [n, pano, square, edge, r] per cell
  if (!ph) delete CITY_METRICS.photo;   // the photo layer only where its data file exists
  const cur = vo ? prepVoi(vo) : null;
  if (cur) voiOrder(cur);
  S.cityVoi = cur;
  if (!cur) { delete CITY_METRICS.unc; delete CITY_METRICS.voi; }
  S.voiScen = (() => { try { const x = localStorage.getItem('em-city-scen') || ''; return cur?.scen.includes(x) ? x : ''; } catch { return ''; } })();
  S.voiTarget = (() => { try { const x = localStorage.getItem('em-city-target') || 'heat'; return cur?.targets.includes(x) ? x : 'heat'; } catch { return 'heat'; } })();
  const F = Object.fromEntries(g.fields.map((f, i) => [f, i]));
  const keys = [...new Set([...Object.keys(g.c100), ...Object.keys(cur?.cells || {})])];
  const fc = (size) => ({ type: 'FeatureCollection', features: keys.map((k) => {
    const v = g.c100[k], [cx, cy] = k.split('_').map(Number), x0 = cx * size, y0 = cy * size;
    const ring = [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]].map(([x, y]) => fromLAEA(x, y));
    const r = v?.[F.r] || 0, ha = ((2 * r + 1) * size) ** 2 / 1e4;   // the sums cover the cell's window (r = 0: the cell)
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { k, ...(v ? { n: v[F.n], r,
      spec: v[F.AN] > 0 ? Math.round((1000 * v[F.heatMWh]) / v[F.AN]) : null,
      dens: Math.round((v[F.heatMWh] + (v[F.dhwMWh] || 0)) / ha), lod2: Math.round((100 * v[F.nLoD2]) / v[F.n]),
      bill: v[F.refHsMWh] > 0 ? Math.round((100 * v[F.finHsMWh]) / v[F.refHsMWh]) / 100 : null, nHs: v[F.nHs], rHs: v[F.rHs] } : { spec: null, dens: null, lod2: null, bill: null }),
      ...photoProps(ph?.c100?.[k]), ...voiProps(cur?.cells[k]) } };
  }) });
  // off by default: the map opens plain, the layer is opt-in (a viewer's own choice is remembered)
  S.cityMetric = (() => { try { return localStorage.getItem('em-city') || 'off'; } catch { return 'off'; } })();
  if (S.cityMetric !== 'off' && !CITY_METRICS[S.cityMetric]) S.cityMetric = 'off';
  S.mapApi.setCity({ c100: fc(100), ...cityStyle(S.cityMetric === 'off' ? 'spec' : S.cityMetric), show: S.cityMetric !== 'off' });
  renderCityLegend();
}
// the map style of a metric: the pilot uncertainty layer reads the property of the chosen data scenario; the categorical
// one takes its categories and slots from the data file
function cityStyle(k) {
  const M = CITY_METRICS[k];
  if (k === 'voi') { const o = S.cityVoi.order; return { metric: S.voiTarget === 'save' ? 'voi_save' : 'voi', cats: o.slice(0, 3), colors: { light: [...SLOTS.light.slice(0, Math.min(3, o.length)), SLOTS.light[3]], dark: [...SLOTS.dark.slice(0, Math.min(3, o.length)), SLOTS.dark[3]] } }; }
  return { metric: k === 'unc' ? (S.voiScen ? `u_${S.voiScen}` : 'unc') : k, breaks: M.breaks, cats: null, colors: M.colors };
}
function setCityMetric(k) {
  S.cityMetric = k;
  try { localStorage.setItem('em-city', k); } catch { /* ignore */ }
  const M = CITY_METRICS[k];
  S.mapApi.setCityStyle(M ? { ...cityStyle(k), show: true } : { show: false });
  if (M?.pilot) S.mapApi.showArea(S.cityVoi.bbox);   // the pilot layers cover a small area: bring it into view
  cityHover(null);
  renderCityLegend();
}
function setVoiTarget(x) {
  S.voiTarget = x;
  try { localStorage.setItem('em-city-target', x); } catch { /* ignore */ }
  S.mapApi.setCityStyle({ ...cityStyle('voi'), show: true });
  cityHover(null);
  renderCityLegend();
}
function setVoiScen(x) {
  S.voiScen = x;
  try { localStorage.setItem('em-city-scen', x); } catch { /* ignore */ }
  S.mapApi.setCityStyle({ ...cityStyle('unc'), show: true });
  cityHover(null);
  renderCityLegend();
}
function renderCityLegend() {
  let box = $('#citylegend');
  if (!box) { box = h('div', { class: 'citylegend maplibregl-ctrl', id: 'citylegend' }); S.mapApi.mountLegend(box); }
  const k = S.cityMetric, M = CITY_METRICS[k], dk = S.dark ? 'dark' : 'light', col = M ? (M.pilot ? cityStyle(k).colors[dk] : M.colors[dk]) : [];
  const n = S.cityGrid.minN, mt = typeof M?.tip === 'function' ? M.tip() : M?.tip;
  const tip = (M?.pilot ? L(`每个 100 m 格子取格内所有供暖楼；不足 ${n} 栋的格子取周围 300 m、再不足取 500 m 的楼，所以颜色不代表任何一栋楼。`,
    `Each 100 m cell takes all heated buildings in it; a cell with fewer than ${n} takes those of the surrounding 300 m, or else 500 m, so no colour stands for a single building.`,
    `Jede 100-m-Zelle nimmt alle beheizten Gebäude darin; eine Zelle mit weniger als ${n} nimmt die der umliegenden 300 m, sonst 500 m, keine Farbe steht also für ein einzelnes Gebäude.`)
    : L(`每个 100 m 格子汇总格内所有供暖楼的模型点值；不足 ${n} 栋的格子取周围 300 m、再不足取 500 m 的合计，所以颜色不代表任何一栋楼。点楼看单栋。`,
      `Each 100 m cell sums the model point values of all heated buildings in it; a cell with fewer than ${n} takes the sums of the surrounding 300 m, or else 500 m, so no colour stands for a single building. Click a building for its own values.`,
      `Jede 100-m-Zelle summiert die Punktwerte des Modells aller beheizten Gebäude darin; eine Zelle mit weniger als ${n} nimmt die Summen der umliegenden 300 m, sonst 500 m, keine Farbe steht also für ein einzelnes Gebäude. Ein Klick auf ein Gebäude zeigt dessen eigene Werte.`)) + (mt ? '\n\n' + mt : '');
  const V = S.cityVoi;
  const scenSel = k === 'unc' ? h('select', { class: 'cl-scen', 'aria-label': L('假如已知', 'If known', 'Falls bekannt'), onchange: (e) => setVoiScen(e.target.value) },
    h('option', { value: '', selected: !S.voiScen }, L('只用开放数据', 'Open data only', 'Nur offene Daten')),
    ...voiMenu(V).map(([g, a]) => h('optgroup', { label: g }, ...a.map((s) => h('option', { value: s, selected: s === S.voiScen }, '+ ' + voiName(s)))))) : null;
  const tgtSel = k === 'voi' && V.targets.length > 1 ? h('select', { class: 'cl-scen', 'aria-label': L('目标', 'Target', 'Zielgröße'), onchange: (e) => setVoiTarget(e.target.value) },
    h('option', { value: 'heat', selected: S.voiTarget !== 'save' }, L('看供暖需求', 'For the heating demand', 'Für den Heizwärmebedarf')),
    h('option', { value: 'save', selected: S.voiTarget === 'save' }, L('看整体改造能省多少', 'For the saving of a deep retrofit', 'Für die Einsparung einer Komplettsanierung'))) : null;
  const cats = k === 'voi' ? h('div', { class: 'cl-cats' }, ...V.order.slice(0, 3).map((c, i) => h('span', {}, h('i', { style: `background:${col[i]}` }), VOI_NAME[c])),
    V.order.length > 3 ? h('span', {}, h('i', { style: `background:${col[col.length - 1]}` }), V.order.slice(3).map((c) => VOI_NAME[c]).join(L('、', ', ', ', '))) : null) : null;
  box.replaceChildren(...[
    h('div', { class: 'cl-head' },
      h('select', { 'aria-label': L('地图着色', 'Map colouring', 'Kartenfärbung'), onchange: (e) => setCityMetric(e.target.value) },
        h('option', { value: 'off', selected: k === 'off' }, L('全市图层：不显示', 'City layer: off', 'Stadtebene: aus')), ...Object.entries(CITY_METRICS).map(([key, m]) => h('option', { value: key, selected: key === k }, m.label))),
      info(tip)),
    scenSel, tgtSel, cats,
    M && !cats ? h('div', { class: 'cl-ramp' }, ...col.map((c, i) => h('span', { class: 'cl-sw', style: `background:${c}` }, h('i', {}, i < M.breaks.length ? fmt(M.breaks[i], M.dec || 0) : '')))) : null,
    M?.unit ? h('div', { class: 'cl-unit' }, M.unit) : null].filter(Boolean));   // replaceChildren would print null as text
}
function cityHover(p, pt) {
  let t = $('#citytip');
  if (!p || !CITY_METRICS[S.cityMetric]) { if (t) t.hidden = true; return; }
  if (!t) { t = h('div', { class: 'citytip', id: 'citytip', role: 'status' }); $('.mapcol').append(t); }
  const k = S.cityMetric, M = CITY_METRICS[k], r0 = $('#map').getBoundingClientRect(), mc0 = $('.mapcol').getBoundingClientRect();
  const place = () => {   // measured after filling, so a wrapped tip never leaves the map
    t.hidden = false;
    t.style.left = `${Math.max(4, Math.min(r0.width - t.offsetWidth - 4, pt.x + 14)) + (r0.left - mc0.left)}px`; t.style.top = `${pt.y + 14 + (r0.top - mc0.top)}px`;
  };
  if (M.pilot) {
    const c = S.cityVoi.cells[p.k];
    if (!c) { t.hidden = true; return; }
    const n5 = S.cityVoi.minN, m = ['', '300 m', '500 m'][c.r] || '', who = L(`${fmt(c.n)} 栋供暖楼`, `${fmt(c.n)} heated buildings`, `${fmt(c.n)} beheizte Gebäude`);
    const where = c.r ? L(`周围 ${m} 内 ${who}（本格不足 ${n5} 栋）`, `${who} within ${m} (fewer than ${n5} in this cell)`, `${who} im Umkreis von ${m} (weniger als ${n5} in dieser Zelle)`) : L(`${who} · 100 m 格`, `${who} · 100 m cell`, `${who} · 100-m-Zelle`);
    const pc = (x) => `${fmt(100 * x)}\u00a0%`, kw = 'kWh/(m²·a)';
    t.classList.add('wide');
    if (k === 'unc') {
      const s = S.voiScen, q = c.q || [], now = L(`典型楼 ${q[0] != null ? `P10 ${fmt(q[0])} · ` : ''}中位数 ${fmt(q[1])}${q[2] != null ? ` · P90 ${fmt(q[2])}` : ''} ${kw}，区间宽 ${fmt(c.w)}`,
        `Typical building ${q[0] != null ? `P10 ${fmt(q[0])} · ` : ''}median ${fmt(q[1])}${q[2] != null ? ` · P90 ${fmt(q[2])}` : ''} ${kw}, range ${fmt(c.w)} wide`,
        `Typisches Gebäude ${q[0] != null ? `P10 ${fmt(q[0])} · ` : ''}Median ${fmt(q[1])}${q[2] != null ? ` · P90 ${fmt(q[2])}` : ''} ${kw}, Bereich ${fmt(c.w)} breit`);
      t.replaceChildren(...[h('div', {}, now),
        s ? h('div', {}, h('b', {}, '+ ' + voiName(s)), L(`：区间宽约 ${fmt(c.rem[s])}（−${fmt(100 * (1 - c.rem[s] / c.w))}\u00a0%）`, `: range about ${fmt(c.rem[s])} wide (−${fmt(100 * (1 - c.rem[s] / c.w))}\u00a0%)`, `: Bereich etwa ${fmt(c.rem[s])} breit (−${fmt(100 * (1 - c.rem[s] / c.w))}\u00a0%)`)) : null,
        h('div', {}, where)].filter(Boolean));
      place(); return;
    }
    // which piece narrows most, the others in order, BIM construction, the best pair, the meter reading alone and with
    // the best single source; shares of the open-data range of the chosen target
    const tg = S.voiTarget === 'save' && c.ratio.save ? 'save' : 'heat', R = c.ratio[tg], b0 = c.best[tg];
    const rest = S.cityVoi.pieces.filter((x) => x !== b0).sort((a, b) => R[a] - R[b]);
    const minOf = (a) => a.reduce((b, x) => (R[x] < R[b] ? x : b), a[0]);
    const pairs = S.cityVoi.scen.filter((x) => x.includes('+') && !isMeterVariant(x)), bp = minOf(pairs);
    const mv = S.cityVoi.scen.filter((x) => isMeterVariant(x) && x.split('+').length === 2), bm = mv.length ? minOf(mv) : null;
    const row = (txt) => h('div', {}, txt);
    t.replaceChildren(...[
      h('div', {}, h('b', {}, VOI_NAME[b0]), L(` · 区间剩 ${pc(R[b0])}`, ` · range left ${pc(R[b0])}`, ` · Bereich bleibt ${pc(R[b0])}`),
        S.cityVoi.targets.length > 1 ? (tg === 'save' ? L('（改造节能量）', ' (retrofit saving)', ' (Einsparung)') : L('（供暖需求）', ' (heating demand)', ' (Heizwärmebedarf)')) : ''),
      row(L('其余：', 'Others: ', 'Übrige: ') + rest.map((x) => `${VOI_NAME[x]} ${pc(R[x])}`).join(' · ')),
      row(`${VOI_NAME.bimConstr} ${pc(R.bimConstr)} · ` + L(`两项最好：${voiName(bp)} ${pc(R[bp])}`, `best pair: ${voiName(bp)} ${pc(R[bp])}`, `bestes Paar: ${voiName(bp)} ${pc(R[bp])}`)),
      R.meter != null ? row(`${VOI_NAME.meter} ${pc(R.meter)}` + (bm ? ` · ${voiName(bm)} ${pc(R[bm])}` : '')) : null,
      row(where)].filter(Boolean));
    place(); return;
  }
  t.classList.remove('wide');
  const v = p[k], bill = k === 'bill', photo = k === 'photo';
  const n = bill ? p.nHs : photo ? p.nPh : p.n, w = bill ? p.rHs : photo ? p.rPh : p.r, m = ['', '300 m', '500 m'][w] || '';
  const who = bill ? L(`${fmt(n)} 栋多户住宅`, `${fmt(n)} multi-dwelling buildings`, `${fmt(n)} Mehrfamilienhäuser`) : L(`${fmt(n)} 栋供暖楼`, `${fmt(n)} heated buildings`, `${fmt(n)} beheizte Gebäude`);
  const n5 = S.cityGrid.minN, where = w ? L(`周围 ${m} 内 ${who}（本格不足 ${n5} 栋）`, `${who} within ${m} (fewer than ${n5} in this cell)`, `${who} im Umkreis von ${m} (weniger als ${n5} in dieser Zelle)`) : L(`${who} · 100 m 格`, `${who} · 100 m cell`, `${who} · 100-m-Zelle`);
  t.replaceChildren(h('b', {}, v == null ? '–' : bill ? `${fmt(v, 2)} × Ø` : `${fmt(v)} ${M.unit}`), ' · ', where);
  const r = $('#map').getBoundingClientRect(), mc = $('.mapcol').getBoundingClientRect();
  t.style.left = `${Math.min(r.width - 220, pt.x + 14) + (r.left - mc.left)}px`; t.style.top = `${pt.y + 14 + (r.top - mc.top)}px`;
  t.hidden = false;
}

// An OSM "building" judged to be a structure (tools/structures_scan.mjs): a monument, tower, chimney, column or shaft.
// Nothing is modelled; the start page comes back with a note on top, and the hash keeps the selection. open: the tag
// that marks an open structure (geometry.js openStructure), e.g. the Dianatempel in the Hofgarten.
function showStructure(rec, st, open) {
  const [area, height] = st || [];
  S.model = null;
  $('#content').hidden = true; $('#empty').hidden = false;
  $('#structnote')?.remove();
  const osmUrl = `https://www.openstreetmap.org/${rec.id.startsWith('w') ? 'way' : 'relation'}/${rec.id.slice(1)}`;
  $('#empty').prepend(h('div', { class: 'structnote', id: 'structnote', role: 'status' },
    h('h2', {}, rec.tags.name || `OSM ${rec.id}`, ' ', h('a', { class: 'addr', href: osmUrl, target: '_blank', rel: 'noopener' }, 'OSM ↗')),
    h('p', {}, L('这不是建筑，所以不计算能耗。', 'This is not a building, so no energy demand is computed.', 'Das ist kein Gebäude, daher wird kein Energiebedarf berechnet.')),
    h('p', { class: 'why' }, open ? L(`OSM 里是 ${open}，没有门牌：这是亭、廊或避雨棚这类开敞构筑物，四面没有围合的外墙，不供暖。`,
      `In OSM it is ${open}, with no address: an open structure such as a pavilion, garden temple or shelter, with no enclosing walls and no heating.`,
      `In OSM ist es ${open}, ohne Adresse: ein offenes Bauwerk wie ein Pavillon, Gartentempel oder Unterstand, ohne umschließende Wände und unbeheizt.`) : L(`OSM 把它标为 building，但巴伐利亚地籍的 LoD2 在这里没有建筑；它占地 ${fmt(area)} m²、高 ${fmt(height)} m，没有门牌号，细而高，判为纪念碑、塔、烟囱或井道这类构筑物。`,
      `OSM tags it as a building, but the Bavarian cadastre's LoD2 has no building here; it covers ${fmt(area)} m², is ${fmt(height)} m tall, has no address and is tall and slender, so it is taken to be a structure such as a monument, tower, chimney or shaft.`,
      `OSM erfasst es als Gebäude, im LoD2 des bayerischen Katasters gibt es hier aber kein Gebäude; es hat ${fmt(area)} m² Grundfläche, ist ${fmt(height)} m hoch, hat keine Adresse und ist schlank, daher wird es als Bauwerk wie Denkmal, Turm, Schornstein oder Schacht eingestuft.`))));
  history.replaceState(null, '', `#b=${rec.id}@${((rec.bbox[1] + rec.bbox[3]) / 2).toFixed(6)},${((rec.bbox[0] + rec.bbox[2]) / 2).toFixed(6)}`);
}

// Rebuild model and results. opts.geometry: rebuild geometry and shading as well.
async function rebuild(opts = {}) {
  const t0 = performance.now();
  if (opts.geometry || !S.model) {
    const useL2 = S.state.geom.lod2 !== false;
    const m = buildGeometry(S.rec, S.nbRecs, { lod2: useL2 ? S.lod2Map : null });
    m.osmGeom = { height: m.height, floors: m.floors, roof: { ...m.roof } };   // kept for the OSM / LoD2 comparison
    if (S.state.geom.floors) { m.floors = S.state.geom.floors; m.floorHeight = +(m.height / m.floors).toFixed(2); m.geomSrc.floors = 'user'; m.hGBias = 0; }
    if (S.state.geom.height) { m.height = S.state.geom.height; m.floorHeight = +(m.height / m.floors).toFixed(2); m.geomSrc.height = 'user'; m.hGBias = 0; }
    if (S.state.geom.usage) { m.usage = S.state.geom.usage; m.usageSrc = L('用户指定', 'Set by user', 'Von Ihnen festgelegt'); }
    const L2 = lod2Record(S.lod2Map?.get(m.id));
    if (L2 && useL2 && !S.state.geom.height && !S.state.geom.floors) applyLoD2(m, L2);
    m.nbLonLat = S.nbRecs.filter((n) => !n.part).map((n) => n.outer);
    S.model = m;
    const z = await zensusAt(m.center.lon, m.center.lat);
    S.ageInfo = agePrior(m.osmTags, z, { usage: m.usage });
    S.ageInfo.heat = await heatingAt(m.center.lon, m.center.lat);   // Zensus heating carrier shares → system prior
  }
  const m = S.model;
  const asg = assign(m, S.ageInfo, S.state);
  m.params = asg.params;
  S.assigned = asg;
  if (S.calibApplied) for (const [k, v] of Object.entries(S.calibApplied)) if (m.params[k] && m.params[k].source !== 'user') { m.params[k].value = v; m.params[k].source = 'calibrated'; m.params[k].note = L('账单标定后验中位数', 'Posterior median from bill calibration', 'Posterior-Median aus der Kalibrierung mit Abrechnungen'); }
  applyWWR(m);
  computeAreas(m);
  if (opts.geometry || !S.shading || opts.shading) { S.shading = computeShading(m); S.irrOpen = null; }
  S.irr = facadeIrradiance(m, S.weather, S.shading);
  S.prof = profileFor(m);
  S.ctx = prepare(m, S.weather, S.irr, S.prof);
  const p = paramValues(m);
  S.res = run(S.ctx, p, { detail: true, hourly: true });
  applyFactorOv();
  S.fe = finalEnergy(S.res, p, S.ctx);
  S.prior = priorMC({ model: S.model, ageInfo: S.ageInfo, state: S.state, assigned: S.assigned, ctx: S.ctx }, 300);   // js/prior.js
  // rotation check (unshaded, isolates orientation)
  const rot = JSON.parse(JSON.stringify({ ...m, lonlatOuter: undefined, nbLonLat: undefined }));
  rot.facades.forEach((f) => { f.azimuth = (f.azimuth + 90) % 360; });
  const ctxR = prepare(rot, S.weather, facadeIrradiance(rot, S.weather, null), S.prof);
  const ctxN = prepare(m, S.weather, facadeIrradiance(m, S.weather, null), S.prof);
  const rN = run(ctxN, p), rR = run(ctxR, p);
  S.rotated = { annual: { heat: rR.annual.heat * (S.res.annual.heat / Math.max(1, rN.annual.heat)) } };
  S.checks = runChecks(m, S.res, checkCtx());
  S.lastMs = performance.now() - t0;
  render(opts);
}
const checkCtx = () => ({ ageInfo: S.ageInfo, calibrated: !!S.calib, shading: S.shading, ageClass: S.A.ageClasses.find((c) => c.id === S.assigned.cls), rotated: S.rotated });

const VAR_TIER = { age: 'zensus', wwrScale: 'default', hScale: 'default', anScale: 'default', n50: 'default', heatedFrac: 'default', T_heat: 'profile', n_vent: 'profile', Q_int: 'profile' };
const varLabel = (it) => (it.key === 'age' ? L('建成年代', 'Construction age', 'Baualtersklasse') : it.key === 'wwrScale' ? L('窗墙比', 'Window-to-wall ratio', 'Fensterflächenanteil') : it.key === 'hScale' ? L('层数（缺省）', 'Storeys (default)', 'Geschosse (Standardwert)') : it.key === 'anScale' ? L('参考面积（层高偏差）', 'Reference area (storey height bias)', 'Gebäudenutzfläche (Abweichung der Geschosshöhe)') : meta_label(it.key));
function uncertaintyCard() {
  const sh = varShares(S.prior);
  if (!sh.length) return null;
  const lab = varLabel;
  const tier = (it) => VAR_TIER[it.key] || (S.model.params[it.key]?.source === 'user' ? 'user' : 'archetype');
  const assumedShare = sh.filter((it) => tier(it) === 'default').reduce((a, it) => a + it.share, 0);
  const COL = { default: 'var(--warn)', archetype: 'var(--info)', profile: 'var(--info)', zensus: 'var(--info)', user: 'var(--fg-2)' };
  const items = sh.slice(0, 8).map((it) => ({ label: lab(it), value: it.share * 100, color: COL[tier(it)], note: SOURCE_CN[tier(it)] || '', key: it.key, row: it.row }));
  const card = h('div', { class: 'card', id: 'pp-var' },
    head(L('不确定性来自哪里', 'Where the uncertainty comes from', 'Herkunft der Unsicherheit'), L('供暖需求先验区间的方差，按输入分解（一阶份额，近似）。橙色是估算项，蓝色是查表或统计。点一行跳到该参数。', 'Variance of the heating demand prior, split by input (first-order shares, approximate). Orange is assumed, blue is table or statistics. Click a row to open the parameter.', 'Varianz des Priors für den Heizwärmebedarf, aufgeteilt nach Eingaben (Anteile erster Ordnung, näherungsweise). Orange steht für Annahmen, Blau für Tabellenwerte oder Statistik. Klicken Sie auf eine Zeile, um den Parameter zu öffnen.'),
      h('span', { class: 'aside' }, L(`估算项约占 ${fmt(assumedShare * 100)}%`, `Assumed inputs about ${fmt(assumedShare * 100)}%`, `Annahmen etwa ${fmt(assumedShare * 100)}%`))),
    h('div', { id: 'var-bars' }));
  card.draw = () => C.hbars($('#var-bars'), items, { unit: '%', max: Math.max(...items.map((i) => i.value)) * 1.1, valueFmt: (it) => `${fmt(it.value)}%`,
    onPick: (it) => (it.key === 'age' ? goto('params', '#pp-age') : ['hScale', 'anScale'].includes(it.key) ? goto('params', '#pp-geom') : goto('params', `#pr-${it.row}`, it.row)) });
  return card;
}

// ---------- carrier factors (CO₂, primary energy): one global override per carrier, like a unified default ----------
S.factorOv = {};
function applyFactorOv() {
  const C0 = factors().carriers;
  for (const [k, base] of Object.entries(S.factorBase || {})) {
    const ov = S.factorOv[k] || {};
    if (!C0[k]) continue;
    C0[k].co2 = ov.co2 ?? base.co2; C0[k].fp = ov.fp ?? base.fp;
  }
}
function setFactor(carrier, key, v) {
  const ov = (S.factorOv[carrier] = S.factorOv[carrier] || {});
  if (v == null || Number.isNaN(v)) delete ov[key]; else ov[key] = v;
  S.retroPrior = null;
  rebuild();
}
function archetypesForWorker() {
  const A = JSON.parse(JSON.stringify(S.A));
  for (const [k, ov] of Object.entries(S.factorOv)) {
    if (A.carriers && A.carriers[k]) Object.assign(A.carriers[k], ov);
    if (k === 'district' && A.munich && A.munich.districtHeating) { if (ov.co2 != null) A.munich.districtHeating.co2_recommended = ov.co2; if (ov.fp != null) A.munich.districtHeating.fp_GEG = ov.fp; }
  }
  return A;
}

// ---------- render ----------
const CLS_COL = { 'A+': ['#00a651', '#fff'], A: ['#4cb848', '#fff'], B: ['#bfd730', '#222'], C: ['#fff200', '#222'], D: ['#fdb913', '#222'], E: ['#f7941d', '#222'], F: ['#f15a24', '#fff'], G: ['#ed1c24', '#fff'], H: ['#be1e2d', '#fff'] };
function clsBadge(c) { if (!c) return ''; const [bg, fg] = CLS_COL[c] || ['#888', '#fff']; return `<span class="cls" style="background:${bg};color:${fg}">${c}</span>`; }
const srcChip = (s, note) => h('span', { class: `src ${s}`, title: note || null }, SOURCE_CN[s] || s);
// Explanations sit behind a small ⓘ next to the heading instead of a paragraph under it.
const info = (text) => h('span', { class: 'tip', title: text, 'aria-label': text, tabindex: 0, role: 'note' }, 'i');
const head = (title, tip, aside) => h('div', { class: 'card-head' }, h('h3', {}, title, tip ? info(tip) : null), aside ? h('span', { class: 'aside' }, aside) : null);
const TIER = { osm: L('真实值', 'Observed', 'Erfasst'), archetype: L('查表', 'Published table', 'Tabellenwert'), default: L('估算', 'Assumed', 'Annahme'), user: L('用户填写', 'User input', 'Eigene Eingabe'), calibrated: L('账单标定', 'Bill-calibrated', 'Kalibriert') };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Drill-down, shared by every "why" link: switch tab, jump so the exact target is in view (a row is centred, a card
// sits under the sticky tab bar), then blink it. The jump is instant on purpose: a smooth scroll can be cut short by any
// other scroll and then stops half way, while the blink already tells the reader where they landed.
const ROW_TARGET = 'tr, .chain, .calc-row, .stats > div, .step';
function scrollerOf() {
  const d = $('#detail');
  return d && d.scrollHeight > d.clientHeight + 1 && getComputedStyle(d).overflowY !== 'visible' ? d : null;
}
function scrollToTarget(t, done) {
  const sc = scrollerOf();
  const r = t.getBoundingClientRect();   // forces layout, so freshly rendered content is measured correctly
  const tabs = $('#tabs')?.getBoundingClientRect().height || 0;
  const head = sc ? 0 : $('header.top')?.getBoundingClientRect().height || 0;
  const viewH = (sc ? sc.clientHeight : window.innerHeight) - tabs - head;
  const top0 = sc ? sc.getBoundingClientRect().top : 0;
  const want = head + tabs + (t.matches(ROW_TARGET) && r.height < viewH ? (viewH - r.height) / 2 : 12);
  const cur = sc ? sc.scrollTop : window.scrollY;
  (sc || window).scrollTo({ top: Math.max(0, cur + (r.top - top0) - want), left: 0, behavior: 'auto' });
  setTimeout(done, 30);
}
function blink(t) {
  t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  clearTimeout(t.__flash); t.__flash = setTimeout(() => t.classList.remove('flash'), 2200);
}
function goto(tab, sel, openRef, tries = 0) {
  const b = $(`#tabs button[data-tab=${tab}]`);
  if (b && !b.classList.contains('on')) b.click();   // tab handlers render synchronously
  if (openRef) { const r = $(`#ref-${openRef}`); if (r) r.hidden = false; const sb = $(`#pr-${openRef} .srcbtn`); if (sb) sb.setAttribute('aria-expanded', 'true'); }
  const el = $(sel);
  if (!el) { if (tries < 5) setTimeout(() => goto(tab, sel, openRef, tries + 1), 60); return; }   // content rendered later
  const t = el.matches(ROW_TARGET) ? el : el.closest('.card') || el;
  if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
  t.focus({ preventScroll: true });
  scrollToTarget(t, () => { blink(t); if (openRef) { const r = $(`#ref-${openRef}`); if (r && !r.hidden) blink(r); } });   // getBoundingClientRect forces layout
}
function initDrill() {
  const kp = $('#kpis');
  const act = (e) => { const t = e.target.closest('[data-go]'); if (!t || !kp.contains(t)) return; e.stopPropagation(); goto(t.dataset.go, t.dataset.sel); };
  kp.addEventListener('click', act);
  kp.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-go]')) { e.preventDefault(); act(e); } });
}
// P10–P90 band on a track from 0, with a tick at the value shown above it; optional posterior band.
function rangeBar(full, cond, pt, post, d = 0) {
  const main = cond || full;   // the band the point belongs to; its ends are labelled
  const top = Math.max(full[1], main[1], pt, post ? post[1] : 0) * 1.08 || 1;
  const pc = (v) => `${Math.max(0, Math.min(100, (100 * v) / top)).toFixed(1)}%`;
  const band = (a, b, cls) => `<div class="rb-band${cls}" style="left:${pc(a)};width:calc(${pc(b)} - ${pc(a)})"></div>`;
  const tip = cond
    ? L(`深色：年代按最可能的一类时的 P10–P90（${fmt(cond[0], d)}–${fmt(cond[1], d)}）；浅色：所有可能年代（${fmt(full[0], d)}–${fmt(full[1], d)}）。点开参数表`, `Dark: P10–P90 with the most likely age class (${fmt(cond[0], d)}–${fmt(cond[1], d)}); light: all possible ages (${fmt(full[0], d)}–${fmt(full[1], d)}). Opens the parameter table`, `Dunkel: P10–P90 mit der wahrscheinlichsten Baualtersklasse (${fmt(cond[0], d)}–${fmt(cond[1], d)}); hell: alle möglichen Baualtersklassen (${fmt(full[0], d)}–${fmt(full[1], d)}). Öffnet die Parametertabelle`)
    : L(`先验 P10–P90（${fmt(full[0], d)}–${fmt(full[1], d)}），来自参数的不确定性。点开参数表`, `Prior P10–P90 (${fmt(full[0], d)}–${fmt(full[1], d)}) from parameter uncertainty. Opens the parameter table`, `Prior P10–P90 (${fmt(full[0], d)}–${fmt(full[1], d)}) aus der Parameterunsicherheit. Öffnet die Parametertabelle`);
  return `<div class="rb" data-go="params" data-sel="#pp-table" title="${esc(tip)}"><span>${fmt(main[0], d)}</span><div class="rb-track">${cond ? band(full[0], full[1], ' wide') : ''}${band(main[0], main[1], '')}${post ? band(post[0], post[1], ' post') : ''}<div class="rb-pt" style="left:${pc(pt)}"></div></div><span>${fmt(main[1], d)}</span></div>`;
}

function renderHeader() {
  const m = S.model;
  $('#empty').hidden = true; $('#content').hidden = false;
  $('#structnote')?.remove();
  $('#bname').textContent = m.name || m.address || `OSM ${m.id}`;
  const osmUrl = `https://www.openstreetmap.org/${m.id.startsWith('w') ? 'way' : 'relation'}/${m.id.slice(1)}`;
  $('#baddr').replaceChildren(...[m.name && m.address ? m.address + ' · ' : null, h('a', { href: osmUrl, target: '_blank', rel: 'noopener', title: L('在 OpenStreetMap 上查看这栋楼', 'View this building on OpenStreetMap', 'Dieses Gebäude auf OpenStreetMap ansehen') }, 'OSM ↗'),
    m.lod2 ? ' · ' : null, m.lod2 ? lod2Link(m.lod2, 'LoD2 ↗') : null].filter(Boolean));
  const cls = S.A.ageClasses.find((c) => c.id === S.assigned.cls);
  const topAge = Object.entries(S.ageInfo.p).sort((a, b) => b[1] - a[1])[0];
  const roof = L(({ flat: '平屋顶', gabled: '双坡屋顶', hipped: '四坡屋顶', skillion: '单坡屋顶' })[m.roof.shape] || m.roof.shape,
    ({ flat: 'Flat roof', gabled: 'Gabled roof', hipped: 'Hipped roof', skillion: 'Mono-pitch roof' })[m.roof.shape] || `Roof ${m.roof.shape}`, ({ flat: 'Flachdach', gabled: 'Satteldach', hipped: 'Walmdach', skillion: 'Pultdach' })[m.roof.shape] || `Dachform ${m.roof.shape}`);
  const attic = m.roof.attic === 'heated' ? L('阁楼供暖', 'heated attic', 'beheiztes Dachgeschoss') : m.roof.attic === 'unheated' ? L('阁楼不供暖', 'unheated attic', 'unbeheiztes Dachgeschoss') : null;
  const fact = (title, go, ...kids) => h('button', { type: 'button', class: 'fact', title: title || null, onclick: () => goto(...go) }, ...kids);
  const calAge = S.calib && !S.state.ageClass ? Object.entries(S.calib.post.ages).sort((a, b) => b[1] - a[1])[0] : null;
  $('#bchips').replaceChildren(...[
    fact(m.usageSrc, ['params', '#pp-geom'], TYPE_CN[m.usage], m.heated ? null : h('small', {}, L('可能不供暖', 'possibly unheated', 'möglicherweise unbeheizt'))),
    fact(`${m.geomSrc.floors}${L('；', '; ', '; ')}${m.geomSrc.height}`, ['params', '#pp-geom'], L(`${m.floors} 层 · ${fmt(m.height, 1)} m`, `${m.floors} storeys · ${fmt(m.height, 1)} m`, `${m.floors} Geschosse · ${fmt(m.height, 1)} m`)),
    fact(m.geomSrc.roof, ['params', '#pp-geom'], roof, attic ? h('small', {}, attic) : null),
    S.state.ageClass
      ? fact(L('用户指定的建成年代', 'Construction age set by the user', 'Baualtersklasse von Ihnen festgelegt'), ['params', '#pp-age'], cls.label, h('small', {}, L('用户', 'user', 'eigene Eingabe')))
      : fact(L(`建成年代，先验：${S.ageInfo.src}`, `Construction age, prior: ${S.ageInfo.src}`, `Baualtersklasse, Prior: ${S.ageInfo.src}`), ['params', '#pp-age'], S.A.ageClasses.find((c) => c.id === topAge[0]).label, h('small', {}, `${fmt(topAge[1] * 100)}%`)),
    calAge ? fact(L('账单标定后最可能的年代', 'Most likely age after bill calibration', 'Wahrscheinlichste Baualtersklasse nach der Kalibrierung mit Abrechnungen'), ['calib', '#cr-age'], h('span', { class: 'cal' }, S.A.ageClasses.find((c) => c.id === calAge[0]).label), h('small', {}, `${fmt(calAge[1] * 100)}%`)) : null,
    fact(L('参考面积 A_N', 'Reference floor area A_N', 'Gebäudenutzfläche A_N'), ['params', '#pp-geom'], `${fmt(m.areas.netFloor)} m²`),
    S.weatherKey !== 'tmy' ? fact(L('气象年份', 'Weather year', 'Wetterjahr'), ['params', '#pp-weather'], L(`${S.weatherKey} 年气象`, `${S.weatherKey} weather`, `Wetter des Jahres ${S.weatherKey}`)) : null,
  ].filter(Boolean));
  const fe = S.fe, pr = S.prior, A_N = m.areas.netFloor;
  const post = S.calib ? S.calib.post.heatPerM2 : null;
  const tipHeat = L(`供暖需求（有用能），标准使用条件。竖线是上方的数值${post ? `；青色是账单标定后 ${fmt(post[0])}–${fmt(post[2])}` : ''}`,
    `Heating demand (useful energy) under standard use. The tick is the value above${post ? `; teal is after bill calibration, ${fmt(post[0])}–${fmt(post[2])}` : ''}`, `Heizwärmebedarf (Nutzenergie) bei Standardnutzung. Der Strich markiert den Wert oben${post ? `; blaugrün ist der Bereich nach der Kalibrierung mit Abrechnungen, ${fmt(post[0])}–${fmt(post[2])}` : ''}`);
  const pp = (k, f = 1) => [pr[k][0] / f, pr[k][2] / f], pc = (k, f = 1) => (pr.cond ? [pr.cond[k][0] / f, pr.cond[k][2] / f] : null);
  $('#kpis').innerHTML = `
    <div class="kpi go" data-go="balance" data-sel="#bal-loss" role="button" tabindex="0" title="${esc(tipHeat)}"><div class="k">${L('供暖需求', 'Heating demand', 'Heizwärmebedarf')}</div><div class="v">${fmt(S.res.annual.heatPerM2)}<small>kWh/(m²·a)</small></div>${rangeBar(pp('heat'), pc('heat'), S.res.annual.heatPerM2, post ? [post[0], post[2]] : null)}</div>
    <div class="kpi go" data-go="balance" data-sel="#chain-fin" role="button" tabindex="0" title="${esc(L(`终端能源（供暖 + 热水）· ${fe.systemLabel}`, `Final energy (heating + hot water) · ${fe.systemLabel}`, `Endenergie (Heizung + Warmwasser) · ${fe.systemLabel}`))}"><div class="k">${L('终端能源', 'Final energy', 'Endenergie')}</div><div class="v">${fe.cls ? clsBadge(fe.cls) : ''}${fmt(fe.perM2)}<small>kWh/(m²·a)</small></div>${rangeBar(pp('fin'), pc('fin'), fe.perM2)}</div>
    <div class="kpi go" data-go="balance" data-sel="#chain-co2" role="button" tabindex="0" title="${esc(L(`CO₂ 排放 · ${fmt(fe.co2 / A_N, 1)} kg/(m²·a)`, `CO₂ emissions · ${fmt(fe.co2 / A_N, 1)} kg/(m²·a)`, `CO₂-Emissionen · ${fmt(fe.co2 / A_N, 1)} kg/(m²·a)`))}"><div class="k">CO₂</div><div class="v">${fmt(fe.co2 / 1000, 1)}<small>t/a</small></div>${rangeBar(pp('co2', 1000), pc('co2', 1000), fe.co2 / 1000, null, 1)}</div>
    <div class="kpi go" data-go="balance" data-sel="#bal-peak" role="button" tabindex="0" title="${esc(L('供暖峰值负荷（逐时最大值）', 'Heating peak load (hourly maximum)', 'Heizlast (stündliches Maximum)'))}"><div class="k">${L('峰值负荷', 'Peak load', 'Heizlast')}</div><div class="v">${fmt(S.res.annual.peakHeat / 1000, 1)}<small>kW</small></div><div class="r">${fmt(S.res.annual.peakHeat / A_N)} W/m²</div></div>`;
}

function render(opts) {
  const m = S.model;
  renderHeader();
  renderOverview(opts);
  renderParams();
  renderBalance();
  renderCalibForm();
  renderChecks();
  renderExport();
  renderMethod();
  if ($('#tabs button.on').dataset.tab === 'retro') renderRetro();
  S.mapApi.setSelection(m);
}

// ---------- overview ----------
const SEQ = ['#f6edc8', '#f0c27a', '#e08a4b', '#c2523a', '#8e2b30', '#5a1a2a'];
const DIV = ['#2f5fa0', '#7fa3d0', '#e9e9e4', '#e79a77', '#b4432f'];
function interp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = parseInt(stops[i].slice(1), 16), b = parseInt(stops[i + 1].slice(1), 16);
  const c = [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function coloring() {
  const m = S.model, fl = S.res.facadeLoss;
  const vals = {};
  let lo = 0, hi = 1, unit = '', palette = SEQ, label = '';
  if (S.colorMode === 'loss') {
    for (const f of m.facades) { if (f.exposedArea > 0.5) vals[f.id] = fl[f.id].wallW; if (f.windowArea > 0) vals[f.id + ':win'] = fl[f.id].winW; }
    vals.roof = fl.roof.wallW; vals.floor = fl.floor.wallW;
    hi = Math.max(...Object.values(vals)); lo = 0; unit = 'W/m²'; label = L('供暖季平均单位面积热损失', 'Mean heat loss per area in the heating season', 'Mittlerer flächenbezogener Wärmeverlust in der Heizperiode');
  } else if (S.colorMode === 'net') {
    for (const f of m.facades) if (f.windowArea > 0) vals[f.id + ':win'] = fl[f.id].winNetW;
    const mx = Math.max(1, ...Object.values(vals).map(Math.abs)); lo = -mx; hi = mx; palette = DIV; unit = 'W/m²'; label = L('窗户净热损失（损失 − 太阳得热，负值为净得热）', 'Net window heat loss (loss minus solar gain; negative values are net gains)', 'Netto-Wärmeverlust der Fenster (Verlust minus solare Gewinne; negative Werte sind Nettogewinne)');
  } else if (S.colorMode === 'sun') {
    S.irrOpen = S.irrOpen || facadeIrradiance(m, S.weather, null);
    m.facades.forEach((f, i) => { if (f.exposedArea > 0.5) { const a = S.irr.facade[i].reduce((s, v) => s + v, 0) / 1000; vals[f.id] = a; } });
    hi = Math.max(1, ...Object.values(vals)); lo = 0; palette = SEQ.slice().reverse(); unit = 'kWh/(m²·a)'; label = L('立面年太阳辐照（含周边遮挡）', 'Annual solar irradiation on the facades (with shading by the surroundings)', 'Jährliche solare Einstrahlung auf die Fassaden (mit Verschattung durch die Umgebung)');
  } else if (S.colorMode === 'dev' && S.calib) {
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const ratio = (k) => med(S.calib.params.post[k]) / med(S.calib.params.prior[k]);
    const rw = ratio('U_wall'), rwin = ratio('U_window'), rr = ratio('U_roof'), rf = ratio('U_floor');
    for (const f of m.facades) { if (f.exposedArea > 0.5) vals[f.id] = Math.log2(rw); if (f.windowArea > 0) vals[f.id + ':win'] = Math.log2(rwin); }
    vals.roof = Math.log2(rr); vals.floor = Math.log2(rf);
    lo = -1; hi = 1; palette = DIV; unit = L('log₂(后验/先验)', 'log₂(posterior/prior)', 'log₂(Posterior/Prior)'); label = L('标定后 U 值相对先验的变化（红 = 比查表差，蓝 = 比查表好）', 'Change of the U-values after calibration relative to the prior (red = worse than the table, blue = better than the table)', 'Änderung der U-Werte nach der Kalibrierung gegenüber dem Prior (rot = schlechter als der Tabellenwert, blau = besser als der Tabellenwert)');
  } else return null;
  const colorFn = (v) => interp(palette, (v - lo) / (hi - lo || 1));
  return { values: vals, colorFn, lo, hi, unit, label, palette };
}

async function ensureViewer(container) {
  if (S.viewer) { if (S.viewer.__el !== container) { container.append(S.viewer.__dom); S.viewer.__el = container; } return S.viewer; }
  try {
    const { createViewer } = await import('./scene3d.js');
    const host = h('div', { style: 'position:absolute;inset:0' });
    container.append(host);
    const v = createViewer(host, { dark: S.dark });
    v.__dom = host; v.__el = container;
    v.onPick((p) => onPick(p));
    S.viewer = v;
    return v;
  } catch (e) {
    container.append(h('div', { class: 'note', style: 'padding:16px' }, L('3D 视图模块未能加载：', 'The 3D view module failed to load: ', 'Das 3D-Ansichtsmodul konnte nicht geladen werden: ') + e.message));
    return null;
  }
}

function onPick(p) {
  const el = $('#pickinfo');
  if (!el) return;
  if (!p) { el.textContent = ''; S.viewer?.highlight(null); return; }
  const m = S.model, fl = S.res.facadeLoss;
  S.viewer?.highlight(p.id);
  if (p.kind === 'facade' || p.kind === 'window') {
    const fid = p.id.split(':')[0];
    const f = m.facades.find((x) => x.id === fid);
    const i = m.facades.indexOf(f);
    const sv = S.shading.svf[i];
    const irr = S.irr.facade[i].reduce((s, v) => s + v, 0) / 1000;
    el.innerHTML = L(`<b>${DIR[f.orient]}向立面 ${f.id}</b>（方位 ${fmt(f.azimuth)}°，长 ${fmt(f.length, 1)} m，外露 ${fmt(f.exposed * 100)}%）· 外墙 ${fmt(f.exposedArea - f.windowArea)} m²，U ${fmt(m.params.U_wall.value, 2)}，年损失 ${fmtK(fl[fid].wall)} · 窗 ${fmt(f.windowArea)} m²，U ${fmt(m.params.U_window.value, 2)}，年损失 ${fmtK(fl[fid].window)}，太阳得热 ${fmtK(fl[fid].solar)} · 年辐照 ${fmt(irr)} kWh/m²，天空可视比 ${fmt(sv * 100)}%`,
      `<b>${DIR[f.orient]} facade ${f.id}</b> (azimuth ${fmt(f.azimuth)}°, length ${fmt(f.length, 1)} m, exposed ${fmt(f.exposed * 100)}%) · wall ${fmt(f.exposedArea - f.windowArea)} m², U ${fmt(m.params.U_wall.value, 2)}, annual loss ${fmtK(fl[fid].wall)} · windows ${fmt(f.windowArea)} m², U ${fmt(m.params.U_window.value, 2)}, annual loss ${fmtK(fl[fid].window)}, solar gain ${fmtK(fl[fid].solar)} · annual irradiation ${fmt(irr)} kWh/m², sky view factor ${fmt(sv * 100)}%`, `<b>${DIR[f.orient]}-Fassade ${f.id}</b> (Azimut ${fmt(f.azimuth)}°, Länge ${fmt(f.length, 1)} m, freiliegend ${fmt(f.exposed * 100)}%) · Außenwand ${fmt(f.exposedArea - f.windowArea)} m², U ${fmt(m.params.U_wall.value, 2)}, Jahresverlust ${fmtK(fl[fid].wall)} · Fenster ${fmt(f.windowArea)} m², U ${fmt(m.params.U_window.value, 2)}, Jahresverlust ${fmtK(fl[fid].window)}, solare Gewinne ${fmtK(fl[fid].solar)} · Jahreseinstrahlung ${fmt(irr)} kWh/m², Himmelssichtfaktor ${fmt(sv * 100)}%`);
  } else if (p.kind === 'roof') {
    el.innerHTML = L(`<b>${m.roof.attic === 'unheated' ? '顶层楼板（阁楼不供暖）' : '屋顶'}</b> · ${fmt(m.areas.roof)} m²，U ${fmt(m.params.U_roof.value, 2)}，温度修正 ${m.params.F_roof.value} · 年损失 ${fmtK(fl.roof.wall)}`,
      `<b>${m.roof.attic === 'unheated' ? 'Top floor ceiling (unheated attic)' : 'Roof'}</b> · ${fmt(m.areas.roof)} m², U ${fmt(m.params.U_roof.value, 2)}, temperature correction ${m.params.F_roof.value} · annual loss ${fmtK(fl.roof.wall)}`, `<b>${m.roof.attic === 'unheated' ? 'Oberste Geschossdecke (unbeheiztes Dachgeschoss)' : 'Dach'}</b> · ${fmt(m.areas.roof)} m², U ${fmt(m.params.U_roof.value, 2)}, Temperaturkorrekturfaktor ${m.params.F_roof.value} · Jahresverlust ${fmtK(fl.roof.wall)}`);
  } else if (p.kind === 'floor') {
    el.innerHTML = L(`<b>${m.basement === 'unheated' ? '地下室顶板' : '地面'}</b> · ${fmt(m.areas.groundFloor)} m²，U ${fmt(m.params.U_floor.value, 2)}，温度修正 ${m.params.F_floor.value} · 年损失 ${fmtK(fl.floor.wall)}`,
      `<b>${m.basement === 'unheated' ? 'Basement ceiling' : 'Ground floor'}</b> · ${fmt(m.areas.groundFloor)} m², U ${fmt(m.params.U_floor.value, 2)}, temperature correction ${m.params.F_floor.value} · annual loss ${fmtK(fl.floor.wall)}`, `<b>${m.basement === 'unheated' ? 'Kellerdecke' : 'Bodenplatte'}</b> · ${fmt(m.areas.groundFloor)} m², U ${fmt(m.params.U_floor.value, 2)}, Temperaturkorrekturfaktor ${m.params.F_floor.value} · Jahresverlust ${fmtK(fl.floor.wall)}`);
  } else if (p.kind === 'neighbor') {
    const n = m.neighbors.find((x) => x.id === p.id);
    el.innerHTML = L(`<b>邻楼 ${p.id}</b> · 推断高度 ${fmt(n?.height, 1)} m${n && !n.heated ? '（不供暖附属建筑，不计共用墙）' : ''}。<a href="#" id="gonb">改为分析这栋</a>`,
      `<b>Neighbour ${p.id}</b> · inferred height ${fmt(n?.height, 1)} m${n && !n.heated ? ' (unheated outbuilding, no party wall counted)' : ''}. <a href="#" id="gonb">Analyse this building instead</a>`, `<b>Nachbargebäude ${p.id}</b> · abgeleitete Höhe ${fmt(n?.height, 1)} m${n && !n.heated ? ' (unbeheiztes Nebengebäude, keine Gebäudetrennwand angerechnet)' : ''}. <a href="#" id="gonb">Stattdessen dieses Gebäude analysieren</a>`);
    $('#gonb').onclick = (e) => { e.preventDefault(); const r = S.nbRecs.find((x) => x.id === p.id); if (r) { S.mapApi.flyTo(...r.outer[0]); select(r); } };
  }
}

const DEV_ON = L('标定偏差', 'Calibration deviation', 'Kalibrierabweichung'), DEV_OFF = L('标定偏差（需先标定）', 'Calibration deviation (calibrate first)', 'Kalibrierabweichung (zuerst kalibrieren)');
async function renderOverview() {
  const P = $('#p-overview');
  if (!$('#ov-viewer')) {
    P.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'viewer', id: 'ov-viewer' }),
        h('div', { class: 'viewer-tools' },
          h('label', {}, L('着色 ', 'Colour by ', 'Einfärben nach '), h('select', { id: 'cmode', onchange: (e) => { S.colorMode = e.target.value; applyColoring(); } },
            h('option', { value: 'loss' }, L('单位面积热损失', 'Heat loss per area', 'Wärmeverlust pro Fläche')), h('option', { value: 'net' }, L('窗户净得失', 'Net window balance', 'Netto-Fensterbilanz')), h('option', { value: 'sun' }, L('立面太阳辐照', 'Facade solar irradiation', 'Einstrahlung auf Fassaden')), h('option', { value: 'dev', id: 'opt-dev', disabled: true }, DEV_OFF), h('option', { value: 'none' }, L('不着色', 'No colour', 'Keine Färbung')))),
          h('label', {}, L('太阳 ', 'Sun ', 'Sonne '), h('select', { id: 'smonth', onchange: () => setSun() }, ...C.MONTHS.map((t, i) => h('option', { value: i + 1, selected: i === 0 }, t))),
            h('input', { type: 'range', id: 'shour', min: 5, max: 20, step: 0.5, value: 12, oninput: () => setSun() }), h('span', { id: 'shourl' }, '12:00')),
          h('span', { class: 'legend', id: 'legend' }),
          h('button', { type: 'button', class: 'btn small walkbtn', id: 'walkbtn', onclick: () => walkHere(),
            title: L('在这栋楼周围的街区里第一人称走动', 'Walk in first person through the streets around this building', 'In der Ich-Perspektive durch die Straßen um dieses Gebäude gehen') }, L('走进街区', 'Walk the streets', 'Durch die Straßen gehen'))),
        h('div', { class: 'pick', id: 'pickinfo', 'aria-live': 'polite' })),
      h('div', { class: 'card', id: 'ov-photo-card' }, h('div', { class: 'card-head' },
        h('h3', {}, L('实景照片', 'Street-level photos', 'Straßenfotos'), info(L('Mapillary 上 60 m 内拍到这栋楼的照片：镜头方向的射线先打到这栋楼、没被邻楼挡住的优先，按距离、正对程度和拍摄年份排，最多 3 张，尽量来自不同侧。地图上的橙点是拍摄位置，线是镜头方向。照片为 CC BY-SA 4.0，署名见每张下方；树木遮挡还没计入。',
          'Photos on Mapillary within 60 m that show this building: first those whose camera ray hits the building before any neighbour, ranked by distance, how square on they are and age; up to 3, preferably from different sides. The orange dots on the map are the camera positions, the lines their headings. Photos are CC BY-SA 4.0, credited under each; occlusion by trees is not counted yet.',
          'Fotos auf Mapillary im Umkreis von 60 m, die dieses Gebäude zeigen: zuerst die, deren Blickrichtung das Gebäude vor jedem Nachbarn trifft, gereiht nach Entfernung, Frontalität und Alter; höchstens 3, möglichst von verschiedenen Seiten. Die orangen Punkte auf der Karte sind die Aufnahmeorte, die Linien die Blickrichtungen. Fotos unter CC BY-SA 4.0, Urheber unter jedem Bild; Verdeckung durch Bäume ist noch nicht berücksichtigt.'))),
        h('span', { class: 'aside', id: 'ov-mly' })),
        h('div', { id: 'ov-photos' })),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, L('逐月供暖需求', 'Monthly heating demand', 'Monatlicher Heizwärmebedarf')), h('span', { class: 'aside', id: 'mhint' })), h('div', { id: 'ov-monthly' })),
      voiShell(),
    );
  }
  if ($('#ov-voi')?.open) startVoi(); else renderVoi();   // which data would narrow the range most: computed once opened
  $('#ov-mly').replaceChildren(photoLink(h, S.model));
  fillPhotos($('#ov-photos'), S.model, { h, fmt, info, setPhotos: (v) => S.mapApi.setPhotos(v) });   // js/photos.js; one search per building
  const v = await ensureViewer($('#ov-viewer'));
  if (v) { v.setTheme({ dark: S.dark }); v.setBuilding(viewModel(S.model)); applyColoring(); setSun(); }
  $('#opt-dev').disabled = !S.calib;
  $('#opt-dev').textContent = S.calib ? DEV_ON : DEV_OFF;
  const band = (S.prior.cond || S.prior).monthly;
  const series = [{ label: L('供暖需求（点估计）', 'Heating demand (point estimate)', 'Heizwärmebedarf (Punktschätzung)'), values: S.res.monthly.heat, color: 'var(--c1)' }];
  if (S.res.annual.cool > 1) series.push({ label: L('供冷需求', 'Cooling demand', 'Kühlbedarf'), values: S.res.monthly.cool, color: 'var(--c3)' });
  C.monthly($('#ov-monthly'), { series, band });
  $('#mhint').replaceChildren(
    h('span', { class: 'legend-inline' }, h('span', { class: 'sw', style: 'background:var(--c1)' }), L('点估计', 'Point estimate', 'Punktschätzung')),
    h('span', { class: 'legend-inline' }, h('span', { class: 'sw', style: 'width:2px;background:var(--fg-2)' }), 'P10–P90'),
    L(`全年 ${fmtK(S.res.annual.heat)} · ${fmt(S.res.annual.heatingHours)} h`, `Annual ${fmtK(S.res.annual.heat)} · ${fmt(S.res.annual.heatingHours)} h`, `Jahr ${fmtK(S.res.annual.heat)} · ${fmt(S.res.annual.heatingHours)} h`));
  $('#mhint').title = L(`${S.weatherKey === 'tmy' ? '慕尼黑典型气象年' : S.weatherKey + ' 年实际气象'}；h 为需要供暖的小时数`, `${S.weatherKey === 'tmy' ? 'Munich typical meteorological year' : 'Actual weather of ' + S.weatherKey}; h is the number of hours that need heating`, `${S.weatherKey === 'tmy' ? 'Typisches meteorologisches Jahr München' : 'Tatsächliches Wetter des Jahres ' + S.weatherKey}; h ist die Zahl der Stunden mit Heizbedarf`);
}

// ---------- which data would narrow the range most (this building) ----------
// js/voi.worker.js with js/voi.js on the building itself, never borrowed from other buildings. A few workers share the
// scenarios (nothing known first, then each source, then pairs) and the card fills in as results come. VOI_T truths ×
// VOI_N draws per scenario: the same building computed with other seeds differs by 2–6 points of the range, up to about
// 10, so the shares are rounded to 5 %. Only the heating demand, with the app's prior.
const VOI_T = 32, VOI_N = 50, VOI_URL = new URL('./voi.worker.js', import.meta.url);
const VOI_SRC = ['age', 'refurb', 'bimConstr', 'bimGeom', 'windows', 'onsite', 'metered'];
const VOI_WHERE = {
  age: L('建筑档案（Bauakte）、地籍', 'building files (Bauakte), cadastre', 'Bauakte, Kataster'),
  refurb: L('需求型能源证书、补贴记录、照片', 'demand-based energy certificate, subsidy records, photos', 'Bedarfsausweis, Förderunterlagen, Fotos'),
  bimConstr: L('IFC 模型（多为新楼，常是设计状态）', 'IFC model (mostly new buildings, often as designed)', 'IFC-Modell (meist Neubauten, oft Planungsstand)'),
  bimGeom: L('IFC 模型、扫描建模', 'IFC model, scan to BIM', 'IFC-Modell, Scan-to-BIM'),
  windows: L('LoD3、照片', 'LoD3, photos', 'LoD3, Fotos'),
  onsite: L('鼓风门试验、红外热像', 'blower-door test, infrared thermography', 'Blower-Door-Test, Thermografie'),
  metered: L('楼宇自控、智能表、使用者问卷', 'building automation, smart meters, occupant survey', 'Gebäudeautomation, Smart Meter, Nutzerbefragung'),
  meter: L('供热公司或物业的年度账单', 'the annual bill of the utility or property manager', 'Jahresabrechnung von Versorger oder Hausverwaltung'),
};
const VOI_BILL = L('账单', 'Bill', 'Abrechnung');
// sources closer than this (share of the range) cannot be ranked: the noise of the card's calculation is 2–6 points, and
// another plausible prior moves single sources by 3–10 points (tools/voi_pilot.mjs --prior lit, the 553 computed buildings)
const VOI_TIE_PTS = 0.10;
let VOI = { sig: null, res: {}, workers: [], queue: [] };
const voiSeed = (id) => { let x = 2166136261; for (const ch of id) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return (x >>> 0) % 1e8; };
const voiSig = () => JSON.stringify([S.model.id, S.state, S.weatherKey, S.model.usage, S.model.floors, S.model.height, Object.entries(S.model.params).filter(([, v]) => v.source === 'user').map(([k, v]) => [k, v.value]), S.factorOv]);
const plainModel = () => JSON.parse(JSON.stringify({ ...S.model, lonlatOuter: undefined, nbLonLat: undefined }));
const plainWeather = () => ({ ...S.weather, T: Array.from(S.weather.T), GHI: Array.from(S.weather.GHI), DNI: Array.from(S.weather.DNI), DHI: Array.from(S.weather.DHI) });
function startVoi() {
  const sig = voiSig();
  if (VOI.sig === sig) { renderVoi(); return; }
  for (const w of VOI.workers) w.terminate();
  const b = { model: S.model, ageInfo: S.ageInfo, state: S.state };
  const singles = VOI_SRC.filter((k) => !voiKnown(k, b)), pairs = VOI_PAIRS.map((p) => p.join('+')).filter((k) => k.split('+').every((x) => singles.includes(x)));
  const job = (VOI = { sig, res: {}, workers: [], queue: ['null', ...singles, ...pairs], singles, pairs, error: null });
  job.total = job.queue.length;
  const setup = { type: 'setup', model: plainModel(), weather: plainWeather(), ageInfo: S.ageInfo, state: S.state, archetypes: archetypesForWorker(), T: VOI_T, N: VOI_N, seed: voiSeed(S.model.id) };
  const K = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2, job.queue.length));
  for (let i = 0; i < K; i++) {
    const w = new Worker(VOI_URL, { type: 'module' });
    w.onmessage = (ev) => {
      if (job !== VOI) return;
      const d = ev.data;
      if (d.type === 'error') { job.error = d.message; console.error(d.message); renderVoi(); return; }
      if (d.type === 'result') job.res[d.key] = d;
      const next = job.queue.shift();
      if (next) w.postMessage({ type: 'scen', key: next });
      else { w.terminate(); job.workers = job.workers.filter((x) => x !== w); }
      if (d.type === 'result') renderVoi();
    };
    w.onerror = (e) => { if (job === VOI) { job.error = e.message || e.type; renderVoi(); } };
    w.postMessage(setup);
    job.workers.push(w);
  }
  renderVoi();
}
// where each source is entered on this page (information-driven: every row leads to its input)
const VOI_GO = { age: ['params', '#pp-age'], refurb: ['params', '#pp-refurb'], bimConstr: ['params', '#pr-U_wall', 'U_wall'], bimGeom: ['params', '#pp-geom'],
  windows: ['params', '#pr-WWR_S', 'WWR_S'], onsite: ['params', '#pr-n50', 'n50'], metered: ['params', '#pr-T_heat', 'T_heat'], meter: ['calib', '#p-calib .card'], geom: ['params', '#pp-geom'] };
const voiOpenSaved = () => { try { return localStorage.getItem('em-voi-open') === '1'; } catch { return false; } };
// a folded card at the bottom of the overview; it computes only when opened, and stays open for the next building
function voiShell() {
  const d = h('details', { class: 'card voi', id: 'ov-voi', open: voiOpenSaved() || null },
    h('summary', { class: 'card-head' }, h('h3', {}, L('补哪项数据最能缩小区间', 'Which data would narrow the range most', 'Welche Daten den Bereich am stärksten eingrenzen'), h('span', { class: 'voi-tip' })), h('span', { class: 'aside' })),
    h('div', { class: 'voi-body' }));
  d.addEventListener('toggle', () => { try { localStorage.setItem('em-voi-open', d.open ? '1' : '0'); } catch { /* ignore */ } if (d.open) startVoi(); else renderVoi(); });
  d.querySelector('summary').addEventListener('click', (e) => { if (e.target.closest('.tip')) e.preventDefault(); });   // the ⓘ explains, it does not fold
  return d;
}
function renderVoi() {
  const box = $('#ov-voi');
  if (!box || !S.model || !S.prior) return;
  const m = S.model, st = S.state, pr = S.prior.heat, wNow = pr[2] - pr[0], R = VOI.res, nul = R.null, cur = VOI.sig === voiSig();
  const user = (k) => m.params[k]?.source === 'user', b = { model: m, ageInfo: S.ageInfo, state: st };
  const go = (k) => () => goto(...VOI_GO[k]);
  const nRef = ['windows', 'wall', 'roof', 'floor'].filter((c) => (st.refurb?.[c] || 'unknown') !== 'unknown').length;
  const chip = (ok, to, k, v) => h('button', { type: 'button', class: `vchip${ok ? ' ok' : ''}`, onclick: go(to) }, k, ' ', h('b', {}, v));
  const pct5 = (x) => Math.max(0, Math.round(20 * x) * 5);
  const ratio = (k) => (!cur || !nul ? null : k === 'meter' ? nul.meter.heat / nul.heat : k.endsWith('+meter') ? (R[k.slice(0, -6)] ? R[k.slice(0, -6)].mHeat / nul.heat : null) : R[k] ? R[k].heat / nul.heat : null);
  const nameOf = (k) => k.split('+').map((x) => (x === 'meter' ? VOI_BILL : VOI_NAME[x])).join(' + ');
  const whyOf = (k) => k.split('+').map((x) => L(`${nameOf(x)}：告诉模型${VOI_WHAT[x]}；来源：${VOI_WHERE[x]}。`, `${nameOf(x)}: tells the model ${VOI_WHAT[x]}; from ${VOI_WHERE[x]}.`, `${nameOf(x)}: liefert dem Modell ${VOI_WHAT[x]}; aus ${VOI_WHERE[x]}.`)).join(' ');
  // a row leads to where its source is entered; in a pair each name leads to its own input. Sources closer than
  // VOI_TIE_PTS share one row: the bar is solid to the best of them and light up to the last, each name its own link
  const w100 = (x) => Math.max(1.5, 100 * Math.min(1, x));
  const row = (ks) => {
    const rs = ks.map(ratio), r = rs[0], r1 = rs[rs.length - 1], many = ks.length > 1;
    // one inline item per source (a pair keeps its " + " inside), the separator after it, so the flex gap never splits them
    const names = ks.map((k, j) => h('span', {}, ...k.split('+').flatMap((x, i) => [i ? ' + ' : null, h('button', { type: 'button', class: 'voi-go', onclick: (e) => { e.stopPropagation(); go(x)(); } }, nameOf(x))]), j < ks.length - 1 ? L('、', ', ', ', ') : null));
    const tieTip = L(`这几项相差不到 ${pct5(VOI_TIE_PTS)} 个百分点，分不出先后：同一栋楼换随机数重算会差 2–6 个点，换一套合理的模型假设，单项也常差 3–10 个点。`,
      `These differ by less than ${pct5(VOI_TIE_PTS)} points and cannot be ranked: the same building computed with other random numbers differs by 2–6 points, and another plausible set of model assumptions often moves single sources by 3–10 points.`,
      `Diese liegen weniger als ${pct5(VOI_TIE_PTS)} Punkte auseinander und lassen sich nicht ordnen: dasselbe Gebäude mit anderen Zufallszahlen weicht um 2–6 Punkte ab, und ein anderer plausibler Satz von Modellannahmen verschiebt einzelne Quellen oft um 3–10 Punkte.`);
    const a = r == null ? '' : pct5(1 - r1), b = r == null ? '' : pct5(1 - r), share = many && a !== b ? `−${a}–${b}%` : `−${b}%`;
    const to = r == null ? '' : many && fmt(r * wNow) !== fmt(r1 * wNow) ? `${fmt(r * wNow)}–${fmt(r1 * wNow)}` : fmt(r * wNow);
    const el = h('div', { class: `voi-row${many ? ' tie' : ''}`, title: L('点击去填这项', 'Click to enter this', 'Klicken, um dies einzugeben') },
      h('span', { class: 'voi-name' }, ...names, info([many ? tieTip : '', ...ks.map(whyOf)].filter(Boolean).join(' '))),
      h('span', { class: 'voi-bar', role: 'img', 'aria-label': r == null ? '' : L(`区间剩 ${pct5(r)}${many ? `–${pct5(r1)}` : ''}%`, `${pct5(r)}${many ? `–${pct5(r1)}` : ''}% of the range left`, `${pct5(r)}${many ? `–${pct5(r1)}` : ''} % des Bereichs bleiben`) },
        r == null ? null : h('i', { style: `width:${w100(r)}%` }), r != null && many ? h('i', { class: 'rng', style: `left:${w100(r)}%;width:${Math.max(0, w100(r1) - w100(r))}%` }) : null),
      h('span', { class: 'voi-val' }, r == null ? '…' : [`${fmt(wNow)} → ${to}`, h('small', {}, share)]),
      h('span', { class: 'voi-chev', 'aria-hidden': 'true' }, '›'));
    el.addEventListener('click', (e) => { if (!e.target.closest('.tip')) go(ks[0].split('+')[0])(); });
    return el;
  };
  const groups = (keys) => keys.reduce((g, k) => { const last = g[g.length - 1]; if (last && ratio(k) - ratio(last[0]) < VOI_TIE_PTS) last.push(k); else g.push([k]); return g; }, []);
  const tip = L(`只算这栋楼：从它的先验里抽 ${VOI_T} 个可能的“真实”版本（已填的信息保持不变），假设某项数据把它知道的输入如实告诉模型，其余照常抽样，看 P10–P90 还剩多宽，再取平均。补上数据后区间落在哪里，要看测出来的结果，事先不知道，所以这里只给区间能缩窄多少。数据都按完全准确算，所以是上限。同一栋楼换随机数重算，相差 2–6 个百分点，个别到 10，所以百分比按 5 取整。只看供暖需求。相差不到 10 个百分点的几项合成一行，分不出先后。点一项去填。`,
    `For this building only: ${VOI_T} possible “true” versions are drawn from its prior (keeping everything entered on this page); a source is assumed to tell the model the inputs it knows, the rest is sampled as usual, and the P10–P90 left is averaged. Where the range lands once the data are in depends on what they show, which is not known beforehand, so only the narrowing is given. Every source is taken as exact, so these are upper bounds. Computed again with other random numbers the same building differs by 2–6 points, up to 10, so the shares are rounded to 5%. Heating demand only. Sources less than 10 points apart share a row: they cannot be ranked. Click an item to enter it.`,
    `Nur für dieses Gebäude: Aus seinem Prior werden ${VOI_T} mögliche „wahre“ Varianten gezogen (alles auf dieser Seite Eingegebene bleibt); eine Quelle liefert dem Modell die Eingangsgrößen, die sie kennt, der Rest wird wie üblich gezogen, und der verbleibende P10–P90-Bereich wird gemittelt. Wo der Bereich mit den Daten landet, hängt davon ab, was sie zeigen, und ist vorher nicht bekannt; angegeben ist daher nur die Eingrenzung. Jede Quelle gilt als exakt, die Werte sind also Obergrenzen. Mit anderen Zufallszahlen weicht dasselbe Gebäude um 2–6 Punkte ab, vereinzelt um 10, daher sind die Anteile auf 5 % gerundet. Nur Heizwärmebedarf. Quellen, die weniger als 10 Punkte auseinanderliegen, teilen sich eine Zeile: sie lassen sich nicht ordnen. Ein Klick auf einen Eintrag führt zur Eingabe.`);
  box.querySelector('.voi-tip').replaceChildren(info(tip));
  const n = cur ? Object.keys(R).length : 0, busy = cur && !VOI.error && n < (VOI.total || 1);
  box.querySelector('summary .aside').textContent = VOI.error && cur ? L('计算失败', 'failed', 'fehlgeschlagen') : busy ? L(`计算中 ${n}/${VOI.total}`, `computing ${n}/${VOI.total}`, `wird berechnet ${n}/${VOI.total}`)
    : box.open ? '' : L(`区间宽 ${fmt(wNow)} kWh/(m²·a)`, `range ${fmt(wNow)} kWh/(m²·a) wide`, `Bereich ${fmt(wNow)} kWh/(m²·a) breit`);   // folded, it says how wide the range is
  if (!box.open) return;
  const have = h('div', { class: 'voi-have' },
    chip(!!m.lod2, 'geom', L('几何', 'Geometry', 'Geometrie'), m.lod2 ? L('LoD2 实测', 'LoD2, measured', 'LoD2, gemessen') : L('OSM 推测', 'OSM, estimated', 'OSM, geschätzt')),
    chip(voiKnown('age', b), 'age', L('年代', 'Age', 'Baualter'), st.ageClass ? L('已填', 'entered', 'eingegeben') : S.ageInfo.kind === 'osm' ? L('OSM 标注', 'OSM tag', 'OSM-Tag') : L('Zensus 推测', 'Zensus, estimated', 'Zensus, geschätzt')),
    chip(nRef === 4, 'refurb', L('改造', 'Refurbishment', 'Sanierung'), nRef === 4 ? L('已填', 'entered', 'eingegeben') : nRef ? L(`已填 ${nRef}/4`, `${nRef} of 4 entered`, `${nRef} von 4 eingegeben`) : L('未知', 'unknown', 'unbekannt')),
    chip(['U_wall', 'U_roof', 'U_floor', 'U_window'].every(user), 'bimConstr', L('构造', 'Construction', 'Konstruktion'), ['U_wall', 'U_roof', 'U_floor', 'U_window'].some(user) ? L('部分已填', 'partly entered', 'teilweise eingegeben') : L('查表', 'table values', 'Tabellenwerte')),
    chip(user('n50') && user('dU_tb'), 'onsite', L('气密性、热桥', 'Air tightness, thermal bridges', 'Luftdichtheit, Wärmebrücken'), user('n50') || user('dU_tb') ? L('部分已填', 'partly entered', 'teilweise eingegeben') : L('查表', 'table values', 'Tabellenwerte')),
    chip(['T_heat', 'n_vent', 'Q_int'].every(user), 'metered', L('使用', 'Use', 'Nutzung'), ['T_heat', 'n_vent', 'Q_int'].some(user) ? L('部分已填', 'partly entered', 'teilweise eingegeben') : L('标准假设', 'standard assumptions', 'Standardannahmen')),
    chip(!!S.calib, 'meter', L('账单', 'Bill', 'Abrechnung'), S.calib ? L('已标定', 'calibrated', 'kalibriert') : L('未填', 'none', 'keine')));
  // single sources (and the bill), best first; those that hardly narrow it are named in one line, each name a link
  const singles = cur ? [...(VOI.singles || []), ...(S.calib ? [] : ['meter'])] : [];
  const done = singles.filter((k) => ratio(k) != null).sort((a, c) => ratio(a) - ratio(c)), wait = singles.filter((k) => ratio(k) == null);
  const flat = done.filter((k) => ratio(k) > 0.95), main = done.filter((k) => ratio(k) <= 0.95);
  // pairs, and each source with the bill (the reading weights the same draws, no extra runs), best three
  const combos = cur ? [...(VOI.pairs || []), ...(S.calib ? [] : (VOI.singles || []).map((k) => `${k}+meter`))].filter((k) => ratio(k) != null).sort((a, c) => ratio(a) - ratio(c)).slice(0, 3) : [];
  box.querySelector('.voi-body').replaceChildren(...[
    h('div', { class: 'voi-now' }, L('供暖需求现在', 'Heating demand now', 'Heizwärmebedarf jetzt'), ' ', h('b', {}, `P10 ${fmt(pr[0])}`), ' · ', h('b', {}, `${L('中位数', 'median', 'Median')} ${fmt(pr[1])}`), ' · ', h('b', {}, `P90 ${fmt(pr[2])}`),
      ' kWh/(m²·a)', L(`，区间宽 ${fmt(wNow)}`, `, range ${fmt(wNow)} wide`, `, Bereich ${fmt(wNow)} breit`)),
    have,
    h('div', { class: 'voi-list' }, ...groups(main).map(row), ...wait.map((k) => row([k]))),
    flat.length ? h('div', { class: 'voi-flat' }, L('几乎不缩：', 'Hardly narrows it: ', 'Grenzt kaum ein: '), ...flat.flatMap((k, i) => [i ? L('、', ', ', ', ') : null, h('button', { type: 'button', class: 'voi-go', onclick: go(k) }, nameOf(k))]).filter(Boolean)) : null,
    combos.length ? h('div', { class: 'voi-sub' }, L('两项一起', 'Two together', 'Zwei zusammen')) : null,
    combos.length ? h('div', { class: 'voi-list' }, ...groups(combos).map(row)) : null].filter(Boolean));
}

// The viewer gets only the near context (≤ 45 m beyond the footprint); shading still uses the full 150 m.
function viewModel(m) {
  const r = Math.max(...m.outer.map(([x, y]) => Math.hypot(x, y)));
  const near = m.neighbors.filter((n) => n.outer.some(([x, y]) => Math.hypot(x, y) < r + 45));
  return { ...m, neighbors: near };
}

function applyColoring() {
  if (!S.viewer) return;
  const c = S.colorMode === 'none' ? null : coloring();
  S.viewer.setColoring(c ? { values: c.values, colorFn: c.colorFn } : null);
  const lg = $('#legend');
  if (!c) { lg.replaceChildren(); return; }
  lg.title = c.label;
  lg.innerHTML = `<span>${fmt(c.lo, 1)}</span><span class="bar" style="background:linear-gradient(90deg,${c.palette.join(',')})"></span><span>${fmt(c.hi, 1)} ${c.unit}</span>`;
}

function sunNow() {   // the sun of the month and hour chosen under the 3D view
  const mo = +($('#smonth')?.value || 1), hr = +($('#shour')?.value || 12);
  const day = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][mo - 1];
  return sunPosition(day, hr - 1, S.model.center.lat, S.model.center.lon); // local CET → UTC
}
function setSun() {
  if (!S.viewer) return;
  const hr = +$('#shour').value;
  $('#shourl').textContent = `${String(Math.floor(hr)).padStart(2, '0')}:${hr % 1 ? '30' : '00'}`;
  const s = sunNow();
  S.viewer.setSun(s.altitude > 0 ? { azimuth: s.azimuth, altitude: s.altitude } : null);
}

// First-person walk through the streets around the building (js/walk.js); the window pattern of the selected building
// takes the model's own window-to-wall ratio
function walkHere() {
  if (!S.model) return;
  const fs = S.model.facades || [];
  const wa = fs.reduce((t, f) => t + (f.windowArea || 0), 0), ea = fs.reduce((t, f) => t + (f.exposedArea || 0), 0);
  openWalk(S.model, { h, info, mapApi: S.mapApi, host: $('.mapcol'), sun: sunNow(), wwr: ea > 0 ? wa / ea : null,
    onPick: async (id, lon, lat) => {   // a building clicked in the walk: the panel switches to it, the walk stays
      const rec = await byId(id, lon, lat) || await buildingAt(lon, lat);
      if (rec) { await select(rec, { keepWalk: true }); walkSelect(id); }
    } });
}

// ---------- references ----------
const TIER_OF = { osm: 'osm', geometry: 'osm', lod2: 'osm', archetype: 'archetype', profile: 'archetype', zensus: 'archetype', default: 'default', user: 'user', calibrated: 'calibrated' };
const RES = ['sfh', 'th', 'mfh', 'ab'];
const SYS_SHORT = { gas_old: L('燃气', 'gas', 'Gas'), gas_cond: L('燃气', 'gas', 'Gas'), oil: L('燃油', 'oil', 'Heizöl'), district: L('区域供热', 'district', 'Fernwärme'), hp_air: L('热泵', 'heat pump', 'Wärmepumpe'), hp_ground: L('热泵', 'heat pump', 'Wärmepumpe'), pellet: L('木材', 'wood', 'Holz'), electric: L('电热', 'electric', 'Strom') };
function refCtx(k) {
  const m = S.model, st = S.state.refurb || {}, mp = S.assigned.mp || {};
  const comp = { U_window: 'windows', g_window: 'windows', U_wall: 'wall', U_roof: 'roof', U_floor: 'floor' }[k];
  const state = comp ? st[comp] || 'unknown' : null;
  const share = comp ? (state === 'yes' ? 1 : state === 'no' ? 0 : mp[comp] || 0) : 0;
  return { param: m.params[k], share, state, residential: RES.includes(m.usage), system: factors().systems[m.params.system.value] };
}
// Source chip as a button: opens the row with the concrete references (document, page, link) under the parameter.
function srcBtn(k, source, label) {
  return h('button', { type: 'button', class: `src ${source} srcbtn`, 'aria-expanded': 'false', title: L('查看出处', 'Show the references', 'Quellen anzeigen'),
    onclick: (e) => { const r = $(`#ref-${k}`); if (!r) return; r.hidden = !r.hidden; e.currentTarget.setAttribute('aria-expanded', String(!r.hidden)); } }, label || SOURCE_CN[source] || source);
}
function refList(refs) {
  return h('ul', { class: 'refs' }, ...refs.map((r) => h('li', {}, h('span', { class: `src ${r.tier}` }, TIER[TIER_OF[r.tier] || 'default']), ' ', h('b', {}, r.label), r.where ? ` · ${r.where}` : '',
    r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, L(' 打开原文 ↗', ' open ↗', ' öffnen ↗')) : null)));
}
function refRow(k, note, refs) {
  return h('tr', { class: 'refrow', id: `ref-${k}`, hidden: true }, h('td', { colspan: 4 }, note ? h('div', { class: 'note' }, note) : null, refs.length ? refList(refs) : h('div', { class: 'note' }, L('没有登记出处', 'No reference recorded', 'Keine Quelle hinterlegt'))));
}

// ---------- params ----------
function renderParams() {
  const m = S.model, P = $('#params-main');
  const ages = S.A.ageClasses;
  const draws = (() => { const d = makePrior(m, S.ageInfo, S.state, S.assigned); const r = rng(5); return Array.from({ length: 400 }, () => d(r).p); })();
  const q = (k, p) => { const a = draws.map((d) => d[k]).filter((v) => typeof v === 'number').sort((x, y) => x - y); return a.length ? a[Math.round(p * (a.length - 1))] : null; };
  const ageSel = h('select', { onchange: (e) => { S.state.ageClass = e.target.value || null; S.calibApplied = null; rebuild(); } },
    h('option', { value: '' }, L(`按先验：${S.ageInfo.src}`, `From the prior: ${S.ageInfo.src}`, `Aus dem Prior: ${S.ageInfo.src}`)), ...ages.map((c) => h('option', { value: c.id, selected: S.state.ageClass === c.id }, c.label)));
  const refSel = (c, label) => h('label', {}, label + ' ', h('select', { onchange: (e) => { S.state.refurb[c] = e.target.value; rebuild(); } },
    ...[['unknown', L(`未知（${fmt((S.assigned.mp[c] || 0) * 100)}% 改造过）`, `Unknown (${fmt((S.assigned.mp[c] || 0) * 100)}% retrofitted)`, `Unbekannt (${fmt((S.assigned.mp[c] || 0) * 100)}% saniert)`)], ['yes', L('已改造', 'Retrofitted', 'Saniert')], ['no', L('原始状态', 'Original', 'Originalzustand')]].map(([v, t]) => h('option', { value: v, selected: S.state.refurb[c] === v }, t))));
  const usageSel = h('select', { onchange: (e) => { S.state.geom.usage = e.target.value; rebuild({ geometry: true }); } },
    ...Object.entries(TYPE_CN).map(([k, v]) => h('option', { value: k, selected: m.usage === k }, v)));
  const geomIn = (key, val, step, title) => h('input', { type: 'number', step, value: val, title, style: 'width:80px', onchange: (e) => { const v = parseFloat(e.target.value); if (v > 0) { S.state.geom[key] = key === 'floors' ? Math.round(v) : v; rebuild({ geometry: true }); } } });
  const agePriorBars = h('div', { id: 'agebars' });
  const tbl = h('table', { class: 't' }, h('tr', {}, h('th', {}, L('参数', 'Parameter', 'Parameter')), h('th', {}, L('取值', 'Value', 'Wert')), h('th', {}, L('来源', 'Source', 'Quelle')), h('th', {}, L('先验 10–90%', 'Prior 10–90%', 'Prior 10–90%'))));
  const groups = {};
  for (const [k, meta] of Object.entries(PARAM_META)) (groups[meta.group] = groups[meta.group] || []).push(k);
  for (const [g, keys] of Object.entries(groups)) {
    tbl.append(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, g)));
    for (const k of keys) {
      const pv = m.params[k];
      if (!pv) continue;
      let input;
      if (k === 'system') {
        input = h('select', { onchange: (e) => { S.state.system = e.target.value; rebuild(); } }, ...Object.entries(factors().systems).map(([sk, sv]) => h('option', { value: sk, selected: pv.value === sk }, sv.label)));
      } else {
        input = h('input', { type: 'number', step: 'any', value: pv.value == null ? '' : +(+pv.value).toPrecision(4), placeholder: L('无', 'none', 'keine'),
          onchange: (e) => { const v = e.target.value === '' ? null : parseFloat(e.target.value); S.state.user[k] = v; rebuild(); } });
      }
      // what the prior samples: the parameter itself, a common WWR factor, or the Zensus system shares
      let prior = null;
      if (k.startsWith('WWR_') && q('wwrScale', 0.1) != null) prior = `${fmt(pv.value * q('wwrScale', 0.1), 2)} – ${fmt(pv.value * q('wwrScale', 0.9), 2)}`;
      else if (k === 'system' && pv.source !== 'user') { const sp = systemPrior(S.ageInfo.heat, S.assigned.cls); if (sp) prior = Object.entries(sp).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([sk, v]) => `${SYS_SHORT[sk] || sk} ${fmt(v * 100)}%`).join(' · '); }
      else if (UNCERTAIN.includes(k) && q(k, 0.1) != null) prior = `${fmt(q(k, 0.1), 2)} – ${fmt(q(k, 0.9), 2)}`;
      tbl.append(h('tr', { id: `pr-${k}` },
        h('td', { class: 'nm', title: pv.note || null }, meta_label(k)),
        h('td', { class: 'num' }, input, ' ', h('span', { class: 'note' }, PARAM_META[k].unit)),
        h('td', {}, srcBtn(k, pv.source), pv.source === 'user' ? h('button', { class: 'btn small', style: 'margin-left:6px', onclick: () => { delete S.state.user[k]; rebuild(); } }, L('撤销', 'Undo', 'Rückgängig')) : null),
        h('td', { class: 'num' }, prior || h('span', { class: 'note' }, L('固定', 'fixed', 'fest')))),
        refRow(k, pv.note, refsFor(k, refCtx(k))));
    }
  }
  // Carrier factors: global, so one change applies to every building (the unified-adjustment idea of the data ledger)
  const car = factors().carriers[S.fe.carrier] || {}, base = S.factorBase[S.fe.carrier] || car, ov = S.factorOv[S.fe.carrier] || {};
  tbl.append(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, L(`排放与一次能源系数（${car.label}，对所有楼生效）`, `Emission and primary energy factors (${car.label}, applies to every building)`, `Emissions- und Primärenergiefaktoren (${car.label}, gilt für alle Gebäude)`))));
  for (const [k, lab, unit, d] of [['co2', L('CO₂ 排放系数', 'CO₂ emission factor', 'CO₂-Emissionsfaktor'), 'g/kWh', 0], ['fp', L('一次能源系数', 'Primary energy factor', 'Primärenergiefaktor'), '–', 2]]) {
    const user = ov[k] != null;
    tbl.append(h('tr', { id: `pr-${k}` },
      h('td', { class: 'nm', title: base.src || null }, lab),
      h('td', { class: 'num' }, h('input', { type: 'number', step: 'any', value: +(+car[k]).toPrecision(4), onchange: (e) => setFactor(S.fe.carrier, k, e.target.value === '' ? null : parseFloat(e.target.value)) }), ' ', h('span', { class: 'note' }, unit)),
      h('td', {}, srcBtn(k, user ? 'user' : base.estimated ? 'default' : 'archetype', user ? null : (base.src || '').split(/[ （(]/)[0]), user ? h('button', { class: 'btn small', style: 'margin-left:6px', onclick: () => setFactor(S.fe.carrier, k, null) }, L('撤销', 'Undo', 'Rückgängig')) : null),
      h('td', { class: 'num' }, h('span', { class: 'note' }, user ? L(`默认 ${fmt(base[k], d)}`, `default ${fmt(base[k], d)}`, `Standardwert ${fmt(base[k], d)}`) : L('固定', 'fixed', 'fest')))),
      refRow(k, base.src, [...(user ? [{ label: L('用户填写', 'User input', 'Eigene Eingabe'), where: L(`覆盖默认值 ${fmt(base[k], d)}，对所有楼生效`, `Overrides the default ${fmt(base[k], d)} for every building`, `Ersetzt den Standardwert ${fmt(base[k], d)} für alle Gebäude`), url: null, tier: 'user' }] : []), ...refsFor(k, { carrier: base })]));
  }
  const varCard = uncertaintyCard();
  P.replaceChildren(
    varCard || '',
    h('div', { class: 'card', id: 'pp-weather' }, head(L('气象', 'Weather', 'Wetter'), L('ERA5 再分析，慕尼黑市中心格点。供暖度日按 20/15 °C。', 'ERA5 reanalysis, grid point in central Munich. Heating degree days use 20/15 °C.', 'ERA5-Reanalyse, Gitterpunkt in der Münchner Innenstadt. Gradtagzahl mit 20/15 °C.')), h('div', { class: 'row' }, h('select', { onchange: async (e) => { S.weatherKey = e.target.value; S.weather = await loadWeather(S.weatherKey); S.irrOpen = null; rebuild(); } },
      h('option', { value: 'tmy', selected: S.weatherKey === 'tmy' }, L(`典型气象年（${S.weatherIndex.tmy.Tmean} °C，供暖度日 ${S.weatherIndex.tmy.HDD20_15}）`, `Typical meteorological year (${S.weatherIndex.tmy.Tmean} °C, heating degree days ${S.weatherIndex.tmy.HDD20_15})`, `Typisches meteorologisches Jahr (${S.weatherIndex.tmy.Tmean} °C, Gradtagzahl ${S.weatherIndex.tmy.HDD20_15})`)),
      ...Object.entries(S.weatherIndex.years).reverse().map(([y, v]) => h('option', { value: y, selected: S.weatherKey === y }, L(`${y} 年实际（${v.Tmean} °C，供暖度日 ${v.HDD20_15}）`, `${y} actual (${v.Tmean} °C, heating degree days ${v.HDD20_15})`, `${y} tatsächlich (${v.Tmean} °C, Gradtagzahl ${v.HDD20_15})`)))))),
    h('div', { class: 'card', id: 'pp-age' }, head(L('建成年代', 'Construction age', 'Baualtersklasse'), L(`先验来自 ${S.ageInfo.src}。Zensus 只统计有住宅的建筑，非住宅楼也用同一网格分布近似。选定年代后，构件值按该年代查表。`, `The prior comes from ${S.ageInfo.src}. Zensus counts only buildings with dwellings, so non-residential buildings use the same grid distribution as an approximation. Once you choose an age class, the element values come from the table for that class.`, `Der Prior stammt aus ${S.ageInfo.src}. Der Zensus zählt nur Gebäude mit Wohnungen; für Nichtwohngebäude dient dieselbe Rasterverteilung als Näherung. Sobald Sie eine Baualtersklasse wählen, stammen die Bauteilwerte aus der Tabelle für diese Klasse.`)),
      h('div', { class: 'row' }, ageSel), agePriorBars),
    h('div', { class: 'card', id: 'pp-refurb' }, head(L('构件是否改造过', 'Have the elements been retrofitted?', 'Wurden die Bauteile saniert?'), L('"未知"时按该年代的改造比例当伯努利先验；点估计取概率较大的状态。知道的话直接选，会把先验收成确定值。', '"Unknown" uses the retrofit share of the age class as a Bernoulli prior. The point estimate takes the more likely state. If you know the answer, choose it, and the prior collapses to that value.', '„Unbekannt“ verwendet den Sanierungsanteil der Baualtersklasse als Bernoulli-Prior. Die Punktschätzung nimmt den wahrscheinlicheren Zustand. Wenn Sie den Zustand kennen, wählen Sie ihn aus; der Prior wird dann auf diesen Wert festgelegt.')),
      h('div', { class: 'row' }, refSel('windows', L('窗', 'Windows', 'Fenster')), refSel('wall', L('外墙', 'External wall', 'Außenwand')), refSel('roof', L('屋顶/顶板', 'Roof / top ceiling', 'Dach / oberste Geschossdecke')), refSel('floor', L('地下室顶板/地面', 'Basement ceiling / ground floor', 'Kellerdecke / Bodenplatte')))),
    h('div', { class: 'card', id: 'pp-geom' }, head(L('几何与类型', 'Geometry and type', 'Geometrie und Typ')),
      h('div', { class: 'row' }, h('label', {}, L('类型 ', 'Type ', 'Typ '), usageSel), h('label', {}, L('层数 ', 'Storeys ', 'Geschosse '), geomIn('floors', m.floors, 1, m.geomSrc.floors)), h('label', {}, L('檐口高度 ', 'Eaves height ', 'Traufhöhe '), geomIn('height', m.height, 0.1, m.geomSrc.height), ' m')),
      h('dl', { class: 'stats' }, ...[
        [L('占地', 'Footprint', 'Grundfläche'), `${fmt(m.areas.footprint)} m²`], [L('体积', 'Volume', 'Volumen'), `${fmt(m.areas.volume)} m³`],
        [L('外露立面', 'Exposed facade', 'Freiliegende Fassade'), `${fmt(m.areas.facadeExposed)} / ${fmt(m.areas.facadeGross)} m²`, L('外露 / 总立面', 'exposed / total facade', 'freiliegende / gesamte Fassade')], [L('窗', 'Windows', 'Fenster'), `${fmt(m.areas.window)} m²`],
        [L('参考面积 A_N', 'Reference area A_N', 'Gebäudenutzfläche A_N'), `${fmt(m.areas.netFloor)} m²`, ['sfh', 'th', 'mfh', 'ab'].includes(m.usage) ? L('GEG：由毛体积换算', 'GEG: derived from the gross volume', 'GEG: aus dem Bruttovolumen abgeleitet') : L('0.85 × 毛楼面积', '0.85 × gross floor area', '0,85 × Bruttogrundfläche')],
      ].map(([k, v, t]) => h('div', { title: t || null }, h('dt', {}, k), h('dd', {}, v)))),
      lod2Block(m)),
    h('div', { class: 'card', id: 'pp-table' }, head(L('全部物理参数', 'All physical parameters', 'Alle physikalischen Parameter'), L('改任何一个值都会立即重算，来源变成"用户填写"，标定时也会固定它。悬停在参数名或来源上可看说明。', 'Changing any value recomputes at once. Its source becomes "User input", and the calibration keeps it fixed. Hover over a parameter or its source for the note.', 'Jede Änderung wird sofort neu berechnet. Die Quelle des Werts wird zu „Eigene Eingabe“, und die Kalibrierung hält ihn fest. Für Erläuterungen zeigen Sie mit der Maus auf einen Parameter oder seine Quelle.'),
      h('span', { class: 'tierkey' }, ...['osm', 'archetype', 'default', 'user', 'calibrated'].map((k) => h('span', { class: `src ${k}` }, TIER[k])))), h('div', { class: 'tblwrap' }, tbl)),
  );
  if (varCard) varCard.draw();
  const ids = ages.map((c) => c.id);
  C.cats(agePriorBars, { labels: ageLabels(), a: ids.map((k) => S.ageInfo.p[k]), b: S.calib ? ids.map((k) => S.calib.post.ages[k] || 0) : null, aLabel: L('先验', 'Prior', 'Prior'), bLabel: L('标定后', 'After calibration', 'Nach Kalibrierung'), height: 140 });
}
// OSM vs LoD2 side by side for buildings with Bavarian LoD2; the column in use is bold, one button switches.
const ROOF_NAME = () => ({ flat: L('平屋顶', 'flat', 'Flachdach'), gabled: L('双坡', 'gabled', 'Satteldach'), hipped: L('四坡', 'hipped', 'Walmdach'), skillion: L('单坡', 'mono-pitch', 'Pultdach'), side_hipped: L('半四坡', 'half-hipped', 'Krüppelwalmdach'), pyramidal: L('攒尖', 'pyramidal', 'Zeltdach') });
function lod2Block(m) {
  const L2 = lod2Record(S.lod2Map?.get(m.id));
  if (!L2) return null;
  const og = m.osmGeom, using = !!m.lod2, RN = ROOF_NAME();
  const cell = (v, on) => h('td', { class: `num${on ? ' on' : ''}` }, v);
  const row = (k, a, b) => h('tr', {}, h('td', {}, k), cell(a, !using), cell(b, using));
  const tip = L(`巴伐利亚测绘局的 LoD2（${L2.lod2}${L2.n > 1 ? `，与另外 ${L2.n - 1} 栋合并` : ''}，CC BY 4.0）。单一棱柱模型取等效值：檐口 = 墙面积 ÷ 地面周长，保留外墙面积；坡屋顶的屋顶高度由体积折算，保留体积；层数取地上层数，没有时用 OSM 层数或檐口 ÷ 默认层高。实测总高 ${fmt(L2.measuredHeight, 1)} m，体积 ${fmt(L2.volume)} m³，LoD2 地面为 OSM 占地的 ${L2.ratio}%。邻楼也用 LoD2 高度。`,
    `Bavarian surveying agency LoD2 (${L2.lod2}${L2.n > 1 ? `, pooled with ${L2.n - 1} more` : ''}, CC BY 4.0). Equivalents for the single-prism model: eaves = wall area ÷ ground perimeter, which keeps the external wall area; for pitched roofs the roof height comes from the volume; storeys above ground as recorded, else the OSM storeys or eaves ÷ default storey height. Measured total height ${fmt(L2.measuredHeight, 1)} m, volume ${fmt(L2.volume)} m³, LoD2 ground ${L2.ratio}% of the OSM footprint. Neighbours take their LoD2 heights too.`, `LoD2 der Bayerischen Vermessungsverwaltung (${L2.lod2}${L2.n > 1 ? `, zusammengefasst mit ${L2.n - 1} weiteren Gebäuden` : ''}, CC BY 4.0). Äquivalente Werte für das Einzelprisma-Modell: Traufhöhe = Wandfläche ÷ Grundrissumfang, damit bleibt die Außenwandfläche erhalten; bei geneigten Dächern ergibt sich die Dachhöhe aus dem Volumen; oberirdische Geschosse laut Datensatz, sonst die OSM-Geschosse oder Traufhöhe ÷ Standard-Geschosshöhe. Gemessene Gesamthöhe ${fmt(L2.measuredHeight, 1)} m, Volumen ${fmt(L2.volume)} m³, LoD2-Grundfläche ${L2.ratio}% der OSM-Grundfläche. Auch Nachbargebäude erhalten ihre LoD2-Höhen.`);
  return h('div', { class: 'lod2cmp', id: 'pp-lod2' },
    h('div', { class: 'card-head' }, h('h4', {}, L('与 LoD2 实测对照', 'Against measured LoD2', 'Vergleich mit LoD2-Messung'), info(tip)),
      h('button', { class: 'btn small', onclick: () => { S.state.geom.lod2 = !using; delete S.state.geom.height; delete S.state.geom.floors; rebuild({ geometry: true }); } }, using ? L('改回 OSM 几何', 'Back to OSM geometry', 'Zurück zur OSM-Geometrie') : L('改用 LoD2 几何', 'Use LoD2 geometry', 'LoD2-Geometrie verwenden'))),
    h('table', { class: 't' },
      h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, 'OSM'), h('th', { class: 'num' }, h('span', { class: 'src lod2' }, 'LoD2'))),
      row(L('檐口高度', 'Eaves height', 'Traufhöhe'), `${fmt(og.height, 1)} m`, `${fmt(L2.eaves, 1)} m`),
      row(L('屋顶高度', 'Roof height', 'Dachhöhe'), `${fmt(og.roof.ridgeHeight, 1)} m`, `${fmt(L2.ridge, 1)} m`),
      row(L('层数', 'Storeys', 'Geschosse'), og.floors, L2.storeys ?? '–'),
      row(L('屋顶形状', 'Roof shape', 'Dachform'), RN[og.roof.shape] || og.roof.shape, h('span', { title: L2.roofDE }, RN[L2.shape] || L2.shape))),
    h('p', { class: 'lod2src' }, lod2Link(L2, L('巴伐利亚测绘局 LoD2 开放数据 ↗', 'Bavarian surveying agency, LoD2 open data ↗', 'Bayerische Vermessungsverwaltung, offene LoD2-Daten ↗')), ` · ${L2.lod2} · CC BY 4.0`));
}
// Data and resources on the start page: a full credit list (name, what it gives, licence), pushed to the bottom of the
// panel and kept in light grey so the map keeps the attention (colleagues testing the page clicked the map at once;
// a bold, coloured list drew the eye). Document links come from the archetype source registry, shared with the
// parameter references.
function renderSources(list) {
  const U = Object.fromEntries((list || []).map((x) => [x.id, x.url]));
  const rows = [
    ['OpenStreetMap', 'https://www.openstreetmap.org/copyright', L('楼的轮廓、类型、地址和层数标签', 'Outlines, type, address and storey tags', 'Umrisse, Typ, Adresse und Geschoss-Tags'), 'ODbL'],
    [L('巴伐利亚测绘局 LoD2', 'Bavarian LoD2 building models', 'Bayerische LoD2-Gebäudemodelle'), LOD2_URL, L('实测高度、屋顶形状、层数和地籍建筑功能', 'Measured height, roof shape, storeys and the cadastre\'s building function', 'Gemessene Höhe, Dachform, Geschosse und Gebäudefunktion des Katasters'), 'CC BY 4.0'],
    ['Zensus 2022', ZENSUS, L('100 m 网格的建造年代、供暖能源和居住面积', 'Construction period, heating fuel and living area on a 100 m grid', 'Baujahr, Energieträger der Heizung und Wohnfläche im Raster von 100 m'), 'dl-de/by-2-0'],
    ['Open-Meteo · ERA5', 'https://open-meteo.com/', L('2010–2025 年逐时气象和典型年', 'Hourly weather 2010–2025 and the typical year', 'Stündliches Wetter 2010–2025 und typisches Jahr'), 'CC BY 4.0'],
    [L('IWU 德国住宅类型学', 'IWU German residential typology', 'IWU: Deutsche Wohngebäudetypologie'), U.IWU2015, L('各年代构件的 U 值和供暖系统损失', 'Component U-values and heating system losses by age', 'U-Werte der Bauteile und Anlagenverluste nach Baualtersklasse')],
    [L('IWU 住宅存量调查 2016', 'IWU housing stock survey 2016', 'IWU-Datenerhebung Wohngebäudebestand 2016'), U.IWU2018, L('后加保温的厚度和换窗比例', 'Added insulation thickness and window replacement shares', 'Nachträgliche Dämmstärken und Anteile erneuerter Fenster')],
    [L('dena 指南（DIN V 18599）', 'dena guide (DIN V 18599)', 'dena-Leitfaden (DIN V 18599)'), U.DENA2023, L('设定温度、通风、内热和热水', 'Set-points, ventilation, internal gains and hot water', 'Solltemperaturen, Lüftung, interne Wärmegewinne und Warmwasser')],
    ['GEG 2024', U.GEG, L('参考面积、一次能源和 CO₂ 系数', 'Reference area, primary energy and CO₂ factors', 'Gebäudenutzfläche, Primärenergie- und CO₂-Faktoren')],
    ['Heizspiegel München 2018', 'https://web.archive.org/web/20240416131550/https://www.heizspiegel.de/fileadmin/hs/khsp/muenchen/Heizspiegel_Muenchen_2018_Abrechnungsjahr_2016_web.pdf#page=4', L('结算年 2016 集中供暖住宅的账单分布，用于和账单比较', 'Bills of centrally heated housing for 2016, for the comparison with bills', 'Abrechnungswerte zentral beheizter Wohngebäude für 2016, für den Vergleich mit Abrechnungen')],
    [L('IWU：计算值与实测用量（Loga 等 2019）', 'IWU: calculated vs metered consumption (Loga et al. 2019)', 'IWU: Bedarf und gemessener Verbrauch (Loga et al. 2019)'), 'https://www.iwu.de/fileadmin/publikationen/energie/2022_eceee_Loga-Stein_Use-of-energy-performance-certificates-for-realistic-prognoses.pdf', L('2,857 栋楼的统计关系，把计算值换算到典型实测水平', 'Relation from 2,857 buildings that brings calculated demand to the typical metered level', 'Zusammenhang aus 2.857 Gebäuden, der den berechneten Bedarf auf das typische Verbrauchsniveau bringt')],
    ['Mapillary', 'https://www.mapillary.com/', L('所选楼的街景照片和拍摄位置', 'Street-level photos of the selected building and where they were taken', 'Straßenfotos des gewählten Gebäudes und ihre Aufnahmeorte'), 'CC BY-SA 4.0'],
    ['OpenFreeMap', 'https://openfreemap.org/', L('底图', 'Base map', 'Grundkarte'), '© OpenMapTiles'],
    [L('巴伐利亚测绘局 DGM1 和 DOP40', 'Bavarian DGM1 and DOP40', 'Bayerisches DGM1 und DOP40'), 'https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=dgm1', L('街区漫游的地形和航拍（目前 TUM 主楼周围）', 'Terrain and aerial photo of the street walk (so far around the TUM main building)', 'Gelände und Luftbild des Straßenrundgangs (bisher um das TUM-Hauptgebäude)'), 'CC BY 4.0'],
    [L('巴伐利亚测绘局单棵树数据', 'Bavarian single-tree data', 'Bayerische Einzelbäume'), 'https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=einzelbaeume', L('街区漫游里树的位置和树高（2024）', 'Positions and heights of the trees in the street walk (2024)', 'Standorte und Höhen der Bäume im Straßenrundgang (2024)'), 'CC BY 4.0'],
    ['ambientCG', 'https://ambientcg.com/', L('街区漫游的墙面、屋瓦、铺地、草和沥青纹理', 'Wall, roof tile, paving, grass and asphalt textures of the street walk', 'Wand-, Dachziegel-, Pflaster-, Gras- und Asphalttexturen des Straßenrundgangs'), 'CC0'],
  ];
  $('#empty .srcs')?.remove();
  $('#empty').append(h('section', { class: 'srcs' }, h('h3', {}, L('数据与资料', 'Data and resources', 'Daten und Quellen')),
    h('ul', {}, ...rows.map(([name, url, what, lic]) => h('li', {},
      h('a', { href: url, target: '_blank', rel: 'noopener' }, name + '\u00a0↗'),
      h('span', { class: 'what' }, what), lic ? h('span', { class: 'lic' }, lic) : null))), h('p', { class: 'disclaimer' }, disclaimer()), licenceNote()));
}
// The licence under the disclaimer of the sources (user, 2026-11-17: the author with the TUM position and e-mail; 2026-11-18:
// code and model under PolyForm Noncommercial 1.0.0, results and texts under CC BY-NC 4.0; the full notice with the third-party data is LICENSE of the release, from tools/release/LICENSE)
function licenceNote() {
  const a = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  return h('p', { class: 'disclaimer' },
    L('代码、模型和计算结果 © 2026 ', 'Code, model and results © 2026 ', 'Code, Modell und Ergebnisse © 2026 '),
    a(HOME_URL, 'Xia Chen'),
    L('（慕尼黑工业大学 ', ' (Postdoctoral Fellow, ', ' (Postdoc am '),
    a('https://www.mdsi.tum.de/gni/research-at-gni/', 'Georg Nemetschek Institute'),
    L(' 博士后研究员）。代码和模型按 ', ', Technical University of Munich). Code and model under ', ', Technische Universität München). Code und Modell unter '),
    a('https://polyformproject.org/licenses/noncommercial/1.0.0', 'PolyForm Noncommercial 1.0.0'),
    L(' 许可，计算结果和文字按 ', ', results and texts under ', ', Ergebnisse und Texte unter '),
    a('https://creativecommons.org/licenses/by-nc/4.0/' + L('deed.zh-hans', 'deed.en', 'deed.de'), 'CC BY-NC 4.0'),
    L(' 许可：学术和个人使用免费，须注明出处；商业用途须另行授权，请先联系 ', ': free for academic and personal use with credit; commercial use needs a licence, please write first to ', ': wissenschaftliche und private Nutzung mit Namensnennung frei; kommerzielle Nutzung nur mit Lizenz, bitte vorher an '),
    a('mailto:x.c.chen@tum.de', 'x.c.chen@tum.de'),
    L('。第三方数据按上面列出的各自许可。源代码在 ', '. Third-party data keep the licences listed above. Source code on ', ' schreiben. Für Daten Dritter gelten die oben genannten Lizenzen. Quellcode auf '),
    a(REPO_URL, 'GitHub'), L('。', '.', '.'));
}
// the author's homepage and the public repository, also linked at the top right (user, 2026-11-18)
const HOME_URL = 'https://chenxiachan.github.io/';
const REPO_URL = 'https://github.com/chenxiachan/open-energy-map';
// Small print under the sources and at the bottom of the building panel (user, 2026-11-17)
function disclaimer() {
  return L('数据来自公开数据源和已发表的文献。模型已用公开统计和实测数据校准和核对，结果仍可能有偏差。项目仍在开发中，结果仅供参考，不能替代能源证书或现场评估。',
    'Data come from open data sources and published literature. The model has been calibrated and checked against public statistics and measurements, but results may still deviate. This is work in progress: results are for reference only and do not replace an energy performance certificate or an on-site assessment.',
    'Die Daten stammen aus offenen Datenquellen und veröffentlichter Literatur. Das Modell wurde an öffentlichen Statistiken und Messwerten kalibriert und geprüft, die Ergebnisse können dennoch abweichen. Das Projekt ist in Arbeit: Die Ergebnisse dienen nur zur Orientierung und ersetzen weder einen Energieausweis noch eine Begehung vor Ort.');
}
// The LoD2 source: the open-data page of the Bavarian surveying agency (no per-building viewer link)
const LOD2_URL = 'https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2';
const lod2Link = (L2, text) => h('a', { href: LOD2_URL, target: '_blank', rel: 'noopener',
  title: L(`高度、屋顶和层数来自巴伐利亚测绘局的 LoD2 建筑模型（${L2.lod2}，CC BY 4.0）`, `Height, roof and storeys from the LoD2 building model of the Bavarian surveying agency (${L2.lod2}, CC BY 4.0)`, `Höhe, Dach und Geschosse aus dem LoD2-Gebäudemodell der Bayerischen Vermessungsverwaltung (${L2.lod2}, CC BY 4.0)`) }, text);

function meta_label(k) { return PARAM_META[k]?.label || k; }
function ageLabels() { return S.A.ageClasses.map((c) => (c.from == null ? `≤ ${c.to}` : c.to == null ? L(`${c.from} 起`, `≥ ${c.from}`, `ab ${c.from}`) : `${c.from} –${String(c.to).slice(2)}`)); }

// ---------- balance ----------
// ---------- calculation chains ----------
// A chain is arithmetic a reader can redo: each step shows a value, and a step that is a model input carries its source
// chip and opens that parameter (with its references) in the parameter table.
const cop = (t) => h('span', { class: 'op', 'aria-hidden': 'true' }, t);
function cstep(label, value, o = {}) {
  const go = o.param ? ['params', `#pr-${o.param}`, o.param] : o.go;
  const chip = o.chip !== undefined ? o.chip : o.param && S.model.params[o.param] ? h('span', { class: `src ${S.model.params[o.param].source}` }, SOURCE_CN[S.model.params[o.param].source]) : null;
  return h(go ? 'button' : 'div', { type: go ? 'button' : null, class: `step${o.total ? ' total' : ''}`, title: o.title || null, onclick: go ? () => goto(...go) : null },
    h('span', { class: 'sl' }, label), h('span', { class: 'sv' }, value), o.sub ? h('span', { class: 'ss' }, o.sub) : null, chip);
}
const pv = (k, d = 2) => fmt(S.model.params[k].value, d);
const chainRow = (title, steps, id) => h('div', { class: 'calc-row', id: id || null }, title ? h('span', { class: 'calc-t' }, title) : null, h('div', { class: 'chain' }, ...steps));
const degreeHours = () => { const b = S.res.balance; return b.meanDT * b.heatingHours; };
const dTstep = () => { const b = S.res.balance; return cstep(L('累计温差 ΣΔT', 'Degree-hours ΣΔT', 'Gradstunden ΣΔT'), `${fmt(degreeHours())} K·h`, { sub: `${fmt(b.meanDT, 1)} K × ${fmt(b.heatingHours)} h`, param: 'T_heat',
  title: L('供暖日（日均气温 < 15 °C）逐小时的（设定温度 − 室外温度）之和，含夜间降温。点开看设定温度的出处', 'Sum over the hours of heating days (daily mean below 15 °C) of (set point − outdoor temperature), including set-back. Opens the set point and its source', 'Summe über die Stunden der Heiztage (Tagesmittel unter 15 °C) von (Solltemperatur − Außentemperatur), einschließlich Nachtabsenkung. Öffnet die Solltemperatur und ihre Quelle') }); };
const areaStep = (label, a, sub) => cstep(label, `${fmt(a)} m²`, { sub, go: ['params', '#pp-geom'], chip: h('span', { class: 'src geometry' }, SOURCE_CN.geometry) });

// How the headline numbers follow from each other: demand ÷ efficiency + hot water = final energy; × CO₂ factor = CO₂.
function chainCard() {
  const m = S.model, fe = S.fe, p = m.params, F = factors();
  const car = F.carriers[fe.carrier] || {}, base = S.factorBase[fe.carrier] || car;
  const div = fe.heat > 0 ? S.res.annual.heat / fe.heat : 1;
  const user = S.factorOv[fe.carrier]?.co2 != null;
  return h('div', { class: 'card', id: 'bal-chain' },
    head(L('从需求到终端能源和 CO₂', 'From demand to final energy and CO₂', 'Vom Bedarf zu Endenergie und CO₂'), L('上方卡片的数就是这样算出来的。每一步都可以点：输入参数会打开它在参数表里的那一行和出处，可以改。', 'This is how the numbers in the cards above follow from each other. Every input step opens its row in the parameter table, with its references, where you can change it.', 'So ergeben sich die Zahlen in den Karten oben auseinander. Jeder Eingabeschritt öffnet seine Zeile in der Parametertabelle mit den Quellen; dort können Sie den Wert ändern.')),
    chainRow(null, [
      cstep(L('供暖需求', 'Heating demand', 'Heizwärmebedarf'), fmtK(S.res.annual.heat), { go: ['balance', '#bal-loss'], title: L('有用能，见下方热损失', 'Useful energy; see the heat losses below', 'Nutzenergie; siehe die Wärmeverluste unten') }),
      cop('÷'),
      cstep(fe.seasonalCop ? L('季节 COP × 系统效率', 'Seasonal COP × system efficiency', 'Jahresarbeitszahl × Systemwirkungsgrad') : L('系统效率 η', 'System efficiency η', 'Systemwirkungsgrad η'), fmt(div, 2), { sub: fe.systemLabel, param: 'eta_sys' }),
      cop('+'),
      cstep(L('生活热水', 'Hot water', 'Warmwasser'), fmtK(fe.dhw), { param: 'dhw', title: L(`有用能 ${fmtK(fe.useDhw)}，换算为终端能源`, `Useful energy ${fmtK(fe.useDhw)}, converted to final energy`, `Nutzenergie ${fmtK(fe.useDhw)}, in Endenergie umgerechnet`) }),
      cop('='),
      cstep(L('终端能源', 'Final energy', 'Endenergie'), fmtK(fe.total), { sub: `${fmt(fe.perM2)} kWh/(m²·a)`, total: true }),
    ], 'chain-fin'),
    chainRow(null, [
      cstep(L('终端能源', 'Final energy', 'Endenergie'), fmtK(fe.total)),
      cop('×'),
      cstep(L('CO₂ 系数', 'CO₂ factor', 'CO₂-Faktor'), `${fmt(car.co2)} g/kWh`, { sub: car.label, go: ['params', '#pr-co2', 'co2'],
        chip: h('span', { class: `src ${user ? 'user' : base.estimated ? 'default' : 'archetype'}` }, user ? SOURCE_CN.user : String(base.src || '').split(/[ （(]/)[0]), title: base.src }),
      cop('='),
      cstep('CO₂', `${fmt(fe.co2 / 1000, 1)} t/a`, { sub: `${fmt(fe.co2 / m.areas.netFloor, 1)} kg/(m²·a)`, total: true }),
    ], 'chain-co2'));
}

// Each heat loss is H × ΣΔT, and H is a U-value times an area (or an air flow). Exactly as in rc5.js.
function lossCalc(key) {
  const m = S.model, b = S.res.balance, cx = S.ctx, H = S.res.H, LS = b.losses;
  const Hs = (v) => cstep('H', `${fmt(v)} W/K`);
  const out = (v) => cstep(L('损失', 'Loss', 'Verlust'), fmtK(v), { total: true });
  const tail = (Hv, v) => [cop('='), Hs(Hv), cop('×'), dTstep(), cop('='), out(v)];
  switch (key) {
    case 'wall': return [cstep(L('外墙 U', 'Wall U', 'Außenwand U-Wert'), pv('U_wall'), { param: 'U_wall' }), cop('×'), areaStep(L('不透明外墙', 'Opaque wall', 'Opake Außenwand'), cx.Aop), ...tail(H.wall, LS.wall)];
    case 'window': return [cstep(L('外窗 U', 'Window U', 'Fenster U-Wert'), pv('U_window'), { param: 'U_window' }), cop('×'), areaStep(L('窗', 'Windows', 'Fenster'), cx.Awin, L('外露立面 × 窗墙比', 'exposed facade × WWR', 'freiliegende Fassade × Fensterflächenanteil')), ...tail(H.window, LS.window)];
    case 'roof': return [cstep(L('温度修正 F', 'Correction F', 'Korrekturfaktor F'), pv('F_roof'), { param: 'F_roof' }), cop('×'), cstep(L('屋顶 U', 'Roof U', 'Dach U-Wert'), pv('U_roof'), { param: 'U_roof' }), cop('×'), areaStep(L('屋顶', 'Roof', 'Dach'), cx.Aroof), ...tail(H.roof, LS.roof)];
    case 'floor': return [cstep(L('温度修正 F', 'Correction F', 'Korrekturfaktor F'), pv('F_floor'), { param: 'F_floor' }), cop('×'), cstep(L('地面 U', 'Floor U', 'Boden U-Wert'), pv('U_floor'), { param: 'U_floor' }), cop('×'), areaStep(L('地面', 'Ground floor', 'Bodenplatte'), cx.Afloor), ...tail(H.floor, LS.floor)];
    case 'tb': return [cstep(L('热桥附加 ΔU', 'Thermal bridge ΔU', 'Wärmebrücken ΔU'), pv('dU_tb'), { param: 'dU_tb' }), cop('×'), areaStep(L('外围护总面积', 'Envelope area', 'Hüllfläche'), cx.Aenv), ...tail(H.tb, LS.tb)];
    case 'infiltration': return [cstep(L('空气热容', 'Air heat capacity', 'Wärmekapazität der Luft'), '0.34', { sub: 'Wh/(m³K)' }), cop('×'), cstep(L('渗透换算', 'Infiltration share', 'Infiltrationsanteil'), '0.07', { sub: 'n_inf = 0.07 × n50', title: L('DIN V 18599-2 的 e 系数做法', 'The e-factor approach of DIN V 18599-2', 'Ansatz mit e-Faktor nach DIN V 18599-2') }), cop('×'), cstep('n50', pv('n50', 1), { param: 'n50' }), cop('×'), cstep(L('空气体积', 'Air volume', 'Luftvolumen'), `${fmt(cx.Vair)} m³`, { sub: '0.8 × V_e', go: ['params', '#pp-geom'] }), ...tail(H.inf, LS.infiltration)];
    case 'ventilation': {
      const Hv = (LS.ventilation * 1000) / Math.max(1, degreeHours());
      if (RES.includes(m.usage)) return [cstep(L('空气热容', 'Air heat capacity', 'Wärmekapazität der Luft'), '0.34', { sub: 'Wh/(m³K)' }), cop('×'), cstep(L('换气次数', 'Air change rate', 'Luftwechselrate'), pv('n_vent'), { param: 'n_vent' }), cop('×'), cstep('1 − η_WRG', fmt(1 - (m.params.hr_eff?.value || 0), 2), { param: m.params.hr_eff ? 'hr_eff' : null }), cop('×'), cstep(L('空气体积', 'Air volume', 'Luftvolumen'), `${fmt(cx.Vair)} m³`, { sub: '0.8 × V_e', go: ['params', '#pp-geom'] }), ...tail(Hv, LS.ventilation)];
      return [cstep(L('平均 H（使用时段与非使用时段加权）', 'Mean H (occupied and unoccupied hours)', 'Mittleres H (Nutzungs- und Nichtnutzungszeiten)'), `${fmt(Hv)} W/K`, { param: 'n_vent' }), cop('×'), dTstep(), cop('='), out(LS.ventilation)];
    }
    default: return [];
  }
}

// Gains: what they are, and the share that actually offsets losses (utilisation η, as in the monthly method).
function gainCalc(key) {
  const m = S.model, b = S.res.balance, G = b.gains, eta = b.utilisation, A_N = m.areas.netFloor;
  const gEff = m.params.g_window.value * (1 - m.params.frameFrac.value) * 0.9;
  const util = cstep(L('利用率 η', 'Utilisation η', 'Ausnutzungsgrad η'), fmt(eta, 2), { title: L('η =（损失合计 − 同期供暖）÷ 得热合计', 'η = (total losses − heating in the same period) ÷ total gains', 'η = (Summe der Verluste − Heizung im selben Zeitraum) ÷ Summe der Gewinne') });
  const used = (v) => cstep(L('计入', 'Counted', 'Angerechnet'), fmtK(v), { total: true });
  const Ltot = Object.values(b.losses).reduce((a, v) => a + v, 0), Gtot = G.solar + G.internal + (G.opaque || 0);
  switch (key) {
    case 'solar': return [cstep('g', pv('g_window'), { param: 'g_window' }), cop('×'), cstep('1 − F_F', fmt(1 - m.params.frameFrac.value, 2), { param: 'frameFrac' }), cop('×'), cstep('F_W', '0.9', { title: L('ISO 13790：非垂直入射修正', 'ISO 13790 correction for non-normal incidence', 'ISO 13790: Korrektur für nicht senkrechten Einfall') }), cop('×'),
      cstep(L('窗面辐照 × 面积', 'Window irradiation × area', 'Einstrahlung auf Fenster × Fläche'), fmtK(G.solar / Math.max(1e-9, gEff)), { sub: L('供暖日，含遮挡与活动遮阳', 'heating days, with shading', 'Heiztage, mit Verschattung'), go: ['balance', '#bal-facades'] }), cop('='), cstep(L('太阳得热', 'Solar gains', 'Solare Gewinne'), fmtK(G.solar)), cop('×'), util, cop('='), used(G.solar * eta)];
    case 'internal': {
      const hrs = (G.internal * 1000) / Math.max(1e-9, m.params.Q_int.value * A_N);
      return [cstep(L('内部得热', 'Internal gains', 'Interne Wärmegewinne'), `${pv('Q_int', 1)} W/m²`, { param: 'Q_int' }), cop('×'), areaStep('A_N', A_N), cop('×'), cstep(L('小时', 'Hours', 'Stunden'), `${fmt(hrs)} h`, { sub: RES.includes(m.usage) ? L('供暖日全部小时', 'all hours of heating days', 'alle Stunden der Heiztage') : L('按使用时段折算', 'equivalent, by occupancy', 'äquivalent, nach Nutzungszeit') }), cop('='), cstep(L('内部得热', 'Internal gains', 'Interne Wärmegewinne'), fmtK(G.internal)), cop('×'), util, cop('='), used(G.internal * eta)];
    }
    case 'opaque': return [cstep(L('不透明构件', 'Opaque elements', 'Opake Bauteile'), fmtK(G.opaque || 0), { sub: L('吸收的太阳辐射 − 天空长波辐射', 'absorbed solar − sky long-wave', 'absorbierte Solarstrahlung − langwellige Abstrahlung an den Himmel'), go: ['method', '#method-body'], title: 'ISO 13790 §11.3' }), cop('×'), util, cop('='), used((G.opaque || 0) * eta)];
    case 'heat': return [cstep(L('损失合计', 'Total losses', 'Verluste gesamt'), fmtK(Ltot), { go: ['balance', '#bal-loss'] }), cop('−'), cstep(L('计入的得热', 'Counted gains', 'Angerechnete Gewinne'), fmtK(Gtot * eta), { sub: `η ${fmt(eta, 2)} × ${fmtK(Gtot)}` }), cop('='), cstep(L('供暖（同期）', 'Heating (same period)', 'Heizwärme (gleicher Zeitraum)'), fmtK(b.heatInPeriod), { total: true, sub: L('5R1C 逐时结果', 'from the hourly 5R1C run', 'aus der stündlichen 5R1C-Rechnung') })];
    default: return [];
  }
}

// One facade, from geometry to losses and gains.
function facadeCalc(f, i) {
  const m = S.model, fl = S.res.facadeLoss[f.id];
  const gross = f.length * m.height, party = Math.max(0, gross - f.exposedArea), aop = Math.max(0, f.exposedArea - f.windowArea);
  const gEff = m.params.g_window.value * (1 - m.params.frameFrac.value) * 0.9, wk = `WWR_${f.orient}`;
  const irr = S.irr.facade[i].reduce((a, v) => a + v, 0) / 1000;
  return h('div', { class: 'calc' },
    chainRow(L('外露立面', 'Exposed facade', 'Freiliegende Fassade'), [cstep(L('长度', 'Length', 'Länge'), `${fmt(f.length, 1)} m`, { chip: h('span', { class: 'src osm' }, 'OSM') }), cop('×'), cstep(L('檐口高度', 'Eaves height', 'Traufhöhe'), `${fmt(m.height, 1)} m`, { go: ['params', '#pp-geom'], title: m.geomSrc.height }), cop('−'), cstep(L('与邻楼共用', 'Shared with neighbours', 'Mit Nachbargebäuden geteilt'), `${fmt(party)} m²`, { sub: L('绝热，不计损失', 'adiabatic, no loss', 'adiabat, kein Verlust') }), cop('='), cstep(L('外露立面', 'Exposed facade', 'Freiliegende Fassade'), `${fmt(f.exposedArea)} m²`, { total: true })]),
    chainRow(L('窗', 'Windows', 'Fenster'), [cstep(L('外露立面', 'Exposed facade', 'Freiliegende Fassade'), `${fmt(f.exposedArea)} m²`), cop('×'), cstep(L('窗墙比', 'WWR', 'Fensterflächenanteil'), pv(wk), { param: wk }), cop('='), cstep(L('窗', 'Windows', 'Fenster'), `${fmt(f.windowArea)} m²`, { total: true })]),
    chainRow(L('墙损失', 'Wall loss', 'Wandverlust'), [cstep('U + ΔU_tb', fmt(m.params.U_wall.value + m.params.dU_tb.value, 2), { param: 'U_wall', sub: `${pv('U_wall')} + ${pv('dU_tb')}` }), cop('×'), cstep(L('外墙', 'Wall', 'Außenwand'), `${fmt(aop)} m²`), cop('×'), dTstep(), cop('='), cstep(L('墙损失', 'Wall loss', 'Wandverlust'), fmtK(fl.wall), { total: true })]),
    chainRow(L('窗损失', 'Window loss', 'Fensterverlust'), [cstep(L('外窗 U', 'Window U', 'Fenster U-Wert'), pv('U_window'), { param: 'U_window' }), cop('×'), cstep(L('窗', 'Windows', 'Fenster'), `${fmt(f.windowArea)} m²`), cop('×'), dTstep(), cop('='), cstep(L('窗损失', 'Window loss', 'Fensterverlust'), fmtK(fl.window), { total: true })]),
    chainRow(L('太阳得热', 'Solar gain', 'Solarer Gewinn'), [cstep('g × (1 − F_F) × 0.9', fmt(gEff, 3), { param: 'g_window' }), cop('×'), cstep(L('窗面辐照 × 面积', 'Irradiation × area', 'Einstrahlung × Fläche'), fmtK(fl.solar / Math.max(1e-9, gEff)), { sub: L(`供暖日，含遮挡；全年 ${fmt(irr)} kWh/m²，天空可视比 ${fmt(S.shading.svf[i] * 100)}%`, `heating days, shaded; annual ${fmt(irr)} kWh/m², sky view ${fmt(S.shading.svf[i] * 100)}%`, `Heiztage, mit Verschattung; jährlich ${fmt(irr)} kWh/m², Himmelssichtfaktor ${fmt(S.shading.svf[i] * 100)}%`), go: ['method', '#method-body'], title: L('遮挡和辐照模型见方法第 2 节', 'Shading and irradiation model: Method, section 2', 'Verschattungs- und Einstrahlungsmodell: Methode, Abschnitt 2') }), cop('='), cstep(L('太阳得热', 'Solar gain', 'Solarer Gewinn'), fmtK(fl.solar), { total: true })]));
}

// When the hourly peak happens and what the weather was doing then.
function peakCard() {
  const q = S.res.hourly && S.res.hourly.Q_hc;
  const A_N = S.model.areas.netFloor;
  let i = 0;
  if (q) for (let k = 1; k < q.length; k++) if (q[k] > q[i]) i = k;
  const d = new Date(Date.UTC(2023, 0, 1) + (i + 1) * 3600e3);   // hour of year, UTC → CET
  const when = L(`${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${String(d.getUTCHours()).padStart(2, '0')}:00`, `${d.getUTCDate()} ${C.MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:00`, `${d.getUTCDate()}. ${C.MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:00`);
  return h('div', { class: 'card', id: 'bal-peak' },
    head(L('峰值负荷', 'Peak load', 'Spitzenlast'), L('逐时 5R1C 结果里的最大供暖功率（理想负荷，不考虑设备容量）。自检的合理范围是 8–160 W/m²。', 'The largest hourly heating power from the 5R1C run (ideal loads, no equipment limit). The self-check accepts 8–160 W/m².', 'Größte stündliche Heizleistung aus der 5R1C-Rechnung (ideale Last, ohne Leistungsgrenze der Anlage). Die Plausibilitätsprüfung akzeptiert 8–160 W/m².')),
    h('dl', { class: 'stats' }, ...[
      [L('峰值', 'Peak', 'Spitzenwert'), `${fmt(S.res.annual.peakHeat / 1000, 1)} kW`], [L('单位面积', 'Per area', 'Flächenbezogen'), `${fmt(S.res.annual.peakHeat / A_N)} W/m²`],
      [L('出现时刻', 'When', 'Zeitpunkt'), q ? when : '–'], [L('当时室外', 'Outdoor then', 'Außen zum Zeitpunkt'), q ? `${fmt(S.weather.T[i], 1)} °C` : '–'], [L('当时室内', 'Indoor then', 'Innen zum Zeitpunkt'), q ? `${fmt(S.res.hourly.T_air[i], 1)} °C` : '–'],
    ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))));
}

function renderBalance() {
  const m = S.model, b = S.res.balance, P = $('#p-balance');
  const LS = b.losses, G = b.gains;
  const Lsum = Object.values(LS).reduce((s, v) => s + v, 0);
  const lossItems = [['wall', L('外墙', 'External wall', 'Außenwand')], ['window', L('窗', 'Windows', 'Fenster')], ['roof', m.roof.attic === 'unheated' ? L('顶层楼板', 'Top floor ceiling', 'Oberste Geschossdecke') : L('屋顶', 'Roof', 'Dach')], ['floor', L('地面/底板', 'Ground floor / slab', 'Boden / Bodenplatte')], ['tb', L('热桥', 'Thermal bridges', 'Wärmebrücken')], ['infiltration', L('渗透', 'Infiltration', 'Infiltration')], ['ventilation', L('通风', 'Ventilation', 'Lüftung')]]
    .map(([key, label]) => ({ key, label, value: LS[key], color: 'var(--c-loss)', note: L(`占总损失 ${fmt((100 * LS[key]) / Lsum)}%`, `${fmt((100 * LS[key]) / Lsum)}% of total losses`, `${fmt((100 * LS[key]) / Lsum)}% der Gesamtverluste`) }));
  const gainItems = [['solar', L('太阳得热（窗）', 'Solar gains (windows)', 'Solare Gewinne (Fenster)'), G.solar * b.utilisation], ['internal', L('内部得热', 'Internal gains', 'Interne Wärmegewinne'), G.internal * b.utilisation], ['opaque', L('不透明构件太阳净得热', 'Opaque solar gains (net)', 'Solare Gewinne opaker Bauteile (netto)'), (G.opaque || 0) * b.utilisation], ['heat', L('供暖（同期）', 'Heating (same period)', 'Heizwärme (gleicher Zeitraum)'), b.heatInPeriod]]
    .map(([key, label, value]) => ({ key, label, value, color: key === 'heat' ? 'var(--c1)' : 'var(--c-gain)', note: key !== 'heat' ? L('已乘得热利用率', 'Multiplied by the gain utilisation factor', 'Mit dem Ausnutzungsgrad der Wärmegewinne multipliziert') : '' }));
  const tbl = h('table', { class: 't' }, h('tr', {}, ...L(['立面', '朝向', '长度 m', '外露长度', '外墙 m²', '窗 m²', '天空可视', '年辐照 kWh/m²（无遮挡）', '墙损失', '窗损失', '窗太阳得热'], ['Facade', 'Orientation', 'Length m', 'Exposed length', 'Wall m²', 'Windows m²', 'Sky view', 'Annual irradiation kWh/m² (unshaded)', 'Wall loss', 'Window loss', 'Window solar gain'], ['Fassade', 'Orientierung', 'Länge m', 'Freiliegende Länge', 'Wand m²', 'Fenster m²', 'Himmelssicht', 'Jahresstrahlung kWh/m² (unverschattet)', 'Wandverlust', 'Fensterverlust', 'Solare Fenstergewinne']).map((t) => h('th', {}, t))));
  S.irrOpen = S.irrOpen || facadeIrradiance(m, S.weather, null);
  m.facades.forEach((f, i) => {
    const fl = S.res.facadeLoss[f.id];
    const irr = S.irr.facade[i].reduce((s, v) => s + v, 0) / 1000, irr0 = S.irrOpen.facade[i].reduce((s, v) => s + v, 0) / 1000;
    const detail = h('tr', { class: 'refrow', hidden: true }, h('td', { colspan: 11 }, f.exposedArea > 0 ? facadeCalc(f, i) : h('div', { class: 'note' }, L('整面与邻楼共用，没有外露部分', 'Fully shared with neighbours; nothing is exposed', 'Vollständig mit Nachbargebäuden geteilt; keine freiliegende Fläche'))));
    const tr = h('tr', { class: 'expand', tabindex: 0, 'aria-expanded': 'false', onclick: () => { S.viewer?.highlight(f.id); detail.hidden = !detail.hidden; tr.setAttribute('aria-expanded', String(!detail.hidden)); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); } } },
      h('td', {}, f.id), h('td', {}, `${DIR[f.orient]} ${fmt(f.azimuth)}°`), h('td', { class: 'num' }, fmt(f.length, 1)),
      h('td', { class: 'num' }, f.exposed < 1 ? `${fmt(f.exposed * 100)}%` : L('全部', 'all', 'vollständig')), h('td', { class: 'num' }, fmt(f.exposedArea - f.windowArea)), h('td', { class: 'num' }, fmt(f.windowArea)),
      h('td', { class: 'num' }, f.exposedArea > 0 ? `${fmt(S.shading.svf[i] * 100)}%` : '–'), h('td', { class: 'num' }, f.exposedArea > 0 ? L(`${fmt(irr)}（${fmt(irr0)}）`, `${fmt(irr)} (${fmt(irr0)})`, `${fmt(irr)} (${fmt(irr0)})`) : '–'),
      h('td', { class: 'num' }, fmtK(fl.wall)), h('td', { class: 'num' }, fmtK(fl.window)), h('td', { class: 'num' }, fmtK(fl.solar)));
    tbl.append(tr, detail);
  });
  P.replaceChildren(
    chainCard(),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, head(L('供暖季热损失', 'Heat losses in the heating season', 'Wärmeverluste in der Heizperiode'), L(`按月度法的口径：供暖日（日均气温 < 15 °C）的 ${fmt(b.heatingHours)} 个小时里，各构件损失 = H × (设定温度 − 室外温度)，含夜间降温。点一行看这一项怎么算。`, `Defined as in the monthly method. Over the ${fmt(b.heatingHours)} hours of heating days (daily mean temperature < 15 °C), each element loses H × (set point − outdoor temperature), including night set-back. Click a row to see how it is computed.`, `Abgegrenzt wie im Monatsbilanzverfahren: In den ${fmt(b.heatingHours)} Stunden der Heiztage (Tagesmitteltemperatur < 15 °C) verliert jedes Bauteil H × (Solltemperatur − Außentemperatur), einschließlich Nachtabsenkung. Klicken Sie auf eine Zeile, um die Berechnung zu sehen.`)), h('div', { id: 'bal-loss' }), h('div', { class: 'calc', id: 'bal-loss-calc' })),
      h('div', { class: 'card' }, head(L('损失由什么补上', 'What covers the losses', 'Wodurch die Verluste gedeckt werden'), L(`得热利用率 ${fmt(b.utilisation, 2)}：太阳和内部得热里有这一比例真正抵掉了损失，其余在过热时段被浪费或储存。点一行看这一项怎么算。`, `Gain utilisation factor ${fmt(b.utilisation, 2)}. This share of the solar and internal gains actually offsets losses. The rest is wasted or stored during overheated periods. Click a row to see how it is computed.`, `Ausnutzungsgrad der Wärmegewinne ${fmt(b.utilisation, 2)}. Dieser Anteil der solaren und internen Gewinne gleicht tatsächlich Verluste aus. Der Rest geht in Phasen der Überhitzung verloren oder wird gespeichert. Klicken Sie auf eine Zeile, um die Berechnung zu sehen.`)), h('div', { id: 'bal-gain' }), h('div', { class: 'calc', id: 'bal-gain-calc' }))),
    peakCard(),
    h('div', { class: 'card', id: 'bal-facades' }, head(L('逐立面', 'By facade', 'Nach Fassade'), L('点一行展开这面墙的算式，3D 视图里也会高亮它。共用墙只在高出邻楼的部分计入外露面积。', 'Click a row to expand the calculation for that facade; it is also highlighted in the 3D view. A party wall counts as exposed area only where it rises above the neighbour.', 'Klicken Sie auf eine Zeile, um die Berechnung für diese Fassade aufzuklappen; sie wird auch in der 3D-Ansicht hervorgehoben. Eine Gebäudetrennwand zählt nur dort als freiliegende Fläche, wo sie über das Nachbargebäude hinausragt.')), h('div', { style: 'overflow:auto' }, tbl)),
  );
  const big = Math.max(...lossItems.map((i) => i.value)) >= 10000;
  const vf = (it) => (big ? `${fmt(it.value / 1000, 1)} MWh` : `${fmt(it.value)} kWh`);
  const pickLoss = (sel) => { C.hbars($('#bal-loss'), lossItems, { valueFmt: vf, selected: sel, onPick: (it, i) => pickLoss(i) }); $('#bal-loss-calc').replaceChildren(chainRow(lossItems[sel].label, lossCalc(lossItems[sel].key))); };
  const pickGain = (sel) => { C.hbars($('#bal-gain'), gainItems, { valueFmt: vf, selected: sel, onPick: (it, i) => pickGain(i) }); $('#bal-gain-calc').replaceChildren(chainRow(gainItems[sel].label, gainCalc(gainItems[sel].key))); };
  pickLoss(lossItems.reduce((bi, it, i, a) => (it.value > a[bi].value ? i : bi), 0));
  pickGain(0);
}

// ---------- calibration ----------
const CARRIERS = [
  ['gas', L('天然气（燃气账单）', 'Natural gas (gas bill)', 'Erdgas (Gasabrechnung)'), ['gas_old', 'gas_cond']], ['district', L('区域供热（SWM 等）', 'District heating (SWM etc.)', 'Fernwärme (SWM u. a.)'), ['district']], ['oil', L('燃油', 'Heating oil', 'Heizöl'), ['oil']],
  ['hp', L('热泵用电', 'Heat pump electricity', 'Wärmepumpenstrom'), ['hp_air', 'hp_ground']], ['wood', L('木屑颗粒', 'Wood pellets', 'Holzpellets'), ['pellet']],
];
function renderCalibForm() {
  const P = $('#p-calib');
  if (P.dataset.bid === S.model.id && $('#cy')) { if (S.calib) renderCalibResult(); return; }   // keep what the user typed
  P.dataset.bid = S.model.id;
  const years = Object.keys(S.weatherIndex.years);
  const sys = S.model.params.system.value;
  const curCarrier = (CARRIERS.find((c) => c[2].includes(sys)) || CARRIERS[0])[0];
  const monthInputs = C.MONTHS.map((t, i) => h('label', {}, t, h('input', { type: 'number', min: 0, step: 'any', id: `mm${i}` })));
  P.replaceChildren(
    h('div', { class: 'card' },
      head(L('输入实测用能', 'Enter measured consumption', 'Gemessenen Verbrauch eingeben'), L('账单给的是终端能源（燃气 kWh、区域供热 kWh、热泵电量）。页面用同一年的 ERA5 实际气象重算，把账单和模型之间的差距分配到年代、各构件是否改造过、构件 U 值和使用行为上。', 'Bills give final energy (gas kWh, district heating kWh, heat pump electricity). The page recomputes with the actual ERA5 weather of the same year. It then attributes the gap between bill and model to the construction age, the retrofit state of each element, the element U-values and occupant behaviour.', 'Abrechnungen geben Endenergie an (Gas-kWh, Fernwärme-kWh, Wärmepumpenstrom). Die Seite rechnet mit dem tatsächlichen ERA5-Wetter desselben Jahres neu. Anschließend wird die Abweichung zwischen Abrechnung und Modell auf die Baualtersklasse, den Sanierungsstand der einzelnen Bauteile, die Bauteil-U-Werte und das Nutzerverhalten verteilt.')),
      h('div', { class: 'form' },
        h('label', {}, L('账单年份', 'Bill year', 'Abrechnungsjahr')), h('select', { id: 'cy' }, ...years.slice().reverse().map((y) => h('option', { value: y }, y)), h('option', { value: 'tmy' }, L('不确定（用典型年）', 'Not sure (use the TMY)', 'Unsicher (TMY verwenden)'))),
        h('label', {}, L('能源类型', 'Energy carrier', 'Energieträger')), h('select', { id: 'cc' }, ...CARRIERS.map(([k, t]) => h('option', { value: k, selected: k === curCarrier }, t))),
        h('label', {}, L('系统', 'System', 'Heizsystem')), h('select', { id: 'cs' }),
        h('label', {}, L('账单含生活热水', 'Bill includes hot water', 'Abrechnung enthält Warmwasser')), h('label', { title: L('集中供热水时通常包含', 'Usually included with central hot water', 'Bei zentraler Warmwasserbereitung meist enthalten') }, h('input', { type: 'checkbox', id: 'cdhw', checked: true }), L(' 是', ' Yes', ' Ja')),
        h('label', {}, L('输入方式', 'Input', 'Eingabe')), h('div', { class: 'row' }, h('label', {}, h('input', { type: 'radio', name: 'ck', value: 'annual', checked: true }), L(' 年度总量', ' Annual total', ' Jahressumme')), h('label', {}, h('input', { type: 'radio', name: 'ck', value: 'monthly' }), L(' 逐月', ' Monthly', ' Monatlich'))),
        h('label', { id: 'lab-annual' }, L('年度用能 kWh', 'Annual consumption kWh', 'Jahresverbrauch kWh')), h('input', { type: 'number', id: 'ca', min: 0, step: 'any', placeholder: L('例如 210000', 'e.g. 210000', 'z. B. 210000') }),
      ),
      h('div', { class: 'months', id: 'cmonths', hidden: true, style: 'margin-top:10px' }, ...monthInputs),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary', id: 'crun', onclick: runCalib }, L('开始标定', 'Run calibration', 'Kalibrierung starten')),
        h('span', { class: 'note', id: 'cstatus' })),
      h('div', { class: 'progress' }, h('div', { id: 'cprog' })),
      h('details', { class: 'adv' }, h('summary', {}, L('高级', 'Advanced', 'Erweitert')),
        h('div', { class: 'form' },
          h('label', { title: L('相对误差，包含模型结构误差，不建议低于 10%', 'Relative error including model structure error; 10% or more is advised', 'Relativer Fehler einschließlich Modellstrukturfehler; empfohlen sind 10% oder mehr') }, L('模型 + 计量误差 %', 'Model + metering error %', 'Modell- + Messfehler %')), h('input', { type: 'number', id: 'csig', value: 15, min: 3, max: 50, step: 1, style: 'width:70px' }),
          h('label', {}, L('粒子数', 'Particles', 'Partikel')), h('select', { id: 'cn' }, h('option', { value: 500 }, L('500（快）', '500 (fast)', '500 (schnell)')), h('option', { value: 900, selected: true }, '900'), h('option', { value: 1800 }, L('1800（慢，更稳）', '1800 (slow, more stable)', '1800 (langsam, stabiler)'))),
          h('span', {}), h('div', {}, h('button', { class: 'btn', onclick: synthBill, title: L('从先验里抽一组参数当"真值"，生成带 5% 噪声的逐月账单，用来检验标定能不能找回它', 'Draws one parameter set from the prior as the "truth" and generates monthly bills with 5% noise. This tests whether the calibration can recover it.', 'Zieht einen Parametersatz aus dem Prior als „wahre Werte“ und erzeugt daraus monatliche Abrechnungen mit 5% Rauschen. So lässt sich prüfen, ob die Kalibrierung sie wiederfindet.') }, L('生成合成账单（检验用）', 'Generate a synthetic bill (for testing)', 'Synthetische Abrechnung erzeugen (zum Testen)'))))),
    ),
    h('div', { id: 'cres' }),
  );
  const fillSys = () => { const c = CARRIERS.find((x) => x[0] === $('#cc').value); $('#cs').replaceChildren(...c[2].map((k) => h('option', { value: k, selected: k === sys }, factors().systems[k].label))); };
  $('#cc').onchange = fillSys; fillSys();
  for (const r of P.querySelectorAll('input[name=ck]')) r.onchange = () => { const mo = $('input[name=ck]:checked').value === 'monthly'; $('#cmonths').hidden = !mo; $('#ca').disabled = mo; $('#ca').hidden = mo; $('#lab-annual').hidden = mo; };
  if (S.calib) renderCalibResult();
}

function synthBill() {
  const draw = makePrior(S.model, S.ageInfo, S.state, S.assigned);
  const r = rng(Math.floor(Math.random() * 1e9));
  const d = draw(r);
  const p = { ...d.p, system: $('#cs').value };
  const rr = run(S.ctx, p);
  const fe = finalEnergy(rr, p, S.ctx);
  const hr = rr.annual.heat > 0 ? fe.heat / rr.annual.heat : 0;
  const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const mon = rr.monthly.heat.map((q, m) => (q * hr + (fe.dhw * DAYS[m]) / 365) * (1 + 0.05 * r.n()));
  $('#cy').value = S.weatherKey === 'tmy' ? 'tmy' : S.weatherKey;
  $('#cdhw').checked = true;
  document.querySelector('input[name=ck][value=monthly]').checked = true;
  $('#cmonths').hidden = false; $('#ca').disabled = true; $('#ca').hidden = true; $('#lab-annual').hidden = true;
  mon.forEach((v, i) => { $(`#mm${i}`).value = Math.round(v); });
  S.truth = { p, ageClass: d.ageClass, modern: d.modern, annual: mon.reduce((s, v) => s + v, 0) };
  $('#cstatus').textContent = L(`已生成合成账单：真值年代 ${S.A.ageClasses.find((c) => c.id === d.ageClass).label}，窗${d.modern.windows ? '已' : '未'}改造，墙${d.modern.wall ? '已' : '未'}改造。标定后会把真值画在图上。`,
    `Synthetic bill generated. True age ${S.A.ageClasses.find((c) => c.id === d.ageClass).label}, windows ${d.modern.windows ? 'retrofitted' : 'original'}, wall ${d.modern.wall ? 'retrofitted' : 'original'}. After calibration the charts show the truth.`, `Synthetische Abrechnung erzeugt. Wahre Baualtersklasse ${S.A.ageClasses.find((c) => c.id === d.ageClass).label}, Fenster ${d.modern.windows ? 'saniert' : 'unsaniert'}, Außenwand ${d.modern.wall ? 'saniert' : 'unsaniert'}. Nach der Kalibrierung zeigen die Diagramme die wahren Werte.`);
}

let WORKER = null;
// The worker has no localStorage, so it gets the language through its URL (i18n.js reads ?lang= there too).
const WORKER_URL = new URL(`./calib.worker.js?lang=${LANG}`, import.meta.url);
async function runCalib() {
  const kind = $('input[name=ck]:checked').value;
  const values = kind === 'monthly' ? Array.from({ length: 12 }, (_, i) => { const v = parseFloat($(`#mm${i}`).value); return Number.isFinite(v) ? v : null; }) : [parseFloat($('#ca').value)];
  if (kind === 'annual' && !(values[0] > 0)) { $('#cstatus').textContent = L('请填写年度用能', 'Please enter the annual consumption', 'Bitte geben Sie den Jahresverbrauch ein'); return; }
  if (kind === 'monthly' && values.filter((v) => v != null).length < 6) { $('#cstatus').textContent = L('逐月至少填 6 个月', 'Enter at least 6 months', 'Mindestens 6 Monate eingeben'); return; }
  const yearKey = $('#cy').value;
  const system = $('#cs').value;
  if (S.state.system !== system) { S.state.system = system; }
  if (S.weatherKey !== yearKey) { S.weatherKey = yearKey; S.weather = await loadWeather(yearKey); S.irrOpen = null; }
  S.calibApplied = null;
  await rebuild();
  const meas = { kind, values, includesDhw: $('#cdhw').checked, system, sigmaRel: (+$('#csig').value || 15) / 100 };
  const N = +$('#cn').value;
  if (WORKER) WORKER.terminate();
  WORKER = new Worker(WORKER_URL, { type: 'module' });
  const bar = $('#cprog');
  $('#crun').disabled = true;
  const t0 = performance.now();
  const modelPlain = JSON.parse(JSON.stringify({ ...S.model, lonlatOuter: undefined, nbLonLat: undefined }));
  const weatherPlain = { ...S.weather, T: Array.from(S.weather.T), GHI: Array.from(S.weather.GHI), DNI: Array.from(S.weather.DNI), DHI: Array.from(S.weather.DHI) };
  WORKER.onmessage = (ev) => {
    const d = ev.data;
    if (d.type === 'progress') {
      bar.style.width = `${Math.round(d.phi * 90)}%`;
      $('#cstatus').textContent = L(`第 ${d.stage} 步 · 温度 φ = ${d.phi.toFixed(3)} · 有效样本 ${fmt(d.ess)}${d.acc != null ? ` · 接受率 ${fmt(d.acc * 100)}%` : ''}`,
        `Stage ${d.stage} · temperature φ = ${d.phi.toFixed(3)} · effective sample size ${fmt(d.ess)}${d.acc != null ? ` · acceptance ${fmt(d.acc * 100)}%` : ''}`, `Stufe ${d.stage} · Temperatur φ = ${d.phi.toFixed(3)} · effektive Stichprobengröße ${fmt(d.ess)}${d.acc != null ? ` · Akzeptanzrate ${fmt(d.acc * 100)}%` : ''}`);
    } else if (d.type === 'done') {
      bar.style.width = '100%';
      S.calib = d.result;
      S.calib.ms = performance.now() - t0;
      $('#crun').disabled = false;
      $('#cstatus').textContent = L(`完成：${d.result.stages} 步，${fmt(S.calib.ms / 1000, 1)} s`, `Done: ${d.result.stages} stages, ${fmt(S.calib.ms / 1000, 1)} s`, `Fertig: ${d.result.stages} Stufen, ${fmt(S.calib.ms / 1000, 1)} s`);
      $('#tabs button[data-tab=calib]').innerHTML = L('账单标定', 'Calibration', 'Kalibrierung') + '<span class="dot"></span>';
      renderCalibResult();
      renderParams();
      S.checks = runChecks(S.model, S.res, checkCtx());
      renderChecks();
      $('#opt-dev').disabled = false; $('#opt-dev').textContent = DEV_ON;
      renderHeader();
    } else if (d.type === 'error') {
      $('#crun').disabled = false;
      $('#cstatus').textContent = L('标定出错：', 'Calibration error: ', 'Fehler bei der Kalibrierung: ') + d.message.split('\n')[0];
      console.error(d.message);
    }
  };
  WORKER.onerror = (e) => { $('#crun').disabled = false; $('#cstatus').textContent = L('标定进程加载失败：', 'The calibration worker failed to load: ', 'Der Kalibrierungs-Worker konnte nicht geladen werden: ') + (e.message || e.type); console.error(e); };
  WORKER.postMessage({ model: modelPlain, weather: weatherPlain, ageInfo: S.ageInfo, state: S.state, archetypes: archetypesForWorker(), meas, N, seed: 11 });
}

function renderCalibResult() {
  const R = S.calib, P = $('#cres');
  const ids = S.A.ageClasses.map((c) => c.id);
  const T = S.truth;
  const meas = R.meas;
  const shrink = (k) => { const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }; return sd(R.params.post[k]) / (sd(R.params.prior[k]) || 1); };
  const lossKeys = [['wall', L('外墙', 'External wall', 'Außenwand')], ['window', L('窗', 'Windows', 'Fenster')], ['roof', L('屋顶/顶板', 'Roof / top ceiling', 'Dach / oberste Geschossdecke')], ['floor', L('地面/底板', 'Ground floor / slab', 'Boden / Bodenplatte')], ['tb', L('热桥', 'Thermal bridges', 'Wärmebrücken')], ['infiltration', L('渗透', 'Infiltration', 'Infiltration')], ['ventilation', L('通风', 'Ventilation', 'Lüftung')]];
  const sensLabels = L({ U_wall: '外墙 U 值 → 外墙构造核查/热像', U_window: '窗 U 值 → 看窗户年代和玻璃', U_roof: '屋顶 U 值 → 阁楼/顶板检查', U_floor: '地面 U 值 → 地下室顶板检查', n50: '气密性 → 鼓风门测试', T_heat: '室温 → 放温度记录仪两周', heatedFrac: '供暖面积 → 问住户哪些房间不开暖气', n_vent: '通风 → 问开窗习惯', Q_int: '内部得热 → 用电量', eta_sys: '锅炉效率 → 锅炉铭牌和年检记录', g_window: '玻璃 g 值 → 玻璃类型', dU_tb: '热桥 → 构造细部', ageClass: '建成年代 → 查建筑档案' },
    { U_wall: 'Wall U-value → check the wall construction or take a thermal image', U_window: 'Window U-value → check window age and glazing', U_roof: 'Roof U-value → inspect the attic or top ceiling', U_floor: 'Floor U-value → inspect the basement ceiling', n50: 'Air tightness → blower door test', T_heat: 'Room temperature → log temperatures for two weeks', heatedFrac: 'Heated area → ask the occupants which rooms stay unheated', n_vent: 'Ventilation → ask about window opening habits', Q_int: 'Internal gains → electricity use', eta_sys: 'Boiler efficiency → boiler rating plate and service records', g_window: 'Glazing g-value → glazing type', dU_tb: 'Thermal bridges → construction details', ageClass: 'Construction age → building records' }, { U_wall: 'Außenwand U-Wert → Wandaufbau prüfen oder Wärmebild aufnehmen', U_window: 'Fenster U-Wert → Fensteralter und Verglasung prüfen', U_roof: 'Dach U-Wert → Dachboden oder oberste Geschossdecke begutachten', U_floor: 'Boden U-Wert → Kellerdecke begutachten', n50: 'Luftdichtheit → Blower-Door-Test', T_heat: 'Raumtemperatur → zwei Wochen lang Temperaturen aufzeichnen', heatedFrac: 'Beheizte Fläche → Bewohner fragen, welche Räume unbeheizt bleiben', n_vent: 'Lüftung → nach dem Fensterlüftungsverhalten fragen', Q_int: 'Interne Wärmegewinne → Stromverbrauch', eta_sys: 'Kesselwirkungsgrad → Typenschild und Wartungsprotokolle des Kessels', g_window: 'g-Wert der Verglasung → Verglasungsart', dU_tb: 'Wärmebrücken → Konstruktionsdetails', ageClass: 'Baualtersklasse → Bauakten' });
  const sensItems = Object.entries(R.sens).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => ({ label: (sensLabels[k] || k).split(' → ')[0], value: v * 100, color: 'var(--c2)', note: sensLabels[k] }));
  const apply = () => {
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    S.calibApplied = Object.fromEntries(UNCERTAIN.map((k) => [k, +med(R.params.post[k]).toPrecision(4)]));
    rebuild();
  };
  P.replaceChildren(
    h('div', { class: 'card' }, head(L('账单 vs 模型', 'Bill vs model', 'Abrechnung vs. Modell'), L('圆点是账单，竖线是先验（灰）与后验（青）的 10–90% 预测区间。', 'Dots are the bills. Whiskers show the 10–90% predictive ranges of the prior (grey) and the posterior (teal).', 'Punkte sind die Abrechnungen. Die senkrechten Linien zeigen die 10–90%-Vorhersagebereiche von Prior (grau) und Posterior (türkis).')),
      h('dl', { class: 'stats' }, ...[[L('账单', 'Bill', 'Abrechnung'), fmtK(meas.values.reduce((s, v) => s + (v || 0), 0))], [L('先验中位', 'Prior median', 'Prior-Median'), fmtK(R.prior.annual[1])], [L('后验中位', 'Posterior median', 'Posterior-Median'), fmtK(R.post.annual[1])], [L('后验 P10–P90', 'Posterior P10–P90', 'Posterior P10–P90'), `${fmtK(R.post.annual[0])}–${fmtK(R.post.annual[2])}`]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { id: 'cr-month' })),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, head(L('建成年代：先验 → 后验', 'Construction age: prior → posterior', 'Baualtersklasse: Prior → Posterior'), L('账单同时约束了年代。只有年度总量时，年代、构件状态和使用行为常常分不开。', 'The bills also constrain the age. With an annual total only, age, element state and behaviour often cannot be told apart.', 'Die Abrechnungen schränken auch die Baualtersklasse ein. Mit nur einer Jahressumme lassen sich Baualter, Bauteilzustand und Nutzerverhalten oft nicht auseinanderhalten.'), T ? L(`合成真值 ${S.A.ageClasses.find((c) => c.id === T.ageClass).label}`, `Synthetic truth ${S.A.ageClasses.find((c) => c.id === T.ageClass).label}`, `Wahrer Wert (synthetisch) ${S.A.ageClasses.find((c) => c.id === T.ageClass).label}`) : null), h('div', { id: 'cr-age' })),
      h('div', { class: 'card' }, head(L('构件是否改造过', 'Have the elements been retrofitted?', 'Wurden die Bauteile saniert?'), L('后验概率接近先验，说明账单没有提供这方面的信息。', 'A posterior close to the prior means the bills carry no information on this.', 'Liegt der Posterior nahe am Prior, enthalten die Abrechnungen dazu keine Information.')), h('div', { id: 'cr-mod' }))),
    h('div', { class: 'card' }, head(L('偏差归到哪个构件', 'Which element explains the mismatch', 'Welches Bauteil die Abweichung erklärt'), L('每个构件供暖季热损失的先验中位数（灰）与后验中位数（青）。变化大的构件就是账单"指认"的偏差来源。', 'Prior median (grey) and posterior median (teal) of the heat loss of each element in the heating season. The elements that change most are the ones the bills point to.', 'Prior-Median (grau) und Posterior-Median (türkis) des Wärmeverlusts jedes Bauteils in der Heizperiode. Die Bauteile, die sich am stärksten ändern, sind diejenigen, auf die die Abrechnungen hinweisen.')), h('div', { id: 'cr-loss' })),
    h('div', { class: 'card' }, head(L('参数后验', 'Parameter posteriors', 'Posterior-Verteilungen der Parameter'), L('灰 = 先验，青 = 后验。"收缩"是后验标准差 ÷ 先验标准差，越小说明账单越能确定它；接近 1 就是没学到。', 'Grey = prior, teal = posterior. "Shrinkage" is the posterior standard deviation ÷ the prior standard deviation. The smaller it is, the better the bills pin the parameter down. Close to 1 means nothing was learnt.', 'Grau = Prior, Türkis = Posterior. „Schrumpfung“ ist die Posterior-Standardabweichung ÷ die Prior-Standardabweichung. Je kleiner sie ist, desto genauer legen die Abrechnungen den Parameter fest. Nahe 1 heißt, dass nichts gelernt wurde.') + (T ? L(' 橙色竖线是合成账单的真值。', ' The orange line marks the truth of the synthetic bill.', ' Die orange Linie markiert den wahren Wert der synthetischen Abrechnung.') : '')),
      h('div', { class: 'small-multiples', id: 'cr-params' })),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, head(L('可辨识性：后验相关', 'Identifiability: posterior correlation', 'Identifizierbarkeit: Posterior-Korrelation'), L('强负相关（蓝）表示两个参数可以互相替代来解释同一张账单，例如室温和外墙 U 值。这时只靠账单分不开，需要补测。', 'A strong negative correlation (blue) means two parameters can stand in for each other to explain the same bill, for example room temperature and wall U-value. Bills alone cannot separate them, so another measurement is needed.', 'Eine stark negative Korrelation (blau) bedeutet, dass sich zwei Parameter bei der Erklärung derselben Abrechnung gegenseitig ersetzen können, etwa Raumtemperatur und Außenwand-U-Wert. Allein mit Abrechnungen lassen sie sich nicht trennen; dafür ist eine weitere Messung nötig.')), h('div', { id: 'cr-corr', style: 'overflow:auto' })),
      h('div', { class: 'card' }, head(L('下一步测什么', 'What to measure next', 'Was als Nächstes messen'), L('对"整体改造包"节能量的方差贡献（一阶敏感度，在后验里算）。排在前面的量，测准了最能缩小改造收益的不确定。', 'Contribution to the variance of the savings of the "Deep retrofit package" (first-order sensitivity on the posterior). Measuring the top items well narrows the uncertainty of the retrofit benefit the most.', 'Beitrag zur Varianz der Einsparung des „Komplettsanierungspakets“ (Sensitivität erster Ordnung, auf dem Posterior berechnet). Wer die obersten Größen genau misst, verringert die Unsicherheit des Sanierungsnutzens am stärksten.')), h('div', { id: 'cr-sens' }))),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: apply, title: L('写回后参数来源显示为"账单标定"，3D 视图可切到"标定偏差"着色。改造标签页会用后验粒子算节能区间。', 'The parameter source then shows as "Bill-calibrated", and the 3D view can be coloured by "Calibration deviation". The Retrofit tab uses the posterior particles for the savings ranges.', 'Die Parameterquelle erscheint danach als „Kalibriert“, und die 3D-Ansicht lässt sich nach „Kalibrierabweichung“ einfärben. Der Reiter „Sanierung“ nutzt die Posterior-Partikel für die Einsparbereiche.') }, L('把后验中位数写回模型', 'Write the posterior medians to the model', 'Posterior-Mediane ins Modell übernehmen')))),
  );
  const band = (s) => s.monthly.map((x) => [x[0], x[2]]);
  if (meas.kind === 'monthly') {
    C.monthly($('#cr-month'), { series: [{ label: L('后验中位', 'Posterior median', 'Posterior-Median'), values: R.post.monthly.map((x) => x[1]), color: 'var(--h-post)' }], band: band(R.post), points: meas.values });
  } else {
    C.hbars($('#cr-month'), [
      { label: L('账单', 'Bill', 'Abrechnung'), value: meas.values[0], color: 'var(--c2)' },
      { label: L('先验预测', 'Prior prediction', 'Prior-Vorhersage'), value: R.prior.annual[1], lo: R.prior.annual[0], hi: R.prior.annual[2], color: 'var(--h-prior)' },
      { label: L('后验预测', 'Posterior prediction', 'Posterior-Vorhersage'), value: R.post.annual[1], lo: R.post.annual[0], hi: R.post.annual[2], color: 'var(--c1)' },
    ], { valueFmt: (it) => fmtK(it.value) });
  }
  C.cats($('#cr-age'), { labels: ageLabels(), a: ids.map((k) => R.prior.ages[k] || 0), b: ids.map((k) => R.post.ages[k] || 0) });
  C.hbars($('#cr-mod'), ['windows', 'wall', 'roof', 'floor'].flatMap((c) => [
    { label: `${L({ windows: '窗', wall: '外墙', roof: '屋顶/顶板', floor: '地面/底板' }, { windows: 'Windows', wall: 'External wall', roof: 'Roof / top ceiling', floor: 'Ground floor / slab' }, { windows: 'Fenster', wall: 'Außenwand', roof: 'Dach / oberste Geschossdecke', floor: 'Boden / Kellerdecke' })[c]} ${L('先验', 'prior', 'Prior')}`, value: R.prior.modern[c] * 100, color: 'var(--h-prior)' },
    { label: `${L('后验', 'Posterior', 'Posterior')}${T ? (T.modern[c] ? L('（真值：改过）', ' (truth: retrofitted)', ' (wahr: saniert)') : L('（真值：未改）', ' (truth: original)', ' (wahr: Originalzustand)')) : ''}`, value: R.post.modern[c] * 100, color: 'var(--c1)' }]), { max: 100, valueFmt: (it) => `${fmt(it.value)}%` });
  C.hbars($('#cr-loss'), lossKeys.flatMap(([k, l]) => [
    { label: `${l} ${L('先验', 'prior', 'Prior')}`, value: R.priorLoss[k][1], lo: R.priorLoss[k][0], hi: R.priorLoss[k][2], color: 'var(--h-prior)' },
    { label: L('后验', 'Posterior', 'Posterior'), value: R.postLoss[k][1], lo: R.postLoss[k][0], hi: R.postLoss[k][2], color: 'var(--c1)' }]), { valueFmt: (it) => fmtK(it.value) });
  const box = $('#cr-params');
  for (const k of UNCERTAIN) {
    const sm = h('div', { class: 'sm' });
    box.append(sm);
    const inner = h('div');
    sm.append(inner, h('div', { class: 'shr' }, `${L('收缩', 'Shrinkage', 'Schrumpfung')} ${fmt(shrink(k), 2)}${T ? ` · ${L('真值', 'truth', 'wahrer Wert')} ${fmt(T.p[k], 2)}` : ''}`));
    C.dist(inner, { prior: R.params.prior[k], post: R.params.post[k], label: PARAM_META[k].label, unit: PARAM_META[k].unit, log: k.startsWith('U_') || k === 'n50', width: 240, height: 96, mark: T ? T.p[k] : null });
  }
  C.heat($('#cr-corr'), { keys: R.corr.keys, labels: R.corr.keys.map((k) => L(PARAM_META[k].label.replace(' U 值', '').replace('/顶层楼板', '').replace('/地下室顶板', ''), PARAM_META[k].label.replace(' U-value', '').replace(' / top floor ceiling', '').replace(' / basement ceiling', ''), PARAM_META[k].label.replace(' U-Wert', '').replace(' / oberste Geschossdecke', '').replace(' / Kellerdecke', ''))), C: R.corr.C });
  C.hbars($('#cr-sens'), sensItems, { max: 100, valueFmt: (it) => `${fmt(it.value)}%` });
}

// ---------- retrofit ----------
let RETRO_RUNNING = false;
async function renderRetro() {
  const P = $('#p-retro');
  const src = S.calib ? S.calib.postRetro : S.retroPrior;
  if (!src) {
    P.replaceChildren(h('div', { class: 'card' }, head(L('改造方案', 'Retrofit options', 'Sanierungsvarianten'), L('正在用 300 个先验样本逐一模拟每个方案（含热泵逐时 COP）…', 'Simulating each option on 300 prior samples (with hourly heat pump COP)…', 'Jede Variante wird an 300 Prior-Stichproben simuliert (mit stündlichem Wärmepumpen-COP) …')), h('div', { class: 'progress' }, h('div', { style: 'width:30%' }))));
    if (RETRO_RUNNING) return;
    RETRO_RUNNING = true;
    const w = new Worker(WORKER_URL, { type: 'module' });
    const modelPlain = JSON.parse(JSON.stringify({ ...S.model, lonlatOuter: undefined, nbLonLat: undefined }));
    const weatherPlain = { ...S.weather, T: Array.from(S.weather.T), GHI: Array.from(S.weather.GHI), DNI: Array.from(S.weather.DNI), DHI: Array.from(S.weather.DHI) };
    w.onmessage = (ev) => { if (ev.data.type === 'done') { S.retroPrior = ev.data.result.priorRetro; RETRO_RUNNING = false; w.terminate(); renderRetro(); } if (ev.data.type === 'error') { RETRO_RUNNING = false; P.append(h('p', { class: 'note' }, ev.data.message)); } };
    w.onerror = (e) => { RETRO_RUNNING = false; P.append(h('p', { class: 'note', style: 'color:var(--fail)' }, L('改造计算进程加载失败：', 'The retrofit worker failed to load: ', 'Der Sanierungs-Worker konnte nicht geladen werden: ') + (e.message || e.type))); console.error(e); };
    w.postMessage({ model: modelPlain, weather: weatherPlain, ageInfo: S.ageInfo, state: S.state, archetypes: archetypesForWorker(), meas: null, N: 320, seed: 3 });
    return;
  }
  const base = S.calib ? S.calib.post.annual[1] : S.fe.total;
  const items = Object.values(src).map((s) => ({ label: s.label, value: s.dRel[1] * 100, lo: s.dRel[0] * 100, hi: s.dRel[2] * 100, color: 'var(--c-gain)', note: L(`${s.note}<br>节能 ${fmtK(s.dFinal[1])}/a（${fmtK(s.dFinal[0])}–${fmtK(s.dFinal[2])}）<br>减碳 ${fmt(s.dCo2[1] / 1000, 1)} t/a`, `${s.note}<br>Savings ${fmtK(s.dFinal[1])}/a (${fmtK(s.dFinal[0])}–${fmtK(s.dFinal[2])})<br>CO₂ reduction ${fmt(s.dCo2[1] / 1000, 1)} t/a`, `${s.note}<br>Einsparung ${fmtK(s.dFinal[1])}/a (${fmtK(s.dFinal[0])}–${fmtK(s.dFinal[2])})<br>CO₂-Minderung ${fmt(s.dCo2[1] / 1000, 1)} t/a`) }));
  const tbl = h('table', { class: 't' }, h('tr', {}, ...L(['方案', '做法', '终端能源节省（中位，10–90%）', '相对节省', 'CO₂ 减少 t/a'], ['Option', 'Measure', 'Final energy saving (median, 10–90%)', 'Relative saving', 'CO₂ reduction t/a'], ['Variante', 'Maßnahme', 'Endenergieeinsparung (Median, 10–90%)', 'Relative Einsparung', 'CO₂-Minderung t/a']).map((t) => h('th', {}, t))));
  const br = (a, lo, hi) => L(`${a}（${lo}–${hi}）`, `${a} (${lo}–${hi})`, `${a} (${lo}–${hi})`);
  for (const s of Object.values(src)) tbl.append(h('tr', {}, h('td', {}, s.label), h('td', { class: 'note' }, s.note), h('td', { class: 'num' }, br(fmtK(s.dFinal[1]), fmtK(s.dFinal[0]), fmtK(s.dFinal[2]))), h('td', { class: 'num' }, br(`${fmt(s.dRel[1] * 100)}%`, fmt(s.dRel[0] * 100), `${fmt(s.dRel[2] * 100)}%`)), h('td', { class: 'num' }, br(fmt(s.dCo2[1] / 1000, 1), fmt(s.dCo2[0] / 1000, 1), fmt(s.dCo2[2] / 1000, 1)))));
  P.replaceChildren(
    h('div', { class: 'card' }, head(S.calib ? L('改造节能（标定后）', 'Retrofit savings (after calibration)', 'Einsparung durch Sanierung (nach Kalibrierung)') : L('改造节能（先验）', 'Retrofit savings (prior)', 'Einsparung durch Sanierung (Prior)'), L(`每个方案在同一组参数样本上和现状对比，所以区间反映的是"这栋楼到底是什么状况"的不确定。现状终端能源约 ${fmtK(base)}/a。${S.calib ? '' : '输入账单标定后，区间通常会变窄，排序也可能变。'}`,
        `Each option is compared with the current state on the same parameter samples. The ranges therefore show the uncertainty about the actual state of this building. Current final energy is about ${fmtK(base)}/a.${S.calib ? '' : ' After bill calibration the ranges usually narrow, and the ranking may change.'}`, `Jede Variante wird auf denselben Parameterstichproben mit dem Ist-Zustand verglichen. Die Bereiche zeigen daher die Unsicherheit über den tatsächlichen Zustand dieses Gebäudes. Die Endenergie im Ist-Zustand beträgt etwa ${fmtK(base)}/a.${S.calib ? '' : ' Nach der Kalibrierung mit Abrechnungen werden die Bereiche meist schmaler, und die Rangfolge kann sich ändern.'}`), L(`基准 ${fmtK(base)}/a`, `Baseline ${fmtK(base)}/a`, `Basis ${fmtK(base)}/a`)),
      h('div', { id: 'rt-bars' })),
    h('div', { class: 'card' }, head(L('方案明细', 'Options in detail', 'Varianten im Detail'), L('构件限值取自 GEG 附件 7（替换构件时的最高 U 值），"整体改造包"参照 TABULA 的进阶改造水平；热泵按散热器供水温度曲线逐时算 COP。', 'Element limits come from GEG Anlage 7 (maximum U-values for replaced elements). The "Deep retrofit package" follows the TABULA advanced retrofit level. The heat pump COP is computed hourly from the radiator supply temperature curve.', 'Die Bauteilgrenzwerte stammen aus GEG Anlage 7 (Höchstwerte der U-Werte bei Erneuerung von Bauteilen). Das „Komplettsanierungspaket“ folgt dem zukunftsweisenden Modernisierungsniveau von TABULA. Der COP der Wärmepumpe wird stündlich aus der Vorlauftemperaturkurve der Heizkörper berechnet.')), tbl),
  );
  C.hbars($('#rt-bars'), items, { unit: '%', max: 100, valueFmt: (it) => `${fmt(it.value)}%` });
}


// ---------- checks ----------
function renderChecks() {
  const P = $('#p-checks');
  const st = L({ pass: '通过', warn: '提醒', fail: '不通过', info: '信息' }, { pass: 'Pass', warn: 'Warning', fail: 'Fail', info: 'Info' }, { pass: 'Bestanden', warn: 'Warnung', fail: 'Nicht bestanden', info: 'Info' });
  const n = (s) => S.checks.filter((c) => c.status === s).length;
  // Rows grouped by category; passed checks fold away so the open items lead. The judging rule sits on the check name.
  const table = (rows) => {
    const t = h('table', { class: 't' });
    let g = null;
    for (const c of rows) {
      if (c.group !== g) { g = c.group; t.append(h('tr', { class: 'grp' }, h('td', { colspan: 3 }, g))); }
      t.append(h('tr', {}, h('td', { class: 'nm', title: c.how || null }, c.go ? h('button', { type: 'button', class: 'linkish', onclick: () => goto(...c.go) }, c.title) : c.title), h('td', {}, h('span', { class: `status ${c.status}` }, st[c.status])), h('td', {}, c.detail)));
    }
    return t;
  };
  const open = S.checks.filter((c) => c.status !== 'pass'), passed = S.checks.filter((c) => c.status === 'pass');
  const counts = h('span', { class: 'counts' }, ...['fail', 'warn', 'info', 'pass'].filter((k) => n(k)).map((k) => h('span', { class: `status ${k}` }, `${st[k]} ${n(k)}`)));
  P.replaceChildren(h('div', { class: 'card' },
    head(L('自检', 'Self-checks', 'Plausibilitätsprüfung'), L('参照 EnergyRSI 的打分表思路：几何与物理合理性只能说明模型"像"，"准"要靠数据锚定那几项。悬停在检查项上可看判定规则。', 'This follows the idea of the EnergyRSI scorecard. Geometric and physical plausibility only show that the model looks right. Accuracy depends on the data anchoring items. Hover over a check for its rule.', 'Dies folgt der Idee der EnergyRSI-Scorecard. Geometrische und physikalische Plausibilität zeigen nur, dass das Modell stimmig aussieht. Die Genauigkeit hängt von den Prüfpunkten mit Datenverankerung ab. Fahren Sie mit der Maus über eine Prüfung, um ihre Regel zu sehen.'), counts),
    open.length ? h('div', { class: 'tblwrap' }, table(open)) : null,
    passed.length ? h('details', { class: 'adv' }, h('summary', {}, L(`${passed.length} 项通过`, `${passed.length} passed`, `${passed.length} bestanden`)), table(passed)) : null));
}

// ---------- export ----------
function download(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
// the format of the CityGML export and the paper its authors ask to cite (github.com/tudelft3d/Energy_ADE)
function energyAdeCredit() {
  const a = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  return [L('CityGML 导出按 ', 'The CityGML export follows the ', 'Der CityGML-Export folgt der '), a('https://github.com/tudelft3d/Energy_ADE', 'CityGML Energy ADE 3.0'),
    L('（TU Delft 与 HFT Stuttgart 开发）。引用：', ' (developed by TU Delft and HFT Stuttgart). Cite: ', ' (entwickelt von der TU Delft und der HFT Stuttgart). Zitieren: '),
    'Agugiaro, G., Padsala, R. (2026). Further development of the CityGML Energy Application Domain Extension 3.0. ISPRS Archives L-4/W2-2026, 1–8. ',
    a('https://doi.org/10.5194/isprs-archives-L-4-W2-2026-1-2026', 'doi:10.5194/isprs-archives-L-4-W2-2026-1-2026')];
}
function renderExport() {
  const P = $('#p-export'), m = S.model;
  const base = `munich_${m.id}`;
  const btn = (label, fn, note) => h('button', { class: 'btn', onclick: fn, title: note }, label);
  P.replaceChildren(h('div', { class: 'card' }, head(L('导出', 'Export', 'Export'), L('IDF 和 EPW 可以直接用 EnergyPlus 24.2 运行；文件头里列出每个参数的来源。CityGML 文件通过 CityGML 2.0 和 Energy ADE 3.0（beta 7）的 schema 校验；每项输入的区间、来源等级和出处在楼的通用属性里。', 'The IDF and EPW files run directly in EnergyPlus 24.2. The file header lists the source of every parameter. The CityGML file validates against the schemas of CityGML 2.0 and the Energy ADE 3.0 (beta 7); the range, source tier and references of every input are in the generic attributes of the building.', 'Die IDF- und EPW-Dateien laufen direkt in EnergyPlus 24.2. Der Dateikopf nennt die Quelle jedes Parameters. Die CityGML-Datei ist gegen die Schemas von CityGML 2.0 und der Energy ADE 3.0 (Beta 7) validiert; Bandbreite, Quellenstufe und Belege jeder Eingabe stehen in den generischen Attributen des Gebäudes.')),

    btn('EnergyPlus IDF', async () => { try { const { buildIDF } = await import('./idf.js'); download(`${base}.idf`, buildIDF(m, { weatherName: S.weather.name, year: S.weatherKey, weather: S.weather, profile: S.prof })); } catch (e) { $('#exerr').textContent = L('IDF 导出失败：', 'IDF export failed: ', 'IDF-Export fehlgeschlagen: ') + e.message; } }, L('逐层热区、共用墙绝热、邻楼作遮挡面、理想负荷系统', 'One thermal zone per storey, adiabatic party walls, neighbours as shading surfaces, ideal loads system', 'Eine thermische Zone je Geschoss, adiabate Gebäudetrennwände, Nachbargebäude als Verschattungsflächen, Ideal-Loads-System')),
    btn('CityGML · Energy ADE 3.0', async () => {
      try {
        const [{ buildEnergyADE }, { traceInputs, band }, idx] = await Promise.all([import('./energyade.js'), import('./trace.js'), loadIndex()]);
        const t = m.osmTags || {}, site = 'https://chenxiachan.github.io/open-energy-map/';
        download(`${base}_energy_ade.gml`, buildEnergyADE(m, {
          res: S.res, fe: S.fe, pr: S.prior, profile: S.prof, inputs: traceInputs(m, S.ageInfo, S.state, S.assigned, { absUrl: (u) => (!u ? null : /^https?:/.test(u) ? u : `${REPO_URL}/blob/main/${u.replace(/^\.?\//, '')}`) }),
          bands: { heat: band(S.prior, 'heat'), fin: band(S.prior, 'fin'), co2: band(S.prior, 'co2', 1000) },
          ids: { osm: m.id, lod2: m.lod2?.lod2 || null, osmSnapshot: (idx.timestamp || '').slice(0, 10) || null },
          address: { street: t['addr:street'] || null, number: t['addr:housenumber'] || null, postcode: t['addr:postcode'] || null },
          lod2Function: m.lod2?.fn || null, site, mapUrl: `${site}#b=${m.id}@${m.center.lat.toFixed(6)},${m.center.lon.toFixed(6)}`, weatherName: S.weather.name, year: S.weatherKey === 'tmy' ? undefined : +S.weatherKey || undefined,
        }), 'application/gml+xml');
      } catch (e) { $('#exerr').textContent = L('CityGML 导出失败：', 'CityGML export failed: ', 'CityGML-Export fehlgeschlagen: ') + e.message; }
    }, L('CityGML 2.0 与 Energy ADE 3.0：LoD2 边界面、热区、使用区、构造、供热设备和能耗；区间和来源等级在通用属性里', 'CityGML 2.0 with the Energy ADE 3.0: LoD2 boundary surfaces, thermal zone, usage zone, constructions, heat generator and energy; ranges and source tiers as generic attributes', 'CityGML 2.0 mit der Energy ADE 3.0: LoD2-Begrenzungsflächen, thermische Zone, Nutzungszone, Konstruktionen, Wärmeerzeuger und Energie; Bandbreiten und Quellenstufen als generische Attribute')),
    btn(L('EPW 气象文件', 'EPW weather file', 'EPW-Wetterdatei'), async () => { try { const { buildEPW } = await import('./epw.js'); download(`munich_${S.weatherKey}.epw`, buildEPW(S.weather, { windUnit: S.weather.windUnit || 'km/h' })); } catch (e) { $('#exerr').textContent = L('EPW 导出失败：', 'EPW export failed: ', 'EPW-Export fehlgeschlagen: ') + e.message; } }, `${S.weather.name}`),
    btn(L('模型 JSON', 'Model JSON', 'Modell-JSON'), () => download(`${base}.json`, JSON.stringify({ model: { ...m, lonlatOuter: undefined }, results: { annual: S.res.annual, monthly: S.res.monthly, balance: S.res.balance, final: S.fe }, ageInfo: S.ageInfo, checks: S.checks, calibration: S.calib ? { prior: S.calib.prior, post: S.calib.post, sens: S.calib.sens, meas: S.calib.meas } : null }, null, 1), 'application/json'), L('BModel、结果、年代先验、自检和标定摘要', 'BModel, results, age prior, self-checks and calibration summary', 'BModel, Ergebnisse, Baualters-Prior, Plausibilitätsprüfung und Kalibrierungsübersicht')),
    btn(L('逐时 CSV', 'Hourly CSV', 'CSV (stündlich)'), () => {
      const rows = ['hour_utc,T_out_C,T_air_C,T_op_C,Q_heat_cool_W,GHI_Wm2'];
      for (let i = 0; i < 8760; i++) rows.push([i, S.weather.T[i].toFixed(1), S.res.hourly.T_air[i].toFixed(2), S.res.hourly.T_op[i].toFixed(2), S.res.hourly.Q_hc[i].toFixed(0), S.weather.GHI[i].toFixed(0)].join(','));
      download(`${base}_hourly.csv`, rows.join('\n'), 'text/csv');
    }, L('8760 行：室外温度、室内空气与操作温度、供暖/供冷功率', '8760 rows: outdoor temperature, indoor air and operative temperature, heating and cooling power', '8760 Zeilen: Außentemperatur, Raumluft- und operative Temperatur, Heiz- und Kühlleistung')),
    h('p', { class: 'disclaimer', style: 'margin:10px 0 0' }, ...energyAdeCredit()),
    h('p', { class: 'note', id: 'exerr', style: 'color:var(--fail)' }),
  ));
  const btns = [...P.querySelectorAll('.card > button')];
  const row = h('div', { class: 'row' }); btns[0].before(row); row.append(...btns);
}

// ---------- method ----------
const METHOD_EN = () => `<div class="card method">
  <h3>How the page works</h3>
  <h4>1. Geometry (derived from geometry / OSM)</h4>
  <p>Footprints, storeys, heights and roof shapes come from local OSM data (BBBike Munich extract, 2026-10-31, ODbL). The outline is simplified by dropping edges shorter than 0.35 m and bends below 6°, and each remaining edge is one facade. Edge sections that are collinear with a neighbouring heated building and closer than 0.9 m count as party wall. They are split at the neighbour's eaves height: below it the wall is adiabatic, above it the wall is still external. The reference area follows the GEG. For residential buildings A<sub>N</sub> = 0.32 V<sub>e</sub>, or (1/h<sub>G</sub> − 0.04) V<sub>e</sub> when the storey height lies outside 2.5–3 m. Non-residential buildings use 0.85 × gross floor area. A storey height taken from measured heights (LoD2 or OSM height) includes plinth, parapet and the wall under the roof, so it may run high by about 0–0.3 m, and it often lies near 3.0 m, where the reference area steps by about 8%. The point value therefore uses the factor averaged over that bias, and each prior draw takes one bias value, so the step shows in the range.</p>
  <p>Where the Bavarian LoD2 building model covers the OSM outline (${S.lod2Index ? Math.round(100 * S.lod2Index.counts.used / S.lod2Index.counts.osm) + '% of the buildings' : 'when the LoD2 data are present'}), height, roof and storeys come from it, for the building and for its neighbours: eaves = LoD2 wall area ÷ ground perimeter, which keeps the external wall area; for pitched roofs the roof height comes from the volume; storeys from storeysAboveGround, else the OSM storeys or eaves ÷ default storey height. The footprint stays the OSM outline. For OSM buildings tagged only building=yes, whose usage would be guessed from their size, the building function of the cadastre that comes with the LoD2 (ALKIS Gebäudefunktion) takes over when it says business, public, garage or structure. ${zensusAreaText('en')} Matching and the city-wide comparison: <code>tools/lod2_extract.mjs</code>, <code>tools/lod2_match.mjs</code>, <code>qa/lod2_city.md</code>.</p>
  <h4>2. Shading and sun</h4>
  <p>Buildings within 150 m and the building itself are treated as prisms. Sample points sit on each facade by section and storey. On the 15th day of each month, a ray is cast towards the sun every hour, which gives the unshaded fraction of direct radiation. A horizon scan over azimuth gives the horizon elevation angles, and integrating them gives the sky view factor, which scales the isotropic diffuse radiation. Facade irradiation uses the Hay–Davies model with direct and diffuse radiation from ERA5.</p>
  <h4>3. Weather</h4>
  <p>Hourly ERA5 data (2010–2025) from the Open-Meteo historical weather API. The typical meteorological year (TMY) uses a simplified Sandia method. For each month it picks the one year out of 15 whose distributions of daily mean, maximum and minimum temperature, humidity, wind speed and daily radiation come closest to the long-term distributions. The month boundaries are blended over 12 hours. Calibration uses the actual weather of the bill year.</p>
  <h4>4. Construction age and element parameters (typology table / Zensus 2022)</h4>
  <p>Only about 0.4% of the buildings in OSM have a construction year. Without one, the page takes the Zensus 2022 age distribution of residential buildings in the building's 100 m grid cell (widened to 300 m or 1 km where it is too sparse), maps it onto the 12 TABULA age classes and uses it as the age prior. Element U-values, g-values, air tightness and the thermal bridge surcharge come from the German residential typology (IWU 2015 / TABULA). Whether each element has been retrofitted is a Bernoulli prior based on the retrofit share of the age class. Source details are in <code>data/archetypes_sources.md</code>.</p>
  <h4>5. Thermal model (ISO 13790 hourly 5R1C)</h4>
  <p>Every hour the model solves the temperatures of the mass, surface and air nodes. The linear relation in C.4 then gives the heating or cooling power needed to reach the set point directly. The model includes solar gains through the windows (with shading and movable summer shading), solar absorption and long-wave sky radiation on opaque elements, infiltration (0.07 × n50), ventilation and night set-back. Non-residential buildings with window ventilation follow DIN V 18599-2: the usage air flow is set per m² (DIN V 18599-10), infiltration counts towards it, and 0.1 air changes per hour remain outside use. Non-residential use keeps the days of use per year: public holidays are off, and schools and nurseries (DIN V 18599-10 profile 8, classrooms 08:00–15:00) also take the Bavarian school holidays. Rooms that stay unheated are approximated by lowering the effective set point by (1 − f) × 4 K. One annual run takes about 1 millisecond.</p>
  <h4>6. Final energy, carbon emissions, energy class</h4>
  <p>Boilers use a seasonal efficiency. Heat pumps get an hourly COP from the supply temperature curve. Primary energy and CO₂ factors come from GEG Anlage 4 and Anlage 9. The energy class follows the final energy bands of GEG Anlage 10 (residential buildings only).</p>
  <h4>7. Bill calibration (sequential Monte Carlo)</h4>
  <p>The prior is hierarchical: construction age → retrofit state of each element → element U-values (log-normal perturbation) → occupant behaviour (room temperature, heated area fraction, ventilation, internal gains, system efficiency). Each sample is a deterministic map of a standard normal latent vector z. The calibration runs SMC with adaptive tempering in z space. Each step picks the next temperature so that the effective sample size is about half, resamples systematically, and then applies pCN moves that leave the prior invariant, so the acceptance ratio depends only on the likelihood ratio. The likelihood uses a relative error σ (15% by default, including model structure error). The outputs are the posteriors of age and retrofit state, the prior and posterior heat loss of each element, the parameter shrinkage ratios, the posterior correlation matrix (identifiability), and the first-order sensitivity of the "Deep retrofit package" savings to each parameter (what to measure next).</p>
  ${hsCityText('en')}
  ${cityText('en')}
  ${photoCityText('en')}
  ${voiCityText('en')}
  <h4>Limitations</h4>
  <ul>
  <li>Table-based estimates for a single building can be far off. This is why the page gives only ranges and puts bill calibration at its centre.</li>
  <li>OSM usually has no window-to-wall ratio (WWR), attic or basement state. The page uses defaults by type and age, which you can change in the "Parameters &amp; sources" tab.</li>
  <li>The model has a single zone, with no split by storey or orientation. For high-rise buildings or complex sites, export the IDF and run EnergyPlus.</li>
  <li>The Zensus age distribution counts only buildings with dwellings, and non-residential buildings use it as an approximation. The confidentiality treatment of the grid sets small counts to 0.</li>
  <li>Non-residential profiles and element values are approximations (multi-family house elements of the same age). They are not a full DIN V 18599 calculation.</li>
  </ul>
  <h4>Data and licences</h4>
  <p>© OpenStreetMap contributors (ODbL) · Zensus 2022, Statistische Ämter des Bundes und der Länder (dl-de/by-2-0) · LoD2 building models © <a href="https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a> (CC BY 4.0) · Weather data Open-Meteo (CC BY 4.0, ERA5 / Copernicus) · Street-level photos Mapillary (CC BY-SA 4.0, photographers credited under each photo), terrain, orthophoto and trees of the street walk DGM1 / DOP40 / Einzelbäume © Bayerische Vermessungsverwaltung (CC BY 4.0), textures ambientCG (CC0) · Base map OpenFreeMap / OpenMapTiles · IWU / TABULA German residential typology · GEG 2024.</p>
  </div>`;
const METHOD_DE = () => `<div class="card method">
  <h3>Funktionsweise der Seite</h3>
  <h4>1. Geometrie (aus Geometrie abgeleitet / OSM)</h4>
  <p>Grundflächen, Geschosse, Höhen und Dachformen stammen aus lokalen OSM-Daten (BBBike-Extrakt München, 2026-10-31, ODbL). Zur Vereinfachung des Umrisses entfallen Kanten unter 0,35 m und Knicke unter 6°, und jede verbleibende Kante bildet eine Fassade. Kantenabschnitte, die mit einem beheizten Nachbargebäude kollinear sind und weniger als 0,9 m von ihm entfernt liegen, gelten als Gebäudetrennwand. Sie werden an der Traufhöhe des Nachbargebäudes geteilt: Darunter ist die Wand adiabat, darüber bleibt sie Außenwand. Die Gebäudenutzfläche wird nach GEG bestimmt. Für Wohngebäude gilt A<sub>N</sub> = 0,32 V<sub>e</sub>, bei einer Geschosshöhe außerhalb von 2,5–3 m dagegen (1/h<sub>G</sub> − 0,04) V<sub>e</sub>. Für Nichtwohngebäude werden 0,85 × Bruttogrundfläche angesetzt. Eine aus gemessenen Höhen (LoD2 oder OSM height) abgeleitete Geschosshöhe enthält Sockel, Attika und Drempel und kann daher um etwa 0–0,3 m zu hoch liegen; oft liegt sie nahe 3,0 m, wo die Bezugsfläche um etwa 8 % springt. Der Punktwert verwendet deshalb den über diese Abweichung gemittelten Faktor, jede Prior-Ziehung nimmt einen Abweichungswert, sodass der Sprung im Bereich sichtbar wird.</p>
  <p>Wo das bayerische LoD2-Gebäudemodell den OSM-Umriss abdeckt (${S.lod2Index ? Math.round(100 * S.lod2Index.counts.used / S.lod2Index.counts.osm) + '% der Gebäude' : 'sofern LoD2-Daten vorliegen'}), werden Höhe, Dach und Geschosse daraus übernommen, sowohl für das Gebäude als auch für seine Nachbargebäude: Traufhöhe = LoD2-Wandfläche ÷ Grundrissumfang, wodurch die Außenwandfläche erhalten bleibt; bei geneigten Dächern ergibt sich die Dachhöhe aus dem Volumen; die Geschosszahl stammt aus storeysAboveGround, ersatzweise aus den OSM-Geschossen oder aus Traufhöhe ÷ Standardgeschosshöhe. Als Grundfläche dient weiterhin der OSM-Umriss. Bei OSM-Gebäuden, die nur building=yes tragen und deren Nutzung sonst aus der Größe geschätzt würde, gilt die Gebäudefunktion des Katasters aus dem LoD2 (ALKIS-Gebäudefunktion), wenn sie Gewerbe, öffentliche Nutzung, Garage oder Bauwerk angibt. ${zensusAreaText('de')} Zuordnung und stadtweiter Vergleich: <code>tools/lod2_extract.mjs</code>, <code>tools/lod2_match.mjs</code>, <code>qa/lod2_city.md</code>.</p>
  <h4>2. Verschattung und Besonnung</h4>
  <p>Gebäude im Umkreis von 150 m und das Gebäude selbst werden als Prismen abgebildet. Auf jeder Fassade liegen Abtastpunkte je Abschnitt und Geschoss. Am 15. Tag jedes Monats wird zu jeder Stunde ein Strahl in Richtung Sonne verfolgt. Daraus ergibt sich der unverschattete Anteil der Direktstrahlung. Eine Horizontabtastung über den Azimut liefert die Horizonthöhenwinkel, und ihre Integration ergibt den Himmelssichtfaktor, mit dem die isotrope Diffusstrahlung skaliert wird. Die Einstrahlung auf die Fassaden wird mit dem Hay–Davies-Modell aus der Direkt- und Diffusstrahlung von ERA5 berechnet.</p>
  <h4>3. Wetterdaten</h4>
  <p>Grundlage sind stündliche ERA5-Daten (2010–2025) aus der historischen Wetter-API von Open-Meteo. Das typische meteorologische Jahr (TMY) wird mit einem vereinfachten Sandia-Verfahren gebildet. Für jeden Monat wird aus den 15 Jahren dasjenige gewählt, dessen Verteilungen von Tagesmittel-, Tageshöchst- und Tagestiefsttemperatur, Luftfeuchte, Windgeschwindigkeit und Tagessumme der Strahlung den Langzeitverteilungen am nächsten kommen. An den Monatsgrenzen wird über 12 Stunden überblendet. Die Kalibrierung verwendet das tatsächliche Wetter des Abrechnungsjahres.</p>
  <h4>4. Baualter und Bauteilkennwerte (Typologietabelle / Zensus 2022)</h4>
  <p>In OSM ist nur für etwa 0,4% der Gebäude ein Baujahr erfasst. Fehlt es, verwendet die Seite die Baualtersverteilung der Wohngebäude aus dem Zensus 2022 in der 100-m-Gitterzelle des Gebäudes (bei zu geringer Besetzung auf 300 m oder 1 km erweitert), überträgt sie auf die 12 TABULA-Baualtersklassen und setzt sie als Prior für das Baualter an. U-Werte und g-Werte der Bauteile, Luftdichtheit und Wärmebrückenzuschlag stammen aus der deutschen Wohngebäudetypologie (IWU 2015 / TABULA). Ob ein Bauteil saniert ist, wird je Bauteil als Bernoulli-Prior mit dem Sanierungsanteil der Baualtersklasse angesetzt. Einzelheiten zu den Quellen stehen in <code>data/archetypes_sources.md</code>.</p>
  <h4>5. Thermisches Modell (ISO 13790, stündliches 5R1C)</h4>
  <p>Das Modell berechnet stündlich die Temperaturen des Massen-, Oberflächen- und Luftknotens. Der lineare Zusammenhang in C.4 liefert dann direkt die Heiz- oder Kühlleistung, die zum Erreichen der Solltemperatur nötig ist. Das Modell berücksichtigt solare Gewinne durch die Fenster (mit Verschattung und beweglichem sommerlichem Sonnenschutz), solare Absorption und langwellige Abstrahlung an den Himmel an opaken Bauteilen, Infiltration (0,07 × n50), Lüftung und Nachtabsenkung. Nichtwohngebäude mit Fensterlüftung folgen DIN V 18599-2: Der nutzungsbedingte Außenluftvolumenstrom wird flächenbezogen angesetzt (DIN V 18599-10), die Infiltration wird darauf angerechnet, und außerhalb der Nutzung bleibt ein Luftwechsel von 0,1 pro Stunde. Nichtwohnnutzungen halten die jährlichen Nutzungstage ein: Feiertage sind frei, Schulen und Kindergärten (DIN V 18599-10 Profil 8, Klassenzimmer 08:00–15:00) haben zusätzlich die bayerischen Schulferien. Unbeheizt bleibende Räume werden näherungsweise durch eine um (1 − f) × 4 K abgesenkte effektive Solltemperatur abgebildet. Eine Jahresberechnung dauert etwa 1 Millisekunde.</p>
  <h4>6. Endenergie, CO₂-Emissionen, Energieeffizienzklasse</h4>
  <p>Für Kessel wird ein Jahresnutzungsgrad angesetzt. Für Wärmepumpen wird die Leistungszahl (COP) stündlich aus der Vorlauftemperaturkurve bestimmt. Primärenergiefaktoren und CO₂-Emissionsfaktoren stammen aus GEG Anlage 4 und Anlage 9. Die Energieeffizienzklasse richtet sich nach den Endenergie-Klassengrenzen von GEG Anlage 10 (nur Wohngebäude).</p>
  <h4>7. Kalibrierung mit Abrechnungen (sequenzielles Monte-Carlo-Verfahren)</h4>
  <p>Der Prior ist hierarchisch aufgebaut: Baualter → Sanierungszustand jedes Bauteils → U-Werte der Bauteile (log-normale Störung) → Nutzerverhalten (Raumtemperatur, beheizter Flächenanteil, Lüftung, interne Wärmegewinne, Anlagenwirkungsgrad). Jede Stichprobe ist eine deterministische Abbildung eines standardnormalverteilten latenten Vektors z. Die Kalibrierung verwendet SMC mit adaptivem Tempering im z-Raum. In jedem Schritt wird die nächste Temperatur so gewählt, dass die effektive Stichprobengröße etwa die Hälfte beträgt. Danach folgen ein systematisches Resampling und pCN-Schritte, die den Prior invariant lassen, sodass die Akzeptanzwahrscheinlichkeit nur vom Likelihood-Verhältnis abhängt. Die Likelihood verwendet einen relativen Fehler σ (standardmäßig 15%, einschließlich des Modellstrukturfehlers). Ausgegeben werden die Posterior-Verteilungen von Baualter und Sanierungszustand, der Wärmeverlust jedes Bauteils a priori und a posteriori, die Schrumpfungsverhältnisse der Parameter, die Korrelationsmatrix a posteriori (Identifizierbarkeit) sowie die Sensitivität erster Ordnung der Einsparung des „Pakets umfassende Sanierung“ gegenüber jedem Parameter (was als Nächstes gemessen werden sollte).</p>
  ${hsCityText('de')}
  ${cityText('de')}
  ${photoCityText('de')}
  ${voiCityText('de')}
  <h4>Einschränkungen</h4>
  <ul>
  <li>Tabellenbasierte Schätzungen können für ein einzelnes Gebäude deutlich danebenliegen. Deshalb gibt die Seite nur Bereiche an und stellt die Kalibrierung mit Abrechnungen in den Mittelpunkt.</li>
  <li>Fensterflächenanteil sowie Zustand von Dachgeschoss und Keller sind in OSM meist nicht erfasst. Die Seite verwendet Standardwerte nach Gebäudetyp und Baualter, die Sie im Reiter „Eingaben &amp; Quellen“ ändern können.</li>
  <li>Das Modell ist ein Einzonenmodell ohne Aufteilung nach Geschossen oder Orientierung. Für Hochhäuser oder komplexe Bebauung exportieren Sie die IDF-Datei und rechnen mit EnergyPlus.</li>
  <li>Die Baualtersverteilung des Zensus erfasst nur Gebäude mit Wohnraum, und für Nichtwohngebäude wird sie näherungsweise ebenfalls verwendet. Durch das Geheimhaltungsverfahren der Gitterdaten werden kleine Fallzahlen auf 0 gesetzt.</li>
  <li>Nutzungsprofile und Bauteilkennwerte für Nichtwohngebäude sind Näherungen (Bauteile von Mehrfamilienhäusern gleichen Baualters). Sie ersetzen keine vollständige Berechnung nach DIN V 18599.</li>
  </ul>
  <h4>Daten und Lizenzen</h4>
  <p>© OpenStreetMap-Mitwirkende (ODbL) · Zensus 2022, Statistische Ämter des Bundes und der Länder (dl-de/by-2-0) · LoD2-Gebäudemodelle © <a href="https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a> (CC BY 4.0) · Wetterdaten Open-Meteo (CC BY 4.0, ERA5 / Copernicus) · Straßenfotos Mapillary (CC BY-SA 4.0, Urheber unter jedem Foto), Gelände, Orthophoto und Bäume des Straßenrundgangs DGM1 / DOP40 / Einzelbäume © Bayerische Vermessungsverwaltung (CC BY 4.0), Texturen ambientCG (CC0) · Hintergrundkarte OpenFreeMap / OpenMapTiles · IWU / TABULA Deutsche Wohngebäudetypologie · GEG 2024.</p>
  </div>`;
// City-wide comparison with the Heizspiegel for the Method tab (data/heizspiegel_city.json, tools/heizspiegel_compare.mjs)
// The city overview layer for the Method tab (data/city/grid.json, tools/city_run.mjs)
// The pilot layers of uncertainty and value of information for the Method tab (data/city/voi_lit.json, tools/voi_pilot.mjs)
function voiCityText(lang) {
  const v = S.cityVoi; if (!v) return '';
  const f = (x) => fmt(x), nc = f(Object.keys(v.cells).length), sig = `${fmt(100 * (v.meterSigma ?? 0.15))} %`;
  const meter = v.scen.includes('meter') ? {
    zh: `<p>热表读数是第八个来源：一年的实测终端能源（供暖和热水），相对模型的误差取 ${sig}（计量、气象修正、热水的拆分和模型结构误差，和本页账单标定的 15 % 一致）。它不固定任何输入，只给出总量，所以按似然给抽样加权：哪组抽样的终端能源和读数越接近，权重越大。每个情景都可以这样再加上热表读数，不用多算。${v.save ? '第二个目标是本页“整体改造包”省下的单位面积供暖需求：外墙、窗、屋顶和地面到 GEG 限值，n50 1.5，带热回收的通风。' : ''}</p>`,
    en: `<p>The heat meter reading is the eighth source: one year of metered final energy (heating and hot water) with an error of ${sig} against the model (metering, weather correction, the hot-water split and the model's structural error, as the 15 % of the bill calibration on this page). It fixes no input and gives only the total, so it weights the draws by their likelihood: the closer a draw's final energy is to the reading, the more weight it gets. Every scenario can take the reading on top this way without further runs.${v.save ? ' The second target is the heating demand per m² saved by the “Deep retrofit package” of this page: wall, windows, roof and floor to the GEG limits, n50 1.5, ventilation with heat recovery.' : ''}</p>`,
    de: `<p>Der Wärmezählerstand ist die achte Quelle: ein Jahr gemessene Endenergie (Heizung und Warmwasser) mit einem Fehler von ${sig} gegenüber dem Modell (Messung, Witterungsbereinigung, Aufteilung auf Warmwasser und Strukturfehler des Modells, wie die 15 % der Kalibrierung mit Abrechnungen auf dieser Seite). Er legt keine Eingangsgröße fest und liefert nur die Summe, daher gewichtet er die Ziehungen nach ihrer Likelihood: je näher die Endenergie einer Ziehung am Zählerstand liegt, desto mehr Gewicht erhält sie. Jedes Szenario kann den Zählerstand so zusätzlich aufnehmen, ohne weitere Rechnungen.${v.save ? ' Die zweite Zielgröße ist der Heizwärmebedarf pro m², den das „Umfassende Sanierungspaket“ dieser Seite einspart: Wand, Fenster, Dach und Boden auf GEG-Grenzwerte, n50 1,5, Lüftung mit Wärmerückgewinnung.' : ''}</p>`,
  }[lang] : '';
  // the single source that narrows most in a cell, checked against a second prior (tools/voi_pilot.mjs `robust`)
  const rb = v.prior === 'lit' && v.robust?.priors?.length > 1 ? v.robust : null, lead = fmt(100 * (rb?.lead ?? 0.05)), tie = fmt(100 * VOI_TIE_PTS);
  const nh = fmt(rb?.heat ?? 0), ns = fmt(rb?.save ?? 0), nAll = fmt(rb?.cells ?? 0);
  const lit = rb ? {
    zh: `<p>地图上的两个试点图层用按文献调整的先验：1983 年及以前未改造构件的 U 值离散 σ_ln 0.30，1984–94 年 0.25，1995 年起 0.20（IWU MOBASY 2021 表 6）；热桥按构造分档（1948 年以前 0–0.05，1949–2001 年 0.02–0.10 W/(m²K)）；住宅开窗换气多户 0.40 h⁻¹（IWU MOBASY 2023），独栋和联排 0.30，σ_ln 0.4；内部得热 σ_ln 0.37（IWU MOBASY 2023 为 ±40 %）；室温标准差多户 1.0 K，独栋和联排 1.5 K；供暖面积比例独栋 0.75–0.95，多户 0.88–1.0；渗透换算从固定的 0.07 × n50 改为中位数 0.045、几何标准差 1.5（80 栋德国老楼的示踪气体测量约为 0.035 × n50，Münzenberg 等 2003）。其中独栋开窗换气 0.30、独栋室温标准差 1.5 K 和渗透换算 0.045 是检索时提出的建议值，不是文献原值。用应用现用的先验把试点重算一遍做检查：两套先验下缩得最多的是同一项、而且都领先至少 ${lead} 个百分点的格子，看供暖需求只有 ${nh} 个（共 ${nAll} 个），看改造节能量 ${ns} 个。单项之间（年代、改造状态、现场测试、运行数据）的排序主要取决于先验怎么设，尤其是渗透换算：现用先验的 0.07 偏大，现场测试因此在几乎所有格子都显得最值。所以地图上的颜色是文献先验下的答案，换一套先验只有上面这些格子不变；单栋卡片用现用先验按楼回答，相差不到 ${tie} 个百分点的几项合成一行。两套先验下都成立的是：几何和窗几乎不缩区间，热表读数比 BIM 构造缩得多，BIM 构造加运行数据缩到一半以下。除了这两个试点图层，页面其余部分都用现用先验。</p>`,
    en: `<p>The two pilot layers of the map use a prior adjusted to the literature: the spread of unrefurbished U-values σ_ln 0.30 up to 1983, 0.25 for 1984–94 and 0.20 from 1995 (IWU MOBASY 2021, table 6); thermal bridges by construction (before 1949 0–0.05, 1949–2001 0.02–0.10 W/(m²K)); window ventilation in housing 0.40 h⁻¹ in multi-family houses (IWU MOBASY 2023) and 0.30 in single-family and terraced houses, σ_ln 0.4; internal gains σ_ln 0.37 (±40 % in IWU MOBASY 2023); room temperature SD 1.0 K in multi-family, 1.5 K in single-family and terraced houses; heated share 0.75–0.95 in single-family, 0.88–1.0 in multi-family houses; the infiltration factor per n50 a median of 0.045 with a geometric SD of 1.5 instead of a fixed 0.07 (tracer gas in 80 old German buildings gives about 0.035 × n50, Münzenberg et al. 2003). Of these, window ventilation of 0.30 in single-family houses, their room-temperature SD of 1.5 K and the infiltration factor of 0.045 are proposals made during the search, not values from the literature. As a check the pilot was run again with the app's current prior. Result: the same source narrows most under both priors, ahead by at least ${lead} points each time, in only ${nh} cells (of ${nAll}) for the heating demand and ${ns} for the retrofit saving. The order among the single sources (year, refurbishment state, on-site tests, metered operation) depends mainly on how the prior is set, above all on the infiltration factor: the current prior's 0.07 is too high, which makes on-site tests look most valuable in almost every cell. So the colours of the map are the answer under the literature prior, and only the cells above keep theirs under the other prior; the building card answers with the current prior for one building at a time, and sources less than ${tie} points apart share a row there. What holds under both priors: geometry and windows hardly narrow the range, the heat meter reading narrows it more than BIM construction, and BIM construction with metered operation halves it at least. Apart from the two pilot layers, the page uses the current prior only.</p>`,
    de: `<p>Die beiden Pilotebenen der Karte nutzen einen an die Literatur angepassten Prior: Streuung unsanierter U-Werte σ_ln 0,30 bis 1983, 0,25 für 1984–94 und 0,20 ab 1995 (IWU MOBASY 2021, Tab. 6); Wärmebrücken nach Konstruktion (vor 1949 0–0,05, 1949–2001 0,02–0,10 W/(m²K)); Fensterlüftung im Wohnbau 0,40 h⁻¹ in Mehrfamilienhäusern (IWU MOBASY 2023) und 0,30 in Ein- und Reihenhäusern, σ_ln 0,4; innere Gewinne σ_ln 0,37 (±40 % in IWU MOBASY 2023); Standardabweichung der Raumtemperatur 1,0 K in Mehrfamilien-, 1,5 K in Ein- und Reihenhäusern; beheizter Flächenanteil 0,75–0,95 in Ein-, 0,88–1,0 in Mehrfamilienhäusern; der Infiltrationsfaktor je n50 mit Median 0,045 und geometrischer Standardabweichung 1,5 statt fest 0,07 (Tracergas in 80 alten deutschen Gebäuden ergibt etwa 0,035 × n50, Münzenberg et al. 2003). Davon sind die Fensterlüftung von 0,30 in Einfamilienhäusern, deren Standardabweichung der Raumtemperatur von 1,5 K und der Infiltrationsfaktor 0,045 Vorschläge aus der Recherche, keine Literaturwerte. Zur Prüfung wurde der Pilot mit dem aktuellen Prior der App noch einmal gerechnet. Ergebnis: Dieselbe Quelle grenzt unter beiden Priors am stärksten ein, jeweils mit mindestens ${lead} Punkten Vorsprung, in nur ${nh} Zellen (von ${nAll}) für den Heizwärmebedarf und ${ns} für die Einsparung. Die Reihenfolge der einzelnen Quellen (Baujahr, Sanierungsstand, Messungen vor Ort, gemessener Betrieb) hängt vor allem davon ab, wie der Prior gesetzt ist, besonders vom Infiltrationsfaktor: die 0,07 des aktuellen Priors sind zu hoch, dadurch wirken Messungen vor Ort fast überall am wertvollsten. Die Farben der Karte sind also die Antwort unter dem Literatur-Prior, und nur die Zellen oben behalten sie unter dem anderen; die Gebäudekarte antwortet mit dem aktuellen Prior für jeweils ein Gebäude, und Quellen, die weniger als ${tie} Punkte auseinanderliegen, teilen sich dort eine Zeile. Unter beiden Priors gilt: Geometrie und Fenster grenzen den Bereich kaum ein, der Wärmezählerstand grenzt stärker ein als die BIM-Konstruktion, und BIM-Konstruktion mit gemessenem Betrieb halbiert ihn mindestens. Außer den beiden Pilotebenen nutzt die Seite nur den aktuellen Prior.</p>`,
  }[lang] : '';
  return ({
    zh: `<h4>10. 不确定性试点</h4>
  <p>全市图层里的“不确定性：区间宽度”和“不确定性：补哪项数据最值”目前只覆盖 ${v.area} 的试点区（${nc} 个格子），由 <code>tools/voi_pilot.mjs</code> 离线算出。方法是期望部分信息价值：从先验里抽一栋“真实”的楼，把某类数据能告诉模型的输入固定为它的真值，其余照常抽样，取单位面积供暖需求的 P10–P90 宽度；对 ${f(v.truths)} 个真值平均，再和什么都不固定时的宽度相比。改造状态、气密性和热桥只间接说明年代和改造情况，这时年代和各构件是否改造按观测下的精确后验抽取（<code>archetype.js</code> 的 <code>latentPosterior</code>）。点开一栋楼后，概览里的“补哪项数据最能缩小区间”用同样的方法只算这栋楼（<code>js/voi.js</code>，${f(VOI_T)} 个真值 × ${f(VOI_N)} 次抽样，在浏览器里几秒钟），不借用代表楼的结果。</p>
  <p>宽度图层表示格内一栋典型楼的不确定范围：每栋楼自己的 P10、中位数和 P90（kWh/(m²·a)）按参考面积加权平均，颜色是 P10–P90 的宽度。它不是全格合计的范围，也不会因为楼多而变窄：同一年代的构造取值、同一套使用假设和模型本身的误差是各楼共有的，汇总时不会抵消。合计的相对宽度在两种极端之间：误差全部共有时等于典型楼的宽度，全部独立时约为它的 1/√n。</p>
  <p>完整计算每栋楼约 ${f(v.sPerBuilding)} 秒，只对按指纹聚类选出的 10 % 代表楼（${f(v.reps)} 栋）做，其余楼取同一层内最近 3 栋代表楼的反距离加权平均；在 ${f(v.check)} 栋随机检验楼上，重建误差和同一栋楼两次独立计算之间的差别相当。数据都假定完全准确，所以每一项都是上限；结果只反映先验里列出的不确定性，也取决于先验定得多宽。</p>`,
    en: `<h4>10. Uncertainty pilot</h4>
  <p>The city layers “Uncertainty: width of the range” and “Uncertainty: which data helps most” cover only the pilot area so far, ${v.area} (${nc} cells), from an offline run, <code>tools/voi_pilot.mjs</code>. The method is the expected value of partial information: a “true” building is drawn from the prior, the inputs a kind of data would tell the model are fixed to their true values, the rest is sampled as usual, and the P10–P90 width of heating demand per m² is taken; the mean over ${f(v.truths)} truths is compared with the width when nothing is fixed. The refurbishment state, air tightness and thermal bridges say something about the age and the refurbishment of each element without fixing them; then the age class and which elements were refurbished are drawn from their exact posterior given the observation (<code>latentPosterior</code> in <code>archetype.js</code>). Once a building is clicked, “Which data would narrow the range most” on the overview uses the same method for that building alone (<code>js/voi.js</code>, ${f(VOI_T)} truths × ${f(VOI_N)} draws, a few seconds in the browser), never the results of representatives.</p>
  <p>The width layer shows the range of a typical building in the cell: the buildings' own P10, median and P90 (kWh/(m²·a)) weighted by reference area, coloured by the P10–P90 width. It is not the range of the cell's total, and it does not narrow with more buildings: the construction values of an age class, one set of use assumptions and the error of the model itself are shared by the buildings and do not cancel when summed. The relative width of the total lies between two extremes: the width of the typical building if all errors are shared, and about 1/√n of it if all are independent.</p>
  <p>The full calculation takes about ${f(v.sPerBuilding)} s a building and runs only for the 10 % representatives of a fingerprint clustering (${f(v.reps)} buildings); every other building takes the inverse-distance mean of the three nearest representatives in its stratum. On ${f(v.check)} random check buildings the reconstruction error is about the difference between two independent calculations of the same building. Every source is taken as exact, so each figure is an upper bound; the results reflect only the uncertainty listed in the prior and depend on how wide the prior is.</p>`,
    de: `<h4>10. Pilot zur Unsicherheit</h4>
  <p>Die Stadtebenen „Unsicherheit: Breite des Bereichs“ und „Unsicherheit: welche Daten am meisten helfen“ decken bisher nur das Pilotgebiet ab, ${v.area} (${nc} Zellen), aus einem Offline-Lauf, <code>tools/voi_pilot.mjs</code>. Die Methode ist der erwartete Wert partieller Information: Aus dem Prior wird ein „wahres“ Gebäude gezogen, die Eingangsgrößen, die eine Datenart dem Modell liefern würde, werden auf ihre wahren Werte gesetzt, der Rest wird wie üblich gezogen, und die P10–P90-Breite des Heizwärmebedarfs pro m² wird bestimmt; das Mittel über ${f(v.truths)} Wahrheiten wird mit der Breite verglichen, wenn nichts festgelegt ist. Sanierungsstand, Luftdichtheit und Wärmebrücken sagen etwas über das Baualter und die Sanierung der Bauteile, ohne sie festzulegen; dann werden Altersklasse und sanierte Bauteile aus ihrem exakten Posterior gegeben die Beobachtung gezogen (<code>latentPosterior</code> in <code>archetype.js</code>). Nach einem Klick auf ein Gebäude nutzt „Welche Daten den Bereich am stärksten eingrenzen“ in der Übersicht dieselbe Methode nur für dieses Gebäude (<code>js/voi.js</code>, ${f(VOI_T)} Wahrheiten × ${f(VOI_N)} Ziehungen, einige Sekunden im Browser), nie die Ergebnisse von Repräsentanten.</p>
  <p>Die Breitenebene zeigt den Bereich eines typischen Gebäudes der Zelle: P10, Median und P90 der Gebäude (kWh/(m²·a)), gewichtet mit der Bezugsfläche, gefärbt nach der P10–P90-Breite. Das ist nicht der Bereich der Zellensumme, und er wird mit mehr Gebäuden nicht schmaler: die Bauteilwerte einer Altersklasse, dieselben Nutzungsannahmen und der Fehler des Modells selbst sind allen Gebäuden gemeinsam und heben sich beim Summieren nicht auf. Die relative Breite der Summe liegt zwischen zwei Extremen: der Breite des typischen Gebäudes, wenn alle Fehler gemeinsam sind, und etwa 1/√n davon, wenn alle unabhängig sind.</p>
  <p>Die volle Rechnung dauert etwa ${f(v.sPerBuilding)} s pro Gebäude und läuft nur für die 10 % Repräsentanten einer Clusterung nach Merkmalen (${f(v.reps)} Gebäude); jedes andere Gebäude nimmt das abstandsgewichtete Mittel der drei nächsten Repräsentanten seiner Schicht. An ${f(v.check)} zufälligen Prüfgebäuden liegt der Rekonstruktionsfehler etwa beim Unterschied zweier unabhängiger Rechnungen desselben Gebäudes. Jede Quelle gilt als exakt, jeder Wert ist also eine Obergrenze; die Ergebnisse spiegeln nur die im Prior erfassten Unsicherheiten und hängen davon ab, wie breit der Prior ist.</p>`,
  })[lang] + meter + lit;
}
function photoCityText(lang) {
  const t = S.cityPhoto?.totals; if (!t?.n) return '';
  const pc = (a) => fmt((100 * a) / t.n);
  return {
    zh: `<p>“有可用实景照片的楼”由 <code>tools/mapillary_coverage.mjs</code> 离线算出：用全市 Mapillary 覆盖瓦片里的全部照片，按概览页“实景照片”同样的规则，逐栋判断供暖楼能不能被看清。全市 ${fmt(t.n)} 栋供暖楼里，有无遮挡全景的 ${pc(t.pano)}%，有正对照片的 ${pc(t.square)}%，只拍到边上的 ${pc(t.edge)}%，其余没有照片。按同样的 100 m 网格和邻域规则汇总；供暖楼按 OSM 标签和占地判断，不含地籍规则。</p>`,
    en: `<p>"Buildings with a usable street-level photo" comes from an offline run, <code>tools/mapillary_coverage.mjs</code>: all photos in the Mapillary coverage tiles of the city, judged building by building with the rules of the "Street-level photos" card. Of ${fmt(t.n)} heated buildings, ${pc(t.pano)}% have a panorama with a clear line of sight, ${pc(t.square)}% a photo facing them, ${pc(t.edge)}% only photos with the building at the edge, and the rest none. Summed on the same 100 m grid with the same neighbourhood rule; heated buildings are judged from the OSM tags and footprint, without the cadastre rules.</p>`,
    de: `<p>„Gebäude mit brauchbarem Straßenfoto“ stammt aus einem Offline-Lauf, <code>tools/mapillary_coverage.mjs</code>: alle Fotos in den Mapillary-Abdeckungskacheln der Stadt, Gebäude für Gebäude nach den Regeln der Karte „Straßenfotos“ beurteilt. Von ${fmt(t.n)} beheizten Gebäuden haben ${pc(t.pano)} % ein Panorama mit freier Sicht, ${pc(t.square)} % ein Foto, das auf sie blickt, ${pc(t.edge)} % nur Fotos mit dem Gebäude am Rand, die übrigen keines. Summiert im selben 100-m-Raster mit derselben Nachbarschaftsregel; beheizt wird nach OSM-Tags und Grundfläche beurteilt, ohne die Katasterregeln.</p>`,
  }[lang];
}
function cityText(lang) {
  const g = S.cityGrid; if (!g?.totals) return '';
  const t = g.totals, c = g.counts, hs = g.hs, f = (x) => fmt(x);
  return {
    zh: `<h4>9. 全市总览图层</h4>
  <p>地图左下角可以打开全市图层（默认不显示），它由 <code>tools/city_run.mjs</code> 离线算出：全市 ${f(c.heated)} 栋供暖楼逐栋按本页同样的方法建模（LoD2 几何、OSM 或 Zensus 年代、查表点值、典型气象年，不含先验区间），结果按 Zensus 的 100 m 网格汇总，缩放到任何级别都用这一层。另有 ${f(c.unheated)} 栋判为不供暖、${f(c.structures)} 处构筑物没有计入。合计供暖有用热 ${f(t.heatGWh)} GWh/a，热水 ${f(t.dhwGWh)} GWh/a，终端能源 ${f(t.finalGWh)} GWh/a。不足 ${g.minN} 栋供暖楼的格子取周围 3 × 3 格（300 m）的合计，再不足取 5 × 5 格（500 m），仍不足的不画；没有供暖楼的格子也不画。所以颜色不代表任何一栋楼，单栋的数值只在点开后出现。热需求密度的分档按 KEA-BW《地方热规划行动指南》（2020）表 5。</p>${hs ? `
  <p>“比同类楼账单偏高或偏低”只看 Heizspiegel 覆盖的那类楼：集中供暖（燃气、燃油或区域供热）、居住面积至少 100 m² 的多户住宅，共 ${f(c.inScopeHs)} 栋${hs.lowKappa ? `；另有 ${f(hs.lowKappa)} 栋所在的分档里，Zensus 只找到不到一半的住房面积（多半是底层商铺或办公），不参加比较` : ''}。它们用 2016 年实际气象再算一遍终端能源（供暖和热水，燃气按低位热值）；格内合计除以“居住面积 × 同燃料、同规模的 Heizspiegel 均值 Ø”的合计，居住面积按 Zensus 2022 校准（第 1 节）。口径和第 8 节相同，区别是这里用点值、按居住面积加权。能耗换算到典型实测水平（Loga 等 2019，第 8 节）。全市合计为 ${fmt(hs.ratio, 2)}${hs.ratioStd ? `（不换算、用标准计算时为 ${fmt(hs.ratioStd, 2)}${hs.ratioAN12 ? `，面积也不校准时为 ${fmt(hs.ratioAN12, 2)}` : ''}）` : ''}，${f(100 * hs.shareAbove)}% 的楼高于各自的 Ø。燃气按高位热值计时，燃气楼约再高 11%。颜色表示模型在哪里高于或低于同类楼的账单，不是任何一栋楼的实际账单。</p>` : ''}`,
    en: `<h4>9. City overview layer</h4>
  <p>The city layer, off by default and switched on at the bottom left of the map, comes from an offline run, <code>tools/city_run.mjs</code>: ${f(c.heated)} heated buildings, each modelled as on this page (LoD2 geometry, OSM or Zensus age, table point values, typical year, no prior range), summed on the 100 m cells of the Zensus grid, the one layer at every zoom. ${f(c.unheated)} buildings judged unheated and ${f(c.structures)} structures are left out. In total ${f(t.heatGWh)} GWh/a useful heat for space heating, ${f(t.dhwGWh)} GWh/a for hot water and ${f(t.finalGWh)} GWh/a final energy. A cell with fewer than ${g.minN} heated buildings takes the sums of its 3 × 3 neighbourhood (300 m), or else of its 5 × 5 neighbourhood (500 m), and is left out if that is still too few; cells without heated buildings are not drawn. So no colour stands for a single building, and the values of a building appear only when it is clicked. The heat-density classes follow table 5 of the KEA-BW guide to municipal heat planning (2020).</p>${hs ? `
  <p>"Above or below the bill mean" covers only the buildings within the scope of the Heizspiegel: multi-dwelling buildings with central heating (gas, oil or district heat) and at least 100 m² living area, ${f(c.inScopeHs)} in all${hs.lowKappa ? `; ${f(hs.lowKappa)} more are left out because in their band the Zensus finds less than half of the floor area as dwellings (mostly shops or offices below)` : ''}. They are modelled again with the actual weather of 2016 (final energy for heating and hot water, gas on the net calorific value); a cell's sum is divided by the sum of living area × the Heizspiegel mean Ø of the same fuel and size, with the living area calibrated to the Zensus 2022 (section 1). The basis is that of section 8, except that point values are used here and weighted by living area. The energy is brought to the typical level of measured consumption (Loga et al. 2019, section 8). City-wide the ratio is ${fmt(hs.ratio, 2)}${hs.ratioStd ? ` (${fmt(hs.ratioStd, 2)} for the standard calculation${hs.ratioAN12 ? `, ${fmt(hs.ratioAN12, 2)} with A_N ÷ 1.2 as well` : ''})` : ''}, and ${f(100 * hs.shareAbove)}% of the buildings lie above their Ø. On the gross calorific value, gas buildings come out about 11% higher. The colours show where the model lies above or below the bills of similar buildings, not the actual bill of any building.</p>` : ''}`,
    de: `<h4>9. Stadtweite Übersichtsebene</h4>
  <p>Die Stadtebene, standardmäßig aus und unten links auf der Karte einschaltbar, stammt aus einem Offline-Lauf, <code>tools/city_run.mjs</code>: ${f(c.heated)} beheizte Gebäude, jedes wie auf dieser Seite modelliert (LoD2-Geometrie, Baualter aus OSM oder Zensus, Tabellen-Punktwerte, typisches Jahr, ohne Prior-Bereich), summiert auf die 100-m-Zellen des Zensus-Rasters, die eine Ebene für jede Zoomstufe. ${f(c.unheated)} als unbeheizt eingestufte Gebäude und ${f(c.structures)} Bauwerke sind nicht enthalten. Insgesamt ${f(t.heatGWh)} GWh/a Nutzwärme für Raumheizung, ${f(t.dhwGWh)} GWh/a für Warmwasser und ${f(t.finalGWh)} GWh/a Endenergie. Eine Zelle mit weniger als ${g.minN} beheizten Gebäuden nimmt die Summen ihrer 3 × 3-Nachbarschaft (300 m), sonst ihrer 5 × 5-Nachbarschaft (500 m), und entfällt, wenn auch das zu wenige sind; Zellen ohne beheizte Gebäude werden nicht gezeichnet. Keine Farbe steht also für ein einzelnes Gebäude, und die Werte eines Gebäudes erscheinen erst nach einem Klick. Die Klassen der Wärmebedarfsdichte folgen Tab. 5 des KEA-BW-Handlungsleitfadens kommunale Wärmeplanung (2020).</p>${hs ? `
  <p>„Über oder unter dem Abrechnungsmittel“ umfasst nur die Gebäude im Geltungsbereich des Heizspiegels: Mehrfamilienhäuser mit Zentralheizung (Gas, Öl oder Fernwärme) und mindestens 100 m² Wohnfläche, insgesamt ${f(c.inScopeHs)}${hs.lowKappa ? `; weitere ${f(hs.lowKappa)} sind nicht enthalten, weil der Zensus in ihrer Klasse weniger als die Hälfte der Fläche als Wohnfläche findet (meist Läden oder Büros in den unteren Geschossen)` : ''}. Sie werden mit dem tatsächlichen Wetter 2016 erneut modelliert (Endenergie für Heizung und Warmwasser, Gas auf den Heizwert bezogen); die Summe einer Zelle wird durch die Summe aus Wohnfläche × Heizspiegel-Mittel Ø gleichen Energieträgers und gleicher Größe geteilt, mit der an den Zensus 2022 angepassten Wohnfläche (Abschnitt 1). Die Grundlage ist die von Abschnitt 8, nur mit Punktwerten und nach Wohnfläche gewichtet. Der Verbrauch ist auf das typische Verbrauchsniveau umgerechnet (Loga et al. 2019, Abschnitt 8). Stadtweit beträgt das Verhältnis ${fmt(hs.ratio, 2)}${hs.ratioStd ? ` (${fmt(hs.ratioStd, 2)} mit der Standardrechnung${hs.ratioAN12 ? `, ${fmt(hs.ratioAN12, 2)} zusätzlich mit A_N ÷ 1,2` : ''})` : ''}, und ${f(100 * hs.shareAbove)}% der Gebäude liegen über ihrem Ø. Auf den Brennwert bezogen liegen Gasgebäude etwa 11% höher. Die Farben zeigen, wo das Modell über oder unter den Abrechnungen ähnlicher Gebäude liegt, nicht die tatsächliche Abrechnung eines Gebäudes.</p>` : ''}`,
  }[lang];
}
// Section 1: residential floor area against Zensus 2022 (data/zensus/living.json, tools/zensus_check.mjs)
function zensusAreaText(lang) {
  const Z = livingArea(), ck = Z?.check, k = Z?.kappa;
  if (!ck || !k) return { zh: '按 Zensus 2022 的 100 m 网格核对居住面积（<code>tools/zensus_check.mjs</code>）。', en: 'The living area is checked against the Zensus 2022 100 m grid (<code>tools/zensus_check.mjs</code>).', de: 'Die Wohnfläche wird mit dem 100-m-Raster des Zensus 2022 abgeglichen (<code>tools/zensus_check.mjs</code>).' }[lang];
  const n = fmt(Object.keys(Z.nonres || {}).length), r = (x) => fmt(x, 2), ab = [Math.min(...k.ab.k), Math.max(...k.ab.k)].map(r).join('–');
  return {
    zh: `按 Zensus 2022 的 100 m 网格核对居住面积：市内模型与 Zensus 之比原为 1.51，地籍功能接入后为 ${r(ck.before)}。另外两步直接用 Zensus（<code>tools/zensus_check.mjs</code>，<code>data/zensus/living.json</code>）。一是只按规模推成住宅、地籍又没有确认住宅功能的楼，如果周围 Zensus 格子里的居住面积容不下模型放在那里的住宅，就按非住宅处理：共 ${n} 栋，包括展馆、广播楼、办公楼和宫殿，比值降到 ${r(ck.afterRule)}。二是和账单比较时用的居住面积，是 A_N ÷ 1.2 再乘以按楼型和层高拟合 Zensus 的系数：层高 2.75–4 m 时独栋 ${r(k.house.k[1])}、多户住宅 ${r(k.mfh.k[1])}，大型住宅楼按层高为 ${ab}；比值因此为 ${r(ck.afterAll)}。GEG 参考面积在层高 3.0 m 处的跳变在 Zensus 里也看得到，所以保留。`,
    en: `Checked against the living area of the Zensus 2022 100 m grid, the ratio of model to Zensus within the city was 1.51 and is ${r(ck.before)} with the cadastre's building function. Two more steps use the Zensus itself (<code>tools/zensus_check.mjs</code>, <code>data/zensus/living.json</code>). A building that is housing only by the size rule, with no residential function in the cadastre, counts as non-residential when the Zensus cells around it hold less living area than the model's housing there: ${n} buildings, among them exhibition halls, broadcasting and office blocks and palaces; the ratio falls to ${r(ck.afterRule)}. And the living area used against bills is A_N ÷ 1.2 times a factor fitted to the Zensus by house type and storey height: for storeys of 2.75–4 m ${r(k.house.k[1])} for houses and ${r(k.mfh.k[1])} for multi-family houses, ${ab} for apartment blocks by storey height; the ratio is then ${r(ck.afterAll)}. The step of the GEG reference area at 3.0 m storey height shows in the Zensus too, so it is kept.`,
    de: `Im Abgleich mit der Wohnfläche des 100-m-Rasters des Zensus 2022 lag das Verhältnis Modell zu Zensus im Stadtgebiet bei 1,51, mit der Gebäudefunktion des Katasters bei ${r(ck.before)}. Zwei weitere Schritte nutzen den Zensus selbst (<code>tools/zensus_check.mjs</code>, <code>data/zensus/living.json</code>). Ein Gebäude, das nur nach der Größenregel als Wohngebäude gilt und im Kataster keine Wohnfunktion hat, wird als Nichtwohngebäude behandelt, wenn die Zensus-Zellen um das Gebäude weniger Wohnfläche enthalten, als das Modell dort an Wohngebäuden ansetzt: ${n} Gebäude, darunter Messehallen, Rundfunk- und Bürogebäude sowie Schlösser; das Verhältnis sinkt auf ${r(ck.afterRule)}. Außerdem ist die Wohnfläche für den Vergleich mit Abrechnungen A_N ÷ 1,2 mal ein Faktor, der nach Gebäudetyp und Geschosshöhe an den Zensus angepasst ist: bei Geschosshöhen von 2,75–4 m ${r(k.house.k[1])} für Ein- und Zweifamilienhäuser und ${r(k.mfh.k[1])} für Mehrfamilienhäuser, ${ab} für große Mehrfamilienhäuser je nach Geschosshöhe; das Verhältnis beträgt dann ${r(ck.afterAll)}. Der Sprung der GEG-Gebäudenutzfläche bei 3,0 m Geschosshöhe zeigt sich auch im Zensus und bleibt deshalb erhalten.`,
  }[lang];
}

function hsCityText(lang) {
  const c = S.hsCity, P = c?.pooled || {}, a = P['all · Hi'], b = P['all · gas on Hs'];
  if (!a || !b) return '';
  const pc = (x) => Math.round(x * 100);
  const s = c.an12?.pooled, sa = s?.['all · Hi'], sb = s?.['all · gas on Hs'], wo = P['without ≥2002 · Hi'], t = P['all · typical · Hi'], ts = P['all · typical · gas on Hs'];
  const rng = (x, y) => [x, y].sort((u, v) => u - v).map((v) => fmt(v, 2)).join('–');
  return lang === 'zh'
    ? `<h4>8. 与实测账单的对比（Heizspiegel）</h4>
  <p>Heizspiegel München 2018 给出结算年 2016 集中供暖住宅的账单分布，按燃料和规模分档，含热水，按居住面积计。随机抽取 ${a.n} 栋多户住宅（居住面积 ≥ 100 m²），按 2016 年实际气象计算，每栋取一次先验抽样，再与同燃料、同规模档的账单比较。居住面积是 A_N ÷ 1.2 乘以按 Zensus 2022 校准的系数（第 1 节）；Zensus 显示大部分面积不是住房的分档（系数 < 0.5）不参加比较。模型均值是账单均值的 ${rng(a.ratioMean, b.ratioMean)}（燃气按低位热值或账单常用的高位热值）。落在最低档和最高档的比例是 ${pc(a.share[0])}% 和 ${pc(a.share[3])}%，co2online 给出的参照各约 10%。${t && ts ? `模型是标准条件下的需求，实测用量通常更低，计算值越高差得越多（prebound 效应）。用 Loga 等 2019 年由德国 2,857 栋楼得到的计算值与实测值关系换算到典型实测水平后，比值为 ${rng(t.ratioMean, ts.ratioMean)}，两端为 ${pc(t.share[0])}% 和 ${pc(t.share[3])}%（换算只给期望值，不含单栋楼之间的离散，所以两端偏少）。` : ''}${wo ? `不含 2002 年以后的楼时，标准计算为 ${fmt(wo.ratioMean, 2)}。按年代拆开时，比较对象仍是所有年代的均值 Ø，新楼本来就低于它，所以这不是各年代自己的误差。` : ''}${sa && sb ? `面积不校准、直接用 A_N ÷ 1.2 时，比值为 ${rng(sa.ratioMean, sb.ratioMean)}，两端为 ${pc(sa.share[0])}% 和 ${pc(sa.share[3])}%；那个接近 1 的结果，有一部分来自居住面积估大。` : ''}这一检验只说明全市层面的水平和离散程度，不说明单栋楼的误差。</p>`
    : lang === 'de'
    ? `<h4>8. Vergleich mit Verbrauchsabrechnungen (Heizspiegel)</h4>
  <p>Der Heizspiegel München 2018 enthält die Verteilung der Abrechnungswerte zentral beheizter Wohngebäude für das Abrechnungsjahr 2016, gegliedert nach Energieträger und Gebäudegrößenklasse, einschließlich Warmwasser, je m² Wohnfläche. Für eine Zufallsstichprobe von ${a.n} Mehrfamilienhäusern (Wohnfläche ≥ 100 m²) wird mit dem tatsächlichen Wetter des Jahres 2016 gerechnet, mit einer Ziehung aus dem Prior je Gebäude. Das Ergebnis wird mit den Abrechnungen desselben Energieträgers und derselben Größenklasse verglichen. Die Wohnfläche ist A_N ÷ 1,2 mal der an den Zensus 2022 angepasste Faktor (Abschnitt 1); Klassen, in denen der Zensus weniger als die Hälfte der Fläche als Wohnfläche findet (Faktor < 0,5), sind nicht enthalten. Das Verhältnis von Modellmittelwert zu Abrechnungsmittelwert beträgt ${rng(a.ratioMean, b.ratioMean)} (Erdgas bezogen auf den Heizwert oder auf den in den meisten Abrechnungen verwendeten Brennwert). In die niedrigste Kategorie fallen ${pc(a.share[0])}%, in die höchste ${pc(a.share[3])}%; co2online gibt als Referenz jeweils etwa 10% an. ${t && ts ? `Das Modell rechnet den Bedarf unter Standardbedingungen; gemessene Verbräuche liegen meist darunter, umso mehr, je höher der Bedarf ist (Prebound-Effekt). Mit dem Zusammenhang zwischen Bedarf und Verbrauch, den Loga et al. 2019 aus 2.857 deutschen Gebäuden ableiten, auf das typische Verbrauchsniveau umgerechnet, beträgt das Verhältnis ${rng(t.ratioMean, ts.ratioMean)}, mit ${pc(t.share[0])}% und ${pc(t.share[3])}% in den äußeren Kategorien (die Umrechnung liefert Erwartungswerte ohne die Streuung einzelner Gebäude, daher sind die Ränder schwächer besetzt). ` : ''}${wo ? `Ohne Gebäude ab 2002 ergibt die Standardrechnung ${fmt(wo.ratioMean, 2)}. Nach Baualter getrennt bleibt die Vergleichsgröße das Mittel Ø aller Baualter; neue Gebäude liegen ohnehin darunter, das ist also kein Fehler je Baualter. ` : ''}${sa && sb ? `Ohne Anpassung der Fläche, mit A_N ÷ 1,2, beträgt das Verhältnis ${rng(sa.ratioMean, sb.ratioMean)}, mit ${pc(sa.share[0])}% und ${pc(sa.share[3])}% in den beiden äußeren Kategorien; dieses scheinbar nahe an 1 liegende Ergebnis kam zum Teil von einer zu großen Wohnfläche. ` : ''}Diese Prüfung zeigt das stadtweite Niveau und die Streuung, nicht den Fehler für ein einzelnes Gebäude.</p>`
    : `<h4>8. Comparison with measured bills (Heizspiegel)</h4>
  <p>The Heizspiegel München 2018 gives the distribution of bills of centrally heated housing for the billing year 2016, by fuel and size class, hot water included, per m² living area. A random sample of ${a.n} multi-dwelling buildings (living area ≥ 100 m²) is computed with the actual 2016 weather, one prior draw per building, and compared with the bills of the same fuel and size class. The living area is A_N ÷ 1.2 times the factor fitted to the Zensus 2022 (section 1); bands where the Zensus finds less than half of the floor area as dwellings (factor < 0.5) are left out. The model mean is ${rng(a.ratioMean, b.ratioMean)} of the bill mean (gas on the net or on the gross calorific value most bills use). ${pc(a.share[0])}% and ${pc(a.share[3])}% fall in the lowest and the highest band, against about 10% each given by co2online. ${t && ts ? `The model computes the demand under standard conditions; metered consumption is usually lower, the more so the higher the demand (the prebound effect). Brought to the typical level of measured consumption with the relation between demand and consumption that Loga et al. 2019 derive from 2,857 German buildings, the ratio is ${rng(t.ratioMean, ts.ratioMean)}, with ${pc(t.share[0])}% and ${pc(t.share[3])}% in the outer bands (the conversion gives expected values without the spread between single buildings, so the outer bands are thinner). ` : ''}${wo ? `Without the buildings from 2002 on the standard calculation gives ${fmt(wo.ratioMean, 2)}. Split by age, the yardstick is still the mean Ø over all ages, which new buildings lie below anyway, so this is not an error per age. ` : ''}${sa && sb ? `With A_N ÷ 1.2 and no adjustment of the area, the ratio is ${rng(sa.ratioMean, sb.ratioMean)}, with ${pc(sa.share[0])}% and ${pc(sa.share[3])}% in the outer bands; that seemingly close agreement came in part from a living area that was too large. ` : ''}This check shows the city-wide level and spread, not the error for a single building.</p>`;
}

function renderMethod() {
  const P = $('#method-body');
  if (P.dataset.done) return;
  P.dataset.done = '1';
  P.innerHTML = L(`<div class="card method">
  <h3>这个页面怎么算</h3>
  <h4>1. 几何（几何推算 / OSM）</h4>
  <p>建筑轮廓、层数、高度和屋顶形式来自本地 OSM 数据（BBBike 慕尼黑提取，2026-10-31，ODbL）。轮廓简化掉 < 0.35 m 的短边和 < 6° 的折点后，每条边就是一个立面。与相邻供暖建筑共线且距离 < 0.9 m 的边段记为共用墙，按邻楼檐口高度分段：邻楼以下绝热，高出部分仍是外墙。参考面积按 GEG：住宅 A<sub>N</sub> = 0.32 V<sub>e</sub>（层高超出 2.5–3 m 时用 (1/h<sub>G</sub> − 0.04) V<sub>e</sub>），非住宅取 0.85 × 毛楼面积。层高来自实测高度（LoD2 或 OSM height）时含勒脚、女儿墙和屋顶下的矮墙，可能偏高约 0–0.3 m，又常落在 3.0 m 附近，参考面积会在这里跳变约 8%。所以点值取这段偏差上的平均系数，先验每次抽样取一个偏差，跳变体现在区间里。</p>
  <p>有巴伐利亚 LoD2 覆盖的楼（${S.lod2Index ? '全市 ' + Math.round(100 * S.lod2Index.counts.used / S.lod2Index.counts.osm) + '%' : '有 LoD2 数据时'}），本楼和邻楼的高度、屋顶和层数都改用 LoD2：檐口 = LoD2 墙面积 ÷ 地面周长，保留外墙面积；坡屋顶的屋顶高度由体积折算；层数取地上层数，没有时用 OSM 层数或檐口 ÷ 默认层高。占地仍用 OSM 轮廓。OSM 只标 building=yes 的楼，用途原本按规模推断；如果 LoD2 带的地籍建筑功能（ALKIS Gebäudefunktion）是商业、公共、车库或构筑物，就改用地籍的用途。${zensusAreaText('zh')}匹配和全市对比见 <code>tools/lod2_extract.mjs</code>、<code>tools/lod2_match.mjs</code>、<code>qa/lod2_city.md</code>。</p>
  <h4>2. 遮挡与日照</h4>
  <p>周边 150 m 内的建筑和本楼自身都当作棱柱体。每个立面按段和层取样点，每月第 15 天逐小时向太阳射线求交，得到直射未遮挡比例；再按水平角扫描地平线高度角，积分出天空可视比，乘到各向同性散射上。立面辐照用 Hay–Davies 模型，由 ERA5 的直射与散射辐射计算。</p>
  <h4>3. 气象</h4>
  <p>Open-Meteo 历史天气接口的 ERA5 逐时数据（2010–2025）。典型年用简化 Sandia 方法：每个月挑 15 年里日均温、日最高最低温、湿度、风速和日辐射分布最接近长期分布的那一年，月份接缝处做 12 小时交叉渐变。标定时用账单所在年份的实际天气。</p>
  <h4>4. 年代与构件参数（类型学查表 / Zensus 2022）</h4>
  <p>OSM 只有约 0.4% 的楼标了建成年份。没有时，取这栋楼所在 100 m 网格（不足时扩到 300 m、1 km）的 Zensus 2022 住宅建筑年代分布，换算到 TABULA 的 12 个年代段，作为年代先验。构件 U 值、g 值、气密性、热桥附加按德国住宅类型学（IWU 2015 / TABULA）查表，每个构件"是否改造过"按该年代的改造比例当伯努利先验。来源细节见 <code>data/archetypes_sources.md</code>。</p>
  <h4>5. 热模型（ISO 13790 逐时 5R1C）</h4>
  <p>每小时求解质量节点、表面节点和空气节点温度，按 C.4 的线性关系直接求出达到设定温度所需的供暖或供冷功率。包含窗户太阳得热（含遮挡和夏季活动遮阳）、不透明构件的太阳吸收和天空长波辐射、渗透（0.07 × n50）、通风和夜间降温。开窗通风的非住宅按 DIN V 18599-2 处理：使用时段的新风量按面积给定（DIN V 18599-10），渗风算在里面，非使用时段只留每小时 0.1 次换气。非住宅按每年使用天数排日程：法定假日放假，中小学和幼儿园（DIN V 18599-10 第 8 类，教室 8–15 点）另按巴伐利亚校历放假。部分房间不开暖气用"有效设定温度降低 (1 − f) × 4 K"近似。一次全年计算约 1 毫秒。</p>
  <h4>6. 终端能源、碳排放、能效等级</h4>
  <p>锅炉类按季节效率换算，热泵按供水温度曲线逐时算 COP。一次能源系数和 CO₂ 系数取 GEG 附件 4 和附件 9，能效等级按 GEG 附件 10 的终端能源分级（仅住宅）。</p>
  <h4>7. 账单标定（序贯蒙特卡洛）</h4>
  <p>先验是分层的：年代 → 各构件是否改造过 → 构件 U 值（对数正态扰动）→ 使用行为（室温、供暖面积比例、通风、内部得热、系统效率）。每个样本是标准正态潜变量 z 的确定映射，标定在 z 空间做自适应温度的 SMC：每步选下一个温度使有效样本约为一半，系统重采样，再做保持先验不变的 pCN 移动，所以接受率只看似然比。似然用相对误差 σ（默认 15%，包含模型结构误差）。输出年代和改造状态的后验、各构件热损失的先验与后验、参数收缩比、后验相关矩阵（可辨识性），以及"整体改造包"节能量对各参数的一阶敏感度（下一步测什么）。</p>
  ${hsCityText('zh')}
  ${cityText('zh')}
  ${photoCityText('zh')}
  ${voiCityText('zh')}
  <h4>局限</h4>
  <ul>
  <li>单栋楼的查表估算误差可能很大；这也是页面只给区间、并把账单标定放在核心位置的原因。</li>
  <li>窗墙比、阁楼和地下室状态在 OSM 里通常没有，用的是按类型和年代的默认值，可在参数页修改。</li>
  <li>单区模型，不区分楼层和朝向分区；高层或复杂综合体建议导出 IDF 用 EnergyPlus 细算。</li>
  <li>Zensus 年代分布只统计有住宅的建筑，非住宅楼也用它近似；网格的保密处理会把小数目改成 0。</li>
  <li>非住宅剖面和构件值是近似（用多户住宅的同年代构件），不等于 DIN V 18599 的完整计算。</li>
  </ul>
  <h4>数据与许可</h4>
  <p>© OpenStreetMap contributors（ODbL）· Zensus 2022，Statistische Ämter des Bundes und der Länder（dl-de/by-2-0）· LoD2 建筑模型 © <a href="https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2" target="_blank" rel="noopener">Bayerische Vermessungsverwaltung</a>（CC BY 4.0）· 天气数据 Open-Meteo（CC BY 4.0，ERA5 / Copernicus）· 街景照片 Mapillary（CC BY-SA 4.0，拍摄者署名在每张照片下），街区漫游的地形、航拍和树 DGM1 / DOP40 / Einzelbäume © Bayerische Vermessungsverwaltung（CC BY 4.0），纹理 ambientCG（CC0）· 底图 OpenFreeMap / OpenMapTiles · IWU / TABULA 德国住宅类型学 · GEG 2024。</p>
  </div>`, METHOD_EN(), METHOD_DE());
}

boot().catch((e) => { console.error(e); $('#sub').textContent = L('加载失败：', 'Loading failed: ', 'Laden fehlgeschlagen: ') + e.message; });

// The page for ?city=sg (js/main.js hands over to boot() here; Munich never loads this module). Same layout and style as
// the Munich page (index.html, css/style.css): map with search and featured buildings on the left, the building panel on
// the right with key figures, range bars and tier colours, ⓘ tips instead of hint paragraphs. The model is
// js/model_sg.js, shared with agent/core.mjs.
//
// Shown for Singapore: Overview (BCA measured data when listed, 3D view, monthly cooling, electricity by end use),
// Inputs & sources (uncertainty, weather, type and geometry, BCA inputs, every parameter with tier, range and source),
// Cooling balance (in the slot of Munich's heat balance: the chains from the inputs to cooling, electricity and CO₂, where
// the sensible and latent heat come from, the peak hour), Method; Mapillary street photos and the street walk (js/photos.js,
// js/walk.js, shared with Munich). Hidden until they work for a cooling climate: bill calibration, retrofit, the research
// tabs and the exports. The city layer (bottom left of the map, off by
// default) shows data/sg/city/grid.json from tools/sg/city_run_sg.mjs on 100 m cells of SVY21.
import { CITY, renderCitySwitch } from './city.js';
import { loadIndex, buildingAt, byId, neighbours, inCoverage, around } from './osmdb.js';
import { pointInPolygon } from './geo.js';
import * as SG from './archetype_sg.js';
import * as MS from './model_sg.js';
import { createMap } from './map.js';
import { L, LANG, pick, localize, setLang } from './i18n.js';
import * as C from './charts.js';
import { sunPosition } from './solar.js';
import { fromSVY21 } from './svy21.js';
import { fillPhotos, photoLink } from './photos.js';
import { openWalk, closeWalk, walkSelect } from './walk.js';

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
const info = (text) => h('span', { class: 'tip', title: text, 'aria-label': text, tabindex: 0, role: 'note' }, 'i');
const head = (title, tip, aside) => h('div', { class: 'card-head' }, h('h3', {}, title, tip ? info(tip) : null), aside ? h('span', { class: 'aside' }, aside) : null);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const tierChip = (tier, title) => h('span', { class: `src ${SG.TIER_CLASS[tier] || 'default'}`, title: title || null }, SG.TIER_LABEL[tier] || tier);
const KW = 'kWh/(m²·a)';
const REPO_URL = 'https://github.com/chenxiachan/open-energy-map';
const SODL = 'https://data.gov.sg/open-data-licence';
const N_DRAWS = 300;

const S = { A: null, bcaRows: null, cals: null, weather: null, weatherKey: 'tmy', weatherIndex: null, rec: null, nbRecs: null, b: null, sim: null, sum: null, prior: null,
  state: { user: {} }, viewer: null, dark: false, mapApi: null, gef: null };

// ---------- theme and language ----------
function initTheme() {
  const saved = (() => { try { return localStorage.getItem('em-theme'); } catch { return null; } })();
  S.dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = S.dark ? 'dark' : 'light';
  $('#theme').addEventListener('click', () => {
    S.dark = !S.dark;
    document.documentElement.dataset.theme = S.dark ? 'dark' : 'light';
    try { localStorage.setItem('em-theme', S.dark ? 'dark' : 'light'); } catch { /* ignore */ }
    S.mapApi?.setDark(S.dark);
    S.viewer?.setTheme({ dark: S.dark });
    if (S.cityGrid) renderCityLegend();
  });
}
const TIERS = ['observed', 'published_table', 'calibrated', 'assumed', 'estimate', 'user'];
function initLang() {
  document.documentElement.lang = L('zh-CN', 'en', 'de');
  document.title = L('Open Energy Map · 新加坡', 'Open Energy Map · Singapore', 'Open Energy Map · Singapur');
  for (const b of document.querySelectorAll('#lang button[data-l]')) {
    b.setAttribute('aria-pressed', String(b.dataset.l === LANG));
    b.addEventListener('click', () => { if (b.dataset.l !== LANG) setLang(b.dataset.l); });
  }
  $('#lang').setAttribute('aria-label', L('语言', 'Language', 'Sprache'));
  renderCitySwitch($('#citysw'), { muc: L('慕尼黑', 'Munich', 'München'), sg: L('新加坡', 'Singapore', 'Singapur') }, L('城市', 'City', 'Stadt'));   // the city switch next to the name (js/city.js)
  $('#sub').textContent = L('正在加载数据…', 'Loading data…', 'Daten werden geladen …');
  $('#theme').innerHTML = '<svg class="ti" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>';
  $('#theme').append(h('span', { class: 'tt' }, L('明暗', 'Theme', 'Hell/Dunkel')));
  $('#theme').title = L('切换明暗', 'Switch between light and dark', 'Zwischen hell und dunkel wechseln');
  $('#home').title = L('Xia Chen 的个人主页', 'Homepage of Xia Chen', 'Homepage von Xia Chen');
  for (const k of ['title', 'aria-label']) $('#repo').setAttribute(k, L('GitHub 上的源代码', 'Source code on GitHub', 'Quellcode auf GitHub'));
  $('#q').placeholder = L('搜索地址、邮编或楼名', 'Search an address, postcode or building', 'Adresse, Postleitzahl oder Gebäude suchen');
  $('#q').setAttribute('aria-label', $('#q').placeholder);
  $('#mapbusy').textContent = L('正在建模…', 'Building the model…', 'Modell wird erstellt …');
  $('#presets').setAttribute('aria-label', L('精选楼', 'Featured buildings', 'Beispielgebäude'));
  $('#empty').innerHTML = `
        <h2>${L('选一栋楼', 'Pick a building', 'Gebäude wählen')}</h2>
        <ol class="steps">
          <li><b>1</b><span>${L('点地图、搜索地址或邮编，或选下方精选楼', 'Click the map, search an address or postcode, or choose a featured building below', 'Auf die Karte klicken, nach Adresse oder Postleitzahl suchen oder unten ein Beispielgebäude wählen')}</span></li>
          <li><b>2</b><span>${L('自动建模：制冷需求和用电，给出区间', 'The model builds itself: cooling demand and electricity, with ranges', 'Das Modell entsteht automatisch: Kühlbedarf und Strom, mit Bandbreiten')}</span></li>
          <li><b>3</b><span>${L('每项输入都有出处和等级；BCA 名单里的楼另有实测能耗对照', 'Every input has its source and tier; buildings in the BCA listing show their measured energy beside the model', 'Jede Eingabe hat Quelle und Stufe; Gebäude der BCA-Liste zeigen ihren gemessenen Verbrauch neben dem Modell')}</span></li>
        </ol>
        <div class="tierkey">${TIERS.filter((k) => k !== 'user').map((k) => `<span class="src ${SG.TIER_CLASS[k]}">${SG.TIER_LABEL[k]}</span>`).join('')}</div>`;
  const TABS = { overview: L('概览', 'Overview', 'Übersicht'), params: L('参数与来源', 'Inputs & sources', 'Eingaben & Quellen'), balance: L('制冷平衡', 'Cooling balance', 'Kühlbilanz'), method: L('方法', 'Method', 'Methode') };
  // the balance tab shows the cooling balance here (renderBalance below); bill calibration, retrofit and exports wait for
  // the Singapore model (js/city.js layers)
  const SHOW = { balance: CITY.climate === 'heating', calib: CITY.layers.calib, retro: CITY.layers.retrofit, prod: false };
  for (const t of document.querySelectorAll('#tabs button[data-tab]')) {
    if (TABS[t.dataset.tab]) t.textContent = TABS[t.dataset.tab];
    else if (!SHOW[t.dataset.tab]) t.hidden = true;
  }
  $('#bdisc').textContent = disclaimer();
}
function disclaimer() {
  return L('数据来自公开数据源和已发表的文献。新加坡版本是试点：商业楼可以和 BCA 实测能耗对照，住宅只有汇总的统计可以检验。结果仅供参考，不能替代能源审计或现场评估。',
    'Data come from open data sources and published literature. The Singapore version is a pilot: commercial buildings can be compared with measured BCA energy use, housing only with aggregate statistics. Results are for reference only and do not replace an energy audit or an on-site assessment.',
    'Die Daten stammen aus offenen Quellen und veröffentlichter Literatur. Die Singapur-Version ist ein Pilot: Gewerbebauten lassen sich mit gemessenen BCA-Verbräuchen vergleichen, Wohnbauten nur mit zusammengefassten Statistiken. Die Ergebnisse dienen nur zur Orientierung und ersetzen weder ein Energieaudit noch eine Begehung vor Ort.');
}

// ---------- boot ----------
export async function boot() {
  window.__em = S;
  initLang();
  initTheme();
  const getJSON = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [idx, A, wIndex, hol] = await Promise.all([loadIndex(CITY.osm), SG.loadArchetypes(CITY.archetypes), getJSON(CITY.weather + 'index.json'), getJSON(CITY.holidays)]);
  S.A = A; S.weatherIndex = wIndex; S.cals = MS.calendars(hol || {}, A);
  S.weather = await loadWeather('tmy');
  S.gef = MS.gridEF(A, 'TMY');
  S.osmInfo = { n: idx.buildings, date: (idx.timestamp || '').slice(0, 10) };
  $('#sub').textContent = '';
  renderSources();
  S.mapApi = createMap($('#map'), { dark: S.dark, center: CITY.center, onClick: (lon, lat) => pickAt(lon, lat), onCityHover: cityHover });
  initCity().catch((e) => console.error(e));   // the city layer loads beside the presets, never in their way
  const presets = localize((await getJSON(CITY.presets)) || []);
  for (const p of presets) $('#presets').append(h('button', { class: 'chip', title: pick(p, 'note'), onclick: () => pickPreset(p) }, pick(p, 'label')));
  initSearch();
  initTabs();
  const m = location.hash.match(/#b=([wr]\d+)@([\d.]+),([\d.]+)/);
  if (m) pickPreset({ id: m[1], lon: +m[3], lat: +m[2] });
}
async function loadWeather(key) {
  const file = key === 'tmy' ? S.weatherIndex.tmy.file : S.weatherIndex.years[key].file;
  const w = await (await fetch(CITY.weather + file)).json();
  for (const k of ['T', 'GHI', 'DNI', 'DHI']) w[k] = Float32Array.from(w[k]);
  return w;
}
async function bcaRows() {
  if (!S.bcaRows) S.bcaRows = (await (await fetch(CITY.bca)).json()).rows;
  return S.bcaRows;
}

// ---------- search: street, number, building name, HDB "BLK n STREET" and the 6-digit postcode ----------
let ADDR = null;
const norm = (s) => String(s).toLowerCase().replace(/[.\-,#/]/g, ' ').replace(/\s+/g, ' ').trim();
function initSearch() {
  const q = $('#q'), out = $('#qres');
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = norm(q.value);
      out.innerHTML = '';
      if (v.length < 3) return;
      if (!ADDR) {
        out.append(h('div', { class: 'note', style: 'padding:8px 12px' }, L('正在载入地址索引…', 'Loading the address index…', 'Adressindex wird geladen …')));
        ADDR = (await (await fetch(CITY.addr)).json()).map((r) => [...r, norm(`${r[0]} ${r[1]} ${r[6]} ${r[2]}`)]);
        out.innerHTML = '';
      }
      const toks = v.split(' ').filter((t) => !['blk', 'block', 'singapore'].includes(t));
      if (!toks.length) return;
      const pcs = toks.filter((t) => /^\d{6}$/.test(t));
      const hits = [], seen = new Set();
      for (const r of ADDR) {
        if (pcs.length && !pcs.includes(r[2])) continue;
        if (toks.every((t) => (/^\d{6}$/.test(t) ? r[2] === t : r[7].includes(t)))) { if (!seen.has(r[3])) { seen.add(r[3]); hits.push(r); } if (hits.length > 40) break; }
      }
      // whole-word matches of the number first (512 before 1512)
      const num = toks.find((t) => /^\d{1,4}[a-z]?$/.test(t));
      const score = (r) => (num && (r[1].toLowerCase() === num || new RegExp(`\\bblk ${num}\\b`).test(r[7])) ? 0 : 1);
      hits.sort((a, b) => score(a) - score(b));
      if (!hits.length) out.append(h('div', { class: 'note', style: 'padding:8px 12px' }, L('本地数据里没有找到', 'Not found in the local data', 'In den lokalen Daten nicht gefunden')));
      for (const r of hits.slice(0, 13)) out.append(h('button', { onclick: () => { clearTimeout(timer); out.innerHTML = ''; q.value = `${r[1]} ${r[0]}`.trim() || r[6]; pickPreset({ id: r[3], lon: r[4], lat: r[5] }); } },
        `${r[1]} ${r[0]}`.trim() || r[6], ' ', h('small', {}, [r[6], r[2]].filter(Boolean).join(' · '))));
    }, 180);
  });
}

// ---------- tabs and drill-down ----------
function initTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b || b.hidden) return;
    for (const x of $('#tabs').children) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.id === 'p-' + b.dataset.tab);
    if (b.dataset.tab === 'overview') setTimeout(() => S.viewer?.resize(), 0);
    if (b.dataset.tab === 'balance' && S.b) renderBalance();   // drawn when shown: the bars take the width of the panel
  });
  $('#kpis').addEventListener('click', (e) => { const t = e.target.closest('[data-go]'); if (t) goto(t.dataset.go, t.dataset.sel); });
}
function goto(tab, sel, key) {
  const b = $(`#tabs button[data-tab=${tab}]`);
  if (b && !b.classList.contains('on')) b.click();
  const el = sel ? $(sel) : null;
  if (!el) return;
  if (el.matches('tr.refrow')) el.hidden = false;
  const ref = key ? $(`#ref-${key}`) : null;   // a parameter opened from a calculation step shows its references
  if (ref) { ref.hidden = false; $(`#pr-${key} .srcbtn`)?.setAttribute('aria-expanded', 'true'); }
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ---------- city overview layer ----------
// data/sg/city/grid.json (tools/sg/city_run_sg.mjs): the model point values of every modelled building summed on 100 m
// cells of SVY21 (EPSG:3414); a cell with fewer than minN buildings carries the sums of its 300 m or 500 m neighbourhood
// (r), so no colour belongs to a single address. Drawn by the city layer of js/map.js, as in Munich (js/main.js): one
// metric at a time, the same 100 m texture at every zoom, off by default; per-building values only after a click.
// The ramps are those of the Munich layer, validated as ordinal ramps on the light and dark base map: orange for
// electricity, blue for cooling, violet for the HDB share.
const ORANGE = { light: ['#ec8a55', '#e06a3a', '#c9502c', '#a83c25', '#84301f', '#5f2318'], dark: ['#9a4427', '#b9532d', '#d76435', '#ea7d45', '#f39c62', '#f8bf8c'] };
const BLUE = { light: ['#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'], dark: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'] };
const VIOLET = { light: ['#ac9eeb', '#8f78df', '#7455c7', '#5836a6', '#3d2178'], dark: ['#5a3fa0', '#7358c2', '#8c75db', '#a795ef', '#c5bafa'] };
// classes over about P10–P95 of the 27,791 drawn cells of the full run (qa/sg_city_run.md): electricity 15 / 29 / 8 / 33 / 8 / 7 %
// of the cells per class, cooling 21 / 27 / 29 / 15 / 9 %, density (doubling steps) 25 / 25 / 30 / 11 / 9 %; HDB share in fifths
const CITY_METRICS = {
  elec: { label: L('单位面积用电', 'Electricity per m²', 'Strom pro m²'), unit: KW, breaks: [45, 55, 70, 100, 150], colors: ORANGE,
    tip: L('格内所有楼的用电（制冷、照明、设备、其他）÷ 它们的参考面积（组屋是户内面积，私宅是住宅面积，其余是 GFA）。',
      'Electricity of the buildings in the cell (cooling, lighting, equipment, other) ÷ their reference area (flat area for HDB blocks, dwelling area for private housing, GFA otherwise).',
      'Strom der Gebäude der Zelle (Kühlung, Licht, Geräte, Sonstiges) ÷ ihre Bezugsfläche (Wohnfläche bei HDB-Blöcken und privatem Wohnen, sonst BGF).') },
  cool: { label: L('单位面积制冷需求', 'Cooling demand per m²', 'Kühlbedarf pro m²'), unit: KW, breaks: [30, 50, 100, 150], colors: BLUE,
    tip: L('空调的制冷需求（有用冷量，显热加潜热）÷ 参考面积。', 'Cooling demand of the AC (useful cooling, sensible plus latent) ÷ reference area.', 'Kühlbedarf der Klimaanlage (Nutzkälte, sensibel und latent) ÷ Bezugsfläche.') },
  dens: { label: L('制冷需求密度', 'Cooling demand density', 'Kältebedarfsdichte'), unit: 'MWh/(ha·a)', breaks: [200, 400, 800, 1600], colors: BLUE,
    tip: L('制冷需求（有用冷量，显热加潜热）÷ 网格面积；取周围 300 m 或 500 m 的格子除以那片的面积。区域供冷看这个：需求越密，同样长的管网送出的冷量越多。分档是各格子分布的台阶，不是可行性门槛：能不能建还要看成本、大用户和管网。',
      'Cooling demand (useful cooling, sensible plus latent) ÷ cell area; a cell that takes the 300 m or 500 m neighbourhood divides by that area. The measure for district cooling: the denser the demand, the more cooling a network delivers per length of pipe. The classes are steps of the cells\' distribution, not thresholds of feasibility, which also depends on costs, anchor customers and the network.',
      'Kühlbedarf (Nutzkälte, sensibel und latent) ÷ Zellenfläche; eine Zelle, die die Umgebung von 300 m oder 500 m nimmt, teilt durch deren Fläche. Das Maß für Fernkälte: je dichter der Bedarf, desto mehr Kälte liefert ein Netz je Meter Leitung. Die Klassen sind Stufen der Verteilung der Zellen, keine Schwellen der Machbarkeit, die auch von Kosten, Großabnehmern und dem Netz abhängt.') },
  hdb: { label: L('组屋占楼面面积比例', 'HDB share of the floor area', 'HDB-Anteil an der Geschossfläche'), unit: '%', breaks: [20, 40, 60, 80], colors: VIOLET,
    tip: L('格内建模楼的总楼面面积（GFA）里属于组屋（HDB 物业信息）的比例。', 'Share of the gross floor area of the modelled buildings in the cell that lies in HDB blocks (HDB Property Information).', 'Anteil der Bruttogeschossfläche der modellierten Gebäude der Zelle, der in HDB-Blöcken liegt (HDB Property Information).') },
};
async function initCity() {
  if (!CITY.layers.cityGrid || !CITY.cityGrid) return;
  const g = await fetch(CITY.cityGrid).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!g?.c100) return;
  S.cityGrid = g;
  const F = Object.fromEntries(g.fields.map((f, i) => [f, i]));
  const fc = { type: 'FeatureCollection', features: Object.entries(g.c100).map(([k, v]) => {
    const [cx, cy] = k.split('_').map(Number), x0 = cx * 100, y0 = cy * 100;
    const ring = [[x0, y0], [x0 + 100, y0], [x0 + 100, y0 + 100], [x0, y0 + 100], [x0, y0]].map(([x, y]) => fromSVY21(x, y));
    const r = v[F.r], ha = (2 * r + 1) ** 2, cool = v[F.coolSensMWh] + v[F.coolLatMWh], el = v[F.eCoolMWh] + v[F.eLightMWh] + v[F.eEquipMWh] + v[F.eOtherMWh];   // the sums cover the window (r = 0: the cell, 1 ha)
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { k, n: v[F.n], r,
      elec: v[F.AF] > 0 ? Math.round((1000 * el) / v[F.AF]) : null, cool: v[F.AF] > 0 ? Math.round((1000 * cool) / v[F.AF]) : null,
      dens: Math.round(cool / ha), hdb: v[F.GFA] > 0 ? Math.round((100 * v[F.GFAhdb]) / v[F.GFA]) : null } };
  }) };
  // off by default: the map opens plain, the layer is opt-in (a viewer's own choice is remembered, apart from Munich's)
  S.cityMetric = (() => { try { return localStorage.getItem('em-city-sg') || 'off'; } catch { return 'off'; } })();
  if (S.cityMetric !== 'off' && !CITY_METRICS[S.cityMetric]) S.cityMetric = 'off';
  S.mapApi.setCity({ c100: fc, ...cityStyle(S.cityMetric === 'off' ? 'elec' : S.cityMetric), show: S.cityMetric !== 'off' });
  renderCityLegend();
  const P = $('#method-body');
  if (P?.dataset.done && S.b) { delete P.dataset.done; renderMethod(); }
}
const cityStyle = (k) => { const M = CITY_METRICS[k]; return { metric: k, breaks: M.breaks, cats: null, colors: M.colors }; };
function setCityMetric(k) {
  S.cityMetric = k;
  try { localStorage.setItem('em-city-sg', k); } catch { /* ignore */ }
  S.mapApi.setCityStyle(CITY_METRICS[k] ? { ...cityStyle(k), show: true } : { show: false });
  cityHover(null);
  renderCityLegend();
}
function renderCityLegend() {
  let box = $('#citylegend');
  if (!box) { box = h('div', { class: 'citylegend maplibregl-ctrl', id: 'citylegend' }); S.mapApi.mountLegend(box); }
  const k = S.cityMetric, M = CITY_METRICS[k], col = M ? M.colors[S.dark ? 'dark' : 'light'] : [], n = S.cityGrid.minN;
  const tip = L(`每个 100 m 格子（SVY21 坐标网格）汇总格内所有建模楼的模型点值（典型气象年，含校准值）；不足 ${n} 栋的格子取周围 300 m、再不足取 500 m 的合计，所以颜色不代表任何一栋楼。没有空调空间的楼（停车楼、亭子、屋顶、棚子）不计。点楼看单栋。`,
    `Each 100 m cell of the SVY21 grid sums the model point values of all modelled buildings in it (typical year, calibrated inputs); a cell with fewer than ${n} takes the sums of the surrounding 300 m, or else 500 m, so no colour stands for a single building. Buildings without air-conditioned space (car parks, pavilions, roofs, sheds) are left out. Click a building for its own values.`,
    `Jede 100-m-Zelle des SVY21-Rasters summiert die Punktwerte des Modells aller modellierten Gebäude darin (typisches Jahr, kalibrierte Eingaben); eine Zelle mit weniger als ${n} nimmt die Summen der umliegenden 300 m, sonst 500 m, keine Farbe steht also für ein einzelnes Gebäude. Gebäude ohne klimatisierten Raum (Parkhäuser, Pavillons, Dächer, Schuppen) zählen nicht. Ein Klick auf ein Gebäude zeigt dessen eigene Werte.`) + (M?.tip ? '\n\n' + M.tip : '');
  box.replaceChildren(...[
    h('div', { class: 'cl-head' },
      h('select', { 'aria-label': L('地图着色', 'Map colouring', 'Kartenfärbung'), onchange: (e) => setCityMetric(e.target.value) },
        h('option', { value: 'off', selected: k === 'off' }, L('全岛图层：不显示', 'City layer: off', 'Inselebene: aus')), ...Object.entries(CITY_METRICS).map(([key, m]) => h('option', { value: key, selected: key === k }, m.label))),
      info(tip)),
    M ? h('div', { class: 'cl-ramp' }, ...col.map((c, i) => h('span', { class: 'cl-sw', style: `background:${c}` }, h('i', {}, i < M.breaks.length ? fmt(M.breaks[i]) : '')))) : null,
    M ? h('div', { class: 'cl-unit' }, M.unit) : null].filter(Boolean));   // replaceChildren would print null as text
  // the select is as wide as its widest label, and the shared style (no padding) lets the arrow cover the label's end:
  // add the arrow's width (again once the web font is in)
  const fit = () => { const sel = box.querySelector('select'); if (!sel) return; sel.style.width = ''; const w = sel.offsetWidth; if (w > 0) sel.style.width = `${w + 28}px`; };
  fit();
  document.fonts?.ready?.then(fit);
}
function cityHover(p, pt) {
  let t = $('#citytip');
  if (!p || !CITY_METRICS[S.cityMetric]) { if (t) t.hidden = true; return; }
  if (!t) { t = h('div', { class: 'citytip', id: 'citytip', role: 'status' }); $('.mapcol').append(t); }
  const k = S.cityMetric, M = CITY_METRICS[k], v = p[k], w = p.r, m = ['', '300 m', '500 m'][w] || '', n5 = S.cityGrid.minN;
  const who = L(`${fmt(p.n)} 栋建模楼`, `${fmt(p.n)} modelled buildings`, `${fmt(p.n)} modellierte Gebäude`);
  const where = w ? L(`周围 ${m} 内 ${who}（本格不足 ${n5} 栋）`, `${who} within ${m} (fewer than ${n5} in this cell)`, `${who} im Umkreis von ${m} (weniger als ${n5} in dieser Zelle)`) : L(`${who} · 100 m 格`, `${who} · 100 m cell`, `${who} · 100-m-Zelle`);
  t.replaceChildren(h('b', {}, v == null ? '–' : `${fmt(v)} ${M.unit}`), ' · ', where);
  const r = $('#map').getBoundingClientRect(), mc = $('.mapcol').getBoundingClientRect();
  t.hidden = false;
  t.style.left = `${Math.max(4, Math.min(r.width - t.offsetWidth - 4, pt.x + 14)) + (r.left - mc.left)}px`; t.style.top = `${pt.y + 14 + (r.top - mc.top)}px`;
}
// the Method tab: what the layer is, its totals and the check against EMA (qa/sg_city_run.md)
function cityText(lang) {
  const g = S.cityGrid; if (!g?.totals || g.partial) return '';
  const c = g.counts, t = g.totals, ck = g.check, f = (x) => fmt(x), Y = ck.years;
  const rr = (o, key = 'ema') => { const r = o[key].map((e) => o.model / e); return `${fmt(Math.min(...r), 2)}–${fmt(Math.max(...r), 2)}`; };
  const span = (a) => `${fmt(Math.min(...a))}–${fmt(Math.max(...a))}`;
  const y0 = Y[0], y1 = Y[Y.length - 1];
  // non-residential except industry against EMA commerce and services without information and communications
  const nr = { model: ck.nonResNoIndustry?.model, ema: ck.nonResNoIndustry?.emaNoICT || ck.bcaCalibrated.emaNoICT };
  return {
    zh: `<h4>7. 全岛图层</h4><p>地图左下角可以打开全岛图层（默认不显示），它由 <code>tools/sg/city_run_sg.mjs</code> 离线算出：${f(c.modelled)} 栋楼逐栋按本页同样的方法建模（输入取点值，含校准值，典型气象年，不含先验区间），${f(c.notModelled)} 个没有空调空间的轮廓（停车楼、亭子、屋顶、棚子）不计。结果按 SVY21（EPSG:3414）的 100 m 网格汇总，缩放到任何级别都用这一层；不足 ${g.minN} 栋楼的格子取周围 300 m、再不足取 500 m 的合计，所以颜色不代表任何一栋楼，没有楼的格子不画。全岛合计：用电 ${f(t.elecGWh)} GWh/a，制冷需求 ${f(t.coolGWh)} GWh/a，CO₂ ${f(t.co2kt)} kt/a。</p><p>对照（不是校准）：模型里住户的用电 ${f(ck.households.model)} GWh/a，EMA 统计 ${y0}–${y1} 年为 ${span(ck.households.ema)} GWh（比值 ${rr(ck.households)}）；住宅的输入按 EMA 每户用电校准过，这里检验的主要是全岛的住房存量。除工业外的全部非住宅楼共 ${f(nr.model)} GWh/a，EMA 的商业与服务业扣掉信息与通信（数据中心所在的子行业，模型里没有它们的 IT 用电）后为 ${span(nr.ema)} GWh（比值 ${rr(nr)}）。工业生产不在模型里。详见 <code>qa/sg_city_run.md</code>。</p>`,
    en: `<h4>7. City layer</h4><p>The city layer, off by default and switched on at the bottom left of the map, comes from an offline run, <code>tools/sg/city_run_sg.mjs</code>: ${f(c.modelled)} buildings, each modelled as on this page (point values of the inputs with the calibrated ones, typical year, no prior range); ${f(c.notModelled)} outlines without air-conditioned space (car parks, pavilions, roofs, sheds) are left out. The results are summed on the 100 m cells of SVY21 (EPSG:3414), the same layer at every zoom; a cell with fewer than ${g.minN} buildings takes the sums of the surrounding 300 m, or else 500 m, so no colour stands for a single building, and cells without buildings are not drawn. Island totals: electricity ${f(t.elecGWh)} GWh/a, cooling demand ${f(t.coolGWh)} GWh/a, CO₂ ${f(t.co2kt)} kt/a.</p><p>As a check, not a calibration: households use ${f(ck.households.model)} GWh/a in the model against ${span(ck.households.ema)} GWh in EMA's statistics for ${y0}–${y1} (ratio ${rr(ck.households)}); the residential inputs were calibrated on EMA's electricity per household, so this mainly tests the housing stock of the island. All non-residential buildings except industry use ${f(nr.model)} GWh/a against ${span(nr.ema)} GWh for commerce and services without information and communications, the sub-sector that holds the data centres, whose IT load the model does not have (ratio ${rr(nr)}). Industrial processes are not modelled. Details in <code>qa/sg_city_run.md</code>.</p>`,
    de: `<h4>7. Inselweite Ebene</h4><p>Die Inselebene, standardmäßig aus und unten links auf der Karte einschaltbar, stammt aus einem Offline-Lauf, <code>tools/sg/city_run_sg.mjs</code>: ${f(c.modelled)} Gebäude, jedes wie auf dieser Seite modelliert (Punktwerte der Eingaben mit den kalibrierten, typisches Jahr, ohne Prior-Bereich); ${f(c.notModelled)} Umrisse ohne klimatisierten Raum (Parkhäuser, Pavillons, Dächer, Schuppen) zählen nicht. Die Ergebnisse werden auf den 100-m-Zellen von SVY21 (EPSG:3414) summiert, dieselbe Ebene bei jedem Zoom; eine Zelle mit weniger als ${g.minN} Gebäuden nimmt die Summen der umliegenden 300 m, sonst 500 m, keine Farbe steht also für ein einzelnes Gebäude, und Zellen ohne Gebäude werden nicht gezeichnet. Inselweit: Strom ${f(t.elecGWh)} GWh/a, Kühlbedarf ${f(t.coolGWh)} GWh/a, CO₂ ${f(t.co2kt)} kt/a.</p><p>Zur Kontrolle, nicht zur Kalibrierung: Haushalte verbrauchen im Modell ${f(ck.households.model)} GWh/a, in der EMA-Statistik ${y0}–${y1} ${span(ck.households.ema)} GWh (Verhältnis ${rr(ck.households)}); die Wohneingaben sind am EMA-Strom je Haushalt kalibriert, geprüft wird also vor allem der Wohnungsbestand der Insel. Alle Nichtwohngebäude außer der Industrie verbrauchen ${f(nr.model)} GWh/a gegenüber ${span(nr.ema)} GWh für Handel und Dienstleistungen ohne Information und Kommunikation, den Teilsektor der Rechenzentren, deren IT-Last das Modell nicht hat (Verhältnis ${rr(nr)}). Industrieprozesse sind nicht modelliert. Einzelheiten in <code>qa/sg_city_run.md</code>.</p>`,
  }[lang];
}

// ---------- picking ----------
async function pickPreset(p) {
  S.mapApi.flyTo(p.lon, p.lat);
  const rec = await byId(p.id, p.lon, p.lat) || await buildingAt(p.lon, p.lat);
  if (rec) select(rec); else toast(L('本地数据里找不到这栋楼', 'This building is not in the local data', 'Dieses Gebäude ist nicht in den lokalen Daten enthalten'));
}
async function pickAt(lon, lat) {
  if (!inCoverage(lon, lat)) { toast(L('本地数据只覆盖新加坡', 'The local data covers Singapore only', 'Die lokalen Daten decken nur Singapur ab')); return; }
  // HDB towers that OSM draws only as building:part (Pinnacle@Duxton) carry the HDB block themselves: take the part
  const part = (await around(lon, lat)).find((b) => b.part && b.x?.hdb?.res && pointInPolygon([lon, lat], b.outer, b.holes));
  const rec = part || await buildingAt(lon, lat);
  if (!rec) { toast(L('这里没有建筑轮廓', 'No building footprint here', 'Hier gibt es keinen Gebäudeumriss')); return; }
  select(rec);
}
function toast(msg) { const e = $('#maphint'); e.textContent = msg; e.style.color = 'var(--warn)'; clearTimeout(toast.t); toast.t = setTimeout(() => { e.textContent = ''; e.style.color = ''; }, 2600); }

// opts.keepWalk: the building was picked inside the street walk, which stays open
async function select(rec, opts = {}) {
  $('#mapbusy').hidden = false;
  if (!opts.keepWalk) closeWalk();
  S.mapApi.setPhotos?.(null);   // the previous building's Mapillary cameras
  try {
    S.rec = rec;
    S.state = { user: {} };
    S.nbRecs = await neighbours(rec, 150);
    if (rec.x?.bca != null) await bcaRows();
    const d = $('#detail'); if (d) d.scrollTop = 0;
    await rebuild({ geometry: true });
    history.replaceState(null, '', `${location.search}#b=${rec.id}@${((rec.bbox[1] + rec.bbox[3]) / 2).toFixed(6)},${((rec.bbox[0] + rec.bbox[2]) / 2).toFixed(6)}`);
  } catch (e) {
    console.error(e);
    toast(L('建模失败：', 'Modelling failed: ', 'Modellierung fehlgeschlagen: ') + e.message);
  } finally { $('#mapbusy').hidden = true; }
}

async function rebuild(opts = {}) {
  const b = MS.buildModel(S.rec, S.nbRecs, S.state, { A: S.A, bcaRows: S.bcaRows });
  if (b.notModelled) { showNotModelled(S.rec, b.notModelled); return; }
  S.b = b;
  S.sim = MS.simulate(b.m, S.weather, S.cals, { hourly: true, detail: true, shading: !opts.geometry && S.sim?.m === b.m.id ? S.sim.shading : null });
  S.sim.m = b.m.id;
  S.sum = MS.summarize(b.m, S.sim.ctx, S.sim.p, S.sim.res, S.gef.value);
  S.prior = MS.priorMC(b, S.sim, S.gef.value, N_DRAWS, [42, 43], S.state);
  render();
}

function showNotModelled(rec, cls) {
  S.b = null;
  $('#content').hidden = true; $('#empty').hidden = false;
  $('#structnote')?.remove();
  const osmUrl = `https://www.openstreetmap.org/${rec.id.startsWith('w') ? 'way' : 'relation'}/${rec.id.slice(1)}`;
  $('#empty').prepend(h('div', { class: 'structnote', id: 'structnote', role: 'status' },
    h('h2', {}, rec.tags?.name || `OSM ${rec.id}`, ' ', h('a', { class: 'addr', href: osmUrl, target: '_blank', rel: 'noopener' }, 'OSM ↗')),
    h('p', {}, L('这里没有空调空间，所以不计算制冷和用电。', 'There is no air-conditioned space here, so no cooling or electricity is computed.', 'Hier gibt es keinen klimatisierten Raum, daher werden weder Kühlung noch Strom berechnet.')),
    h('p', { class: 'why' }, cls.why)));
  S.mapApi.setSelection({ lonlatOuter: rec.outer, nbLonLat: [], height: 6, roof: { ridgeHeight: 0 } });
  history.replaceState(null, '', `${location.search}#b=${rec.id}@${((rec.bbox[1] + rec.bbox[3]) / 2).toFixed(6)},${((rec.bbox[0] + rec.bbox[2]) / 2).toFixed(6)}`);
}

// ---------- render ----------
function render() {
  renderHeader();
  renderOverview();
  renderParams();
  if ($('#tabs button[data-tab=balance]')?.classList.contains('on')) renderBalance(); else $('#p-balance').replaceChildren();
  renderMethod();
  S.mapApi.setSelection(S.b.m);
}

// P10–P90 band on a track from 0, tick at the value; dark: era at the one used, light: all eras (as on the Munich page)
function rangeBar(full, cond, pt, d = 0, go = '#pp-table') {
  const main = cond || full;
  if (!main || main[0] == null) return '';
  const top = Math.max(full[1] ?? 0, main[1] ?? 0, pt ?? 0) * 1.08 || 1;
  const pc = (v) => `${Math.max(0, Math.min(100, (100 * v) / top)).toFixed(1)}%`;
  const band = (a, b, cls) => `<div class="rb-band${cls}" style="left:${pc(a)};width:calc(${pc(b)} - ${pc(a)})"></div>`;
  const tip = cond
    ? L(`深色：年代按所用的一类时的 P10–P90（${fmt(cond[0], d)}–${fmt(cond[1], d)}）；浅色：所有可能年代（${fmt(full[0], d)}–${fmt(full[1], d)}）。点开参数表`, `Dark: P10–P90 with the era used (${fmt(cond[0], d)}–${fmt(cond[1], d)}); light: all possible eras (${fmt(full[0], d)}–${fmt(full[1], d)}). Opens the parameter table`, `Dunkel: P10–P90 mit der verwendeten Klasse (${fmt(cond[0], d)}–${fmt(cond[1], d)}); hell: alle möglichen Klassen (${fmt(full[0], d)}–${fmt(full[1], d)}). Öffnet die Parametertabelle`)
    : L(`先验 P10–P90（${fmt(full[0], d)}–${fmt(full[1], d)}），来自输入的不确定性。点开参数表`, `Prior P10–P90 (${fmt(full[0], d)}–${fmt(full[1], d)}) from the uncertainty of the inputs. Opens the parameter table`, `Prior P10–P90 (${fmt(full[0], d)}–${fmt(full[1], d)}) aus der Unsicherheit der Eingaben. Öffnet die Parametertabelle`);
  return `<div class="rb" data-go="params" data-sel="${go}" title="${esc(tip)}"><span>${fmt(main[0], d)}</span><div class="rb-track">${cond ? band(full[0], full[2] ?? full[1], ' wide') : ''}${band(main[0], main[1], '')}<div class="rb-pt" style="left:${pc(pt)}"></div></div><span>${fmt(main[1], d)}</span></div>`;
}
const band2 = (pr, k, f = 1) => (pr[k] ? [pr[k][0] / f, pr[k][2] / f] : null);

function titleOf(m, b) {
  const t = m.osmTags || {}, row = b.bcaRow;
  return t.name || row?.name || (m.x?.hdb ? `Blk ${m.x.hdb.blk} ${m.x.hdb.street}` : null) || m.address || `OSM ${m.id}`;
}
function renderHeader() {
  const b = S.b, m = b.m, s = S.sum, pr = S.prior, row = b.bcaRow;
  $('#empty').hidden = true; $('#content').hidden = false;
  $('#structnote')?.remove();
  $('#bname').textContent = titleOf(m, b);
  const osmUrl = `https://www.openstreetmap.org/${m.id.startsWith('w') ? 'way' : 'relation'}/${m.id.slice(1)}`;
  const t = m.osmTags || {};
  const bcaName = row && (row.name_conflict || !t.name) && row.name !== $('#bname').textContent ? row.name : null;
  $('#baddr').replaceChildren(...[m.address && m.address !== $('#bname').textContent ? m.address + ' · ' : null,
    bcaName ? h('span', { title: L('BCA 名单里的名字（与 OSM 不同）', 'Name in the BCA listing (differs from OSM)', 'Name in der BCA-Liste (weicht von OSM ab)') }, `BCA: ${bcaName} · `) : null,
    h('a', { href: osmUrl, target: '_blank', rel: 'noopener', title: L('在 OpenStreetMap 上查看这栋楼', 'View this building on OpenStreetMap', 'Dieses Gebäude auf OpenStreetMap ansehen') }, 'OSM ↗')].filter(Boolean));
  const fact = (title, sel, ...kids) => h('button', { type: 'button', class: 'fact', title: title || null, onclick: () => goto('params', sel) }, ...kids);
  const era = b.asg.eraId ? (SG.erasOf(m.sgType) || []).find((e) => e.id === b.asg.eraId) : null;
  $('#bchips').replaceChildren(...[
    fact(m.usageSrc, '#pg-type', SG.TYPE_CN[m.sgType], m.sgVariant ? h('small', {}, SG.variantLabel(m.sgVariant)) : null),
    fact(`${m.geomSrc.floors}${L('；', '; ', '; ')}${m.geomSrc.height}`, '#pg-storeys', L(`${m.floors} 层 · ${fmt(m.height, 1)} m`, `${m.floors} storeys · ${fmt(m.height, 1)} m`, `${m.floors} Geschosse · ${fmt(m.height, 1)} m`)),
    era ? fact(b.eraInfo.src, '#pg-era', b.eraInfo.year && !S.state.era ? String(b.eraInfo.year) : SG.eraLabel(era), b.eraInfo.kind === 'prior' && !S.state.era ? h('small', {}, `${fmt(100 * b.eraInfo.p[era.id])}%`) : null) : null,
    fact(m.areas.refSrc, '#pg-area', `${fmt(m.areas.netFloor)} m²`, h('small', {}, m.areas.refBasis.split(' (')[0])),
    row ? fact(L('BCA 建筑能耗名单', 'BCA building energy listing', 'BCA-Gebäudeenergieliste'), '#pp-bca', L('BCA 名单', 'BCA listed', 'BCA-Liste')) : null,
    S.weatherKey !== 'tmy' ? fact(L('气象年份', 'Weather year', 'Wetterjahr'), '#pp-weather', L(`${S.weatherKey} 年气象`, `${S.weatherKey} weather`, `Wetter ${S.weatherKey}`)) : null,
  ].filter(Boolean));
  const c = pr.cond;
  const tipCool = L(`空调的制冷需求（有用冷量）= 显热 ${fmt(s.coolSens)} + 潜热 ${fmt(s.coolLat)} ${KW}，每 m² ${m.areas.refBasis}`, `Cooling demand of the AC (useful cooling) = sensible ${fmt(s.coolSens)} + latent ${fmt(s.coolLat)} ${KW}, per m² ${m.areas.refBasis}`, `Kühlbedarf der Klimaanlage (Nutzkälte) = sensibel ${fmt(s.coolSens)} + latent ${fmt(s.coolLat)} ${KW}, je m² ${m.areas.refBasis}`);
  const tipEl = L(`用电：制冷 ${fmt(s.elec.cooling)} + 照明 ${fmt(s.elec.lighting)} + 设备 ${fmt(s.elec.equipment)} + 其他 ${fmt(s.elec.other)} ${KW}；按 GFA 的 EUI ${fmt(s.eui)}`, `Electricity: cooling ${fmt(s.elec.cooling)} + lighting ${fmt(s.elec.lighting)} + equipment ${fmt(s.elec.equipment)} + other ${fmt(s.elec.other)} ${KW}; EUI per GFA ${fmt(s.eui)}`, `Strom: Kühlung ${fmt(s.elec.cooling)} + Licht ${fmt(s.elec.lighting)} + Geräte ${fmt(s.elec.equipment)} + Sonstiges ${fmt(s.elec.other)} ${KW}; EUI je BGF ${fmt(s.eui)}`);
  const tipCo2 = L(`用电 × EMA 电网排放系数 ${S.gef.value} kg/kWh（${S.gef.year} 年${S.gef.tmy ? '，典型年取 2019' : ''}）· ${fmt(s.co2kg, 1)} kg/(m²·a)`, `Electricity × EMA grid emission factor ${S.gef.value} kg/kWh (${S.gef.year}${S.gef.tmy ? ', the typical year takes 2019' : ''}) · ${fmt(s.co2kg, 1)} kg/(m²·a)`, `Strom × EMA-Netzemissionsfaktor ${S.gef.value} kg/kWh (${S.gef.year}${S.gef.tmy ? ', das typische Jahr nimmt 2019' : ''}) · ${fmt(s.co2kg, 1)} kg/(m²·a)`);
  const tipPk = L('逐时最大制冷负荷（显热 + 潜热，理想负荷，不考虑设备容量）', 'Largest hourly cooling load (sensible + latent, ideal load, no equipment limit)', 'Größte stündliche Kühllast (sensibel + latent, ideale Last, ohne Leistungsgrenze)');
  $('#kpis').innerHTML = `
    <div class="kpi go" data-go="balance" data-sel="#cb-cool" role="button" tabindex="0" title="${esc(tipCool)}"><div class="k">${L('制冷需求', 'Cooling demand', 'Kühlbedarf')}</div><div class="v">${fmt(s.cool)}<small>${KW}</small></div>${rangeBar(band2(pr, 'cool'), c ? band2(c, 'cool') : null, s.cool)}</div>
    <div class="kpi go" data-go="balance" data-sel="#cb-elec" role="button" tabindex="0" title="${esc(tipEl)}"><div class="k">${L('用电', 'Electricity', 'Strom')}</div><div class="v">${fmt(s.elec.total)}<small>${KW}</small></div>${rangeBar(band2(pr, 'e_total'), c ? band2(c, 'e_total') : null, s.elec.total)}</div>
    <div class="kpi go" data-go="balance" data-sel="#cb-co2" role="button" tabindex="0" title="${esc(tipCo2)}"><div class="k">CO₂</div><div class="v">${fmt(s.co2t, s.co2t < 100 ? 1 : 0)}<small>t/a</small></div>${rangeBar(band2(pr, 'co2t'), c ? band2(c, 'co2t') : null, s.co2t, s.co2t < 100 ? 1 : 0)}</div>
    <div class="kpi go" data-go="balance" data-sel="#cb-peak" role="button" tabindex="0" title="${esc(tipPk)}"><div class="k">${L('制冷峰值负荷', 'Peak cooling load', 'Kühllast')}</div><div class="v">${fmt(s.peakW / 1000, s.peakW < 1e5 ? 1 : 0)}<small>kW</small></div><div class="r">${fmt(s.peakWm2)} W/m² · P10–P90 ${fmt(pr.peakWm2[0])}–${fmt(pr.peakWm2[2])}</div></div>`;
}

// ---------- overview ----------
const SEQ = ['#f6edc8', '#f0c27a', '#e08a4b', '#c2523a', '#8e2b30', '#5a1a2a'];
function interp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = parseInt(stops[i].slice(1), 16), b = parseInt(stops[i + 1].slice(1), 16);
  return '#' + [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f).toString(16).padStart(2, '0')).join('');
}
async function ensureViewer(container) {
  if (S.viewer) { if (S.viewer.__el !== container) { container.append(S.viewer.__dom); S.viewer.__el = container; } return S.viewer; }
  try {
    const { createViewer } = await import('./scene3d.js');
    const host = h('div', { style: 'position:absolute;inset:0' });
    container.append(host);
    const v = createViewer(host, { dark: S.dark });
    v.__dom = host; v.__el = container;
    v.onPick((p) => { if (!p) $('#pickinfo').textContent = ''; else if (p.kind === 'facade' || p.kind === 'window') pickFacade(p.id.split(':')[0]); });
    S.viewer = v;
    return v;
  } catch (e) {
    container.append(h('div', { class: 'note', style: 'padding:16px' }, L('3D 视图模块未能加载：', 'The 3D view module failed to load: ', 'Das 3D-Ansichtsmodul konnte nicht geladen werden: ') + e.message));
    return null;
  }
}
const DIR = L({ N: '北', E: '东', S: '南', W: '西' }, { N: 'N', E: 'E', S: 'S', W: 'W' }, { N: 'N', E: 'O', S: 'S', W: 'W' });
function pickFacade(fid) {
  const m = S.b.m, i = m.facades.findIndex((f) => f.id === fid), f = m.facades[i];
  if (!f) return;
  S.viewer?.highlight(fid);
  const irr = S.sim.irr.facade[i].reduce((a, v) => a + v, 0) / 1000;
  $('#pickinfo').innerHTML = L(`<b>${DIR[f.orient]}向立面 ${f.id}</b> · 长 ${fmt(f.length, 1)} m · 外露 ${fmt(f.exposedArea)} m²，窗 ${fmt(f.windowArea)} m² · 年辐照 ${fmt(irr)} kWh/m²，天空可视比 ${fmt(S.sim.shading.svf[i] * 100)}%`,
    `<b>${DIR[f.orient]} facade ${f.id}</b> · length ${fmt(f.length, 1)} m · exposed ${fmt(f.exposedArea)} m², windows ${fmt(f.windowArea)} m² · annual irradiation ${fmt(irr)} kWh/m², sky view factor ${fmt(S.sim.shading.svf[i] * 100)}%`,
    `<b>${DIR[f.orient]}-Fassade ${f.id}</b> · Länge ${fmt(f.length, 1)} m · freiliegend ${fmt(f.exposedArea)} m², Fenster ${fmt(f.windowArea)} m² · Jahreseinstrahlung ${fmt(irr)} kWh/m², Himmelssichtfaktor ${fmt(S.sim.shading.svf[i] * 100)}%`);
}
function applyColoring() {
  if (!S.viewer) return;
  const m = S.b.m, vals = {};
  m.facades.forEach((f, i) => { if (f.exposedArea > 0.5) vals[f.id] = S.sim.irr.facade[i].reduce((s, v) => s + v, 0) / 1000; });
  const hi = Math.max(1, ...Object.values(vals)), pal = SEQ.slice().reverse();
  S.viewer.setColoring({ values: vals, colorFn: (v) => interp(pal, v / hi) });
  const lg = $('#legend');
  lg.title = L('立面年太阳辐照（含周边遮挡）', 'Annual solar irradiation on the facades (with shading by the surroundings)', 'Jährliche solare Einstrahlung auf die Fassaden (mit Verschattung durch die Umgebung)');
  lg.innerHTML = `<span>0</span><span class="bar" style="background:linear-gradient(90deg,${pal.join(',')})"></span><span>${fmt(hi)} kWh/(m²·a)</span>`;
}
function setSun() {
  if (!S.viewer) return;
  const mo = +$('#smonth').value, hr = +$('#shour').value;
  $('#shourl').textContent = `${String(Math.floor(hr)).padStart(2, '0')}:${hr % 1 ? '30' : '00'}`;
  const day = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][mo - 1];
  const s = sunPosition(day, hr - CITY.tz, S.b.m.center.lat, S.b.m.center.lon);   // local time UTC+8 → UTC
  S.viewer.setSun(s.altitude > 0 ? { azimuth: s.azimuth, altitude: s.altitude } : null);
}
// First-person walk through the streets around the building (js/walk.js, shared with Munich): OSM outlines at the
// heights of the energy model's neighbours (archetype_sg.js neighbourHeight: HDB storeys, OSM height or levels, GBA),
// flat roofs unless OSM has a roof shape, roads, green and water from the base map; flat ground and no trees, as
// Singapore has no open terrain model, orthophoto or tree register to download (checked 2026-11-26).
function sunNow() {
  const mo = +($('#smonth')?.value || 3), hr = +($('#shour')?.value || 13);
  const day = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][mo - 1];
  const s = sunPosition(day, hr - CITY.tz, S.b.m.center.lat, S.b.m.center.lon);
  return s.altitude > 0 ? { azimuth: s.azimuth, altitude: s.altitude } : null;
}
const walkHeight = (r) => { const e = SG.neighbourHeight(r); return e > 0 ? { eaves: e, floors: r.x?.hdb?.levels > 0 ? r.x.hdb.levels : Math.max(1, Math.round(e / 3.2)) } : null; };
function walkHere() {
  if (!S.b) return;
  const m = S.b.m, fs = m.facades || [];
  const wa = fs.reduce((t, f) => t + (f.windowArea || 0), 0), ea = fs.reduce((t, f) => t + (f.exposedArea || 0), 0);
  openWalk(m, { h, info, mapApi: S.mapApi, host: $('.mapcol'), sun: sunNow(), wwr: ea > 0 ? wa / ea : null, heightOf: walkHeight,
    tipText: L(`合成的街区，不是照片。楼是 OSM 轮廓，高度和能耗模型里的邻楼一样：组屋按 HDB 的层数，其他楼按 OSM 的高度或层数，再没有就用 GlobalBuildingAtlas 的卫星估计高度，都没有时按默认规则估。屋顶除非 OSM 标了形状，一律平顶。窗按层高和平均窗墙比画出（进入漫游时所选的楼用模型估的 ${ea > 0 ? Math.round((100 * wa) / ea) : 22}%）。道路、绿地和水面来自底图的矢量瓦片。地面是平的，也没有树：新加坡没有可以下载的开放地形、航拍或树木数据（2026-11-26 查过）。`,
      `A synthetic street model, not photos. Buildings are OSM outlines at the heights of the energy model's neighbours: HDB blocks by HDB's storeys, others by the OSM height or levels, else the satellite height of GlobalBuildingAtlas, else default rules. Roofs are flat unless OSM gives a roof shape. Windows follow the storey height and an average window-to-wall ratio (the selected building takes the model's ${ea > 0 ? Math.round((100 * wa) / ea) : 22} %). Roads, green and water come from the base map's vector tiles. The ground is flat and there are no trees: Singapore has no open terrain model, orthophoto or tree register to download (checked on 2026-11-26).`,
      `Ein synthetisches Straßenmodell, keine Fotos. Gebäude sind OSM-Umrisse in den Höhen der Nachbarn des Energiemodells: HDB-Blöcke nach den HDB-Geschossen, andere nach OSM-Höhe oder -Geschossen, sonst nach der Satellitenhöhe von GlobalBuildingAtlas, sonst nach Standardregeln. Dächer sind flach, außer OSM gibt eine Dachform an. Fenster folgen der Geschosshöhe und einem mittleren Fensterflächenanteil (das gewählte Gebäude nimmt den Wert des Modells, ${ea > 0 ? Math.round((100 * wa) / ea) : 22} %). Straßen, Grün und Wasser stammen aus den Vektorkacheln der Grundkarte. Der Boden ist eben und es gibt keine Bäume: Für Singapur gibt es kein offenes Geländemodell, Orthofoto oder Baumkataster zum Herunterladen (geprüft am 26.11.2026).`),
    onPick: async (id, lon, lat) => {   // a building clicked in the walk: the panel switches to it, the walk stays
      const rec = await byId(id, lon, lat) || await buildingAt(lon, lat);
      if (rec) { await select(rec, { keepWalk: true }); walkSelect(id); }
    } });
}
function viewModel(m) {
  const r = Math.max(...m.outer.map(([x, y]) => Math.hypot(x, y)));
  return { ...m, neighbors: m.neighbors.filter((n) => n.outer.some(([x, y]) => Math.hypot(x, y) < r + 45)) };
}

async function renderOverview() {
  const P = $('#p-overview');
  if (!$('#ov-viewer')) {
    P.replaceChildren(
      h('div', { id: 'ov-bca' }),
      h('div', { class: 'card' },
        h('div', { class: 'viewer', id: 'ov-viewer' }),
        h('div', { class: 'viewer-tools' },
          h('label', {}, L('太阳 ', 'Sun ', 'Sonne '), h('select', { id: 'smonth', onchange: () => setSun() }, ...C.MONTHS.map((t, i) => h('option', { value: i + 1, selected: i === 2 }, t))),
            h('input', { type: 'range', id: 'shour', min: 7, max: 19, step: 0.5, value: 13, oninput: () => setSun() }), h('span', { id: 'shourl' }, '13:00')),
          h('span', { class: 'legend', id: 'legend' }),
          CITY.layers.walk ? h('button', { type: 'button', class: 'btn small walkbtn', id: 'walkbtn', onclick: () => walkHere(),
            title: L('在这栋楼周围的街区里第一人称走动', 'Walk in first person through the streets around this building', 'In der Ich-Perspektive durch die Straßen um dieses Gebäude gehen') }, L('走进街区', 'Walk the streets', 'Durch die Straßen gehen')) : null),
        h('div', { class: 'pick', id: 'pickinfo', 'aria-live': 'polite' })),
      CITY.layers.photos ? h('div', { class: 'card', id: 'ov-photo-card' }, h('div', { class: 'card-head' },
        h('h3', {}, L('实景照片', 'Street-level photos', 'Straßenfotos'), info(L('Mapillary 上 60 m 内拍到这栋楼的照片：镜头方向的射线先打到这栋楼、没被邻楼挡住的优先，按距离、正对程度和拍摄年份排，最多 3 张，尽量来自不同侧。地图上的橙点是拍摄位置，线是镜头方向。照片为 CC BY-SA 4.0，署名见每张下方；树木遮挡还没计入。',
          'Photos on Mapillary within 60 m that show this building: first those whose camera ray hits the building before any neighbour, ranked by distance, how square on they are and age; up to 3, preferably from different sides. The orange dots on the map are where they were taken, the lines the camera direction. Photos are CC BY-SA 4.0, credited under each; trees blocking the view are not taken into account yet.',
          'Fotos auf Mapillary im Umkreis von 60 m, die dieses Gebäude zeigen: zuerst die, deren Blickrichtung das Gebäude vor jedem Nachbarn trifft, gereiht nach Entfernung, Frontalität und Alter; höchstens 3, möglichst von verschiedenen Seiten. Die orangen Punkte auf der Karte sind die Aufnahmeorte, die Linien die Blickrichtung. Fotos unter CC BY-SA 4.0, Nennung unter jedem Foto; Verdeckung durch Bäume ist noch nicht berücksichtigt.'))),
        h('span', { class: 'aside', id: 'ov-mly' })),
        h('div', { id: 'ov-photos' })) : null,
      h('div', { class: 'card', id: 'ov-cool' }, h('div', { class: 'card-head' }, h('h3', {}, L('逐月制冷需求', 'Monthly cooling demand', 'Monatlicher Kühlbedarf'), h('span', { id: 'cool-tip' })), h('span', { class: 'aside', id: 'cool-aside' })), h('div', { id: 'ov-monthly' })),
      h('div', { class: 'card', id: 'ov-elec' }, h('div', { class: 'card-head' }, h('h3', {}, L('用电（按用途）', 'Electricity by end use', 'Strom nach Verwendung'), h('span', { id: 'elec-tip' })), h('span', { class: 'aside', id: 'elec-aside' })),
        h('div', { id: 'ov-ebars' }), h('div', { id: 'ov-emonth' })),
    );
  }
  renderBcaCard();
  if (CITY.layers.photos) {   // js/photos.js: one Mapillary search per building, the camera positions on the map
    $('#ov-mly').replaceChildren(photoLink(h, S.b.m));
    fillPhotos($('#ov-photos'), S.b.m, { h, fmt, info, setPhotos: (v) => S.mapApi.setPhotos(v) });
  }
  const v = await ensureViewer($('#ov-viewer'));
  if (v) { v.setTheme({ dark: S.dark }); v.setBuilding(viewModel(S.b.m)); applyColoring(); setSun(); }
  const res = S.sim.res, pr = S.prior.cond || S.prior, s = S.sum, m = S.b.m;
  C.monthly($('#ov-monthly'), { series: [
    { label: L('显热', 'Sensible', 'Sensibel'), values: res.monthly.coolSens, color: 'var(--c3)', stack: true },
    { label: L('潜热（除湿）', 'Latent (dehumidification)', 'Latent (Entfeuchtung)'), values: res.monthly.coolLat, color: 'var(--c2)', stack: true }], band: pr.monthlyCool });
  $('#cool-tip').replaceChildren(info(L(`柱子是显热和潜热的点估计，竖线是 P10–P90。空调开 ${fmt(res.annual.acHours)} 小时/年。${SG.RES_TYPES.includes(m.sgType) ? `住宅：空调只在卧室、按夜间时段开，其余时间开窗（混合模式）。` : '非住宅：使用时段开空调，关窗。'}`,
    `Bars are the point estimate of sensible and latent cooling, whiskers P10–P90. AC on ${fmt(res.annual.acHours)} h a year. ${SG.RES_TYPES.includes(m.sgType) ? 'Housing: AC in the bedrooms at night only, windows open otherwise (mixed mode).' : 'Non-residential: AC during use, windows closed.'}`,
    `Balken: Punktschätzung von sensibler und latenter Kühlung, Linien P10–P90. Klimaanlage ${fmt(res.annual.acHours)} h im Jahr an. ${SG.RES_TYPES.includes(m.sgType) ? 'Wohnen: Klimaanlage nur nachts in den Schlafzimmern, sonst offene Fenster (Mischbetrieb).' : 'Nichtwohnen: Klimaanlage während der Nutzung, Fenster zu.'}`)));
  const lgd = (items) => items.map(([label, color]) => h('span', { class: 'legend-inline' }, h('span', { class: 'sw', style: `background:${color}` }), label));
  $('#cool-aside').replaceChildren(...lgd([[L('显热', 'Sensible', 'Sensibel'), 'var(--c3)'], [L('潜热', 'Latent', 'Latent'), 'var(--c2)']]), L(`全年 ${fmtK(res.annual.cool)} · 潜热 ${fmt((100 * s.coolLat) / Math.max(1e-9, s.cool))}%`, `Annual ${fmtK(res.annual.cool)} · latent ${fmt((100 * s.coolLat) / Math.max(1e-9, s.cool))}%`, `Jahr ${fmtK(res.annual.cool)} · latent ${fmt((100 * s.coolLat) / Math.max(1e-9, s.cool))} %`));
  const E = [['cooling', L('制冷', 'Cooling', 'Kühlung'), 'var(--c1)'], ['lighting', L('照明', 'Lighting', 'Beleuchtung'), 'var(--c2)'], ['equipment', L('设备与插座', 'Equipment and plugs', 'Geräte und Steckdosen'), 'var(--c3)'], ['other', L('其他', 'Other', 'Sonstiges'), 'var(--fg-2)']];
  const items = E.map(([k, label, color]) => ({ label, value: s.elec[k] || 0, color, lo: pr['e_' + k][0], hi: pr['e_' + k][2], note: `P10–P90 ${fmt(pr['e_' + k][0], 1)}–${fmt(pr['e_' + k][2], 1)} ${KW}` }));
  const CHAIN = { cooling: '#cb-ecool', lighting: '#cb-elight', equipment: '#cb-eequip', other: '#cb-eother' };
  C.hbars($('#ov-ebars'), items, { valueFmt: (it) => `${fmt(it.value, 1)}`, onPick: (it, i) => goto('balance', CHAIN[E[i][0]]) });
  C.monthly($('#ov-emonth'), { series: E.map(([k, label, color]) => ({ label, values: res.monthly.elec[k], color, stack: true })), band: pr.monthlyElec, height: 180 });
  const cop = m.params.COP_cool;
  $('#elec-tip').replaceChildren(info(L(`制冷用电 = 制冷需求 ÷ COP ${fmt(cop.value, 2)}（${cop.note}）。照明和设备逐时按使用时段计入，同时作为内热；其他（热水、厨房、电梯、水泵）按年计。kWh/(m²·a)，线段是 P10–P90。`,
    `Cooling electricity = cooling demand ÷ COP ${fmt(cop.value, 2)} (${cop.note}). Lighting and equipment hourly on the schedule, also as internal gains; other (hot water, kitchen, lifts, pumps) per year. kWh/(m²·a), lines are P10–P90.`,
    `Kühlstrom = Kühlbedarf ÷ COP ${fmt(cop.value, 2)} (${cop.note}). Licht und Geräte stündlich nach Zeitplan, auch als innere Lasten; Sonstiges (Warmwasser, Küche, Aufzüge, Pumpen) jährlich. kWh/(m²·a), Linien P10–P90.`)));
  $('#elec-aside').replaceChildren(...lgd(E.map(([, label, color]) => [label, color])), L(`合计 ${fmt(s.elec.total)} ${KW} · ${fmtK(s.elecKWh)}`, `Total ${fmt(s.elec.total)} ${KW} · ${fmtK(s.elecKWh)}`, `Summe ${fmt(s.elec.total)} ${KW} · ${fmtK(s.elecKWh)}`));
}

// BCA measured EUI next to the model: never an input
function renderBcaCard() {
  const box = $('#ov-bca'), b = S.b, meas = MS.measured(b.bcaRow);
  if (!meas) { box.replaceChildren(); return; }
  const pr = S.prior.cond || S.prior, s = S.sum;
  const rows = meas.years.map((y) => h('tr', {}, h('td', {}, String(y.year)), h('td', { class: 'num' }, y.plausible ? fmt(y.eui) : h('span', { class: 'note' }, fmt(y.eui))),
    h('td', {}, y.plausible ? (y.covid ? h('span', { class: 'note' }, L('疫情年份', 'COVID year', 'COVID-Jahr')) : '') : h('span', { class: 'status warn', title: L('低于 20 或高于 1000 kWh/(m²·a)', 'below 20 or above 1000 kWh/(m²·a)', 'unter 20 oder über 1000 kWh/(m²·a)') }, L('源数据存疑', 'implausible in the source', 'in der Quelle unplausibel'))),
    h('td', { class: 'note' }, y.src === 'BEBR' ? 'BCA BEBR' : y.src ? `BCA ${y.src.slice(1)}` : '')));
  const tip = L(`BCA 公布的这栋楼实测 EUI（全年用电 ÷ GFA）。只用于对照，从不作为模型输入。区域供冷的楼不含买来的冷水。匹配：${meas.match}，可信度 ${meas.conf}${meas.outlines > 1 ? `，名单覆盖 ${meas.outlines} 个轮廓` : ''}。`,
    `Measured EUI of this building published by BCA (annual electricity ÷ GFA). For comparison only, never a model input. Buildings on district cooling exclude the purchased chilled water. Match: ${meas.match}, confidence ${meas.conf}${meas.outlines > 1 ? `, the listing covers ${meas.outlines} outlines` : ''}.`,
    `Von der BCA veröffentlichter gemessener EUI dieses Gebäudes (Jahresstrom ÷ BGF). Nur zum Vergleich, nie eine Modelleingabe. Gebäude mit Fernkälte ohne die zugekaufte Kälte. Zuordnung: ${meas.match}, Konfidenz ${meas.conf}${meas.outlines > 1 ? `, die Liste umfasst ${meas.outlines} Umrisse` : ''}.`);
  box.replaceChildren(h('div', { class: 'card', id: 'pp-bca-meas' },
    head(L('BCA 实测能耗（对照，不是输入）', 'Measured by BCA (comparison, not an input)', 'Gemessen von der BCA (Vergleich, keine Eingabe)'), tip, meas.name),
    h('dl', { class: 'stats' }, ...[
      [L('模型 EUI（按 GFA）', 'Model EUI (per GFA)', 'Modell-EUI (je BGF)'), `${fmt(s.eui)} ${KW}`, `P10–P90 ${fmt(pr.eui[0])}–${fmt(pr.eui[2])}`],
      [L('BCA 2019', 'BCA 2019', 'BCA 2019'), (() => { const y = meas.years.find((x) => x.year === 2019); return y ? `${fmt(y.eui)} ${KW}${y.plausible ? '' : ' ?'}` : '–'; })(), L('疫情前的检验年', 'pre-COVID test year', 'Testjahr vor COVID')],
      [L('BCA 最近一年', 'BCA latest year', 'BCA letztes Jahr'), (() => { const y = meas.years.filter((x) => x.plausible).pop(); return y ? `${fmt(y.eui)} ${KW} (${y.year})` : '–'; })(), ''],
      [L('BCA GFA', 'BCA GFA', 'BCA-BGF'), meas.gfa ? `${fmt(meas.gfa)} m²` : '–', meas.type || ''],
    ].map(([k, v, t]) => h('div', { title: t || null }, h('dt', {}, k), h('dd', {}, v)))),
    h('details', { class: 'adv' }, h('summary', {}, L(`逐年 EUI（${meas.years.length} 年）`, `EUI by year (${meas.years.length} years)`, `EUI nach Jahr (${meas.years.length} Jahre)`)),
      h('div', { class: 'tblwrap' }, h('table', { class: 't' }, h('tr', {}, h('th', {}, L('年份', 'Year', 'Jahr')), h('th', { class: 'num' }, KW), h('th', {}, ''), h('th', {}, L('来源', 'Source', 'Quelle'))), ...rows)))));
}

// ---------- cooling balance ----------
// The arithmetic behind the key figures, as on the Munich Heat balance tab (js/main.js): a chain is a sum a reader can
// redo; each step shows a value, and a step that is a model input carries its tier and opens its row in the parameter
// table, with its references, where it can be changed. The numbers are rc5.js res.coolBalance (opts.detail): the heat
// that enters the cooled zone in its AC hours, at the set point, closed by the storage term; the latent terms and the
// electricity add up exactly (tests/sg_balance.mjs redoes every chain).
const op = (t) => h('span', { class: 'op', 'aria-hidden': 'true' }, t);
function cstep(label, value, o = {}) {
  const pv = o.param ? S.b.m.params[o.param] : null;
  const go = pv ? ['params', `#pr-${o.param}`, o.param] : o.go;
  const chip = o.chip !== undefined ? o.chip : pv ? tierChip(pv.tier) : null;
  const title = o.title || (pv ? `${SG.PARAM_META[o.param]?.label || o.param}: ${[pv.source, pv.note].filter(Boolean).join(' · ')}` : null);
  return h(go ? 'button' : 'div', { type: go ? 'button' : null, class: `step${o.total ? ' total' : ''}`, title, onclick: go ? () => goto(...go) : null },
    h('span', { class: 'sl' }, label), h('span', { class: 'sv' }, value), o.sub ? h('span', { class: 'ss' }, o.sub) : null, chip);
}
const chainRow = (title, steps, id) => h('div', { class: 'calc-row', id: id || null }, title ? h('span', { class: 'calc-t' }, title) : null, h('div', { class: 'chain' }, ...steps));
const pval = (k) => S.sim.p[k];
const pstep = (k, d = 2, o = {}) => cstep(o.label || SG.PARAM_META[k]?.label || k, `${fmt(pval(k), d)}${o.unit === false ? '' : ' ' + (SG.PARAM_META[k]?.unit || '')}`.trim(), { param: k, ...o });
const LC = { light: L('照明', 'Lighting', 'Beleuchtung'), equip: L('设备与插座', 'Equipment and plugs', 'Geräte und Steckdosen'), other: L('其他', 'Other', 'Sonstiges'), cool: L('制冷', 'Cooling', 'Kühlung') };
const perM2 = (kwh) => `${fmt(kwh / S.sim.ctx.AN, 1)} ${KW}`;
// the hours of use in a year, as the schedule gives them (rc5 prepare: occM)
function useHours() {
  const pr = S.sim.prof, h1 = S.sim.ctx.occM.reduce((s, v) => s + v, 0);
  const res = SG.RES_TYPES.includes(S.b.m.sgType);
  const days = { 5: L('周一至五', 'Mon–Fri', 'Mo–Fr'), 6: L('周一至六', 'Mon–Sat', 'Mo–Sa'), 7: L('每天', 'every day', 'täglich') }[pr.daysPerWeek] || `${pr.daysPerWeek} d/wk`;
  const hol = pr.holidayRule === 'open' || pr.holidayRule === 'none' ? '' : pr.holidays === 'school' ? L('，学校假期休', ', closed in school holidays', ', in Schulferien geschlossen') : L('，公共假日休', ', closed on public holidays', ', an Feiertagen geschlossen');
  return { h: h1, rest: 8760 - h1, sub: res ? L('住宅按全天 24 小时平均功率计', 'housing: 24-h mean power', 'Wohnen: 24-h-Mittelwert') : L(`${pr.start}–${pr.end} 时，${days}${hol}`, `${pr.start}:00–${pr.end}:00, ${days}${hol}`, `${pr.start}–${pr.end} Uhr, ${days}${hol}`) };
}

// how the key figures follow from each other: sensible + latent = cooling; ÷ COP; + lighting, equipment, other; × grid factor
function cbChainCard() {
  const s = S.sum, m = S.b.m, a = S.sim.res.annual, U = useHours(), us = pval('useScale') ?? 1, res = SG.RES_TYPES.includes(m.sgType);
  const usStep = us !== 1 ? [op('×'), pstep('useScale', 2, { unit: false })] : [];
  const sysKey = S.b.asg.sysKey;
  const kwh = (v) => `${fmt(v, 1)} ${KW}`;
  const hoursStep = (label, hrs, sub) => cstep(label, `${fmt(hrs)} h`, { sub, title: L('按使用时段和节假日逐时数出来的小时', 'Counted hour by hour from the schedule and the holidays', 'Stunde für Stunde aus Zeitplan und Feiertagen gezählt') });
  const rows = [
    chainRow(L('制冷需求', 'Cooling demand', 'Kühlbedarf'), [
      cstep(L('显热', 'Sensible', 'Sensibel'), kwh(s.coolSens), { go: ['balance', '#cb-sens'], title: L('温度：见下方显热的来源', 'Temperature: see where the sensible heat comes from, below', 'Temperatur: siehe unten, woher die sensible Wärme kommt') }), op('+'),
      cstep(L('潜热（除湿）', 'Latent (dehumidification)', 'Latent (Entfeuchtung)'), kwh(s.coolLat), { go: ['balance', '#cb-lat'], title: L('湿度：见下方潜热的来源', 'Moisture: see where the latent heat comes from, below', 'Feuchte: siehe unten, woher die latente Wärme kommt') }), op('='),
      cstep(L('制冷需求', 'Cooling demand', 'Kühlbedarf'), kwh(s.cool), { total: true, sub: fmtK(a.cool) })], 'cb-cool'),
    chainRow(LC.cool, [
      cstep(L('制冷需求', 'Cooling demand', 'Kühlbedarf'), kwh(s.cool)), op('÷'),
      pstep('COP_cool', 2, { label: L('系统 COP', 'System COP', 'System-COP'), unit: false, sub: SG.sysLabel(sysKey) }), op('='),
      cstep(L('制冷用电', 'Cooling electricity', 'Kühlstrom'), kwh(s.elec.cooling), { total: true })], 'cb-ecool'),
    chainRow(LC.light, [
      pstep('P_light', 2), ...usStep, op('×'), hoursStep(L('使用小时', 'Hours of use', 'Nutzungsstunden'), U.h, U.sub), op('÷ 1000 ='),
      cstep(LC.light, kwh(s.elec.lighting), { total: true })], 'cb-elight'),
    chainRow(LC.equip, [
      pstep('P_equip', 2), ...usStep, op(res ? '×' : '× ('), hoursStep(L('使用小时', 'Hours of use', 'Nutzungsstunden'), U.h, U.sub),
      ...(res ? [] : [op('+'), pstep('equipBase', 2, { unit: false }), op('×'), hoursStep(L('其余小时', 'Other hours', 'Übrige Stunden'), U.rest, L('不在使用时段', 'outside the hours of use', 'außerhalb der Nutzungszeit')), op(')')]),
      op('÷ 1000 ='), cstep(LC.equip, kwh(s.elec.equipment), { total: true })], 'cb-eequip'),
    chainRow(LC.other, [pstep('E_other', 1, { sub: L('热水、厨房、电梯、水泵', 'hot water, kitchen, lifts, pumps', 'Warmwasser, Küche, Aufzüge, Pumpen') }), ...usStep, op('='), cstep(LC.other, kwh(s.elec.other), { total: true })], 'cb-eother'),
    chainRow(L('用电', 'Electricity', 'Strom'), [
      cstep(LC.cool, fmt(s.elec.cooling, 1), { go: ['balance', '#cb-ecool'] }), op('+'), cstep(LC.light, fmt(s.elec.lighting, 1), { go: ['balance', '#cb-elight'] }), op('+'),
      cstep(LC.equip, fmt(s.elec.equipment, 1), { go: ['balance', '#cb-eequip'] }), op('+'), cstep(LC.other, fmt(s.elec.other, 1), { go: ['balance', '#cb-eother'] }), op('='),
      cstep(L('用电', 'Electricity', 'Strom'), kwh(s.elec.total), { total: true, sub: fmtK(s.elecKWh) })], 'cb-elec'),
    chainRow('CO₂', [
      cstep(L('用电', 'Electricity', 'Strom'), fmtK(s.elecKWh)), op('×'),
      cstep(L('电网排放系数', 'Grid emission factor', 'Netzemissionsfaktor'), `${S.gef.value} kg/kWh`, { chip: tierChip('observed'), go: ['params', '#pp-co2'], sub: `EMA ${S.gef.year}${S.gef.tmy ? L('（典型年取 2019）', ' (typical year: 2019)', ' (typisches Jahr: 2019)') : ''}`, title: S.gef.source }), op('='),
      cstep('CO₂', `${fmt(s.co2t, s.co2t < 100 ? 1 : 0)} t/a`, { total: true, sub: `${fmt(s.co2kg, 1)} kg/(m²·a)` })], 'cb-co2'),
  ];
  if (Math.abs(s.gfa - s.af) > 0.01 * s.af) rows.push(chainRow('EUI', [
    cstep(L('用电', 'Electricity', 'Strom'), fmtK(s.elecKWh)), op('÷'),
    cstep('GFA', `${fmt(s.gfa)} m²`, { go: ['params', '#pg-gfa'], sub: m.areas.gfaSrc }), op('='),
    cstep(L('按 GFA 的 EUI', 'EUI per GFA', 'EUI je BGF'), `${fmt(s.eui)} kWh/(m²·a)`, { total: true, sub: L('BCA 的口径', 'as BCA reports it', 'wie die BCA sie angibt') })], 'cb-eui'));
  return h('div', { class: 'card', id: 'cb-chain' },
    head(L('从制冷需求到用电和 CO₂', 'From cooling demand to electricity and CO₂', 'Vom Kühlbedarf zu Strom und CO₂'),
      L(`上方卡片的数就是这样算出来的，每 m² ${m.areas.refBasis}。带等级的一步是模型输入：点开它在参数表里的那一行和出处，可以改。`, `This is how the numbers in the cards above follow from each other, per m² ${m.areas.refBasis}. A step with a tier is a model input: it opens its row in the parameter table, with its references, where you can change it.`, `So ergeben sich die Zahlen oben auseinander, je m² ${m.areas.refBasis}. Ein Schritt mit Stufe ist eine Modelleingabe: Er öffnet seine Zeile in der Parametertabelle mit den Quellen; dort lässt sie sich ändern.`)),
    ...rows);
}

// sensible: what enters the cooled zone in the AC hours (rc5.js header, cooling balance)
const CB_SENS = () => [
  ['wall', L('外墙', 'External walls', 'Außenwände'), 'var(--c-loss)'], ['window', L('窗（传热）', 'Windows (conduction)', 'Fenster (Leitung)'), 'var(--c-loss)'],
  ['roof', L('屋顶', 'Roof', 'Dach'), 'var(--c-loss)'], ['floor', L('底层楼板', 'Lowest floor', 'Bodenplatte'), 'var(--c-loss)'], ['tb', L('热桥', 'Thermal bridges', 'Wärmebrücken'), 'var(--c-loss)'],
  ['infiltration', L('渗透风', 'Infiltration', 'Infiltration'), 'var(--c3)'], ['ventilation', L('新风', 'Outdoor air (ventilation)', 'Außenluft (Lüftung)'), 'var(--c3)'],
  ['solar', L('窗户进来的太阳', 'Sun through the windows', 'Sonne durch die Fenster'), 'var(--c2)'], ['opaque', L('墙和屋顶上的太阳（净）', 'Sun on walls and roof (net)', 'Sonne auf Wand und Dach (netto)'), 'var(--c2)'],
  ['people', L('人员', 'People', 'Personen'), 'var(--c-gain)'], ['lighting', L('照明', 'Lighting', 'Beleuchtung'), 'var(--c-gain)'], ['equipment', L('设备与插座', 'Equipment and plugs', 'Geräte und Steckdosen'), 'var(--c-gain)'],
  ['partitions', L('隔壁不开空调的房间', 'Rooms next door without AC', 'Nachbarräume ohne Klimaanlage'), 'var(--c-loss)'], ['storage', L('蓄热与时段转移', 'Storage and shift in time', 'Speicherung und zeitliche Verschiebung'), 'var(--fg-2)'],
];
const CB_LAT = () => [
  ['infiltration', L('渗透风', 'Infiltration air', 'Infiltrationsluft')], ['ventilation', L('新风', 'Outdoor air', 'Außenluft')],
  ['internal', L('人员、做饭、洗浴', 'People, cooking, bathing', 'Personen, Kochen, Duschen')], ['pulldown', L('开机除湿', 'Drying at AC start', 'Entfeuchten beim Start')],
];
function cbCommon() {
  const cb = S.sim.res.coolBalance, a = S.sim.res.annual, cf = !!a.cooledFloor;
  const fShown = cb.twoZone ? [op('×'), pstep('coolFrac', 2, { label: L('空调比例 f', 'AC share f', 'Klimaanteil f'), unit: false })] : [];
  const areaSub = cf ? L(`空调楼面那一份：全楼 × ${fmt(pval('coolFrac'), 2)}`, `the air-conditioned floor's part: building × ${fmt(pval('coolFrac'), 2)}`, `Anteil der klimatisierten Fläche: Gebäude × ${fmt(pval('coolFrac'), 2)}`) : null;
  const area = (label, A) => cstep(label, `${fmt(A)} m²`, { sub: areaSub, go: ['params', '#pp-geom'], title: L('来自轮廓、层数和窗墙比，见几何', 'From the outline, storeys and window ratio; see the geometry', 'Aus Umriss, Geschossen und Fensteranteil; siehe Geometrie') });
  const dT = cstep(L('空调时段温差 Σ(θe − T_cool)', 'AC-hour degree-hours Σ(θe − T_cool)', 'Gradstunden der Klimastunden Σ(θe − T_cool)'), `${fmt(cb.sumDT)} K·h`,
    { sub: `${fmt(cb.meanTe - cb.Tcool, 1)} K × ${fmt(cb.hours)} h`, param: 'T_cool', chip: tierChip(S.b.m.params.T_cool?.tier),
      title: L(`空调开着的 ${fmt(cb.hours)} 小时里，室外气温比设定温度 ${cb.Tcool} °C 高多少，逐时累加（室外平均 ${fmt(cb.meanTe, 1)} °C）。点开看设定温度的出处`, `Over the ${fmt(cb.hours)} hours with the AC on, how far the outdoor air is above the set point of ${cb.Tcool} °C, summed hour by hour (outdoor mean ${fmt(cb.meanTe, 1)} °C). Opens the set point and its source`, `Über die ${fmt(cb.hours)} Stunden mit laufender Klimaanlage: wie weit die Außenluft über dem Sollwert von ${cb.Tcool} °C liegt, Stunde für Stunde summiert (Außenmittel ${fmt(cb.meanTe, 1)} °C). Öffnet den Sollwert und seine Quelle`) });
  const Hs = (v) => cstep('H', `${fmt(v)} W/K`);
  const out = (v, label = L('得热', 'Gain', 'Gewinn')) => cstep(label, fmtK(v), { total: true, sub: perM2(v) });
  return { cb, cf, fShown, area, dT, Hs, out };
}
function sensCalc(key) {
  const { cb, cf, fShown, area, dT, Hs, out } = cbCommon(), S_ = cb.sens, H = cb.H, U = useHours(), res = SG.RES_TYPES.includes(S.b.m.sgType);
  const tail = (Hv, v) => [op('='), Hs(Hv), ...fShown, op('×'), dT, op('='), out(v)];
  const us = pval('useScale') ?? 1, usStep = us !== 1 ? [op('×'), pstep('useScale', 2, { unit: false })] : [];
  const AN = S.sim.ctx.AN, hUse = res ? cb.hours : cb.occHours;
  const hStep = (hrs, label = L('空调时段里的使用小时', 'Hours of use with the AC on', 'Nutzungsstunden mit Klimaanlage'), sub = res ? L('住宅：空调开的全部小时', 'housing: all AC hours', 'Wohnen: alle Klimastunden') : U.sub) => cstep(label, `${fmt(hrs)} h`, { sub });
  const fAll = cb.twoZone ? fShown : [];
  const refA = cstep(L('参考面积', 'Reference area', 'Bezugsfläche'), `${fmt(AN)} m²`, { go: ['params', '#pg-area'], chip: tierChip(S.b.m.areas.refTier), title: S.b.m.areas.refSrc });
  switch (key) {
    case 'wall': return [pstep('U_wall'), op('×'), area(L('不透明外墙', 'Opaque wall', 'Opake Außenwand'), cb.A.wall), ...tail(H.wall, S_.wall)];
    case 'window': return [pstep('U_window'), op('×'), area(L('窗', 'Windows', 'Fenster'), cb.A.window), ...tail(H.window, S_.window)];
    case 'roof': return [pstep('F_roof', 2, { unit: false }), op('×'), pstep('U_roof'), op('×'), area(L('屋顶', 'Roof', 'Dach'), cb.A.roof), ...tail(H.roof, S_.roof)];
    case 'floor': return [pstep('F_floor', 2, { unit: false }), op('×'), pstep('U_floor'), op('×'), area(L('底层楼板', 'Lowest floor', 'Bodenplatte'), cb.A.floor), ...tail(H.floor, S_.floor)];
    case 'tb': return [pstep('dU_tb'), op('×'), area(L('外围护总面积', 'Envelope area', 'Hüllfläche'), cb.A.env), ...tail(H.tb, S_.tb)];
    case 'infiltration': return [cstep(L('空气热容', 'Air heat capacity', 'Wärmekapazität der Luft'), '0.34', { sub: 'Wh/(m³·K)' }), op('×'),
      cstep(L('渗透换算', 'Infiltration per n50', 'Infiltration je n50'), fmt(pval('e_inf') ?? 0.07, 2), S.b.m.params.e_inf ? { param: 'e_inf' } : { sub: 'n = 0.07 × n50' }), op('×'), pstep('n50', 1, { unit: false }), op('×'),
      cstep(L('空气体积', 'Air volume', 'Luftvolumen'), `${fmt(cb.A.Vair)} m³`, { sub: cf ? L('空调楼面那一份', "the air-conditioned floor's part", 'Anteil der klimatisierten Fläche') : '0.8 × V', go: ['params', '#pp-geom'] }), ...tail(H.inf, S_.infiltration)];
    case 'ventilation': return [cstep(L('新风量', 'Outdoor air flow', 'Außenluftvolumenstrom'), `${fmt(cb.air.Hvent / 0.34)} m³/h`, { param: 'n_vent', chip: tierChip(S.b.m.params.n_vent?.tier),
      sub: res ? L(`n_vent ${fmt(pval('n_vent'), 2)}/h × 空调房间的空气体积`, `n_vent ${fmt(pval('n_vent'), 2)}/h × air volume of the AC rooms`, `n_vent ${fmt(pval('n_vent'), 2)}/h × Luftvolumen der klimatisierten Räume`) : L(`n_vent ${fmt(pval('n_vent'), 2)}/h × 3 m × 面积，减去渗透`, `n_vent ${fmt(pval('n_vent'), 2)}/h × 3 m × area, less infiltration`, `n_vent ${fmt(pval('n_vent'), 2)}/h × 3 m × Fläche, abzüglich Infiltration`) }), op('×'),
      cstep(L('空气热容', 'Air heat capacity', 'Wärmekapazität der Luft'), '0.34', { sub: 'Wh/(m³·K)' }), ...tail(cb.air.Hvent, S_.ventilation)];
    case 'solar': {
      const sh = S.b.m.params.shadeCtrl;
      return [pstep('g_window', 2, { label: 'g', unit: false }), op('×'), cstep('1 − F_F', fmt(1 - pval('frameFrac'), 2), { param: 'frameFrac', chip: tierChip(S.b.m.params.frameFrac?.tier) }), op('×'),
        cstep('F_W', '0.9', { title: L('ISO 13790：非垂直入射修正', 'ISO 13790 correction for non-normal incidence', 'ISO 13790: Korrektur für nicht senkrechten Einfall') }), op('×'),
        cstep(L('窗面辐照 × 面积', 'Window irradiation × area', 'Einstrahlung auf Fenster × Fläche'), fmtK(cb.irrWin), { go: ['overview', '#ov-viewer'],
          sub: sh ? L(`空调时段，含邻楼遮挡和窗帘（透过 ${fmt(sh.value, 2)}）`, `AC hours, with shading by neighbours and curtains (${fmt(sh.value, 2)})`, `Klimastunden, mit Verschattung und Vorhängen (${fmt(sh.value, 2)})`) : L('空调时段，含邻楼遮挡', 'AC hours, with shading by neighbours', 'Klimastunden, mit Verschattung'),
          title: L('立面辐照见概览的 3D 视图。窗帘在窗面辐照超过 250 W/m² 且室温超过 23 °C 时拉上', 'The facade irradiation is in the 3D view of the overview. Curtains close when the window irradiance exceeds 250 W/m² and the room is above 23 °C', 'Die Fassadeneinstrahlung zeigt die 3D-Ansicht der Übersicht. Vorhänge schließen über 250 W/m² Einstrahlung und 23 °C Raumtemperatur') }),
        ...fAll, op('='), out(S_.solar)];
    }
    case 'opaque': return [cstep(L('吸收的太阳 − 天空长波', 'Absorbed sun − sky long-wave', 'Absorbierte Sonne − langwellige Abstrahlung'), fmtK(cb.opaqueZone), { sub: L('α 墙 0.5、屋顶 0.6，R_se 0.04，h_r 4.1', 'α wall 0.5, roof 0.6, R_se 0.04, h_r 4.1', 'α Wand 0.5, Dach 0.6, R_se 0.04, h_r 4.1'), go: ['method', '#method-body'], title: 'ISO 13790 §11.3' }),
      ...fAll, op('='), out(S_.opaque), op('·'), pstep('dT_sky', 1)];
    case 'people': return [pstep('Q_int', 2), ...usStep, op('×'), refA, op('×'), hStep(hUse), ...fAll, op('÷ 1000 ='), out(S_.people)];
    case 'lighting': return [pstep('P_light', 2), ...usStep, op('×'), refA, op('×'), hStep(hUse), ...fAll, op('÷ 1000 ='), out(S_.lighting)];
    case 'equipment': return res || cb.hours === cb.occHours
      ? [pstep('P_equip', 2), ...usStep, op('×'), refA, op('×'), hStep(res ? cb.hours : cb.occHours), ...fAll, op('÷ 1000 ='), out(S_.equipment)]
      : [pstep('P_equip', 2), ...usStep, op('×'), refA, op('× ('), hStep(cb.occHours), op('+'), pstep('equipBase', 2, { unit: false }), op('×'), hStep(cb.hours - cb.occHours, L('空调时段里的其余小时', 'Other hours with the AC on', 'Übrige Stunden mit Klimaanlage'), L('不在使用时段', 'outside the hours of use', 'außerhalb der Nutzungszeit')), op(')'), ...fAll, op('÷ 1000 ='), out(S_.equipment)];
    case 'partitions': return [pstep('hPart', 1), op('×'), cstep(L('较小一区的面积', 'Floor of the smaller zone', 'Fläche der kleineren Zone'), `${fmt(Math.min(cb.fc, 1 - cb.fc) * AN)} m²`, { sub: `min(f, 1 − f) × ${fmt(AN)} m²` }), op('='),
      Hs(S.sim.res.H.cu), op('×'), cstep(L('两区表面温差', 'Surface temperature difference', 'Temperaturdifferenz der Oberflächen'), `${fmt(S.sim.res.H.cu > 0 ? (S_.partitions * 1000) / S.sim.res.H.cu : 0)} K·h`, { sub: L('空调时段，隔壁 − 空调房', 'AC hours, next door − AC room', 'Klimastunden, Nachbarraum − Klimaraum') }), op('='), out(S_.partitions)];
    case 'storage': {
      const sum = cb.sensible - S_.storage;
      return [cstep(L('逐时 5R1C 显热', 'Hourly 5R1C sensible load', 'Stündliche sensible Last (5R1C)'), fmtK(cb.sensible), { sub: perM2(cb.sensible) }), op('−'),
        cstep(L('上面各项之和', 'Sum of the items above', 'Summe der Posten oben'), fmtK(sum), { sub: L('按设定温度', 'at the set point', 'beim Sollwert') }), op('='), out(S_.storage, L('蓄热与时段转移', 'Storage and shift', 'Speicherung und Verschiebung')), op('·'),
        cb.startT != null ? cstep(L('开机时的室温', 'Room at AC start', 'Raum beim Einschalten'), `${fmt(cb.startT, 1)} °C`, { sub: L(`${fmt(cb.starts)} 次开机的平均，不开空调会到的温度`, `mean of ${fmt(cb.starts)} starts, without the AC`, `Mittel von ${fmt(cb.starts)} Starts, ohne Klimaanlage`) }) : null,
        pstep('Cm', 0, { label: L('有效热容', 'Effective heat capacity', 'Wirksame Wärmekapazität') })].filter(Boolean);
    }
    default: return [];
  }
}
function latCalc(key) {
  const { cb, fShown, out: out0 } = cbCommon(), A_ = cb.air, LT = 0.836, AN = S.sim.ctx.AN, out = (v) => out0(v, L('潜热', 'Latent', 'Latent'));
  const k = cstep(L('除湿常数', 'Latent constant', 'Latente Konstante'), `${LT}`, { sub: 'Wh/(m³ · g/kg)', title: L('ρ · h_fg = 1.2 kg/m³ × 2.5 kJ/g ÷ 3600：每 m³ 空气每 g/kg 含湿差要除掉的热。ASHRAE Fundamentals 2017 第 18 章的标准空气', 'ρ · h_fg = 1.2 kg/m³ × 2.5 kJ/g ÷ 3600: the heat to remove per m³ of air and g/kg of humidity difference. Standard air of ASHRAE Fundamentals 2017, ch. 18', 'ρ · h_fg = 1,2 kg/m³ × 2,5 kJ/g ÷ 3600: abzuführende Wärme je m³ Luft und g/kg Feuchtedifferenz. Normluft nach ASHRAE Fundamentals 2017, Kap. 18') });
  const xi = A_.xIn * 1000;
  const dx = (sum, sub) => cstep(L('含湿差 Σ(x_e − x_i)', 'Humidity difference Σ(x_e − x_i)', 'Feuchtedifferenz Σ(x_e − x_i)'), `${fmt(sum * 1000)} g/kg·h`, { param: 'RH_cool', chip: tierChip(S.b.m.params.RH_cool?.tier),
    sub: sub || L(`空调时段，室外比室内目标 ${fmt(xi, 1)} g/kg 高的部分`, `AC hours, outdoor above the indoor target of ${fmt(xi, 1)} g/kg`, `Klimastunden, außen über dem Ziel von ${fmt(xi, 1)} g/kg innen`),
    title: L(`室内目标含湿量 x_i 由设定温度 ${cb.Tcool} °C 和相对湿度 ${fmt(100 * pval('RH_cool'))}% 算出；室外更干的小时不计负值。点开看相对湿度的出处`, `The indoor target x_i follows from the set point ${cb.Tcool} °C and ${fmt(100 * pval('RH_cool'))}% relative humidity; drier outdoor hours count as zero. Opens the humidity and its source`, `Das Ziel x_i ergibt sich aus ${cb.Tcool} °C und ${fmt(100 * pval('RH_cool'))} % relativer Feuchte; trockenere Außenstunden zählen null. Öffnet die Feuchte und ihre Quelle`) });
  switch (key) {
    case 'infiltration': return [cstep(L('渗透风量', 'Infiltration air flow', 'Infiltrationsluftstrom'), `${fmt(A_.Hinf / 0.34)} m³/h`, { param: 'n50', chip: tierChip(S.b.m.params.n50?.tier), sub: `${fmt(pval('e_inf') ?? 0.07, 2)} × n50 ${fmt(pval('n50'), 1)} × V` }), op('×'), dx(A_.sumDx), op('×'), k, ...fShown, op('='), out(cb.lat.infiltration)];
    case 'ventilation': return [cstep(L('新风量', 'Outdoor air flow', 'Außenluftvolumenstrom'), `${fmt(A_.HventLat / 0.34)} m³/h`, { param: 'n_vent', chip: tierChip(S.b.m.params.n_vent?.tier), sub: L('空调时段平均', 'mean of the AC hours', 'Mittel der Klimastunden') }), op('×'),
      dx(A_.sumDxVent, L('按风量加权', 'weighted by the air flow', 'nach Luftstrom gewichtet')), op('×'), k, ...fShown, op('='), out(cb.lat.ventilation)];
    case 'internal': {
      const us = pval('useScale') ?? 1;
      return [pstep('Q_lat', 2), ...(us !== 1 ? [op('×'), pstep('useScale', 2, { unit: false })] : []), op('×'), cstep(L('参考面积', 'Reference area', 'Bezugsfläche'), `${fmt(AN)} m²`, { go: ['params', '#pg-area'] }), op('×'),
        pstep('coolFrac', 2, { label: L('空调比例 f', 'AC share f', 'Klimaanteil f'), unit: false }), op('×'), cstep(L('空调时段里的使用小时', 'Hours of use with the AC on', 'Nutzungsstunden mit Klimaanlage'), `${fmt(cb.occHours)} h`), op('÷ 1000 ='), out(cb.lat.internal)];
    }
    case 'pulldown': return [cstep(L('空调房间的空气', 'Air of the AC rooms', 'Luft der klimatisierten Räume'), `${fmt(cb.A.Vair)} m³`, { go: ['params', '#pp-geom'] }), op('×'),
      cstep(L('开机时的含湿差', 'Humidity excess at AC start', 'Feuchteüberschuss beim Einschalten'), `${fmt(cb.starts ? (A_.pullDx * 1000) / cb.starts : 0, 2)} g/kg`, { sub: L(`房间空气比目标 ${fmt(A_.xIn * 1000, 1)} g/kg 湿的部分，平均`, `room air above the target of ${fmt(A_.xIn * 1000, 1)} g/kg, mean`, `Raumluft über dem Ziel von ${fmt(A_.xIn * 1000, 1)} g/kg, Mittel`) }), op('×'),
      cstep(L('开机次数', 'AC starts', 'Einschaltvorgänge'), fmt(cb.starts), { sub: L('一年', 'a year', 'im Jahr') }), op('×'), k, ...fShown, op('='), out(cb.lat.pulldown)];
    default: return [];
  }
}
// the hour of the largest cooling load and the weather then
function cbPeakCard() {
  const hr = S.sim.res.hourly, s = S.sum, W = S.weather;
  let i = 0, best = -1;
  if (hr) for (let k = 0; k < 8760; k++) { const c = Math.max(0, -hr.Q_hc[k]) + (hr.Q_lat ? hr.Q_lat[k] : 0); if (c > best) { best = c; i = k; } }
  const d = new Date(Date.UTC(2019, 0, 1) + (i + CITY.tz) * 3600e3);
  const when = L(`${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${String(d.getUTCHours()).padStart(2, '0')}:00`, `${d.getUTCDate()} ${C.MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:00`, `${d.getUTCDate()}. ${C.MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:00`);
  const sens = hr ? Math.max(0, -hr.Q_hc[i]) : null, lat = hr?.Q_lat ? hr.Q_lat[i] : null;
  return h('div', { class: 'card', id: 'cb-peak' },
    head(L('制冷峰值负荷', 'Peak cooling load', 'Kühllast'), L('逐时 5R1C 结果里显热加潜热最大的那个小时（理想负荷，不考虑设备容量）。时刻是当地时间。', 'The hour with the largest sensible plus latent load in the hourly 5R1C run (ideal load, no equipment limit). Local time.', 'Die Stunde mit der größten sensiblen plus latenten Last der stündlichen 5R1C-Rechnung (ideale Last, ohne Leistungsgrenze). Ortszeit.')),
    h('dl', { class: 'stats' }, ...[
      [L('峰值', 'Peak', 'Spitzenwert'), `${fmt(s.peakW / 1000, s.peakW < 1e5 ? 1 : 0)} kW`], [L('单位面积', 'Per m²', 'Je m²'), `${fmt(s.peakWm2)} W/m²`],
      [L('出现时刻', 'When', 'Zeitpunkt'), hr ? when : '–'],
      [L('显热 / 潜热', 'Sensible / latent', 'Sensibel / latent'), hr ? `${fmt(sens / 1000, 1)} / ${fmt(lat / 1000, 1)} kW` : '–'],
      [L('当时室外', 'Outdoor then', 'Außen zum Zeitpunkt'), hr ? `${fmt(W.T[i], 1)} °C · ${fmt(W.RH?.[i])}%` : '–'],
    ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))));
}
function renderBalance() {
  const P = $('#p-balance'), cb = S.sim.res.coolBalance;
  if (!cb) { P.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'note' }, L('这栋楼没有空调时段，没有制冷平衡。', 'This building has no AC hours, so there is no cooling balance.', 'Dieses Gebäude hat keine Klimastunden und daher keine Kühlbilanz.')))); return; }
  const AN = S.sim.ctx.AN, m = S.b.m;
  const sens = CB_SENS().filter(([k]) => k !== 'partitions' || cb.twoZone).map(([key, label, color]) => ({ key, label, value: cb.sens[key] / AN, color, note: fmtK(cb.sens[key]) }));
  const lat = CB_LAT().map(([key, label]) => ({ key, label, value: cb.lat[key] / AN, color: 'var(--c2)', note: fmtK(cb.lat[key]) }));
  const res = SG.RES_TYPES.includes(m.sgType);
  const tipS = L(`空调开着的 ${fmt(cb.hours)} 小时里进入空调区的热，每 m² ${m.areas.refBasis}。传热和新风按设定温度 ${cb.Tcool} °C 算（与慕尼黑热平衡同一口径）。各项之和和逐时 5R1C 的显热之差记为“蓄热与时段转移”：正值是墙、楼板和家具在空调关着时存下、开机后放出的热${res ? '（住宅白天开窗，夜里才开空调，所以这一项最大）' : ''}；负值是空调时段被楼体吸收、关机后才放出的热。点一行看这一项怎么算。`,
    `Heat entering the air-conditioned zone over the ${fmt(cb.hours)} hours with the AC on, per m² ${m.areas.refBasis}. Conduction and outdoor air at the set point of ${cb.Tcool} °C (the convention of the Munich heat balance). The gap between their sum and the hourly 5R1C sensible load is "storage and shift in time": positive is heat that walls, floors and furniture stored while the AC was off and give back once it runs${res ? ' (flats have their windows open by day and AC only at night, so this item is the largest)' : ''}; negative is heat the structure takes up in the AC hours and gives off after the AC stops. Click a row to see how it is computed.`,
    `Wärme, die in den ${fmt(cb.hours)} Stunden mit laufender Klimaanlage in die klimatisierte Zone gelangt, je m² ${m.areas.refBasis}. Leitung und Außenluft beim Sollwert ${cb.Tcool} °C (wie in der Münchner Wärmebilanz). Die Differenz ihrer Summe zur stündlichen sensiblen 5R1C-Last ist „Speicherung und zeitliche Verschiebung“: positiv ist Wärme, die Wände, Decken und Möbel bei ausgeschalteter Anlage gespeichert haben und danach abgeben${res ? ' (Wohnungen lüften tagsüber über Fenster und kühlen nur nachts, daher ist dieser Posten am größten)' : ''}; negativ ist Wärme, die der Baukörper in den Klimastunden aufnimmt und nach dem Ausschalten abgibt. Ein Klick auf eine Zeile zeigt die Rechnung.`);
  const tipL = L(`除掉的水汽，每 m² ${m.areas.refBasis}。四项相加正好是潜热。空调把室内保持在 ${cb.Tcool} °C、${fmt(100 * pval('RH_cool'))}% 相对湿度。点一行看这一项怎么算。`, `Moisture removed, per m² ${m.areas.refBasis}. The four items add up to the latent load exactly. The AC holds the room at ${cb.Tcool} °C and ${fmt(100 * pval('RH_cool'))}% relative humidity. Click a row to see how it is computed.`, `Abgeführte Feuchte, je m² ${m.areas.refBasis}. Die vier Posten ergeben genau die latente Last. Die Anlage hält ${cb.Tcool} °C und ${fmt(100 * pval('RH_cool'))} % relative Feuchte. Ein Klick auf eine Zeile zeigt die Rechnung.`);
  P.replaceChildren(
    cbChainCard(),
    h('div', { class: 'grid2' },
      h('div', { class: 'card', id: 'cb-sens' }, head(L('显热从哪里来', 'Where the sensible heat comes from', 'Woher die sensible Wärme kommt'), tipS, `${fmt(S.sum.coolSens, 1)} ${KW}`), h('div', { id: 'cb-sens-bars' }), h('div', { class: 'calc', id: 'cb-sens-calc' })),
      h('div', { class: 'card', id: 'cb-lat' }, head(L('潜热从哪里来', 'Where the latent heat comes from', 'Woher die latente Wärme kommt'), tipL, `${fmt(S.sum.coolLat, 1)} ${KW}`), h('div', { id: 'cb-lat-bars' }), h('div', { class: 'calc', id: 'cb-lat-calc' }))),
    cbPeakCard());
  const vf = (it) => fmt(it.value, 1);
  const signed = sens.some((i) => i.value < 0);
  const pickS = (sel) => { C.hbars($('#cb-sens-bars'), sens, { valueFmt: vf, signed, selected: sel, onPick: (it, i) => pickS(i) }); $('#cb-sens-calc').replaceChildren(chainRow(sens[sel].label, sensCalc(sens[sel].key))); };
  const pickL = (sel) => { C.hbars($('#cb-lat-bars'), lat, { valueFmt: vf, selected: sel, onPick: (it, i) => pickL(i) }); $('#cb-lat-calc').replaceChildren(chainRow(lat[sel].label, latCalc(lat[sel].key))); };
  pickS(sens.reduce((bi, it, i, a) => (Math.abs(it.value) > Math.abs(a[bi].value) ? i : bi), 0));
  pickL(lat.reduce((bi, it, i, a) => (it.value > a[bi].value ? i : bi), 0));
}

// ---------- inputs & sources ----------
const tierOfGeom = (t) => (t === 'user' ? 'user' : t || 'assumed');
function renderParams() {
  const b = S.b, m = b.m, P = $('#params-main'), a = m.areas;
  $('#p-checks').replaceChildren();
  // uncertainty: first-order shares of the electricity per m²
  const sh = MS.varShares(S.prior).slice(0, 8);
  const varCard = sh.length ? h('div', { class: 'card', id: 'pp-var' }, head(L('不确定性来自哪里', 'Where the uncertainty comes from', 'Herkunft der Unsicherheit'),
    L('单位面积用电的先验方差按输入分解（一阶份额，近似）。橙色是估算，蓝色是查表，绿色是实测或记录值。', 'Variance of the electricity per m² in the prior, split by input (first-order shares, approximate). Orange is assumed, blue is a published table, green is observed.', 'Varianz des Stroms pro m² im Prior, nach Eingaben aufgeteilt (Anteile erster Ordnung, näherungsweise). Orange: Annahme, Blau: Tabellenwert, Grün: erfasst.')), h('div', { id: 'var-bars' })) : null;
  const COL = { observed: 'var(--pass)', published_table: 'var(--info)', assumed: 'var(--warn)', estimate: 'var(--warn)', user: 'var(--fg-2)' };
  const varLabel = (k) => (k === 'wwrScale' ? SG.PARAM_META.WWR.label : k === 'hScale' ? L('层数与高度', 'Storeys and height', 'Geschosse und Höhe') : k === 'anScale' ? L('参考面积', 'Reference area', 'Bezugsfläche') : SG.PARAM_META[k]?.label || k);
  const varTier = (k) => (k === 'wwrScale' ? m.params.WWR?.tier : k === 'hScale' ? tierOfGeom(m.geomTier.height) : k === 'anScale' ? a.refTier : m.params[k]?.tier) || 'assumed';
  // weather
  const W = S.weatherIndex;
  const wCard = h('div', { class: 'card', id: 'pp-weather' }, head(L('气象', 'Weather', 'Wetter'), L('Open-Meteo 的 ERA5 逐时数据，新加坡中部格点；典型年按 2010–2025 年逐月挑选。CDD18 是 18 °C 以上的度日。', 'Hourly ERA5 data from Open-Meteo, grid point in central Singapore; the typical year picks one month per calendar month from 2010–2025. CDD18 are degree days above 18 °C.', 'Stündliche ERA5-Daten von Open-Meteo, Gitterpunkt in Zentral-Singapur; das typische Jahr wählt je Kalendermonat einen Monat aus 2010–2025. CDD18 sind Gradtage über 18 °C.')),
    h('div', { class: 'row' }, h('select', { onchange: async (e) => { S.weatherKey = e.target.value; S.weather = await loadWeather(S.weatherKey); S.gef = MS.gridEF(S.A, S.weatherKey === 'tmy' ? 'TMY' : +S.weatherKey); await rebuild(); } },
      h('option', { value: 'tmy', selected: S.weatherKey === 'tmy' }, L(`典型气象年（${W.tmy.Tmean} °C，CDD18 ${W.tmy.CDD18}）`, `Typical year (${W.tmy.Tmean} °C, CDD18 ${W.tmy.CDD18})`, `Typisches Jahr (${W.tmy.Tmean} °C, CDD18 ${W.tmy.CDD18})`)),
      ...Object.entries(W.years).reverse().map(([y, v]) => h('option', { value: y, selected: S.weatherKey === y }, L(`${y} 年实际（${v.Tmean} °C，CDD18 ${v.CDD18}）`, `${y} actual (${v.Tmean} °C, CDD18 ${v.CDD18})`, `${y} tatsächlich (${v.Tmean} °C, CDD18 ${v.CDD18})`))))));
  // type, era, storeys, areas: each with its tier and source
  const typeSel = h('select', { onchange: (e) => { S.state.type = e.target.value || null; rebuild({ geometry: true }); } },
    h('option', { value: '' }, L('按规则', 'By the rules', 'Nach den Regeln')), ...Object.entries(SG.TYPE_CN).map(([k, v]) => h('option', { value: k, selected: S.state.type === k }, v)));
  const eras = SG.erasOf(m.sgType);
  const eraSel = eras ? h('select', { onchange: (e) => { S.state.era = e.target.value || null; rebuild(); } },
    h('option', { value: '' }, L('按先验', 'From the prior', 'Aus dem Prior')), ...eras.map((e) => h('option', { value: e.id, selected: S.state.era === e.id }, LANG === 'en' ? `${SG.eraLabel(e)} · ${e.label_en}` : SG.eraLabel(e)))) : null;
  const flIn = h('input', { type: 'number', step: 1, min: 1, value: m.floors, style: 'width:70px', onchange: (e) => { const v = parseInt(e.target.value, 10); if (v > 0) { S.state.floors = v; rebuild({ geometry: true }); } } });
  const gRow = (id, k, v, tier, src, input) => h('tr', { id }, h('td', { class: 'nm' }, k), h('td', { class: 'num' }, input || v), h('td', {}, tierChip(tier)), h('td', { class: 'note' }, src || ''));
  const era = eras ? eras.find((e) => e.id === b.asg.eraId) : null;
  const geo = h('table', { class: 't' }, h('tr', {}, h('th', {}, L('项目', 'Item', 'Größe')), h('th', {}, L('取值', 'Value', 'Wert')), h('th', {}, L('等级', 'Tier', 'Stufe')), h('th', {}, L('来源', 'Source', 'Quelle'))),
    gRow('pg-type', L('类型', 'Type', 'Typ'), '', m.usageTier || 'assumed', m.usageSrc, h('span', {}, typeSel, ' ', SG.TYPE_CN[m.sgType], m.sgVariant ? ` · ${SG.variantLabel(m.sgVariant)}` : '')),
    era ? gRow('pg-era', L('年代', 'Era', 'Baualtersklasse'), '', S.state.era ? 'user' : b.eraInfo.tier, `${b.eraInfo.src}${b.eraInfo.kind === 'prior' ? ' · ' + eras.map((e) => `${SG.eraLabel(e)} ${fmt(100 * b.eraInfo.p[e.id])}%`).join(', ') : ''} · ${era.basis || era.evidence || ''}`, eraSel) : null,
    gRow('pg-storeys', L('层数', 'Storeys', 'Geschosse'), '', tierOfGeom(m.geomTier.floors), m.geomSrc.floors, flIn),
    gRow('pg-height', L('高度', 'Height', 'Höhe'), `${fmt(m.height, 1)} m${m.geomPrior.h90 > m.geomPrior.h10 ? ` (P10–P90 ${fmt(m.geomPrior.h10, 0)}–${fmt(m.geomPrior.h90, 0)})` : ''}`, tierOfGeom(m.geomTier.height), m.geomSrc.height),
    m.voidDeck > 0 ? gRow('pg-void', L('首层（架空层）', 'First storey (void deck)', 'Erdgeschoss (Void Deck)'), `${m.voidDeck} m`, 'assumed', L('不在住户和外围护内', 'outside the flats and the envelope', 'außerhalb der Wohnungen und der Hülle')) : null,
    gRow('pg-fp', L('占地', 'Footprint', 'Grundfläche'), `${fmt(a.footprint)} m²`, 'observed', L('OSM 轮廓', 'OSM outline', 'OSM-Umriss')),
    gRow('pg-area', L('参考面积', 'Reference area', 'Bezugsfläche'), `${fmt(a.netFloor)} m²`, a.refTier, `${a.refBasis} · ${a.refSrc}`),
    gRow('pg-gfa', 'GFA', `${fmt(a.gfa)} m²`, SG.RES_TYPES.includes(m.sgType) ? 'assumed' : a.refTier, a.gfaSrc),
    gRow('pg-win', L('窗面积', 'Window area', 'Fensterfläche'), `${fmt(a.window)} m²`, m.params.WWR?.tier || 'assumed', L(`外露立面 ${fmt(a.facadeExposed)} m² × 窗墙比`, `exposed facade ${fmt(a.facadeExposed)} m² × WWR`, `freiliegende Fassade ${fmt(a.facadeExposed)} m² × Fensterflächenanteil`)),
    m.x?.lu ? gRow('pg-lu', L('URA 2019 用地', 'URA 2019 land use', 'URA-2019-Flächennutzung'), `${m.x.lu}${m.x.gpr ? ` · GPR ${m.x.gpr}` : m.x.gprt ? ` · ${m.x.gprt}` : ''}`, 'observed', `${m.x.pa || ''}${m.x.sz ? ' / ' + m.x.sz : ''}`) : null,
    m.x?.gba ? gRow('pg-gba', 'GlobalBuildingAtlas', `${m.x.gba.h} m`, 'estimate', L(`LoD1 高度，方差 ${m.x.gba.var} m²；30 m 以上只作下限`, `LoD1 height, variance ${m.x.gba.var} m²; from 30 m a lower bound only`, `LoD1-Höhe, Varianz ${m.x.gba.var} m²; ab 30 m nur Untergrenze`)) : null,
  );
  const geoCard = h('div', { class: 'card', id: 'pp-geom' }, head(L('类型、年代与几何', 'Type, era and geometry', 'Typ, Baualter und Geometrie'), L('改类型、年代或层数会立即重算，等级变成“用户填写”。', 'Changing the type, era or storeys recomputes at once; the tier becomes "User input".', 'Eine Änderung von Typ, Baualter oder Geschossen wird sofort neu berechnet; die Stufe wird „Eigene Eingabe“.')), h('div', { class: 'tblwrap' }, geo));
  // BCA attributes that enter the model
  const bc = b.bca;
  const bcaCard = bc ? h('div', { class: 'card', id: 'pp-bca' }, head(L('BCA 名单给出的输入', 'Inputs from the BCA listing', 'Eingaben aus der BCA-Liste'), L('名单里的楼本身的属性作为实测输入；EUI 不进入模型。', 'Attributes of the listed building enter as observed inputs; its EUI does not enter the model.', 'Merkmale des gelisteten Gebäudes gehen als erfasste Eingaben ein; sein EUI geht nicht in das Modell ein.'), bc.row.name),
    h('ul', { class: 'refs' }, ...[bc.coolFrac?.src, bc.system?.src || (bc.systemNote ? `AC system: ${bc.systemNote} → ${SG.TYPE_CN[m.sgType]} default` : null), bc.cop?.src, bc.gfa?.src, b.eraInfo.kind === 'bca' ? b.eraInfo.src : null, bc.occ?.src].filter(Boolean).map((t) => h('li', {}, tierChip('observed'), ' ', t)))) : null;
  // every parameter
  const tbl = h('table', { class: 't' }, h('tr', {}, h('th', {}, L('参数', 'Parameter', 'Parameter')), h('th', {}, L('取值', 'Value', 'Wert')), h('th', {}, L('来源', 'Source', 'Quelle')), h('th', {}, 'P10–P90')));
  const groups = {};
  for (const [k, meta] of Object.entries(SG.PARAM_META)) (groups[meta.group] = groups[meta.group] || []).push(k);
  for (const [g, keys] of Object.entries(groups)) {
    tbl.append(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, g)));
    for (const k of keys) {
      const pv = m.params[k];
      if (!pv || pv.value == null || typeof pv.value !== 'number') continue;
      const input = h('input', { type: 'number', step: 'any', value: +(+pv.value).toPrecision(4), onchange: (e) => { const v = e.target.value === '' ? null : parseFloat(e.target.value); if (v == null) delete S.state.user[k]; else S.state.user[k] = v; rebuild(); } });
      const refs = SG.sourceRefs(`${pv.source} ${pv.note || ''}`);
      const ref = h('tr', { class: 'refrow', id: `ref-${k}`, hidden: true }, h('td', { colspan: 4 },
        h('div', { class: 'note' }, [pv.source, pv.note].filter(Boolean).join(' · ')),
        refs.length ? h('ul', { class: 'refs' }, ...refs.map((r) => h('li', {}, h('b', {}, r.id), ` · ${r.ref}`, r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, L(' 打开原文 ↗', ' open ↗', ' öffnen ↗')) : null))) : null));
      const chip = h('button', { type: 'button', class: `src ${SG.TIER_CLASS[pv.tier] || 'default'} srcbtn`, 'aria-expanded': 'false', title: L('查看出处', 'Show the references', 'Quellen anzeigen'),
        onclick: (e) => { ref.hidden = !ref.hidden; e.currentTarget.setAttribute('aria-expanded', String(!ref.hidden)); } }, SG.TIER_LABEL[pv.tier] || pv.tier);
      tbl.append(h('tr', { id: `pr-${k}` },
        h('td', { class: 'nm', title: pv.note || null }, SG.PARAM_META[k].label),
        h('td', { class: 'num' }, input, ' ', h('span', { class: 'note' }, SG.PARAM_META[k].unit)),
        h('td', {}, chip, pv.tier === 'user' ? h('button', { class: 'btn small', style: 'margin-left:6px', onclick: () => { delete S.state.user[k]; rebuild(); } }, L('撤销', 'Undo', 'Rückgängig')) : null),
        h('td', { class: 'num' }, pv.dist === 'fixed' ? h('span', { class: 'note' }, L('固定', 'fixed', 'fest')) : `${fmt(pv.p10, 2)} – ${fmt(pv.p90, 2)}`)), ref);
    }
  }
  // cooling system and grid factor
  const sy = S.A.systems[b.asg.sysKey];
  tbl.append(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, L('制冷系统与电网', 'Cooling system and grid', 'Kälteanlage und Netz'))),
    h('tr', { id: 'pp-sys' }, h('td', { class: 'nm', title: sy.scope }, L('系统', 'System', 'System')), h('td', {}, SG.sysLabel(b.asg.sysKey)), h('td', {}, tierChip(b.asg.sysSrc ? 'observed' : A_tier(m.sgType))), h('td', { class: 'note' }, b.asg.sysSrc || shareText(b.asg.systemShares))),
    h('tr', { id: 'pp-co2' }, h('td', { class: 'nm' }, L('电网排放系数', 'Grid emission factor', 'Netzemissionsfaktor')), h('td', { class: 'num' }, `${S.gef.value} kg/kWh`), h('td', {}, tierChip('observed')), h('td', { class: 'note' }, `${S.gef.source}; ${S.gef.year}${S.gef.tmy ? L('（典型年取 2019）', ' (typical year: 2019)', ' (typisches Jahr: 2019)') : ''}`)));
  const tblCard = h('div', { class: 'card', id: 'pp-table' }, head(L('全部物理参数', 'All physical parameters', 'Alle physikalischen Parameter'), L('值、P10–P90、来源和等级来自 data/archetypes_sg.json。改任何一个值都会立即重算。点等级看出处。', 'Values, P10–P90, sources and tiers from data/archetypes_sg.json. Changing a value recomputes at once. Click a tier for its references.', 'Werte, P10–P90, Quellen und Stufen aus data/archetypes_sg.json. Jede Änderung wird sofort neu berechnet. Ein Klick auf die Stufe zeigt die Quellen.'),
    h('span', { class: 'tierkey' }, ...TIERS.map((k) => h('span', { class: `src ${SG.TIER_CLASS[k]}` }, SG.TIER_LABEL[k])))), h('div', { class: 'tblwrap' }, tbl));
  P.replaceChildren(...[varCard, wCard, geoCard, bcaCard, tblCard].filter(Boolean));
  if (varCard) C.hbars($('#var-bars'), sh.map((it) => ({ label: varLabel(it.key), value: it.share * 100, color: COL[varTier(it.key)], note: SG.TIER_LABEL[varTier(it.key)] })), { unit: '%', max: Math.max(...sh.map((i) => i.share * 100)) * 1.1, valueFmt: (it) => `${fmt(it.value)}%` });
}
const A_tier = (type) => S.A.types[type].systemPrior?.tier || 'assumed';
const shareText = (sh) => (sh ? Object.entries(sh).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${SG.sysLabel(k)} ${fmt(v * 100)}%`).join(' · ') : '');

// ---------- method ----------
function renderMethod() {
  const P = $('#method-body');
  $('#p-export').replaceChildren();
  if (P.dataset.done) return;
  P.dataset.done = '1';
  const gef = MS.gridEF(S.A, 'TMY');
  // smallest BCA training building of each calibrated type (data/sg/calib_commercial.json meta.domain)
  const DT = { office: ['办公', 'office', 'Büro'], retail: ['零售', 'retail', 'Einzelhandel'], hotel: ['酒店', 'hotel', 'Hotel'], mixed: ['综合楼', 'mixed', 'gemischt'] };
  const dom = (i) => Object.entries(DT).filter(([t]) => S.A.types[t]?.calibDomain).map(([t, n]) => `${n[i]} ${fmt(S.A.types[t].calibDomain.gfaMin)} m²`).join(i === 0 ? '，' : ', ');
  P.innerHTML = L(`<div class="card method">
  <h3>新加坡页面怎么算</h3>
  <h4>1. 楼与属性</h4><p>轮廓、标签和地址来自 OpenStreetMap（Geofabrik 提取，${S.osmInfo.date}，ODbL）。每个轮廓另外接上：HDB 物业信息（经 HDB 建筑轮廓匹配：建成年份、最高层、各户型户数）、URA 2019 总体规划的用地和容积率、规划区和分区、GlobalBuildingAtlas LoD1 高度，以及 BCA 建筑能耗名单（data.gov.sg 的 2017–2020 年清单，按邮编、地址和名字匹配）。标定和验证另外用了 BCA 网站的 BEBR 2022–2025 年数据；按 BCA 网站条款，这份数据不随公开版发布，只有由它算出的统计和参数在页面上。</p>
  <h4>2. 类型、年代、层数</h4><p>类型依次取 HDB 物业信息、BCA 名单的建筑类型、OSM 的 building 标签、URA 用地规则；停车楼、亭子、棚子和屋顶没有空调，不计算。年代取 HDB 建成年份、BCA 的 TOP/CSC 年份或 OSM start_date，没有时按各年代在 1960–2025 年里的年数加权。组屋层数取 HDB 最高层，首层（架空层或商铺）不算在住户和外围护里；其他楼取 OSM 的 building:part 和 building:levels、OSM 高度、GBA 高度（30 m 以下；30 m 以上只作下限），最后才用类型规则。</p>
  <h4>3. 输入</h4><p>每个物理输入都带值、P10–P90、来源和等级（<code>data/archetypes_sg.json</code>、<code>data/archetypes_sg_sources.md</code>）：非住宅按 BCA 围护规范的年代，组屋按 HDB 构造年代，住户用电和空调习惯来自 SingStat、EMA 和 NEA（空调 22–06 点开在卧室，设定 25 °C），非住宅的时段和负荷来自 BCA Green Mark。BCA 名单里的楼用它自己的空调面积比例、空调系统、冷站效率（COP = 3.517 ÷ kW/RT）、GFA、TOP 年份和入住率；它的 EUI 不是输入。办公、零售、酒店和综合楼的设备负荷、其他用电和使用强度按 BCA 实测 EUI 标定（一半的楼，2023 年），只用于 BCA 训练楼面积范围内的楼；住宅的空调比例和基础用电按 EMA 每户用电标定（2018–2019 年）。这些值的等级是“实测标定”。</p>
  <h4>4. 热模型</h4><p>ISO 13790 逐时 5R1C，加上热带的项（<code>js/rc5.js</code>）：室外湿度和室内水汽带来的潜热，只有部分面积开空调时分两区（住宅：夜里开卧室空调，其余时间开窗），制冷用电 = 显热与潜热 ÷ 季节 COP，照明和设备逐时计，其他用电按年计。当地时间 UTC+8，新加坡公众假期（人力部，data.gov.sg；2020–2027 年，其他年份借最近一年）。气象：Open-Meteo 的 ERA5 逐时数据，典型年取自 2010–2025 年。</p>
  <h4>5. 结果</h4><p>按类型的参考面积计（组屋是户内面积，私宅是住宅面积，其余是 GFA）；EUI 按 GFA，便于和 BCA 对照。CO₂ = 用电 × EMA 电网排放系数（气象年份的系数，典型年取 2019 年的 ${gef.value} kg/kWh）。区间是 ${N_DRAWS} 次输入抽样的 P10–P90（各输入独立，过 P10、值、P90 的分段正态分布），年代未知时深色带固定在所用年代。</p>
  <h4>6. 验证</h4><p><b>商业楼逐栋（BCA）。</b>825 栋有实测 EUI 的 BCA 楼按楼一次分成两半：用一半 2023 年的 EUI 标定输入，再在另一半 2024 年的 EUI 上只跑一次。在这 310 栋办公、商场、酒店和综合楼上，逐栋误差的中位数是 26%；不用模型、直接取同类中位数是 27%，标定前的模型是 31%；83% 的实测值落在模型的 P10–P90 内。分类型：办公 25%（同类中位数 23%），零售 28%（29%），酒店 18%（20%），综合楼 32%（32%）。所以逐栋来看，模型和按类型查表一样好，但不更好：同类楼之间它几乎排不出先后（办公 Spearman 0.11），对数误差平方的 92% 来自同类楼之间的差异。有机房和实验室的楼低估 2–5 倍，没有满负荷使用的楼高估 4–7 倍。名单里的楼，页面在模型旁边给出实测 EUI。</p>
  <p><b>住宅汇总（EMA）。</b>组屋和私宅没有开放的逐栋或逐户电表数据，只能和 EMA 按规划区和住宅类型公布的每户平均用电比较。用 2018–2019 年标定，在 2022–2024 年检验：每种住宅类型的全国水平都是 EMA 的 0.93–0.97（标定前 0.82–0.95；直接沿用 2018–2019 年的 EMA 均值是 0.92–0.99）。月份规律对（相关 0.72–0.90），季节起伏只有 EMA 的一半左右。在规划区之间，只有 HDB 四房式胜过全国均值（r 0.51）。标定出的空调比例是等效值，也替模型缺少的季节性兜底，不是实测比例。</p>
  <p><b>物理（EnergyPlus）。</b>16 栋楼用相同输入在 EnergyPlus 26.1 里算，差值是 EnergyPlus 减本模型，除以本模型。按当前模型（2026-11-26 重跑）：全空调时制冷平均差 −2.0%（−8.6% 到 +7.4%），两区情形（住宅、学校和诊所等的默认做法）−6.5%（−11% 到 0%），商业楼按空调楼面算 −4.4%（−7% 到 0%），逐月相关 0.989–0.999。第一轮对比的分解显示，吻合有一部分来自内外表面换热的相反偏差互相抵消。</p>
  ${cityText('zh')}
  <h4>局限</h4><ul><li>每个轮廓一个单区棱柱；裙楼上的塔楼按楼面摊到整个轮廓。</li><li>GBA 高度在 30 m 以上饱和，只作下限。</li><li>住宅结果主要取决于空调使用习惯；组屋和私宅没有开放的逐栋实测，只能和 EMA 的汇总数据比较。</li><li>BCA 的 EUI 是楼内电表；区域供冷的楼不含买来的冷水。</li><li>全岛只用一条气象序列（ERA5，按樟宜站订正），没有城市热岛。</li><li>商业楼的标定值只用在 BCA 训练楼的面积范围内（各类型最小一栋：${dom(0)}）；更小的店铺、店屋和办公楼用表值，并按分体或多联机空调计，这里没有数据能检验。</li><li>机房、实验室和工业生产的用电不在模型里。</li><li>组屋立面上的太阳辐射比 EnergyPlus 低 15–30%。</li></ul>
  <h4>数据与许可</h4><p>${creditsText('zh')}</p></div>`,
  `<div class="card method">
  <h3>How the Singapore page works</h3>
  <h4>1. Buildings and attributes</h4><p>Outlines, tags and addresses come from OpenStreetMap (Geofabrik extract, ${S.osmInfo.date}, ODbL). Joined to each outline: HDB Property Information through the HDB building footprints (completion year, highest floor, flats by type), URA Master Plan 2019 land use and plot ratio, planning area and subzone, GlobalBuildingAtlas LoD1 height, and the BCA building energy listings (the data.gov.sg listings 2017–2020, matched by postcode, address and name). The calibration and validation also used BCA's BEBR data 2022–2025 from the BCA website; under the BCA website terms it is not part of the public version, only the statistics and parameters derived from it are on the page.</p>
  <h4>2. Type, era, storeys</h4><p>The type comes from HDB Property Information, then the BCA building type, then the OSM building tag, then rules on the URA land use; car parks, pavilions, sheds and roofs have no AC and are not computed. The era comes from the HDB completion year, the BCA TOP/CSC year or OSM start_date; without one, the eras are weighted by their years within 1960–2025. HDB storeys are the highest floor level; the first storey (void deck or shops) is outside the flats and the envelope. Other buildings take OSM building:part and building:levels, OSM height, the GBA height (below 30 m; from 30 m a lower bound only), and the type rule last.</p>
  <h4>3. Inputs</h4><p>Every physical input carries a value, P10–P90, source and tier (<code>data/archetypes_sg.json</code>, <code>data/archetypes_sg_sources.md</code>): BCA envelope codes by era for non-residential buildings, HDB construction by era, SingStat, EMA and NEA for the use of flats (AC in the bedrooms 22–06 h, 25 °C), BCA Green Mark schedules and loads otherwise. A building in the BCA listing takes its own AC floor share, AC system, plant efficiency (COP = 3.517 ÷ kW/RT), GFA, TOP year and occupancy; its EUI is not an input. Plug loads, other electricity and use intensity of offices, retail, hotels and mixed developments are calibrated on BCA measured EUI (half of the buildings, 2023) and apply within the size range of those buildings; the AC share and base loads of housing are calibrated on EMA household electricity (2018–2019). Their tier is “calibrated”.</p>
  <h4>4. Thermal model</h4><p>ISO 13790 hourly 5R1C with the tropical terms of <code>js/rc5.js</code>: latent load from outdoor humidity and indoor moisture, two zones when only part of the floor is cooled (flats: bedroom AC at night, windows open otherwise), cooling electricity = sensible and latent load ÷ seasonal COP, lighting and equipment hourly, other electricity per year. Local time UTC+8, Singapore public holidays (Ministry of Manpower via data.gov.sg; 2020–2027, other years borrow the nearest listed year). Weather: hourly ERA5 from Open-Meteo, typical year from 2010–2025.</p>
  <h4>5. Results</h4><p>Per m² of the type's reference area (flat area for HDB blocks, dwelling area for private housing, GFA otherwise); EUI per m² GFA for the comparison with BCA. CO₂ = electricity × EMA grid emission factor of the weather year (the typical year takes 2019, ${gef.value} kg/kWh). Ranges are P10–P90 of ${N_DRAWS} draws of the inputs (independent, two-piece normal through P10, value and P90); with the era unknown, the dark band keeps the era used.</p>
  <h4>6. Validation</h4><p><b>Commercial buildings, one by one (BCA).</b> 825 BCA buildings with measured EUI were split once into two halves by building: the inputs were calibrated on the 2023 EUI of one half, and the model was then run once on the 2024 EUI of the other. On those 310 offices, malls, hotels and mixed developments the median error per building is 26 %, against 27 % for the median of the type (no model) and 31 % before calibration; 83 % of the measured values lie inside the model's P10–P90. By type: offices 25 % (type median 23 %), retail 28 % (29 %), hotels 18 % (20 %), mixed developments 32 % (32 %). Per building the model is therefore as good as a lookup by type, not better: within a type it hardly ranks the buildings (offices Spearman 0.11), and 92 % of its squared log error is scatter between buildings of the same type. It puts buildings with data rooms and laboratories 2–5 times too low and buildings not fully in use 4–7 times too high. For a building in the listing the page shows the measured EUI beside the model.</p>
  <p><b>Housing, in aggregate (EMA).</b> HDB blocks and private housing have no open meter data per building or per flat, only EMA's average electricity per household account by planning area and dwelling type. Calibrated on 2018–2019 and tested on 2022–2024, the national level is 0.93–0.97 of EMA for every dwelling type (0.82–0.95 before calibration; carrying the 2018–2019 EMA mean forward gives 0.92–0.99). The months are right (correlation 0.72–0.90), the seasonal swing is about half of EMA's. Between planning areas only HDB 4-room flats beat the national mean (r 0.51). The calibrated AC share is an effective value that also stands in for the missing seasonality, not a measured share.</p>
  <p><b>Physics (EnergyPlus).</b> 16 buildings with the same inputs in EnergyPlus 26.1; the difference is EnergyPlus minus this model, divided by this model. On the current model (rerun on 2026-11-26): with full AC the cooling differs by −2.0 % on average (−8.6 to +7.4 %), in the two-zone case (the default for housing, schools, clinics and the like) by −6.5 % (−11 to 0 %), for commercial buildings with the cooled-floor rule by −4.4 % (−7 to 0 %); monthly correlation 0.989–0.999. The decomposition of the first comparison shows that part of the agreement comes from opposite differences in the interior and exterior surface heat transfer.</p>
  ${cityText('en')}
  <h4>Limits</h4><ul><li>One single-zone prism per outline; towers on a podium are spread over the outline by floor area.</li><li>GBA heights saturate above 30 m and serve only as a lower bound.</li><li>Results for housing depend mostly on how the AC is used; flats and condominiums have no open per-building measurements, only the EMA aggregates.</li><li>BCA EUI is the building's own meter; buildings on district cooling exclude the purchased chilled water.</li><li>One weather series for the whole island (ERA5 corrected to Changi), no urban heat island.</li><li>Calibrated values for commercial buildings apply only within the size range of the BCA training buildings (smallest of each type: ${dom(1)}); smaller shops, shophouses and offices take the table values and split or VRF units, which no data here tests.</li><li>Data rooms, laboratories and industrial processes are not modelled.</li><li>Solar gains on HDB facades are 15–30 % below those of EnergyPlus.</li></ul>
  <h4>Data and licences</h4><p>${creditsText('en')}</p></div>`,
  `<div class="card method">
  <h3>So rechnet die Singapur-Seite</h3>
  <h4>1. Gebäude und Merkmale</h4><p>Umrisse, Tags und Adressen aus OpenStreetMap (Geofabrik-Auszug, ${S.osmInfo.date}, ODbL). Zu jedem Umriss kommen: HDB Property Information über die HDB-Gebäudeumrisse (Fertigstellungsjahr, oberstes Geschoss, Wohnungen nach Typ), Flächennutzung und Geschossflächenzahl des URA Master Plan 2019, Planungsgebiet und Teilgebiet, die LoD1-Höhe des GlobalBuildingAtlas und die BCA-Gebäudeenergielisten (die data.gov.sg-Listen 2017–2020, über Postleitzahl, Adresse und Namen zugeordnet). Kalibrierung und Validierung nutzten zusätzlich die BEBR-Daten 2022–2025 von der BCA-Website; nach deren Nutzungsbedingungen gehören sie nicht zur öffentlichen Version, auf der Seite stehen nur die daraus abgeleiteten Statistiken und Parameter.</p>
  <h4>2. Typ, Baualter, Geschosse</h4><p>Der Typ kommt aus HDB Property Information, dann aus dem BCA-Gebäudetyp, dann aus dem OSM-Tag building, dann aus Regeln zur URA-Flächennutzung; Parkhäuser, Pavillons, Schuppen und Dächer haben keine Klimaanlage und werden nicht gerechnet. Das Baualter kommt aus dem HDB-Fertigstellungsjahr, dem BCA-Jahr TOP/CSC oder OSM start_date; ohne Angabe werden die Klassen nach ihren Jahren zwischen 1960 und 2025 gewichtet. HDB-Geschosse: das oberste Geschoss; das Erdgeschoss (Void Deck oder Läden) liegt außerhalb der Wohnungen und der Hülle. Andere Gebäude nehmen OSM building:part und building:levels, OSM height, die GBA-Höhe (unter 30 m; ab 30 m nur Untergrenze) und zuletzt die Typregel.</p>
  <h4>3. Eingaben</h4><p>Jede physikalische Eingabe hat Wert, P10–P90, Quelle und Stufe (<code>data/archetypes_sg.json</code>, <code>data/archetypes_sg_sources.md</code>): BCA-Hüllvorschriften nach Baualter für Nichtwohngebäude, HDB-Bauweise nach Baualter, SingStat, EMA und NEA für die Nutzung der Wohnungen (Klimaanlage in den Schlafzimmern 22–6 Uhr, 25 °C), sonst Zeitpläne und Lasten von BCA Green Mark. Ein Gebäude der BCA-Liste nimmt seinen eigenen klimatisierten Flächenanteil, sein Klimasystem, die Effizienz der Kältezentrale (COP = 3,517 ÷ kW/RT), BGF, TOP-Jahr und Belegung; sein EUI ist keine Eingabe. Gerätelasten, sonstiger Strom und Nutzungsintensität von Büros, Einzelhandel, Hotels und gemischten Bauten sind am gemessenen BCA-EUI kalibriert (die Hälfte der Gebäude, 2023) und gelten im Größenbereich dieser Gebäude; Klimaanteil und Grundlasten des Wohnens sind am EMA-Haushaltsstrom kalibriert (2018–2019). Ihre Stufe ist „kalibriert“.</p>
  <h4>4. Thermisches Modell</h4><p>Stündliches 5R1C nach ISO 13790 mit den tropischen Termen von <code>js/rc5.js</code>: latente Last aus Außenfeuchte und innerer Feuchte, zwei Zonen, wenn nur ein Teil der Fläche gekühlt wird (Wohnungen: nachts Klimaanlage im Schlafzimmer, sonst offene Fenster), Kühlstrom = sensible und latente Last ÷ saisonale Leistungszahl, Licht und Geräte stündlich, sonstiger Strom jährlich. Ortszeit UTC+8, Feiertage Singapurs (Ministry of Manpower über data.gov.sg; 2020–2027, andere Jahre nehmen das nächste gelistete Jahr). Wetter: stündliche ERA5-Daten von Open-Meteo, typisches Jahr aus 2010–2025.</p>
  <h4>5. Ergebnisse</h4><p>Je m² Bezugsfläche des Typs (Wohnfläche bei HDB-Blöcken und privatem Wohnen, sonst BGF); EUI je m² BGF für den Vergleich mit der BCA. CO₂ = Strom × EMA-Netzemissionsfaktor des Wetterjahres (das typische Jahr nimmt 2019, ${gef.value} kg/kWh). Bandbreiten sind P10–P90 aus ${N_DRAWS} Ziehungen der Eingaben (unabhängig, zweiteilige Normalverteilung durch P10, Wert und P90); bei unbekanntem Baualter hält das dunkle Band die verwendete Klasse fest.</p>
  <h4>6. Validierung</h4><p><b>Gewerbebauten einzeln (BCA).</b> 825 BCA-Gebäude mit gemessenem EUI wurden einmal nach Gebäuden in zwei Hälften geteilt: Die Eingaben wurden am EUI 2023 der einen Hälfte kalibriert, danach lief das Modell einmal auf dem EUI 2024 der anderen. Auf diesen 310 Büros, Einkaufszentren, Hotels und gemischten Bauten liegt der Median des Fehlers je Gebäude bei 26 %, gegen 27 % für den Median des Typs (ohne Modell) und 31 % vor der Kalibrierung; 83 % der Messwerte liegen im P10–P90 des Modells. Nach Typ: Büros 25 % (Typmedian 23 %), Einzelhandel 28 % (29 %), Hotels 18 % (20 %), gemischte Bauten 32 % (32 %). Je Gebäude ist das Modell also so gut wie ein Tabellenwert nach Typ, nicht besser: Innerhalb eines Typs ordnet es die Gebäude kaum (Büros Spearman 0,11), und 92 % des quadrierten logarithmischen Fehlers sind Streuung zwischen Gebäuden desselben Typs. Gebäude mit Rechenräumen und Laboren schätzt es 2- bis 5-mal zu niedrig, nicht voll genutzte Gebäude 4- bis 7-mal zu hoch. Für ein Gebäude der Liste zeigt die Seite den gemessenen EUI neben dem Modell.</p>
  <p><b>Wohnen in der Summe (EMA).</b> Für HDB-Blöcke und privates Wohnen gibt es keine offenen Zählerdaten je Gebäude oder Wohnung, nur den mittleren Strom je Haushaltskonto der EMA nach Planungsgebiet und Wohnform. Kalibriert auf 2018–2019 und geprüft auf 2022–2024 liegt das landesweite Niveau für jede Wohnform bei 0,93–0,97 des EMA-Werts (vor der Kalibrierung 0,82–0,95; der fortgeschriebene EMA-Mittelwert 2018–2019 ergibt 0,92–0,99). Die Monate stimmen (Korrelation 0,72–0,90), der jahreszeitliche Ausschlag ist etwa halb so groß wie bei der EMA. Zwischen den Planungsgebieten schlägt nur HDB 4-Zimmer den Landesmittelwert (r 0,51). Der kalibrierte Klimaanteil ist ein effektiver Wert, der auch die fehlende Saisonalität auffängt, kein gemessener Anteil.</p>
  <p><b>Physik (EnergyPlus).</b> 16 Gebäude mit denselben Eingaben in EnergyPlus 26.1; die Abweichung ist EnergyPlus minus dieses Modell, geteilt durch dieses Modell. Mit dem aktuellen Modell (am 26.11.2026 neu gerechnet): Bei Vollklimatisierung weicht die Kühlung im Mittel um −2,0 % ab (−8,6 bis +7,4 %), im Fall mit zwei Zonen (Standard für Wohnbauten, Schulen, Praxen und Ähnliches) um −6,5 % (−11 bis 0 %), bei Gewerbebauten mit der Regel der klimatisierten Fläche um −4,4 % (−7 bis 0 %); monatliche Korrelation 0,989–0,999. Die Zerlegung des ersten Vergleichs zeigt, dass ein Teil der Übereinstimmung aus gegenläufigen Abweichungen der inneren und äußeren Wärmeübergänge kommt.</p>
  ${cityText('de')}
  <h4>Grenzen</h4><ul><li>Ein einzoniges Prisma je Umriss; Türme auf einem Sockel werden nach Geschossfläche über den Umriss verteilt.</li><li>GBA-Höhen sättigen über 30 m und dienen nur als Untergrenze.</li><li>Ergebnisse für Wohnbauten hängen vor allem von der Nutzung der Klimaanlage ab; für Wohnungen gibt es keine offenen Messungen je Gebäude, nur die EMA-Summen.</li><li>Der BCA-EUI ist der eigene Zähler des Gebäudes; Gebäude mit Fernkälte ohne die zugekaufte Kälte.</li><li>Eine Wetterreihe für die ganze Insel (ERA5, auf Changi korrigiert), keine städtische Wärmeinsel.</li><li>Kalibrierte Werte für Gewerbebauten gelten nur im Größenbereich der BCA-Trainingsgebäude (kleinstes je Typ: ${dom(2)}); kleinere Läden, Shophouses und Büros nehmen die Tabellenwerte und Split- oder VRF-Geräte, die hier keine Daten prüfen.</li><li>Rechenräume, Labore und Industrieprozesse sind nicht modelliert.</li><li>Die Solargewinne an HDB-Fassaden liegen 15–30 % unter denen von EnergyPlus.</li></ul>
  <h4>Daten und Lizenzen</h4><p>${creditsText('de')}</p></div>`);
}
function creditsText(lang) {
  const a = (href, t) => `<a href="${href}" target="_blank" rel="noopener">${t}</a>`;
  const sodl = a(SODL, 'Singapore Open Data Licence v1.0');
  return {
    zh: `© OpenStreetMap contributors（ODbL）· 包含 HDB Property Information、HDB Existing Building、URA Master Plan 2019 Land Use 与 Subzone Boundary、BCA Building Energy Performance Data、Singapore Public Holidays 的信息，2026-11-25 取自 data.gov.sg，按 ${sodl} 提供 · BCA BEBR 数据 2022–2025（BCA 网站）· GlobalBuildingAtlas（Zhu 等 2025），CC BY-NC 4.0 · 天气 Open-Meteo（CC BY 4.0，ERA5 / Copernicus）· EMA Singapore Energy Statistics（电网排放系数）· 参数来源见 ${a(`${REPO_URL}/blob/main/data/archetypes_sg_sources.md`, 'archetypes_sg_sources.md')} · 底图 OpenFreeMap / OpenMapTiles。`,
    en: `© OpenStreetMap contributors (ODbL) · Contains information from HDB Property Information, HDB Existing Building, URA Master Plan 2019 Land Use and Subzone Boundary, BCA Building Energy Performance Data and Singapore Public Holidays accessed on 2026-11-25 from data.gov.sg, which is made available under the terms of the ${sodl} · BCA BEBR data 2022–2025 (BCA website) · GlobalBuildingAtlas (Zhu et al. 2025), CC BY-NC 4.0 · Weather Open-Meteo (CC BY 4.0, ERA5 / Copernicus) · EMA Singapore Energy Statistics (grid emission factor) · Input sources in ${a(`${REPO_URL}/blob/main/data/archetypes_sg_sources.md`, 'archetypes_sg_sources.md')} · Base map OpenFreeMap / OpenMapTiles.`,
    de: `© OpenStreetMap contributors (ODbL) · Enthält Informationen aus HDB Property Information, HDB Existing Building, URA Master Plan 2019 Land Use und Subzone Boundary, BCA Building Energy Performance Data und Singapore Public Holidays, abgerufen am 2026-11-25 von data.gov.sg, bereitgestellt unter der ${sodl} · BCA-BEBR-Daten 2022–2025 (BCA-Website) · GlobalBuildingAtlas (Zhu et al. 2025), CC BY-NC 4.0 · Wetter Open-Meteo (CC BY 4.0, ERA5 / Copernicus) · EMA Singapore Energy Statistics (Netzemissionsfaktor) · Quellen der Eingaben in ${a(`${REPO_URL}/blob/main/data/archetypes_sg_sources.md`, 'archetypes_sg_sources.md')} · Grundkarte OpenFreeMap / OpenMapTiles.`,
  }[lang];
}

// ---------- data and resources on the start page ----------
function renderSources() {
  const rows = [
    ['OpenStreetMap', 'https://www.openstreetmap.org/copyright', L('楼的轮廓、类型、地址和层数', 'Outlines, type, address and storeys', 'Umrisse, Typ, Adresse und Geschosse'), 'ODbL'],
    [L('HDB 物业信息与建筑轮廓', 'HDB Property Information and building footprints', 'HDB Property Information und Gebäudeumrisse'), 'https://data.gov.sg/datasets/d_17f5382f26140b1fdae0ba2ef6239d2f/view', L('组屋的建成年份、层数和户型', 'Completion year, storeys and flat types of HDB blocks', 'Fertigstellungsjahr, Geschosse und Wohnungstypen der HDB-Blöcke'), 'SODL v1.0'],
    [L('URA 2019 总体规划', 'URA Master Plan 2019', 'URA Master Plan 2019'), 'https://data.gov.sg/datasets/d_90d86daa5bfaa371668b84fa5f01424f/view', L('用地、容积率、规划区和分区', 'Land use, plot ratio, planning areas and subzones', 'Flächennutzung, Geschossflächenzahl, Planungsgebiete'), 'SODL v1.0'],
    [L('BCA 建筑能耗数据', 'BCA building energy performance data', 'BCA-Gebäudeenergiedaten'), 'https://data.gov.sg/collections/22/view', L('商业楼的空调、冷站效率和实测 EUI（对照用）', 'AC, plant efficiency and measured EUI of commercial buildings (EUI for comparison)', 'Klimatisierung, Effizienz der Kältezentrale und gemessener EUI von Gewerbebauten (EUI zum Vergleich)'), 'SODL v1.0'],
    ['GlobalBuildingAtlas', 'https://huggingface.co/datasets/zhu-xlab/GBA.LoD1', L('卫星估计的楼高（Zhu 等 2025）', 'Building heights estimated from satellite images (Zhu et al. 2025)', 'Aus Satellitenbildern geschätzte Gebäudehöhen (Zhu et al. 2025)'), 'CC BY-NC 4.0'],
    ['Open-Meteo · ERA5', 'https://open-meteo.com/', L('2010–2025 年逐时气象和典型年', 'Hourly weather 2010–2025 and the typical year', 'Stündliches Wetter 2010–2025 und typisches Jahr'), 'CC BY 4.0'],
    [L('新加坡公众假期', 'Singapore public holidays', 'Feiertage in Singapur'), 'https://data.gov.sg/datasets/d_8ef23381f9417e4d4254ee8b4dcdb176/view', L('非住宅的作息', 'Schedules of non-residential buildings', 'Zeitpläne der Nichtwohngebäude'), 'SODL v1.0'],
    ['EMA Singapore Energy Statistics', 'https://www.ema.gov.sg/resources/singapore-energy-statistics', L('电网排放系数、住户用电', 'Grid emission factor, household electricity', 'Netzemissionsfaktor, Haushaltsstrom')],
    [L('参数出处（BCA、NEA、SingStat、HDB 等）', 'Sources of the inputs (BCA, NEA, SingStat, HDB, …)', 'Quellen der Eingaben (BCA, NEA, SingStat, HDB, …)'), `${REPO_URL}/blob/main/data/archetypes_sg_sources.md`, L('每个参数的值、区间和页码', 'Value, range and page of every input', 'Wert, Bereich und Seite jeder Eingabe')],
    ['OpenFreeMap', 'https://openfreemap.org/', L('底图，以及街区漫游的道路、绿地和水面', 'Base map, and the roads, green and water of the street walk', 'Grundkarte sowie Straßen, Grün und Wasser des Straßenrundgangs'), '© OpenMapTiles'],
    ['Mapillary', 'https://www.mapillary.com/', L('所选楼的街景照片和拍摄位置', 'Street-level photos of the selected building and where they were taken', 'Straßenfotos des gewählten Gebäudes und ihre Aufnahmeorte'), 'CC BY-SA 4.0'],
    ['ambientCG', 'https://ambientcg.com/', L('街区漫游的墙面、铺地、草和沥青纹理', 'Wall, paving, grass and asphalt textures of the street walk', 'Wand-, Pflaster-, Gras- und Asphalttexturen des Straßenrundgangs'), 'CC0'],
  ];
  $('#empty .srcs')?.remove();
  $('#empty').append(h('section', { class: 'srcs' }, h('h3', {}, L('数据与资料', 'Data and resources', 'Daten und Quellen')),
    h('ul', {}, ...rows.map(([name, url, what, lic]) => h('li', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, name + ' ↗'), h('span', { class: 'what' }, what), lic ? h('span', { class: 'lic' }, lic) : null))),
    h('p', { class: 'disclaimer' }, L('data.gov.sg 的数据按 ', 'Data from data.gov.sg are used under the ', 'Daten von data.gov.sg stehen unter der '), h('a', { href: SODL, target: '_blank', rel: 'noopener' }, 'Singapore Open Data Licence v1.0'), L('（2026-11-25 获取）。', ' (accessed 2026-11-25).', ' (abgerufen am 2026-11-25).')),
    h('p', { class: 'disclaimer' }, disclaimer())));
}

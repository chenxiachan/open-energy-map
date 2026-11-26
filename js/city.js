// The city of the page: Munich (default) or Singapore (?city=sg). Every data path of a city comes from here, so the
// app, the tools and agent/core.mjs read the same files (docs/singapore-contract.md §1).
//
// In the browser CITY follows ?city= of the page URL; in Node it is Munich until setCity('sg') is called (agent/core.mjs
// does this for --city sg). Safe to import anywhere: no top-level await, location is guarded (as in i18n.js).
//
// Choices: Munich keeps its paths exactly as before (data/…), so its fetches are byte for byte the old ones. Singapore has
// no LoD2, Zensus, terrain, tree or Heizspiegel layer, no bill calibration, retrofit or export yet; its street walk has flat
// ground and no trees (js/walk.js reads terrain and trees only where `layers` has them); `layers` says which exist, and
// the page hides the rest. Its city grid layer (data/sg/city/grid.json, tools/sg/city_run_sg.mjs)
// is on 100 m cells of SVY21 (EPSG:3414) instead of the Zensus grid.

const MUC = {
  id: 'muc',
  dataRoot: 'data/',
  osm: 'data/osm/',
  addr: 'data/osm/addr.json',
  weather: 'data/weather/',
  presets: 'data/presets.json',
  archetypes: 'data/archetypes_de.json',
  holidays: null,                 // the Bavarian holidays are built into js/holidays.js
  tz: 1,
  center: [11.5679, 48.1497],     // lon, lat of the opening view (js/map.js default)
  bbox: [11.36, 48.06, 11.73, 48.25],
  climate: 'heating',
  gridEF: null,                   // carrier factors come from data/archetypes_de.json (js/systems.js)
  layers: { lod2: true, zensus: true, terrain: true, trees: true, heizspiegel: true, cityGrid: true, photos: true, walk: true, calib: true, retrofit: true, export: true },
};

const SG = {
  id: 'sg',
  dataRoot: 'data/sg/',
  osm: 'data/sg/osm/',
  addr: 'data/sg/osm/addr.json',
  weather: 'data/sg/weather/',
  presets: 'data/sg/presets.json',
  archetypes: 'data/archetypes_sg.json',
  bca: 'data/sg/bca.json',
  holidays: 'data/sg/holidays.json',
  cityGrid: 'data/sg/city/grid.json',   // the city layer (js/sg_app.js initCity)
  tz: 8,
  center: [103.8455, 1.2795],     // Tanjong Pagar: HDB blocks next to the CBD towers
  bbox: [103.59, 1.15, 104.10, 1.48],
  climate: 'cooling',
  // EMA grid emission factor (data/archetypes_sg.json gridEF.byYear); the typical year takes 2019 (gridEF note)
  gridEF: { table: 'gridEF', tmyYear: 2019 },
  layers: { lod2: false, zensus: false, terrain: false, trees: false, heizspiegel: false, cityGrid: true, photos: true, walk: true, calib: false, retrofit: false, export: false },
};

export const CITIES = { muc: MUC, sg: SG };

function fromUrl() {
  try {
    if (typeof location !== 'undefined' && location && location.search) {
      const c = new URLSearchParams(location.search).get('city');
      if (c && CITIES[c.toLowerCase()]) return c.toLowerCase();
    }
  } catch { /* ignore */ }
  return null;
}

export let CITY = CITIES[fromUrl() || 'muc'];

// Node (tools, agent): choose the city explicitly. Returns the city.
export function setCity(id) {
  const k = String(id || 'muc').toLowerCase();
  if (!CITIES[k]) throw new Error(`Unknown city ${id}; known: ${Object.keys(CITIES).join(', ')}`);
  CITY = CITIES[k];
  return CITY;
}

// a path under the city's data root ('weather/index.json' → 'data/sg/weather/index.json')
export const cityData = (p) => CITY.dataRoot + p;

// The city switch in the page header (index.html #citysw, styled like the language switch): one link per city in the
// current language, the open city marked with aria-current. labels: { muc: 'Munich', sg: 'Singapore' } in the page language.
export function renderCitySwitch(el, labels, ariaLabel) {
  if (!el || typeof document === 'undefined') return;
  el.replaceChildren(...Object.keys(CITIES).map((id) => {
    const a = document.createElement('a');
    a.href = cityHref(id); a.dataset.c = id; a.textContent = labels[id] || id;
    if (id === CITY.id) a.setAttribute('aria-current', 'page');
    return a;
  }));
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
}

// The page URL of a city in the current language (keeps ?lang= when the URL has it).
export function cityHref(id) {
  try {
    const u = new URL(location.href);
    u.hash = '';
    if (id === 'muc') u.searchParams.delete('city'); else u.searchParams.set('city', id);
    return u.pathname + (u.search || '');
  } catch { return id === 'muc' ? './' : `./?city=${id}`; }
}

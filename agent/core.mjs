// Open Energy Map for agents: the model of the map for one building, returned as JSON in which every input carries
// its source tier and references, so an agent can quote building energy it can trace instead of making it up.
// Shared by the command line and the MCP server (agent/oem.mjs).
//
// The steps are those of the page (js/main.js select → rebuild), on the same modules and data: the OSM outline and
// its neighbours within 150 m, the Bavarian LoD2 model, the Zensus 2022 priors for the construction age and the
// heating carrier, the typology table, shading, the hourly 5R1C model with the typical year, the prior Monte Carlo
// for the ranges and the self-checks. Assumptions given by the caller enter as user input, as on the page.
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
export const SITE = 'https://chenxiachan.github.io/open-energy-map/';
export const REPO = 'https://github.com/chenxiachan/open-energy-map';
export const VERSION = '2026-11-20';
const RES = ['sfh', 'th', 'mfh', 'ab'];

// tiers as on the page (js/main.js TIER_OF): what kind of evidence a value rests on
const TIER_OF = { osm: 'observed', geometry: 'observed', lod2: 'observed', archetype: 'published_table', profile: 'published_table', zensus: 'published_table', default: 'assumed', user: 'user_input', calibrated: 'bill_calibrated' };
const VAR_TIER = { age: 'zensus', wwrScale: 'default', hScale: 'default', anScale: 'default', n50: 'default', heatedFrac: 'default', T_heat: 'profile', n_vent: 'profile', Q_int: 'profile' };

let S = null;   // modules and data, loaded once per process
let CITY_ID = 'muc';   // the city of this process: 'muc' (default) or 'sg' (init(lang, 'sg'), --city sg)
export const cityId = () => CITY_ID;

export async function init(lang = 'en', city = null) {
  if (String(city || CITY_ID).toLowerCase() === 'sg') { CITY_ID = 'sg'; return initSG(lang); }
  if (S) return S;
  // the page modules fix their language when js/i18n.js loads, from ?lang= as on the page
  if (typeof globalThis.location === 'undefined') globalThis.location = { search: `?lang=${lang}` };
  // the page modules fetch their data with paths relative to the site root: serve those from the repository
  const netFetch = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    const s = u instanceof URL ? u.href : String(u);
    if (/^(https?|data):/.test(s)) return netFetch(u, opts);
    const url = s.startsWith('file:') ? new URL(s) : new URL(s.replace(/^\.?\//, ''), ROOT);
    try { return new Response(await readFile(url), { status: 200, headers: { 'content-type': 'application/json' } }); } catch { return new Response(null, { status: 404 }); }
  };
  const im = (p) => import(new URL(p, ROOT).href);
  const [i18n, G, Arch, solar, rc5, sys, osm, prior, checks, refs, T] = await Promise.all(
    ['js/i18n.js', 'js/geometry.js', 'js/archetype.js', 'js/solar.js', 'js/rc5.js', 'js/systems.js', 'js/osmdb.js', 'js/prior.js', 'js/checks.js', 'js/refs.js', 'js/trace.js'].map(im));
  const idx = await osm.loadIndex('data/osm/');
  const A = await Arch.loadArchetypes('data/archetypes_de.json');
  sys.setFactors(A);
  refs.setSources(A.meta && A.meta.sources);
  await osm.loadZensus('data/zensus/baujahr.json');
  await osm.loadHeating('data/zensus/heizung.json');
  const wIdx = JSON.parse(await readFile(new URL('data/weather/index.json', ROOT), 'utf8'));
  const W = JSON.parse(await readFile(new URL('data/weather/' + wIdx.tmy.file, ROOT), 'utf8'));
  for (const k of ['T', 'GHI', 'DNI', 'DHI']) W[k] = Float32Array.from(W[k]);
  S = { lang: i18n.LANG, L: i18n.L, G, Arch, solar, rc5, sys, osm, prior, checks, refs, T, A, idx, W, wIdx, addr: null };
  return S;
}

// ---------- addresses (data/osm/addr.json, the index behind the search field of the page) ----------
// Rows: the addresses and names on OSM building outlines, and the OSM address points placed on the outline that holds
// them (tools/build_addr_index.py). An address can still name several buildings (a school and its
// sports hall), and the same street and number exist in several municipalities around Munich, so a match is only
// taken when it is unique; otherwise the candidates go back to the caller.
const norm = (s) => String(s).toLowerCase().replace(/ß/g, 'ss').replace(/straße|strasse/g, 'str').replace(/[.\-,/]/g, ' ').replace(/\s+/g, ' ').trim();
const CITY_WORDS = new Set(['münchen', 'munchen', 'muenchen', 'munich', 'germany', 'deutschland', 'bayern', 'bavaria', 'de']);
const MUNICH_WORDS = new Set(['münchen', 'munchen', 'muenchen', 'munich']);
// the postcodes of the city of Munich run from 80331 to 81929; the index keeps no municipality names
const inMunich = (pc) => (pc ? /^8[01]\d{3}$/.test(pc) : null);
const place = (pc) => (!pc ? '' : inMunich(pc) ? `${pc} München` : pc);
const label = (street, number, pc) => [`${street || ''} ${number || ''}`.trim(), place(pc)].filter(Boolean).join(', ');
// house numbers of a row: "12a" → [12a]; "3;5" → [3, 5]; "12-14" → [12, 13, 14]
function numbers(s) {
  const out = new Set();
  for (const part of String(s || '').toLowerCase().replace(/\s+/g, '').split(/[;,/]/)) {
    const m = part.match(/^(\d+)[-–](\d+)$/);
    if (m && +m[2] > +m[1] && +m[2] - +m[1] < 40) for (let k = +m[1]; k <= +m[2]; k++) out.add(String(k));
    else if (part) out.add(part);
  }
  return out;
}

async function addresses() {
  if (!S.addr) {
    const rows = JSON.parse(await readFile(new URL('data/osm/addr.json', ROOT), 'utf8'));
    // street, number, postcode, OSM id, lon, lat, name
    S.addr = rows.map((r) => ({ street: r[0], number: r[1], postcode: r[2], id: r[3], lon: r[4], lat: r[5], name: r[6] || '', nums: numbers(r[1]),
      street_n: norm(r[0] || ''), parts: norm(`${r[0]} ${r[6] || ''}`).split(' ').filter(Boolean) }));
  }
  return S.addr;
}

function parseQuery(query) {
  const toks = norm(query).split(' ').filter(Boolean);
  const q = { postcodes: [], number: null, words: [], munich: false };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (CITY_WORDS.has(t)) { if (MUNICH_WORDS.has(t)) q.munich = true; continue; }
    if (/^\d{5}$/.test(t)) { q.postcodes.push(t); continue; }
    if (q.number == null && /^\d{1,4}[a-z]?$/.test(t)) { q.number = /^\d+$/.test(t) && /^[a-z]$/.test(toks[i + 1] || '') ? t + toks[++i] : t; continue; }
    q.words.push(t);
  }
  return q;
}

// rows matching a query: { rows (unique buildings, best first), exact, near (same street, other numbers), ignored words }
async function matchAddress(query) {
  const all = await addresses();
  const q = parseQuery(query);
  if (!q.words.length && !q.number) return { q, rows: [], near: [], ignored: [] };
  const wordsOk = (r, ws) => ws.every((w) => r.parts.some((p) => p.startsWith(w)));
  const scan = (ws) => all.filter((r) => (!q.postcodes.length || q.postcodes.includes(r.postcode))
    && (r.street ? wordsOk(r, ws) : wordsOk(r, q.number ? [...ws, q.number] : ws)));
  let words = q.words, ignored = [], cand = scan(words);
  // a word that matches nothing, often a municipality or district, which the index does not keep, is left out
  for (let i = words.length - 1; !cand.length && i >= 0 && words.length > 1; i--) {
    const ws = words.filter((_, j) => j !== i), c = scan(ws);
    if (c.length) { ignored = [words[i]]; words = ws; cand = c; }
  }
  const numOk = (r) => !q.number || !r.street || r.nums.has(q.number);
  let rows = cand.filter(numOk);
  const near = rows.length || !q.number ? [] : cand.filter((r) => r.street).sort((a, b) => Math.abs(parseInt(a.number) - parseInt(q.number)) - Math.abs(parseInt(b.number) - parseInt(q.number)));
  // the street as typed beats a longer street that starts with it ("Hauptstraße 5" over "Hauptstraße Nord 5")
  const typed = words.join(' ');
  if (rows.some((r) => r.street_n === typed)) rows = rows.filter((r) => !r.street || r.street_n === typed);
  // "München" in the query: buildings in the city first, and only those if there are any
  if (q.munich && rows.some((r) => inMunich(r.postcode))) rows = rows.filter((r) => inMunich(r.postcode) !== false);
  // an address names a place, not a building: every building with the same street, number and postcode is a candidate,
  // also when a word of the query matched the name of only one of them
  if (q.number) {
    const keys = new Set(rows.filter((r) => r.street).map((r) => `${r.street_n}|${r.number}|${r.postcode}`)), have = new Set(rows);
    for (const r of all) if (r.street && !have.has(r) && keys.has(`${r.street_n}|${r.number}|${r.postcode}`)) rows.push(r);
  }
  const score = (r) => words.filter((w) => r.parts.includes(w)).length * 10 - r.parts.join(' ').length / 100;
  rows.sort((a, b) => score(b) - score(a));
  // a building can carry several addresses (a corner, several entrances): one row per building
  const seen = new Set();
  rows = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
  return { q, rows, near, ignored };
}

const entry = (r, exact = true) => ({
  address: label(r.street, r.number, r.postcode) || null, name: r.name || null, postcode: r.postcode || null, in_munich: inMunich(r.postcode),
  osm_id: r.id, lat: r.lat, lon: r.lon, map_url: mapUrl(r.id, r.lat, r.lon), exact,
});

export async function findBuildings(query, limit = 10) {
  await init();
  if (CITY_ID === 'sg') return findBuildingsSG(query, limit);
  const m = await matchAddress(query);
  return (m.rows.length ? m.rows.map((r) => entry(r)) : m.near.map((r) => entry(r, false))).slice(0, limit);
}

const mapUrl = (id, lat, lon) => `${SITE}#b=${id}@${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;
const sig = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : +x.toPrecision(d));
const rd = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const absUrl = (u) => (!u ? null : /^https?:/.test(u) ? u : `${REPO}/blob/main/${u.replace(/^\.?\//, '')}`);

class UserError extends Error {}
export { UserError };

// ---------- identifiers ----------
// osm_id (w… or r…) is unique in the OSM snapshot of the data; it changes when mappers redraw an outline, so keep the
// point as well (map_url carries both). lod2_id is the gml:id of the building in the LoD2 model of the Bavarian
// survey (CityGML, city of Munich only). The two do not always match one to one: an OSM outline can cover several
// LoD2 buildings (the index keeps the largest), and one LoD2 building can be split into several OSM outlines.
const OSM_ID = /^[wr]\d+(_\d+)?$/;
const tileCentre = (key) => { const [ix, iy] = key.split('_').map(Number), I = S.idx; return [I.bbox[0] + (ix + 0.5) * I.dlon, I.bbox[1] + (iy + 0.5) * I.dlat]; };
const tileFiles = async (dir) => (await readdir(new URL(dir, ROOT))).filter((f) => /^t_-?\d+_-?\d+\.json$/.test(f));

async function locateOsm(id) {
  const row = (await addresses()).find((r) => r.id === id);
  if (row) return { lat: row.lat, lon: row.lon };
  const needle = `"i":"${id}"`;
  for (const f of await tileFiles('data/osm/')) {
    if (!(await readFile(new URL('data/osm/' + f, ROOT), 'utf8')).includes(needle)) continue;
    const [lon, lat] = tileCentre(f.slice(2, -5)), rec = await S.osm.byId(id, lon, lat);
    if (rec) return { lat: (rec.bbox[1] + rec.bbox[3]) / 2, lon: (rec.bbox[0] + rec.bbox[2]) / 2 };
  }
  return null;
}

async function lod2Index() {
  if (!S.lod2rev) {
    S.lod2rev = new Map();
    for (const f of await tileFiles('data/lod2/')) {
      const t = JSON.parse(await readFile(new URL('data/lod2/' + f, ROOT), 'utf8'));
      for (const [id, v] of Object.entries(t.b || {})) { const k = String(v[8]); if (!S.lod2rev.has(k)) S.lod2rev.set(k, []); S.lod2rev.get(k).push({ id, tile: f.slice(2, -5) }); }
    }
  }
  return S.lod2rev;
}

async function locateLod2(lod2) {
  const num = String(lod2).trim().replace(/^DEBY_LOD2_/i, '');
  if (!/^\d+$/.test(num)) throw new UserError(`lod2_id should look like DEBY_LOD2_4769338, got ${lod2}.`);
  const out = [];
  for (const { id, tile } of (await lod2Index()).get(num) || []) {
    const [lon, lat] = tileCentre(tile), rec = await S.osm.byId(id, lon, lat);
    if (rec) out.push({ id, lat: (rec.bbox[1] + rec.bbox[3]) / 2, lon: (rec.bbox[0] + rec.bbox[2]) / 2 });
  }
  return out;
}

const footprint = (rec) => {
  if (!rec) return null;
  const lat0 = (rec.bbox[1] + rec.bbox[3]) / 2, kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const ring = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky); } return Math.abs(a) / 2; };
  return Math.round(ring(rec.outer) - (rec.holes || []).reduce((t, h) => t + ring(h), 0));
};

// several buildings fit the query: describe each so the agent (or the person) can choose
async function ambiguous(base, list, reason) {
  const cands = [];
  for (const c of list.slice(0, 12)) {
    const rec = await S.osm.byId(c.osm_id, c.lon, c.lat), l2 = (await S.osm.lod2Around(c.lon, c.lat)).get(c.osm_id);
    cands.push({ ...c, exact: undefined, osm_building: rec?.tags?.building || null, footprint_m2: footprint(rec), storeys: rec?.tags?.['building:levels'] ? +rec.tags['building:levels'] : null, lod2_id: l2 ? `DEBY_LOD2_${l2[8]}` : null });
  }
  return { ...base, modelled: false, status: 'ambiguous', reason, n_candidates: list.length, candidates: cands,
    next_step: 'Ask the person which building is meant, or choose by name, postcode, use and size; then call building_energy again with the osm_id and the lat and lon of that candidate.' };
}

// ---------- one building ----------
// where: { osm_id, lat?, lon? } | { lod2_id } | { lat, lon } | { address }, taken in this order;
// assume: what the caller knows (user input on the page)
export async function buildingEnergy(where = {}, assume = {}, opts = {}) {
  await init(undefined, opts.city || null);
  if (CITY_ID === 'sg') return buildingEnergySG(where, assume, opts);
  const { G, Arch, solar, rc5, sys, osm, prior, checks, refs, T, A, L } = S;
  const n = Math.max(50, Math.min(1000, Math.round(opts.samples || 300)));
  const base = { tool: toolInfo(), query: { ...Object.fromEntries(Object.entries(where).filter(([, v]) => v != null && v !== '')), assume } };
  let match = null, lat = where.lat, lon = where.lon, osmId = where.osm_id, resolvedBy = null, note = null;
  if (osmId != null) {
    osmId = String(osmId).trim();
    if (!OSM_ID.test(osmId)) throw new UserError(`osm_id should look like w34107320 or r1234567, got ${where.osm_id}.`);
    if (lat == null || lon == null) {
      const p = await locateOsm(osmId);
      if (!p) throw new UserError(`OSM id ${osmId} is not in the local data (OSM snapshot ${toolInfo().osm_snapshot}). Give lat and lon as well, or use find_building.`);
      ({ lat, lon } = p);
    }
    resolvedBy = 'osm_id';
  } else if (where.lod2_id) {
    const hits = await locateLod2(where.lod2_id);
    if (!hits.length) throw new UserError(`LoD2 building ${where.lod2_id} is not matched to an OSM outline in the local data. LoD2 covers the city of Munich; where an OSM outline covers several LoD2 buildings, only the largest is indexed. Give lat and lon instead.`);
    if (hits.length > 1) {
      const rows = await addresses();
      return ambiguous(base, hits.map((h) => { const r = rows.find((x) => x.id === h.id); return r ? entry(r) : { address: null, name: null, postcode: null, in_munich: true, osm_id: h.id, lat: rd(h.lat, 6), lon: rd(h.lon, 6), map_url: mapUrl(h.id, h.lat, h.lon) }; }),
        `LoD2 building ${where.lod2_id} is split into ${hits.length} OSM outlines; the map models each outline as a building.`);
    }
    ({ id: osmId, lat, lon } = hits[0]); resolvedBy = 'lod2_id';
  } else if (lat != null && lon != null) {
    resolvedBy = 'point';
  } else if (where.address) {
    const m = await matchAddress(where.address);
    const ign = m.ignored.length ? ` The word "${m.ignored.join(' ')}" matched nothing and was left out (the index keeps postcodes, not municipality names).` : '';
    if (!m.rows.length) {
      throw new UserError(m.near.length
        ? `${m.near[0].street} ${m.q.number} is not in the local address index (the OSM addresses on or inside building outlines). Numbers on this street in the index: ${[...new Set(m.near.map((r) => label(r.street, r.number, r.postcode)))].slice(0, 8).join('; ')}. If the address exists, give lat and lon of the building.${ign}`
        : `No address in the local data matches "${where.address}". The map covers Munich and its surroundings; try the street and house number, or give lat and lon.${ign}`);
    }
    if (m.rows.length > 1) return ambiguous(base, m.rows.map((r) => entry(r)), `"${where.address}" fits ${m.rows.length} buildings.${ign}`);
    match = entry(m.rows[0]); match.exact = undefined; lat = match.lat; lon = match.lon; osmId = match.osm_id; resolvedBy = 'address';
    if (ign) note = ign.trim();
  } else throw new UserError('Give an address, lat and lon, an osm_id or a lod2_id.');
  if (!osm.inCoverage(lon, lat)) throw new UserError(`${lat}, ${lon} is outside the area covered so far (Munich and its surroundings).`);
  let rec = osmId ? await osm.byId(osmId, lon, lat) : null;
  if (osmId && !rec) { note = `OSM id ${osmId} was not found near ${lat}, ${lon} in this snapshot; the building at the point was used instead.`; resolvedBy = 'point'; }
  rec = rec || await osm.buildingAt(lon, lat);
  if (!rec) throw new UserError(`No building outline at ${lat}, ${lon}.`);
  base.resolved_by = resolvedBy; base.matched_address = match || undefined; base.note = note || undefined;

  const nbRecs = await osm.neighbours(rec, 150);
  const cLon = (rec.bbox[0] + rec.bbox[2]) / 2, cLat = (rec.bbox[1] + rec.bbox[3]) / 2;
  const lod2Map = await osm.lod2Around(cLon, cLat);
  const st = lod2Map.structures.get(rec.id), open = G.openStructure(rec.tags || {}, G.lod2Record(lod2Map.get(rec.id))?.fn);
  if (st || open) return { ...base, building: { osm_id: rec.id, lat: cLat, lon: cLon, map_url: mapUrl(rec.id, cLat, cLon) }, modelled: false,
    reason: open ? `An open structure (${open}): no enclosing walls and no heating, so no energy demand is computed.` : 'A structure such as a monument, tower, chimney or shaft (tall and slender, no address, no LoD2 building in the cadastre), so no energy demand is computed.' };

  // the caller's assumptions, as the page's state
  const state = { ageClass: null, refurb: { windows: 'unknown', wall: 'unknown', roof: 'unknown', floor: 'unknown' }, system: null, user: {}, geom: {} };
  const ages = A.ageClasses.map((c) => c.id);
  if (assume.age_class != null) { if (!ages.includes(assume.age_class)) throw new UserError(`age_class must be one of ${ages.join(', ')}: ${A.ageClasses.map((c) => `${c.id} ${c.label}`).join('; ')}`); state.ageClass = assume.age_class; }
  for (const [c, v] of Object.entries(assume.refurbished || {})) {
    if (!(c in state.refurb)) throw new UserError(`refurbished takes windows, wall, roof, floor (yes or no); got ${c}`);
    state.refurb[c] = v === true || v === 'yes' ? 'yes' : v === false || v === 'no' ? 'no' : 'unknown';
  }
  if (assume.system != null) { if (!A.systems[assume.system]) throw new UserError(`system must be one of ${Object.keys(A.systems).join(', ')}`); state.system = assume.system; }
  for (const [k, v] of Object.entries(assume.params || {})) {
    if (!Arch.PARAM_META[k] || k === 'system') throw new UserError(`Unknown input ${k}; inputs: ${Object.keys(Arch.PARAM_META).filter((x) => x !== 'system').join(', ')}`);
    if (!Number.isFinite(+v)) throw new UserError(`${k} must be a number`);
    state.user[k] = +v;
  }
  if (assume.storeys != null) state.geom.floors = Math.max(1, Math.round(+assume.storeys));
  if (assume.height_m != null) state.geom.height = +assume.height_m;
  if (assume.usage != null) { if (!Arch.TYPE_CN[assume.usage]) throw new UserError(`usage must be one of ${Object.keys(Arch.TYPE_CN).join(', ')}`); state.geom.usage = assume.usage; }

  // geometry as js/main.js rebuild({ geometry: true })
  const m = G.buildGeometry(rec, nbRecs, { lod2: lod2Map });
  if (state.geom.floors) { m.floors = state.geom.floors; m.floorHeight = +(m.height / m.floors).toFixed(2); m.geomSrc.floors = 'user'; m.hGBias = 0; }
  if (state.geom.height) { m.height = state.geom.height; m.floorHeight = +(m.height / m.floors).toFixed(2); m.geomSrc.height = 'user'; m.hGBias = 0; }
  if (state.geom.usage) { m.usage = state.geom.usage; m.usageSrc = L('用户指定', 'Set by user', 'Von Ihnen festgelegt'); }
  const L2 = G.lod2Record(lod2Map.get(m.id));
  if (L2 && !state.geom.height && !state.geom.floors) G.applyLoD2(m, L2);
  m.nbLonLat = nbRecs.filter((x) => !x.part).map((x) => x.outer);
  const ageInfo = Arch.agePrior(m.osmTags, await osm.zensusAt(m.center.lon, m.center.lat), { usage: m.usage });
  ageInfo.heat = await osm.heatingAt(m.center.lon, m.center.lat);
  const asg = Arch.assign(m, ageInfo, state);
  m.params = asg.params; Arch.applyWWR(m); G.computeAreas(m);
  const shading = solar.computeShading(m), prof = Arch.profileFor(m);
  const ctx = rc5.prepare(m, S.W, solar.facadeIrradiance(m, S.W, shading), prof);
  const p = rc5.paramValues(m), res = rc5.run(ctx, p, { detail: true, hourly: true }), fe = sys.finalEnergy(res, p, ctx);
  const pr = prior.priorMC({ model: m, ageInfo, state, assigned: asg, ctx }, n);
  // the orientation check of the page: the same building turned by 90°, unshaded
  const rot = JSON.parse(JSON.stringify({ ...m, lonlatOuter: undefined, nbLonLat: undefined }));
  rot.facades.forEach((f) => { f.azimuth = (f.azimuth + 90) % 360; });
  const rN = rc5.run(rc5.prepare(m, S.W, solar.facadeIrradiance(m, S.W, null), prof), p), rR = rc5.run(rc5.prepare(rot, S.W, solar.facadeIrradiance(rot, S.W, null), prof), p);
  const rotated = { annual: { heat: rR.annual.heat * (res.annual.heat / Math.max(1, rN.annual.heat)) } };
  const ck = checks.runChecks(m, res, { ageInfo, calibrated: false, shading, ageClass: A.ageClasses.find((c) => c.id === asg.cls), rotated });

  const AN = m.areas.netFloor, tags = m.osmTags || rec.tags || {};
  const cls = A.ageClasses.find((c) => c.id === asg.cls);
  const topAge = Object.entries(ageInfo.p).sort((a, b) => b[1] - a[1]);
  // as the range bars of the page: the band the value belongs to (construction age at the class used, if the age is
  // uncertain) is p10_p90 with its median; the band over all possible ages is p10_p90_all_ages
  const band = (k, f = 1) => T.band(pr, k, f);
  // every input with its value, tier, prior range and references (js/trace.js, shared with the exports)
  const inputs = T.traceInputs(m, ageInfo, state, asg, { absUrl });
  const varLabel = (key) => (key === 'age' ? L('建成年代', 'Construction age', 'Baualtersklasse') : key === 'wwrScale' ? L('窗墙比', 'Window-to-wall ratio', 'Fensterflächenanteil') : key === 'hScale' ? L('层数（缺省）', 'Storeys (default)', 'Geschosse (Standardwert)') : key === 'anScale' ? L('参考面积（层高偏差）', 'Reference area (storey height bias)', 'Gebäudenutzfläche (Abweichung der Geschosshöhe)') : Arch.PARAM_META[key]?.label || key);
  const shares = prior.varShares(pr).slice(0, 10).map((it) => ({ input: it.key, label: varLabel(it.key), share: rd(it.share, 3), tier: TIER_OF[VAR_TIER[it.key] || (m.params[it.key]?.source === 'user' ? 'user' : 'archetype')] }));
  const GSRC = (s) => (s == null ? null : /^LoD2/.test(s) ? 'observed' : /^osm/.test(s) ? 'observed' : s === 'user' ? 'user_input' : 'assumed');

  const out = {
    ...base,
    modelled: true,
    building: {
      osm_id: m.id, name: tags.name || null,
      address: (tags['addr:street'] && label(tags['addr:street'], tags['addr:housenumber'], tags['addr:postcode'])) || match?.address || null,
      lat: rd(m.center.lat, 6), lon: rd(m.center.lon, 6), map_url: mapUrl(m.id, m.center.lat, m.center.lon), osm_url: `https://www.openstreetmap.org/${m.id.startsWith('w') ? 'way' : 'relation'}/${m.id.slice(1)}`,
      usage: m.usage, usage_label: Arch.TYPE_CN[m.usage], usage_source: m.usageSrc || null, possibly_unheated: !m.heated || undefined,
      storeys: m.floors, height_m: rd(m.height, 1), storey_height_m: rd(m.floorHeight, 2), roof: m.roof?.shape || null, attic: m.roof?.attic || null,
      geometry_sources: { height: m.geomSrc?.height || null, storeys: m.geomSrc?.floors || null, roof: m.geomSrc?.roof || null, tier: { height: GSRC(m.geomSrc?.height), storeys: GSRC(m.geomSrc?.floors) } },
      lod2_id: m.lod2?.lod2 || null,
      identity: identity(rec.id, lod2Map),
      party_wall_share: rd(m.facades.reduce((t, f) => t + f.length * (1 - f.exposed), 0) / Math.max(1e-9, m.facades.reduce((t, f) => t + f.length, 0)), 2),
      reference_area_m2: Math.round(AN), living_area_m2: m.areas.living ? Math.round(m.areas.living) : null,
      construction_age: {
        used: { class: asg.cls, period: cls.label, set_by_user: !!state.ageClass },
        prior: state.ageClass ? null : { source: ageInfo.src, kind: ageInfo.kind, tier: ageInfo.kind === 'osm' ? 'observed' : ageInfo.kind === 'zensus' ? 'published_table' : 'assumed',
          top: topAge.slice(0, 3).map(([c, v]) => ({ class: c, period: A.ageClasses.find((x) => x.id === c).label, probability: rd(v, 3) })) },
      },
    },
    results: {
      weather: 'typical year built from hourly ERA5 data 2010–2025 (Open-Meteo)',
      heating_demand: { what: 'useful energy for space heating under standard use', unit: 'kWh/(m²·a)', value: sig(res.annual.heatPerM2), ...band('heat'), annual_MWh: sig(res.annual.heat / 1000) },
      final_energy: { what: 'space heating and hot water, at the meter', unit: 'kWh/(m²·a)', value: sig(fe.perM2), ...band('fin'), annual_MWh: sig(fe.total / 1000), carrier: fe.carrierLabel, system: fe.systemLabel, energy_class: fe.cls || undefined },
      primary_energy: { unit: 'kWh/(m²·a)', value: sig(fe.primary / AN) },
      co2: { unit: 't/a', value: sig(fe.co2 / 1000), ...band('co2', 1000), per_m2_kg: sig(fe.co2 / AN) },
      peak_load: { what: 'hourly maximum of the heating load', unit: 'kW', value: sig(res.annual.peakHeat / 1000), per_m2_W: sig(res.annual.peakHeat / AN) },
      ranges: `value: the model with the point values of the inputs below. p10_p90 and median: ${n} draws from the prior (refurbishment state, U-values, air tightness, use${pr.cond ? ') with the construction age at the class used for the value; p10_p90_all_ages: over all possible construction ages' : ', construction age known)'}, as the dark and light bands on the page.`,
    },
    uncertainty: { what: 'first-order share of each input in the variance of the heating demand (approximate)', shares },
    inputs,
    checks: ck.filter((c) => !/research model|研究模型|forschungsmodell/i.test(String(c.group))).map((c) => ({ group: c.group, title: c.title, status: c.status, detail: c.detail, criterion: c.how })),
    tiers: { observed: 'measured or mapped for this building (OSM, LoD2, geometry)', published_table: 'from a published table or statistic (IWU / TABULA, DIN V 18599 via dena, GEG, Zensus 2022)', assumed: 'an assumption with the rule stated', user_input: 'given by the caller with assume' },
    sources: SOURCES,
    disclaimer: 'Research prototype. Estimates from open data and published literature for reference only; they do not replace an energy performance certificate or an on-site assessment.',
    licence: 'Results: CC BY-NC 4.0; code and model: PolyForm Noncommercial 1.0.0; third-party data under the licences in sources. Commercial use needs a licence (x.c.chen@tum.de).',
    cite: 'Open Energy Map, (c) 2026 Xia Chen, ' + REPO,
  };
  // the export (agent/oem.mjs energy-ade) needs the model itself as well
  if (opts.internal) return { json: out, m, res, fe, pr, p, ageInfo, asg, state, inputs, shares, prof };
  return opts.detail === 'summary' ? summary(out) : out;
}

// The same result in about a third of the size, for the context of an agent: each input keeps its value, tier, prior
// range and first reference; checks keep only what is not a pass. detail "full" gives everything.
function summary(o) {
  return {
    ...o, detail: 'summary (call again with detail "full" for every reference, note and check)',
    inputs: o.inputs.map((i) => ({ key: i.key, label: i.label, value: i.value, value_label: i.value_label, unit: i.unit, tier: i.tier, prior_p10_p90: i.prior_p10_p90,
      reference: i.references[0] ? [i.references[0].label, i.references[0].where].filter(Boolean).join(' · ') + (i.references[0].url ? ` <${i.references[0].url}>` : '') : null })),
    checks: o.checks.filter((c) => c.status !== 'pass').map((c) => ({ title: c.title, status: c.status, detail: c.detail })),
    tiers: undefined, sources: o.sources.map((x) => `${x.data}: ${x.source} (${x.licence})`),
  };
}

// how this outline relates to the official LoD2 model (see "identifiers" above)
function identity(id, lod2Map) {
  const v = lod2Map.get(id), k = v ? v[8] : null;
  return {
    osm_id: id, osm_snapshot: toolInfo().osm_snapshot,
    lod2_id: v ? `DEBY_LOD2_${k}` : null,
    lod2_buildings_under_outline: v ? v[9] : 0,
    outlines_sharing_lod2: v ? [...lod2Map].filter(([o, w]) => o !== id && w[8] === k).map(([o]) => o) : [],
  };
}

// ---------- CityGML 2.0 + Energy ADE 3.0 of one building (js/energyade.js, the same file as the Export tab) ----------
export async function buildingEnergyADE(where = {}, assume = {}, opts = {}) {
  if (CITY_ID === 'sg') throw new UserError('The CityGML export is not available for Singapore yet; use building for the JSON model.');
  const r = await buildingEnergy(where, assume, { ...opts, internal: true });
  if (!r.m) return { json: r, xml: null };   // not modelled: a structure, or several buildings fit the address
  const { m, res, fe, pr, inputs, prof, json } = r;
  const { buildEnergyADE } = await import(new URL('js/energyade.js', ROOT).href);
  const tags = m.osmTags || {};
  const xml = buildEnergyADE(m, {
    res, fe, pr, inputs, profile: prof,
    bands: { heat: S.T.band(pr, 'heat'), fin: S.T.band(pr, 'fin'), co2: S.T.band(pr, 'co2', 1000) },
    ids: { osm: m.id, lod2: m.lod2?.lod2 || null, osmSnapshot: toolInfo().osm_snapshot },
    address: { street: tags['addr:street'] || json.matched_address?.address?.split(/ \d/)[0] || null, number: tags['addr:housenumber'] || null, postcode: tags['addr:postcode'] || null },
    lod2Function: m.lod2?.fn || null, version: VERSION, site: SITE, mapUrl: json.building.map_url, weatherName: S.W.name || json.results.weather,
  });
  return { json, xml };
}

function toolInfo() {
  return { name: 'Open Energy Map', version: VERSION, site: SITE, repository: REPO, coverage: 'Munich and its surroundings (first city)', osm_snapshot: (S.idx.timestamp || '').slice(0, 10) || null, language: S.lang };
}

const SOURCES = [
  { data: 'Building outlines and tags', source: '© OpenStreetMap contributors', licence: 'ODbL 1.0' },
  { data: 'LoD2 building models', source: 'Bayerische Vermessungsverwaltung', licence: 'CC BY 4.0' },
  { data: 'Census 2022 on the 100 m grid (construction period, heating carrier, living area)', source: 'Statistische Ämter des Bundes und der Länder', licence: 'dl-de/by-2-0' },
  { data: 'Hourly weather (ERA5)', source: 'Open-Meteo, Copernicus Climate Change Service', licence: 'CC BY 4.0' },
  { data: 'Typology and use profiles', source: 'IWU / TABULA, DIN V 18599 (via dena 2023), GEG 2024', licence: 'cited by page in the references of each input' },
];

// =====================================================================================================================
// Singapore (--city sg): the model of the page index.html?city=sg (js/model_sg.js), with the same inputs, ranges and
// sources. Results are cooling demand (sensible + latent), electricity by end use, CO₂ and the peak cooling load per m²
// of the type's reference area, and the EUI per m² GFA. A building in the BCA listing gets its measured EUI under
// `measured`, kept apart from the results: it is never an input. Options: opts.year (weather year 2010–2025, default the
// typical year; the grid emission factor follows the year), opts.samples.
let SGS = null;
const MAP_SG = (id, lat, lon) => `${SITE}?city=sg#b=${id}@${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;

async function initSG(lang = 'en') {
  if (SGS) return SGS;
  if (typeof globalThis.location === 'undefined') globalThis.location = { search: `?lang=${lang}&city=sg` };
  const netFetch = globalThis.fetch;
  if (!globalThis.__oemFetch) {
    globalThis.fetch = async (u, o) => {
      const x = u instanceof URL ? u.href : String(u);
      if (/^(https?|data):/.test(x)) return netFetch(u, o);
      const url = x.startsWith('file:') ? new URL(x) : new URL(x.replace(/^\.?\//, ''), ROOT);
      try { return new Response(await readFile(url), { status: 200, headers: { 'content-type': 'application/json' } }); } catch { return new Response(null, { status: 404 }); }
    };
    globalThis.__oemFetch = true;
  }
  const im = (p) => import(new URL(p, ROOT).href);
  const [i18n, city, osm, SGA, MS] = await Promise.all(['js/i18n.js', 'js/city.js', 'js/osmdb.js', 'js/archetype_sg.js', 'js/model_sg.js'].map(im));
  const C = city.setCity('sg');
  const idx = await osm.loadIndex(C.osm);
  const A = await SGA.loadArchetypes(C.archetypes);
  const rd = async (p) => JSON.parse(await readFile(new URL(p, ROOT), 'utf8'));
  const [bca, hol, wIdx] = await Promise.all([rd(C.bca), rd(C.holidays), rd(C.weather + 'index.json')]);
  SGS = { lang: i18n.LANG, L: i18n.L, C, osm, SGA, MS, A, idx, bcaRows: bca.rows, bcaSource: bca.source, cals: MS.calendars(hol, A), wIdx, W: new Map(), addr: null };
  return SGS;
}
async function weatherSG(year) {
  const key = year == null ? 'tmy' : String(year);
  if (!SGS.W.has(key)) {
    const meta = key === 'tmy' ? SGS.wIdx.tmy : SGS.wIdx.years[key];
    if (!meta) throw new UserError(`No Singapore weather for ${year}; years: ${Object.keys(SGS.wIdx.years).join(', ')} (default: the typical year).`);
    const w = JSON.parse(await readFile(new URL(SGS.C.weather + meta.file, ROOT), 'utf8'));
    for (const k of ['T', 'GHI', 'DNI', 'DHI']) w[k] = Float32Array.from(w[k]);
    SGS.W.set(key, w);
  }
  return SGS.W.get(key);
}

// ---------- addresses (data/sg/osm/addr.json): street, number, postcode, id, lon, lat, name ("BLK 512 HOUGANG AVE 10") ----------
const normSG = (x) => String(x).toLowerCase().replace(/[.\-,#/()]/g, ' ').replace(/\s+/g, ' ').trim();
async function addressesSG() {
  if (!SGS.addr) {
    const rows = JSON.parse(await readFile(new URL(SGS.C.addr, ROOT), 'utf8'));
    SGS.addr = rows.map((r) => ({ street: r[0], number: r[1], postcode: r[2], id: r[3], lon: r[4], lat: r[5], name: r[6] || '', parts: normSG(`${r[0]} ${r[6] || ''}`).split(' ').filter(Boolean), hay: normSG(`${r[0]} ${r[1]} ${r[6] || ''}`) }));
  }
  return SGS.addr;
}
function parseSG(query) {
  const toks = normSG(query).split(' ').filter(Boolean), q = { postcodes: [], number: null, words: [] };
  const bi = toks.findIndex((t) => t === 'blk' || t === 'block');
  if (bi > -1 && /^\d{1,4}[a-z]?$/.test(toks[bi + 1] || '')) q.number = toks[bi + 1];
  toks.forEach((t, i) => {
    if (['blk', 'block', 'singapore', 'sg', 's'].includes(t) || (bi > -1 && i === bi + 1)) return;
    if (/^\d{6}$/.test(t)) { q.postcodes.push(t); return; }
    if (q.number == null && i === 0 && /^\d{1,4}[a-z]?$/.test(t)) { q.number = t; return; }
    q.words.push(t);
  });
  if (q.number == null) { const j = q.words.findIndex((t) => /^\d{1,4}[a-z]?$/.test(t)); if (j > -1 && q.words.length > 1) q.number = q.words.splice(j, 1)[0]; }
  return q;
}
async function matchSG(query) {
  const all = await addressesSG(), q = parseSG(query);
  if (!q.words.length && !q.number && !q.postcodes.length) return { q, rows: [] };
  const numOk = (r) => !q.number || String(r.number).toLowerCase() === q.number || new RegExp(`\\bblk ${q.number}\\b`).test(normSG(r.name));
  const wordsOk = (r) => q.words.every((w) => r.parts.some((p) => p.startsWith(w)));
  let rows = all.filter((r) => (!q.postcodes.length || q.postcodes.includes(r.postcode)) && wordsOk(r) && numOk(r));
  const seen = new Set();
  rows = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
  return { q, rows };
}
const entrySG = (r) => ({ address: `${r.number ? r.number + ' ' : ''}${r.street || ''}`.trim() || null, name: r.name || null, postcode: r.postcode || null, osm_id: r.id, lat: r.lat, lon: r.lon, map_url: MAP_SG(r.id, r.lat, r.lon) });
async function findBuildingsSG(query, limit = 10) {
  return (await matchSG(query)).rows.slice(0, limit).map(entrySG);
}
async function locateSG(id) {
  const row = (await addressesSG()).find((r) => r.id === id);
  if (row) return { lat: row.lat, lon: row.lon };
  const needle = `"i":"${id}"`, I = SGS.idx;
  for (const f of (await readdir(new URL(SGS.C.osm, ROOT))).filter((x) => /^t_\d+_\d+\.json$/.test(x))) {
    if (!(await readFile(new URL(SGS.C.osm + f, ROOT), 'utf8')).includes(needle)) continue;
    const [ix, iy] = f.slice(2, -5).split('_').map(Number), rec = await SGS.osm.byId(id, I.bbox[0] + (ix + 0.5) * I.dlon, I.bbox[1] + (iy + 0.5) * I.dlat);
    if (rec) return { lat: (rec.bbox[1] + rec.bbox[3]) / 2, lon: (rec.bbox[0] + rec.bbox[2]) / 2 };
  }
  return null;
}

const TIER_SG = { observed: 'observed', published_table: 'published_table', assumed: 'assumed', estimate: 'estimate', user: 'user_input' };
async function buildingEnergySG(where = {}, assume = {}, opts = {}) {
  const { osm, SGA, MS, A, L } = SGS;
  const n = Math.max(50, Math.min(1000, Math.round(opts.samples || 300)));
  const year = opts.year != null && opts.year !== 'tmy' ? +opts.year : null;
  const tool = { name: 'Open Energy Map', version: VERSION, site: SITE, repository: REPO, city: 'sg', coverage: 'Singapore (pilot)', osm_snapshot: (SGS.idx.timestamp || '').slice(0, 10) || null, language: SGS.lang };
  const base = { tool, query: { ...Object.fromEntries(Object.entries(where).filter(([, v]) => v != null && v !== '')), assume, ...(year ? { weather_year: year } : {}) } };
  let lat = where.lat, lon = where.lon, osmId = where.osm_id, resolvedBy = null, match = null;
  if (osmId != null) {
    osmId = String(osmId).trim();
    if (!OSM_ID.test(osmId)) throw new UserError(`osm_id should look like w100162742 or r1234567, got ${where.osm_id}.`);
    if (lat == null || lon == null) { const p = await locateSG(osmId); if (!p) throw new UserError(`OSM id ${osmId} is not in the local Singapore data.`); ({ lat, lon } = p); }
    resolvedBy = 'osm_id';
  } else if (lat != null && lon != null) resolvedBy = 'point';
  else if (where.address) {
    const m = await matchSG(where.address);
    if (!m.rows.length) throw new UserError(`No address in the local Singapore data matches "${where.address}". Try "blk <number> <street>", the street and number, a building name or the 6-digit postcode, or give lat and lon.`);
    if (m.rows.length > 1) return { ...base, modelled: false, status: 'ambiguous', reason: `"${where.address}" fits ${m.rows.length} buildings.`, n_candidates: m.rows.length, candidates: m.rows.slice(0, 12).map(entrySG),
      next_step: 'Ask which building is meant, or choose by name and postcode; then call again with the osm_id and lat/lon of that candidate.' };
    match = entrySG(m.rows[0]); lat = match.lat; lon = match.lon; osmId = match.osm_id; resolvedBy = 'address';
  } else throw new UserError('Give an address or postcode, lat and lon, or an osm_id.');
  if (!osm.inCoverage(lon, lat)) throw new UserError(`${lat}, ${lon} is outside Singapore.`);
  let rec = osmId ? await osm.byId(osmId, lon, lat) : null;
  if (osmId && !rec) resolvedBy = 'point';
  rec = rec || await osm.buildingAt(lon, lat);
  if (!rec) throw new UserError(`No building outline at ${lat}, ${lon}.`);
  base.resolved_by = resolvedBy; base.matched_address = match || undefined;
  // the caller's assumptions, as user input on the page
  const state = { user: {} };
  if (assume.type != null || assume.usage != null) { const t = assume.type ?? assume.usage; if (!A.types[t]) throw new UserError(`type must be one of ${Object.keys(A.types).join(', ')}`); state.type = t; }
  if (assume.era != null) state.era = String(assume.era);
  if (assume.system != null) { if (!A.systems[assume.system]) throw new UserError(`system must be one of ${Object.keys(A.systems).join(', ')}`); state.system = assume.system; }
  if (assume.storeys != null) state.floors = Math.max(1, Math.round(+assume.storeys));
  for (const [k, v] of Object.entries(assume.params || {})) {
    if (!SGA.PARAM_META[k]) throw new UserError(`Unknown input ${k}; inputs: ${Object.keys(SGA.PARAM_META).join(', ')}`);
    if (!Number.isFinite(+v)) throw new UserError(`${k} must be a number`);
    state.user[k] = +v;
  }
  const nb = await osm.neighbours(rec, 150);
  const b = MS.buildModel(rec, nb, state, { A, bcaRows: SGS.bcaRows });
  const cLat = (rec.bbox[1] + rec.bbox[3]) / 2, cLon = (rec.bbox[0] + rec.bbox[2]) / 2;
  if (b.notModelled) return { ...base, building: { osm_id: rec.id, lat: rd(cLat, 6), lon: rd(cLon, 6), map_url: MAP_SG(rec.id, cLat, cLon) }, modelled: false, reason: b.notModelled.why, measured: measuredSG(b.bcaRow, null) };
  if (state.era && !(SGA.erasOf(b.m.sgType) || []).some((e) => e.id === state.era)) throw new UserError(`era must be one of ${(SGA.erasOf(b.m.sgType) || []).map((e) => e.id).join(', ') || '(none for this type)'}`);
  const W = await weatherSG(year), gef = MS.gridEF(A, year ?? 'TMY');
  const sim = MS.simulate(b.m, W, SGS.cals), s = MS.summarize(b.m, sim.ctx, sim.p, sim.res, gef.value);
  const pr = MS.priorMC(b, sim, gef.value, n, [42, 43], state);
  const m = b.m, a = m.areas, t = m.osmTags || {};
  const bandSG = (k, f = 1) => { const main = (pr.cond || pr)[k]; return { p10_p90: [sig(main[0] / f), sig(main[2] / f)], median: sig(main[1] / f), p10_p90_all_eras: pr.cond ? [sig(pr[k][0] / f), sig(pr[k][2] / f)] : undefined }; };
  const era = b.asg.eraId ? (SGA.erasOf(m.sgType) || []).find((e) => e.id === b.asg.eraId) : null;
  const geo = (key, label, value, unit, tier, source) => ({ key, label, value, unit, tier: TIER_SG[tier] || tier, source });
  const inputs = Object.entries(m.params).filter(([k, v]) => SGA.PARAM_META[k] && typeof v.value === 'number').map(([k, v]) => ({
    key: k, label: SGA.PARAM_META[k].label, group: SGA.PARAM_META[k].group, value: sig(v.value, 4), unit: SGA.PARAM_META[k].unit, tier: TIER_SG[v.tier] || v.tier,
    source: v.source || null, note: v.note || null, prior_p10_p90: v.dist === 'fixed' ? null : [sig(v.p10), sig(v.p90)],
    references: SGA.sourceRefs(`${v.source} ${v.note || ''}`).map((r) => ({ id: r.id, label: r.ref, url: r.url })),
  }));
  const out = {
    ...base,
    modelled: true,
    building: {
      osm_id: m.id, name: t.name || null, bca_name: b.bcaRow && b.bcaRow.name !== t.name ? b.bcaRow.name : undefined, address: m.address || match?.address || null,
      lat: rd(m.center.lat, 6), lon: rd(m.center.lon, 6), map_url: MAP_SG(m.id, m.center.lat, m.center.lon), osm_url: `https://www.openstreetmap.org/${m.id.startsWith('w') ? 'way' : 'relation'}/${m.id.slice(1)}`,
      planning_area: m.x?.pa || null, subzone: m.x?.sz || null, land_use: m.x?.lu || null, gross_plot_ratio: m.x?.gpr ?? m.x?.gprt ?? null,
      type: m.sgType, type_label: SGA.TYPE_CN[m.sgType], variant: m.sgVariant || null, type_source: m.usageSrc, type_tier: TIER_SG[m.usageTier] || m.usageTier, rc5_usage: m.usage,
      storeys: m.floors, height_m: rd(m.height, 1), storey_height_m: rd(m.floorHeight, 2), void_deck_m: m.voidDeck || 0,
      geometry_sources: { storeys: m.geomSrc.floors, height: m.geomSrc.height, tier: { storeys: TIER_SG[m.geomTier.floors], height: TIER_SG[m.geomTier.height] }, height_p10_p90_m: m.geomPrior.h90 > m.geomPrior.h10 ? [rd(m.geomPrior.h10), rd(m.geomPrior.h90)] : null },
      era: era ? { used: era.id, period: SGA.eraLabel(era), label: era.label_en, year: b.eraInfo.year || null, source: b.eraInfo.src, tier: TIER_SG[state.era ? 'user' : b.eraInfo.tier], prior: b.eraInfo.kind === 'prior' && !state.era ? Object.fromEntries(Object.entries(b.eraInfo.p).map(([k, v]) => [k, rd(v, 3)])) : undefined } : null,
      footprint_m2: Math.round(a.footprint), reference_area_m2: Math.round(a.netFloor), reference_area_basis: a.refBasis, reference_area_source: a.refSrc, reference_area_tier: TIER_SG[a.refTier] || a.refTier,
      reference_area_check: a.refCheck ? Object.fromEntries(Object.entries(a.refCheck).map(([k, v]) => [k, typeof v === 'number' ? sig(v, 6) : v])) : null,
      gfa_m2: Math.round(a.gfa), gfa_source: a.gfaSrc,
      hdb: m.x?.hdb ? { blk: m.x.hdb.blk, street: m.x.hdb.street, postcode: m.x.hdb.pc || null, year_completed: m.x.hdb.year, max_floor_level: m.x.hdb.levels, units: m.x.hdb.units, records_per_block: m.x.hdb.n || 1 } : undefined,
      bca_listed: !!b.bcaRow,
      cooling_system: { key: b.asg.sysKey, label: A.systems[b.asg.sysKey]?.label_en, scope: A.systems[b.asg.sysKey]?.scope, source: b.asg.sysSrc || (b.asg.systemShares ? `type prior: ${Object.entries(b.asg.systemShares).map(([k, v]) => `${k} ${rd(100 * v, 0)}%`).join(', ')}` : 'type default') },
    },
    results: {
      weather: W.name || (year ? `ERA5 ${year}` : 'typical year from hourly ERA5 data 2010–2025 (Open-Meteo)'), weather_year: year || 'typical year',
      area_basis: `per m² of the reference area (${a.refBasis}); eui_per_gfa per m² GFA`,
      cooling_demand: { what: 'cooling demand of the air conditioning (useful cooling), sensible + latent', unit: 'kWh/(m²·a)', value: sig(s.cool), ...bandSG('cool'), sensible: sig(s.coolSens), latent: sig(s.coolLat), annual_MWh: sig(s.coolKWh / 1000), ac_hours: s.acHours },
      electricity: { what: 'electricity at the building meter: cooling (demand ÷ COP), lighting, equipment, other', unit: 'kWh/(m²·a)', value: sig(s.elec.total), ...bandSG('e_total'), annual_MWh: sig(s.elecKWh / 1000),
        by_end_use: Object.fromEntries(['cooling', 'lighting', 'equipment', 'other'].map((k) => [k, { value: sig(s.elec[k]), ...bandSG('e_' + k) }])) },
      eui_per_gfa: { what: 'electricity per m² GFA, the basis of BCA EUI', unit: 'kWh/(m²·a)', value: sig(s.eui), ...bandSG('eui'), gfa_m2: Math.round(a.gfa) },
      co2: { unit: 't/a', value: sig(s.co2t), ...bandSG('co2t'), per_m2_kg: sig(s.co2kg), grid_emission_factor: { value: gef.value, unit: 'kg CO2/kWh', year: gef.year, typical_year: gef.tmy || undefined, source: gef.source } },
      peak_cooling_load: { what: 'hourly maximum of the cooling load (sensible + latent)', unit: 'kW', value: sig(s.peakW / 1000), per_m2_W: sig(s.peakWm2), per_m2_W_p10_p90: bandSG('peakWm2').p10_p90 },
      ranges: `value: the model with the point values of the inputs. p10_p90 and median: ${n} draws of the inputs (independent; two-piece normal through each input's P10, value and P90)${pr.cond ? ', with the era fixed at the one used; p10_p90_all_eras: over all eras' : ''}.`,
    },
    measured: measuredSG(b.bcaRow, s),
    uncertainty: { what: 'first-order share of each sampled input in the variance of the electricity per m² (approximate)', shares: MS.varShares(pr).slice(0, 10).map((x) => ({ input: x.key, share: rd(x.share, 3) })) },
    geometry_inputs: [
      geo('type', 'Type', m.sgType, null, m.usageTier, m.usageSrc), era ? geo('era', 'Era', era.id, null, state.era ? 'user' : b.eraInfo.tier, b.eraInfo.src) : null,
      geo('storeys', 'Storeys', m.floors, null, m.geomTier.floors, m.geomSrc.floors), geo('height', 'Height', rd(m.height, 1), 'm', m.geomTier.height, m.geomSrc.height),
      geo('footprint', 'Footprint', Math.round(a.footprint), 'm²', 'observed', 'OSM outline'), geo('reference_area', 'Reference area', Math.round(a.netFloor), 'm²', a.refTier, a.refSrc),
      geo('gfa', 'GFA', Math.round(a.gfa), 'm²', SGA.RES_TYPES.includes(m.sgType) ? 'assumed' : a.refTier, a.gfaSrc),
      geo('wwr', 'Window-to-wall ratio', m.params.WWR?.value ?? null, '–', m.params.WWR?.tier || 'assumed', m.params.WWR?.source || null),
    ].filter(Boolean),
    inputs,
    tiers: { observed: 'measured or recorded for this building (OSM, HDB, URA, BCA listing) or computed from Singapore records', published_table: 'from a code, standard or official table', assumed: 'an assumption with the rule stated', estimate: 'a model estimate (GlobalBuildingAtlas height, storey heights)', user_input: 'given by the caller with assume' },
    sources: SOURCES_SG,
    disclaimer: 'Research prototype, Singapore pilot. Estimates from open data and published literature for reference only; they do not replace an energy audit or an on-site assessment.',
    licence: 'Results: CC BY-NC 4.0; code and model: PolyForm Noncommercial 1.0.0; third-party data under the licences in sources. Commercial use needs a licence (x.c.chen@tum.de).',
    cite: 'Open Energy Map, (c) 2026 Xia Chen, ' + REPO,
  };
  if (opts.internal) return { json: out, m, b, sim, s, pr };
  return opts.detail === 'summary' ? { ...out, detail: 'summary (call again with detail "full" for every note and reference)', inputs: out.inputs.map((i) => ({ key: i.key, value: i.value, unit: i.unit, tier: i.tier, prior_p10_p90: i.prior_p10_p90, reference: i.references[0]?.id || i.source })), tiers: undefined } : out;
}
// the BCA listing of the building: measured, never an input; values outside 20–1000 kWh/(m²·a) flagged
function measuredSG(row, s) {
  const M = row ? SGS.MS.measured(row) : null;
  if (!M) return null;
  const y19 = M.years.find((y) => y.year === 2019);
  return {
    what: 'measured EUI published by BCA (annual electricity at the building meter ÷ GFA); for comparison only, never a model input',
    unit: 'kWh/(m²·a)', name: M.name, address: M.address, postcode: M.postcode, bca_type: M.type, gfa_m2: M.gfa, top_year: M.topYear, ac_system: M.acSystem, combined_metering: M.combined || undefined,
    match: { method: M.match, confidence: M.conf, name_differs_from_osm: M.nameConflict || undefined, outlines_in_listing: M.outlines },
    eui_by_year: M.years.map((y) => ({ year: y.year, value: y.eui, source: y.src, plausible: y.plausible, note: !y.plausible ? 'implausible in the source (below 20 or above 1000)' : y.covid ? 'COVID year' : undefined })),
    eui_2019: y19 ? (y19.plausible ? y19.eui : null) : null,
    model_eui_per_gfa: s ? sig(s.eui) : undefined,
    source: SGS.bcaSource,
  };
}
const SOURCES_SG = [
  { data: 'Building outlines, tags, addresses', source: '© OpenStreetMap contributors', licence: 'ODbL 1.0' },
  { data: 'HDB Property Information, HDB Existing Building, URA Master Plan 2019 land use and boundaries, BCA Building Energy Performance Data 2017–2020, Singapore public holidays', source: 'data.gov.sg (HDB, URA, BCA, MOM), accessed 2026-11-25', licence: 'Singapore Open Data Licence v1.0, https://data.gov.sg/open-data-licence' },
  { data: 'BCA Building Energy Benchmarking Report data 2022–2025', source: 'Building and Construction Authority, https://go.gov.sg/bca-bebr-data', licence: 'terms of the BCA website' },
  { data: 'Building heights (LoD1)', source: 'GlobalBuildingAtlas, Zhu et al. 2025', licence: 'CC BY-NC 4.0' },
  { data: 'Hourly weather (ERA5)', source: 'Open-Meteo, Copernicus Climate Change Service', licence: 'CC BY 4.0' },
  { data: 'Grid emission factor, household electricity', source: 'EMA Singapore Energy Statistics', licence: 'EMA terms of use' },
  { data: 'Archetype parameters', source: 'BCA codes and Green Mark, NEA, SingStat, HDB and the literature in data/archetypes_sg_sources.md', licence: 'cited per input' },
];

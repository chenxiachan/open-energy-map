// Open Energy Map for agents: the model of the map for one building, returned as JSON in which every input carries
// its source tier and references, so an agent can quote building energy it can trace instead of making it up.
// Shared by the command line and the MCP server (agent/oem.mjs).
//
// The steps are those of the page (js/main.js select → rebuild), on the same modules and data: the OSM outline and
// its neighbours within 150 m, the Bavarian LoD2 model, the Zensus 2022 priors for the construction age and the
// heating carrier, the typology table, shading, the hourly 5R1C model with the typical year, the prior Monte Carlo
// for the ranges and the self-checks. Assumptions given by the caller enter as user input, as on the page.
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
export const SITE = 'https://chenxiachan.github.io/open-energy-map/';
export const REPO = 'https://github.com/chenxiachan/open-energy-map';
export const VERSION = '2026-11-18';
const RES = ['sfh', 'th', 'mfh', 'ab'];

// tiers as on the page (js/main.js TIER_OF): what kind of evidence a value rests on
const TIER_OF = { osm: 'observed', geometry: 'observed', lod2: 'observed', archetype: 'published_table', profile: 'published_table', zensus: 'published_table', default: 'assumed', user: 'user_input', calibrated: 'bill_calibrated' };
const VAR_TIER = { age: 'zensus', wwrScale: 'default', hScale: 'default', anScale: 'default', n50: 'default', heatedFrac: 'default', T_heat: 'profile', n_vent: 'profile', Q_int: 'profile' };

let S = null;   // modules and data, loaded once per process

export async function init(lang = 'en') {
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
  const [i18n, G, Arch, solar, rc5, sys, osm, prior, checks, refs] = await Promise.all(
    ['js/i18n.js', 'js/geometry.js', 'js/archetype.js', 'js/solar.js', 'js/rc5.js', 'js/systems.js', 'js/osmdb.js', 'js/prior.js', 'js/checks.js', 'js/refs.js'].map(im));
  const idx = await osm.loadIndex('data/osm/');
  const A = await Arch.loadArchetypes('data/archetypes_de.json');
  sys.setFactors(A);
  refs.setSources(A.meta && A.meta.sources);
  await osm.loadZensus('data/zensus/baujahr.json');
  await osm.loadHeating('data/zensus/heizung.json');
  const wIdx = JSON.parse(await readFile(new URL('data/weather/index.json', ROOT), 'utf8'));
  const W = JSON.parse(await readFile(new URL('data/weather/' + wIdx.tmy.file, ROOT), 'utf8'));
  for (const k of ['T', 'GHI', 'DNI', 'DHI']) W[k] = Float32Array.from(W[k]);
  S = { lang: i18n.LANG, L: i18n.L, G, Arch, solar, rc5, sys, osm, prior, checks, refs, A, idx, W, wIdx, addr: null };
  return S;
}

// ---------- addresses (data/osm/addr.json, the index behind the search field of the page) ----------
const norm = (s) => String(s).toLowerCase().replace(/ß/g, 'ss').replace(/straße|strasse/g, 'str').replace(/[.\-,/]/g, ' ').replace(/\s+/g, ' ').trim();
const CITY_WORDS = new Set(['münchen', 'munchen', 'muenchen', 'munich', 'germany', 'deutschland', 'bayern', 'bavaria', 'de']);

async function addresses() {
  if (!S.addr) {
    const rows = JSON.parse(await readFile(new URL('data/osm/addr.json', ROOT), 'utf8'));
    // street, number, postcode, OSM id, lon, lat, name
    S.addr = rows.map((r) => ({ street: r[0], number: r[1], postcode: r[2], id: r[3], lon: r[4], lat: r[5], name: r[6] || '', key: norm(`${r[0]} ${r[1]} ${r[6] || ''}`) }));
  }
  return S.addr;
}

export async function findBuildings(query, limit = 10) {
  await init();
  const rows = await addresses();
  const toks = norm(query).split(' ').filter((t) => t && !CITY_WORDS.has(t));
  const pcs = toks.filter((t) => /^\d{5}$/.test(t)), words = toks.filter((t) => !/^\d{5}$/.test(t));
  if (!words.length && !pcs.length) return [];
  const hits = [];
  for (const r of rows) {
    if (pcs.length && !pcs.includes(r.postcode)) continue;
    if (!words.every((t) => r.key.includes(t))) continue;
    const parts = r.key.split(' ');
    // exact house number and whole words first, then the shorter entries
    const score = words.filter((t) => parts.includes(t)).length * 10 - r.key.length / 100;
    hits.push({ r, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map(({ r }) => ({
    address: [`${r.street} ${r.number}`.trim(), [r.postcode, 'München'].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    name: r.name || null, osm_id: r.id, lat: r.lat, lon: r.lon, map_url: mapUrl(r.id, r.lat, r.lon),
  }));
}

const mapUrl = (id, lat, lon) => `${SITE}#b=${id}@${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;
const sig = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : +x.toPrecision(d));
const rd = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const absUrl = (u) => (!u ? null : /^https?:/.test(u) ? u : `${REPO}/blob/main/${u.replace(/^\.?\//, '')}`);

class UserError extends Error {}
export { UserError };

// ---------- one building ----------
// where: { address } | { lat, lon } | { osm_id, lat?, lon? }; assume: what the caller knows (user input on the page)
export async function buildingEnergy(where = {}, assume = {}, opts = {}) {
  await init();
  const { G, Arch, solar, rc5, sys, osm, prior, checks, refs, A, L } = S;
  const n = Math.max(50, Math.min(1000, Math.round(opts.samples || 300)));
  let match = null, lat = where.lat, lon = where.lon;
  if (where.address) {
    const hits = await findBuildings(where.address, 5);
    if (!hits.length) throw new UserError(`No address in the local data matches "${where.address}". The map covers Munich and its surroundings; try the street and house number, or give lat/lon.`);
    match = hits[0]; lat = match.lat; lon = match.lon; where = { ...where, osm_id: where.osm_id || match.osm_id };
    match.other_candidates = hits.slice(1).map((h) => h.address);
  }
  if (where.osm_id && (lat == null || lon == null)) {
    const row = (await addresses()).find((r) => r.id === where.osm_id);
    if (!row) throw new UserError(`OSM id ${where.osm_id} needs lat and lon (it has no address in the local index).`);
    lat = row.lat; lon = row.lon;
  }
  if (lat == null || lon == null) throw new UserError('Give an address, lat and lon, or an OSM id.');
  if (!osm.inCoverage(lon, lat)) throw new UserError(`${lat}, ${lon} is outside the area covered so far (Munich and its surroundings).`);
  const rec = (where.osm_id && await osm.byId(where.osm_id, lon, lat)) || await osm.buildingAt(lon, lat);
  if (!rec) throw new UserError(`No building outline at ${lat}, ${lon}.`);

  const nbRecs = await osm.neighbours(rec, 150);
  const cLon = (rec.bbox[0] + rec.bbox[2]) / 2, cLat = (rec.bbox[1] + rec.bbox[3]) / 2;
  const lod2Map = await osm.lod2Around(cLon, cLat);
  const base = { tool: toolInfo(), query: { ...where, assume }, matched_address: match };
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
  const band = (k, f = 1) => {
    const main = (pr.cond || pr)[k];
    return { p10_p90: [sig(main[0] / f), sig(main[2] / f)], median: sig(main[1] / f), p10_p90_all_ages: pr.cond ? [sig(pr[k][0] / f), sig(pr[k][2] / f)] : undefined };
  };
  const systems = sys.factors().systems;
  const sp = Arch.systemPrior(ageInfo.heat, asg.cls);

  // the prior range of each input, from draws of the prior as in the parameter table of the page
  const draw = Arch.makePrior(m, ageInfo, state, asg), rg = Arch.rng(5), draws = Array.from({ length: 400 }, () => draw(rg).p);
  const q = (k, f) => { const a = draws.map((d) => d[k]).filter((v) => typeof v === 'number').sort((x, y) => x - y); return a.length ? a[Math.round(f * (a.length - 1))] : null; };
  const inputs = [];
  for (const [k, meta] of Object.entries(Arch.PARAM_META)) {
    const pv = m.params[k];
    if (!pv) continue;
    const comp = { U_window: 'windows', g_window: 'windows', U_wall: 'wall', U_roof: 'roof', U_floor: 'floor' }[k];
    const rs = comp ? state.refurb[comp] : null, share = comp ? (rs === 'yes' ? 1 : rs === 'no' ? 0 : asg.mp[comp] || 0) : 0;
    const refList = refs.refsFor(k, { param: pv, share, state: rs, residential: RES.includes(m.usage), system: systems[m.params.system.value] });
    let range = null;
    if (k.startsWith('WWR_') && q('wwrScale', 0.1) != null) range = [sig(pv.value * q('wwrScale', 0.1)), sig(pv.value * q('wwrScale', 0.9))];
    else if (Arch.UNCERTAIN.includes(k) && q(k, 0.1) != null) range = [sig(q(k, 0.1)), sig(q(k, 0.9))];
    inputs.push({
      key: k, label: meta.label, group: meta.group,
      value: k === 'system' ? pv.value : sig(pv.value, 4), value_label: k === 'system' ? systems[pv.value]?.label || pv.value : undefined, unit: meta.unit || null,
      tier: TIER_OF[pv.source] || 'assumed', source: Arch.SOURCE_CN[pv.source] || pv.source, note: pv.note || null,
      prior_p10_p90: range, prior_shares: k === 'system' && pv.source !== 'user' && sp ? Object.fromEntries(Object.entries(sp).sort((a, b) => b[1] - a[1]).map(([s, v]) => [s, rd(v, 3)])) : undefined,
      references: refList.map((r) => ({ tier: TIER_OF[r.tier] || 'assumed', label: r.label, where: r.where || null, url: absUrl(r.url) })),
    });
  }
  const varLabel = (key) => (key === 'age' ? L('建成年代', 'Construction age', 'Baualtersklasse') : key === 'wwrScale' ? L('窗墙比', 'Window-to-wall ratio', 'Fensterflächenanteil') : key === 'hScale' ? L('层数（缺省）', 'Storeys (default)', 'Geschosse (Standardwert)') : key === 'anScale' ? L('参考面积（层高偏差）', 'Reference area (storey height bias)', 'Gebäudenutzfläche (Abweichung der Geschosshöhe)') : Arch.PARAM_META[key]?.label || key);
  const shares = prior.varShares(pr).slice(0, 10).map((it) => ({ input: it.key, label: varLabel(it.key), share: rd(it.share, 3), tier: TIER_OF[VAR_TIER[it.key] || (m.params[it.key]?.source === 'user' ? 'user' : 'archetype')] }));
  const GSRC = (s) => (s == null ? null : /^LoD2/.test(s) ? 'observed' : /^osm/.test(s) ? 'observed' : s === 'user' ? 'user_input' : 'assumed');

  const out = {
    ...base,
    modelled: true,
    building: {
      osm_id: m.id, name: tags.name || null,
      address: [tags['addr:street'] && `${tags['addr:street']} ${tags['addr:housenumber'] || ''}`.trim(), tags['addr:postcode'] && `${tags['addr:postcode']} ${tags['addr:city'] || 'München'}`].filter(Boolean).join(', ') || match?.address || null,
      lat: rd(m.center.lat, 6), lon: rd(m.center.lon, 6), map_url: mapUrl(m.id, m.center.lat, m.center.lon), osm_url: `https://www.openstreetmap.org/${m.id.startsWith('w') ? 'way' : 'relation'}/${m.id.slice(1)}`,
      usage: m.usage, usage_label: Arch.TYPE_CN[m.usage], usage_source: m.usageSrc || null, possibly_unheated: !m.heated || undefined,
      storeys: m.floors, height_m: rd(m.height, 1), storey_height_m: rd(m.floorHeight, 2), roof: m.roof?.shape || null, attic: m.roof?.attic || null,
      geometry_sources: { height: m.geomSrc?.height || null, storeys: m.geomSrc?.floors || null, roof: m.geomSrc?.roof || null, tier: { height: GSRC(m.geomSrc?.height), storeys: GSRC(m.geomSrc?.floors) } },
      lod2_id: m.lod2?.lod2 || null, party_wall_share: rd(m.facades.reduce((t, f) => t + f.length * (1 - f.exposed), 0) / Math.max(1e-9, m.facades.reduce((t, f) => t + f.length, 0)), 2),
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

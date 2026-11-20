// CityGML 2.0 with the Energy ADE 3.0 (beta 7) of one building, from the model of the page.
//   buildEnergyADE(bm, ctx) → string (XML)
// bm: the BModel (js/geometry.js, with params, areas, facades); ctx: { res, fe, pr, inputs (js/trace.js), profile,
// ids: { osm, lod2, osmSnapshot }, address: { street, number, postcode }, groundElevation, lod2Function, weatherName,
// version, site, mapUrl, created }. Pure ES module without dependencies; runs in the browser and in Node.
//
// What is written:
// - CRS: ETRS89 / UTM 32N (EPSG:25832) with DHHN2016 heights (EPSG:7837), as the Bavarian LoD2. The data of the map
//   hold heights above ground only, so the ground lies at ctx.groundElevation (default 519 m, the mean elevation of
//   Munich); the provenance attributes say so.
// - Geometry: the thermal hull of the model as LoD2 boundary surfaces: the outline (with courtyards) as GroundSurface,
//   one WallSurface per facade, the part of a facade shared with a neighbour up to the neighbour's height as
//   PartyWallSurface (adiabatic, as in the model), the top as RoofSurface at eaves height. Pitched roofs are not
//   built as faces: the roof type and ridge height are in roofType and measuredHeight, the sloped area and pitch of
//   the model in the attributes of the RoofSurface. No solid is written.
// - Energy ADE: one ThermalZone (the model has one zone) whose thermal boundaries are the boundary surfaces, one
//   UsageZone (set points, ventilation, internal gains), the constructions (U-values, g-value and glazing ratio of the
//   windows) in a LayeredConstructionLibrary, the heat generator (Boiler or HeatPump), and Energy resources: useful
//   heat for space heating with the hourly series of the typical year, final energy for heating and hot water with the
//   carrier and CO2, primary energy.
// - Ranges and source tiers have no element in Energy ADE 3.0 beta 7. They are written as CityGML generic attribute
//   sets on the building: OEM_result_* (value, median, P10 and P90), OEM_input_* (value, prior P10 and P90, tier,
//   source, note, first reference) and OEM_provenance.

export const SRS = 'urn:ogc:def:crs,crs:EPSG::25832,crs:EPSG::7837';
const NS = {
  core: 'http://www.opengis.net/citygml/2.0', bldg: 'http://www.opengis.net/citygml/building/2.0', gen: 'http://www.opengis.net/citygml/generics/2.0',
  gml: 'http://www.opengis.net/gml', xlink: 'http://www.w3.org/1999/xlink', xAL: 'urn:oasis:names:tc:ciq:xsdschema:xAL:2.0',
  nrg3: 'http://www.citygml.org/ade/energy/3.0', xsi: 'http://www.w3.org/2001/XMLSchema-instance',
};
export const ENERGY_ADE_XSD = 'https://raw.githubusercontent.com/tudelft3d/Energy_ADE/main/xsd/Energy_ADE_3.0_beta7.xsd';
const SCHEMA_LOCATION = [
  NS.bldg, 'http://schemas.opengis.net/citygml/building/2.0/building.xsd',
  NS.gen, 'http://schemas.opengis.net/citygml/generics/2.0/generics.xsd',
  NS.nrg3, ENERGY_ADE_XSD,
].join(' ');
const CL = {   // code spaces: the code lists of the Energy ADE repository and of SIG3D for CityGML 2.0
  nrg: (n) => `https://github.com/tudelft3d/Energy_ADE/blob/main/xsd/codelists/${n}.xml`,
  roof: 'http://www.sig3d.org/codelists/standard/building/2.0/_AbstractBuilding_roofType.xml',
  alkis: 'https://www.adv-online.de/GeoInfoDok/AX_Gebaeude_Gebaeudefunktion',
};
const ROOF = { flat: 'flat roof', skillion: 'monopitch roof', gabled: 'gabled roof', hipped: 'hipped roof', pyramidal: 'pavilion roof', mansard: 'mansard roof' };
const BDG_TYPE = { sfh: 'single-family house', th: 'terraced house', mfh: 'multi-family house', ab: 'apartment block', office: 'office building', retail: 'commercial building' };
const USAGE = { sfh: 'residential', th: 'residential', mfh: 'residential', ab: 'residential', office: 'office', education: 'education', retail: 'retail', other: 'other' };
// systems.js keys → Energy ADE carrier and source code lists, and the device
const CARRIER = { gas_cond: 'naturalGas', gas_old: 'naturalGas', oil: 'fuelOil', pellet: 'woodPallets', district: 'hotWater', hp_air: 'electricity', hp_ground: 'electricity', electric: 'electricity' };
const SOURCE = { district: 'districtHeating', hp_air: 'heatPump', hp_ground: 'heatPump', electric: 'powerGrid' };

// ---------- coordinates: local metres of the BModel → lon/lat (js/geo.js makeFrame) → UTM 32N (GRS80) ----------
export function utm32(lon, lat) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lam0 = (9 * Math.PI) / 180;
  const n = f / (2 - f), A = (a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const al = [0, n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180 - lam0, c = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi = Math.atan(t / Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) { E += al[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); N += al[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
  return [500000 + k0 * A * E, k0 * A * N];
}
const frame = (c) => { const kx = 111320 * Math.cos((c.lat * Math.PI) / 180); return (x, y) => [c.lon + x / kx, c.lat + y / 110540]; };

// ---------- small XML writer ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const comment = (s) => String(s).replace(/-{2,}/g, '-');
const num = (x, d = 3) => { if (x == null || !Number.isFinite(+x)) return null; const s = (+x).toFixed(d); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };
const at = (o) => Object.entries(o || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
class W {
  constructor() { this.out = []; this.d = 0; }
  line(s) { this.out.push('  '.repeat(this.d) + s); }
  open(t, a) { this.line(`<${t}${at(a)}>`); this.d++; }
  close(t) { this.d--; this.line(`</${t}>`); }
  leaf(t, v, a) { if (v == null || v === '') return; this.line(`<${t}${at(a)}>${esc(v)}</${t}>`); }
  ref(t, id) { this.line(`<${t} xlink:href="#${esc(id)}"/>`); }
  wrap(t, a, fn) { this.open(t, a); fn(); this.close(t); }
}

// ---------- the hull ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sarea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };
const orient = (r, ccw) => { const c = r.filter((p, i) => i === 0 || dist(p, r[i - 1]) > 1e-6); if (c.length > 1 && dist(c[0], c[c.length - 1]) < 1e-6) c.pop(); return (sarea(c) > 0) === ccw ? c : c.reverse(); };

function hull(bm) {
  const H = bm.height, outer = orient(bm.outer, true), holes = (bm.holes || []).map((h) => orient(h, false)).filter((h) => h.length >= 3);
  const facades = Array.isArray(bm.facades) ? bm.facades : [];
  const find = (a, b) => {
    for (const f of facades) {
      if (!f.a || !f.b) continue;
      if (dist(f.a, a) < 0.05 && dist(f.b, b) < 0.05) return { f, rev: false };
      if (dist(f.a, b) < 0.05 && dist(f.b, a) < 0.05) return { f, rev: true };
    }
    return null;
  };
  const quad = (a, b, z0, z1) => [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]];
  const walls = [];
  [outer, ...holes].forEach((ring) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], L = dist(a, b);
      if (L < 0.02) continue;
      const az = ((Math.atan2(b[1] - a[1], -(b[0] - a[0])) * 180) / Math.PI + 360) % 360;   // outward normal (dy, −dx), clockwise from north
      const hit = find(a, b), f = hit?.f;
      const segs = f && Array.isArray(f.segments) && f.segments.length ? f.segments.map((s) => (hit.rev ? { ...s, t0: 1 - s.t1, t1: 1 - s.t0 } : s)) : [{ t0: 0, t1: 1, exposed: true }];
      const at_ = (t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const exp = [], party = [];
      for (const s of segs) {
        const p = at_(s.t0), q = at_(s.t1), w = (s.t1 - s.t0) * L;
        if (w < 0.01) continue;
        if (s.exposed) { exp.push({ poly: quad(p, q, 0, H), area: w * H }); continue; }
        const hN = Math.min(H, Number.isFinite(s.neighborHeight) ? s.neighborHeight : H);
        if (hN > 0.01) party.push({ poly: quad(p, q, 0, hN), area: w * hN });
        if (H - hN > 0.05) exp.push({ poly: quad(p, q, hN, H), area: w * (H - hN) });
      }
      const wallArea = exp.reduce((t, x) => t + x.area, 0);
      if (exp.length) walls.push({ kind: 'WallSurface', facade: f?.id, orient: f?.orient, az: f?.azimuth ?? az, polys: exp.map((x) => x.poly), area: wallArea, ratio: f && wallArea > 0 ? Math.min(0.95, (f.windowArea || 0) / wallArea) : 0 });
      if (party.length) walls.push({ kind: 'PartyWallSurface', facade: f?.id, orient: f?.orient, az: f?.azimuth ?? az, polys: party.map((x) => x.poly), area: party.reduce((t, x) => t + x.area, 0) });
    }
  });
  const fp = sarea(outer) + holes.reduce((t, h) => t + sarea(h), 0);
  const ground = { kind: 'GroundSurface', rings: [outer.slice().reverse(), ...holes.map((h) => h.slice().reverse())].map((r) => r.map((p) => [p[0], p[1], 0])), area: fp };
  const roof = { kind: 'RoofSurface', rings: [outer, ...holes].map((r) => r.map((p) => [p[0], p[1], H])), area: fp };
  return { walls, ground, roof, footprint: fp, H };
}

// ---------- the document ----------
export function buildEnergyADE(bm, ctx = {}) {
  const { res, fe, pr, inputs = [], profile = {}, ids = {}, address = {} } = ctx;
  const P = bm.params, pv = (k) => (P[k] ? P[k].value : null);
  const Z0 = Number.isFinite(ctx.groundElevation) ? ctx.groundElevation : 519;
  const toLL = frame(bm.center);
  const cache = new Map();
  const xyz = ([x, y, z]) => { const k = `${x},${y}`; if (!cache.has(k)) cache.set(k, utm32(...toLL(x, y))); const [E, N] = cache.get(k); return [E, N, Z0 + z]; };
  const id0 = `OEM_${ids.osm || bm.id || 'building'}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  const h = hull(bm);
  const env = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  const posList = (ring) => {
    const pts = [...ring, ring[0]].map(xyz);
    for (const [x, y, z] of pts) { env.x0 = Math.min(env.x0, x); env.y0 = Math.min(env.y0, y); env.z0 = Math.min(env.z0, z); env.x1 = Math.max(env.x1, x); env.y1 = Math.max(env.y1, y); env.z1 = Math.max(env.z1, z); }
    return pts.map((p) => `${num(p[0], 3)} ${num(p[1], 3)} ${num(p[2], 3)}`).join(' ');
  };
  const w = new W();
  let polyN = 0;
  const multiSurface = (sid, polygons) => w.wrap('bldg:lod2MultiSurface', null, () => w.wrap('gml:MultiSurface', { 'gml:id': `${sid}_geom`, srsName: SRS, srsDimension: 3 }, () => {
    for (const rings of polygons) {
      w.wrap('gml:surfaceMember', null, () => w.wrap('gml:Polygon', { 'gml:id': `${id0}_poly_${++polyN}` }, () => {
        rings.forEach((r, i) => w.wrap(i === 0 ? 'gml:exterior' : 'gml:interior', null, () => w.wrap('gml:LinearRing', null, () => w.leaf('gml:posList', posList(r)))));
      }));
    }
  }));
  const ang = (t, v) => w.leaf(t, num(v, 1), { uom: 'decimal degree' });
  const area = (t, v) => w.leaf(t, num(v, 2), { uom: 'm^2' });
  const ratio = (t, v) => w.leaf(t, num(v, 3), { uom: 'unit interval' });
  const code = (t, v, list) => w.leaf(t, v, { codeSpace: CL.nrg(list) });
  const gAttr = {
    measure: (name, v, uom) => { if (v == null || !Number.isFinite(+v)) return; w.wrap('gen:measureAttribute', { name }, () => w.leaf('gen:value', String(+(+v).toPrecision(4)), { uom: uom || '1' })); },
    str: (name, v) => { if (v == null || v === '') return; w.wrap('gen:stringAttribute', { name }, () => w.leaf('gen:value', v)); },
  };

  // constructions
  const lc = {
    wall: { u: pv('U_wall'), name: 'External wall' }, roof: { u: pv('U_roof'), name: 'Roof or top ceiling' }, floor: { u: pv('U_floor'), name: 'Ground floor or basement ceiling' },
    window: { u: pv('U_window'), g: pv('g_window'), glazing: P.frameFrac ? 1 - pv('frameFrac') : null, name: 'Window' },
  };
  const lcId = (k) => `${id0}_construction_${k}`;
  const surfaces = [];   // ids, for the thermal zone
  const surface = (s, sid, cons) => {
    surfaces.push(sid);
    const tag = s.kind === 'PartyWallSurface' ? 'nrg3:PartyWallSurface' : `bldg:${s.kind}`;
    w.wrap('bldg:boundedBy', null, () => w.wrap(tag, { 'gml:id': sid }, () => {
      w.leaf('gml:name', s.label);
      for (const c of cons) w.ref('nrg3:layeredConstruction', lcId(c));
      multiSurface(sid, s.rings ? [s.rings] : s.polys.map((p) => [p]));
      ang('nrg3:bdgBdrySurfAzimuth', s.azimuth);
      ang('nrg3:bdgBdrySurfInclination', s.inclination);
      w.leaf('nrg3:bdgBdrySurfIsAdiabatic', s.kind === 'PartyWallSurface' ? 'true' : 'false');
      if (s.opaque != null) area('nrg3:bdgBdrySurfOpaqueSurfaceArea', s.opaque);
      ratio('nrg3:bdgBdrySurfOpeningToSurfaceRatio', s.ratio || 0);
      area('nrg3:bdgBdrySurfTotalSurfaceArea', s.total ?? s.area);
    }));
  };

  // ----- header -----
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<!--\n${comment([
    `Open Energy Map${ctx.version ? ` (${ctx.version})` : ''}: building energy model of ${[address.street && `${address.street} ${address.number || ''}`.trim(), ids.osm && `OSM ${ids.osm}`].filter(Boolean).join(', ')}`,
    `CityGML 2.0 with the Energy ADE 3.0 beta 7 (${ENERGY_ADE_XSD})`,
    ctx.mapUrl ? `On the map: ${ctx.mapUrl}` : '',
    '',
    'Geometry: the thermal hull of the model as LoD2 boundary surfaces (OSM outline, heights from the Bavarian LoD2 model',
    'where it covers the building); pitched roofs are kept as roof type, ridge height and the sloped area of the',
    `RoofSurface, not as faces. Heights: ground at ${num(Z0, 1)} m DHHN2016 (${ctx.groundElevation != null ? 'given' : 'assumed, the mean elevation of Munich'}).`,
    'Ranges (P10 to P90) and the source tier of every input have no element in Energy ADE 3.0 beta 7; they are in the',
    'generic attribute sets OEM_result_*, OEM_input_* and OEM_provenance of the building.',
    '',
    'Results: CC BY-NC 4.0, Open Energy Map, (c) 2026 Xia Chen. Data: (c) OpenStreetMap contributors (ODbL), LoD2',
    '(c) Bayerische Vermessungsverwaltung (CC BY 4.0), Zensus 2022 (dl-de/by-2-0), ERA5 via Open-Meteo (CC BY 4.0),',
    'IWU / TABULA, DIN V 18599, GEG 2024. Research estimates for reference only, not an energy performance certificate.',
  ].join('\n'))}\n-->`);

  // ----- library of constructions -----
  const lib = () => {
    const ww = w;   // write into w
    ww.wrap('core:cityObjectMember', null, () => ww.wrap('nrg3:LayeredConstructionLibrary', { 'gml:id': `${id0}_constructions` }, () => {
      ww.leaf('gml:name', 'Constructions of the model');
      ww.leaf('nrg3:source', 'Open Energy Map: IWU / TABULA German residential typology (2015), retrofit shares IWU (2018), DIN V 18599 and GEG 2024; see OEM_input_* of the building for every value with its range and references');
      ww.leaf('nrg3:author', 'Open Energy Map');
      for (const [k, c] of Object.entries(lc)) {
        if (c.u == null) continue;
        ww.wrap('nrg3:libraryMember', null, () => ww.wrap('nrg3:LayeredConstruction', { 'gml:id': lcId(k) }, () => {
          ww.leaf('gml:description', k === 'wall' ? `Thermal bridges are added in the model as ${num(pv('dU_tb'), 3)} W/(m2 K) over the whole envelope (not included here).`
            : k === 'window' ? 'The windows of the walls that reference this construction; their share of the wall area is bdgBdrySurfOpeningToSurfaceRatio of the wall.' : null);
          ww.leaf('gml:name', c.name);
          ww.leaf('nrg3:uValue', num(c.u, 3), { uom: 'W/(K*m^2)' });
          if (c.g != null) ww.leaf('nrg3:gValue', num(c.g, 3), { uom: 'unit interval' });
          if (c.glazing != null) ww.leaf('nrg3:glazingRatio', num(c.glazing, 3), { uom: 'unit interval' });
        }));
      }
    }));
  };

  // ----- the building -----
  const sys = pv('system');
  const residential = USAGE[bm.usage] === 'residential';
  const AN = bm.areas?.netFloor, V = bm.areas?.volume;
  const building = () => w.wrap('core:cityObjectMember', null, () => w.wrap('bldg:Building', { 'gml:id': id0 }, () => {
    w.leaf('gml:description', 'Energy model of Open Energy Map. Every input with its range, tier and references is in the generic attribute sets OEM_input_*.');
    w.leaf('gml:name', bm.name || [address.street && `${address.street} ${address.number || ''}`.trim()].filter(Boolean).join('') || id0);
    w.leaf('core:creationDate', (ctx.created || new Date().toISOString()).slice(0, 10));
    if (ids.osm) w.wrap('core:externalReference', null, () => { w.leaf('core:informationSystem', 'https://www.openstreetmap.org'); w.wrap('core:externalObject', null, () => w.leaf('core:uri', `https://www.openstreetmap.org/${ids.osm.startsWith('r') ? 'relation' : 'way'}/${ids.osm.slice(1).replace(/_\d+$/, '')}`)); });
    if (ids.lod2) w.wrap('core:externalReference', null, () => { w.leaf('core:informationSystem', 'https://geodaten.bayern.de/opengeodata/OpenDataDetail.html?pn=lod2'); w.wrap('core:externalObject', null, () => w.leaf('core:name', ids.lod2)); });

    // ranges, tiers and provenance (generic attributes)
    const result = (name, what, unit, value, b) => w.wrap('gen:genericAttributeSet', { name }, () => {
      gAttr.str('what', what);
      gAttr.measure('value', value, unit);
      if (b) { gAttr.measure('median', b.median, unit); gAttr.measure('p10', b.p10_p90?.[0], unit); gAttr.measure('p90', b.p10_p90?.[1], unit);
        if (b.p10_p90_all_ages) { gAttr.measure('p10_all_ages', b.p10_p90_all_ages[0], unit); gAttr.measure('p90_all_ages', b.p10_p90_all_ages[1], unit); } }
    });
    const bands = ctx.bands || {};
    result('OEM_result_heating_demand', 'Useful energy for space heating under standard use, per m2 of reference area. value: the model with the point values of the inputs; p10, median, p90: the range over the prior of the inputs (construction age at the class used, if the age is uncertain); p10_all_ages, p90_all_ages: over all possible ages', 'kWh/(m^2*a)', res?.annual?.heatPerM2, bands.heat);
    result('OEM_result_final_energy', 'Space heating and hot water at the meter, per m2 of reference area', 'kWh/(m^2*a)', fe?.perM2, bands.fin);
    result('OEM_result_co2', 'CO2 equivalent of the final energy', 't/a', fe?.co2 != null ? fe.co2 / 1000 : null, bands.co2);
    if (fe?.cls) w.wrap('gen:genericAttributeSet', { name: 'OEM_result_energy_class' }, () => { gAttr.str('what', 'Energy efficiency class of the final energy on the scale of GEG 2024 Annex 10; an estimate, not a certificate'); gAttr.str('value', fe.cls); });
    for (const it of inputs) {
      w.wrap('gen:genericAttributeSet', { name: `OEM_input_${it.key}` }, () => {
        gAttr.str('label', it.label);
        if (typeof it.value === 'number') gAttr.measure('value', it.value, it.unit || '1'); else gAttr.str('value', it.value_label ? `${it.value} (${it.value_label})` : it.value);
        if (it.prior_p10_p90) { gAttr.measure('prior_p10', it.prior_p10_p90[0], it.unit || '1'); gAttr.measure('prior_p90', it.prior_p10_p90[1], it.unit || '1'); }
        if (it.prior_shares) gAttr.str('prior_shares', Object.entries(it.prior_shares).map(([k, v]) => `${k} ${num(v, 3)}`).join('; '));
        gAttr.str('tier', it.tier);
        gAttr.str('source', it.source);
        gAttr.str('note', it.note);
        const r = it.references?.[0];
        if (r) gAttr.str('reference', [r.label, r.where, r.url].filter(Boolean).join(' | '));
        if (it.references?.length > 1) gAttr.str('references_more', String(it.references.length - 1));
      });
    }
    w.wrap('gen:genericAttributeSet', { name: 'OEM_provenance' }, () => {
      gAttr.str('tool', `Open Energy Map${ctx.version ? ` ${ctx.version}` : ''}`);
      gAttr.str('site', ctx.site);
      gAttr.str('map_url', ctx.mapUrl);
      gAttr.str('osm_id', ids.osm);
      gAttr.str('osm_snapshot', ids.osmSnapshot);
      gAttr.str('lod2_id', ids.lod2);
      gAttr.str('geometry', 'OSM outline; height, storeys and roof from the Bavarian LoD2 model where it covers the building, else from OSM tags and defaults (see OEM_input_* and the tiers)');
      gAttr.str('ground_elevation', `${num(Z0, 1)} m DHHN2016, ${ctx.groundElevation != null ? 'given' : 'assumed (mean elevation of Munich; the data hold heights above ground only)'}`);
      gAttr.str('weather', ctx.weatherName || 'typical year built from hourly ERA5 data 2010 to 2025 (Open-Meteo)');
      gAttr.str('tiers', 'observed: measured or mapped for this building; published_table: a published table or statistic; assumed: an assumption with the rule stated; user_input: given by the user');
      gAttr.str('licence', 'Results CC BY-NC 4.0 (Open Energy Map, (c) 2026 Xia Chen); third-party data keep their licences');
      gAttr.str('disclaimer', 'Research estimates for reference only; not an energy performance certificate or an on-site assessment');
    });

    // the heat generator and the energy
    const op = (eff) => w.wrap('nrg3:deviceOperation', null, () => w.wrap('nrg3:DeviceOperation', { 'gml:id': `${id0}_heating_operation` }, () => {
      code('nrg3:type', 'spaceHeating', 'DeviceOperationTypeValue');
      w.leaf('nrg3:yearlyGlobalEfficiency', num(eff, 3));
    }));
    const eff = fe?.seasonalCop || pv('eta_sys');
    if (/^gas|^oil|^pellet/.test(sys || '')) {
      w.wrap('nrg3:device', null, () => w.wrap('nrg3:Boiler', { 'gml:id': `${id0}_boiler` }, () => {
        w.leaf('gml:description', `${fe?.systemLabel || sys}. yearlyGlobalEfficiency: annual efficiency of generation, distribution and control as in the model (input eta_sys)`);
        w.leaf('gml:name', fe?.systemLabel || sys);
        op(eff);
        w.leaf('nrg3:hasCondensation', sys === 'gas_cond' ? 'true' : 'false');
      }));
    } else if (/^hp_/.test(sys || '')) {
      w.wrap('nrg3:device', null, () => w.wrap('nrg3:HeatPump', { 'gml:id': `${id0}_heat_pump` }, () => {
        w.leaf('gml:description', `${fe?.systemLabel || sys}. yearlyGlobalEfficiency: seasonal coefficient of performance of the model`);
        w.leaf('gml:name', fe?.systemLabel || sys);
        op(eff);
        w.leaf('nrg3:heatSource', sys === 'hp_air' ? 'ambientAir' : 'unknown', { codeSpace: CL.nrg('HeatSourceTypeValue') });
      }));
    }
    const energy = (sid, o) => w.wrap('nrg3:resource', null, () => w.wrap('nrg3:Energy', { 'gml:id': `${id0}_${sid}` }, () => {
      w.leaf('gml:description', o.description);
      w.leaf('nrg3:status', 'actual');
      code('nrg3:operationType', 'demands', 'ResourceOperationTypeValue');
      code('nrg3:amountType', 'simulation', 'AcquisitionMethodValue');
      w.leaf('nrg3:amount', num(o.amount, 0), { uom: 'kWh/a' });
      if (o.series) o.series();
      w.leaf('nrg3:isAmountNormalized', 'false');
      if (o.co2 != null) w.leaf('nrg3:co2Equivalent', num(o.co2, 0), { uom: 'kg/a' });
      code('nrg3:type', o.type, 'EnergyTypeValue');
      code('nrg3:endUse', o.endUse, 'EnergyEndUseValue');
      if (o.carrier) code('nrg3:energyCarrier', o.carrier, 'EnergyCarrierValue');
      if (o.maxLoad != null) w.leaf('nrg3:maximumLoad', num(o.maxLoad, 2), { uom: 'kW' });
      if (o.source) code('nrg3:source', o.source, 'EnergySourceValue');
    }));
    const hourly = res?.hourly?.Q_hc;
    const year = ctx.year || 2018;
    if (res?.annual) energy('useful_heating', {
      description: `Useful energy for space heating under standard use, hourly 5R1C model (EN ISO 13790 / 52016-1), weather: ${ctx.weatherName || 'typical year'}; range in OEM_result_heating_demand`,
      amount: res.annual.heat, type: 'useful', endUse: 'spaceHeating', maxLoad: res.annual.peakHeat / 1000,
      series: hourly ? () => w.wrap('nrg3:timeDependentAmount', null, () => w.wrap('nrg3:RegularTimeSeries', { 'gml:id': `${id0}_heating_hourly` }, () => {
        w.leaf('gml:description', `Hourly heating load in kW, weather: ${ctx.weatherName || 'typical year'} (time stamps of the year ${year})`);
        code('nrg3:acquisitionMethod', 'simulation', 'AcquisitionMethodValue');
        w.leaf('nrg3:interpolationType', 'averageInSucceedingInterval');
        w.leaf('nrg3:source', 'Open Energy Map, hourly 5R1C model');
        w.wrap('nrg3:temporalExtent', null, () => w.wrap('gml:TimePeriod', null, () => { w.leaf('gml:beginPosition', `${year}-01-01T00:00:00`); w.leaf('gml:endPosition', `${year + 1}-01-01T00:00:00`); }));
        w.leaf('nrg3:timeInterval', '1', { unit: 'hour' });
        w.leaf('nrg3:valuesList', Array.from(hourly, (x) => num(Math.max(0, x) / 1000, 2)).join(' '), { uom: 'kW' });
      })) : null,
    });
    const carrier = CARRIER[sys], src = SOURCE[sys];
    const co2 = (part) => (fe?.co2 != null && fe.total > 0 ? fe.co2 * (part / fe.total) : null);
    if (fe) {
      energy('final_heating', { description: `Final energy for space heating, ${fe.systemLabel}; range of the total in OEM_result_final_energy`, amount: fe.heat, type: 'final', endUse: 'spaceHeating', carrier, source: src, co2: co2(fe.heat) });
      if (fe.dhw) energy('final_hot_water', { description: 'Final energy for domestic hot water', amount: fe.dhw, type: 'final', endUse: 'domesticHotWater', carrier, source: src, co2: co2(fe.dhw) });
      if (fe.primary != null) energy('primary', { description: 'Primary energy (non-renewable) of space heating and hot water, factors of GEG 2024 Annex 4', amount: fe.primary, type: 'primary', endUse: 'otherOrCombination', carrier, source: src });
    }

    // CityGML building attributes
    if (ctx.lod2Function) w.leaf('bldg:function', ctx.lod2Function, { codeSpace: CL.alkis });
    w.leaf('bldg:roofType', ROOF[bm.roof?.shape] || 'combination of roof forms', { codeSpace: CL.roof });
    w.leaf('bldg:measuredHeight', num(h.H + (bm.roof?.shape && bm.roof.shape !== 'flat' ? bm.roof.ridgeHeight || 0 : 0), 2), { uom: 'm' });
    w.leaf('bldg:storeysAboveGround', bm.floors);
    w.leaf('bldg:storeyHeightsAboveGround', num(bm.floorHeight || h.H / bm.floors, 2), { uom: 'm' });

    // boundary surfaces
    const pitched = bm.roof?.shape && bm.roof.shape !== 'flat';
    surface({ ...h.ground, label: 'Ground floor (outline)', azimuth: -1, inclination: 180 }, `${id0}_ground`, ['floor']);
    h.walls.forEach((s, i) => {
      const exposed = s.kind === 'WallSurface';
      surface({ ...s, label: `${exposed ? 'Wall' : 'Party wall'} ${s.facade || i + 1}${s.orient ? ` (${s.orient})` : ''}`, azimuth: s.az, inclination: 90, opaque: exposed ? s.area * (1 - (s.ratio || 0)) : undefined },
        `${id0}_${exposed ? 'wall' : 'partywall'}_${i + 1}`, exposed ? ['wall', ...((s.ratio || 0) > 0 ? ['window'] : [])] : []);
    });
    const roofArea = pitched && bm.areas?.roof > h.footprint ? bm.areas.roof : h.footprint;
    surface({ ...h.roof, label: pitched ? `Roof (${bm.roof.shape} in reality, drawn flat at eaves height)` : 'Roof', azimuth: -1, inclination: pitched ? (Math.acos(Math.min(1, h.footprint / roofArea)) * 180) / Math.PI : 0, total: roofArea }, `${id0}_roof`, ['roof']);

    // address
    if (address.street) w.wrap('bldg:address', null, () => w.wrap('core:Address', null, () => w.wrap('core:xalAddress', null, () => w.wrap('xAL:AddressDetails', null, () => w.wrap('xAL:Country', null, () => {
      w.leaf('xAL:CountryName', 'Germany');
      w.wrap('xAL:Locality', { Type: 'Town' }, () => {
        if (/^8[01]\d{3}$/.test(address.postcode || '')) w.leaf('xAL:LocalityName', 'München');
        w.wrap('xAL:Thoroughfare', { Type: 'Street' }, () => { w.leaf('xAL:ThoroughfareNumber', address.number); w.leaf('xAL:ThoroughfareName', address.street); });
        if (address.postcode) w.wrap('xAL:PostalCode', null, () => w.leaf('xAL:PostalCodeNumber', address.postcode));
      });
    })))));

    // Energy ADE building attributes
    const qa = (tag, inner, type, list, value, uom, source, description) => w.wrap(tag, null, () => w.wrap(inner, null, () => {
      w.leaf('nrg3:description', description); w.leaf('nrg3:source', source); w.leaf('nrg3:value', num(value, 1), { uom }); code('nrg3:type', type, list);
    }));
    if (AN) qa('nrg3:bdgArea', 'nrg3:QualifiedArea', 'energyReferenceArea', 'AreaTypeValue', AN, 'm^2', 'Open Energy Map: GEG reference area A_N from the volume (residential) or net floor area (non-residential)', 'Reference area of the per-m2 results');
    if (bm.areas?.grossFloor) qa('nrg3:bdgArea', 'nrg3:QualifiedArea', 'grossFloorArea', 'AreaTypeValue', bm.areas.grossFloor, 'm^2', 'Open Energy Map: footprint times storeys');
    qa('nrg3:bdgArea', 'nrg3:QualifiedArea', 'footprintArea', 'AreaTypeValue', h.footprint, 'm^2', 'OpenStreetMap outline');
    const status = (s) => (s === 'heated' ? 'isOnlyHeated' : s === 'unheated' ? 'isNeitherHeatedNorCooled' : null);
    if (status(bm.roof?.attic)) w.leaf('nrg3:bdgAtticThermalStatus', status(bm.roof.attic));
    if (status(bm.basement)) w.leaf('nrg3:bdgBasementThermalStatus', status(bm.basement));
    qa('nrg3:bdgHeight', 'nrg3:QualifiedHeight', 'generalEave', 'HeightTypeValue', h.H, 'm', bm.geomSrc?.height || 'Open Energy Map');
    if (BDG_TYPE[bm.usage]) code('nrg3:bdgType', BDG_TYPE[bm.usage], 'BuildingTypeValue');
    if (V) qa('nrg3:bdgVolume', 'nrg3:QualifiedVolume', 'grossVolume', 'VolumeTypeValue', V, 'm^3', 'Open Energy Map: footprint times eaves height, plus the roof volume if the attic is heated');

    // thermal zone and usage zone
    w.wrap('nrg3:thermalZone', null, () => w.wrap('nrg3:ThermalZone', { 'gml:id': `${id0}_thermal_zone` }, () => {
      w.leaf('gml:description', 'The model has a single thermal zone (hourly 5R1C); its thermal boundaries are the boundary surfaces of the building.');
      w.leaf('gml:name', 'Thermal zone');
      if (AN) qa('nrg3:area', 'nrg3:QualifiedArea', 'energyReferenceArea', 'AreaTypeValue', AN, 'm^2', 'Open Energy Map');
      if (V) { qa('nrg3:volume', 'nrg3:QualifiedVolume', 'grossVolume', 'VolumeTypeValue', V, 'm^3', 'Open Energy Map'); qa('nrg3:volume', 'nrg3:QualifiedVolume', 'netVolume', 'VolumeTypeValue', 0.8 * V, 'm^3', 'Open Energy Map: 0.8 of the gross volume (DIN V 18599)'); }
      w.ref('nrg3:usageZone', `${id0}_usage_zone`);
      if (pv('Cm') && AN) w.leaf('nrg3:heatCapacity', num(pv('Cm') * AN, 0), { uom: 'J/K' });
      if (pv('n50') != null) w.leaf('nrg3:infiltrationRate', num(0.07 * pv('n50'), 3), { uom: '1/h' });
      w.leaf('nrg3:isCooled', pv('T_cool') != null ? 'true' : 'false');
      w.leaf('nrg3:isHeated', bm.heated === false ? 'false' : 'true');
      w.leaf('nrg3:coincidesWithLod2Hull', pitched && bm.roof?.attic === 'heated' ? 'false' : 'true');
      w.leaf('nrg3:coincidesWithLod3Hull', 'false');
      for (const sid of surfaces) w.ref('nrg3:thermalBoundary', sid);
    }));
    w.wrap('nrg3:usageZone', null, () => w.wrap('nrg3:UsageZone', { 'gml:id': `${id0}_usage_zone` }, () => {
      w.leaf('gml:name', `Usage zone (${USAGE[bm.usage] || bm.usage})`);
      if (AN) qa('nrg3:area', 'nrg3:QualifiedArea', 'energyReferenceArea', 'AreaTypeValue', AN, 'm^2', 'Open Energy Map');
      w.leaf('nrg3:type', USAGE[bm.usage] || bm.usage, { codeSpace: 'https://github.com/chenxiachan/open-energy-map' });
      w.leaf('nrg3:isPrimary', 'true');
      if (pv('Q_int') != null) w.leaf('nrg3:internalHeatGains', num(pv('Q_int'), 2), { uom: 'W/m^2' });
      const T = pv('T_heat'), sb = pv('setback') || 0;
      if (T != null) w.wrap('nrg3:heatingSchedule', null, () => w.wrap('nrg3:DualValueSchedule', { 'gml:id': `${id0}_heating_schedule` }, () => {
        w.leaf('gml:description', residential ? 'Heating set point with night set-back, every day' : `Heating set point in the usage hours (${profile.daysPerWeek || 5} days a week), set-back outside`);
        code('nrg3:type', 'typicalDay', 'ScheduleTypeValue');
        w.leaf('nrg3:idleValue', num(T - sb, 1), { uom: 'degree Celsius' });
        w.leaf('nrg3:usageValue', num(T, 1), { uom: 'degree Celsius' });
        const hh = (x) => `${String(Math.max(0, Math.min(23, Math.floor(x)))).padStart(2, '0')}:00:00`;
        w.leaf('nrg3:startUsageTime', residential ? '06:00:00' : hh(profile.start ?? 7));
        w.leaf('nrg3:endUsageTime', residential ? '22:00:00' : (profile.end ?? 18) >= 24 ? '23:59:59' : hh(profile.end ?? 18));
      }));
      if (pv('n_vent') != null) w.wrap('nrg3:ventilationSchedule', null, () => w.wrap('nrg3:AtomicSchedule', { 'gml:id': `${id0}_ventilation_schedule` }, () => {
        w.leaf('gml:description', `Ventilation air change rate${pv('hr_eff') ? `, heat recovery ${num(pv('hr_eff') * 100, 0)} %` : ''}`);
        code('nrg3:type', 'typicalYear', 'ScheduleTypeValue');
        w.leaf('nrg3:constantValue', num(pv('n_vent'), 2), { uom: '1/h' });
      }));
    }));
  }));

  // ----- assemble -----
  w.d = 1;
  lib();
  building();
  const body = w.out;
  const head = [
    `<core:CityModel${Object.entries(NS).map(([k, v]) => ` xmlns:${k}="${v}"`).join('')} xsi:schemaLocation="${SCHEMA_LOCATION}">`,
    '  <gml:name>Open Energy Map</gml:name>',
    '  <gml:boundedBy>',
    `    <gml:Envelope srsName="${SRS}" srsDimension="3">`,
    `      <gml:lowerCorner>${num(env.x0, 3)} ${num(env.y0, 3)} ${num(env.z0, 3)}</gml:lowerCorner>`,
    `      <gml:upperCorner>${num(env.x1, 3)} ${num(env.y1, 3)} ${num(env.z1, 3)}</gml:upperCorner>`,
    '    </gml:Envelope>',
    '  </gml:boundedBy>',
  ];
  return [...out, ...head, ...body, '</core:CityModel>', ''].join('\n');
}

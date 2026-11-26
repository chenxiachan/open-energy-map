// Singapore pipeline for one building, shared by the page (js/sg_app.js) and the agent (agent/core.mjs) so both give
// the same model: OSM outline + joined attributes (x.hdb, x.lu, x.gba, x.bca) → type, era, storeys (archetype_sg.js) →
// geometry (geometry.js, with Singapore heights for the neighbours) → inputs → shading → 5R1C with the tropical terms
// (rc5.js) → cooling, electricity by end use, CO₂, peak load and EUI per GFA, with P10–P90 from the prior.
// No fetching here: the caller passes the archetype table, the BCA rows, the weather and the holiday calendars.
//
// Results (all per m² of the reference area, the table's areaBasis: flat area for HDB, dwelling area for condos and
// landed houses, GFA for the rest; EUI is per m² GFA, as BCA reports it):
//   cool: demand of the AC (sensible + latent, useful cooling), kWh/(m²·a); peak: hourly maximum, W/m²
//   elec: cooling (demand ÷ COP), lighting, equipment, other, total, kWh/(m²·a)
//   co2: electricity × EMA grid emission factor of the weather year (typical year: 2019), t/a and kg/(m²·a)
// The heating final-energy path (systems.js) is not used. BCA EUI is never an input: measured() returns it beside the
// model for comparison only, with values outside 20–1000 kWh/(m²·a) flagged as implausible in the source.
import { buildGeometry, computeAreas } from './geometry.js';
import { computeShading, facadeIrradiance } from './solar.js';
import { prepare, run } from './rc5.js';
import { cityCalendar } from './holidays.js';
import * as SG from './archetype_sg.js';
import { L } from './i18n.js';

// holiday calendars by the profiles' rule: public holidays (data/sg/holidays.json), public + MOE vacations (schools), none
export function calendars(holidays, A) {
  const terms = A.types.education.params.holidays.terms2019 || [];
  const school = {};
  if (terms.length) {
    const inTerm = (d) => terms.some(([a, b]) => d >= a && d <= b);
    const out = [];
    for (let t = Date.UTC(2019, 0, 1); t < Date.UTC(2020, 0, 1); t += 864e5) { const d = new Date(t).toISOString().slice(0, 10); if (!inTerm(d)) out.push(d); }
    school['2019'] = out;
  }
  return {
    public: cityCalendar(holidays || {}),
    school: cityCalendar(holidays || {}, { school }),
    open: { sundayRule: 'none', sourceYear: () => null, publicHolidays: () => [], schoolHolidays: null },
  };
}
const calOf = (prof, cals) => (prof.holidayRule === 'open' || prof.holidayRule === 'none' ? cals.open : prof.holidays === 'school' ? cals.school : cals.public);

export function gridEF(A, year) {
  const t = A.gridEF, y = typeof year === 'number' ? year : 2019;
  const row = t.byYear[String(y)] || t.byYear['2019'];
  return { value: row.GEF, year: t.byYear[String(y)] ? y : 2019, tmy: typeof year !== 'number', source: t.source, unit: t.unit };
}

const fpOf = (rec) => SG.footprintOf(rec);
// gross floor area of another outline of the same BCA listing (for sharing the GFA)
const grossOf = (rec) => { const h = SG.neighbourHeight(rec); return fpOf(rec) * Math.max(1, Math.round((h || 6) / 3.6)); };

// → { m, cls, eraInfo, asg, bca, bcaRow, parts } or { notModelled: cls, bcaRow }
// state: { type, era, system, floors, user: {k: v} }; data: { A, bcaRows }
export function buildModel(rec0, nbRecs, state = {}, data = {}) {
  let rec = rec0;
  const A = data.A || SG.archetypes();
  const bcaRow = rec.x?.bca != null && data.bcaRows ? data.bcaRows[rec.x.bca] || null : null;
  const parts = SG.partsOf(rec, nbRecs);
  rec = hdbFromParts(rec, parts);
  const cls = { ...SG.classify(rec, { bcaRow, parts }) };
  if (state.type && A.types[state.type]) Object.assign(cls, { type: state.type, variant: null, conditioned: true, tier: 'user', src: L('用户指定', 'Set by user', 'Von Ihnen festgelegt'), rc5: null });
  if (!cls.conditioned) return { notModelled: cls, bcaRow };
  const type = cls.type;
  const eraInfo = SG.agePrior(rec, type, bcaRow);
  const eras = SG.erasOf(type);
  const eraId = state.era || (eras ? Object.entries(eraInfo.p).sort((a, b) => b[1] - a[1])[0][0] : null);
  const st = SG.storeys(rec, type, eraId, parts);
  const fromGfa = bcaStoreys(rec, nbRecs, type, bcaRow, st, A);
  if (fromGfa) Object.assign(st, fromGfa);
  if (state.floors > 0) { st.floors = Math.round(state.floors); st.height = +(st.voidDeck + st.floors * st.fh).toFixed(1); st.src.floors = 'user'; st.tier.floors = 'user'; st.h10 = st.h90 = st.height; }
  const m = buildGeometry(rec, nbRecs, { heightOf: SG.neighbourHeight });
  const t = rec.tags || {};
  Object.assign(m, {
    sgType: type, sgVariant: cls.variant || null, x: rec.x || {}, usage: cls.rc5 || SG.RC5_USAGE[type], profile: null,
    height: st.height, floors: st.floors, floorHeight: +((st.height - st.voidDeck) / st.floors).toFixed(2), voidDeck: st.voidDeck,
    roof: { shape: t['roof:shape'] && t['roof:shape'] !== 'flat' ? t['roof:shape'] : 'flat', ridgeHeight: 0, attic: 'none', roofLevels: 0 },
    basement: 'none', hGBias: 0, floorsPrior: null, heated: true, usageSrc: cls.src, usageTier: cls.tier, geomSrc: st.src, geomTier: st.tier,
    address: sgAddress(t, rec.x), structure: null, noLoD2: false,
  });
  m.nbLonLat = nbRecs.filter((n) => !n.part).map((n) => n.outer);
  const bca = SG.bcaInputs(bcaRow, data.bcaRows);
  const asg = SG.assign(m, eraInfo, state, { bca, gross: fpOf(rec) * m.floors });
  m.params = asg.params;
  SG.applyWWR(m);
  computeAreas(m);
  // HDB: the first storey (void deck or shops) is outside the flats: not in the envelope or the air volume
  if (m.voidDeck > 0 && m.height > m.voidDeck) {
    const f = (m.height - m.voidDeck) / m.height, a = m.areas;
    let ex = 0, win = 0;
    for (const fa of m.facades) { fa.exposedArea = +(fa.exposedArea * f).toFixed(2); fa.windowArea = +(fa.windowArea * f).toFixed(2); ex += fa.exposedArea; win += fa.windowArea; }
    Object.assign(a, { facadeGross: +(a.facadeGross * f).toFixed(1), facadeExposed: +ex.toFixed(1), window: +win.toFixed(1), opaqueWall: +(ex - win).toFixed(1), volume: +(a.footprint * (m.height - m.voidDeck)).toFixed(1) });
    a.envelope = +(a.facadeExposed + a.roof + a.footprint).toFixed(1);
  }
  refArea(m, rec, nbRecs, bca, st, A);
  m.geomPrior = { h10: st.h10, h90: st.h90, area: m.areas.refPrior || null };
  return { m, cls, eraInfo, asg, bca, bcaRow, parts, storeys: st };
}

// A BCA-listed non-residential building whose storeys come only from GlobalBuildingAtlas or the type rule (no OSM
// levels, parts or height): storeys = BCA GFA / (refAreaFactor × footprint of the listing's outlines), the range from
// the refAreaFactor P10–P90. Uses only the BCA GFA, never the EUI. (Fix of 2026-11-26, qa/sg_bca_validation.md §5.)
function bcaStoreys(rec, nbRecs, type, row, st, A) {
  if (!row || !(row.gfa > 0) || SG.RES_TYPES.includes(type) || st.tier.floors === 'observed' || st.tier.height === 'observed') return null;
  const rf = A.types[type]?.params?.refAreaFactor;
  if (!rf) return null;
  const ids = new Set(row.osm_all || (row.osm ? [row.osm] : []));
  let fp = fpOf(rec);
  for (const n of nbRecs || []) if (!n.part && n.id !== rec.id && ids.has(n.id)) fp += fpOf(n);
  if (!(fp > 20)) return null;
  const f = Math.max(1, Math.min(90, Math.round(row.gfa / (rf.value * fp)))), fh = st.fh;
  const f10 = Math.max(1, Math.round(row.gfa / (rf.p90 * fp))), f90 = Math.max(f10, Math.round(row.gfa / (rf.p10 * fp)));
  const txt = L(`BCA GFA ${Math.round(row.gfa).toLocaleString('en-GB')} m² ÷（${rf.value} × 占地 ${Math.round(fp)} m²）= ${f} 层（refAreaFactor；之前：${st.src.floors}）`,
    `BCA GFA ${Math.round(row.gfa).toLocaleString('en-GB')} m² ÷ (${rf.value} × footprint ${Math.round(fp)} m²) = ${f} storeys (refAreaFactor; before: ${st.src.floors})`,
    `BCA-BGF ${Math.round(row.gfa).toLocaleString('en-GB')} m² ÷ (${rf.value} × Grundfläche ${Math.round(fp)} m²) = ${f} Geschosse (refAreaFactor; vorher: ${st.src.floors})`);
  return { floors: f, height: +(f * fh).toFixed(1), src: { floors: txt, height: L(`层数 × 层高 ${fh} m`, `storeys × storey height ${fh} m`, `Geschosse × Geschosshöhe ${fh} m`) }, tier: { floors: 'estimate', height: 'estimate' }, h10: f10 * fh, h90: f90 * fh };
}

// HDB towers that OSM draws only as building:part on a podium outline (Pinnacle@Duxton): the outline takes the blocks of
// its parts (units summed, each divided by its n; the highest floor; the earliest year), with the parts' floor area
// spread over the outline as equivalent levels
function hdbFromParts(rec, parts) {
  if (rec.x?.hdb) return rec;
  const hp = parts.filter((p) => p.x?.hdb?.res && p.x.hdb.levels > 0);
  if (!hp.length) return rec;
  const fp = SG.footprintOf(rec), blocks = new Map();
  let eq = 0;
  for (const p of hp) { const h = p.x.hdb; blocks.set(`${h.blk}|${h.street}`, h); eq += (SG.footprintOf(p) * h.levels) / Math.max(1, fp); }
  const hs = [...blocks.values()], units = {};
  for (const h of hs) for (const [k, v] of Object.entries(h.units || {})) units[k] = (units[k] || 0) + v;
  const first = hs[0];
  const hdb = { ...first, blk: hs.map((h) => h.blk).join(', '), street: [...new Set(hs.map((h) => h.street))].join(' / '), year: Math.min(...hs.map((h) => h.year)), levels: Math.max(...hs.map((h) => h.levels)),
    units, n: 1, res: 1, eqLevels: Math.max(2, Math.min(Math.max(...hs.map((h) => h.levels)), eq)), fromParts: hp.length };
  return { ...rec, x: { ...rec.x, hdb } };
}

function sgAddress(t, x) {
  const s = t['addr:street'] ? `${t['addr:housenumber'] ? t['addr:housenumber'] + ' ' : ''}${t['addr:street']}` : null;
  const hdb = x?.hdb ? `Blk ${x.hdb.blk} ${x.hdb.street}` : null;
  const pc = t['addr:postcode'] || x?.hdb?.pc || null;
  const a = hdb || s;
  return a ? `${a}${pc ? `, Singapore ${pc}` : ''}` : null;
}

// reference area (areas.netFloor, used by rc5 as A_f), its source and tier, and the GFA for EUI
function refArea(m, rec, nbRecs, bca, st, A) {
  const a = m.areas, fp = a.footprint, gross = fp * m.floors, P = m.params, type = m.sgType, rf = P.refAreaFactor;
  const geomRef = rf.value * gross;
  let ref = geomRef, src = L(`${rf.value} × 占地 ${Math.round(fp)} m² × ${m.floors} 层（refAreaFactor，${rf.source}）`, `${rf.value} × footprint ${Math.round(fp)} m² × ${m.floors} storeys (refAreaFactor, ${rf.source})`, `${rf.value} × Grundfläche ${Math.round(fp)} m² × ${m.floors} Geschosse (refAreaFactor, ${rf.source})`), tier = rf.tier || 'assumed';
  let prior = { value: geomRef, p10: rf.p10 * gross, p90: rf.p90 * gross }, check = null, gfa = null, gfaSrc = null;
  if (type === 'hdb' && m.x?.hdb) {
    const f = SG.hdbFlats(m.x.hdb);
    if (f.area > 0) {
      const ratio = f.area / geomRef;
      check = { units: f.units, flatArea: f.area, geomRef, ratio };
      if (ratio >= 0.5 && ratio <= 2) {
        ref = f.area; tier = 'observed'; prior = null;
        src = L(`HDB 户数 × 户型面积：${f.text} = ${Math.round(f.area)} m²（几何核对 ${Math.round(geomRef)} m²，比值 ${ratio.toFixed(2)}）`, `HDB units × flat areas: ${f.text} = ${Math.round(f.area)} m² (geometry check ${Math.round(geomRef)} m², ratio ${ratio.toFixed(2)})`, `HDB-Wohnungen × Wohnfläche: ${f.text} = ${Math.round(f.area)} m² (Prüfung mit der Geometrie ${Math.round(geomRef)} m², Verhältnis ${ratio.toFixed(2)})`);
      } else src += L(`；HDB 户数给出 ${Math.round(f.area)} m²，与几何差 ${ratio.toFixed(2)} 倍，不用`, `; the HDB units give ${Math.round(f.area)} m², ${ratio.toFixed(2)} times the geometry, not used`, `; die HDB-Wohnungen ergeben ${Math.round(f.area)} m², das ${ratio.toFixed(2)}-Fache der Geometrie, nicht verwendet`);
    }
  }
  if (!SG.RES_TYPES.includes(type) && bca?.gfa) {
    const ids = bca.gfa.osmAll || [];
    let share = 1;
    if (ids.length > 1) {
      const byId = new Map((nbRecs || []).filter((n) => !n.part).map((n) => [n.id, n]));
      const own = gross, others = ids.filter((id) => id !== rec.id).map((id) => (byId.has(id) ? grossOf(byId.get(id)) : null));
      const known = others.filter((v) => v != null), mean = known.length ? known.reduce((s, v) => s + v, 0) / known.length : own;
      const tot = own + others.reduce((s, v) => s + (v ?? mean), 0);
      share = own / tot;
    }
    ref = bca.gfa.value * share; tier = 'observed'; prior = null;
    src = share < 1 ? L(`${bca.gfa.src}，${ids.length} 个轮廓按毛面积分摊，本楼 ${Math.round(share * 100)}%`, `${bca.gfa.src}, shared over ${ids.length} outlines by gross floor area, this one ${Math.round(share * 100)}%`, `${bca.gfa.src}, auf ${ids.length} Umrisse nach Bruttofläche verteilt, dieser ${Math.round(share * 100)} %`) : bca.gfa.src;
    check = { gfa: bca.gfa.value, share, ratio: ref / Math.max(1, gross) };
  }
  if (SG.RES_TYPES.includes(type)) { gfa = gross; gfaSrc = L(`占地 × ${m.floors} 层（毛面积）`, `footprint × ${m.floors} storeys (gross)`, `Grundfläche × ${m.floors} Geschosse (brutto)`); }
  else { gfa = ref; gfaSrc = src; }
  Object.assign(a, { netFloor: +Math.max(1, ref).toFixed(1), ref: +ref.toFixed(1), refSrc: src, refTier: tier, refBasis: A.types[type].areaBasis?.basis || '', refPrior: prior, refCheck: check, gfa: +gfa.toFixed(1), gfaSrc, living: null, anFactor: null });
}

// Commercial buildings (BCA office, retail, hotel, mixed development): the occupied floor is the air-conditioned floor.
// rc5 spreads internal gains and ventilation evenly over its cooled and uncooled zones (a choice made for flats, where the
// AC runs in the bedrooms only). In a commercial building the floor without AC is ancillary space (corridors, toilets,
// staircases: BCA_SLE p. 26–27, AC area 70–90 % of a typical office's GFA, natural ventilation "in all ancillary spaces
// like corridor, toilet, staircase"), while people, lighting, plug loads and the outdoor air of the AHUs (V_oa per m²
// GFA) are in, or supplied to, the air-conditioned floor; the table's Q_lat is already per m² of cooled floor. So these
// types run as one cooled zone of coolFrac × GFA with its share of the envelope (facades, roof, floor, air volume, solar
// gains) and all of the building's sensible internal gains, outdoor air and E_other; results come back per m² GFA. Not
// modelled: heat flowing from the uncooled ancillary rooms into the cooled floor through partitions (treating the whole
// GFA as cooled adds 2–7 % to the cooling of the BCA examples). Other non-residential types (healthcare, education,
// civic, sports, industrial) keep the two-zone rule: nursing homes, community buildings and schools have occupied rooms
// without AC. (Fix of 2026-11-26, qa/sg_bca_validation.md §5.)
const COOLED_FLOOR = new Set(['office', 'retail', 'hotel', 'mixed']);
function cooledCtx(ctx, fc) {
  if (ctx._cooled && ctx._cooled.fc === fc) return ctx._cooled.cx;
  const cx = { ...ctx, _cooled: null };
  for (const k of ['Awin', 'Aop', 'Aroof', 'Afloor', 'Aenv', 'AN', 'Vair']) cx[k] = ctx[k] * fc;
  cx.Swin = Float32Array.from(ctx.Swin, (v) => v * fc); cx.Sop = Float32Array.from(ctx.Sop, (v) => v * fc);
  if (ctx.winArea) { cx.winArea = ctx.winArea.map((v) => v * fc); cx.opArea = ctx.opArea.map((v) => v * fc); }
  ctx._cooled = { fc, cx };
  return cx;
}
// rc5 for a Singapore model (every SG run goes through here: simulate, priorMC, the tools)
// useScale (calibrated types only, data/sg/calib_commercial.json): the between-building use intensity, a factor on the
// occupant, lighting, equipment and other loads together (value 1; its range carries the spread the inputs do not explain)
export function runModel(m, ctx, p0, opts = {}) {
  const u = p0.useScale, p = u != null && u !== 1
    ? { ...p0, Q_int: (p0.Q_int || 0) * u, Q_lat: (p0.Q_lat || 0) * u, P_light: (p0.P_light || 0) * u, P_equip: (p0.P_equip || 0) * u, E_other: (p0.E_other || 0) * u } : p0;
  const fc = p.coolFrac;
  if (!COOLED_FLOOR.has(m.sgType) || !(fc > 0 && fc < 1) || p.T_cool == null) return run(ctx, p, opts);
  const q = { ...p, coolFrac: 1, Q_int: (p.Q_int || 0) / fc, P_light: (p.P_light || 0) / fc, P_equip: (p.P_equip || 0) / fc, E_other: (p.E_other || 0) / fc, n_vent: (p.n_vent || 0) / fc };
  const r = run(cooledCtx(ctx, fc), q, opts), a = r.annual;
  // per m² of the cooled floor → per m² GFA (absolute kWh are those of the building already)
  for (const k of ['heatPerM2', 'coolPerM2', 'coolSensPerM2', 'coolLatPerM2']) if (a[k] != null) a[k] *= fc;
  if (a.elecPerM2) for (const k of Object.keys(a.elecPerM2)) if (a.elecPerM2[k] != null) a.elecPerM2[k] *= fc;
  a.coolFrac = fc; a.overheatHoursUncooled = null; a.cooledFloor = true;
  return r;
}

// shading, irradiance, schedule and the 5R1C context
export function simulate(m, weather, cals, opts = {}) {
  const shading = opts.shading || computeShading(m);
  const irr = facadeIrradiance(m, weather, shading);
  const prof = SG.profileFor(m);
  const ctx = prepare(m, weather, irr, prof, { tz: 8, holidays: calOf(prof, cals) });
  const p = SG.paramValues(m);
  const res = runModel(m, ctx, p, { hourly: !!opts.hourly, detail: !!opts.detail });   // detail: the cooling balance (rc5.js)
  return { shading, irr, prof, ctx, p, res };
}

// the numbers of one run (point or draw)
export function summarize(m, ctx, p, res, gef) {
  const a = res.annual, af = Math.max(1, ctx.AN * (p.hScale ?? 1) * (p.anScale ?? 1));
  const gfa = SG.RES_TYPES.includes(m.sgType) ? m.areas.gfa * (p.hScale ?? 1) : af;
  const e = a.elec || {}, ep = a.elecPerM2 || {};
  return {
    af, gfa,
    cool: a.coolPerM2, coolSens: a.coolSensPerM2 ?? a.coolPerM2, coolLat: a.coolLatPerM2 ?? 0, coolKWh: a.cool, peakW: a.peakCool, peakWm2: a.peakCool / af,
    elec: { cooling: ep.cooling, lighting: ep.lighting, equipment: ep.equipment, other: ep.other, total: ep.total }, elecKWh: e.total,
    eui: e.total != null ? e.total / gfa : null,
    co2t: e.total != null ? (e.total * gef) / 1000 : null, co2kg: e.total != null ? (e.total * gef) / af : null,
    acHours: a.acHours, overheatU: a.overheatHoursUncooled,
  };
}

// prior Monte Carlo: draws of every input (archetype_sg.js makePrior); cond fixes the era at the one of the point value
export function priorMC(b, sim, gef, n = 300, seeds = [42, 43], state = {}) {
  const q = (arr, f) => { const s = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y); return s.length ? s[Math.round(f * (s.length - 1))] : null; };
  const t3 = (arr) => [q(arr, 0.1), q(arr, 0.5), q(arr, 0.9)];
  const one = (st, seed) => {
    const draw = SG.makePrior(b.m, b.eraInfo, st, b.asg, { bca: b.bca }), r = SG.rng(seed);
    const K = ['cool', 'coolSens', 'coolLat', 'eui', 'co2t', 'peakWm2'], E = ['cooling', 'lighting', 'equipment', 'other', 'total'];
    const acc = Object.fromEntries([...K, ...E.map((k) => 'e_' + k)].map((k) => [k, []]));
    const mCool = Array.from({ length: 12 }, () => []), mElec = Array.from({ length: 12 }, () => []), xs = [];
    for (let i = 0; i < n; i++) {
      const d = draw(r), rr = runModel(b.m, sim.ctx, d.p), s = summarize(b.m, sim.ctx, d.p, rr, gef);
      for (const k of K) acc[k].push(s[k]);
      for (const k of E) acc['e_' + k].push(s.elec[k]);
      rr.monthly.cool.forEach((v, m) => mCool[m].push(v));
      (rr.monthly.elec?.total || []).forEach((v, m) => mElec[m].push(v));
      xs.push({ ...d.p, era: d.ageClass, system: d.system, y: s.elec.total });
    }
    const o = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, t3(v)]));
    o.monthlyCool = mCool.map((v) => [q(v, 0.1), q(v, 0.9)]); o.monthlyElec = mElec.map((v) => [q(v, 0.1), q(v, 0.9)]);
    o.draws = { xs, y: acc.e_total };
    return o;
  };
  const full = one(state, seeds[0]);
  const eraKnown = !!state.era || b.eraInfo.kind !== 'prior';
  full.cond = eraKnown ? null : one({ ...state, era: b.asg.eraId }, seeds[1]);
  full.n = n;
  return full;
}

// first-order share of each sampled input in the variance of the electricity per m² (η² over 8 quantile bins, bias-corrected)
export function varShares(pr) {
  const base = pr.cond || pr, xs = base.draws.xs, y = base.draws.y, N = y.length;
  const vr = (a) => { const mu = a.reduce((s, v) => s + v, 0) / a.length; return a.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(1, a.length - 1); };
  const vy = vr(y), my = y.reduce((s, v) => s + v, 0) / N, out = [];
  if (!(vy > 0)) return out;
  for (const k of Object.keys(xs[0] || {})) {
    if (['era', 'system', 'y', 'T_heat', 'setback', 'heatedFrac'].includes(k)) continue;
    const x = xs.map((d) => d[k]);
    if (x.some((v) => typeof v !== 'number') || vr(x) < 1e-12) continue;
    const idx = x.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), G = 8, sum = new Array(G).fill(0), cnt = new Array(G).fill(0);
    idx.forEach(([, i], r) => { const g = Math.min(G - 1, Math.floor((r * G) / N)); sum[g] += y[i]; cnt[g]++; });
    let between = 0; for (let g = 0; g < G; g++) if (cnt[g]) between += cnt[g] * (sum[g] / cnt[g] - my) ** 2;
    const eta2 = between / ((N - 1) * vy), bias = (G - 1) / (N - 1), share = Math.max(0, (eta2 - bias) / (1 - bias));
    if (share > 0.01) out.push({ key: k, share });
  }
  return out.sort((a, b) => b.share - a.share);
}

// BCA measured EUI of a listed building: shown beside the model, never an input. Values outside 20–1000 kWh/(m²·a)
// are kept but flagged as implausible in the source (docs/sg-data-report.md); 2020 is a COVID year.
export function measured(row) {
  if (!row) return null;
  const years = Object.entries(row.eui || {}).map(([y, v]) => ({ year: +y, eui: v, src: row.src?.[y] || null, plausible: v >= 20 && v <= 1000, covid: +y === 2020 || +y === 2021 })).sort((a, b) => a.year - b.year);
  return { name: row.name, address: row.address, postcode: row.postcode, type: row.type || row.bebr_type || null, gfa: row.gfa, topYear: row.top_year, acSystem: row.ac_system, combined: !!row.combined,
    match: row.match, conf: row.conf, nameConflict: !!row.name_conflict, outlines: (row.osm_all || []).length, years };
}

// Retrofit measures for Singapore (?city=sg): the counterpart of js/retrofit.js. The targets come from the `retrofit` block
// of data/archetypes_sg.json (value, source with page or table, tier), the Singapore sources are in
// data/archetypes_sg_sources.md §J. Shared by the page (js/sg_app.js: the point chains), the worker (js/calib_sg.js: the
// paired draws) and the tests (tests/sg_calib_retro.mjs).
//
// A measure maps a parameter set p to p2 and never makes an input worse: the new value is the better of the draw and the
// target (min for U_roof, g_window, P_light; max for COP_cool, T_cool). Targets that depend on the draw are taken per
// draw: the AC target follows the cooling system of the draw (unitary units: NEA 5 ticks × the field factor of the stock
// rule; central plants: Green Mark Platinum TSE; district cooling: the Platinum air side), the glazing target follows
// the window-to-wall ratio of the draw (BCA ESC4 deemed-to-satisfy SC). Measures the model cannot express are left out
// (the table's retrofit._note says which), and LED lighting is left out for flats (no Green Mark budget for dwellings).
//
// Savings are paired: the same draw with and without the measure, electricity per m² of the reference area, kWh/a and CO₂
// (× the grid factor of the weather year). The set point measure of housing counts the ceiling fans the occupants switch on
// where the set point rises by 1 K or more: fan W × air-conditioned floor × AC hours × (1 + 1/COP).
import { L } from './i18n.js';
import { RES_TYPES } from './archetype_sg.js';
import { runModel, summarize } from './model_sg.js';

export const KWRT = 3.517;   // kW of cooling per refrigeration ton: COP = 3.517 / (kW/RT)
const PLANT = new Set(['chw_water', 'chw_air', 'package_wc']);

// effective SC2 of the external shading for this building: the SC2 of each facade's orientation (Envelope Code Tables
// C12–C13), weighted by the solar irradiation on its windows in the model (irr: solar.js facadeIrradiance)
export function shadingSC2(A, m, irr) {
  const T = A.retrofit.shading.SC2;
  let s = 0, w = 0;
  m.facades.forEach((f, i) => {
    const aw = f.windowArea || 0, I = irr?.facade?.[i];
    if (!(aw > 0) || !I) return;
    let q = 0; for (let k = 0; k < I.length; k++) q += I[k];
    q *= aw; s += q * (T[f.orient] ?? (T.N + T.E) / 2); w += q;
  });
  return w > 0 ? s / w : (T.N + T.E) / 2;
}

const has = (A) => !!A?.retrofit;
// the WWR of a draw (the prior draws scale the window area by wwrScale) and the deemed-to-satisfy SC row it falls in
function scRow(rows, wwr) { for (let i = 0; i < rows.length; i++) if (wwr < rows[i][0] || i === rows.length - 1) return rows[i]; return rows[rows.length - 1]; }

// the measures for this building: [{ id, label, keys, target(p, d) → { key: { to, tier, source, rule, sub } }, apply(p, d) → p2, fans }]
// d: { p, system } of a draw (system: the cooling system key of the draw; the point model passes the assigned one)
// opts.sc2: effective SC2 of external shading (shadingSC2), opts.P_light: the building's point P_light (the LED ratio applies to it)
export function measures(A, m, opts = {}) {
  if (!has(A)) return [];
  const R = A.retrofit, type = m.sgType, res = RES_TYPES.includes(type), wwr0 = m.params.WWR?.value ?? 0.25;
  const sc2 = opts.sc2 ?? (R.shading.SC2.N + R.shading.SC2.E) / 2;
  const pl0 = opts.P_light ?? m.params.P_light?.value;
  const list = [];
  const ac = {
    id: 'ac', keys: ['COP_cool'],
    label: L('高效空调', 'Efficient air conditioning', 'Effiziente Klimatisierung'),
    target: (p, d) => {
      const sys = d?.system, U = R.ac.unitary[sys];
      if (U) return { COP_cool: { to: U.value, tier: U.tier, source: U.source, rule: U.rule, sub: L(`5 级能效，额定 ${U.rated ?? '–'} × ${U.fieldFactor ?? '–'}`, `5 ticks, rated ${U.rated ?? '–'} × ${U.fieldFactor ?? '–'}`, `5 Ticks, Nennwert ${U.rated ?? '–'} × ${U.fieldFactor ?? '–'}`) } };
      if (PLANT.has(sys)) {
        const t = res ? R.ac.plant.residential : (R.ac.plant.byVariant?.[m.sgVariant] || R.ac.plant.byType[type] || R.ac.plant.byType.other);
        return { COP_cool: { to: KWRT / t.value, tier: t.tier, source: t.source, rule: t.rule, sub: L(`系统总效率 ${t.value} kW/RT`, `total system ${t.value} kW/RT`, `Gesamtsystem ${t.value} kW/RT`) } };
      }
      if (sys === 'dcs') { const t = R.ac.dcs; return { COP_cool: { to: KWRT / t.value, tier: t.tier, source: t.source, rule: t.rule, sub: L(`风侧 ${t.value} kW/RT`, `air side ${t.value} kW/RT`, `Luftseite ${t.value} kW/RT`) } }; }
      return {};
    },
  };
  ac.apply = (p, d) => { const t = ac.target(p, d).COP_cool; return t && t.to > (p.COP_cool || 0) ? { ...p, COP_cool: t.to } : p; };
  list.push(ac);
  const G = res ? R.glazing.residential : R.glazing.nonResidential;
  const glazing = {
    id: 'glazing', keys: ['g_window'],
    label: L('隔热膜或低辐射玻璃', 'Solar control film or low-e glazing', 'Sonnenschutzfolie oder Low-E-Verglasung'), short: L('隔热玻璃', 'Solar control glazing', 'Sonnenschutzglas'),
    target: (p) => {
      const w = wwr0 * (p.wwrScale ?? 1), row = scRow(G.rows, w);
      return { g_window: { to: R.glazing.gPerSC * row[1], tier: G.tier, source: G.source, sub: L(`窗墙比 ${w.toFixed(2)} → SC ≤ ${row[1]}，g = 0.87 × SC`, `WWR ${w.toFixed(2)} → SC ≤ ${row[1]}, g = 0.87 × SC`, `WWR ${w.toFixed(2)} → SC ≤ ${row[1]}, g = 0,87 × SC`) } };
    },
  };
  glazing.apply = (p) => { const t = glazing.target(p).g_window; return t.to < p.g_window ? { ...p, g_window: t.to } : p; };
  list.push(glazing);
  const S2 = R.shading;
  const shading = {
    id: 'shading', keys: ['g_window'],
    label: L('外遮阳', 'External shading', 'Außenliegender Sonnenschutz'),
    target: (p) => ({ g_window: { to: p.g_window * sc2, factor: sc2, tier: S2.R1.tier, source: `${S2.SC2.source}; R1 ${S2.R1.value}: ${S2.R1.source}`, sub: L(`g × SC2 ${sc2.toFixed(3)}（挑檐深 = 窗高 × ${S2.R1.value}）`, `g × SC2 ${sc2.toFixed(3)} (overhang depth = window height × ${S2.R1.value})`, `g × SC2 ${sc2.toFixed(3)} (Auskragung = Fensterhöhe × ${S2.R1.value})`) } }),
    apply: (p) => ({ ...p, g_window: p.g_window * sc2 }),
  };
  list.push(shading);
  const grp = R.roof.weightGroup[type] || R.roof.weightGroup.default, RU = res ? R.roof.residential : R.roof.nonResidential;
  const roof = {
    id: 'roof', keys: ['U_roof'],
    label: L('屋顶隔热', 'Roof insulation', 'Dachdämmung'),
    target: () => ({ U_roof: { to: RU[grp.value], tier: grp.tier === 'assumed' ? 'assumed' : RU.tier, source: `${RU.source}; ${grp.source}`, sub: L(`${{ light: '轻', medium: '中', heavy: '重' }[grp.value]}型屋面的限值`, `limit for a ${grp.value} roof`, `Grenzwert für ${{ light: 'leichte', medium: 'mittelschwere', heavy: 'schwere' }[grp.value]} Dächer`) } }),
  };
  roof.apply = (p) => { const t = RU[grp.value]; return t < p.U_roof ? { ...p, U_roof: t } : p; };
  list.push(roof);
  const LT = R.lighting.byType[type];
  if (!res && LT && pl0 > 0) {
    const to = LT.ratio * pl0;
    const led = {
      id: 'led', keys: ['P_light'],
      label: L('LED 照明', 'LED lighting', 'LED-Beleuchtung'),
      target: () => ({ P_light: { to, tier: LT.tier, source: LT.source, rule: LT.rule, sub: L(`绿标白金级 × ${LT.ratio}`, `Green Mark Platinum, × ${LT.ratio}`, `Green Mark Platinum, × ${LT.ratio}`) } }),
      apply: (p) => (to < p.P_light ? { ...p, P_light: to } : p),
    };
    list.push(led);
  }
  const SP = R.setpoint, F = SP.fans, fansHere = F.types.includes(type);
  const setpoint = {
    id: 'setpoint', keys: ['T_cool'], fans: fansHere,
    label: fansHere ? L('空调 25 °C 加风扇', 'AC at 25 °C with fans', 'Klimaanlage auf 25 °C mit Ventilator') : L('空调 25 °C', 'AC at 25 °C', 'Klimaanlage auf 25 °C'),
    target: () => ({ T_cool: { to: SP.T_cool.value, tier: SP.T_cool.tier, source: SP.T_cool.source, rule: SP.T_cool.rule } }),
    apply: (p) => (p.T_cool != null && p.T_cool < SP.T_cool.value ? { ...p, T_cool: SP.T_cool.value } : p),
  };
  list.push(setpoint);
  const singles = list.slice();
  list.push({
    id: 'package', keys: [...new Set(singles.flatMap((x) => x.keys))], fans: fansHere, members: singles.map((x) => x.id),
    label: L('改造组合', 'Retrofit package', 'Sanierungspaket'),
    target: (p, d) => {   // every key with the target of the last measure that sets it (g: the glazing target × SC2)
      const out = {};
      let q = p;
      for (const x of singles) { const t = x.target(q, d); q = x.apply(q, d); for (const k of Object.keys(t)) out[k] = { ...t[k], via: [...(out[k]?.via || []), x.id] }; }
      return out;
    },
    apply: (p, d) => singles.reduce((q, x) => x.apply(q, d), p),
  });
  return list;
}

// fan electricity of the set point measure in housing (kWh/a): only where the set point rose by retrofit.setpoint.fans.minRaise
export function fanKWh(A, m, p, p2, r2, af) {
  const F = A.retrofit.setpoint.fans;
  if (!F.types.includes(m.sgType) || !(p2.T_cool - p.T_cool >= F.minRaise - 1e-9)) return 0;
  const hours = r2.annual.acHours || 0, fc = p2.coolFrac ?? 1, cop = p2.COP_cool > 0 ? p2.COP_cool : 3;
  return ((F.value * fc * af * hours) / 1000) * (1 + 1 / cop);
}

// one draw through every measure: the base and, per measure, the paired saving
// d: { p, system }; list: measures(); gef: kg CO₂/kWh. Returns { base, by: { id: { dKWh, dPerM2, dCo2t, dRel, use, fan, changed, to } } }
export function evalDraw(A, m, ctx, d, list, gef) {
  const r0 = runModel(m, ctx, d.p), s0 = summarize(m, ctx, d.p, r0, gef);
  const base = { perM2: s0.elec.total, kWh: s0.elecKWh, co2t: s0.co2t, af: s0.af, elec: s0.elec, cool: s0.cool, acHours: r0.annual.acHours };
  const by = {};
  for (const x of list) {
    const p2 = x.apply(d.p, d);
    const changed = x.keys.some((k) => p2[k] !== d.p[k]);
    if (!changed) { by[x.id] = { dKWh: 0, dPerM2: 0, dCo2t: 0, dRel: 0, fan: 0, changed: false, use: { cooling: 0, lighting: 0, equipment: 0, other: 0 }, from: pick(d.p, x.keys), to: pick(p2, x.keys) }; continue; }
    const r1 = runModel(m, ctx, p2), s1 = summarize(m, ctx, p2, r1, gef);
    const fan = x.fans ? fanKWh(A, m, d.p, p2, r1, s1.af) : 0;
    const dKWh = s0.elecKWh - s1.elecKWh - fan, af = s1.af;
    by[x.id] = {
      dKWh, dPerM2: dKWh / af, dCo2t: (dKWh * gef) / 1000, dRel: s0.elecKWh > 0 ? dKWh / s0.elecKWh : 0, fan, changed: true,
      use: Object.fromEntries(['cooling', 'lighting', 'equipment', 'other'].map((k) => [k, (s0.elec[k] || 0) - (s1.elec[k] || 0)])),
      from: pick(d.p, x.keys), to: pick(p2, x.keys), after: { perM2: s1.elec.total + fan / af, kWh: s1.elecKWh + fan, elec: s1.elec, cool: s1.cool },
    };
  }
  return { base, by };
}
const pick = (p, keys) => Object.fromEntries(keys.map((k) => [k, p[k]]));

// P10, median and P90 of the paired savings over many draws (evalDraw outputs)
export function retroStats(rows, list) {
  const q3 = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const q = (f) => (s.length ? s[Math.round(f * (s.length - 1))] : null); return [q(0.1), q(0.5), q(0.9)]; };
  const mean = (a) => a.reduce((t, v) => t + v, 0) / Math.max(1, a.length);
  const out = { n: rows.length, base: { perM2: q3(rows.map((r) => r.base.perM2)), MWh: q3(rows.map((r) => r.base.kWh / 1000)), co2t: q3(rows.map((r) => r.base.co2t)) }, by: {} };
  for (const x of list) {
    const v = rows.map((r) => r.by[x.id]);
    out.by[x.id] = {
      dPerM2: q3(v.map((o) => o.dPerM2)), dMWh: q3(v.map((o) => o.dKWh / 1000)), dCo2t: q3(v.map((o) => o.dCo2t)), dRel: q3(v.map((o) => o.dRel)),
      mean: { dPerM2: mean(v.map((o) => o.dPerM2)), dMWh: mean(v.map((o) => o.dKWh / 1000)) },
      changed: v.filter((o) => o.changed).length / Math.max(1, v.length), fanMWh: q3(v.map((o) => o.fan / 1000)),
      use: Object.fromEntries(['cooling', 'lighting', 'equipment', 'other'].map((k) => [k, q3(v.map((o) => o.use[k]))[1]])),
      from: Object.fromEntries(x.keys.map((k) => [k, q3(v.map((o) => o.from[k]))])), to: Object.fromEntries(x.keys.map((k) => [k, q3(v.map((o) => o.to[k]))])),
    };
  }
  return out;
}

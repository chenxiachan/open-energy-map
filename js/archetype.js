// Typology → physics parameters with provenance, plus the hierarchical prior used by the calibration.
//
// Prior structure (sampled by samplePrior):
//   age class  ~ Categorical(π)          π from OSM start_date, else Zensus 2022 grid (100 m → 300 m → 1 km), else uniform
//   modernised component c ∈ {windows, wall, roof, floor} ~ Bernoulli(q_c(period))   (unless the user fixed it)
//   U_c        = U_c(type, class, state) · LogNormal(0, σ)                            σ = 0.22 original, 0.30 modernised
//   behaviour  T_heat ~ N, heatedFrac ~ U, n_vent ~ LogN, Q_int ~ LogN, eta ~ U(etaRange), n50 ~ LogN(period)
// User-entered values are point masses. All of this is shown in the "参数与来源" tab.
// UI strings are built with L(zh, en) from i18n.js; the export names (SOURCE_CN, TYPE_CN, …) are kept for the tests and tools.
import { L, localize } from './i18n.js';
import { osmRule } from './osmdefaults.js';
import { anFactorAt } from './geometry.js';

const G = { env: L('围护', 'Envelope', 'Gebäudehülle'), geom: L('几何', 'Geometry', 'Geometrie'), vent: L('通风', 'Ventilation', 'Lüftung'), use: L('使用', 'Occupancy', 'Nutzung'), sys: L('系统', 'System', 'Anlagentechnik') };

export const PARAM_META = {
  U_wall: { label: L('外墙 U 值', 'External wall U-value', 'Außenwand U-Wert'), unit: 'W/(m²·K)', group: G.env },
  U_roof: { label: L('屋顶/顶层楼板 U 值', 'Roof / top floor ceiling U-value', 'Dach / oberste Geschossdecke U-Wert'), unit: 'W/(m²·K)', group: G.env },
  U_floor: { label: L('地面/地下室顶板 U 值', 'Ground floor / basement ceiling U-value', 'Boden / Kellerdecke U-Wert'), unit: 'W/(m²·K)', group: G.env },
  U_window: { label: L('外窗 U 值', 'Window U-value', 'Fenster U-Wert'), unit: 'W/(m²·K)', group: G.env },
  g_window: { label: L('玻璃 g 值', 'Glazing g-value', 'Verglasung g-Wert'), unit: '–', group: G.env },
  frameFrac: { label: L('窗框比例', 'Frame fraction', 'Rahmenanteil'), unit: '–', group: G.env },
  dU_tb: { label: L('热桥附加', 'Thermal bridge surcharge', 'Wärmebrückenzuschlag'), unit: 'W/(m²·K)', group: G.env },
  WWR_N: { label: L('北向窗墙比', 'Window-to-wall ratio N', 'Fensterflächenanteil N'), unit: '–', group: G.geom },
  WWR_E: { label: L('东向窗墙比', 'Window-to-wall ratio E', 'Fensterflächenanteil O'), unit: '–', group: G.geom },
  WWR_S: { label: L('南向窗墙比', 'Window-to-wall ratio S', 'Fensterflächenanteil S'), unit: '–', group: G.geom },
  WWR_W: { label: L('西向窗墙比', 'Window-to-wall ratio W', 'Fensterflächenanteil W'), unit: '–', group: G.geom },
  n50: { label: L('气密性 n50', 'Air tightness n50', 'Luftdichtheit n50'), unit: '1/h', group: G.vent },
  n_vent: { label: L('通风换气次数', 'Ventilation air change rate', 'Luftwechselrate (Lüftung)'), unit: '1/h', group: G.vent },
  hr_eff: { label: L('热回收效率', 'Heat recovery efficiency', 'Wärmerückgewinnungsgrad'), unit: '–', group: G.vent },
  T_heat: { label: L('供暖设定温度', 'Heating set point', 'Solltemperatur Heizen'), unit: '°C', group: G.use },
  setback: { label: L('夜间/非使用时段降温', 'Night and unoccupied set-back', 'Nacht- und Abwesenheitsabsenkung'), unit: 'K', group: G.use },
  T_cool: { label: L('制冷设定温度', 'Cooling set point', 'Solltemperatur Kühlen'), unit: '°C', group: G.use },
  Q_int: { label: L('内部得热', 'Internal gains', 'Interne Wärmegewinne'), unit: 'W/m²', group: G.use },
  heatedFrac: { label: L('实际供暖面积比例', 'Heated floor area fraction', 'Anteil beheizter Fläche'), unit: '–', group: G.use },
  dhw: { label: L('生活热水需求', 'Domestic hot water demand', 'Trinkwarmwasserbedarf'), unit: 'kWh/(m²·a)', group: G.use },
  Cm: { label: L('有效热容', 'Effective heat capacity', 'Wirksame Wärmekapazität'), unit: 'J/(m²·K)', group: G.env },
  F_floor: { label: L('地面温度修正系数', 'Ground floor temperature correction factor', 'Temperatur-Korrekturfaktor Boden'), unit: '–', group: G.env },
  F_roof: { label: L('屋顶温度修正系数', 'Roof temperature correction factor', 'Temperatur-Korrekturfaktor Dach'), unit: '–', group: G.env },
  shadeCtrl: { label: L('活动遮阳透过系数', 'Movable shading transmittance', 'Abminderungsfaktor beweglicher Sonnenschutz'), unit: '–', group: G.use },
  system: { label: L('供热系统', 'Heating system', 'Heizsystem'), unit: '', group: G.sys },
  eta_sys: { label: L('系统季节效率', 'System seasonal efficiency', 'Jahresnutzungsgrad der Anlage'), unit: '–', group: G.sys },
};

export const SOURCE_CN = {
  osm: L('OSM 标签', 'OSM', 'OSM'), lod2: 'LoD2', geometry: L('几何推算', 'Derived from geometry', 'Aus Geometrie abgeleitet'), archetype: L('类型学查表', 'Typology table', 'Typologie-Tabelle'),
  profile: L('使用剖面', 'Usage profile', 'Nutzungsprofil'), user: L('用户填写', 'User input', 'Eigene Eingabe'), default: L('估算', 'Assumed', 'Annahme'),
  calibrated: L('账单标定', 'Bill-calibrated', 'Kalibriert'), zensus: 'Zensus 2022',
};

export const TYPE_CN = {
  sfh: L('独栋住宅', 'Single-family house', 'Einfamilienhaus'), th: L('联排/双拼住宅', 'Terraced or semi-detached house', 'Reihen- oder Doppelhaus'), mfh: L('多户住宅', 'Multi-family house', 'Mehrfamilienhaus'),
  ab: L('大型多户住宅', 'Large apartment block', 'Großes Mehrfamilienhaus'), office: L('办公', 'Office', 'Bürogebäude'), education: L('教育', 'Education', 'Bildungsgebäude'), retail: L('商业零售', 'Retail', 'Einzelhandel'), other: L('其他', 'Other', 'Sonstige'),
};

let A = null;
export async function loadArchetypes(url = 'data/archetypes_de.json') {
  if (!A) A = localize(await (await fetch(url)).json());
  return A;
}
export function archetypes() { return A; }

export function ageClassOfYear(year) {
  for (const c of A.ageClasses) if ((c.from == null || year >= c.from) && (c.to == null || year <= c.to)) return c.id;
  return A.ageClasses[A.ageClasses.length - 1].id;
}

function classMid(c) {
  const lo = c.from ?? 1800, hi = c.to ?? 2025;
  return (lo + hi) / 2;
}

// Zensus class (by index 0..7) → TABULA class weights.
function zensusMapWeights() {
  const zm = A.zensusMap || {};
  const keys = Object.keys(zm);
  const firstYear = (k) => { const m = k.match(/\d{4}/); return m ? +m[0] : (k.includes('<') || /vor/i.test(k) ? 0 : NaN); };
  const starts = [0, 1919, 1949, 1979, 1991, 2001, 2011, 2020];
  return starts.map((y, i) => {
    const k = keys.find((kk) => (i === 0 ? /</.test(kk) || /vor/i.test(kk) : !/</.test(kk) && !/vor/i.test(kk) && firstYear(kk) === y));
    if (k && typeof zm[k] === 'object') return zm[k];
    // fallback: proportional by overlapping years
    const lo = i === 0 ? 1800 : y, hi = i === 7 ? 2025 : starts[i + 1] - 1;
    const w = {};
    for (const c of A.ageClasses) {
      const a = Math.max(lo, c.from ?? 1800), b = Math.min(hi, c.to ?? 2025);
      if (b >= a) w[c.id] = b - a + 1;
    }
    const s = Object.values(w).reduce((x, v) => x + v, 0);
    for (const k2 in w) w[k2] /= s;
    return w;
  });
}

// ctx.usage (optional, the model's usage) decides the non-residential mix; without it the building tags decide.
export function agePrior(tags, zensus, ctx = {}) {
  const ids = A.ageClasses.map((c) => c.id);
  const y = parseInt(String(tags.start_date || tags['building:year'] || tags.construction_date || tags.year_of_construction || '').match(/\d{4}/)?.[0], 10);
  if (Number.isFinite(y) && y > 1200 && y < 2030) {
    const id = ageClassOfYear(y);
    const p = Object.fromEntries(ids.map((k) => [k, k === id ? 0.9 : 0]));
    const i = ids.indexOf(id);
    if (i > 0) p[ids[i - 1]] += 0.05; else p[id] += 0.05;
    if (i < ids.length - 1) p[ids[i + 1]] += 0.05; else p[id] += 0.05;
    return { p, src: `OSM start_date=${y}`, kind: 'osm' };
  }
  if (zensus && zensus.counts.reduce((s, v) => s + v, 0) > 0) {
    const W = zensusMapWeights();
    const p = Object.fromEntries(ids.map((k) => [k, 0]));
    const tot = zensus.counts.reduce((s, v) => s + v, 0);
    zensus.counts.forEach((cnt, zi) => { for (const [k, w] of Object.entries(W[zi])) if (k in p) p[k] += (cnt / tot) * w; });
    // keep every class possible (confidentiality zeroes small counts)
    const eps = 0.01;
    let s = 0;
    for (const k of ids) { p[k] = p[k] * (1 - eps * ids.length) + eps; s += p[k]; }
    for (const k of ids) p[k] /= s;
    // Mix in equal class weights where the grid prior proved weak in the OSM holdout test (qa/holdout_b.md):
    // registry rule ageMixUniform (data/osm_defaults.json); without the registry the prior stays unmixed.
    const mix = osmRule('ageMixUniform')?.table;
    const b = tags.building || 'yes';
    const resTag = ['house', 'detached', 'bungalow', 'farm', 'cabin', 'semidetached_house', 'terrace', 'apartments', 'residential', 'dormitory'].includes(b) || tags['building:use'] === 'residential';
    const nonRes = ctx.usage ? !['sfh', 'th', 'mfh', 'ab'].includes(ctx.usage)
      : !resTag && (b !== 'yes' || !!(tags.office || tags.shop || ['university', 'school', 'college', 'kindergarten'].includes(tags.amenity)));
    let a = 0;
    if (mix) {
      const lv = String(zensus.level || '');
      a = (/1 ?km/.test(lv) ? mix['1km'] : /300/.test(lv) ? mix['300m'] : mix['100m']) || 0;
      if (nonRes) a = Math.max(a, mix.nonResidential || 0);
      for (const k of ids) p[k] = (1 - a) * p[k] + a / ids.length;
    }
    const base = L(`Zensus 2022（${zensus.level}，${tot} 栋住宅建筑）`, `Zensus 2022 (${zensus.level}, ${tot} residential buildings)`, `Zensus 2022 (${zensus.level}, ${tot} Wohngebäude)`);
    const pct = Math.round(a * 100);
    const src = a > 0
      ? L(`${base}，其中 ${pct}% 权重给各年代等权分布（${nonRes ? '非住宅，' : ''}按 OSM 留出统计）`, `${base}, with ${pct}% weight on equal age class weights (${nonRes ? 'non-residential, ' : ''}from the OSM holdout statistics)`, `${base}, davon ${pct}% Gewicht auf gleich gewichtete Baualtersklassen (${nonRes ? 'Nichtwohngebäude, ' : ''}nach der OSM-Holdout-Statistik)`)
      : base;
    return { p, src, kind: 'zensus', zensus, mixUniform: a };
  }
  const p = Object.fromEntries(ids.map((k) => [k, 1 / ids.length]));
  return { p, src: L('无年代信息，各年代等权', 'No age data, all age classes weighted equally', 'Keine Altersangabe, alle Baualtersklassen gleich gewichtet'), kind: 'uniform' };
}

function envelopeFor(type, cls, model) {
  const t = ['sfh', 'th', 'mfh', 'ab'].includes(type) ? type : 'mfh';
  const e = { ...((A.envelope[t] && A.envelope[t][cls]) || A.envelope.mfh[cls]) };
  // pick the element that matches the attic / basement situation inferred from OSM
  if (model) {
    const att = model.roof.attic;
    const TOP = L('顶层楼板', 'Top floor ceiling', 'Oberste Geschossdecke'), PITCHED = L('坡屋面', 'Pitched roof', 'Geneigtes Dach');
    if (att === 'unheated' && e.U_topCeiling) { e.U_roof = e.U_topCeiling; e.roofUsed = TOP; }
    else if (att === 'heated' && e.U_roofPitched) { e.U_roof = e.U_roofPitched; e.roofUsed = PITCHED; }
    else e.roofUsed = e.roofIs === 'top ceiling' ? TOP : e.roofIs === 'pitched roof' ? PITCHED : L('屋面', 'Roof', 'Dach');
    if (model.basement === 'unheated' && e.U_basementCeiling) { e.U_floor = e.U_basementCeiling; e.floorUsed = L('地下室顶板', 'Basement ceiling', 'Kellerdecke'); }
    else if (model.basement === 'none' && e.U_slab) { e.U_floor = e.U_slab; e.floorUsed = L('地面板', 'Ground slab', 'Bodenplatte'); }
    else e.floorUsed = L('地面/底板', 'Ground floor or slab', 'Boden oder Bodenplatte');
  }
  return { ...e, proxy: t !== type };
}

function modernProb(cls) {
  const c = A.ageClasses.find((x) => x.id === cls);
  const mid = classMid(c);
  const rows = (A.modernisation && A.modernisation.byPeriod) || [];
  const row = rows.find((r) => (r.from == null || mid >= r.from) && (r.to == null || mid <= r.to));
  // the last IWU period lumps 1995–today; buildings younger than ~25 years have rarely been modernised (estimate)
  const age = 2026 - mid;
  const f = age < 15 ? 0.1 : age < 25 ? 0.5 : 1;
  if (row) return { windows: (row.windows ?? 0) * f, wall: (row.wall ?? 0) * f, roof: (row.roof ?? 0) * f, floor: (row.floor ?? 0) * f, src: row.src, estimated: row.estimated };
  return { windows: 0, wall: 0, roof: 0, floor: 0, src: 'none', estimated: true };
}

// U-value of a component modernised at some point after construction (estimate, see the 方法 tab):
// windows → post-1995 low-e double glazing (IWU 2018 defines the window event that way), opaque elements → the
// original construction plus a typical retrofit insulation layer (λ 0.04: wall 8 cm, roof/top ceiling 12 cm, floor 6 cm).
// U after a past retrofit: the original U in series with the mean added insulation measured in the stock
// (IWU2018 Tab. 33/35/38: wall 9.0 cm, roof 13.3 cm, floor 7.7 cm; λ 0.035, roof λ_eff 0.045 for rafters).
// Replaced windows: about 1.6, implied by IWU2022 Tab. 3. Values live in data/archetypes_de.json modernisation.typicalUAfter.
export function modernU(orig, comp) {
  const t = (A && A.modernisation && A.modernisation.typicalUAfter) || {};
  if (comp === 'windows') return Math.min(orig, t.U_window_derived ?? 1.6);
  const d = (t.thickness_m || { wall: 0.09, roof: 0.133, floor: 0.077 })[comp], lam = (t.lambda || { wall: 0.035, roof: 0.045, floor: 0.035 })[comp];
  return Math.min(orig, 1 / (1 / orig + d / lam));
}

// Heating system from the Zensus energy-carrier shares of the grid cell (dwellings). The boiler type within gas
// still follows the age rule, which is an assumption.
const CARRIER_SYSTEM = { Gas: 'gas', Heizoel: 'oil', Holz_Holzpellets: 'pellet', Biomasse_Biogas: 'pellet', Solar_Geothermie_Waermepumpen: 'hp_air', Strom: 'electric', Kohle: 'oil', Fernwaerme: 'district' };
export const CARRIER_CN = { Gas: L('燃气', 'gas', 'Gas'), Heizoel: L('燃油', 'oil', 'Heizöl'), Holz_Holzpellets: L('木材/颗粒', 'wood/pellets', 'Holz/Pellets'), Biomasse_Biogas: L('生物质', 'biomass', 'Biomasse'), Solar_Geothermie_Waermepumpen: L('热泵/太阳能/地热', 'heat pump/solar/geothermal', 'Wärmepumpe/Solar/Geothermie'), Strom: L('直接电热', 'direct electric', 'Stromdirektheizung'), Kohle: L('煤', 'coal', 'Kohle'), Fernwaerme: L('区域供热', 'district heating', 'Fernwärme') };
function systemOf(carrier, cls) {
  const s = CARRIER_SYSTEM[carrier];
  return s === 'gas' ? defaultSystem(cls).replace('hp_air', 'gas_cond') : s || null;
}
export function systemPrior(heat, cls) {
  if (!heat || !heat.p) return null;
  const out = {};
  for (const [c, v] of Object.entries(heat.p)) { const k = systemOf(c, cls); if (k && v > 0) out[k] = (out[k] || 0) + v; }
  return Object.keys(out).length ? out : null;
}

const USAGE_PROFILE = { sfh: 'residential', th: 'residential', mfh: 'residential', ab: 'residential', office: 'office', education: 'education', retail: 'retail', other: 'office' };
const PROFILE_OF = { classroom: 'education' };   // profiles a model may name, and the usage profile they refine

// The usage profile of a model (or of a usage string). A model may name a profile of its own (model.profile, e.g.
// 'classroom' for schools and nurseries, geometry.js classifyUsage) within its usage.
export function profileFor(u) {
  const usage = typeof u === 'string' ? u : u?.usage;
  const own = typeof u === 'object' ? u?.profile : null;   // kept only while the usage still matches (the user may change it)
  const key = own && A.profiles[own] && PROFILE_OF[own] === USAGE_PROFILE[usage] ? own : USAGE_PROFILE[usage];
  const pr = A.profiles[key] || A.profiles.residential;
  const hours = pr.hoursPerDay ?? 24;
  const start = pr.start ?? (hours >= 24 ? 0 : usage === 'retail' ? 8 : 7);
  return { ...pr, start, end: hours >= 24 ? 24 : start + hours, daysPerWeek: pr.daysPerWeek ?? 7, key };
}

function defaultWWR(usage, cls) {
  const year = classMid(A.ageClasses.find((x) => x.id === cls));
  if (usage === 'office') return year < 1970 ? 0.30 : 0.40;
  if (usage === 'education') return 0.35;
  if (usage === 'retail') return 0.30;
  if (usage === 'sfh') return 0.17;
  if (usage === 'th') return 0.19;
  return year < 1919 ? 0.24 : 0.21;
}

// state: { ageClass: null | id, refurb: { windows, wall, roof, floor: 'unknown' | 'yes' | 'no' }, system, user: { key: value } }
export function assign(model, ageInfo, state) {
  const ids = A.ageClasses.map((c) => c.id);
  const pr = ageInfo.p;
  const cls = state.ageClass || ids.reduce((best, k) => (pr[k] > pr[best] ? k : best), ids[0]);
  const env = envelopeFor(model.usage, cls, model);
  const per = A.periodDefaults[cls] || {};
  const mp = modernProb(cls);
  const prof = profileFor(model);
  const D = (A.meta && A.meta.defaults) || {};
  const P = {};
  const set = (k, value, source, note) => { P[k] = { value, unit: PARAM_META[k]?.unit || '', source, note: note || '' }; };
  const clsLabel = A.ageClasses.find((c) => c.id === cls).label;
  const envSrc = L(`${TYPE_CN[model.usage]}${env.proxy ? '（用多户住宅构件值近似）' : ''}，${clsLabel}`, `${TYPE_CN[model.usage]}${env.proxy ? ' (approximated with multi-family house elements)' : ''}, ${clsLabel}`, `${TYPE_CN[model.usage]}${env.proxy ? ' (mit Bauteilwerten des Mehrfamilienhauses angenähert)' : ''}, ${clsLabel}`);
  const comp = [['windows', 'U_window'], ['wall', 'U_wall'], ['roof', 'U_roof'], ['floor', 'U_floor']];
  // Unknown retrofit state: the point value is the expected value p · U_retrofitted + (1 − p) · U_original, so the
  // point sits where the prior does instead of flipping at p = 50 %.
  const share = (c) => { const st = state.refurb?.[c] || 'unknown'; return st === 'yes' ? 1 : st === 'no' ? 0 : mp[c]; };
  for (const [c, k] of comp) {
    const st = state.refurb?.[c] || 'unknown';
    const q = share(c), u0 = env[k], u1 = modernU(env[k], c);
    const u = q * u1 + (1 - q) * u0;
    const sep = L('，', ', ', ', ');
    const what = k === 'U_roof' ? `${env.roofUsed}${sep}` : k === 'U_floor' ? `${env.floorUsed}${sep}` : '';
    const f = (v) => (+v).toFixed(2);
    const how = st === 'yes' ? L(`已改造（用户指定）：${f(u1)}`, `retrofitted (set by user): ${f(u1)}`, `saniert (eigene Angabe): ${f(u1)}`)
      : st === 'no' ? L(`原始状态（用户指定）：${f(u0)}`, `original state (set by user): ${f(u0)}`, `Originalzustand (eigene Angabe): ${f(u0)}`)
      : L(`期望值 = ${(q * 100).toFixed(0)}% × 改造后 ${f(u1)} + ${((1 - q) * 100).toFixed(0)}% × 原始 ${f(u0)}`, `expected value = ${(q * 100).toFixed(0)}% × retrofitted ${f(u1)} + ${((1 - q) * 100).toFixed(0)}% × original ${f(u0)}`, `Erwartungswert = ${(q * 100).toFixed(0)}% × saniert ${f(u1)} + ${((1 - q) * 100).toFixed(0)}% × Original ${f(u0)}`);
    set(k, +u.toFixed(3), 'archetype', `${what}${envSrc}${L('；', '; ', '; ')}${how}`);
  }
  const qw = share('windows'), g0 = env.g_window ?? 0.75;
  set('g_window', +(qw * 0.6 + (1 - qw) * g0).toFixed(3), 'archetype', qw === 1 ? L('更换后的双层低辐射玻璃', 'Replacement low-e double glazing', 'Erneuerte Zweifach-Wärmeschutzverglasung') : qw === 0 ? L('原始玻璃', 'Original glazing', 'Originalverglasung')
    : L(`期望值 = ${(qw * 100).toFixed(0)}% × 0.60（换窗后）+ ${((1 - qw) * 100).toFixed(0)}% × ${g0.toFixed(2)}（原始）`, `expected value = ${(qw * 100).toFixed(0)}% × 0.60 (replaced) + ${((1 - qw) * 100).toFixed(0)}% × ${g0.toFixed(2)} (original)`, `Erwartungswert = ${(qw * 100).toFixed(0)}% × 0,60 (erneuert) + ${((1 - qw) * 100).toFixed(0)}% × ${g0.toFixed(2)} (Original)`));
  set('frameFrac', per.frameFrac ?? 0.3, per.frameFrac ? 'archetype' : 'default', per.frameFrac_src ? L('TABULA 标准窗框比例', 'TABULA standard frame fraction', 'Standard-Rahmenanteil nach TABULA') : L('常用假设', 'Common assumption', 'Übliche Annahme'));
  set('dU_tb', per.dU_tb ?? 0.1, 'archetype', `${L('年代默认值', 'Age-class default', 'Standardwert der Baualtersklasse')} ${per.src || ''}`);
  set('n50', +((per.n50 ?? 5) * (1 - 0.25 * share('windows'))).toFixed(2), 'archetype', L(`年代默认值 ${per.n50 ?? 5} × (1 − 0.25 × 换窗概率 ${(share('windows') * 100).toFixed(0)}%)`, `Age-class default ${per.n50 ?? 5} × (1 − 0.25 × window replacement probability ${(share('windows') * 100).toFixed(0)}%)`, `Standardwert der Baualtersklasse ${per.n50 ?? 5} × (1 − 0,25 × Wahrscheinlichkeit Fenstertausch ${(share('windows') * 100).toFixed(0)}%)`));
  set('Cm', per.Cm ?? 165000, 'archetype', L('按年代的构造重量', 'Construction mass by age class', 'Bauschwere nach Baualtersklasse'));
  const w0 = defaultWWR(model.usage, cls);
  for (const o of ['N', 'E', 'S', 'W']) set(`WWR_${o}`, w0, 'default', L('按类型和年代估计（OSM 无窗户信息）', 'Estimated from type and age (OSM has no window data)', 'Nach Gebäudetyp und Baujahr geschätzt (OSM enthält keine Fensterdaten)'));
  set('n_vent', prof.n_vent ?? 0.5, 'profile', prof.label || '');
  set('hr_eff', 0, 'default', L('无机械通风热回收', 'No heat recovery on mechanical ventilation', 'Keine Lüftungsanlage mit Wärmerückgewinnung'));
  set('T_heat', prof.T_heat ?? 20, 'profile', prof.label || '');
  set('setback', prof.setback ?? 2, 'profile', '');
  set('T_cool', prof.T_cool ?? null, 'profile', prof.T_cool == null ? L('无制冷', 'No cooling', 'Keine Kühlung') : '');
  set('Q_int', prof.Q_int ?? 3, 'profile', prof.label || '');
  set('heatedFrac', 1.0, 'default', L('全部面积供暖', 'Whole floor area heated', 'Gesamte Fläche beheizt'));
  set('dhw', ['sfh', 'th', 'mfh', 'ab'].includes(model.usage) ? (prof.dhw ?? 12.5) : (prof.dhw ?? 0), 'profile', '');
  set('F_floor', D.F_floor ?? 0.5, 'archetype', L(`TABULA 温度修正 b = ${D.F_floor ?? 0.5}（${model.basement === 'unheated' ? '不供暖地下室顶板' : '地面板'}）`, `TABULA temperature correction b = ${D.F_floor ?? 0.5} (${model.basement === 'unheated' ? 'ceiling over unheated basement' : 'ground slab'})`, `TABULA-Temperatur-Korrekturfaktor b = ${D.F_floor ?? 0.5} (${model.basement === 'unheated' ? 'Decke über unbeheiztem Keller' : 'Bodenplatte'})`));
  set('F_roof', model.roof.attic === 'unheated' ? (D.F_roof_unheatedAttic ?? 0.85) : (D.F_roof_heatedAttic ?? 1.0), model.roof.attic === 'unheated' ? 'archetype' : 'default', model.roof.attic === 'unheated' ? L('不供暖阁楼下的顶层楼板（由 TABULA MFH_E 推得）', 'Top floor ceiling below an unheated attic (derived from TABULA MFH_E)', 'Oberste Geschossdecke unter unbeheiztem Dachgeschoss (abgeleitet aus TABULA MFH_E)') : L('直接对外的屋面', 'Roof exposed to outside air', 'Dach gegen Außenluft'));
  set('shadeCtrl', D.shadeCtrl ?? 0.3, 'default', L('夏季外遮阳（活动百叶）透过系数，估计值', 'Transmittance of summer external shading (movable blinds), estimated', 'Abminderungsfaktor des sommerlichen außenliegenden Sonnenschutzes (bewegliche Jalousien), geschätzt'));
  const sp = systemPrior(ageInfo && ageInfo.heat, cls);
  const sysKey = state.system || (sp ? Object.entries(sp).sort((a, b) => b[1] - a[1])[0][0] : defaultSystem(cls));
  const heatNote = sp ? L(`Zensus 2022 ${ageInfo.heat.level}，按住宅单元：`, `Zensus 2022 ${ageInfo.heat.level}, by dwellings: `, `Zensus 2022 ${ageInfo.heat.level}, nach Wohnungen: `) + Object.entries(ageInfo.heat.p).filter(([, v]) => v >= 0.01).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${CARRIER_CN[c] || c} ${(v * 100).toFixed(0)}%`).join(L('，', ', ', ', ')) + L('；取最多的一类。燃气锅炉类型仍按年代估算', '; the largest share is used. The gas boiler type is still estimated from age', '; verwendet wird der größte Anteil. Die Art des Gaskessels wird weiterhin aus dem Baujahr geschätzt') : L('按年代估算（附近没有 Zensus 供暖数据）', 'Estimated from age (no Zensus heating data nearby)', 'Nach Baujahr geschätzt (keine Zensus-Heizungsdaten in der Nähe)');
  set('system', sysKey, state.system ? 'user' : sp ? 'zensus' : 'default', state.system ? '' : heatNote);
  const sy = A.systems[sysKey] || {};
  set('eta_sys', sy.eta ?? 0.9, 'archetype', sy.label || '');
  for (const [k, v] of Object.entries(state.user || {})) if (P[k]) { P[k].value = v; P[k].source = 'user'; P[k].note = L('用户填写', 'User input', 'Eigene Eingabe'); }
  return { params: P, cls, env, mp, prof };
}

function defaultSystem(cls) {
  const y = classMid(A.ageClasses.find((c) => c.id === cls));
  return y < 1995 ? 'gas_old' : y < 2016 ? 'gas_cond' : 'hp_air';
}

export function applyWWR(model) {
  for (const f of model.facades) f.wwr = model.params[`WWR_${f.orient}`]?.value ?? 0.2;
}

// ---------- prior sampling ----------
export function rng(seed = 1) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => { let x = 0, y = 0; while (x === 0) x = u(); y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  return { u, n };
}

export const UNCERTAIN = ['U_wall', 'U_window', 'U_roof', 'U_floor', 'g_window', 'n50', 'dU_tb', 'T_heat', 'heatedFrac', 'n_vent', 'Q_int', 'eta_sys'];

// Returns a sampler: draw(r) → { p, ageClass, modern: {windows, wall, roof, floor} }
// Prior variants for offline studies only (tools/voi_pilot.mjs --prior lit): spreads taken from the literature. The app
// never sets one; with none set every draw below is exactly the app's prior (the same random numbers in the same order).
// v: { sigmaU(cls), dUtb(cls) → [lo, hi], sdT(usage), heated(usage) → [lo, hi], nVent(usage, prof), sVent, sQ,
// eInf: { median, gsd } } (each optional)
let PV = null;
export function setPriorVariant(v) { PV = v || null; }

export function makePrior(model, ageInfo, state, assigned) {
  const ids = A.ageClasses.map((c) => c.id);
  const fixedAge = state.ageClass;
  const cum = [];
  let s = 0;
  for (const k of ids) { s += ageInfo.p[k]; cum.push([s, k]); }
  const base = {};
  for (const [k, v] of Object.entries(model.params)) base[k] = v.value;
  const user = (k) => model.params[k]?.source === 'user';
  const prof = assigned.prof;
  const userSys = !!state.system || user('system');
  const etaRange = (k) => (A.systems[k] || {}).etaRange || [base.eta_sys * 0.9, Math.min(1, base.eta_sys * 1.08)];
  const wwrUser = ['N', 'E', 'S', 'W'].some((o) => user(`WWR_${o}`));
  return (r) => {
    let cls = fixedAge;
    if (!cls) { const x = r.u() * s; cls = cum.find(([c]) => x <= c)?.[1] || ids[ids.length - 1]; }
    const env = envelopeFor(model.usage, cls, model);
    const per = A.periodDefaults[cls] || {};
    const mp = modernProb(cls);
    const p = { ...base };
    const modern = {};
    for (const [c, k] of [['windows', 'U_window'], ['wall', 'U_wall'], ['roof', 'U_roof'], ['floor', 'U_floor']]) {
      const st = state.refurb?.[c] || 'unknown';
      modern[c] = st === 'yes' ? true : st === 'no' ? false : r.u() < mp[c];
      if (!user(k)) {
        const u0 = modern[c] ? modernU(env[k], c) : env[k];
        p[k] = u0 * Math.exp((modern[c] ? 0.30 : PV?.sigmaU ? PV.sigmaU(cls) : 0.22) * r.n());
      }
    }
    if (!user('g_window')) p.g_window = modern.windows ? 0.5 + 0.15 * r.u() : Math.min(0.85, (env.g_window ?? 0.75) + 0.08 * (r.u() - 0.5));
    if (!user('n50')) p.n50 = (per.n50 ?? 5) * (modern.windows ? 0.75 : 1) * Math.exp(Math.log(per.n50_gsd || 1.45) * r.n());
    const tb = PV?.dUtb?.(cls);
    if (!user('dU_tb')) p.dU_tb = tb ? tb[0] + (tb[1] - tb[0]) * r.u() : Math.max(0.02, (per.dU_tb ?? 0.1) + 0.04 * (r.u() - 0.5) * 2);
    if (!user('T_heat')) p.T_heat = (prof.T_heat ?? 20) + 0.5 + (PV?.sdT ? PV.sdT(model.usage) : 1.0) * r.n();
    const hf = PV?.heated?.(model.usage);
    if (!user('heatedFrac')) p.heatedFrac = hf ? hf[0] + (hf[1] - hf[0]) * r.u() : model.usage === 'office' || model.usage === 'education' || model.usage === 'retail' ? 0.85 + 0.15 * r.u() : 0.7 + 0.3 * r.u();
    if (!user('n_vent')) p.n_vent = (PV?.nVent ? PV.nVent(model.usage, prof) : prof.n_vent ?? 0.5) * Math.exp((PV?.sVent ?? 0.35) * r.n());
    if (!user('Q_int')) p.Q_int = (prof.Q_int ?? 3) * Math.exp((PV?.sQ ?? 0.25) * r.n());
    if (PV?.eInf) p.e_inf = PV.eInf.median * Math.exp(Math.log(PV.eInf.gsd) * r.n());   // infiltration per n50 (rc5.js; the app uses 0.07)
    if (!userSys) {   // system from the Zensus carrier shares of the cell, conditional on the sampled age for the gas boiler type
      const sp = systemPrior(ageInfo && ageInfo.heat, cls);
      if (sp) { let x = r.u(); p.system = Object.keys(sp).find((k) => (x -= sp[k]) <= 0) || base.system; }
    }
    if (!user('eta_sys')) { const er = etaRange(p.system); p.eta_sys = er[0] + (er[1] - er[0]) * r.u(); }
    if (!wwrUser) p.wwrScale = Math.exp(0.25 * r.n());   // WWR has no source: one common factor, P10–P90 about ×0.73–1.38
    // storeys: when they are a default, sample true/default from the holdout histogram that geometry.js attaches
    if (model.floorsPrior && !(state.geom && (state.geom.floors || state.geom.height))) { let x = r.u(); const hit = model.floorsPrior.find(([, w]) => (x -= w) <= 0); p.hScale = hit ? hit[0] : 1; }
    // reference area: storey height from measured heights may run high by up to model.hGBias (geometry.js anFactorMean);
    // each draw takes one δ, so the GEG step at 3.0 m shows in the range instead of moving the point value
    if (model.hGBias > 0 && model.areas?.anFactor) p.anScale = anFactorAt(model.floorHeight, model.hGBias * r.u()) / model.areas.anFactor;
    return { p, ageClass: cls, modern };
  };
}

// Exact conditioning for value-of-information studies (tools/voi_pilot.mjs). makePrior draws every input independently
// once the latent state is set: the age class and which of the four components were modernised. Given observed inputs,
// this returns the posterior over that state (12 classes × 16 combinations, enumerated); drawing a state from it, fixing
// it in `state` (ageClass, refurb) and fixing the observed inputs gives draws from the prior conditional on the
// observations. Without it, fixing for example the refurbishment state while the age is still drawn from its prior
// ignores what the state says about the age, and the range can even come out wider than with no information.
// obs: { p: observed input values, keys: their names, refurb: { windows, wall, roof, floor } booleans or null,
// ageClass: or null }. The densities follow makePrior line by line.
export function latentPosterior(model, ageInfo, state, obs) {
  const comps = [['windows', 'U_window'], ['wall', 'U_wall'], ['roof', 'U_roof'], ['floor', 'U_floor']];
  const user = (k) => model.params[k]?.source === 'user';
  const has = (k) => obs.keys.includes(k) && !user(k) && typeof obs.p[k] === 'number';
  const lnN = (x, mu, s) => (x > 0 ? Math.exp(-0.5 * ((Math.log(x) - mu) / s) ** 2) / (s * x) : 0);   // up to a constant
  const unif = (x, a, b) => (x >= a - 1e-12 && x <= b + 1e-12 ? 1 / (b - a) : 0);
  const out = [];
  for (const c of A.ageClasses.map((x) => x.id)) {
    const pc = state.ageClass ? (c === state.ageClass ? 1 : 0) : ageInfo.p[c] || 0;
    if (!pc || (obs.ageClass && c !== obs.ageClass)) continue;
    const env = envelopeFor(model.usage, c, model), per = A.periodDefaults[c] || {}, mp = modernProb(c);
    for (let mask = 0; mask < 16; mask++) {
      const modern = {};
      let w = pc;
      comps.forEach(([cn], j) => { modern[cn] = !!(mask & (1 << j)); });
      for (const [cn, k] of comps) {
        const st = state.refurb?.[cn] || 'unknown', pm = st === 'yes' ? 1 : st === 'no' ? 0 : mp[cn];
        w *= modern[cn] ? pm : 1 - pm;
        if (obs.refurb && modern[cn] !== !!obs.refurb[cn]) w = 0;
        if (w && has(k)) { const u0 = modern[cn] ? modernU(env[k], cn) : env[k]; w *= lnN(obs.p[k], Math.log(u0), modern[cn] ? 0.30 : PV?.sigmaU ? PV.sigmaU(c) : 0.22); }
      }
      if (w && has('g_window')) {
        const x = obs.p.g_window, g0 = env.g_window ?? 0.75;
        if (modern.windows) w *= unif(x, 0.5, 0.65);
        else if (g0 + 0.04 > 0.85 && x >= 0.85 - 1e-9) w *= (g0 + 0.04 - 0.85) / 0.08;   // the cap at 0.85 holds a mass
        else w *= unif(x, g0 - 0.04, Math.min(0.85, g0 + 0.04));
      }
      if (w && has('n50')) w *= lnN(obs.p.n50, Math.log((per.n50 ?? 5) * (modern.windows ? 0.75 : 1)), Math.log(per.n50_gsd || 1.45));
      if (w && has('dU_tb')) {
        const d = per.dU_tb ?? 0.1, x = obs.p.dU_tb, tb = PV?.dUtb?.(c);
        w *= tb ? unif(x, tb[0], tb[1]) : x <= 0.02 + 1e-9 ? Math.max(0, (0.02 - (d - 0.04)) / 0.08) : unif(x, d - 0.04, d + 0.04);   // floor at 0.02
      }
      if (w > 0) out.push({ cls: c, modern, w });
    }
  }
  const s = out.reduce((a, b) => a + b.w, 0);
  for (const o of out) o.w /= s || 1;
  return out;
}

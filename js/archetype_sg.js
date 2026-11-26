// Singapore: building type, construction era, storeys and every physics input with value, P10–P90, source and tier,
// plus the prior sampler for the ranges. Counterpart of js/archetype.js for ?city=sg (docs/singapore-contract.md §4);
// the numbers come from data/archetypes_sg.json (its meta.schemaNotes) and data/archetypes_sg_sources.md.
//
// Interface as in archetype.js: loadArchetypes(url), agePrior(…) (here the era prior), assign(model, eraInfo, state)
// → { params, cls, prof, … }, makePrior(model, eraInfo, state, assigned) → draw(r) → { p, ageClass }, profileFor(model),
// rng, PARAM_META, TYPE_CN, UNCERTAIN; plus classify, storeys, refArea and bcaInputs for the Singapore pipeline
// (js/model_sg.js). Every params entry is { value, unit, source, tier, note, p10, p90, dist }.
//
// Rules (stated; shown in the Inputs & sources tab):
// - Type. 1. HDB Property Information (x.hdb, observed): residential block → hdb; multi-storey car park or precinct
//   pavilion → not air-conditioned, not modelled; a non-residential block in the BCA listing → its BCA type; commercial
//   block → retail; market or hawker centre, miscellaneous → other. 2. BCA listing (x.bca, observed): the BCA building type (office, hotel, retail, mixed development, hospital,
//   clinic, nursing home, university, community and civic buildings). 3. OSM building tag, where specific (house,
//   terrace, apartments, office, retail, hotel, school, hospital, industrial, temple, …). 4. URA Master Plan 2019 land use
//   for building=yes (RESIDENTIAL: landed if the plot code is LND or the block is low (≤ 4 storeys and < 400 m²), else
//   condominium; COMMERCIAL: office from 8 storeys, else retail; HOTEL; WHITE → mixed; BUSINESS PARK → office;
//   BUSINESS 1/2 → industrial; EDUCATIONAL INSTITUTION; HEALTH & MEDICAL CARE; the rest → other). 5. other.
//   Roofs, car parks, sheds, shelters, tanks and building=yes under 25 m² without an address are not air-conditioned.
//   Not private dwellings (2026-11-26): tourism=hotel, hostel, apartment (serviced apartments) or guest_house → hotel;
//   building=dormitory, and residential tags on land zoned for institutions, business, ports, utilities and the like
//   (NONHOUSING_LU), → other.
// - Era. HDB completion year, BCA TOP/CSC year or OSM start_date (observed); else a prior over the eras of the type in
//   proportion to the years each era covers from 1960 to 2025 (assumed: construction spread evenly over time).
// - Storeys and height. HDB: max floor level (observed); the first storey (void deck or shops, 3.6 m, DENG2022 via the
//   table) is outside the flats and the envelope; the flats above take the era's floor height. Otherwise: OSM
//   building:part levels (towers on a podium: their floor area spread over the outline), OSM building:levels and height
//   (observed); GlobalBuildingAtlas LoD1 height below 30 m (estimate, its variance gives the range); GBA from 30 m is a
//   lower bound only (it saturates in Singapore, docs/sg-data-report.md), combined with the type rule; else the type rule
//   (assumed storeys, wide range). Condominiums and landed houses instead take the storeys of the tagged OSM outlines of
//   their type in the same GBA height bin (LEVELS_PRIOR: median and P10–P90), GBA itself being uninformative for them.
// - Reference area (the table's areaBasis). HDB: Σ units / n × flat area by flat type and lease decade (HDB resale
//   medians), checked against 0.75 × footprint × storeys; outside 0.5–2× the geometry is used. Non-residential: BCA GFA
//   (shared by gross floor area when one listing covers several outlines), else refAreaFactor × footprint × storeys.
// - BCA attributes of a listed building enter as observed inputs: AC floor share → coolFrac, AC system → system,
//   plant (+ air side) efficiency → COP = 3.517 / (kW/RT) per the system's scope, GFA, TOP year, occupancy (scales the
//   occupant and plug loads relative to the median occupancy of BCA buildings of the type; rule assumed). BCA EUI is
//   never an input; js/model_sg.js shows it next to the result as measured data.
// Draws are independent across inputs (two-piece normal through P10, value, P90; in log space for positive inputs).
import { L } from './i18n.js';
import { pointInPolygon, signedArea } from './geo.js';

let A = null;
// The table plus the calibration overrides next to it: data/sg/calib_commercial.json (BCA, qa/sg_bca_validation.md) and
// data/sg/calib_residential.json (EMA), each { meta, types: { <type>: { <param>: { value, p10, p90, source, tier } } } }.
// A missing file means no override. opts.calib: a list of URLs instead of the two defaults ([] = the table alone).
export async function loadArchetypes(url = 'data/archetypes_sg.json', opts = {}) {
  if (!A) {
    const base = await (await fetch(url)).json();
    const dir = url.replace(/[^/]*$/, '');
    const files = opts.calib ?? [`${dir}sg/calib_commercial.json`, `${dir}sg/calib_residential.json`];
    const got = await Promise.all(files.map(async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } }));
    A = mergeCalib(base, got.filter(Boolean));
  }
  return A;
}
// Calibrated values go to types.<type>.calib and win over the table's params, eras and variants (typeParams puts them
// last) and over the per-block weighting of HDB blocks; BCA attributes of a listed building and user input still win
// over them. Each keeps the table's value as `prior`. Entries without a tier get 'calibrated'.
export function mergeCalib(base, calibs = []) {
  if (!calibs.length) return base;
  const out = structuredClone(base);
  out.meta.calibration = [];
  for (const C of calibs) {
    if (!C || (!C.types && !C.households)) continue;
    out.meta.calibration.push({ file: C.meta?.file || null, source: C.meta?.source || null, compiled: C.meta?.compiled || null, types: Object.keys(C.types || {}), byDwelling: Object.keys(C.households?.byDwelling || {}) });
    if (C.meta?.sourceEntry && !out.meta.sources.some((s) => s.id === C.meta.sourceEntry.id)) out.meta.sources.push(C.meta.sourceEntry);
    // per-dwelling rows (HDB flat types): households.byDwelling.<key>.<param> → A.households.byDwelling[key][param];
    // assign() weights them per HDB block by flat area as before
    for (const [key, ps] of Object.entries(C.households?.byDwelling || {})) {
      const H = out.households?.byDwelling?.[key];
      if (!H) continue;
      for (const [k, e] of Object.entries(ps)) {
        if (!e || typeof e !== 'object' || !('value' in e)) continue;
        const pr = H[k];
        H[k] = { ...e, tier: e.tier || 'calibrated', prior: pr && typeof pr === 'object' ? { value: pr.value, p10: pr.p10, p90: pr.p90, source: pr.source, tier: pr.tier } : null };
      }
    }
    for (const [t, ps] of Object.entries(C.types || {})) {
      const T = out.types[t];
      if (!T) continue;
      T.calib = T.calib || {};
      if (C.meta?.domain?.gfaMin?.[t] != null) T.calibDomain = { gfaMin: C.meta.domain.gfaMin[t], file: C.meta.file || null };
      for (const [k, e] of Object.entries(ps)) {
        if (!e || typeof e !== 'object' || !('value' in e)) continue;
        const pr = T.params?.[k];
        T.calib[k] = { ...e, tier: e.tier || 'calibrated', prior: pr && typeof pr === 'object' ? { value: pr.value, p10: pr.p10, p90: pr.p90, source: pr.source, tier: pr.tier } : null };
      }
    }
  }
  return out;
}
export function archetypes() { return A; }
export function setArchetypes(a) { A = a; return A; }

// ---------- labels ----------
export const TYPE_CN = {
  hdb: L('组屋', 'HDB block', 'HDB-Wohnblock'), condo: L('私人公寓', 'Condominium', 'Eigentumswohnanlage'), landed: L('有地住宅', 'Landed house', 'Einfamilien- oder Reihenhaus'),
  office: L('办公', 'Office', 'Bürogebäude'), retail: L('商场零售', 'Retail', 'Einzelhandel'), hotel: L('酒店', 'Hotel', 'Hotel'), mixed: L('综合体', 'Mixed development', 'Mischnutzung'),
  education: L('教育', 'Education', 'Bildungsgebäude'), healthcare: L('医疗', 'Healthcare', 'Gesundheitswesen'), industrial: L('工业', 'Industrial', 'Industrie'), other: L('其他', 'Other', 'Sonstige'),
};
const VARIANT_CN = { ihl: L('大学、理工学院', 'university or polytechnic', 'Hochschule'), school: L('中小学', 'school', 'Schule'), hospital: L('医院', 'hospital', 'Krankenhaus'), clinic: L('诊所', 'clinic', 'Poliklinik'), nursingHome: L('养老院', 'nursing home', 'Pflegeheim') };
export const variantLabel = (v) => VARIANT_CN[v] || v || '';
export const SYS_CN = {
  window: L('窗式空调', 'Window or casement units', 'Fenstergeräte'), split: L('分体空调', 'Split units', 'Split-Geräte'), vrf: L('VRF 多联机', 'VRF system', 'VRF-System'),
  unitary: L('单元式（VRF、分体）', 'Unitary (VRF, split units)', 'Einzelgeräte (VRF, Split)'), chw_water: L('水冷冷水机组（系统总效率）', 'Water-cooled chilled-water plant (total system)', 'Wassergekühlte Kältezentrale (Gesamtsystem)'),
  chw_air: L('风冷冷水机组', 'Air-cooled chilled-water plant', 'Luftgekühlte Kältezentrale'), package_wc: L('水冷柜式机组', 'Water-cooled package units', 'Wassergekühlte Kompaktgeräte'), dcs: L('区域供冷（楼内电表只计风侧）', 'District cooling (building meter: air side only)', 'Fernkälte (Gebäudezähler: nur Luftseite)'),
};
export const sysLabel = (k) => SYS_CN[k] || A?.systems?.[k]?.label_en || k;
export const RES_TYPES = ['hdb', 'condo', 'landed'];
// rc5 knows the residential mixed mode by these usage codes (js/rc5.js prepare)
export const RC5_USAGE = { hdb: 'ab', condo: 'ab', landed: 'sfh', office: 'office', retail: 'retail', education: 'education', hotel: 'other', mixed: 'other', healthcare: 'other', industrial: 'other', other: 'other' };

export const TIER_LABEL = { observed: L('真实值', 'Observed', 'Erfasst'), published_table: L('查表', 'Published table', 'Tabellenwert'), assumed: L('估算', 'Assumed', 'Annahme'), estimate: L('模型估计', 'Estimate', 'Schätzung'), user: L('用户填写', 'User input', 'Eigene Eingabe'), calibrated: L('实测标定', 'Calibrated', 'Kalibriert') };
export const TIER_CLASS = { observed: 'osm', published_table: 'archetype', assumed: 'default', estimate: 'default', user: 'user', calibrated: 'calibrated' };
export const SOURCE_CN = TIER_LABEL;

const G = { env: L('围护', 'Envelope', 'Gebäudehülle'), air: L('通风与湿度', 'Air and humidity', 'Luft und Feuchte'), use: L('使用', 'Occupancy', 'Nutzung'), el: L('用电', 'Electricity', 'Strom'), sys: L('制冷系统', 'Cooling system', 'Kälteanlage') };
export const PARAM_META = {
  U_wall: { label: L('外墙 U 值', 'External wall U-value', 'Außenwand U-Wert'), unit: 'W/(m²·K)', group: G.env },
  U_roof: { label: L('屋顶 U 值', 'Roof U-value', 'Dach U-Wert'), unit: 'W/(m²·K)', group: G.env },
  U_floor: { label: L('底层楼板 U 值', 'Lowest floor U-value', 'Boden U-Wert'), unit: 'W/(m²·K)', group: G.env },
  U_window: { label: L('外窗 U 值', 'Window U-value', 'Fenster U-Wert'), unit: 'W/(m²·K)', group: G.env },
  g_window: { label: L('玻璃 g 值', 'Glazing g-value', 'g-Wert der Verglasung'), unit: '–', group: G.env },
  frameFrac: { label: L('窗框比例', 'Frame fraction', 'Rahmenanteil'), unit: '–', group: G.env },
  WWR: { label: L('窗墙比', 'Window-to-wall ratio', 'Fensterflächenanteil'), unit: '–', group: G.env },
  dU_tb: { label: L('热桥附加', 'Thermal bridge surcharge', 'Wärmebrückenzuschlag'), unit: 'W/(m²·K)', group: G.env },
  Cm: { label: L('有效热容', 'Effective heat capacity', 'Wirksame Wärmekapazität'), unit: 'J/(m²·K)', group: G.env },
  F_floor: { label: L('底层温度修正', 'Lowest floor temperature factor', 'Temperaturfaktor Boden'), unit: '–', group: G.env },
  F_roof: { label: L('屋顶温度修正', 'Roof temperature factor', 'Temperaturfaktor Dach'), unit: '–', group: G.env },
  shadeCtrl: { label: L('窗帘遮阳透过系数', 'Curtain and blind transmittance', 'Abminderung durch Vorhänge'), unit: '–', group: G.env },
  dT_sky: { label: L('天空温差（室外气温 − 天空温度）', 'Sky temperature depression (air − sky)', 'Himmelstemperaturabsenkung (Luft − Himmel)'), unit: 'K', group: G.env },
  n50: { label: L('气密性 n50', 'Air tightness n50', 'Luftdichtheit n50'), unit: '1/h', group: G.air },
  e_inf: { label: L('渗透换算系数', 'Infiltration per n50', 'Infiltrationsfaktor je n50'), unit: '–', group: G.air },
  n_vent: { label: L('空调时换气', 'Air change with AC on', 'Luftwechsel bei Klimatisierung'), unit: '1/h', group: G.air },
  n_nat: { label: L('开窗换气', 'Air change with windows open', 'Luftwechsel bei offenen Fenstern'), unit: '1/h', group: G.air },
  natCtrl: { label: L('开窗规则', 'Window opening rule', 'Regel zum Fensteröffnen'), unit: '0/1', group: G.air },
  hr_eff: { label: L('热回收效率', 'Heat recovery efficiency', 'Wärmerückgewinnungsgrad'), unit: '–', group: G.air },
  RH_cool: { label: L('空调室内相对湿度', 'Indoor relative humidity with AC', 'Raumluftfeuchte bei Klimatisierung'), unit: '–', group: G.air },
  T_cool: { label: L('空调设定温度', 'Cooling set point', 'Solltemperatur Kühlen'), unit: '°C', group: G.use },
  coolFrac: { label: L('空调面积比例', 'Air-conditioned share of the floor area', 'Klimatisierter Flächenanteil'), unit: '–', group: G.use },
  acStart: { label: L('空调开启（当地时）', 'AC on (local hour)', 'Klimaanlage ein (Ortszeit)'), unit: 'h', group: G.use },
  acEnd: { label: L('空调关闭（当地时）', 'AC off (local hour)', 'Klimaanlage aus (Ortszeit)'), unit: 'h', group: G.use },
  Q_int: { label: L('人员显热', 'Occupant sensible gains', 'Sensible Wärme der Personen'), unit: 'W/m²', group: G.use },
  Q_lat: { label: L('室内潜热', 'Internal latent gains', 'Latente innere Lasten'), unit: 'W/m²', group: G.use },
  hPart: { label: L('隔墙传热', 'Partition conductance', 'Leitwert der Innenwände'), unit: 'W/(m²·K)', group: G.use },
  P_light: { label: L('照明功率', 'Lighting power', 'Beleuchtungsleistung'), unit: 'W/m²', group: G.el },
  P_equip: { label: L('设备与插座功率', 'Equipment and plug loads', 'Geräte- und Steckdosenlasten'), unit: 'W/m²', group: G.el },
  equipBase: { label: L('非使用时设备比例', 'Equipment share outside use', 'Geräteanteil außerhalb der Nutzung'), unit: '–', group: G.el },
  E_other: { label: L('其他用电', 'Other electricity', 'Sonstiger Strom'), unit: 'kWh/(m²·a)', group: G.el },
  COP_cool: { label: L('制冷系统 COP', 'Cooling system COP', 'Leistungszahl der Kälteanlage'), unit: 'W/W', group: G.sys },
  // only in calibrated types (data/sg/calib_*.json): value 1, its P10–P90 is the spread between buildings of the type
  // that the inputs do not explain; it scales the occupant, lighting, equipment and other loads together (model_sg.js)
  useScale: { label: L('使用强度（楼与楼的差异）', 'Use intensity (spread between buildings)', 'Nutzungsintensität (Streuung zwischen Gebäuden)'), unit: '×', group: G.use },
};
// keys rc5 reads from p (the rest of a type's params are profile, geometry or information)
const RC5_KEYS = ['U_wall', 'U_roof', 'U_floor', 'U_window', 'g_window', 'frameFrac', 'dU_tb', 'Cm', 'F_floor', 'F_roof', 'shadeCtrl', 'dT_sky', 'n50', 'e_inf', 'n_vent', 'n_nat', 'natCtrl', 'hr_eff',
  'RH_cool', 'T_cool', 'coolFrac', 'acStart', 'acEnd', 'Q_int', 'Q_lat', 'hPart', 'P_light', 'P_equip', 'equipBase', 'E_other', 'COP_cool', 'useScale'];
export const UNCERTAIN = RC5_KEYS.filter((k) => !['hr_eff', 'natCtrl'].includes(k)).concat(['WWR']);
const FRACTION = new Set(['g_window', 'frameFrac', 'WWR', 'shadeCtrl', 'F_floor', 'F_roof', 'RH_cool', 'coolFrac', 'equipBase', 'hr_eff']);

// ---------- random numbers (the generator of js/archetype.js) ----------
export function rng(seed = 1) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => { let x = 0, y = 0; while (x === 0) x = u(); y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  return { u, n };
}
const Z90 = 1.2816;
// two-piece normal through P10, value, P90 (log space when all are positive): z ~ N(0, 1)
export function twoPiece(v, lo, hi, z) {
  if (lo == null || hi == null || !(hi > lo)) return v;
  const a = Math.min(lo, v), b = Math.max(hi, v);
  if (v > 0 && a > 0) { const m = Math.log(v), s = z < 0 ? m - Math.log(a) : Math.log(b) - m; return Math.exp(m + (z * s) / Z90); }
  return v + (z * (z < 0 ? v - a : b - v)) / Z90;
}
const clampK = (k, x) => (FRACTION.has(k) ? Math.max(0, Math.min(1, x)) : k === 'T_cool' ? x : Math.max(0, x));

// ---------- source references ----------
// ids of meta.sources named in a source string → [{ id, ref, url }]
export function sourceRefs(text) {
  if (!A || !text) return [];
  const out = [];
  for (const s of A.meta.sources) if (new RegExp(`\\b${s.id}\\b`).test(text)) out.push({ id: s.id, ref: s.ref, url: s.url && /^https?:/.test(s.url) ? s.url.split(' ')[0] : null });
  return out;
}

// ---------- type ----------
const UNCOND = new Set(['roof', 'parking', 'garage', 'garages', 'carport', 'shed', 'construction', 'storage_tank', 'service', 'substation', 'transformer_tower', 'hut', 'bridge',
  'grandstand', 'ruins', 'tent', 'toilets', 'shelter', 'farm_auxiliary', 'greenhouse', 'glasshouse', 'silo', 'container', 'bunker', 'water_tower', 'chimney', 'collapsed', 'demolished',
  'stairs', 'staircase', 'bicycle_parking', 'waste_shelter', 'tech_cab', 'pavilion', 'gazebo', 'cowshed', 'stable', 'barn', 'boathouse', 'elevator', 'tower', 'covered_walkway', 'canopy']);
const BCA_TYPE = {
  'Office': ['office'], 'Hotel': ['hotel'], 'Retail': ['retail'], 'Mixed Development': ['mixed'], 'Combined': ['mixed'],
  'Nursing Home': ['healthcare', 'nursingHome'],
  'Hospital or Specialist Clinic': ['healthcare', 'hospital'], 'Specialist Centre (Public)': ['healthcare', 'hospital'], 'Private Hospital (Private)': ['healthcare', 'hospital'],
  'Community Hospital': ['healthcare', 'hospital'], 'General Hospital/ Specialist Centre (Public)': ['healthcare', 'hospital'],
  'Polyclinic or Private Clinic': ['healthcare', 'clinic'], 'Polyclinic': ['healthcare', 'clinic'], 'Private Clinic': ['healthcare', 'clinic'], 'TCM Clinic': ['healthcare', 'clinic'],
  'Univerisity': ['education', 'ihl'], 'Autonomous University': ['education', 'ihl'], 'Polytechnic': ['education', 'ihl'], 'Private College': ['education', 'ihl'], 'ITE': ['education', 'ihl'],
  'Other Educational Institution': ['education', 'ihl'], 'Private School': ['education', 'ihl'],
  'Recreation Club': ['other'], 'Community Institution': ['other'], 'Civic Institution': ['other'], 'Sports Centre': ['other'], 'Cultural Institution': ['other'],
};
const NONHOUSING_LU = new Set(['EDUCATIONAL INSTITUTION', 'CIVIC & COMMUNITY INSTITUTION', 'HEALTH & MEDICAL CARE', 'BUSINESS 1', 'BUSINESS 2', 'BUSINESS 1 - WHITE', 'BUSINESS 2 - WHITE',
  'BUSINESS PARK', 'BUSINESS PARK - WHITE', 'SPECIAL USE', 'PORT / AIRPORT', 'UTILITY', 'PLACE OF WORSHIP', 'SPORTS & RECREATION', 'TRANSPORT FACILITIES', 'CEMETERY', 'AGRICULTURE', 'COMMERCIAL / INSTITUTION']);
const bcaTypeOf = (row) => row && (row.type || row.bebr_type || row.function) || null;
const IHL_NAME = /universit|polytechnic|\bITE\b|institute of|college|campus/i;

const num = (v) => { const m = String(v ?? '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
export const footprintOf = (rec) => {
  const lat0 = (rec.bbox[1] + rec.bbox[3]) / 2, kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const a = (r) => Math.abs(signedArea(r.map(([x, y]) => [x * kx, y * ky])));
  return a(rec.outer) - (rec.holes || []).reduce((t, h) => t + a(h), 0);
};

// a rough storey count for the type rules (before the type is known): OSM levels, parts, GBA, else 1–2
function roughStoreys(rec, parts) {
  const t = rec.tags || {}, lv = num(t['building:levels']);
  let s = lv > 0 ? lv : NaN;
  for (const p of parts || []) { const pl = num(p.tags['building:levels']); if (pl > (s || 0)) s = pl; }
  if (!(s > 0)) { const h = num(t.height); if (h > 0) s = h / 3.3; }
  if (!(s > 0) && rec.x?.gba?.h > 0) s = rec.x.gba.h >= 30 ? Math.max(10, rec.x.gba.h / 3.3) : rec.x.gba.h / 3.3;
  return s > 0 ? Math.max(1, Math.round(s)) : null;
}

function bcaClass(row, out, extra = '') {
  const bt = bcaTypeOf(row), [type, variant] = BCA_TYPE[bt];
  return out(type, 'observed', L(`BCA 建筑能耗名单：${row.name}，类型 ${bt}${extra}`, `BCA building energy listing: ${row.name}, type ${bt}${extra}`, `BCA-Gebäudeenergieliste: ${row.name}, Typ ${bt}${extra}`), { variant: variant || null, bcaType: bt });
}
// → { type, variant, conditioned, tier, src, why } ; ctx: { bcaRow, parts }
export function classify(rec, ctx = {}) {
  const t = rec.tags || {}, x = rec.x || {}, b = t.building || 'yes', fp = footprintOf(rec);
  const hdb = x.hdb, row = ctx.bcaRow;
  const out = (type, tier, src, extra = {}) => ({ type, variant: null, conditioned: true, tier, src, ...extra });
  const none = (why) => ({ type: 'other', conditioned: false, tier: 'observed', src: why, why });
  if (hdb) {
    const blk = `HDB Blk ${hdb.blk} ${hdb.street}`;
    if (hdb.res) return out('hdb', 'observed', L(`HDB 物业信息：${blk}，住宅楼（${hdb.year} 年建成）`, `HDB Property Information: ${blk}, residential block (completed ${hdb.year})`, `HDB Property Information: ${blk}, Wohnblock (fertiggestellt ${hdb.year})`));
    if (hdb.car) return none(L(`HDB 物业信息：${blk} 是多层停车楼，开敞、不开空调`, `HDB Property Information: ${blk} is a multi-storey car park, open and not air-conditioned`, `HDB Property Information: ${blk} ist ein Parkhaus, offen und nicht klimatisiert`));
    if (hdb.pav) return none(L(`HDB 物业信息：${blk} 是亭子（precinct pavilion），开敞`, `HDB Property Information: ${blk} is a precinct pavilion, an open structure`, `HDB Property Information: ${blk} ist ein offener Pavillon`));
    // a non-residential HDB block in the BCA listing: the BCA building type (the owner's submission) is more specific
    // than HDB's commercial or market flag (Connection ONE, an office; Kitchener Complex, a mixed development)
    if (BCA_TYPE[bcaTypeOf(row)]) return bcaClass(row, out, L(`（HDB 物业信息：${blk}，非住宅）`, ` (HDB Property Information: ${blk}, non-residential)`, ` (HDB Property Information: ${blk}, Nichtwohnen)`));
    if (hdb.com && !hdb.mkt) return out('retail', 'observed', L(`HDB 物业信息：${blk}，商业楼（按零售计）`, `HDB Property Information: ${blk}, commercial block (modelled as retail)`, `HDB Property Information: ${blk}, Gewerbeblock (als Einzelhandel gerechnet)`));
    return out('other', 'observed', L(`HDB 物业信息：${blk}，${hdb.mkt ? '市场或小贩中心' : '其他用途'}（按其他计）`, `HDB Property Information: ${blk}, ${hdb.mkt ? 'market or hawker centre' : 'other use'} (modelled as other)`, `HDB Property Information: ${blk}, ${hdb.mkt ? 'Markt oder Hawker Centre' : 'sonstige Nutzung'} (als Sonstige gerechnet)`));
  }
  if (BCA_TYPE[bcaTypeOf(row)]) return bcaClass(row, out);
  if (t.amenity === 'shelter' || t.amenity === 'parking' || UNCOND.has(b)) return none(L(`OSM ${t.amenity === 'shelter' || t.amenity === 'parking' ? `amenity=${t.amenity}` : `building=${b}`}：没有空调空间`, `OSM ${t.amenity === 'shelter' || t.amenity === 'parking' ? `amenity=${t.amenity}` : `building=${b}`}: no air-conditioned space`, `OSM ${t.amenity === 'shelter' || t.amenity === 'parking' ? `amenity=${t.amenity}` : `building=${b}`}: kein klimatisierter Raum`));
  const st = roughStoreys(rec, ctx.parts), lu = x.lu || null, landedCode = x.gprt === 'LND';
  const rule = (txt) => L(`规则：${txt[0]}`, `Rule: ${txt[1]}`, `Regel: ${txt[2]}`);
  const osmTxt = (type) => L(`OSM building=${b}${t.shop ? `、shop=${t.shop}` : ''}${t.amenity ? `、amenity=${t.amenity}` : ''} → ${TYPE_CN[type]}`, `OSM building=${b}${t.shop ? `, shop=${t.shop}` : ''}${t.amenity ? `, amenity=${t.amenity}` : ''} → ${TYPE_CN[type]}`, `OSM building=${b}${t.shop ? `, shop=${t.shop}` : ''}${t.amenity ? `, amenity=${t.amenity}` : ''} → ${TYPE_CN[type]}`);
  const tagged = (type, variant = null, rc5 = null) => out(type, 'assumed', osmTxt(type), { variant, rc5, rule: 'osm' });
  if (['house', 'detached', 'bungalow'].includes(b)) return tagged('landed', null, 'sfh');
  if (['semidetached_house', 'terrace'].includes(b)) return tagged('landed', null, 'th');
  if (['hospital'].includes(b) || t.amenity === 'hospital') return tagged('healthcare', 'hospital');
  if (['clinic'].includes(b) || ['clinic', 'doctors'].includes(t.amenity)) return tagged('healthcare', 'clinic');
  if (t.social_facility === 'nursing_home' || t.amenity === 'nursing_home') return tagged('healthcare', 'nursingHome');
  if (['university', 'college'].includes(b) || ['university', 'college'].includes(t.amenity)) return tagged('education', 'ihl');
  if (['school', 'kindergarten'].includes(b) || ['school', 'kindergarten', 'childcare'].includes(t.amenity)) return tagged('education', IHL_NAME.test(t.name || '') ? 'ihl' : null);
  // hotels, hostels, serviced apartments and guest houses are let commercially, not private households
  if (b === 'hotel' || ['hotel', 'hostel', 'apartment', 'guest_house'].includes(t.tourism)) return tagged('hotel');
  // workers' and students' dormitories are not private dwellings (no dormitory type in the table: other)
  if (b === 'dormitory') return out('other', 'assumed', L('OSM building=dormitory：员工或学生宿舍，不是私人住户（表里没有宿舍类型，按其他计）', "OSM building=dormitory: a workers' or students' dormitory, not a private household (no dormitory type in the table, modelled as other)", 'OSM building=dormitory: Wohnheim für Beschäftigte oder Studierende, kein Privathaushalt (kein eigener Typ in der Tabelle, als Sonstige gerechnet)'), { rule: 'osm' });
  if (['retail', 'supermarket', 'mall', 'department_store', 'kiosk', 'shop'].includes(b) || t.shop) return tagged('retail');
  if (['office', 'government', 'bank', 'townhall'].includes(b) || t.office) return tagged('office');
  if (b === 'commercial') return out((st || 1) >= 5 ? 'office' : 'retail', 'assumed', rule([`OSM building=commercial，${(st || 1) >= 5 ? '5 层及以上按办公' : '4 层及以下按零售（店屋、低层商铺）'}`, `OSM building=commercial, ${(st || 1) >= 5 ? '5 storeys or more → office' : 'up to 4 storeys → retail (shophouses, low-rise shops)'}`, `OSM building=commercial, ${(st || 1) >= 5 ? 'ab 5 Geschossen → Büro' : 'bis 4 Geschosse → Einzelhandel (Shophouses, niedrige Läden)'}`]), { rule: 'osm' });
  if (['industrial', 'warehouse', 'manufacture', 'factory', 'data_center', 'hangar'].includes(b)) return tagged('industrial');
  // a residential tag on land zoned for institutions, business, ports or utilities: staff quarters, student halls,
  // workers' housing, not private dwellings (URA Master Plan 2019 zoning; private housing sits on residential,
  // commercial & residential, residential / institution and white zones)
  if (['apartments', 'residential', 'flats'].includes(b) && NONHOUSING_LU.has(lu)) return out('other', 'assumed', L(`规则：OSM building=${b}，但 URA 2019 用地 ${lu}：宿舍或机构住房，不是私人住户（按其他计）`, `Rule: OSM building=${b} on URA 2019 land use ${lu}: institutional or workers' housing, not a private household (modelled as other)`, `Regel: OSM building=${b} auf URA-2019-Flächennutzung ${lu}: Wohnheim oder Dienstwohnungen, kein Privathaushalt (als Sonstige gerechnet)`), { rule: 'lu' });
  if (['apartments', 'residential', 'flats'].includes(b) || (b === 'yes' && /^RESIDENTIAL( WITH COMMERCIAL AT 1ST STOREY)?$/.test(lu || ''))) {
    const low = (st || 1) <= 4 && (fp < 400 || landedCode);
    const type = low ? 'landed' : 'condo';
    const why = b === 'yes' ? L(`URA 2019 用地 ${lu}`, `URA 2019 land use ${lu}`, `URA-2019-Flächennutzung ${lu}`) : `OSM building=${b}`;
    return out(type, 'assumed', L(`规则：${why}；${low ? `${st || 1} 层、${landedCode ? '地块代码 LND（有地住宅区）' : '占地 < 400 m²'} → 有地住宅` : `${st || '?'} 层 → 私人公寓（没有 HDB 匹配）`}`,
      `Rule: ${why}; ${low ? `${st || 1} storeys, ${landedCode ? 'plot code LND (landed housing area)' : 'footprint < 400 m²'} → landed house` : `${st || '?'} storeys → condominium (no HDB match)`}`,
      `Regel: ${why}; ${low ? `${st || 1} Geschosse, ${landedCode ? 'Plancode LND (Gebiet für Einfamilienhäuser)' : 'Grundfläche < 400 m²'} → Einfamilien- oder Reihenhaus` : `${st || '?'} Geschosse → Eigentumswohnanlage (kein HDB-Treffer)`}`), { rule: 'lu', rc5: low ? 'th' : null });
  }
  if (['church', 'chapel', 'cathedral', 'mosque', 'synagogue', 'temple', 'religious', 'shrine', 'civic', 'public', 'train_station', 'transportation', 'sports_centre', 'stadium', 'sports_hall', 'museum', 'fire_station', 'police', 'library'].includes(b)) return tagged('other');
  if (b !== 'yes') return tagged('other');
  if (fp < 25 && !t['addr:housenumber'] && !t.name) return none(L('building=yes，占地 < 25 m²，没有门牌和名字：附属小屋，不开空调', 'building=yes, footprint < 25 m², no address or name: a small outbuilding, not air-conditioned', 'building=yes, Grundfläche < 25 m², ohne Adresse und Namen: kleines Nebengebäude, nicht klimatisiert'));
  const LU = {
    'COMMERCIAL & RESIDENTIAL': (st || 1) >= 5 ? 'condo' : 'retail', 'COMMERCIAL': (st || 1) >= 8 ? 'office' : 'retail', 'HOTEL': 'hotel', 'WHITE': 'mixed',
    'BUSINESS PARK': 'office', 'BUSINESS PARK - WHITE': 'office', 'BUSINESS 1': 'industrial', 'BUSINESS 2': 'industrial', 'BUSINESS 1 - WHITE': 'industrial', 'BUSINESS 2 - WHITE': 'industrial',
    'EDUCATIONAL INSTITUTION': 'education', 'HEALTH & MEDICAL CARE': 'healthcare',
  };
  const type = LU[lu] || 'other';
  return out(type, 'assumed', L(`规则：building=yes，URA 2019 用地 ${lu || '无'}${['COMMERCIAL', 'COMMERCIAL & RESIDENTIAL'].includes(lu) ? `，约 ${st || 1} 层` : ''} → ${TYPE_CN[type]}`,
    `Rule: building=yes, URA 2019 land use ${lu || 'none'}${['COMMERCIAL', 'COMMERCIAL & RESIDENTIAL'].includes(lu) ? `, about ${st || 1} storeys` : ''} → ${TYPE_CN[type]}`,
    `Regel: building=yes, URA-2019-Flächennutzung ${lu || 'keine'}${['COMMERCIAL', 'COMMERCIAL & RESIDENTIAL'].includes(lu) ? `, etwa ${st || 1} Geschosse` : ''} → ${TYPE_CN[type]}`),
  { rule: 'lu', variant: type === 'education' && IHL_NAME.test(t.name || '') ? 'ihl' : null });
}

// ---------- era ----------
export function erasOf(type) {
  if (type === 'hdb') return A.types.hdb.eras;
  if (type === 'condo') return A.types.condo.eras;
  if (type === 'landed') return null;
  return A.nrEras;
}
const eraOfYear = (eras, y) => eras.find((e) => (e.from == null || y >= e.from) && (e.to == null || y <= e.to)) || eras[eras.length - 1];
const eraLabel = (e) => (e.from == null ? L(`${e.to} 年及以前`, `up to ${e.to}`, `bis ${e.to}`) : e.to == null ? L(`${e.from} 年起`, `${e.from} on`, `ab ${e.from}`) : `${e.from}–${e.to}`);
export { eraLabel };
// → { p: {eraId: prob}, src, kind: 'hdb'|'bca'|'osm'|'prior'|'none', year, tier }
export function agePrior(rec, type, bcaRow) {
  const eras = erasOf(type);
  if (!eras) return { p: {}, src: L('这一类型不分年代', 'No eras for this type', 'Keine Baualtersklassen für diesen Typ'), kind: 'none', tier: 'published_table', year: null };
  const one = (y, kind, src) => { const e = eraOfYear(eras, y); return { p: Object.fromEntries(eras.map((x) => [x.id, x.id === e.id ? 1 : 0])), src, kind, tier: 'observed', year: y }; };
  if (type === 'hdb' && rec.x?.hdb?.year) return one(rec.x.hdb.year, 'hdb', L(`HDB 物业信息：${rec.x.hdb.year} 年建成`, `HDB Property Information: completed ${rec.x.hdb.year}`, `HDB Property Information: fertiggestellt ${rec.x.hdb.year}`));
  const top = bcaRow && Number.isFinite(+bcaRow.top_year) && +bcaRow.top_year > 1900 ? Math.round(+bcaRow.top_year) : null;
  if (top) return one(top, 'bca', L(`BCA 名单：TOP/CSC ${top} 年`, `BCA listing: TOP/CSC ${top}`, `BCA-Liste: TOP/CSC ${top}`));
  const y = parseInt(String(rec.tags?.start_date || rec.tags?.['building:year'] || rec.tags?.construction_date || '').match(/\d{4}/)?.[0], 10);
  if (Number.isFinite(y) && y > 1800 && y < 2030) return one(y, 'osm', L(`OSM start_date=${y}`, `OSM start_date=${y}`, `OSM start_date=${y}`));
  const span = (e) => Math.max(1, Math.min(2025, e.to ?? 2025) - Math.max(1960, e.from ?? 1960) + 1);
  const tot = eras.reduce((s, e) => s + span(e), 0);
  return { p: Object.fromEntries(eras.map((e) => [e.id, span(e) / tot])), src: L('没有年代信息：各年代按 1960–2025 年里所占年数加权（假设）', 'No year known: eras weighted by the years each covers from 1960 to 2025 (assumed)', 'Kein Baujahr bekannt: Klassen nach ihren Jahren zwischen 1960 und 2025 gewichtet (Annahme)'), kind: 'prior', tier: 'assumed', year: null };
}
const mostLikely = (p) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

// ---------- storeys and height ----------
// building:part records whose centre lies in the outline (towers on a podium)
export function partsOf(rec, all) {
  const out = [];
  for (const n of all || []) {
    if (!n.part || n.id === rec.id) continue;
    const c = [(n.bbox[0] + n.bbox[2]) / 2, (n.bbox[1] + n.bbox[3]) / 2];
    if (c[0] < rec.bbox[0] || c[0] > rec.bbox[2] || c[1] < rec.bbox[1] || c[1] > rec.bbox[3]) continue;
    if (pointInPolygon(c, rec.outer, rec.holes)) out.push(n);
  }
  return out;
}
const RULE_STOREYS = { landed: [2, 1, 3], condo: [15, 6, 30], office: [12, 4, 35], retail: [4, 2, 8], hotel: [15, 5, 35], mixed: [12, 4, 35], education: [4, 2, 8], healthcare: [6, 2, 15], industrial: [3, 1, 8], other: [2, 1, 5], hdb: [12, 4, 25] };
export function floorHeightOf(type, eraId) {
  if (type === 'hdb') { const e = A.types.hdb.eras.find((x) => x.id === eraId) || A.types.hdb.eras[A.types.hdb.eras.length - 1]; return e.params.floorHeight; }
  return A.types[type].params.floorHeight;
}
const VOID_DECK = 3.6;   // m, HDB first storey (table: hdb_1960_1979 floorHeight note, DENG2022)
// Storey prior of condominiums and landed houses without OSM levels, parts or height: OSM building:levels of the tagged
// outlines that the rules above class as the same type (OSM snapshot of 2026-11-24), in the GlobalBuildingAtlas height
// bin of the outline where that bin holds at least 30 tagged outlines, else over all tagged ones. Entries [GBA from m,
// to m, n, P10, median, P90] (tools/sg/res_geometry_sg.mjs --prior, 2026-11-26). GBA alone is not used: for tagged
// landed houses it is 7.4, 8.6 and 8.6 m (medians) at 1, 2 and 3 levels, and for tagged condos it saturates (10–14
// levels: 18.3 m, 15–19: 25.9 m), so GBA ÷ storey height gave 3 storeys to most two-storey houses and too few to towers.
const LEVELS_PRIOR = {
  condo: { all: [5621, 4, 12, 23], byGba: [[0, 8, 817, 2, 9, 20], [8, 12, 609, 2, 5, 18], [12, 16, 738, 4, 5, 16], [16, 20, 569, 5, 8, 17], [20, 25, 388, 5, 12, 20],
    [25, 30, 351, 9, 15, 21], [30, 40, 461, 11, 16, 24], [40, 60, 353, 15, 20, 36], [60, null, 106, 20, 27, 38]] },
  landed: { all: [9006, 2, 2, 3], byGba: [[0, 8, 3118, 2, 2, 3], [8, 12, 3718, 2, 2, 3], [12, 16, 673, 2, 3, 4], [16, 20, 80, 1, 3, 4], [20, 25, 31, 1, 3, 4]] },
};
// → { floors, height, voidDeck, src: {floors, height}, tier: {floors, height}, h10, h90 (height P10/P90 in m) }
export function storeys(rec, type, eraId, parts) {
  const t = rec.tags || {}, x = rec.x || {}, fhP = floorHeightOf(type, eraId), fh = fhP.value;
  const fhTxt = L(`层高 ${fh} m（${fhP.source}）`, `storey height ${fh} m (${fhP.source})`, `Geschosshöhe ${fh} m (${fhP.source})`);
  const res = (floors, height, srcF, srcH, tF, tH, h10, h90, voidDeck = 0) => ({ floors: Math.max(1, Math.round(floors)), height, voidDeck, src: { floors: srcF, height: srcH }, tier: { floors: tF, height: tH }, h10: h10 ?? height, h90: h90 ?? height, fh });
  if (type === 'hdb' && x.hdb?.levels > 0) {
    // towers drawn as building:part on a podium: their floor area spread over the outline (js/model_sg.js hdbFromParts)
    const lv = x.hdb.eqLevels ? Math.round(x.hdb.eqLevels) : x.hdb.levels, f = lv >= 2 ? lv - 1 : 1, v = lv >= 2 ? VOID_DECK : 0, h = v + f * fh;
    const partsTxt = x.hdb.fromParts ? L(`（${x.hdb.fromParts} 个 building:part 上的组屋 ${x.hdb.blk}，最高 ${x.hdb.levels} 层，楼面摊到整个轮廓）`, ` (HDB blocks ${x.hdb.blk} on ${x.hdb.fromParts} building:part records, up to ${x.hdb.levels} levels, floor area spread over the outline)`, ` (HDB-Blöcke ${x.hdb.blk} auf ${x.hdb.fromParts} building:part-Einträgen, bis ${x.hdb.levels} Geschosse, Geschossfläche über den Umriss verteilt)`) : '';
    return res(f, +h.toFixed(1), L(`HDB 物业信息：最高 ${lv} 层；首层（架空层或商铺）不算在住户内，住户 ${f} 层${partsTxt}`, `HDB Property Information: max floor level ${lv}; the first storey (void deck or shops) is outside the flats, ${f} storeys of flats${partsTxt}`, `HDB Property Information: oberstes Geschoss ${lv}; das Erdgeschoss (Void Deck oder Läden) liegt außerhalb der Wohnungen, ${f} Wohngeschosse${partsTxt}`),
      L(`首层 ${VOID_DECK} m + ${f} × ${fhTxt}`, `first storey ${VOID_DECK} m + ${f} × ${fhTxt}`, `Erdgeschoss ${VOID_DECK} m + ${f} × ${fhTxt}`), 'observed', 'estimate', h - f * (fh - fhP.p10), h + f * (fhP.p90 - fh), v);
  }
  const fp = footprintOf(rec), lv = num(t['building:levels']), hOsm = num(t.height);
  // towers on a podium: the floor area of the parts spread over the outline (equivalent storeys)
  // OSM counts a part's building:levels from the ground; building:min_level (or min_height) are the levels it skips, so a
  // part's own floors are levels − min_level, and the outline's own levels fill what no part covers from the ground up
  const pts = (parts || []).map((p) => {
    const pl = num(p.tags['building:levels']), ph = num(p.tags.height), ml = num(p.tags['building:min_level']), mh = num(p.tags.min_height);
    const top = pl > 0 ? pl : ph > 0 ? ph / fh : NaN, min = ml > 0 ? ml : mh > 0 ? mh / fh : 0;
    return { fp: footprintOf(p), lv: top, own: Math.max(0, top - min), min, h: ph };
  }).filter((p) => p.lv > 0 && p.fp > 0);
  if (pts.length && fp > 0) {
    const base = lv > 0 ? lv : 1, ground = Math.min(fp, pts.filter((p) => p.min === 0).reduce((s, p) => s + p.fp, 0));
    const gfa = (fp - ground) * base + pts.reduce((s, p) => s + p.fp * p.own, 0), eq = gfa / fp;
    if (eq > base * 1.1) {
      const top = Math.max(...pts.map((p) => (p.h > 0 ? p.h : p.lv * fh)));
      return res(eq, +(Math.round(eq) * fh).toFixed(1), L(`OSM building:part ×${pts.length}（最高约 ${Math.round(Math.max(...pts.map((p) => p.lv)))} 层）：塔楼楼面摊到整个轮廓，相当 ${eq.toFixed(1)} 层`, `OSM building:part ×${pts.length} (up to about ${Math.round(Math.max(...pts.map((p) => p.lv)))} storeys): the floor area of the tower parts spread over the outline, ${eq.toFixed(1)} storeys equivalent`, `OSM building:part ×${pts.length} (bis etwa ${Math.round(Math.max(...pts.map((p) => p.lv)))} Geschosse): die Geschossfläche der Turmteile über den Umriss verteilt, ${eq.toFixed(1)} Geschosse gleichwertig`),
        L(`等效层数 × ${fhTxt}（实际塔顶约 ${Math.round(top)} m）`, `equivalent storeys × ${fhTxt} (tower top about ${Math.round(top)} m)`, `gleichwertige Geschosse × ${fhTxt} (Turmspitze etwa ${Math.round(top)} m)`), 'observed', 'estimate');
    }
  }
  if (lv > 0) {
    return res(lv, hOsm > 0 ? hOsm : +(Math.round(lv) * fh).toFixed(1), 'OSM building:levels', hOsm > 0 ? 'OSM height' : L(`层数 × ${fhTxt}`, `storeys × ${fhTxt}`, `Geschosse × ${fhTxt}`), 'observed', hOsm > 0 ? 'observed' : 'estimate',
      hOsm > 0 ? hOsm : Math.round(lv) * fhP.p10, hOsm > 0 ? hOsm : Math.round(lv) * fhP.p90);
  }
  if (hOsm > 0) return res(hOsm / fh, hOsm, L(`OSM height ÷ ${fhTxt}`, `OSM height ÷ ${fhTxt}`, `OSM height ÷ ${fhTxt}`), 'OSM height', 'estimate', 'observed');
  if (LEVELS_PRIOR[type]) {
    const P = LEVELS_PRIOR[type], g = x.gba?.h > 0 ? x.gba.h : null;
    const bin = g != null ? P.byGba.find(([a, b, n]) => g >= a && (b == null || g < b) && n >= 30) : null;
    const [n, p10, med, p90] = bin ? bin.slice(2) : P.all;
    const where = bin ? L(`GBA 高度 ${g} m 所在区间 ${bin[0]}–${bin[1] ?? '…'} m 内`, `in the GBA height bin ${bin[0]}–${bin[1] ?? '…'} m of this outline (${g} m)`, `in der GBA-Höhenklasse ${bin[0]}–${bin[1] ?? '…'} m dieses Umrisses (${g} m)`) : L('（全部）', '(all)', '(alle)');
    return res(med, +(med * fh).toFixed(1), L(`先验：有 OSM 层数的同类楼 ${where}的层数中位数 ${med}（P10–P90 ${p10}–${p90}，n ${n}）`, `prior: median OSM building:levels of tagged ${TYPE_CN[type]} outlines ${where}: ${med} (P10–P90 ${p10}–${p90}, n ${n})`, `Prior: Median der OSM building:levels getaggter Umrisse dieses Typs ${where}: ${med} (P10–P90 ${p10}–${p90}, n ${n})`),
      L(`层数 × ${fhTxt}`, `storeys × ${fhTxt}`, `Geschosse × ${fhTxt}`), bin ? 'estimate' : 'assumed', bin ? 'estimate' : 'assumed', p10 * fh, p90 * fh);
  }
  const R = RULE_STOREYS[type] || RULE_STOREYS.other;
  const gba = x.gba?.h > 0 ? x.gba : null, ruleTxt = L(`类型规则：${TYPE_CN[type]}约 ${R[0]} 层（${R[1]}–${R[2]}，假设）`, `type rule: ${TYPE_CN[type]} about ${R[0]} storeys (${R[1]}–${R[2]}, assumed)`, `Typregel: ${TYPE_CN[type]} etwa ${R[0]} Geschosse (${R[1]}–${R[2]}, Annahme)`);
  if (gba && gba.h < 30) {
    const sd = Math.max(0.15 * gba.h, Math.sqrt(Math.max(0, gba.var || 0)));
    return res(gba.h / fh, +gba.h.toFixed(1), L(`GBA 高度 ÷ ${fhTxt}`, `GBA height ÷ ${fhTxt}`, `GBA-Höhe ÷ ${fhTxt}`), L(`GlobalBuildingAtlas LoD1：${gba.h} m（方差 ${gba.var} m²）`, `GlobalBuildingAtlas LoD1: ${gba.h} m (variance ${gba.var} m²)`, `GlobalBuildingAtlas LoD1: ${gba.h} m (Varianz ${gba.var} m²)`),
      'estimate', 'estimate', Math.max(2.5, gba.h - Z90 * sd), gba.h + Z90 * sd);
  }
  if (gba) {
    const f = Math.max(R[0], Math.round(gba.h / fh)), h = f * fh;
    return res(f, +h.toFixed(1), L(`GBA ${gba.h} m 只作下限（30 m 以上饱和）；${ruleTxt}`, `GBA ${gba.h} m taken as a lower bound only (saturates above 30 m); ${ruleTxt}`, `GBA ${gba.h} m nur als Untergrenze (über 30 m gesättigt); ${ruleTxt}`), L(`层数 × ${fhTxt}`, `storeys × ${fhTxt}`, `Geschosse × ${fhTxt}`), 'estimate', 'estimate', gba.h, Math.max(2.5 * gba.h, R[2] * fh));
  }
  return res(R[0], +(R[0] * fh).toFixed(1), ruleTxt, L(`层数 × ${fhTxt}`, `storeys × ${fhTxt}`, `Geschosse × ${fhTxt}`), 'assumed', 'assumed', R[1] * fh, R[2] * fh);
}
// eaves height of a neighbour for shading and party walls (no BCA, no type: quick rules)
export function neighbourHeight(n) {
  const t = n.tags || {}, x = n.x || {};
  if (x.hdb?.levels > 0) return VOID_DECK + Math.max(0, x.hdb.levels - 1) * 2.8;
  const h = num(t.height); if (h > 0) return h;
  const lv = num(t['building:levels']); if (lv > 0) return lv * 3.2;
  if (x.gba?.h > 0) return x.gba.h;
  return null;
}

// ---------- reference area ----------
const DECADE = (y) => (y ? `${Math.floor(y / 10) * 10}s` : null);
// flat area by HDB flat type and lease decade (HDB resale medians), else the household rows
function flatArea(kind, year) {
  const T = A.types.hdb.flatAreaByLeaseDecade, H = A.households.byDwelling, d = DECADE(year);
  const pickDec = (row) => { if (!row) return null; if (row[d] != null) return row[d]; const ks = Object.keys(row).filter((k) => /^\d{4}s$/.test(k)).sort((a, b) => Math.abs(+a.slice(0, 4) - (year || 2000)) - Math.abs(+b.slice(0, 4) - (year || 2000))); return ks.length ? row[ks[0]] : null; };
  switch (kind) {
    case 'r1': return H.hdb_1r2r.floorArea.p10;   // 1-room, HDB_RESALE 31 m² (n 89), the row's P10
    case 'r2': case 'st': return pickDec(T['2-room']) ?? H.hdb_1r2r.floorArea.value;
    case 'rent': return H.hdb_1r2r.floorArea.value;
    case 'r3': return pickDec(T['3-room']) ?? H.hdb_3r.floorArea.value;
    case 'r4': return pickDec(T['4-room']) ?? H.hdb_4r.floorArea.value;
    case 'r5': case 'mg': return pickDec(T['5-room']) ?? H.hdb_5r_ex.floorArea.value;
    case 'ex': return pickDec(T.executive) ?? H.hdb_5r_ex.floorArea.value;
    default: return null;
  }
}
const ROW_OF = { r1: 'hdb_1r2r', r2: 'hdb_1r2r', st: 'hdb_1r2r', rent: 'hdb_1r2r', r3: 'hdb_3r', r4: 'hdb_4r', r5: 'hdb_5r_ex', ex: 'hdb_5r_ex', mg: 'hdb_5r_ex' };
// HDB block: Σ units / n × flat area, and the household rows weighted by that area
export function hdbFlats(hdb) {
  const n = hdb.n > 1 ? hdb.n : 1, rows = {}, parts = [];
  let area = 0, units = 0;
  for (const [k, v] of Object.entries(hdb.units || {})) {
    if (!(v > 0) || !ROW_OF[k]) continue;
    const a = flatArea(k, hdb.year), u = v / n;
    area += u * a; units += u;
    rows[ROW_OF[k]] = (rows[ROW_OF[k]] || 0) + u * a;
    parts.push(`${v}${n > 1 ? `/${n}` : ''} × ${k} ${a} m²`);
  }
  return { area, units, n, rows, text: parts.join(' + ') };
}

// ---------- BCA attributes ----------
const SYS_KEY = (s) => (s ? A.meta.systemKeyMap[s] || (/district/i.test(s) ? 'dcs' : /package/i.test(s) ? 'package_wc' : /air cooled/i.test(s) ? 'chw_air' : /water cooled/i.test(s) ? 'chw_water' : /unitary|vrf|split/i.test(s) ? 'unitary' : 'other') : null);
const okEff = (v, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? +v : null);
let OCC_MED = null;
function occMedian(bcaType, rows) {
  if (!OCC_MED && rows) {
    const g = {};
    for (const r of rows) if (r && r.occupancy > 0 && r.type) (g[r.type] = g[r.type] || []).push(r.occupancy);   // null: a row left out of the public release
    OCC_MED = Object.fromEntries(Object.entries(g).filter(([, a]) => a.length >= 20).map(([k, a]) => [k, a.sort((x, y) => x - y)[Math.floor(a.length / 2)]]));
  }
  return OCC_MED?.[bcaType] ?? null;
}
// the inputs a BCA row gives (no EUI): { coolFrac, systemKey, cop, gfa, occScale, ... } each with source text
export function bcaInputs(row, rows) {
  if (!row) return null;
  const nm = `BCA: ${row.name}`, o = { row };
  const ac = row.ac_share > 0 && row.ac_share <= 1 ? row.ac_share : row.ac_area > 0 && row.gfa > 0 ? Math.min(1, row.ac_area / row.gfa) : null;
  if (ac) o.coolFrac = { value: +ac.toFixed(3), src: L(`${nm}，空调面积占 GFA ${Math.round(ac * 100)}%`, `${nm}, AC floor area ${Math.round(ac * 100)}% of GFA`, `${nm}, klimatisierte Fläche ${Math.round(ac * 100)} % der BGF`) };
  const key = SYS_KEY(row.ac_system);
  if (key && A.systems[key]) o.system = { key, src: L(`${nm}，空调系统：${row.ac_system}`, `${nm}, AC system: ${row.ac_system}`, `${nm}, Klimasystem: ${row.ac_system}`) };
  else if (key) o.systemNote = row.ac_system;
  const chw = okEff(row.chw_eff, 0.3, 2.0) ?? okEff(row.plant_eff, 0.3, 2.0), air = okEff(row.air_eff, 0.03, 1.0);
  const sk = o.system?.key, sy = sk ? A.systems[sk] : null;
  if (sk === 'dcs' && air) o.cop = { value: 3.517 / air, kwrt: air, src: L(`${nm}，风侧效率 ${air} kW/RT（区域供冷：楼内电表只计风侧）→ COP = 3.517 ÷ ${air}`, `${nm}, air-side efficiency ${air} kW/RT (district cooling: the building meter has the air side only) → COP = 3.517 ÷ ${air}`, `${nm}, luftseitige Effizienz ${air} kW/RT (Fernkälte: im Gebäudezähler nur die Luftseite) → COP = 3,517 ÷ ${air}`), tier: 'observed' };
  else if ((sk === 'chw_water' || sk === 'chw_air') && chw) {
    const airV = air ?? sy.airside_kWperRT?.value ?? A.systems.chw_water.airside_kWperRT.value, airR = air ? null : (sy.airside_kWperRT || A.systems.chw_water.airside_kWperRT);
    const tse = chw + airV;
    o.cop = { value: 3.517 / tse, kwrt: tse, airTable: airR, chw, src: L(`${nm}，冷站 ${chw} kW/RT + 风侧 ${airV} kW/RT${air ? '' : '（查表中位数，BCA_BEBRDATA）'} = ${tse.toFixed(3)} kW/RT（系统总效率）→ COP = 3.517 ÷ ${tse.toFixed(3)}`,
      `${nm}, plant ${chw} kW/RT + air side ${airV} kW/RT${air ? '' : ' (table median, BCA_BEBRDATA)'} = ${tse.toFixed(3)} kW/RT (total system) → COP = 3.517 ÷ ${tse.toFixed(3)}`,
      `${nm}, Kältezentrale ${chw} kW/RT + Luftseite ${airV} kW/RT${air ? '' : ' (Tabellenmedian, BCA_BEBRDATA)'} = ${tse.toFixed(3)} kW/RT (Gesamtsystem) → COP = 3,517 ÷ ${tse.toFixed(3)}`), tier: air ? 'observed' : 'observed+table' };
  } else if (sk && !['dcs', 'chw_water', 'chw_air'].includes(sk) && chw) o.cop = { value: 3.517 / (chw + (air || 0)), kwrt: chw + (air || 0), src: L(`${nm}，系统效率 ${chw + (air || 0)} kW/RT（整机）→ COP = 3.517 ÷ ${chw + (air || 0)}`, `${nm}, system efficiency ${chw + (air || 0)} kW/RT (whole unit) → COP = 3.517 ÷ ${chw + (air || 0)}`, `${nm}, Systemeffizienz ${chw + (air || 0)} kW/RT (ganzes Gerät) → COP = 3,517 ÷ ${chw + (air || 0)}`), tier: 'observed' };
  else if (sk === 'chw_water' && row.chiller_year > 1980 && sy.plant_byChillerYear) {
    const y = row.chiller_year, bins = sy.plant_byChillerYear, k = y < 2000 ? '<2000' : y < 2010 ? '2000-2009' : y < 2015 ? '2010-2014' : y < 2020 ? '2015-2019' : '2020+';
    const plant = bins[k][1], airV = sy.airside_kWperRT.value, tse = plant + airV;
    o.cop = { value: 3.517 / tse, kwrt: tse, airTable: sy.airside_kWperRT, chw: plant, src: L(`${nm}：最新冷机 ${y} 年 → 同期冷站中位数 ${plant} kW/RT + 风侧 ${airV} kW/RT（BCA_BEBRDATA）→ COP = 3.517 ÷ ${tse.toFixed(3)}`, `${nm}: newest chiller ${y} → median plant of that period ${plant} kW/RT + air side ${airV} kW/RT (BCA_BEBRDATA) → COP = 3.517 ÷ ${tse.toFixed(3)}`, `${nm}: neueste Kältemaschine ${y} → Median der Kältezentralen dieser Zeit ${plant} kW/RT + Luftseite ${airV} kW/RT (BCA_BEBRDATA) → COP = 3,517 ÷ ${tse.toFixed(3)}`), tier: 'published_table' };
  }
  if (row.gfa > 0) o.gfa = { value: row.gfa, src: L(`${nm}，GFA ${Math.round(row.gfa).toLocaleString('en-GB')} m²`, `${nm}, GFA ${Math.round(row.gfa).toLocaleString('en-GB')} m²`, `${nm}, BGF ${Math.round(row.gfa).toLocaleString('en-GB')} m²`), osmAll: row.osm_all || (row.osm ? [row.osm] : []) };
  const med = row.type ? occMedian(row.type, rows) : null;
  if (row.occupancy > 0 && med) o.occ = { value: row.occupancy, med, scale: Math.max(0.3, Math.min(1.2, row.occupancy / med)), src: L(`${nm}，入住率 ${Math.round(row.occupancy * 100)}%（同类 BCA 中位数 ${Math.round(med * 100)}%）`, `${nm}, occupancy ${Math.round(row.occupancy * 100)}% (BCA median of the type ${Math.round(med * 100)}%)`, `${nm}, Belegung ${Math.round(row.occupancy * 100)} % (BCA-Median des Typs ${Math.round(med * 100)} %)`) };
  return o;
}

// ---------- profile ----------
// the schedule of rc5 (start, end, daysPerWeek, holidays, acStart, acEnd) from the type's params
export function profileFor(m) {
  const P = m.params || {}, v = (k, d) => (P[k] && P[k].value != null ? P[k].value : d);
  const hol = String(P.holidays?.value || 'none');
  const res = RES_TYPES.includes(m.sgType);
  return {
    key: m.sgType, label: TYPE_CN[m.sgType], start: res ? 0 : v('start', 8), end: res ? 24 : v('end', 18), daysPerWeek: res ? 7 : v('daysPerWeek', 5),
    holidays: hol.includes('moe') ? 'school' : null, holidayRule: hol, acStart: v('acStart', null), acEnd: v('acEnd', null), tz: 8,
  };
}

// ---------- assignment ----------
const TYPE_STAT = () => L('同类楼的统计值，不是本楼的实测', 'statistic of buildings of this type, not measured for this building', 'Statistik der Gebäude dieses Typs, nicht für dieses Gebäude gemessen');
const P_ = (e, extra = {}) => (e && typeof e === 'object' && 'value' in e ? { value: e.value, p10: e.p10 ?? e.value, p90: e.p90 ?? e.value, source: e.source || '', tier: e.tier || 'assumed', note: e.note || e.rule || '', ...extra } : null);
function typeParams(type, variant, eraId, noCalib = false) {
  const T = A.types[type], out = {};
  const put = (obj) => { for (const [k, e] of Object.entries(obj || {})) { const p = P_(e); if (p) out[k] = p; else if (e && typeof e === 'object' && 'value' in e) out[k] = { value: e.value, source: e.source, tier: e.tier }; } };
  if (!RES_TYPES.includes(type)) put(A.nrEnvelope[eraId] || A.nrEnvelope[A.nrEras[A.nrEras.length - 1].id]);
  put(T.params);
  if (RES_TYPES.includes(type) && T.eras) put((T.eras.find((e) => e.id === eraId) || T.eras[T.eras.length - 1]).params);
  if (T.WWR_byEra && T.WWR_byEra[eraId] != null && out.WWR) out.WWR = { ...out.WWR, value: T.WWR_byEra[eraId], note: L(`按年代 ${eraId}（WWR_byEra）`, `by era ${eraId} (WWR_byEra)`, `nach Klasse ${eraId} (WWR_byEra)`) };
  const vk = variant || T.defaultVariant;
  if (T.variants && vk && T.variants[vk]) put(T.variants[vk].params);
  // calibrated values (mergeCalib) last; the table's value stays in the note
  for (const [k, e] of Object.entries(noCalib ? {} : T.calib || {})) {
    const p = P_(e);
    if (!p) continue;
    const pr = e.prior, prTxt = pr ? L(`先验 ${pr.value}（${pr.p10}–${pr.p90}，${pr.tier}）`, `prior ${pr.value} (${pr.p10}–${pr.p90}, ${pr.tier})`, `Prior ${pr.value} (${pr.p10}–${pr.p90}, ${pr.tier})`) : '';
    out[k] = { ...p, note: [e.note || e.rule || '', prTxt].filter(Boolean).join(' · '), prior: pr || null };
  }
  return out;
}
const sharesOf = (type, variant) => { const T = A.types[type], v = variant && T.variants?.[variant]; return (v && v.systemPrior?.shares) || T.systemPrior?.shares || null; };
const SYS_FALLBACK = (k) => (A.systems[k] ? k : null);
function sysCOP(key) { const s = A.systems[key] || A.systems.unitary; return s.COP_cool; }

// model: needs sgType, sgVariant, x (record attributes), areas; eraInfo: agePrior(); state: { era, system, user: {k: v} }
// ctx: { bca: bcaInputs() | null, gross: footprint × storeys in m² (for the calibration domain) }
export function assign(m, eraInfo, state = {}, ctx = {}) {
  const type = m.sgType, eras = erasOf(type);
  const eraId = state.era || (eras ? mostLikely(eraInfo.p) : null);
  // calibration domain (calib_commercial.json meta.domain): an unlisted outline smaller than the smallest training
  // building of its type keeps the table values
  const D = A.types[type]?.calibDomain, P0 = typeParams(type, m.sgVariant, eraId, true);
  const gfaEst = D && !ctx.bca?.row && ctx.gross > 0 && P0.refAreaFactor ? P0.refAreaFactor.value * ctx.gross : null;
  const outside = gfaEst != null && gfaEst < D.gfaMin;
  const P = outside ? P0 : typeParams(type, m.sgVariant, eraId);
  if (outside) {
    const g = Math.round(gfaEst).toLocaleString('en-GB'), lim = D.gfaMin.toLocaleString('en-GB');
    const why = L(`本楼约 ${g} m² GFA，小于 BCA 标定所用最小一栋同类楼（${lim} m²），不用标定值，取表值`, `about ${g} m² GFA, smaller than the smallest BCA building of this type in the calibration (${lim} m²): table value, not the calibrated one`, `etwa ${g} m² BGF, kleiner als das kleinste BCA-Gebäude dieses Typs in der Kalibrierung (${lim} m²): Tabellenwert, nicht der kalibrierte`);
    for (const k of Object.keys(A.types[type].calib || {})) if (P[k]) P[k] = { ...P[k], note: [P[k].note, why].filter(Boolean).join(' · ') };
  }
  // a table value with tier observed is a statistic of measured Singapore buildings or households (meta.tiers), not a
  // value of this building: on the building it reads as a published table; values from the building's own records
  // (BCA listing, HDB year) are set below or elsewhere and keep observed
  for (const k of Object.keys(P)) if (P[k]?.tier === 'observed') P[k] = { ...P[k], tier: 'published_table', note: [P[k].note, TYPE_STAT()].filter(Boolean).join(' · ') };
  const eraTxt = eras ? (eras.find((e) => e.id === eraId)?.label_en || eraId) : '';
  for (const [k, p] of Object.entries(P)) if (p && p.p10 != null) { p.note = [p.note, eras && ['U_wall', 'U_roof', 'U_window', 'g_window', 'WWR', 'floorHeight', 'n50'].includes(k) ? eraTxt : ''].filter(Boolean).join(' · '); }
  // HDB block: the household rows weighted by this block's flat area (table note: recompute per block)
  if (type === 'hdb' && m.x?.hdb) {
    const f = hdbFlats(m.x.hdb), H = A.households.byDwelling, tot = Object.values(f.rows).reduce((s, v) => s + v, 0);
    if (tot > 0) {
      const mix = Object.entries(f.rows).map(([r, a]) => `${H[r].label_en} ${Math.round((100 * a) / tot)}%`).join(', ');
      for (const k of ['coolFrac', 'Q_int', 'Q_lat', 'P_light', 'P_equip', 'E_other']) {
        if (A.types.hdb.calib?.[k]) continue;   // a calibrated type value wins over the per-block weighting
        const w = (q) => Object.entries(f.rows).reduce((s, [r, a]) => s + (a / tot) * H[r][k][q], 0);
        const cal = Object.keys(f.rows).some((r) => H[r][k].tier === 'calibrated');   // calibrated rows (mergeCalib)
        P[k] = { ...P[k], value: +w('value').toFixed(4), p10: +w('p10').toFixed(4), p90: +w('p90').toFixed(4), tier: cal ? 'calibrated' : 'assumed',
          source: `${H[Object.keys(f.rows)[0]][k].source}`, note: L(`按本楼各户型的面积加权：${mix}`, `weighted by the flat area of this block's flat types: ${mix}`, `gewichtet nach der Wohnfläche der Wohnungstypen dieses Blocks: ${mix}`) };
      }
    }
  }
  // mixed development with its own GFA shares (BCA): per-m² loads of the part types, as annual energy on the mixed schedule
  const shares = ctx.bca?.row?.gfa_share;
  if (type === 'mixed' && shares && Object.keys(shares).length) {
    const MAP = { Office: 'office', Retail: 'retail', Hotel: 'hotel' }, hrs = (pp) => Math.max(1, (pp.end.value - pp.start.value) * (pp.daysPerWeek.value / 7));
    const own = hrs(P), parts = Object.entries(shares).filter(([, s]) => s > 0).map(([k, s]) => [MAP[k] || null, s]);
    const sum = parts.reduce((t, [, s]) => t + s, 0);
    if (sum > 0) {
      const desc = Object.entries(shares).filter(([, s]) => s > 0).map(([k, s]) => `${k} ${Math.round(100 * s)}%`).join(', ');
      for (const k of ['Q_int', 'Q_lat', 'P_light', 'P_equip', 'equipBase', 'E_other', 'n_vent']) {
        const val = (q) => parts.reduce((t, [ty, s]) => { const pp = ty ? typeParams(ty, null, eraId) : P, f = ['Q_int', 'Q_lat', 'P_light', 'P_equip'].includes(k) ? hrs(pp) / own : 1; return t + (s / sum) * pp[k][q] * f; }, 0);
        P[k] = { ...P[k], value: +val('value').toFixed(3), p10: +val('p10').toFixed(3), p90: +val('p90').toFixed(3), note: L(`BCA 各功能 GFA 占比 ${desc}：各类型的值按年使用小时折到综合体的使用时段`, `BCA GFA shares ${desc}: the values of the part types brought to the mixed schedule by their annual use hours`, `BCA-Flächenanteile ${desc}: die Werte der Teiltypen über ihre jährlichen Nutzungsstunden auf den Zeitplan der Mischnutzung gebracht`) };
      }
    }
  }
  // the subtype of "other" by its BCA type (AC floor share medians)
  if (type === 'other' && ctx.bca?.row?.type && A.types.other.subtypeCoolFrac[ctx.bca.row.type]) {
    const [n, p10, p50, p90] = A.types.other.subtypeCoolFrac[ctx.bca.row.type];
    P.coolFrac = { value: p50, p10, p90, source: `BCA_BEBRDATA "AC Floor Area Percentage", ${ctx.bca.row.type}, n = ${n}`, tier: 'published_table', note: TYPE_STAT() };
  }
  // system and COP
  const bca = ctx.bca;
  const shares0 = outside ? null : sharesOf(type, m.sgVariant);
  let sysKey = state.system || bca?.system?.key || (outside && A.systems.unitary ? 'unitary' : A.types[type].defaultSystem) || 'unitary', sysSrc = state.system ? 'user' : bca?.system ? bca.system.src : null;
  if (!A.systems[sysKey]) sysKey = SYS_FALLBACK(A.types[type].defaultSystem) || 'unitary';
  const sc = sysCOP(sysKey);
  P.COP_cool = { ...P_(sc), note: `${A.systems[sysKey].label_en}; ${A.systems[sysKey].scope}` };
  if (P.COP_cool.tier === 'observed') P.COP_cool = { ...P.COP_cool, tier: 'published_table', note: [P.COP_cool.note, TYPE_STAT()].join(' · ') };
  if (outside && !state.system && !bca?.system) P.COP_cool = { ...P.COP_cool, tier: 'assumed', note: [P.COP_cool.note, L('小楼按分体或多联机计（BCA 的空调系统分布只来自 5,000 m² 以上的楼，其中 5,000–15,000 m² 的楼已有一半是分体或多联机）', 'small building taken as split or VRF units (the BCA system shares come from buildings of 5,000 m² and more; of those between 5,000 and 15,000 m², half already have unitary systems)', 'kleines Gebäude als Split- oder VRF-Geräte angenommen (die BCA-Systemanteile stammen von Gebäuden ab 5.000 m²; von denen zwischen 5.000 und 15.000 m² hat schon die Hälfte Einzelgeräte)')].join(' · ') };
  if (bca?.cop && !state.system) P.COP_cool = { value: +bca.cop.value.toFixed(3), p10: bca.cop.value, p90: bca.cop.value, source: 'BCA listing', tier: bca.cop.tier === 'published_table' ? 'published_table' : 'observed', note: bca.cop.src, bcaCop: bca.cop };
  if (bca?.coolFrac) P.coolFrac = { value: bca.coolFrac.value, p10: bca.coolFrac.value, p90: bca.coolFrac.value, source: 'BCA listing', tier: 'observed', note: bca.coolFrac.src };
  if (bca?.occ) for (const k of ['Q_int', 'Q_lat', 'P_equip']) if (P[k]) { const s = bca.occ.scale; P[k] = { ...P[k], value: +(P[k].value * s).toFixed(3), p10: P[k].p10 * s, p90: P[k].p90 * s, note: [P[k].note, L(`× ${s.toFixed(2)}（${bca.occ.src}；按入住率缩放是假设）`, `× ${s.toFixed(2)} (${bca.occ.src}; scaling by occupancy assumed)`, `× ${s.toFixed(2)} (${bca.occ.src}; Skalierung mit der Belegung angenommen)`)].filter(Boolean).join(' · ') }; }
  // infiltration factor of rc5
  if (A.meta.defaults?.e_inf) P.e_inf = P_(A.meta.defaults.e_inf);
  // the type's AC hours: non-residential AC follows use (rc5); residential acStart/acEnd as given
  // user input: point masses
  for (const [k, v] of Object.entries(state.user || {})) if (P[k] && v != null && Number.isFinite(+v)) P[k] = { ...P[k], value: +v, p10: +v, p90: +v, tier: 'user', source: 'user', note: L('用户填写', 'User input', 'Eigene Eingabe') };
  // to the BModel params form ({ value, unit, source, note } plus the table's fields)
  const params = {};
  for (const [k, p] of Object.entries(P)) params[k] = { ...p, unit: PARAM_META[k]?.unit ?? '', dist: p.p10 == null || p.p90 == null || p.p10 === p.p90 ? 'fixed' : 'twoPiece' };
  return { params, cls: eraId, eraId, sysKey, sysSrc, systemShares: state.system || bca?.system ? null : shares0, prof: null, calibDomain: D ? { gfaMin: D.gfaMin, gfaEst, outside } : null };
}

// values for rc5 (and the geometry factors the prior adds)
export function paramValues(m) {
  const p = {};
  for (const k of RC5_KEYS) if (m.params[k] && m.params[k].value != null) p[k] = m.params[k].value;
  p.T_heat = null;   // no space heating (table: T_heat null)
  p.setback = 0; p.heatedFrac = 1;
  return p;
}

export function applyWWR(m) { const w = m.params.WWR?.value ?? 0.25; for (const f of m.facades) f.wwr = w; }

// ---------- prior sampler ----------
// draw(r) → { p, ageClass: era id, system }
export function makePrior(m, eraInfo, state, assigned, ctx = {}) {
  const base = paramValues(m), type = m.sgType, eras = erasOf(type);
  const eraKnown = !!state.era || !eras || eraInfo.kind !== 'prior';
  const cum = []; let s = 0; for (const [k, v] of Object.entries(eraInfo.p || {})) { s += v; cum.push([s, k]); }
  const user = (k) => m.params[k]?.tier === 'user';
  const fixedSys = !!state.system || !!ctx.bca?.system;
  const sysShares = assigned.systemShares;
  const copFromBca = m.params.COP_cool?.bcaCop;
  const geo = m.geomPrior || {};
  const fixedGfa = !RES_TYPES.includes(type) && m.areas?.refTier === 'observed';
  const envCache = new Map();
  const envFor = (eraId) => { if (!envCache.has(eraId)) envCache.set(eraId, assign(m, eraInfo, { ...state, era: eraId }, ctx).params); return envCache.get(eraId); };
  return (r) => {
    let eraId = assigned.eraId;
    if (!eraKnown) { const x = r.u() * s; eraId = cum.find(([c]) => x <= c)?.[1] || eraId; }
    const P = eraId === assigned.eraId ? m.params : envFor(eraId);
    const p = { ...base };
    for (const k of RC5_KEYS) {
      const e = P[k];
      if (!e || e.value == null || user(k) || k === 'COP_cool') continue;
      if (k === 'natCtrl') { const pOne = A.types[type]?.params?.natCtrl?.pOne; p.natCtrl = pOne ? (r.u() < pOne ? 1 : 0) : e.value; continue; }
      const z = r.n();
      let v = e.dist === 'fixed' ? e.value : clampK(k, twoPiece(e.value, e.p10, e.p90, z));
      if (k === 'acStart' || k === 'acEnd') v = Math.round(v) % 24;
      p[k] = v;
    }
    // cooling system: drawn from the type's shares unless BCA or the user named it; COP from that system's range
    let sys = assigned.sysKey;
    if (!user('COP_cool')) {
      if (!fixedSys && sysShares) { let x = r.u(); sys = Object.keys(sysShares).find((k) => (x -= sysShares[k]) <= 0) || sys; if (!A.systems[sys]) sys = assigned.sysKey; }
      if (copFromBca && !state.system) {
        // observed efficiency; with the air side from the table, its spread
        const t = copFromBca.airTable;
        p.COP_cool = t ? 3.517 / (copFromBca.chw + twoPiece(t.value, t.p10, t.p90, r.n())) : copFromBca.value;
      } else { const c = sysCOP(sys); p.COP_cool = Math.max(0.5, twoPiece(c.value, c.p10, c.p90, r.n())); }
    }
    // geometry: window share, storeys (height range), reference area factor
    const w0 = m.params.WWR?.value, we = P.WWR;
    if (w0 > 0 && we && !user('WWR')) p.wwrScale = clampK('WWR', twoPiece(we.value, we.p10, we.p90, r.n())) / w0;
    if (geo.h10 != null && geo.h90 > geo.h10 && m.height > 0) p.hScale = Math.max(0.2, twoPiece(m.height, geo.h10, geo.h90, r.n()) / m.height);
    if (geo.area && geo.area.p90 > geo.area.p10) p.anScale = twoPiece(geo.area.value, geo.area.p10, geo.area.p90, r.n()) / geo.area.value;
    // non-residential with the BCA GFA: the storeys draw changes the envelope, not the observed floor area
    else if (fixedGfa && p.hScale) p.anScale = 1 / p.hScale;
    return { p, ageClass: eraId, system: sys };
  };
}

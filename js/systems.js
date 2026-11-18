// Useful energy → final energy, primary energy, CO2 and the residential Energieausweis class.
// Factors come from data/archetypes_de.json (systems, carriers, hpModel, classes); FALLBACK is used only until it loads.
import { MONTH_OF_HOUR } from './rc5.js';
import { L } from './i18n.js';

const FALLBACK = {
  systems: {
    gas_cond: { label: L('燃气冷凝锅炉', 'Gas condensing boiler', 'Gas-Brennwertkessel'), eta: 0.92, etaRange: [0.85, 0.97], carrier: 'gas' },
    gas_old: { label: L('旧式燃气锅炉', 'Old gas boiler', 'Alter Gaskessel'), eta: 0.78, etaRange: [0.68, 0.86], carrier: 'gas' },
    oil: { label: L('燃油锅炉', 'Oil boiler', 'Ölkessel'), eta: 0.80, etaRange: [0.70, 0.90], carrier: 'oil' },
    district: { label: L('区域供热', 'District heating', 'Fernwärme'), eta: 0.95, etaRange: [0.90, 0.98], carrier: 'district' },
    hp_air: { label: L('空气源热泵', 'Air-source heat pump', 'Luft-Wasser-Wärmepumpe'), eta: 0.95, etaRange: [0.90, 0.98], carrier: 'electricity', hp: 'air' },
    hp_ground: { label: L('地源热泵', 'Ground-source heat pump', 'Sole-Wasser-Wärmepumpe'), eta: 0.95, etaRange: [0.90, 0.98], carrier: 'electricity', hp: 'ground' },
    pellet: { label: L('木屑颗粒锅炉', 'Wood pellet boiler', 'Holzpelletkessel'), eta: 0.85, etaRange: [0.78, 0.90], carrier: 'wood' },
    electric: { label: L('电直热', 'Direct electric heating', 'Stromdirektheizung'), eta: 0.98, etaRange: [0.95, 1.0], carrier: 'electricity' },
  },
  carriers: {
    gas: { label: L('天然气', 'Natural gas', 'Erdgas'), fp: 1.1, co2: 240 }, oil: { label: L('燃油', 'Heating oil', 'Heizöl'), fp: 1.1, co2: 310 },
    electricity: { label: L('电', 'Electricity', 'Strom'), fp: 1.8, co2: 560 }, district: { label: L('区域供热', 'District heating', 'Fernwärme'), fp: 0.7, co2: 300 }, wood: { label: L('木材', 'Wood', 'Holz'), fp: 0.2, co2: 20 },
  },
  hpModel: { carnotEta: 0.45, supplyT: { radiator: 55, floor: 35 } },
  classes: [{ label: 'A+', max: 30 }, { label: 'A', max: 50 }, { label: 'B', max: 75 }, { label: 'C', max: 100 }, { label: 'D', max: 130 },
    { label: 'E', max: 160 }, { label: 'F', max: 200 }, { label: 'G', max: 250 }, { label: 'H', max: null }],
};

let DB = FALLBACK;
const mergeKeys = (base, over) => { const out = { ...base }; for (const [k, v] of Object.entries(over || {})) out[k] = { ...(base[k] || {}), ...v }; return out; };
export function setFactors(arch) {
  const carriers = mergeKeys(FALLBACK.carriers, arch.carriers);
  // Munich: SWM district heating network values (GEG primary energy factor; CO2 by the Carnot method, see sources)
  const dh = arch.munich && arch.munich.districtHeating;
  if (dh) carriers.district = { ...carriers.district, label: L('区域供热（SWM 慕尼黑网）', 'District heating (SWM Munich network)', 'Fernwärme (SWM-Netz München)'), fp: dh.fp_GEG ?? carriers.district.fp, co2: dh.co2_recommended ?? carriers.district.co2, src: L('SWM 公布值（见 archetypes_sources.md）', 'SWM published values (see archetypes_sources.md)', 'Veröffentlichte SWM-Werte (siehe archetypes_sources.md)') };
  DB = {
    systems: mergeKeys(FALLBACK.systems, arch.systems),
    carriers,
    hpModel: { ...FALLBACK.hpModel, ...(arch.hpModel || {}) },
    classes: arch.classes && arch.classes.length ? arch.classes : FALLBACK.classes,
  };
}
const carnotOf = (kind) => { const c = DB.hpModel.carnotEta; return typeof c === 'number' ? c : (c[kind === 'ground' ? 'hp_ground' : 'hp_air'] ?? 0.45); };
const supplyOf = (emitter) => { const s = DB.hpModel.supplyT || {}; return emitter === 'floor' ? (s.floor ?? 35) : emitter === 'radiator_old' ? (s.radiator_old ?? 70) : (s.radiator_new ?? s.radiator ?? 55); };
export function factors() { return DB; }

export function energyClass(perM2) {
  for (const c of DB.classes) if (c.max == null || perM2 <= c.max) return c.label;
  return DB.classes[DB.classes.length - 1].label;
}

// Heat-pump COP with a heating curve: supply temperature falls linearly from the design value at −16 °C to 25 °C at +20 °C.
function cop(te, tSupDesign, source, carnotEta) {
  const tSup = Math.max(25, tSupDesign - ((tSupDesign - 25) * (te + 16)) / 36);
  const tSrc = source === 'ground' ? 5 : te;
  const c = (carnotEta * (tSup + 273.15)) / Math.max(5, tSup - tSrc);
  return Math.max(1.3, Math.min(7, c));
}

// res: rc5 results with hourly Q_hc (needed for heat pumps; otherwise annual/monthly suffice)
export function finalEnergy(res, p, ctx, opts = {}) {
  const sys = DB.systems[p.system] || DB.systems.gas_cond;
  const car = DB.carriers[sys.carrier] || DB.carriers.gas;
  const AN = ctx.AN * (p.hScale ?? 1) * (p.anScale ?? 1);   // prior draws may scale the storeys and the reference area (rc5.js)
  const useHeat = res.annual.heat;
  const useDhw = (p.dhw || 0) * AN;
  let fHeat, fDhw, seasonalCop = null;
  if (sys.hp) {
    // emitter: unrefurbished buildings need old-radiator temperatures (70 °C), otherwise 55 °C radiators (or floor heating if given)
    const tSup = supplyOf(opts.emitter || (res.annual.heatPerM2 > 110 ? 'radiator_old' : 'radiator_new'));
    const ce = carnotOf(sys.hp);
    const Te = ctx.Te;
    let el = 0, heatSum = 0;
    if (res.hourly) {
      for (let i = 0; i < 8760; i++) { const q = res.hourly.Q_hc[i]; if (q > 0) { el += q / cop(Te[i], tSup, sys.hp, ce); heatSum += q; } }
      el /= 1000; heatSum /= 1000;
    } else {
      // monthly approximation with the monthly mean outdoor temperature
      const tm = monthlyMeanT(Te);
      res.monthly.heat.forEach((q, m) => { el += q / cop(tm[m], tSup, sys.hp, ce); heatSum += q; });
    }
    seasonalCop = heatSum > 0 ? heatSum / el : null;
    fHeat = el / (p.eta_sys || 1);
    const copDhw = cop(10, 55, sys.hp, ce) * 0.85;
    fDhw = useDhw / copDhw / (p.eta_sys || 1);
  } else {
    fHeat = useHeat / Math.max(0.3, p.eta_sys);
    fDhw = useDhw / Math.max(0.3, p.eta_sys * 0.9);
  }
  const total = fHeat + fDhw;
  const perM2 = total / AN;
  return {
    carrier: sys.carrier, carrierLabel: car.label, systemLabel: sys.label + (sys.hp && seasonalCop ? L(`（季节 COP ${seasonalCop.toFixed(1)}）`, ` (seasonal COP ${seasonalCop.toFixed(1)})`, ` (Jahresarbeitszahl ${seasonalCop.toFixed(1)})`) : ''),
    heat: fHeat, dhw: fDhw, useDhw, total, perM2, seasonalCop,
    cls: ctx.residential ? energyClass(perM2) : null,
    co2: (total * car.co2) / 1000, primary: total * car.fp,
  };
}

const MT_CACHE = new WeakMap();
export function monthlyMeanT(T) {
  if (MT_CACHE.has(T)) return MT_CACHE.get(T);
  const s = new Float64Array(12), n = new Float64Array(12);
  for (let i = 0; i < 8760; i++) { s[MONTH_OF_HOUR[i]] += T[i]; n[MONTH_OF_HOUR[i]]++; }
  const r = Array.from(s, (v, i) => v / n[i]);
  MT_CACHE.set(T, r);
  return r;
}

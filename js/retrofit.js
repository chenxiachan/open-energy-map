// Retrofit scenarios (applied to a parameter set) — values from data/archetypes_de.json refurb/gegAnlage7 when present.
import { L } from './i18n.js';

export function scenarios(A, model) {
  const g7 = (A && A.refurb && A.refurb.gegAnlage7) || {};
  const pick = (...vals) => vals.find((v) => typeof v === 'number' && v > 0);
  const uWall = pick(g7.U_wall, g7.wall, g7.U_wall_external, 0.24);
  const uWin = pick(g7.U_window, g7.window, 1.3);
  const uRoof = pick(model.roof.attic === 'unheated' ? (g7.U_topCeiling ?? g7.U_top_ceiling) : g7.U_roof, g7.U_roof, g7.roof, 0.24);
  const uFloor = pick(g7.U_floor, g7.U_basementCeiling, g7.floor, 0.30);
  const adv = (A && A.refurb && A.refurb.advanced) || {};
  return [
    { id: 'wall', label: L('外墙保温', 'Wall insulation', 'Außenwanddämmung'), note: L(`外墙 U → ${uWall}`, `Wall U → ${uWall}`, `Außenwand U → ${uWall}`), apply: (p) => ({ ...p, U_wall: Math.min(p.U_wall, uWall), dU_tb: Math.min(p.dU_tb, 0.05) }) },
    { id: 'window', label: L('换窗', 'New windows', 'Fenstertausch'), note: L(`窗 U → ${uWin}，g → 0.6，气密性提高`, `Window U → ${uWin}, g → 0.6, better air tightness`, `Fenster U → ${uWin}, g → 0,6, bessere Luftdichtheit`), apply: (p) => ({ ...p, U_window: Math.min(p.U_window, uWin), g_window: 0.6, n50: p.n50 * 0.8 }) },
    { id: 'roof', label: model.roof.attic === 'unheated' ? L('顶层楼板保温', 'Top floor ceiling insulation', 'Dämmung der obersten Geschossdecke') : L('屋面保温', 'Roof insulation', 'Dachdämmung'), note: `U → ${uRoof}`, apply: (p) => ({ ...p, U_roof: Math.min(p.U_roof, uRoof) }) },
    { id: 'floor', label: L('地下室顶板保温', 'Basement ceiling insulation', 'Kellerdeckendämmung'), note: `U → ${uFloor}`, apply: (p) => ({ ...p, U_floor: Math.min(p.U_floor, uFloor) }) },
    { id: 'hp', label: L('换空气源热泵', 'Air-source heat pump', 'Luft-Wasser-Wärmepumpe'), note: L('保留散热器；采暖需求 > 110 kWh/(m²·a) 按 70 °C 老式散热器，否则 55 °C，逐时算 COP', 'Radiators are kept. Above 110 kWh/(m²·a) heating demand they are treated as old 70 °C radiators, otherwise 55 °C. COP is computed hourly.', 'Die Heizkörper bleiben erhalten. Über 110 kWh/(m²·a) Heizwärmebedarf gelten sie als alte 70-°C-Heizkörper, sonst 55 °C. Der COP wird stündlich berechnet.'), apply: (p) => ({ ...p, system: 'hp_air', eta_sys: 0.95 }) },
    {
      id: 'deep', label: L('整体改造包', 'Deep retrofit package', 'Umfassendes Sanierungspaket'), note: L(`外墙/窗/顶板/底板到 GEG 限值，带热回收通风（${adv.hr_eff ?? 0.8}）、n50 1.5、热泵`, `Wall, windows, roof and floor to GEG limits, ventilation with heat recovery (${adv.hr_eff ?? 0.8}), n50 1.5, heat pump`, `Außenwand, Fenster, Dach und Boden auf GEG-Höchstwerte, Lüftung mit Wärmerückgewinnung (${adv.hr_eff ?? 0.8}), n50 1,5, Wärmepumpe`),
      apply: (p) => ({
        ...p, U_wall: Math.min(p.U_wall, uWall), U_window: Math.min(p.U_window, uWin), g_window: 0.6, U_roof: Math.min(p.U_roof, uRoof),
        U_floor: Math.min(p.U_floor, uFloor), dU_tb: 0.05, n50: Math.min(p.n50, 1.5), hr_eff: adv.hr_eff ?? 0.8, system: 'hp_air', eta_sys: 0.95,
      }),
    },
  ];
}

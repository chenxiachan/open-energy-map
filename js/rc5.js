// ISO 13790:2008 simple hourly method (5R1C), Annex C, with the heating/cooling demand procedure of C.4.
//
// Split in two steps so the Bayesian calibration can rerun the thermal model thousands of times:
//   prepare(model, weather, shading, profile, city)  → ctx: everything that does not depend on the uncertain parameters
//   run(ctx, p, opts)                                 → results (CONTRACT §3 subset); p = plain object of parameter values
//
// Modelling choices (shown in the UI "方法" note):
// - Opaque solar gains and sky long-wave losses per ISO 13790 §11.3 (α 0.5 walls / 0.6 roof, R_se 0.04, h_r 4.1, Δθ_er 11 K;
//   p.dT_sky sets Δθ_er, default 11 K).
// - Window gains: g · (1 − frame) · F_W 0.9 · irradiance after neighbour/self shading; movable shading (shadeCtrl) applies
//   when the mean window irradiance exceeds 250 W/m² and the room was above 23 °C in the previous hour.
// - Infiltration n_inf = 0.07 · n50 (DIN V 18599-2 style e-factor). Air volume 0.8 · V_e.
// - Ventilation, residential: n_vent on the air volume at all hours, reduced by heat recovery (1 − hr_eff).
//   Non-residential with window ventilation (no heat recovery), after DIN V 18599-2: the usage air flow is per m² of
//   reference area (DIN V 18599-10 V_A, reduced by the relative absence; n_vent refers to a 3 m clear height, so the
//   flow is n_vent × 3 m × A_N); infiltration counts towards it, so the windows add max(0.1 h⁻¹, flow − infiltration)
//   during use, and 0.1 h⁻¹ outside use (Δn_win = n_nutz − n_inf − 0.1 and n_win = 0.1 + Δn_win during use). The
//   seasonal correction of window ventilation in DIN V 18599-2 is not applied. Non-residential with heat recovery: n_vent
//   on the air volume during use, 10 % of it outside.
// - Partial heating (heatedFrac f): effective set point lowered by (1 − f) · 4 K (unheated rooms float below the heated ones).
// - Ground floor and roof to an unheated attic: temperature correction factors F_floor, F_roof on (θ_i − θ_e).
//
// Tropical extensions (Singapore, docs/singapore-contract.md §3). Each term is off, and the result object keeps exactly its
// Munich form and values, when its parameters are absent (tests/munich_regression.mjs checks this byte for byte).
// - Local time. Schedules, AC hours and night hours use local time UTC + tz: city.tz (5th argument of prepare), else
//   profile.tz, else 1 (Munich, no daylight saving). Months stay those of the UTC hour (MONTH_OF_HOUR), so in Singapore
//   (tz 8) the first 8 local hours of each month count to the month before (under 1.1 % of a month).
// - Holidays. city.holidays (a list by year, data/sg/holidays.json, or a calendar from holidays.js cityCalendar)
//   replaces the Bavarian holidays; the rules for years not in the list, the typical year included, are in holidays.js.
// - Latent load. Humidity ratio x = 0.621945 · p_v / (p − p_v) (ASHRAE Handbook Fundamentals 2017, ch. 1, eq. 20), with
//   p_v = RH · p_s(T) and p_s = 610.94 · exp(17.625 T / (T + 243.04)) Pa (Magnus form, coefficients of Alduchov and
//   Eskridge 1996, J. Appl. Meteor. 35:601; no enhancement factor, so x is about 0.7 % below the ASHRAE tables), at the
//   sea-level pressure p = 101.325 kPa (Singapore lies at 0–160 m: under 2 % less pressure, x about 2 % higher at the
//   same RH, not corrected). Air latent load q_l = 3010 · V̇ · Δx
//   (W, V̇ in L/s; ASHRAE Fundamentals 2017, ch. 18, standard air), i.e. 2459 · H · Δx for an air conductance
//   H = 0.34 · n · V in W/K as used here (0.34 Wh/(m³·K) = 1.224 W per L/s and K). Counted in every hour the AC of a zone
//   is on by schedule, as an ideal AC with a humidistat holding RH_cool at T_cool (the target x_i = x(T_cool, RH_cool)),
//   also in the rare AC hours without a sensible load (annual.latOnlyHours): the infiltration and ventilation air of
//   the cooled share brings max(0, x_e − x_i), so dry outdoor air gives no latent credit; the air flow is taken without
//   hr_eff (a sensible heat recovery device does not recover moisture). Internal latent gains Q_lat (W/m²) count during
//   occupancy in the cooled share while its AC is on.
//   Pull-down at AC start: in the first hour the AC of the cooled zone is on after being off, it also removes the moisture
//   the room air took up meanwhile, ρ · V_air · max(0, x_room − x_i) · h_fg = 2459 · 0.34 · V_air · Δx Wh (the same
//   standard-air constants; V_air of the cooled share). x_room is tracked hour by hour as a well-mixed air node: while
//   the AC is off it relaxes towards the outdoor humidity ratio of the hour, plus the internal moisture Q_lat / (2459 · H)
//   while occupied, with the hour's air change n = H / (0.34 · V_air), x ← x_eq + (x − x_eq) · e^(−n); while the AC is on
//   it is held at x_i (or lower, if the air is drier). With open windows (n_nat of several per hour) this is the outdoor
//   humidity of the hour before; a closed building overnight (infiltration only) keeps a ventilation-weighted mean of the
//   last hours. With the AC on all day there is no pull-down. Choice: room air only, no moisture capacity of furnishings
//   and finishes (EnergyPlus' default zone moisture capacity multiplier is 1 as well); buffering would add to the
//   pull-down and spread it over more hours, and no published value for Singapore interiors fixes its size. EnergyPlus
//   with the same inputs removes 5–12 % more latent heat with intermittent AC for this reason (qa/sg_eplus_compare.md).
//   Not modelled: moisture buffering of materials, moisture carried between the zones.
// - Cooled share (coolFrac f < 1): two zones instead of the heatedFrac rule. Each zone is the whole building scaled by
//   its share (envelope, air volume, mass, solar and internal gains spread evenly over the floor area); they are coupled
//   by the partitions between them, H_cu = hPart · min(f, 1 − f) · A_N, with hPart 2.0 W/K per m² of floor of the
//   smaller share (assumed: about 0.8 m² of partition per m² of bedroom floor, U 2.5 W/(m²K) for a 100 mm masonry or
//   concrete partition with both surface resistances; p.hPart overrides it). H_cu links the surface nodes θ_s of the two
//   zones (it enters each zone's network like a second window conductance, to the other zone's θ_s instead of θ_e): a
//   partition is a surface, and when the AC starts the cooled room's own surfaces are still about as warm as the rooms
//   next door, so little heat crosses it in the AC hours (EnergyPlus with the same inputs: partition conduction near 0
//   in the AC hours, qa/sg_eplus_compare.md cause 6). Coupling the air nodes, as before 2026-11-26, carried the full air
//   temperature difference and gave 3–4 times EnergyPlus' coupling load. The cooled zone is solved first with the other
//   zone's θ_s of the previous hour, then the uncooled zone with the new one; H_cu is far below each zone's own
//   H_tr,ms + H_tr,is (over 40 W/K per m²), so this explicit coupling is stable. Why two zones: in a hot climate
//   the uncooled rooms are warmer than the cooled ones and heat flows in through the partitions, and the latent load
//   scales with the cooled air volume; a shifted set point (the heatedFrac rule) gives neither. Without the coupling the
//   cooled zone would simply be f times the whole building cooled; H_cu is what the second zone adds. Only the cooled
//   zone is cooled; heating (if any) applies to both. Loads are reported for the building (zone loads times their share).
// - Mixed mode (residential with T_cool and AC hours acStart–acEnd, p.acStart/p.acEnd or the profile's): the AC of the
//   cooled zone runs in the local hours [acStart, acEnd) (wrapping past midnight; 0–24 is all day, acStart = acEnd none)
//   with the windows closed (infiltration + n_vent). Residential AC without AC hours runs all day, as before. With n_nat
//   given, every zone of a residential building whose AC is off has its windows open (infiltration + n_nat): the
//   uncooled zone always, the cooled zone outside the AC hours, a building without AC always. Choice: open at all those
//   hours (natCtrl 0, default) rather than only when the outdoor air is cooler than the room (natCtrl 1: outdoor below the
//   zone air of the previous hour). In Singapore the outdoor air is warmer than the rooms for much of the day, so an
//   ideal controller would keep the windows shut through the afternoon, while in naturally ventilated flats the windows
//   stay open in the non-AC hours and fans move the air; the ideal rule would understate the warm-up before the AC
//   starts. This is an assumption on behaviour, not a measured rule; natCtrl 1 is there to test it.
// - Non-residential: AC during use with the windows closed (ventilation as above), off outside use; with n_nat given
//   the uncooled share (stairs, corridors, toilets) has its windows open.
// - Electricity. Lighting P_light (W/m²) during use, 0 outside; equipment P_equip during use and equipBase · P_equip
//   outside (residential: in use all day, so both are 24-h means). Both enter the zones in full as internal gains (all
//   electric power ends as heat in the building), with the internal-gain split of ISO 13790 C.2. When P_light or
//   P_equip is given, Q_int means the sensible gains of the occupants only: residential the same 24-h mean at all
//   hours, non-residential during use and 0 outside (equipBase replaces the 10 % rule). Without them Q_int keeps its
//   Munich meaning (all internal gains). Cooling electricity = (sensible + latent cooling) / COP_cool with a constant
//   seasonal COP: an hourly curve such as the DOE-2 EIR(T) of DX coils needs the coil entering wet-bulb temperature and
//   rated conditions that the archetype table does not give, and the published inputs (NEA labels, BCA plant efficiency
//   in kW/RT, COP = 3.517 / (kW/RT)) are seasonal or rated values. E_other (kWh/(m²·a)) is an annual add-on, spread over
//   the months by days.
// - Sky temperature depression Δθ_er (p.dT_sky): ISO 13790 gives 11 K, a value for temperate skies. Under the humid and
//   mostly overcast sky of Singapore the depression is much smaller: 4.2 K as the mean of T_air − T_sky over the hours of
//   the Singapore typical-year EPW, whose horizontal infrared comes from EnergyPlus' Clark–Allen model with the mean opaque
//   sky cover of 8.4 tenths (qa/sg_eplus_compare.md, tools/sg/epw_sg.mjs). The Singapore table sets it; without it 11 K.
// - Cooling balance (opts.detail with the tropical terms; res.coolBalance, read by the Cooling balance tab of the
//   Singapore page). Over the hours the AC of the cooled zone is on, the heat that enters it, in the convention of the
//   heating balance below: transmission and outdoor air at the set point, H × Σ(θ_e − T_cool); window solar g · (1 − F_F)
//   · 0.9 · irradiance (with shading and curtains); net opaque solar (absorbed minus sky long-wave); the sensible gains of
//   occupants, lighting and equipment; and, with two zones, the flow through the partitions from the uncooled zone's
//   surface node. Each is times the cooled share. Their sum differs from the hourly sensible load: the difference is heat
//   that the walls, floors and furniture stored while the AC was off and give back once it is on (positive), or take up
//   (negative), plus the AC hours in which the room stays below the set point. The latent terms are exact: outdoor air
//   (infiltration and ventilation) 2459 · H · max(0, x_e − x_i), internal Q_lat, and the pull-down at AC start; they add
//   up to annual.coolLat. Nothing here changes a result; without the tropical terms it is not computed.

import { daysOff, weekdayOf, cityCalendar, TMY_YEAR } from './holidays.js';

const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_OF_HOUR = (() => {
  const a = new Uint8Array(8760);
  let i = 0;
  MDAYS.forEach((n, m) => { for (let k = 0; k < n * 24; k++) a[i++] = m; });
  return a;
})();

export function amFactor(Cm) {
  if (Cm <= 95000) return 2.5;
  if (Cm <= 200000) return 2.5;
  if (Cm <= 300000) return 3.0;
  return 3.5;
}

// ---------- moist air (see the header) ----------
export const P_ATM = 101325;                    // Pa, sea level
export const LAT_PER_H = 3010 / (0.34 * 3.6);   // W per (W/K of air conductance) per (kg/kg): 2459
export const satPressure = (T) => 610.94 * Math.exp((17.625 * T) / (T + 243.04));   // Pa
// humidity ratio (kg water / kg dry air) at temperature T (°C) and relative humidity rh (0–1)
export function humidityRatio(T, rh) {
  const pv = Math.max(0, Math.min(1, rh)) * satPressure(T);
  return (0.621945 * pv) / (P_ATM - pv);
}
// outdoor humidity ratio of the weather, cached on ctx; weather.RH in % (CONTRACT §6), or 0–1 if no value exceeds 1
function outdoorX(ctx) {
  if (ctx.xOut !== undefined) return ctx.xOut;
  const { T, RH } = ctx.weather;
  if (!RH || RH.length < 8760) return (ctx.xOut = null);
  let mx = 0; for (let i = 0; i < 8760; i++) if (RH[i] > mx) mx = RH[i];
  const s = mx > 1 ? 0.01 : 1, a = new Float64Array(8760);
  for (let i = 0; i < 8760; i++) a[i] = humidityRatio(T[i], RH[i] * s);
  return (ctx.xOut = a);
}

// Operating schedule (local time = UTC + tz, no daylight saving). Non-residential profiles keep the days of use per
// year of the usage data: public holidays and, if needed, further days are off (js/holidays.js).
function schedules(profile, year, tz = 1, cal = null) {
  const occ = new Uint8Array(8760);
  const yr = typeof year === 'number' ? year : TMY_YEAR;   // TMY: laid on 2018, which starts on a Monday
  const h0 = profile.start ?? 0, h1 = profile.end ?? 24, days = profile.daysPerWeek ?? 7;
  const off = daysOff(profile, yr, cal);
  const wds = Uint8Array.from({ length: 366 }, (_, d) => weekdayOf(yr, Math.min(d, 364)));   // 1..7 Mon..Sun; file days (29 Feb dropped)
  for (let i = 0; i < 8760; i++) {
    let tl = i + tz;                        // local hour index (a negative offset wraps round the year)
    if (tl < 0) tl += 8760;
    const hl = tl % 24;
    const day = Math.floor(tl / 24);
    occ[i] = (h1 - h0 >= 24 ? 1 : (hl >= h0 && hl < h1 ? 1 : 0)) && wds[day] <= days && !off.has(day) ? 1 : 0;
  }
  return occ;
}

// city: { tz, holidays, sundayRule } of the city (all optional; absent = Munich). holidays: a list by year
// ({ "2019": ["2019-01-01", …] }) or a calendar from holidays.js cityCalendar.
export function prepare(model, weather, irr, profile, city = {}) {
  const A = model.areas;
  const nf = model.facades.length;
  const Swin = new Float32Array(8760), Sop = new Float32Array(8760);
  for (let f = 0; f < nf; f++) {
    const fa = model.facades[f];
    const aw = fa.windowArea || 0, ao = Math.max(0, (fa.exposedArea || 0) - aw);
    if (aw <= 0 && ao <= 0) continue;
    const I = irr.facade[f];
    for (let i = 0; i < 8760; i++) { Swin[i] += aw * I[i]; Sop[i] += ao * I[i]; }
  }
  const roofExposed = model.roof.attic !== 'unheated';
  const hday = new Uint8Array(8760);
  for (let d = 0; d < 365; d++) {
    let t = 0; for (let k = 0; k < 24; k++) t += weather.T[d * 24 + k];
    if (t / 24 < 15) hday.fill(1, d * 24, d * 24 + 24);
  }
  const winArea = Float64Array.from(model.facades, (f) => f.windowArea || 0);
  const opArea = Float64Array.from(model.facades, (f) => Math.max(0, (f.exposedArea || 0) - (f.windowArea || 0)));
  const tz = city.tz ?? profile.tz ?? 1;
  const hl0 = city.holidays ?? profile.holidayList ?? null;
  const cal = !hl0 ? null : typeof hl0.publicHolidays === 'function' ? hl0 : cityCalendar(hl0, { sundayRule: city.sundayRule, school: city.school });
  const hod = new Uint8Array(8760);         // local hour of the day
  for (let i = 0; i < 8760; i++) hod[i] = (((i + tz) % 24) + 24) % 24;
  const occ = schedules(profile, weather.year, tz, cal);
  const occM = new Float64Array(12), hrsM = new Float64Array(12);   // occupied and all hours per month
  for (let i = 0; i < 8760; i++) { hrsM[MONTH_OF_HOUR[i]]++; if (occ[i]) occM[MONTH_OF_HOUR[i]]++; }
  return {
    hday, winArea, opArea,
    model, weather, irr, profile,
    Te: weather.T, Swin, Sop, roofGHI: roofExposed ? weather.GHI : null,
    occ, hod, occM, hrsM, tz, calendar: cal,
    Awin: A.window, Aop: A.opaqueWall, Aroof: A.roof, Afloor: A.groundFloor, Aenv: A.envelope,
    AN: A.netFloor, Vair: 0.8 * A.volume,
    residential: ['sfh', 'th', 'mfh', 'ab'].includes(model.usage),
  };
}

export function run(ctx, p, opts = {}) {
  const { Te, Swin, Sop, roofGHI, occ, hday } = ctx;
  const hod = ctx.hod || HOD1;   // a ctx built by an older prepare: Munich local hours
  // Prior-only geometry factors. p.wwrScale scales every window area (the exposed facade stays the same, so the wall
  // takes the rest). p.hScale scales the number of storeys: facades, air volume and reference area grow with it, roof
  // and ground floor do not; shading is kept as computed for the point geometry.
  const ws = p.wwrScale ?? 1, hs = p.hScale ?? 1;
  const Awin = ctx.Awin * ws * hs, Aop = (ctx.Aop + (1 - ws) * ctx.Awin) * hs;
  const Aenv = ctx.Aenv + (hs - 1) * (ctx.Awin + ctx.Aop), Vair = ctx.Vair * hs;
  const Af = Math.max(1, ctx.AN * hs * (p.anScale ?? 1));   // p.anScale: reference-area draw (archetype.js)
  const Am = amFactor(p.Cm) * Af, At = 4.5 * Af, Cm = p.Cm * Af;
  const Htr_is = 3.45 * At, Htr_ms = 9.1 * Am;
  const Hw = p.U_window * Awin;
  const Hwall = p.U_wall * Aop, Hroof = p.F_roof * p.U_roof * ctx.Aroof, Hfloor = p.F_floor * p.U_floor * ctx.Afloor;
  const Htb = p.dU_tb * Aenv;
  const Hop = Hwall + Hroof + Hfloor + Htb;
  const Htr_em = 1 / (1 / Math.max(Hop, 1e-3) - 1 / Htr_ms);
  const hveInf = 0.34 * (p.e_inf ?? 0.07) * p.n50 * Vair;   // p.e_inf only in prior variants of offline studies
  const winVent = !ctx.residential && !(p.hr_eff > 0);
  const hveVentOcc = winVent ? Math.max(0.34 * 0.1 * Vair, 0.34 * p.n_vent * 3 * Af - hveInf) : 0.34 * p.n_vent * (1 - (p.hr_eff || 0)) * Vair;
  const hveVentOff = ctx.residential ? hveVentOcc : winVent ? 0.34 * 0.1 * Vair : 0.1 * hveVentOcc;
  const gEff = p.g_window * (1 - p.frameFrac) * 0.9;
  const awin = Math.max(Awin, 1e-6);
  const radW = 0.5 * 0.04 * p.U_wall, radR = 0.6 * 0.04 * p.U_roof * ctx.Aroof;
  const dTs = p.dT_sky ?? 11;   // Δθ_er, K (ISO 13790 §11.3.5: 11 K; Singapore table about 4.2 K, see the header)
  const skyW = 0.5 * 0.04 * p.U_wall * 4.1 * dTs * Aop, skyR = roofGHI ? 1.0 * 0.04 * p.U_roof * 4.1 * dTs * ctx.Aroof : 0;
  const hasHeat = p.T_heat != null;
  const Tset = hasHeat ? p.T_heat - (1 - p.heatedFrac) * 4 : -Infinity;
  const hasCool = p.T_cool != null;
  const Tcool = hasCool ? p.T_cool : 0;
  const sb = p.setback || 0;
  const resid = ctx.residential;

  // ---- tropical extensions (header); `trop` false = the Munich model exactly
  const split = p.P_light != null || p.P_equip != null;
  const trop = split || p.coolFrac != null || p.Q_lat != null || p.RH_cool != null || p.COP_cool != null || p.E_other != null || p.n_nat != null || p.acStart != null;
  const fc = hasCool ? Math.min(1, Math.max(0, p.coolFrac ?? 1)) : 1;   // cooled share
  const coolOK = hasCool && fc > 0;
  const twoZone = coolOK && fc < 1;
  const fu = 1 - fc;
  const acS = p.acStart ?? ctx.profile?.acStart, acE = p.acEnd ?? ctx.profile?.acEnd;
  const mixed = resid && coolOK && acS != null && acE != null;
  const acWrap = mixed && acS > acE;
  const hasNat = p.n_nat != null;
  const natRes = hasNat && resid;          // residential: windows open whenever the zone's AC is off
  const natCtrl = (p.natCtrl || 0) === 1;  // 1: open only when the outdoor air is cooler than the zone air
  const pLight = split ? (p.P_light || 0) * Af : 0, pEquip = split ? (p.P_equip || 0) * Af : 0, eBase = split ? (p.equipBase || 0) : 0;
  const qintOcc = split ? (p.Q_int || 0) * Af + pLight + pEquip : p.Q_int * Af;
  const qintOff = resid ? qintOcc : split ? eBase * pEquip : 0.1 * qintOcc;
  // latent: air conductance of the actual air flow (no heat recovery on moisture), target humidity ratio, internal gains
  const xOut = trop && coolOK && p.RH_cool != null ? outdoorX(ctx) : null;
  const xIn = xOut ? humidityRatio(Tcool, p.RH_cool) : 0;
  const qlatOcc = trop && coolOK ? (p.Q_lat || 0) * Af : 0;
  const latOn = !!xOut || qlatOcc > 0;
  const airVentOcc = winVent ? hveVentOcc : 0.34 * p.n_vent * Vair;
  const airVentOff = resid ? airVentOcc : winVent ? hveVentOff : 0.1 * airVentOcc;
  const hveNat = hasNat ? hveInf + 0.34 * p.n_nat * Vair : 0;
  const Hcu = twoZone ? (p.hPart ?? 2.0) * Math.min(fc, fu) * Af : 0;   // W/K between the zones (real scale)

  const amAt = Am / At, stFac = 1 - Am / At - Hw / (9.1 * At);
  const shadeOn = p.shadeCtrl < 1;
  // ventilation states → precompute the network coefficients. Hve: air-node conductance to the outdoor air; Hs: from the
  // surface node to the other zone's surface node (two zones, full-building scale: H_cu / share; it enters the network
  // like a second window conductance); La: air flow for the latent load; kx: share of the room air's moisture left after
  // one hour of that air change.
  const mk = (Hve, Hs = 0, La = 0) => {
    const H1 = 1 / (1 / Hve + 1 / Htr_is), H2 = H1 + Hw + Hs, H3 = 1 / (1 / H2 + 1 / Htr_ms);
    return { Hve, Hs, La, kx: La > 0 ? Math.exp(-La / (0.34 * Vair)) : 1, H1, H2, H3, c1: Cm / 3600 - 0.5 * (H3 + Htr_em), c2: Cm / 3600 + 0.5 * (H3 + Htr_em), dS: Htr_ms + Hw + H1 + Hs, dA: Htr_is + Hve };
  };
  const HcC = twoZone ? Hcu / fc : 0, HcU = twoZone ? Hcu / fu : 0;
  const NOcc = mk(hveInf + hveVentOcc, HcC, hveInf + airVentOcc), NOff = mk(hveInf + hveVentOff, HcC, hveInf + airVentOff);
  const NNat = hasNat ? mk(hveNat, HcC, hveNat) : null;
  const UOcc = twoZone ? mk(hveInf + hveVentOcc, HcU) : null, UOff = twoZone ? mk(hveInf + hveVentOff, HcU) : null;
  const UNat = twoZone && hasNat ? mk(hveNat, HcU) : null;
  // moisture pull-down at AC start (header): room air humidity of the cooled zone, tracked while it runs free
  const xTrack = trop && !!xOut;
  const pullK = fc * LAT_PER_H * 0.34 * Vair;   // Wh per (kg/kg) of the cooled share's air
  let xRoom = xOut ? xOut[8760 - 337] : 0, acPrev = false;
  const keepHourly = !!opts.hourly, detail = !!opts.detail;
  const Tair = keepHourly ? new Float32Array(8760) : null, Top = keepHourly ? new Float32Array(8760) : null, Qhc = keepHourly ? new Float32Array(8760) : null;
  const Qlat = keepHourly && trop ? new Float32Array(8760) : null, TairU = keepHourly && twoZone ? new Float32Array(8760) : null;
  const mHeat = new Float64Array(12), mCool = new Float64Array(12);
  const mSens = trop ? new Float64Array(12) : null, mLat = trop ? new Float64Array(12) : null;
  let heat = 0, cool = 0, peakH = 0, peakC = 0, over26 = 0, occHours = 0;
  let coolS = 0, coolL = 0, peakS = 0, peakL = 0, acHours = 0, latOnly = 0, over26U = 0;
  let nHd = 0, heatHd = 0, sA = 0, gSol = 0, gInt = 0, gOp = 0, ventDT = 0, infDT = 0, nHeatH = 0;
  // cooling balance (header), full-building scale of the cooled zone until the share fc is applied at the end
  const cbOn = detail && trop && coolOK, qPeople = split ? (p.Q_int || 0) * Af : 0;
  let cbN = 0, cbOcc = 0, cbDT = 0, cbVent = 0, cbSolW = 0, cbOpq = 0, cbPeople = 0, cbLight = 0, cbEquip = 0, cbCu = 0;
  let cbAir = 0, cbHve = 0, cbDx = 0, cbAirDx = 0, cbLatInt = 0, cbPull = 0, cbPullDx = 0, cbTe = 0, cbStarts = 0, cbStartT = 0, cbPrev = false;
  const nf = ctx.model.facades.length;
  const solWin = detail ? new Float64Array(nf) : null;
  let thM = 20, prevAir = 20, thMU = 20, sU = 20, airU = 20;
  // per-hour solution (no allocation): results in rMt, rMm, rS, rA
  let rMt = 0, rMm = 0, rS = 0, rA = 0;
  let N = NOcc, te = 0, tO = 0, phiIa0 = 0, phiSt = 0, phiM = 0;
  // tO: surface-node temperature of the other zone (two zones)
  const solve = (phiHC, th) => {
    const phiIa = phiIa0 + phiHC;
    const x = phiIa / N.Hve + te;
    const sx = N.Hs > 0 ? Hw * te + N.Hs * tO : Hw * te;
    const phiMtot = phiM + Htr_em * te + (N.H3 * (phiSt + sx + N.H1 * x)) / N.H2;
    rMt = (th * N.c1 + phiMtot) / N.c2;
    rMm = (rMt + th) / 2;
    rS = (Htr_ms * rMm + phiSt + sx + N.H1 * x) / N.dS;
    rA = (Htr_is * rS + N.Hve * te + phiIa) / N.dA;
  };
  const phi10 = 10 * Af;
  for (let pass = 0; pass < 2; pass++) {
    const i0 = pass === 0 ? 8760 - 336 : 0;   // pass 0: warm-up with late December
    for (let i = i0; i < 8760; i++) {
      te = Te[i];
      const o = occ[i];
      const hl = hod[i];
      const night = resid ? (hl >= 22 || hl < 6) : !o;
      const tH = night ? Tset - sb : Tset;
      const inAC = mixed && (acWrap ? hl >= acS || hl < acE : hl >= acS && hl < acE);
      const coolOn = coolOK && (mixed ? inAC : (resid || o));
      const openC = natRes && !coolOn && (!natCtrl || te < prevAir);
      N = openC ? NNat : o ? NOcc : NOff;
      tO = sU;
      const tOc = sU;   // the other zone's surface node as the cooled zone sees it this hour (cooling balance)
      const qint = o ? qintOcc : qintOff;
      const sw = hs * ws * Swin[i], so = hs * (Sop[i] + (1 - ws) * Swin[i]);
      const fsh = shadeOn && sw / awin > 250 && prevAir > 23 ? p.shadeCtrl : 1;
      const phiSolW = gEff * sw * fsh;
      let phiSol = phiSolW + radW * so - skyW;
      if (roofGHI) phiSol += radR * roofGHI[i] - skyR;
      phiIa0 = 0.5 * qint;
      phiSt = stFac * (0.5 * qint + phiSol);
      phiM = amAt * (0.5 * qint + phiSol);
      solve(0, thM);
      let phi = 0;
      const a0 = rA;
      const target = a0 < tH - 1e-6 ? tH : (coolOn && a0 > Tcool + 1e-6 ? Tcool : NaN);
      if (target === target) {            // not NaN
        solve(phi10, thM);                // ISO 13790 C.4.2: linear in Φ_HC
        phi = (phi10 * (target - a0)) / (rA - a0);
        solve(phi, thM);
      }
      thM = rMt;
      prevAir = rA;
      const zA = rA, zS = rS, zN = N;     // the (cooled) zone; the uncooled zone below reuses the solver
      let phiU = 0;
      if (twoZone) {
        const openU = hasNat && (!natCtrl || te < airU);
        N = openU ? UNat : o ? UOcc : UOff;
        tO = zS;
        solve(0, thMU);
        const b0 = rA;
        if (b0 < tH - 1e-6) { solve(phi10, thMU); phiU = (phi10 * (tH - b0)) / (rA - b0); solve(phiU, thMU); }
        thMU = rMt;
        sU = rS;
        airU = rA;
      }
      let pull = 0;
      if (xTrack) {
        // first AC hour after the AC was off: remove the moisture the room air took up (well-mixed air, no furnishings)
        if (coolOn && !acPrev && xRoom > xIn) { pull = pullK * (xRoom - xIn); if (cbOn && pass === 1) cbPullDx += xRoom - xIn; }
        const xeq = xOut[i] + (o && qlatOcc > 0 && zN.La > 0 ? qlatOcc / (LAT_PER_H * zN.La) : 0);
        xRoom = xeq + (xRoom - xeq) * zN.kx;
        if (coolOn && xRoom > xIn) xRoom = xIn;
        acPrev = coolOn;
      }
      if (pass === 0) continue;
      const m = MONTH_OF_HOUR[i];
      const thOp = 0.3 * zA + 0.7 * zS;
      if (!trop) {
        if (phi > 0) { heat += phi; mHeat[m] += phi; if (phi > peakH) peakH = phi; nHeatH++; }
        else if (phi < 0) { cool -= phi; mCool[m] -= phi; if (-phi > peakC) peakC = -phi; }
        if (o) { occHours++; if (thOp > 26) over26++; }
        if (keepHourly) { Tair[i] = zA; Top[i] = thOp; Qhc[i] = phi; }
      } else {
        // building loads: zone loads times their share (fc = 1 and phiU = 0 with one zone)
        const hC = phi > 0 ? fc * phi : 0, hU = phiU > 0 ? fu * phiU : 0, h = hC + hU;
        if (h > 0) { heat += h; mHeat[m] += h; if (h > peakH) peakH = h; nHeatH++; }
        const cs = phi < 0 ? -fc * phi : 0;
        let cl = 0;
        if (coolOn) {
          acHours++;
          if (latOn) {
            const dx = xOut ? xOut[i] - xIn : 0;
            cl = fc * ((dx > 0 ? zN.La * LAT_PER_H * dx : 0) + (o ? qlatOcc : 0)) + pull;
            if (cl > 0 && cs === 0) latOnly++;
          }
        }
        const c = cs + cl;
        if (c > 0) {
          cool += c; mCool[m] += c; coolS += cs; coolL += cl; mSens[m] += cs; mLat[m] += cl;
          if (c > peakC) peakC = c; if (cs > peakS) peakS = cs; if (cl > peakL) peakL = cl;
        }
        if (cbOn && coolOn) {
          const dT = te - Tcool, inUse = o || resid;
          cbN++; cbDT += dT; cbTe += te; if (o) cbOcc++;
          if (!cbPrev) { cbStarts++; cbStartT += a0; }   // free-running air temperature of the cooled zone at AC start
          cbVent += (zN.Hve - hveInf) * dT; cbHve += zN.Hve - hveInf;
          cbSolW += phiSolW; cbOpq += phiSol - phiSolW;
          if (!split) cbPeople += qint;
          else if (inUse) { cbPeople += qPeople; cbLight += pLight; cbEquip += pEquip; } else cbEquip += eBase * pEquip;
          if (twoZone) cbCu += HcC * (tOc - zS);
          cbAir += zN.La;
          if (latOn && xOut) { const dx = xOut[i] - xIn; if (dx > 0) { cbDx += dx; cbAirDx += zN.La * dx; } }
          if (latOn && o) cbLatInt += qlatOcc;
          cbPull += pull;
        }
        cbPrev = coolOn;
        if (o) { occHours++; if (thOp > 26) over26++; if (twoZone && 0.3 * airU + 0.7 * rS > 26) over26U++; }
        if (keepHourly) { Tair[i] = zA; Top[i] = thOp; Qhc[i] = h - cs; Qlat[i] = cl; if (TairU) TairU[i] = airU; }
      }
      if (detail && hday[i]) {
        // monthly-method convention: losses at the set-point temperature, gains counted in full, η = (L − Q_H) / G
        nHd++;
        if (phi > 0) heatHd += phi;
        const dT = tH > te ? tH - te : 0;
        sA += dT;
        infDT += hveInf * dT; ventDT += (zN.Hve - hveInf) * dT;
        gSol += phiSolW; gInt += qint; gOp += phiSol - phiSolW;
        for (let f = 0; f < nf; f++) { const aw = hs * ws * ctx.winArea[f]; if (aw > 0) solWin[f] += gEff * fsh * aw * ctx.irr.facade[f][i]; }
      }
    }
  }
  const kWh = (x) => x / 1000;
  const res = {
    annual: {
      heat: kWh(heat), cool: kWh(cool), peakHeat: peakH, peakCool: peakC,
      heatPerM2: kWh(heat) / Af, coolPerM2: kWh(cool) / Af, overheatHours: over26, occHours, heatingHours: nHeatH,
    },
    monthly: { heat: Array.from(mHeat, kWh), cool: Array.from(mCool, kWh) },
    H: { wall: Hwall, window: Hw, roof: Hroof, floor: Hfloor, tb: Htb, inf: hveInf, ventOcc: hveVentOcc },
  };
  if (trop) {
    // cooling split, electricity (kWh) and per m² of reference area
    const a = res.annual;
    Object.assign(a, {
      coolSens: kWh(coolS), coolLat: kWh(coolL), coolSensPerM2: kWh(coolS) / Af, coolLatPerM2: kWh(coolL) / Af,
      peakCoolSens: peakS, peakCoolLat: peakL, acHours, latOnlyHours: latOnly, coolFrac: coolOK ? fc : 0,
      overheatHoursUncooled: twoZone ? over26U : null,
    });
    const cop = p.COP_cool > 0 ? p.COP_cool : null;
    const mE = { cooling: [], lighting: [], equipment: [], other: [], total: [] };
    const other = (p.E_other || 0) * Af;   // kWh/a
    for (let m = 0; m < 12; m++) {
      const ec = cop ? kWh(mCool[m]) / cop : null;
      const el = kWh(pLight * ctx.occM[m]), ee = kWh(pEquip * (ctx.occM[m] + eBase * (ctx.hrsM[m] - ctx.occM[m]))), eo = (other * MDAYS[m]) / 365;
      mE.cooling.push(ec); mE.lighting.push(el); mE.equipment.push(ee); mE.other.push(eo); mE.total.push(cop ? ec + el + ee + eo : null);
    }
    const sum = (v) => (v.some((x) => x == null) ? null : v.reduce((s, x) => s + x, 0));
    const elec = { cooling: sum(mE.cooling), lighting: sum(mE.lighting), equipment: sum(mE.equipment), other: sum(mE.other), total: sum(mE.total) };
    a.elec = elec;
    a.elecPerM2 = Object.fromEntries(Object.entries(elec).map(([k, v]) => [k, v == null ? null : v / Af]));
    res.monthly.coolSens = Array.from(mSens, kWh);
    res.monthly.coolLat = Array.from(mLat, kWh);
    res.monthly.elec = mE;
    res.H.cu = Hcu;
    if (cbOn) {
      // cooling balance (header), kWh of the building; storage closes the sensible part, the latent part adds up exactly
      const k = (x) => kWh(fc * x);
      const sens = {
        wall: k(Hwall * cbDT), window: k(Hw * cbDT), roof: k(Hroof * cbDT), floor: k(Hfloor * cbDT), tb: k(Htb * cbDT),
        infiltration: k(hveInf * cbDT), ventilation: k(cbVent), solar: k(cbSolW), opaque: k(cbOpq),
        people: k(cbPeople), lighting: k(cbLight), equipment: k(cbEquip), partitions: k(cbCu),
      };
      sens.storage = kWh(coolS) - Object.values(sens).reduce((s, v) => s + v, 0);
      const lat = { infiltration: k(LAT_PER_H * hveInf * cbDx), ventilation: k(LAT_PER_H * (cbAirDx - hveInf * cbDx)), internal: k(cbLatInt), pulldown: kWh(cbPull) };
      res.coolBalance = {
        hours: cbN, occHours: cbOcc, sumDT: cbDT, meanTe: cbN ? cbTe / cbN : null, Tcool, fc, twoZone,
        starts: cbStarts, startT: cbStarts ? cbStartT / cbStarts : null, Cm: p.Cm,
        sensible: kWh(coolS), latent: kWh(coolL), sens, lat,
        H: res.H, A: { wall: Aop, window: Awin, roof: ctx.Aroof, floor: ctx.Afloor, env: Aenv, Vair, Af },
        // outdoor air in the AC hours (zone scale, before fc): infiltration and mean ventilation conductance in W/K (sensible,
        // and the latent air flow without heat recovery), Σ max(0, x_e − x_i) over the hours and weighted by the air flow,
        // the target x_i; at AC start Σ max(0, x_room − x_i)
        air: { Hinf: hveInf, Hvent: cbN ? cbHve / cbN : 0, HventLat: cbN ? cbAir / cbN - hveInf : 0, sumDx: cbDx, sumDxVent: cbAir - hveInf * cbN > 0 ? (cbAirDx - hveInf * cbDx) / ((cbAir - hveInf * cbN) / cbN) : 0, xIn, pullDx: cbPullDx },
        // window irradiation × area in the AC hours after shading and curtains, kWh (zone scale); gEff = g · (1 − F_F) · 0.9
        irrWin: gEff > 0 ? kWh(cbSolW / gEff) : 0, gEff, opaqueZone: kWh(cbOpq),
        rates: { people: qPeople, light: pLight, equip: pEquip, eBase },
      };
    }
  }
  if (detail) {
    // heat balance over all hours of heating days (daily mean outdoor temperature < 15 °C)
    const L = (H) => kWh(H * sA);
    const losses = { wall: L(Hwall), window: L(Hw), roof: L(Hroof), floor: L(Hfloor), tb: L(Htb), infiltration: kWh(infDT), ventilation: kWh(ventDT) };
    const gains = { solar: kWh(gSol), internal: kWh(gInt), opaque: kWh(gOp) };
    const Ltot = Object.values(losses).reduce((a, v) => a + v, 0), Gtot = gains.solar + gains.internal + gains.opaque;
    res.balance = { losses, gains, heatInPeriod: kWh(heatHd), utilisation: Gtot > 0 ? Math.max(0, Math.min(1, (Ltot - kWh(heatHd)) / Gtot)) : 0, heatingHours: nHd, meanDT: nHd ? sA / nHd : 0 };
    const mM = nHd ? sA / nHd : 0, mS = mM, sM = sA, sS = sA;
    const fl = {};
    const tb = p.dU_tb;
    ctx.model.facades.forEach((fa, f) => {
      const aw = hs * ws * ctx.winArea[f], ao = hs * (ctx.opArea[f] + (1 - ws) * ctx.winArea[f]);
      fl[fa.id] = {
        wall: kWh((p.U_wall + tb) * ao * sM), window: kWh(p.U_window * aw * sS), solar: kWh(solWin[f]),
        wallW: (p.U_wall + tb) * mM, winW: p.U_window * mS,
        winNetW: aw > 0 ? p.U_window * mS - solWin[f] / Math.max(1, nHd) / aw : null,
      };
    });
    fl.roof = { wall: kWh((p.F_roof * p.U_roof + tb) * ctx.Aroof * sM), wallW: (p.F_roof * p.U_roof + tb) * mM };
    fl.floor = { wall: kWh((p.F_floor * p.U_floor + tb) * ctx.Afloor * sM), wallW: (p.F_floor * p.U_floor + tb) * mM };
    res.facadeLoss = fl;
  }
  if (keepHourly) {
    res.hourly = { T_air: Tair, T_op: Top, Q_hc: Qhc };
    if (Qlat) res.hourly.Q_lat = Qlat;
    if (TairU) res.hourly.T_airU = TairU;
  }
  return res;
}
const HOD1 = Uint8Array.from({ length: 8760 }, (_, i) => (i + 1) % 24);

export function paramValues(model) {
  const p = {};
  for (const [k, v] of Object.entries(model.params)) p[k] = v.value;
  return p;
}

// ISO 13790:2008 simple hourly method (5R1C), Annex C, with the heating/cooling demand procedure of C.4.
//
// Split in two steps so the Bayesian calibration can rerun the thermal model thousands of times:
//   prepare(model, weather, shading)  → ctx: everything that does not depend on the uncertain parameters
//   run(ctx, p, opts)                 → results (CONTRACT §3 subset); p = plain object of parameter values
//
// Modelling choices (shown in the UI "方法" note):
// - Opaque solar gains and sky long-wave losses per ISO 13790 §11.3 (α 0.5 walls / 0.6 roof, R_se 0.04, h_r 4.1, Δθ_er 11 K).
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

import { daysOff, weekdayOf, TMY_YEAR } from './holidays.js';

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

// Operating schedule (local time = UTC + 1, no daylight saving). Non-residential profiles keep the days of use per
// year of the usage data: public holidays and, if needed, further days are off (js/holidays.js).
function schedules(profile, year) {
  const occ = new Uint8Array(8760);
  const yr = typeof year === 'number' ? year : TMY_YEAR;   // TMY: laid on 2018, which starts on a Monday
  const h0 = profile.start ?? 0, h1 = profile.end ?? 24, days = profile.daysPerWeek ?? 7;
  const off = daysOff(profile, yr);
  const wds = Uint8Array.from({ length: 366 }, (_, d) => weekdayOf(yr, Math.min(d, 364)));   // 1..7 Mon..Sun; file days (29 Feb dropped)
  for (let i = 0; i < 8760; i++) {
    const tl = i + 1;                       // local hour index
    const hl = tl % 24;
    const day = Math.floor(tl / 24);
    occ[i] = (h1 - h0 >= 24 ? 1 : (hl >= h0 && hl < h1 ? 1 : 0)) && wds[day] <= days && !off.has(day) ? 1 : 0;
  }
  return occ;
}

export function prepare(model, weather, irr, profile) {
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
  return {
    hday, winArea, opArea,
    model, weather, irr, profile,
    Te: weather.T, Swin, Sop, roofGHI: roofExposed ? weather.GHI : null,
    occ: schedules(profile, weather.year),
    Awin: A.window, Aop: A.opaqueWall, Aroof: A.roof, Afloor: A.groundFloor, Aenv: A.envelope,
    AN: A.netFloor, Vair: 0.8 * A.volume,
    residential: ['sfh', 'th', 'mfh', 'ab'].includes(model.usage),
  };
}

export function run(ctx, p, opts = {}) {
  const { Te, Swin, Sop, roofGHI, occ, hday } = ctx;
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
  const skyW = 0.5 * 0.04 * p.U_wall * 4.1 * 11 * Aop, skyR = roofGHI ? 1.0 * 0.04 * p.U_roof * 4.1 * 11 * ctx.Aroof : 0;
  const Tset = p.T_heat - (1 - p.heatedFrac) * 4;
  const hasCool = p.T_cool != null;
  const Tcool = hasCool ? p.T_cool : 0;
  const sb = p.setback || 0;
  const resid = ctx.residential;
  const qintOcc = p.Q_int * Af, qintOff = resid ? qintOcc : 0.1 * qintOcc;
  const amAt = Am / At, stFac = 1 - Am / At - Hw / (9.1 * At);
  const shadeOn = p.shadeCtrl < 1;
  // two ventilation states → precompute the network coefficients
  const mk = (Hve) => {
    const H1 = 1 / (1 / Hve + 1 / Htr_is), H2 = H1 + Hw, H3 = 1 / (1 / H2 + 1 / Htr_ms);
    return { Hve, H1, H2, H3, c1: Cm / 3600 - 0.5 * (H3 + Htr_em), c2: Cm / 3600 + 0.5 * (H3 + Htr_em), dS: Htr_ms + Hw + H1, dA: Htr_is + Hve };
  };
  const NOcc = mk(hveInf + hveVentOcc), NOff = mk(hveInf + hveVentOff);
  const keepHourly = !!opts.hourly, detail = !!opts.detail;
  const Tair = keepHourly ? new Float32Array(8760) : null, Top = keepHourly ? new Float32Array(8760) : null, Qhc = keepHourly ? new Float32Array(8760) : null;
  const mHeat = new Float64Array(12), mCool = new Float64Array(12);
  let heat = 0, cool = 0, peakH = 0, peakC = 0, over26 = 0, occHours = 0;
  let nHd = 0, heatHd = 0, sA = 0, gSol = 0, gInt = 0, gOp = 0, ventDT = 0, infDT = 0, nHeatH = 0;
  const nf = ctx.model.facades.length;
  const solWin = detail ? new Float64Array(nf) : null;
  let thM = 20, prevAir = 20;
  // per-hour solution (no allocation): results in rMt, rMm, rS, rA
  let rMt = 0, rMm = 0, rS = 0, rA = 0;
  let N = NOcc, te = 0, phiIa0 = 0, phiSt = 0, phiM = 0;
  const solve = (phiHC) => {
    const phiIa = phiIa0 + phiHC;
    const x = phiIa / N.Hve + te;
    const phiMtot = phiM + Htr_em * te + (N.H3 * (phiSt + Hw * te + N.H1 * x)) / N.H2;
    rMt = (thM * N.c1 + phiMtot) / N.c2;
    rMm = (rMt + thM) / 2;
    rS = (Htr_ms * rMm + phiSt + Hw * te + N.H1 * x) / N.dS;
    rA = (Htr_is * rS + N.Hve * te + phiIa) / N.dA;
  };
  const phi10 = 10 * Af;
  for (let pass = 0; pass < 2; pass++) {
    const i0 = pass === 0 ? 8760 - 336 : 0;   // pass 0: warm-up with late December
    for (let i = i0; i < 8760; i++) {
      te = Te[i];
      const o = occ[i];
      const hl = (i + 1) % 24;
      const night = resid ? (hl >= 22 || hl < 6) : !o;
      const tH = night ? Tset - sb : Tset;
      const coolOn = hasCool && (resid || o);
      N = o ? NOcc : NOff;
      const qint = o ? qintOcc : qintOff;
      const sw = hs * ws * Swin[i], so = hs * (Sop[i] + (1 - ws) * Swin[i]);
      const fsh = shadeOn && sw / awin > 250 && prevAir > 23 ? p.shadeCtrl : 1;
      const phiSolW = gEff * sw * fsh;
      let phiSol = phiSolW + radW * so - skyW;
      if (roofGHI) phiSol += radR * roofGHI[i] - skyR;
      phiIa0 = 0.5 * qint;
      phiSt = stFac * (0.5 * qint + phiSol);
      phiM = amAt * (0.5 * qint + phiSol);
      solve(0);
      let phi = 0;
      const a0 = rA;
      const target = a0 < tH - 1e-6 ? tH : (coolOn && a0 > Tcool + 1e-6 ? Tcool : NaN);
      if (target === target) {            // not NaN
        solve(phi10);                     // ISO 13790 C.4.2: linear in Φ_HC
        phi = (phi10 * (target - a0)) / (rA - a0);
        solve(phi);
      }
      thM = rMt;
      prevAir = rA;
      if (pass === 0) continue;
      const m = MONTH_OF_HOUR[i];
      if (phi > 0) { heat += phi; mHeat[m] += phi; if (phi > peakH) peakH = phi; nHeatH++; }
      else if (phi < 0) { cool -= phi; mCool[m] -= phi; if (-phi > peakC) peakC = -phi; }
      const thOp = 0.3 * rA + 0.7 * rS;
      if (o) { occHours++; if (thOp > 26) over26++; }
      if (keepHourly) { Tair[i] = rA; Top[i] = thOp; Qhc[i] = phi; }
      if (detail && hday[i]) {
        // monthly-method convention: losses at the set-point temperature, gains counted in full, η = (L − Q_H) / G
        nHd++;
        if (phi > 0) heatHd += phi;
        const dT = tH > te ? tH - te : 0;
        sA += dT;
        infDT += hveInf * dT; ventDT += (N.Hve - hveInf) * dT;
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
  if (keepHourly) res.hourly = { T_air: Tair, T_op: Top, Q_hc: Qhc };
  return res;
}

export function paramValues(model) {
  const p = {};
  for (const [k, v] of Object.entries(model.params)) p[k] = v.value;
  return p;
}

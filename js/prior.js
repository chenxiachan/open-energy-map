// The prior Monte Carlo of one building and the split of its variance by input. Shared by the app (js/main.js, the
// "Where the uncertainty comes from" card and the lab) and the offline city tools (tools/uncertainty_pilot.mjs), so the
// city-scale figures come from exactly the method of the panel.
import { makePrior, rng } from './archetype.js';
import { run } from './rc5.js';
import { finalEnergy } from './systems.js';

// Prior Monte Carlo. `cond` fixes the age class to the one the point value uses, so the point sits inside it; the full
// prior adds the uncertainty about the age itself. If the age is known (OSM tag or user), both are the same.
export function priorMC({ model, ageInfo, state, assigned, ctx }, n, seeds = [42, 43]) {
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.round(p * (s.length - 1))]; };
  const sample = (state, seed) => {
    const draw = makePrior(model, ageInfo, state, assigned);
    const r = rng(seed);
    const heat = [], fin = [], co2 = [], monthly = Array.from({ length: 12 }, () => []), xs = [];
    for (let i = 0; i < n; i++) {
      const d = draw(r);
      const rr = run(ctx, d.p);
      const fe = finalEnergy(rr, d.p, ctx);
      heat.push(rr.annual.heatPerM2); fin.push(fe.perM2); co2.push(fe.co2);
      rr.monthly.heat.forEach((v, m) => monthly[m].push(v));
      xs.push({ ...d.p, ageClass: d.ageClass });
    }
    const t = (a) => [q(a, 0.1), q(a, 0.5), q(a, 0.9)];
    return { heat: t(heat), fin: t(fin), co2: t(co2), monthly: monthly.map((a) => [q(a, 0.1), q(a, 0.9)]), draws: { xs, heat } };
  };
  const full = sample(state, seeds[0]);
  const ageKnown = !!state.ageClass || ageInfo.kind === 'osm' || Math.max(...Object.values(ageInfo.p)) > 0.97;
  full.cond = ageKnown ? null : sample({ ...state, ageClass: assigned.cls }, seeds[1]);
  return full;
}

// ---------- where the uncertainty comes from ----------
// First-order share of each sampled input in the variance of heating demand: the correlation ratio η² over 8 quantile
// bins (bias-corrected). Inputs that depend on the age class are read from the sample with the age fixed and scaled
// by the share left after the age, whose own share is the between-class variance of the full prior. Approximate.
export const VAR_INPUTS = { U_wall: 'U_wall', U_window: 'U_window', U_roof: 'U_roof', U_floor: 'U_floor', g_window: 'g_window', n50: 'n50', dU_tb: 'dU_tb', T_heat: 'T_heat', heatedFrac: 'heatedFrac', n_vent: 'n_vent', Q_int: 'Q_int', wwrScale: 'WWR_S', hScale: null, anScale: null, eta_sys: 'eta_sys' };
// The same inputs grouped by the kind of information that would narrow them: the construction age (records), the
// envelope and its refurbishment (energy certificate, site visit), geometry defaults (window share, storeys, reference
// area: photos, LoD2, BIM) and use and operation (occupancy, metering). eta_sys acts on final energy only.
export const VAR_CLASS = { age: 'age', U_wall: 'envelope', U_window: 'envelope', U_roof: 'envelope', U_floor: 'envelope', g_window: 'envelope', n50: 'envelope', dU_tb: 'envelope', wwrScale: 'geometry', hScale: 'geometry', anScale: 'geometry', T_heat: 'usage', n_vent: 'usage', Q_int: 'usage', heatedFrac: 'usage', eta_sys: 'system' };
export const CLASSES = ['age', 'envelope', 'geometry', 'usage'];
export function classShares(shares) {
  const o = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const it of shares) { const c = VAR_CLASS[it.key]; if (c in o) o[c] += it.share; }
  return o;
}
export function varShares(pr) {
  const vr = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1); };
  const base = pr.cond || pr, y = base.draws.heat, N = y.length, vy = vr(y);
  let ageShare = 0;   // between-class share of the full prior: Var(E[y | age]) / Var(y), bias-corrected
  if (pr.cond) {
    const yf = pr.draws.heat, mf = yf.reduce((a, b) => a + b, 0) / yf.length, g = {};
    pr.draws.xs.forEach((d, i) => { (g[d.ageClass] = g[d.ageClass] || []).push(yf[i]); });
    const G = Object.keys(g).length, between = Object.values(g).reduce((a, v) => a + v.length * (v.reduce((x, y2) => x + y2, 0) / v.length - mf) ** 2, 0);
    const eta2 = between / ((yf.length - 1) * vr(yf) || 1), bias = (G - 1) / (yf.length - 1);
    ageShare = G > 1 ? Math.max(0, (eta2 - bias) / (1 - bias)) : 0;
  }
  const out = [];
  if (ageShare > 0.005) out.push({ key: 'age', share: ageShare });
  const my = y.reduce((a, b) => a + b, 0) / N;
  for (const [k, row] of Object.entries(VAR_INPUTS)) {
    const x = base.draws.xs.map((d) => d[k]);
    if (x.some((v) => typeof v !== 'number') || vr(x) < 1e-12) continue;
    const idx = x.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), G = 8, sum = new Array(G).fill(0), cnt = new Array(G).fill(0);
    idx.forEach(([, i], r) => { const g = Math.min(G - 1, Math.floor((r * G) / N)); sum[g] += y[i]; cnt[g]++; });
    let between = 0; for (let g = 0; g < G; g++) if (cnt[g]) between += cnt[g] * (sum[g] / cnt[g] - my) ** 2;
    const eta2 = between / ((N - 1) * vy || 1), bias = (G - 1) / (N - 1);
    const share = Math.max(0, (eta2 - bias) / (1 - bias)) * (1 - ageShare);
    if (share > 0.005) out.push({ key: k, row, share });
  }
  return out.sort((a, b) => b.share - a.share);
}

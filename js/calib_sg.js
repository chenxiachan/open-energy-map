// Bill calibration and retrofit draws for Singapore: the work of js/calib_sg.worker.js, also run in Node by
// tests/sg_calib_retro.mjs. Same method as the Munich worker (js/calib.worker.js): adaptive-tempering SMC with pCN moves
// in the latent space of the prior.
//
// Every prior draw of js/archetype_sg.js makePrior is a deterministic map g(z) of a latent vector z ~ N(0, I): draw(r)
// asks r.n() for normal and r.u() for uniform numbers, and latentStream(z) answers the k-th call with z[k] or Φ(z[k]).
// The pCN proposal z' = √(1 − β²) z + β ξ leaves N(0, I) invariant, so the acceptance ratio is the likelihood ratio alone
// and the prior (era → envelope of the era, cooling system → its COP, every input's two-piece normal) is kept exactly.
// The page's results (model_sg.js priorMC) are untouched: they draw with archetype_sg.js rng as before.
//
// What the bill covers (meas.scope, chosen on the page): 'building' = the whole building (non-residential buildings and
// landed houses: res.monthly.elec.total); 'block' = the households of an HDB block or condominium (the model has no common
// property, which the Town Council or MCST pays, so this is res.monthly.elec.total too); 'flat' = one dwelling: the model's
// electricity per m² × the floor area of the flat (meas.area). Months: calendar months, or (meas.lag) meter-reading
// periods that end mid-month, model'(m) = ½ model(m) + ½ model(m − 1), January taking December of the same weather year,
// as the EMA calibration (data/sg/calib_residential.json billingKernelMonths 0.5). The weather files have 8,760 hours, so
// in a leap year (meas.leap) February is scaled by 29/28. Likelihood: relative error σ (model and metering), on the annual
// total, or per month with a floor of 4 % of the annual total, as in Munich.
import * as SG from './archetype_sg.js';
import * as MS from './model_sg.js';
import * as RT from './retrofit_sg.js';

function Phi(x) {   // standard normal CDF (Abramowitz and Stegun 26.2.17), as calib.worker.js
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
export function latentStream(z) {
  let k = 0;
  return { u: () => Math.min(1 - 1e-9, Math.max(1e-9, Phi(z[k++ % z.length]))), n: () => z[k++ % z.length] };
}
// the number of random numbers one draw takes (it can differ by era and system): the latent dimension
export function latentDim(draw, n = 60) {
  const r = SG.rng(5);
  let c = 0, most = 0;
  const cr = { u: () => { c++; return r.u(); }, n: () => { c++; return r.n(); } };
  for (let i = 0; i < n; i++) { c = 0; draw(cr); most = Math.max(most, c); }
  return most + 2;
}

// msg: { A, m, shading, weather, holidays, eraInfo, asg, bca, state, gef } (the page posts its model, js/sg_app.js)
export function setup(msg) {
  if (msg.A) SG.setArchetypes(msg.A);
  const A = SG.archetypes();
  const cals = MS.calendars(msg.holidays || {}, A);
  const sim = MS.simulate(msg.m, msg.weather, cals, { shading: msg.shading });
  const state = msg.state || { user: {} };
  const draw = SG.makePrior(msg.m, msg.eraInfo, state, msg.asg, { bca: msg.bca });
  return { A, m: msg.m, b: { m: msg.m, eraInfo: msg.eraInfo, asg: msg.asg, bca: msg.bca }, sim, ctx: sim.ctx, draw, gef: msg.gef, state };
}

// the bill of one run in the terms of meas (see the header)
export function billOf(meas, ctx, p, rr) {
  const af = Math.max(1, ctx.AN * (p.hScale ?? 1) * (p.anScale ?? 1)), k = meas.scope === 'flat' ? meas.area / af : 1;
  let mon = Array.from(rr.monthly.elec.total, (v) => v * k);
  if (meas.leap) mon[1] *= 29 / 28;
  if (meas.lag) { const a = mon.slice(); mon = a.map((v, i) => 0.5 * v + 0.5 * a[(i + 11) % 12]); }
  return { monthly: mon, annual: mon.reduce((s, v) => s + v, 0), k };
}

const q3 = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const q = (f) => (s.length ? s[Math.round(f * (s.length - 1))] : null); return [q(0.1), q(0.5), q(0.9)]; };
// the inputs the posterior is shown for: every drawn input with a spread, and the geometry factors of the prior
export const GEOM_KEYS = ['wwrScale', 'hScale', 'anScale'];
function drawnKeys(os) {
  const keys = [...SG.UNCERTAIN.filter((k) => k !== 'WWR'), ...GEOM_KEYS];
  return keys.filter((k) => { const v = os.map((o) => o.d.p[k]).filter(Number.isFinite); if (v.length < os.length / 2) return false; const mn = Math.min(...v), mx = Math.max(...v); return mx - mn > 1e-9 * Math.max(1, Math.abs(mx)); });
}
function summary(os) {
  const share = (f) => { const o = {}; for (const x of os) { const k = f(x); o[k] = (o[k] || 0) + 1 / os.length; } return o; };
  return {
    annual: q3(os.map((o) => o.bill.annual)), monthly: Array.from({ length: 12 }, (_, m) => q3(os.map((o) => o.bill.monthly[m]))),
    elecPerM2: q3(os.map((o) => o.s.elec.total)), cool: q3(os.map((o) => o.s.cool)), co2t: q3(os.map((o) => o.s.co2t)), elecMWh: q3(os.map((o) => o.s.elecKWh / 1000)),
    use: Object.fromEntries(['cooling', 'lighting', 'equipment', 'other'].map((k) => [k, q3(os.map((o) => o.s.elec[k]))])),
    ages: share((o) => o.d.ageClass || '–'), systems: share((o) => o.d.system || '–'),
  };
}

// adaptive-tempering SMC; onProgress({ stage, phi, ess, acc }) between the steps
export function calibrate(msg, onProgress = () => {}) {
  const C = setup(msg), { m, ctx, draw, gef } = C, meas = msg.meas;
  const N = msg.N || 900, R = SG.rng(msg.seed || 11), ZD = latentDim(draw);
  const sim = (z) => {
    const d = draw(latentStream(z)), rr = MS.runModel(m, ctx, d.p), s = MS.summarize(m, ctx, d.p, rr, gef);
    return { d, s, bill: billOf(meas, ctx, d.p, rr) };
  };
  const sig = meas.sigmaRel || 0.15, vals = meas.values, annualMeas = vals.reduce((s, v) => s + (v || 0), 0);
  const loglik = (o) => {
    if (meas.kind === 'monthly') {
      let s = 0;
      for (let k = 0; k < 12; k++) {
        if (vals[k] == null || Number.isNaN(vals[k])) continue;
        const sd = sig * Math.max(vals[k], 0.04 * annualMeas);
        s += ((o.bill.monthly[k] - vals[k]) / sd) ** 2;
      }
      return -0.5 * s;
    }
    return -0.5 * ((o.bill.annual - annualMeas) / (sig * annualMeas)) ** 2;
  };
  let Z = [], Lk = [], O = [];
  for (let i = 0; i < N; i++) {
    const z = new Float64Array(ZD); for (let k = 0; k < ZD; k++) z[k] = R.n();
    const o = sim(z); Z.push(z); O.push(o); Lk.push(loglik(o));
  }
  const priorO = O.slice(0, Math.min(N, 600));
  let phi = 0, stage = 0, lastEss = N, lastAcc = null;
  const essOf = (lw) => { let mx = -Infinity; for (const v of lw) if (v > mx) mx = v; let s = 0, s2 = 0; for (const v of lw) { const w = Math.exp(v - mx); s += w; s2 += w * w; } return (s * s) / s2; };
  while (phi < 1 && stage < 12) {
    stage++;
    let lo = phi, hi = 1;
    const essAt = (ph) => essOf(Lk.map((l) => (ph - phi) * l));
    if (essAt(1) < N / 2) { for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (essAt(mid) >= N / 2) lo = mid; else hi = mid; } hi = Math.max(lo, phi + 1e-4); }
    const nphi = Math.min(1, hi);
    const logw = Float64Array.from(Lk, (l) => (nphi - phi) * l);
    const ess = essOf(logw);
    phi = nphi; lastEss = ess;
    onProgress({ stage, phi, ess });
    let mx = -Infinity; for (const v of logw) if (v > mx) mx = v;
    const w = Array.from(logw, (v) => Math.exp(v - mx)), sw = w.reduce((a, b) => a + b, 0);
    const idx = [];
    let c = w[0] / sw, j = 0;
    const u0 = R.u() / N;
    for (let i = 0; i < N; i++) { const uu = u0 + i / N; while (uu > c && j < N - 1) { j++; c += w[j] / sw; } idx.push(j); }
    Z = idx.map((k) => Z[k].slice()); Lk = idx.map((k) => Lk[k]); O = idx.map((k) => O[k]);
    let beta = 0.25, acc = 0, tot = 0;
    const nMoves = phi >= 1 ? 3 : 2;
    for (let mv = 0; mv < nMoves; mv++) {
      for (let i = 0; i < N; i++) {
        const zp = new Float64Array(ZD), a = Math.sqrt(1 - beta * beta);
        for (let k = 0; k < ZD; k++) zp[k] = a * Z[i][k] + beta * R.n();
        const op = sim(zp), lp = loglik(op);
        tot++;
        if (Math.log(R.u()) < phi * (lp - Lk[i])) { Z[i] = zp; Lk[i] = lp; O[i] = op; acc++; }
      }
      lastAcc = acc / tot;
      beta = Math.max(0.05, Math.min(0.9, beta * (lastAcc > 0.3 ? 1.3 : 0.75)));
      onProgress({ stage, phi, ess, acc: lastAcc });
    }
  }
  const postO = O.slice(0, Math.min(N, 600));
  const keys = drawnKeys(priorO);
  const arr = (os) => Object.fromEntries(keys.map((k) => [k, os.map((o) => o.d.p[k])]));
  return {
    N, stages: stage, ess: lastEss, acc: lastAcc, zdim: ZD, meas, gef,
    prior: summary(priorO), post: summary(O),
    params: { keys, prior: arr(priorO), post: arr(postO) },
    // the posterior particles for the page (model_sg.js particleMC) and the retrofit tab
    particles: O.slice(0, Math.min(N, 300)).map((o) => ({ p: o.d.p, ageClass: o.d.ageClass, system: o.d.system })),
  };
}

// the retrofit measures on given draws (the posterior particles) or on N prior draws with the seed of priorMC (42), so the
// base is the distribution the page shows
export function retroJob(msg) {
  const C = setup(msg), { A, m, ctx, sim, gef } = C;
  const sc2 = RT.shadingSC2(A, m, sim.irr);
  const list = RT.measures(A, m, { sc2, P_light: m.params.P_light?.value });
  let draws = msg.particles;
  if (!draws) { const r = SG.rng(msg.seed || 42); draws = Array.from({ length: msg.N || 300 }, () => C.draw(r)); }
  const u = Object.entries(msg.state?.user || {}).filter(([k, v]) => v != null && Number.isFinite(+v) && m.params[k]);
  if (msg.particles && u.length) draws = draws.map((d) => ({ ...d, p: { ...d.p, ...Object.fromEntries(u.map(([k, v]) => [k, +v])) } }));
  const rows = draws.map((d) => RT.evalDraw(A, m, ctx, d, list, gef));
  return { stats: RT.retroStats(rows, list), ids: list.map((x) => x.id), sc2, n: rows.length, posterior: !!msg.particles };
}

// Bayesian calibration against energy bills: adaptive-tempering SMC with pCN moves in the latent space of the prior.
//
// Every prior draw is a deterministic map g(z) of a latent vector z ~ N(0, I) (uniform draws use Φ(z)). The pCN
// proposal z' = √(1−β²) z + β ξ leaves N(0, I) invariant, so the acceptance ratio is the likelihood ratio only and
// the hierarchical prior (age class → modernised components → U-values → behaviour) is respected exactly.
//
// message in:  { model, weather, ageInfo, state, archetypes, meas, N, seed, scenarioSet }
//   meas = { kind: 'annual' | 'monthly', values: [kWh] (1 or 12), includesDhw, system, sigmaRel, emitter }
// messages out: { type: 'progress', stage, phi, ess } … { type: 'done', result }

// The modules are imported dynamically. Some of them use top-level await (js/osmdefaults.js loads its JSON), and with
// static imports the onmessage handler below would only be installed after that await. A message posted right after
// `new Worker()` can then be dispatched before the handler exists and is lost, which leaves the page waiting forever.
// With dynamic imports this module has no dependencies, installs the handler at once, and waits for `ready` inside it.
let computeShading, facadeIrradiance, prepare, run, setFactors, finalEnergy, monthlyMeanT, makePrior, UNCERTAIN, makeRng, Arch, scenarios;
const ready = Promise.all([import('./solar.js'), import('./rc5.js'), import('./systems.js'), import('./archetype.js'), import('./retrofit.js')])
  .then(([so, rc, sy, ar, re]) => {
    ({ computeShading, facadeIrradiance } = so);
    ({ prepare, run } = rc);
    ({ setFactors, finalEnergy, monthlyMeanT } = sy);
    Arch = ar; ({ makePrior, UNCERTAIN } = ar); makeRng = ar.rng;
    ({ scenarios } = re);
  });

const ZDIM = 40;

function Phi(x) { // standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
function latentStream(z) {
  let k = 0;
  return { u: () => Math.min(1 - 1e-9, Math.max(1e-9, Phi(z[k++ % ZDIM]))), n: () => z[k++ % ZDIM] };
}

self.onmessage = async (ev) => {
  try {
    await ready;
    const out = await calibrate(ev.data);
    self.postMessage({ type: 'done', result: out });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.stack || e) });
  }
};

async function calibrate(msg) {
  const { model, weather, ageInfo, state, archetypes, meas } = msg;
  const N = msg.N || 1000;
  const R = makeRng(msg.seed || 7);
  // archetype module keeps its data in module state: inject it
  await injectArchetypes(archetypes);
  setFactors(archetypes);
  const shading = computeShading(model);
  const irr = facadeIrradiance(model, weather, shading);
  const prof = Arch.profileFor(model);
  const ctx = prepare(model, weather, irr, prof);
  const assigned = { prof };
  const draw = makePrior(model, ageInfo, state, assigned);
  const tm = monthlyMeanT(weather.T);
  const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const sim = (z) => {
    const d = draw(latentStream(z));
    if (meas && meas.system) d.p.system = meas.system;
    const r = run(ctx, d.p);
    const fe = finalEnergy(r, d.p, ctx, { emitter: meas && meas.emitter });
    // monthly final energy: heating per month scaled by the annual final/useful ratio of heating, DHW spread by days
    const hRatio = r.annual.heat > 0 ? fe.heat / r.annual.heat : 0;
    const withDhw = meas ? meas.includesDhw : true;
    const monthly = r.monthly.heat.map((q, m) => q * hRatio + (withDhw ? (fe.dhw * DAYS[m]) / 365 : 0));
    const annual = monthly.reduce((s, v) => s + v, 0);
    return { d, r, fe, monthly, annual };
  };
  const sig = meas ? (meas.sigmaRel || 0.15) : 0.15;
  const vals = meas ? meas.values : [0];
  const annualMeas = vals.reduce((s, v) => s + (v || 0), 0);
  const loglik = (o) => {
    if (!meas) return 0;
    if (meas.kind === 'monthly') {
      let s = 0;
      for (let m = 0; m < 12; m++) {
        if (vals[m] == null || Number.isNaN(vals[m])) continue;
        const sd = sig * Math.max(vals[m], 0.04 * annualMeas);
        s += ((o.monthly[m] - vals[m]) / sd) ** 2;
      }
      return -0.5 * s;
    }
    return -0.5 * ((o.annual - annualMeas) / (sig * annualMeas)) ** 2;
  };

  // ---- initial particles from the prior
  let Z = [], L = [], O = [];
  for (let i = 0; i < N; i++) {
    const z = new Float64Array(ZDIM); for (let k = 0; k < ZDIM; k++) z[k] = R.n();
    const o = sim(z); Z.push(z); O.push(o); L.push(loglik(o));
  }
  const priorO = O.slice(0, Math.min(N, 600));
  const priorSummary = summarise(priorO);
  // ---- adaptive tempering
  let phi = 0, stage = 0;
  let logw = new Float64Array(N);
  const essOf = (lw) => { const m = Math.max(...lw); let s = 0, s2 = 0; for (const v of lw) { const w = Math.exp(v - m); s += w; s2 += w * w; } return (s * s) / s2; };
  if (!meas) phi = 1; // prior only: no tempering, no moves
  while (phi < 1 && stage < 12) {
    stage++;
    // bisection for next phi with ESS ≈ N/2
    let lo = phi, hi = 1;
    const essAt = (ph) => essOf(L.map((l) => (ph - phi) * l));
    if (essAt(1) >= N / 2) hi = 1; else { for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (essAt(mid) >= N / 2) lo = mid; else hi = mid; } hi = Math.max(lo, phi + 1e-4); }
    const nphi = Math.min(1, hi);
    logw = Float64Array.from(L, (l) => (nphi - phi) * l);
    const ess = essOf(logw);
    phi = nphi;
    self.postMessage({ type: 'progress', stage, phi, ess });
    // resample (systematic)
    const m = Math.max(...logw);
    const w = Array.from(logw, (v) => Math.exp(v - m));
    const sw = w.reduce((a, b) => a + b, 0);
    const idx = [];
    let u0 = R.u() / N, c = w[0] / sw, j = 0;
    for (let i = 0; i < N; i++) { const uu = u0 + i / N; while (uu > c && j < N - 1) { j++; c += w[j] / sw; } idx.push(j); }
    Z = idx.map((k) => Z[k].slice()); L = idx.map((k) => L[k]); O = idx.map((k) => O[k]);
    // pCN moves
    let beta = 0.25, acc = 0, tot = 0;
    const nMoves = phi >= 1 ? 3 : 2;
    for (let mv = 0; mv < nMoves; mv++) {
      for (let i = 0; i < N; i++) {
        const zp = new Float64Array(ZDIM);
        const a = Math.sqrt(1 - beta * beta);
        for (let k = 0; k < ZDIM; k++) zp[k] = a * Z[i][k] + beta * R.n();
        const op = sim(zp), lp = loglik(op);
        tot++;
        if (Math.log(R.u()) < phi * (lp - L[i])) { Z[i] = zp; L[i] = lp; O[i] = op; acc++; }
      }
      const rate = acc / tot;
      beta = Math.max(0.05, Math.min(0.9, beta * (rate > 0.3 ? 1.3 : 0.75)));
      self.postMessage({ type: 'progress', stage, phi, ess, acc: rate });
    }
  }
  const postSummary = summarise(O.slice(0, Math.min(N, 600)));

  // ---- component losses (detail runs) prior vs posterior on subsamples
  const detail = (os, n) => os.slice(0, n).map((o) => run(ctx, o.d.p, { detail: true }).balance.losses);
  const priorLoss = detail(priorO, 150);
  const postLoss = detail(O, 150);

  // ---- retrofit savings over posterior (and prior) particles
  const sc = scenarios(archetypes, model);
  const retro = (os, n) => os.slice(0, n).map((o) => {
    const base = o.fe.total;
    const co2b = o.fe.co2;
    return Object.fromEntries(sc.map((s) => {
      const p2 = s.apply(o.d.p);
      const r2 = run(ctx, p2, { hourly: p2.system.startsWith('hp') });
      const f2 = finalEnergy(r2, p2, ctx, { emitter: meas && meas.emitter });
      return [s.id, { dFinal: base - f2.total, dRel: base > 0 ? (base - f2.total) / base : 0, dCo2: co2b - f2.co2 }];
    }));
  });
  const postRetro = retro(O, 300);
  const priorRetro = retro(priorO, 300);
  // ---- what to measure: first-order sensitivity of the deep-retrofit saving within the posterior
  const target = postRetro.map((r) => r.deep.dFinal);
  const sens = {};
  for (const k of UNCERTAIN) sens[k] = firstOrder(O.slice(0, 300).map((o) => o.d.p[k]), target);
  sens.ageClass = firstOrderCat(O.slice(0, 300).map((o) => o.d.ageClass), target);

  return {
    N, stages: stage, meas,
    prior: priorSummary, post: postSummary,
    priorLoss: lossStats(priorLoss), postLoss: lossStats(postLoss),
    priorRetro: retroStats(priorRetro, sc), postRetro: retroStats(postRetro, sc),
    sens,
    params: { prior: paramArrays(priorO), post: paramArrays(O) },
    corr: corrMatrix(O),
  };
}

function summarise(os) {
  const ann = os.map((o) => o.annual).sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  const monthly = Array.from({ length: 12 }, (_, m) => { const v = os.map((o) => o.monthly[m]).sort((a, b) => a - b); return [q(v, 0.1), q(v, 0.5), q(v, 0.9)]; });
  const ages = {};
  for (const o of os) ages[o.d.ageClass] = (ages[o.d.ageClass] || 0) + 1 / os.length;
  const modern = {};
  for (const c of ['windows', 'wall', 'roof', 'floor']) modern[c] = os.reduce((s, o) => s + (o.d.modern[c] ? 1 : 0), 0) / os.length;
  const heatUse = os.map((o) => o.r.annual.heatPerM2).sort((a, b) => a - b);
  return { annual: [q(ann, 0.1), q(ann, 0.5), q(ann, 0.9)], monthly, ages, modern, heatPerM2: [q(heatUse, 0.1), q(heatUse, 0.5), q(heatUse, 0.9)] };
}

function lossStats(arr) {
  const keys = Object.keys(arr[0] || {});
  const out = {};
  for (const k of keys) { const v = arr.map((a) => a[k]).sort((x, y) => x - y); out[k] = [v[Math.round(0.1 * (v.length - 1))], v[Math.round(0.5 * (v.length - 1))], v[Math.round(0.9 * (v.length - 1))]]; }
  return out;
}
function retroStats(arr, sc) {
  const out = {};
  for (const s of sc) {
    const v = arr.map((a) => a[s.id].dFinal).sort((x, y) => x - y), rv = arr.map((a) => a[s.id].dRel).sort((x, y) => x - y), cv = arr.map((a) => a[s.id].dCo2).sort((x, y) => x - y);
    const q = (a, p) => a[Math.round(p * (a.length - 1))];
    out[s.id] = { label: s.label, note: s.note, dFinal: [q(v, 0.1), q(v, 0.5), q(v, 0.9)], dRel: [q(rv, 0.1), q(rv, 0.5), q(rv, 0.9)], dCo2: [q(cv, 0.1), q(cv, 0.5), q(cv, 0.9)] };
  }
  return out;
}
function paramArrays(os) {
  const out = {};
  for (const k of UNCERTAIN) out[k] = os.map((o) => o.d.p[k]);
  return out;
}
function firstOrder(x, y, bins = 8) {
  const n = x.length; const idx = [...x.keys()].sort((a, b) => x[a] - x[b]);
  const my = y.reduce((s, v) => s + v, 0) / n; const vy = y.reduce((s, v) => s + (v - my) ** 2, 0) / n;
  if (vy <= 0) return 0;
  let vb = 0;
  for (let b = 0; b < bins; b++) {
    const sl = idx.slice(Math.floor((b * n) / bins), Math.floor(((b + 1) * n) / bins));
    if (!sl.length) continue;
    const m = sl.reduce((s, i) => s + y[i], 0) / sl.length;
    vb += (sl.length / n) * (m - my) ** 2;
  }
  return Math.max(0, Math.min(1, vb / vy));
}
function firstOrderCat(x, y) {
  const n = x.length; const my = y.reduce((s, v) => s + v, 0) / n; const vy = y.reduce((s, v) => s + (v - my) ** 2, 0) / n;
  if (vy <= 0) return 0;
  const g = {};
  x.forEach((c, i) => { (g[c] = g[c] || []).push(y[i]); });
  let vb = 0;
  for (const v of Object.values(g)) { const m = v.reduce((s, a) => s + a, 0) / v.length; vb += (v.length / n) * (m - my) ** 2; }
  return Math.max(0, Math.min(1, vb / vy));
}
function corrMatrix(os) {
  const keys = UNCERTAIN;
  const X = keys.map((k) => os.map((o) => (k.startsWith('U_') || k === 'n50' || k === 'n_vent' || k === 'Q_int' ? Math.log(Math.max(1e-6, o.d.p[k])) : o.d.p[k])));
  const n = os.length;
  const mean = X.map((v) => v.reduce((s, a) => s + a, 0) / n);
  const sd = X.map((v, i) => Math.sqrt(v.reduce((s, a) => s + (a - mean[i]) ** 2, 0) / n) || 1);
  const C = keys.map((_, i) => keys.map((__, j) => X[i].reduce((s, a, t) => s + (a - mean[i]) * (X[j][t] - mean[j]), 0) / n / (sd[i] * sd[j])));
  return { keys, C };
}

async function injectArchetypes(A) {
  // archetype.js loads via fetch; in the worker we already have the JSON, so prime its cache through a data URL
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(A));
  await Arch.loadArchetypes(url);
}

// Value of information for one building: how much would the P10–P90 of heating demand per m² narrow if a data source
// told the model the inputs it knows? Expected value of partial information on the model's own prior, as
// tools/voi_pilot.mjs: draw a "true" version of the building from its prior (with everything the user has entered kept),
// fix the inputs of the source to that truth, sample the rest, take the P10–P90 width; average over T truths. The heat
// meter reading fixes no input: it weights the draws by the likelihood of the truth's reading. Used by the building card
// "Which data would narrow the range most" (js/voi.worker.js); safe in Node.
import { makePrior, latentPosterior, rng } from './archetype.js';
import { run } from './rc5.js';
import { finalEnergy } from './systems.js';

// what each source tells the model; 'age' fixes the age class, 'refurb' whether each component was refurbished
export const SOURCES = {
  age: ['age'],
  refurb: ['refurb'],
  bimConstr: ['U_wall', 'U_roof', 'U_floor', 'U_window', 'g_window', 'refurb', 'age'],
  bimGeom: ['hScale', 'anScale', 'heatedFrac'],
  windows: ['wwrScale'],
  onsite: ['n50', 'dU_tb'],
  metered: ['T_heat', 'n_vent', 'Q_int'],
};
export const PAIRS = [['age', 'refurb'], ['age', 'metered'], ['refurb', 'metered'], ['refurb', 'onsite'], ['onsite', 'metered'], ['bimConstr', 'metered'], ['bimConstr', 'onsite']];
export const keysOf = (k) => [...new Set(k.split('+').flatMap((x) => SOURCES[x] || []))];
// one year of metered final energy (heating and hot water), lognormal error against the model: metering, weather
// correction, the hot-water split, model structure (the bill calibration of the app uses 15 % as well)
export const SIG_M = 0.15;

// Observations that say something about the latent state (age class, modernised components) without fixing all of it
// are conditioned exactly: the state of each draw comes from its posterior (archetype.js latentPosterior).
const LATENT_OBS = ['refurb', 'n50', 'dU_tb', 'U_wall', 'U_window', 'U_roof', 'U_floor', 'g_window'];
const exactPath = (keys) => keys.some((k) => LATENT_OBS.includes(k)) && !(keys.includes('age') && keys.includes('refurb'));
const ON = ['windows', 'wall', 'roof', 'floor'];
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.round(p * (s.length - 1))]; };
const wq = (a, w, p) => { const ix = a.map((_, i) => i).sort((x, y) => a[x] - a[y]), W = w.reduce((x, y) => x + y, 0); let c = 0; for (const i of ix) { c += w[i]; if (c >= p * W) return a[i]; } return a[ix[ix.length - 1]]; };
const essOf = (w) => { let s = 0, s2 = 0; for (const x of w) { s += x; s2 += x * x; } return s2 > 0 ? (s * s) / s2 : 0; };
const lik = (fin, o) => fin.map((f) => Math.exp(-0.5 * ((Math.log(Math.max(1e-9, f)) - o) / SIG_M) ** 2));
// is a source already known on this page? (every input it fixes is set by the user, the age known from OSM, …)
export function known(k, { model, ageInfo, state }) {
  const user = (x) => model.params[x]?.source === 'user';
  return keysOf(k).every((x) => (x === 'age' ? !!state.ageClass || ageInfo.kind === 'osm'
    : x === 'refurb' ? ON.every((c) => (state.refurb?.[c] || 'unknown') !== 'unknown')
      : x === 'hScale' ? !model.floorsPrior || !!(state.geom && (state.geom.floors || state.geom.height))
        : x === 'anScale' ? !(model.hGBias > 0)
          : x === 'wwrScale' ? ['N', 'E', 'S', 'W'].some((o) => user(`WWR_${o}`)) : user(x)));
}

// b = { model, ageInfo, state, assigned, ctx }. The meter readings of the truths (log kWh; the same truths in every
// scenario, since they come from one stream).
export function readings(b, T, seed) {
  const full = makePrior(b.model, b.ageInfo, b.state, b.assigned), rT = rng(seed), rE = rng(seed * 31 + 7), out = [];
  for (let t = 0; t < T; t++) { const truth = full(rT), rr = run(b.ctx, truth.p); out.push(Math.log(finalEnergy(rr, truth.p, b.ctx).total) + SIG_M * rE.n()); }
  return out;
}
// one scenario: mean P10–P90 width and P50 of heating demand per m² over T truths, plain and weighted by the meter
// reading of each truth (obs), and the mean effective sample size of the weights; keep: return the draws as well
export function width(b, keys, { T, N, seed, obs, keep }) {
  const base = b.state, full = makePrior(b.model, b.ageInfo, base, b.assigned), rT = rng(seed), exact = exactPath(keys);
  const o = { heat: 0, h50: 0, mHeat: 0, ess: 0 }, pool = keep ? { heat: [], fin: [] } : null;
  for (let t = 0; t < T; t++) {
    const truth = full(rT);
    const st = { ...base, refurb: { ...base.refurb } };
    if (keys.includes('age')) st.ageClass = truth.ageClass;
    if (keys.includes('refurb')) for (const c of ON) st.refurb[c] = truth.modern[c] ? 'yes' : 'no';
    const r = rng(seed * 7919 + t + 1), heat = [], fin = [];
    let pick = () => makePrior(b.model, b.ageInfo, st, b.assigned);
    if (exact) {
      const post = latentPosterior(b.model, b.ageInfo, base, { p: truth.p, keys, refurb: keys.includes('refurb') ? truth.modern : null, ageClass: keys.includes('age') ? truth.ageClass : null });
      const cache = new Map();
      pick = () => {
        let x = r.u(), c0 = post[post.length - 1];
        for (const c of post) if ((x -= c.w) <= 0) { c0 = c; break; }
        const key = c0.cls + ON.map((c) => +c0.modern[c]).join('');
        if (!cache.has(key)) cache.set(key, makePrior(b.model, b.ageInfo, { ...base, ageClass: c0.cls, refurb: Object.fromEntries(ON.map((c) => [c, c0.modern[c] ? 'yes' : 'no'])) }, b.assigned));
        return cache.get(key);
      };
    }
    const draw0 = exact ? null : pick();
    for (let i = 0; i < N; i++) {
      const d = (draw0 || pick())(r);
      for (const k of keys) if (k !== 'age' && k !== 'refurb' && k in truth.p) d.p[k] = truth.p[k];
      const rr = run(b.ctx, d.p);
      heat.push(rr.annual.heatPerM2);
      if (obs || pool) fin.push(finalEnergy(rr, d.p, b.ctx).total);
    }
    o.heat += q(heat, 0.9) - q(heat, 0.1); o.h50 += q(heat, 0.5);
    if (obs) { const w = lik(fin, obs[t]); o.mHeat += wq(heat, w, 0.9) - wq(heat, w, 0.1); o.ess += essOf(w); }
    if (pool) { pool.heat.push(...heat); pool.fin.push(...fin); }
  }
  for (const k in o) o[k] /= T;
  return { ...o, pool };
}
// the meter reading alone: the pooled draws of the null scenario, weighted for each truth's reading
export function meterAlone(pool, obs) {
  let w0 = 0, ess = 0;
  for (const o of obs) { const w = lik(pool.fin, o); w0 += wq(pool.heat, w, 0.9) - wq(pool.heat, w, 0.1); ess += essOf(w); }
  return { heat: w0 / obs.length, ess: ess / obs.length };
}

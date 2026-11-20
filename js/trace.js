// Every input of the model with its value, source tier, prior range and references, for the exports and for
// agent/core.mjs: the same rows as the parameter table of the page (js/main.js renderParams), as plain data.
import { PARAM_META, SOURCE_CN, UNCERTAIN, makePrior, rng, systemPrior } from './archetype.js';
import { refsFor } from './refs.js';
import { factors } from './systems.js';

// what kind of evidence a value rests on (the page's TIER_OF in words)
export const TIER_OF = { osm: 'observed', geometry: 'observed', lod2: 'observed', archetype: 'published_table', profile: 'published_table', zensus: 'published_table', default: 'assumed', user: 'user_input', calibrated: 'bill_calibrated' };
const RES = ['sfh', 'th', 'mfh', 'ab'];
const COMP = { U_window: 'windows', g_window: 'windows', U_wall: 'wall', U_roof: 'roof', U_floor: 'floor' };
const sig = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : +x.toPrecision(d));
const rd = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// opts.absUrl turns the repository paths of some references into links
export function traceInputs(m, ageInfo, state, assigned, opts = {}) {
  const absUrl = opts.absUrl || ((u) => u || null);
  const systems = factors().systems;
  const sp = systemPrior(ageInfo.heat, assigned.cls);
  // the prior range of each input, from draws of the prior as in the parameter table of the page
  const draw = makePrior(m, ageInfo, state, assigned), rg = rng(5), draws = Array.from({ length: 400 }, () => draw(rg).p);
  const q = (k, f) => { const a = draws.map((d) => d[k]).filter((v) => typeof v === 'number').sort((x, y) => x - y); return a.length ? a[Math.round(f * (a.length - 1))] : null; };
  const inputs = [];
  for (const [k, meta] of Object.entries(PARAM_META)) {
    const pv = m.params[k];
    if (!pv) continue;
    const comp = COMP[k];
    const rs = comp ? state.refurb[comp] : null, share = comp ? (rs === 'yes' ? 1 : rs === 'no' ? 0 : assigned.mp[comp] || 0) : 0;
    const refList = refsFor(k, { param: pv, share, state: rs, residential: RES.includes(m.usage), system: systems[m.params.system.value] });
    let range = null;
    if (k.startsWith('WWR_') && q('wwrScale', 0.1) != null) range = [sig(pv.value * q('wwrScale', 0.1)), sig(pv.value * q('wwrScale', 0.9))];
    else if (UNCERTAIN.includes(k) && q(k, 0.1) != null) range = [sig(q(k, 0.1)), sig(q(k, 0.9))];
    inputs.push({
      key: k, label: meta.label, group: meta.group,
      value: k === 'system' ? pv.value : sig(pv.value, 4), value_label: k === 'system' ? systems[pv.value]?.label || pv.value : undefined, unit: meta.unit || null,
      tier: TIER_OF[pv.source] || 'assumed', source: SOURCE_CN[pv.source] || pv.source, note: pv.note || null,
      prior_p10_p90: range, prior_shares: k === 'system' && pv.source !== 'user' && sp ? Object.fromEntries(Object.entries(sp).sort((a, b) => b[1] - a[1]).map(([s, v]) => [s, rd(v, 3)])) : undefined,
      references: refList.map((r) => ({ tier: TIER_OF[r.tier] || 'assumed', label: r.label, where: r.where || null, url: absUrl(r.url) })),
    });
  }
  return inputs;
}

// a result as the range bars of the page: p10_p90 is the dark band (construction age at the class used, if the age
// is uncertain) with its median, p10_p90_all_ages the light band over all possible ages
export function band(pr, k, f = 1) {
  const main = (pr.cond || pr)[k];
  return { p10_p90: [sig(main[0] / f), sig(main[2] / f)], median: sig(main[1] / f), p10_p90_all_ages: pr.cond ? [sig(pr[k][0] / f), sig(pr[k][2] / f)] : undefined };
}

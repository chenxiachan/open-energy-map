// The building card "Which data would narrow the range most" (js/main.js): value of information for the selected
// building with js/voi.js. Several of these workers share the scenarios; each sets the building up once.
// in:  { type: 'setup', model, weather, ageInfo, state, archetypes, T, N, seed } → { type: 'ready' }
//      { type: 'scen', key } → { type: 'result', key, heat, h50, mHeat, ess, meter? }   ('null': nothing fixed, with the
//      meter reading alone on the pooled draws)
// Modules are imported dynamically, as in js/calib.worker.js (tests/worker_imports.mjs): a static import of a module with
// top-level await would install the handler late and lose the first message.
let V, Arch, so, rc, sy, b = null, obs = null, cfg = null;
const ready = Promise.all([import('./voi.js'), import('./archetype.js'), import('./solar.js'), import('./rc5.js'), import('./systems.js')])
  .then(([v, ar, s, r, y]) => { V = v; Arch = ar; so = s; rc = r; sy = y; });

self.onmessage = async (ev) => {
  try {
    await ready;
    const m = ev.data;
    if (m.type === 'setup') {
      await Arch.loadArchetypes('data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(m.archetypes)));
      sy.setFactors(m.archetypes);
      const w = { ...m.weather };
      for (const k of ['T', 'GHI', 'DNI', 'DHI']) w[k] = Float32Array.from(w[k]);
      const prof = Arch.profileFor(m.model);
      const ctx = rc.prepare(m.model, w, so.facadeIrradiance(m.model, w, so.computeShading(m.model)), prof);
      b = { model: m.model, ageInfo: m.ageInfo, state: m.state, assigned: { prof }, ctx };
      cfg = { T: m.T, N: m.N, seed: m.seed };
      obs = V.readings(b, cfg.T, cfg.seed);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (m.type === 'scen') {
      if (m.key === 'null') {
        const x = V.width(b, [], { ...cfg, obs, keep: true });
        self.postMessage({ type: 'result', key: 'null', heat: x.heat, h50: x.h50, mHeat: x.mHeat, ess: x.ess, meter: V.meterAlone(x.pool, obs) });
      } else {
        const x = V.width(b, V.keysOf(m.key), { ...cfg, obs });
        self.postMessage({ type: 'result', key: m.key, heat: x.heat, h50: x.h50, mHeat: x.mHeat, ess: x.ess });
      }
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
};

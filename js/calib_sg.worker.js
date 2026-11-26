// Worker of the Singapore page (js/sg_app.js): bill calibration and retrofit draws, the work itself in js/calib_sg.js.
//
// message in:  { kind: 'calib' | 'retro', A, m, shading, weather, holidays, eraInfo, asg, bca, state, gef, … }
//   calib: meas = { kind: 'annual' | 'monthly', values, scope: 'building' | 'block' | 'flat', area, lag, leap, sigmaRel }, N, seed
//   retro: particles (posterior draws) or N, seed (prior draws)
// messages out: { type: 'progress', stage, phi, ess, acc } … { type: 'done', kind, result } or { type: 'error', message }
//
// The module is imported dynamically, as in js/calib.worker.js: geometry.js (through model_sg.js) loads its JSON with
// top-level await, and with static imports onmessage would be installed only after it, so a message posted right after
// `new Worker()` could be lost (tests/worker_imports.mjs).
let core = null;
const ready = import('./calib_sg.js').then((m) => { core = m; });

self.onmessage = async (ev) => {
  try {
    await ready;
    const msg = ev.data;
    const result = msg.kind === 'retro' ? core.retroJob(msg) : core.calibrate(msg, (p) => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', kind: msg.kind, result });
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.stack) || e) });
  }
};

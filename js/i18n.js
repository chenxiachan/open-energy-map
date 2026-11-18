// UI language: 'zh', 'en' or 'de'. The language is fixed for one page load; switching saves the choice and reloads.
// Order: ?lang=zh|en|de in the URL, then localStorage 'em-lang', then the default: English in the browser (user,
// 2026-11-17: the public site opens in English), Chinese in Node, the base language of the data files, so the tests
// and tools see the data unchanged.
// Safe to import in Node (tests, tools) and in the calibration worker: window, location and localStorage are guarded.
// The worker has no localStorage, so main.js passes the language in the worker URL (calib.worker.js?lang=en).

const KEY = 'em-lang';
export const LANGS = ['zh', 'en', 'de'];
const valid = (v) => (LANGS.includes(v) ? v : null);

function fromUrl() {
  try {
    if (typeof location !== 'undefined' && location && location.search) return valid(new URLSearchParams(location.search).get('lang'));
  } catch { /* ignore */ }
  return null;
}
function fromStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return valid(localStorage.getItem(KEY));
  } catch { /* ignore */ }
  return null;
}

const IN_NODE = typeof process !== 'undefined' && !!process.versions?.node;
export const LANG = fromUrl() || fromStorage() || (IN_NODE ? 'zh' : 'en');
export const LOCALE = { en: 'en-GB', de: 'de-DE' }[LANG] || 'zh-CN';
// L(zh, en, de): every UI string carries all three languages (tests/i18n_coverage.mjs checks it); German falls back to
// English if a call has no third argument.
export const L = (zh, en, de) => (LANG === 'en' ? en : LANG === 'de' ? (de === undefined ? en : de) : zh);

// Data files carry English and German next to Chinese as `<key>_en`, `<key>_de` (label_en, note_de, classes_de, …).
// pick(obj, 'label') returns the field for the current language; German falls back to English, both to Chinese.
const SUFFIXES = { en: ['_en'], de: ['_de', '_en'] }[LANG] || [];
export const pick = (obj, key) => {
  if (obj == null) return obj;
  for (const s of SUFFIXES) if (obj[key + s] != null) return obj[key + s];
  return obj[key];
};

// In English or German mode, copy every `<key>_en` / `<key>_de` onto `<key>` throughout a loaded JSON tree (in place,
// idempotent; German first, English as fallback). In Chinese mode it does nothing, so the Node tests see the data unchanged.
export function localize(data) {
  if (!SUFFIXES.length) return data;
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      const m = /^(.+)_(en|de)$/.exec(k);
      const i = m && m[1] in v ? SUFFIXES.indexOf('_' + m[2]) : -1;
      if (i >= 0) { if (SUFFIXES.slice(0, i).every((x) => !(m[1] + x in v))) v[m[1]] = v[k]; }
      else if (!m) walk(v[k]);
      else walk(v[k]);
    }
  };
  walk(data);
  return data;
}

// Save the choice and reload. The hash (#b=w123@lat,lon) is kept, so boot() restores the selected building.
export function setLang(l) {
  const v = valid(l) || 'zh';
  let stored = false;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) { localStorage.setItem(KEY, v); stored = localStorage.getItem(KEY) === v; }
  } catch { /* ignore */ }
  if (typeof location === 'undefined' || typeof window === 'undefined') return;
  try {
    const u = new URL(location.href);
    // A ?lang= in the URL wins over localStorage, so it has to change too; without storage the URL carries the choice.
    if (u.searchParams.has('lang') || !stored) u.searchParams.set('lang', v);
    if (u.href === location.href) location.reload();
    else location.assign(u.href);
  } catch {
    location.reload();
  }
}

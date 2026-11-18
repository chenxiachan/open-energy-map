// Registry of default rules for values OSM leaves out (data/osm_defaults.json, built by tools/build_osm_defaults.mjs
// from the holdout test in qa/holdout_b.md). geometry.js and archetype.js read rules by id through osmRule(id).
//
// The file loads once at module level: fetch in the browser and in the worker, readFileSync in Node, both relative to
// this module, so callers need no extra step. loadOsmDefaults(url) loads another copy (a data: URL in the tools),
// setOsmDefaults(obj | null) swaps it in memory (null = the hard-coded rules the tool used before the registry).
// When the file is missing every rule returns null and the callers fall back to their built-in rules.

let D = null;

function index(json) {
  if (!json || !Array.isArray(json.rules)) return null;
  return { ...json, byId: Object.fromEntries(json.rules.map((r) => [r.id, r])) };
}

async function readDefault() {
  const url = new URL('../data/osm_defaults.json', import.meta.url);
  try {
    if (url.protocol === 'file:' && typeof process !== 'undefined' && process.versions && process.versions.node) {
      const { readFileSync } = await import('node:fs');
      return JSON.parse(readFileSync(url, 'utf8'));
    }
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function loadOsmDefaults(url) {
  if (url == null) { if (!D) D = index(await readDefault()); return D; }
  D = index(await (await fetch(url)).json());
  return D;
}

export function setOsmDefaults(json) { D = index(json); return D; }
export function osmDefaults() { return D; }
export function osmRule(id) { return D ? D.byId[id] || null : null; }

D = index(await readDefault());

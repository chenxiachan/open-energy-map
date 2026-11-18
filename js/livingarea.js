// Residential floor area checked against Zensus 2022 (data/zensus/living.json, built by tools/zensus_check.mjs).
//
// nonres: OSM buildings tagged only building=yes that the size rule would call housing, while the Zensus 100 m cells
//   around them hold far less living area than the model puts there (exhibition halls, broadcasting or office
//   buildings, palaces). OSM id → [Zensus living area of the cells around, model living area there incl. this building],
//   both m². geometry.js then treats the building as non-residential.
// kappa: Zensus living area per m² of model living area (A_N / 1.2), by house type and storey height, fitted on 300 m
//   blocks of Munich. areas.living = A_N / 1.2 × kappa is the living area used wherever the model meets figures per m²
//   of living area (the Heizspiegel comparison, the bill layer). A_N itself stays the GEG reference area.
//
// Loading follows osmdefaults.js: once at module level, fetch in the browser and the worker, readFileSync in Node.
// setLivingArea(null) switches both off (tools/zensus_check.mjs builds the model without them before fitting).

let D = null;

async function readDefault() {
  const url = new URL('../data/zensus/living.json', import.meta.url);
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

export function setLivingArea(json) { D = json || null; return D; }
export function livingArea() { return D; }
export function zensusNonRes(id) { return D?.nonres?.[id] || null; }

// house type of the kappa table: sfh and th are houses
export const livingType = (usage) => (usage === 'sfh' || usage === 'th' ? 'house' : usage === 'mfh' || usage === 'ab' ? usage : null);
// kappa for a residential building; 1 (A_N / 1.2 unchanged) without the file
export function livingKappa(usage, hG) {
  const t = D?.kappa?.[livingType(usage)];
  if (!t) return 1;
  let i = 0;
  while (i < t.edges.length && hG >= t.edges[i]) i++;
  return t.k[i];
}
// The bill comparisons (Heizspiegel) cover residential buildings. Where Zensus finds less than half of the model's floor
// area as dwellings (kappa < 0.5: apartment blocks with storeys of 4 m and more, houses under 2.75 m), the buildings are
// mostly something else (shops and offices below, garden huts), so they are left out rather than given a living area
// a fraction of their size.
export const BILL_SCOPE_KAPPA = 0.5;
export const inBillScope = (usage, hG) => livingKappa(usage, hG) >= BILL_SCOPE_KAPPA;
export function livingBand(usage, hG) {
  const t = D?.kappa?.[livingType(usage)];
  if (!t) return null;
  let i = 0;
  while (i < t.edges.length && hG >= t.edges[i]) i++;
  return { type: livingType(usage), i, label: t.labels[i], k: t.k[i], p5: t.p5[i], p95: t.p95[i] };
}

D = await readDefault();

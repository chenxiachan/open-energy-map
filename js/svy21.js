// SVY21 / Singapore TM (EPSG:3414): transverse Mercator on the WGS 84 ellipsoid, latitude of origin 1°22′ N, central
// meridian 103°50′ E, scale factor 1, false easting 28,001.642 m, false northing 38,744.572 m (EPSG conversion 19864
// "Singapore Transverse Mercator", method 9807). The SVY21 datum (EPSG:4757) is taken as WGS 84: EPSG transformation
// 8886 "SVY21 to WGS 84 (1)" is a geocentric translation of zero (accuracy 1 m), so OSM lon/lat go in unchanged.
// Formulas: the series of Snyder (1987), Map Projections: A Working Manual, USGS PP 1395, pp. 60–64, as in EPSG
// Guidance Note 7-2 (Transverse Mercator). Checked in tools/sg/svy21_check.mjs.
//
// Used by tools/sg/city_run_sg.mjs (the 100 m grid of the Singapore city layer) and js/sg_app.js (cell outlines).
const D = Math.PI / 180;

// a transverse Mercator projection with the given ellipsoid and origin (parameterised so the check can run the EPSG
// worked example as well)
export function tmerc({ a, invf, lat0, lon0, k0, fe, fn }) {
  const f = 1 / invf, e2 = f * (2 - f), ep2 = e2 / (1 - e2), e4 = e2 * e2, e6 = e4 * e2;
  const m1 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256, m2 = (3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024, m3 = (15 * e4) / 256 + (45 * e6) / 1024, m4 = (35 * e6) / 3072;
  const M = (p) => a * (m1 * p - m2 * Math.sin(2 * p) + m3 * Math.sin(4 * p) - m4 * Math.sin(6 * p));
  const p0 = lat0 * D, l0 = lon0 * D, M0 = M(p0);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  // lon, lat in degrees → [E, N] in metres
  const forward = (lon, lat) => {
    const p = lat * D, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
    const nu = a / Math.sqrt(1 - e2 * s * s), T = t * t, C = ep2 * c * c, A = (lon * D - l0) * c;
    const E = fe + k0 * nu * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120);
    const N = fn + k0 * (M(p) - M0 + nu * t * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
    return [E, N];
  };
  // [E, N] in metres → [lon, lat] in degrees
  const inverse = (E, N) => {
    const mu = (M0 + (N - fn) / k0) / (a * m1);
    const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
      + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
    const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
    const nu = a / Math.sqrt(1 - e2 * s * s), rho = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5, T = t * t, C = ep2 * c * c, Dd = (E - fe) / (nu * k0);
    const lat = p1 - ((nu * t) / rho) * ((Dd * Dd) / 2 - ((5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * Dd ** 4) / 24 + ((61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * Dd ** 6) / 720);
    const lon = l0 + (Dd - ((1 + 2 * T + C) * Dd ** 3) / 6 + ((5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * Dd ** 5) / 120) / c;
    return [lon / D, lat / D];
  };
  return { forward, inverse };
}

export const SVY21 = { a: 6378137, invf: 298.257223563, lat0: 1 + 22 / 60, lon0: 103 + 50 / 60, k0: 1, fe: 28001.642, fn: 38744.572 };
const P = tmerc(SVY21);
export const toSVY21 = P.forward;     // (lon, lat) → [E, N]
export const fromSVY21 = P.inverse;   // (E, N) → [lon, lat]

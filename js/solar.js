// Solar geometry, irradiance on facades (Hay–Davies), shading by neighbours and by the building itself.
//
// Time base: weather hour i covers [i, i+1) UTC of a non-leap year (CONTRACT §6); the sun is evaluated at the
// interval midpoint. Azimuths in degrees clockwise from north.

const D2R = Math.PI / 180;

export function sunPosition(dayOfYear, hourUTC, lat, lon) {
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hourUTC - 12) / 24);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hourUTC * 60 + eot + 4 * lon;
  const ha = (tst / 4 - 180) * D2R;
  const phi = lat * D2R;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  let az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / D2R + 180;
  az = ((az % 360) + 360) % 360;
  return { cosZ, altitude: 90 - zen / D2R, azimuth: az, decl };
}

const SUN_CACHE = new Map();
// Per-hour sun for a weather year (cached by lat/lon).
export function sunTable(lat, lon) {
  const key = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
  if (SUN_CACHE.has(key)) return SUN_CACHE.get(key);
  const cosZ = new Float32Array(8760), alt = new Float32Array(8760), az = new Float32Array(8760), i0 = new Float32Array(8760);
  for (let i = 0; i < 8760; i++) {
    const d = Math.floor(i / 24) + 1, h = (i % 24) + 0.5;
    const s = sunPosition(d, h, lat, lon);
    cosZ[i] = s.cosZ; alt[i] = s.altitude; az[i] = s.azimuth;
    i0[i] = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * d) / 365));
  }
  const t = { cosZ, alt, az, i0 };
  SUN_CACHE.set(key, t);
  return t;
}

// ---------- shading ----------
// Obstacles: neighbour prisms + the building's own prism. Returns per facade:
//   direct[f][month*24 + hourUTC] = unshaded fraction of the beam (0..1), svf[f] = sky view relative to an open vertical wall.
export function computeShading(model) {
  const obstacles = [];
  const addPrism = (ring, h, own) => {
    for (let i = 0; i < ring.length; i++) obstacles.push({ a: ring[i], b: ring[(i + 1) % ring.length], h, own });
  };
  for (const n of model.neighbors) { addPrism(n.outer, n.height, false); for (const hl of n.holes || []) addPrism(hl, n.height, false); }
  const ownH = model.height + (model.roof.ridgeHeight || 0) * 0.5;
  addPrism(model.outer, ownH, true);
  for (const hl of model.holes) addPrism(hl, ownH, true);

  const nf = model.facades.length;
  const direct = model.facades.map(() => new Float32Array(12 * 24).fill(1));
  const svf = new Float32Array(nf).fill(1);
  const samplesOf = (f) => {
    const pts = [];
    const nrm = [Math.sin(f.azimuth * D2R), Math.cos(f.azimuth * D2R)];
    const nz = Math.min(4, Math.max(1, model.floors));
    for (const s of f.segments) {
      const L = (s.t1 - s.t0) * f.length;
      const zMin = s.exposed ? 0 : (s.neighborHeight ?? model.height);
      if (zMin >= model.height - 0.5) continue;
      const nx = Math.max(1, Math.min(6, Math.round(L / 4)));
      for (let k = 0; k < nx; k++) {
        const t = s.t0 + ((k + 0.5) / nx) * (s.t1 - s.t0);
        const x = f.a[0] + t * (f.b[0] - f.a[0]) + nrm[0] * 0.15, y = f.a[1] + t * (f.b[1] - f.a[1]) + nrm[1] * 0.15;
        for (let j = 0; j < nz; j++) {
          const z = zMin + ((j + 0.5) / nz) * (model.height - zMin);
          pts.push([x, y, z]);
        }
      }
    }
    return pts;
  };
  // ray (2D direction d, elevation tan) from point p: blocked if an obstacle edge is crossed where the prism is taller
  const blocked = (p, dx, dy, tanAlt) => {
    for (const o of obstacles) {
      const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = o.a[0] - p[0], wy = o.a[1] - p[1];
      const s = (wx * ey - wy * ex) / den;          // distance along ray
      const u = (wx * dy - wy * dx) / den;          // position along edge
      if (s <= 0.05 || u < 0 || u > 1) continue;
      if (o.h > p[2] + s * tanAlt) return true;
    }
    return false;
  };
  const lat = model.center.lat, lon = model.center.lon;
  const MID = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];
  model.facades.forEach((f, fi) => {
    const pts = samplesOf(f);
    if (!pts.length) { direct[fi].fill(0); svf[fi] = 0; return; }
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        const s = sunPosition(MID[m], h + 0.5, lat, lon);
        if (s.altitude <= 0.5) continue;
        const rel = Math.cos((s.azimuth - f.azimuth) * D2R);
        if (rel <= 0) continue;
        const dx = Math.sin(s.azimuth * D2R), dy = Math.cos(s.azimuth * D2R), ta = Math.tan(s.altitude * D2R);
        let nb = 0;
        for (const p of pts) if (blocked(p, dx, dy, ta)) nb++;
        direct[fi][m * 24 + h] = 1 - nb / pts.length;
      }
    }
    // sky view: horizon elevation profile over relative azimuths −85…85°
    let F = 0;
    const step = 10;
    for (let phi = -85; phi <= 85; phi += step) {
      const azDir = (f.azimuth + phi) * D2R;
      const dx = Math.sin(azDir), dy = Math.cos(azDir);
      let epsSum = 0;
      for (const p of pts) {
        let eps = 0;
        for (const o of obstacles) {
          const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1];
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-9) continue;
          const wx = o.a[0] - p[0], wy = o.a[1] - p[1];
          const s = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
          if (s <= 0.05 || u < 0 || u > 1) continue;
          if (o.h > p[2]) eps = Math.max(eps, Math.atan((o.h - p[2]) / s));
        }
        epsSum += eps;
      }
      const eps = epsSum / pts.length;
      F += Math.cos(phi * D2R) * (Math.PI / 4 - eps / 2 - Math.sin(2 * eps) / 4) * step * D2R;
    }
    svf[fi] = Math.max(0, Math.min(1, F / Math.PI / 0.5));
  });
  return { direct, svf };
}

// Hourly irradiance (W/m²) on every facade (vertical) + horizontal roof. Shading applied to beam and circumsolar.
export function facadeIrradiance(model, weather, shading) {
  const { cosZ, az, i0 } = sunTable(model.center.lat, model.center.lon);
  const nf = model.facades.length;
  const out = model.facades.map(() => new Float32Array(8760));
  const beamOnly = model.facades.map(() => new Float32Array(8760));
  const roof = new Float32Array(8760);
  const rho = 0.2;
  const monthOfDay = new Uint8Array(365);
  { let d = 0; [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].forEach((n, m) => { for (let k = 0; k < n; k++) monthOfDay[d++] = m; }); }
  for (let i = 0; i < 8760; i++) {
    const ghi = weather.GHI[i], dni = weather.DNI[i], dhi = weather.DHI[i];
    roof[i] = ghi;
    if (ghi <= 0 && dhi <= 0) continue;
    const cz = cosZ[i];
    const sinZ = Math.sqrt(Math.max(0, 1 - cz * cz));
    const Ai = cz > 0.05 ? Math.min(1, dni / i0[i]) : 0;
    const m = monthOfDay[Math.floor(i / 24)], h = i % 24;
    for (let f = 0; f < nf; f++) {
      const fa = model.facades[f].azimuth * D2R;
      const cosT = cz > 0 ? sinZ * Math.cos(az[i] * D2R - fa) : 0;   // vertical: cosθ = sinZ cos(Δaz)
      const sh = shading ? shading.direct[f][m * 24 + h] : 1;
      const sv = shading ? shading.svf[f] : 1;
      const beam = cosT > 0 ? dni * cosT * sh : 0;
      const Rb = cz > 0.087 ? Math.max(0, cosT) / cz : 0;
      const circ = dhi * Ai * Rb * sh;
      const iso = dhi * (1 - Ai) * 0.5 * sv;
      const grd = ghi * rho * 0.5;
      out[f][i] = beam + circ + iso + grd;
      beamOnly[f][i] = beam;
    }
  }
  return { facade: out, beam: beamOnly, roof };
}

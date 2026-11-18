// EPW (EnergyPlus/ESP-r weather) export from the project weather JSON (CONTRACT §5, §6).
//   buildEPW(weather, opts) → string   (8 header lines + 8760 data rows, 35 fields each)
// Pure ES module, no dependencies; works in the browser and in Node.
//
// Time conventions (the part that is easy to get wrong):
// - Weather JSON (CONTRACT §6, tools/build_weather.py): hour i covers [i, i+1) UTC of a non-leap year. Radiation is
//   the mean irradiance over that interval (W/m²). T, RH and wind are interval means too (build_weather.py averages
//   the instantaneous Open-Meteo values stamped i and i+1), i.e. they represent the state at UTC i + 0.5.
// - EPW: local STANDARD time (no daylight saving), hour-ending. Record k (0-based; day = floor(k/24), hour field
//   = k % 24 + 1) covers local [k, k+1) h after Jan 1 00:00. Radiation fields hold the energy received during that
//   hour (Wh/m², numerically the mean W/m²). T, dew point, RH, pressure and wind are values AT the hour stamp
//   (local k+1); EnergyPlus interpolates them linearly between stamps for sub-hourly time steps.
// - With local = UTC + tz (tz = +1 for Munich):
//     radiation[k] = R[k − tz]                         (same interval, shifted by the time zone)
//     state[k]     = value at UTC k + 1 − tz = ½ (X[k − tz] + X[k − tz + 1])   (mean of the two adjacent interval
//                    means, whose centres lie ½ h before and after the stamp)
//   Indices wrap around the year end; for tz = 1 this only touches record 0 radiation (night) and the last state
//   value (Dec 31 24:00 uses Jan 1 of the same data year).
// - Fields we do not have use the EPW missing codes of the EnergyPlus "Auxiliary Programs" documentation
//   (weather converter, EPW field definitions), except:
//   * horizontal infrared radiation is COMPUTED (Clark & Allen sky emissivity, the same formula EnergyPlus uses
//     when the field is missing) with an opaque sky cover estimated from the clearness of the hour. Writing 9999
//     instead would make EnergyPlus fall back to the opaque sky cover field, which we would also have to mark
//     missing, so it would run with a constant default/last-good cloud cover all year (see tools/export_notes.md).
//   * total/opaque sky cover hold that estimate (tenths), so the file is self-consistent.
//   * wind direction is not in the weather JSON → 999 (missing); EnergyPlus substitutes its default.
// - Wind speed unit: Open-Meteo delivers km/h by default and the project weather JSON keeps that unit. The unit is
//   taken from opts.windUnit or weather.windUnit; 'auto' (default) assumes km/h when the annual mean exceeds 6.

const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SIGMA = 5.6697e-8;

// EPW missing-value codes (EnergyPlus Auxiliary Programs, "Weather Data Format" field list).
export const EPW_MISSING = {
  dryBulb: 99.9, dewPoint: 99.9, relHum: 999, pressure: 999999, extHorRad: 9999, extDirNormRad: 9999, horIR: 9999,
  ghi: 9999, dni: 9999, dhi: 9999, ghIllum: 999999, dnIllum: 999999, dhIllum: 999999, zenLum: 9999, windDir: 999,
  windSpd: 999, totSky: 99, opqSky: 99, visibility: 9999, ceiling: 99999, presWeathObs: 9, presWeathCodes: 999999999,
  precipWater: 999, aod: 0.999, snowDepth: 999, daysSinceSnow: 99, albedo: 999, liqPrecipDepth: 999, liqPrecipQty: 99,
};

// Approximate Munich monthly mean air temperatures (°C), used only when no weather object is at hand.
export const MUNICH_MONTHLY_T = [1.0, 2.2, 5.9, 10.1, 14.3, 17.8, 19.6, 19.2, 14.9, 10.3, 5.2, 1.9];

export function isLeapYear(y) {
  return Number.isInteger(y) && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0);
}

// Weekday name of Jan 1. TMY / unknown year → Monday (same assumption as js/rc5.js schedules()).
export function startWeekday(year) {
  if (!Number.isInteger(year)) return 'Monday';
  return WEEKDAYS[new Date(Date.UTC(year, 0, 1)).getUTCDay()];
}

// Monthly means of weather.T over the UTC month boundaries of the JSON (difference to local months is negligible).
export function monthlyMeanTemps(weather) {
  const T = weather && weather.T;
  if (!T || T.length !== 8760) return MUNICH_MONTHLY_T.slice();
  const out = [];
  let i = 0;
  for (let m = 0; m < 12; m++) {
    let s = 0;
    const n = MDAYS[m] * 24;
    for (let k = 0; k < n; k++) s += T[i++];
    out.push(s / n);
  }
  return out;
}

// Damped, lagged monthly ground temperature (periodic heat conduction in a semi-infinite soil, Kusuda-type):
//   Tg(m) = Tann + D · (T̃(m − L) − Tann),  D = exp(−z·√(π/(α·P))),  L = z/2·√(P/(π·α))  (converted to months)
// with T̃ the periodic linear interpolation of the monthly means, P = 365 d, α the soil diffusivity (m²/day).
// Defaults z = 2 m, α = 0.0648 m²/d (7.5e-7 m²/s, moist soil) → D ≈ 0.48, L ≈ 1.4 months.
export function groundTemperatures(monthly, { depth = 2.0, alpha = 0.0648 } = {}) {
  const m = monthly && monthly.length === 12 ? monthly : MUNICH_MONTHLY_T;
  const P = 365;
  const kz = depth * Math.sqrt(Math.PI / (alpha * P));
  const D = Math.exp(-kz);
  const lag = (kz / (2 * Math.PI)) * 12;
  const Tann = m.reduce((s, v) => s + v, 0) / 12;
  const interp = (x) => {
    const x0 = Math.floor(x), f = x - x0;
    const a = m[((x0 % 12) + 12) % 12], b = m[(((x0 + 1) % 12) + 12) % 12];
    return a + f * (b - a);
  };
  return m.map((_, i) => Tann + D * (interp(i - lag) - Tann));
}

// Dew point from T (°C) and RH (%) — Magnus formula with Sonntag (1990) coefficients over water.
export function dewPoint(T, RH) {
  const b = 17.62, c = 243.12;
  const rh = Math.min(100, Math.max(1, RH));
  const g = Math.log(rh / 100) + (b * T) / (c + T);
  return Math.min(T, (c * g) / (b - g));
}

// Standard-atmosphere station pressure (Pa) at elevation z (m).
export function stationPressure(z) {
  return 101325 * Math.pow(1 - 2.25577e-5 * z, 5.25588);
}

// Solar geometry (NOAA / Spencer series), same formulation as js/solar.js. hourUTC may be fractional.
function cosZenith(dayOfYear, hourUTC, latDeg, lonDeg) {
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hourUTC - 12) / 24);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = ((hourUTC * 60 + eot + 4 * lonDeg) / 4 - 180) * (Math.PI / 180);
  const phi = latDeg * (Math.PI / 180);
  return Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
}

// Clark & Allen (1978) sky emissivity as used by EnergyPlus for a missing horizontal IR field.
export function horizontalIR(T, Tdp, opaqueSkyTenths) {
  const N = opaqueSkyTenths;
  const eps = (0.787 + 0.764 * Math.log((Tdp + 273.15) / 273.0)) * (1 + 0.0224 * N - 0.0035 * N * N + 0.00028 * N * N * N);
  return eps * SIGMA * Math.pow(T + 273.15, 4);
}

function resolveWindFactor(weather, opts) {
  const unit = opts.windUnit || weather.windUnit || weather.wind_unit || 'auto';
  if (unit === 'm/s' || unit === 'ms') return { factor: 1, unit: 'm/s', note: 'wind given in m/s' };
  if (unit === 'km/h' || unit === 'kmh') return { factor: 1 / 3.6, unit: 'km/h', note: 'wind converted from km/h' };
  const mean = weather.wind.reduce((s, v) => s + v, 0) / weather.wind.length;
  if (mean > 6) return { factor: 1 / 3.6, unit: 'km/h', note: `wind unit auto-detected as km/h (annual mean ${mean.toFixed(1)}) and converted to m/s` };
  return { factor: 1, unit: 'm/s', note: `wind unit auto-detected as m/s (annual mean ${mean.toFixed(1)})` };
}

function checkWeather(w) {
  for (const k of ['T', 'RH', 'wind', 'GHI', 'DNI', 'DHI']) {
    const a = w[k];
    if (!a || a.length !== 8760) throw new Error(`buildEPW: weather.${k} must have 8760 values (got ${a ? a.length : 'none'})`);
    for (let i = 0; i < 8760; i++) if (!Number.isFinite(a[i])) throw new Error(`buildEPW: weather.${k}[${i}] is not a finite number`);
  }
}

// Converted hourly records (numbers, before formatting). Exported for tests and for UI previews.
export function epwRecords(weather, opts = {}) {
  checkWeather(weather);
  const tz = Math.round(opts.timeZone ?? 1);
  const lat = opts.latitude ?? weather.lat ?? 48.14;
  const lon = opts.longitude ?? weather.lon ?? 11.58;
  const elev = opts.elevation ?? weather.elevation ?? 520;
  const wind = resolveWindFactor(weather, opts);
  const stateMode = opts.stateConvention || 'intervalMean'; // 'intervalMean' (build_weather.py) | 'instantStart'
  const pressure = Math.round(stationPressure(elev));
  const N = 8760, mod = (i) => ((i % N) + N) % N;
  const state = (X, k) => (stateMode === 'instantStart' ? X[mod(k + 1 - tz)] : 0.5 * (X[mod(k - tz)] + X[mod(k - tz + 1)]));

  const rec = {
    month: new Uint8Array(N), day: new Uint8Array(N), hour: new Uint8Array(N),
    T: new Float64Array(N), Tdp: new Float64Array(N), RH: new Float64Array(N), P: new Float64Array(N),
    etrH: new Float64Array(N), etrN: new Float64Array(N), IR: new Float64Array(N),
    GHI: new Float64Array(N), DNI: new Float64Array(N), DHI: new Float64Array(N),
    windDir: new Float64Array(N), windSpd: new Float64Array(N), sky: new Float64Array(N), srcIndex: new Int32Array(N),
  };
  const nightSky = new Float64Array(N).fill(NaN);
  let k = 0;
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= MDAYS[m]; d++) {
      for (let h = 1; h <= 24; h++, k++) {
        rec.month[k] = m + 1; rec.day[k] = d; rec.hour[k] = h;
        const j = mod(k - tz);                       // JSON interval = same physical hour
        rec.srcIndex[k] = j;
        rec.T[k] = state(weather.T, k);
        rec.RH[k] = Math.min(100, Math.max(1, state(weather.RH, k)));
        rec.Tdp[k] = dewPoint(rec.T[k], rec.RH[k]);
        rec.P[k] = pressure;
        rec.windSpd[k] = Math.max(0, state(weather.wind, k) * wind.factor);
        rec.windDir[k] = weather.windDir && weather.windDir.length === N ? mod(Math.round(state(weather.windDir, k))) % 360 : EPW_MISSING.windDir;
        rec.GHI[k] = Math.max(0, weather.GHI[j]);
        rec.DNI[k] = Math.max(0, weather.DNI[j]);
        rec.DHI[k] = Math.max(0, weather.DHI[j]);
        // extraterrestrial radiation over local [k, k+1) = UTC [k − tz, k − tz + 1)
        const doy = Math.floor(k / 24) + 1;
        const i0 = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));
        let czMean = 0;
        const hUTC0 = (k - tz) - (doy - 1) * 24;      // hour of day (UTC) at interval start, may be −1
        for (let s = 0; s < 12; s++) czMean += Math.max(0, cosZenith(doy, hUTC0 + (s + 0.5) / 12, lat, lon)) / 12;
        rec.etrN[k] = i0;
        rec.etrH[k] = i0 * czMean;
        // opaque sky cover estimate (tenths) for daylight hours: inverse Kasten–Czeplak on a Haurwitz clear sky
        const cz = cosZenith(doy, hUTC0 + 0.5, lat, lon);
        if (cz > 0.1) {
          const gcs = 1098 * cz * Math.exp(-0.057 / cz);
          const r = Math.min(1, Math.max(0.25, rec.GHI[k] / gcs));
          nightSky[k] = 10 * Math.min(1, Math.pow((1 - r) / 0.75, 1 / 3.4));
        }
      }
    }
  }
  // fill night hours by linear interpolation between the neighbouring daylight estimates (periodic)
  const known = [];
  for (let i = 0; i < N; i++) if (Number.isFinite(nightSky[i])) known.push(i);
  if (known.length === 0) rec.sky.fill(5);
  else {
    for (let q = 0; q < known.length; q++) {
      const a = known[q], b = known[(q + 1) % known.length];
      const va = nightSky[a], vb = nightSky[b];
      const span = mod(b - a) || N;
      for (let s = 0; s < span; s++) rec.sky[mod(a + s)] = va + ((vb - va) * s) / span;
    }
  }
  for (let i = 0; i < N; i++) {
    rec.sky[i] = Math.min(10, Math.max(0, Math.round(rec.sky[i])));
    rec.IR[i] = horizontalIR(rec.T[i], rec.Tdp[i], rec.sky[i]);
  }
  return { rec, meta: { tz, lat, lon, elev, pressure, wind, stateMode } };
}

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/,/g, ';').replace(/[^\x20-\x7E]/g, '?').trim();
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const i0 = (x) => String(Math.round(x));

export function buildEPW(weather, opts = {}) {
  const { rec, meta } = epwRecords(weather, opts);
  const isTMY = !Number.isInteger(weather.year);
  const year = Number.isInteger(opts.year) ? opts.year : weather.year;
  const mfy = Array.isArray(weather.months_from_year) && weather.months_from_year.length === 12 ? weather.months_from_year : null;
  const rowYear = (m) => (Number.isInteger(year) ? year : mfy ? mfy[m - 1] : 2023);
  const tzStr = (meta.tz >= 0 ? '' : '-') + Math.abs(meta.tz).toFixed(1);
  const gt = groundTemperatures(monthlyMeanTemps(weather), { depth: opts.groundDepth ?? 2.0 });
  const city = clean(opts.city || 'Munich');
  const src = clean(opts.sourceShort || 'Open-Meteo ERA5');
  const lines = [];
  lines.push(['LOCATION', city, 'BY', 'DEU', src, '999999', meta.lat.toFixed(4), meta.lon.toFixed(4), tzStr, meta.elev.toFixed(1)].join(','));
  lines.push('DESIGN CONDITIONS,0');
  lines.push('TYPICAL/EXTREME PERIODS,0');
  lines.push(['GROUND TEMPERATURES', '1', (opts.groundDepth ?? 2.0).toFixed(1), '', '', '', ...gt.map(f1)].join(','));
  lines.push('HOLIDAYS/DAYLIGHT SAVINGS,No,0,0,0');
  lines.push('COMMENTS 1,' + clean(`${weather.name || 'weather'}; source: ${weather.source || 'n/a'}` +
    (isTMY && mfy ? `; TMY months from years ${mfy.join(' ')}` : '')));
  lines.push('COMMENTS 2,' + clean(`Converted by Open Energy Map (js/epw.js): UTC interval means -> local standard time UTC${meta.tz >= 0 ? '+' : ''}${meta.tz} hour-ending` +
    ` (radiation shifted by the time zone; T/RH/wind = mean of the two interval means around each stamp); dew point Magnus;` +
    ` constant station pressure ${meta.pressure} Pa (standard atmosphere at ${meta.elev} m); horizontal IR Clark-Allen with` +
    ` sky cover estimated from clearness; ${meta.wind.note}; wind direction missing (999); ground temperatures damped/lagged monthly means at ${(opts.groundDepth ?? 2.0)} m`));
  lines.push(`DATA PERIODS,1,1,Data,${startWeekday(year)},1/1,12/31`);

  const FLAGS = '?9?9?9?9E0?9?9?9?9?9?9?9?9?9?9?9?9?9?9?9*9*9?9?9?9';
  const M = EPW_MISSING;
  for (let k = 0; k < 8760; k++) {
    const row = [
      rowYear(rec.month[k]), rec.month[k], rec.day[k], rec.hour[k], 0, FLAGS,
      f1(rec.T[k]), f1(rec.Tdp[k]), i0(rec.RH[k]), i0(rec.P[k]),
      i0(rec.etrH[k]), i0(rec.etrN[k]), i0(rec.IR[k]),
      i0(rec.GHI[k]), i0(rec.DNI[k]), i0(rec.DHI[k]),
      M.ghIllum, M.dnIllum, M.dhIllum, M.zenLum,
      i0(rec.windDir[k]), f1(rec.windSpd[k]), i0(rec.sky[k]), i0(rec.sky[k]),
      M.visibility, M.ceiling, M.presWeathObs, M.presWeathCodes, M.precipWater, M.aod.toFixed(3),
      M.snowDepth, M.daysSinceSnow, M.albedo, M.liqPrecipDepth, M.liqPrecipQty,
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

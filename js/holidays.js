// Calendar of the hourly schedule and the days off of non-residential use (shared by js/rc5.js and js/idf.js).
//
// The weather files have 8760 hours: in a leap year 29 February is dropped (tools/build_weather.py), so day d of the
// file is calendar day d of the year, or d + 1 from 1 March on. A typical meteorological year has no calendar year; it
// is laid on 2018, whose 1 January is a Monday, as the schedule of the TMY assumed before.
//
// The usage data give the days of use per year (DIN V 18599-10, d_nutz,a: 250 for offices, 300 for retail). The schedule
// counts the weekdays of use; the statutory public holidays of Bavaria (as in Munich, Mariä Himmelfahrt included) that
// fall on such a day are days off. If the year still has more days of use than the profile allows, the remaining days
// off are spread evenly over the days of use. Profiles with holidays: 'school' (DIN V 18599-10 profile 8, whose 200
// days already allow for school holidays) also take the Bavarian school holidays off, laid on the calendar by rule
// (the Ministry sets the exact dates each year): Christmas 24 Dec–5 Jan, the winter week of Shrove Monday, Holy Week and
// Easter week, Whit Tuesday to the Friday after, summer 1 Aug–11 Sep, the week of All Saints and the Day of Repentance.
// That leaves about 188 school days; the profile's 200 is then not reached and no further day is taken off.
//
// Other cities (Singapore): cityCalendar(list) turns a city's own list of public holidays by year into a calendar that
// daysOff(profile, y, calendar) uses instead of the Bavarian rules; without a calendar nothing changes. Rules:
// - A year in the list takes its dates as given (data/sg/holidays.json from data.gov.sg: { "2019": ["2019-01-01", …] }).
// - A year that is not in the list, which includes the typical year laid on 2018 when 2018 is not listed, takes the dates
//   of the nearest listed year (the earlier one on a tie) by month and day, on the calendar of the year asked for. The
//   number of holidays and their season are kept; the moving holidays (Chinese New Year, Hari Raya, Deepavali, Vesak,
//   Good Friday) then sit on the dates of that year. 29 February is dropped in a common year.
// - Holiday in lieu (Singapore Holidays Act 1998, s. 4(2)): a holiday that falls on a Sunday makes the next day that is
//   not itself a public holiday a public holiday. sundayRule 'apply' adds those days, 'none' takes the list as it is,
//   and 'auto' (default) adds them only if the list does not already name them: if every Sunday holiday in the list is
//   followed by a listed day, the list is taken to include the days in lieu.
// - School holidays: a profile with holidays 'school' takes opts.school (same format, same year rule) if given, and no
//   school holidays otherwise (the profile's daysPerYear then spreads the remaining days off).

export const TMY_YEAR = 2018;

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// calendar day of the year (0 = 1 January) of a date
function calDay(y, month, day) {
  const md = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let n = day - 1; for (let i = 0; i < month - 1; i++) n += md[i];
  return n;
}
// file day (0..364) of a calendar day; 29 February has none
const fileDay = (y, c) => (isLeap(y) && c >= 59 ? (c === 59 ? -1 : c - 1) : c);
const calOf = (y, d) => (isLeap(y) && d >= 59 ? d + 1 : d);

// weekday of file day d: 1..7 Monday..Sunday
export function weekdayOf(y, d) {
  const dow = (new Date(Date.UTC(y, 0, 1)).getUTCDay() + calOf(y, d)) % 7;
  return dow === 0 ? 7 : dow;
}

// Easter Sunday (Gregorian, anonymous algorithm) as a calendar day
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return calDay(y, Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
}

// statutory public holidays of Bavaria, as file days
export function publicHolidays(y) {
  const e = easter(y);
  return [calDay(y, 1, 1), calDay(y, 1, 6), e - 2, e + 1, calDay(y, 5, 1), e + 39, e + 50, e + 60, calDay(y, 8, 15), calDay(y, 10, 3), calDay(y, 11, 1), calDay(y, 12, 25), calDay(y, 12, 26)]
    .map((c) => fileDay(y, c)).filter((d) => d >= 0 && d < 365);
}

// Bavarian school holidays by rule, as file days
export function schoolHolidays(y) {
  const e = easter(y), out = [];
  const span = (a, b) => { for (let c = a; c <= b; c++) out.push(c); };
  const last = calDay(y, 12, 31);
  span(calDay(y, 1, 1), calDay(y, 1, 5)); span(calDay(y, 12, 24), last);        // Christmas
  span(e - 48, e - 44);                                                          // winter week (Shrove Monday to Friday)
  span(e - 6, e + 5);                                                            // Holy Week and Easter week
  span(e + 51, e + 60);                                                          // Whit Tuesday to the Friday after
  span(calDay(y, 8, 1), calDay(y, 9, 11));                                       // summer
  const n1 = calDay(y, 11, 1), dow = (new Date(Date.UTC(y, 0, 1)).getUTCDay() + n1) % 7, mon = n1 - ((dow + 6) % 7);
  span(mon, mon + 4);                                                            // week of All Saints
  const n22 = calDay(y, 11, 22), d22 = (new Date(Date.UTC(y, 0, 1)).getUTCDay() + n22) % 7;
  out.push(n22 - ((d22 - 3 + 7) % 7));                                           // Day of Repentance: the last Wednesday before 23 Nov
  return [...new Set(out.map((c) => fileDay(y, c)))].filter((d) => d >= 0 && d < 365);
}

// ---------- a city's own holidays from a list by year (see the header) ----------
// a date as "2019-01-01" or { date: "2019-01-01", … } → [y, m, d]
const parseISO = (s) => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s && typeof s === 'object' ? s.date : s)); return m ? [+m[1], +m[2], +m[3]] : null; };
const sundayOf = (y, c) => (new Date(Date.UTC(y, 0, 1)).getUTCDay() + c) % 7 === 0;   // calendar day c of year y is a Sunday

// { "2019": [dates] } (other keys such as a source note are ignored), { holidays: … }, or a flat array of dates
// → Map year → [[month, day], …]; a date is kept under its own year
function listByYear(list) {
  const out = new Map();
  const add = (v) => { const p = parseISO(v); if (p) { if (!out.has(p[0])) out.set(p[0], []); out.get(p[0]).push([p[1], p[2]]); } };
  if (Array.isArray(list)) list.forEach(add);
  else if (list && typeof list === 'object') {
    const years = Object.keys(list).filter((k) => /^\d{4}$/.test(k));
    if (!years.length && list.holidays) return listByYear(list.holidays);
    for (const k of years) if (Array.isArray(list[k])) list[k].forEach(add);
  }
  return out;
}

// list: { "2019": ["2019-01-01", ...], ... }; opts: { sundayRule: 'auto' | 'apply' | 'none', school: list }
// → { publicHolidays(y), schoolHolidays(y) | null, sourceYear(y), sundayRule }: file days as publicHolidays above
export function cityCalendar(list, opts = {}) {
  const pub = listByYear(list), sch = opts.school ? listByYear(opts.school) : null;
  let rule = opts.sundayRule || 'auto';
  if (rule === 'auto') {
    let sundays = 0, followed = 0;
    for (const [y, md] of pub) {
      const set = new Set(md.map(([m, d]) => calDay(y, m, d)));
      for (const c of set) if (sundayOf(y, c)) { sundays++; if (set.has(c + 1)) followed++; }
    }
    rule = sundays > 0 && followed === sundays ? 'none' : 'apply';
  }
  const nearest = (byYear, y) => {
    if (byYear.has(y)) return y;
    let best = null;
    for (const k of byYear.keys()) if (best == null || Math.abs(k - y) < Math.abs(best - y) || (Math.abs(k - y) === Math.abs(best - y) && k < best)) best = k;
    return best;
  };
  const daysOf = (byYear, y, inLieu) => {
    const from = nearest(byYear, y);
    const cals = new Set();
    for (const [m, d] of from == null ? [] : byYear.get(from)) if (!(m === 2 && d === 29 && !isLeap(y))) cals.add(calDay(y, m, d));
    if (inLieu) for (const c of [...cals].sort((a, b) => a - b)) if (sundayOf(y, c)) { let n = c + 1; while (cals.has(n)) n++; cals.add(n); }
    const last = calDay(y, 12, 31);
    return [...cals].filter((c) => c >= 0 && c <= last).map((c) => fileDay(y, c)).filter((d) => d >= 0 && d < 365).sort((a, b) => a - b);
  };
  const cache = new Map();
  return {
    sundayRule: rule,
    sourceYear: (y) => nearest(pub, y),
    publicHolidays: (y) => { if (!cache.has(y)) cache.set(y, daysOf(pub, y, rule === 'apply')); return cache.get(y); },
    schoolHolidays: sch ? (y) => daysOf(sch, y, false) : null,
  };
}

// Days off of a profile in year y: a Set of file days. Empty for profiles in use every day around the clock (residential).
// cal: a calendar from cityCalendar (another city); without it the Bavarian holidays apply.
export function daysOff(profile, y, cal = null) {
  const days = profile.daysPerWeek ?? 7, hours = (profile.end ?? 24) - (profile.start ?? 0);
  const off = new Set();
  if (days >= 7 && hours >= 24) return off;
  const isUse = (d) => weekdayOf(y, d) <= days;
  for (const d of cal ? cal.publicHolidays(y) : publicHolidays(y)) if (isUse(d)) off.add(d);
  if (profile.holidays === 'school') for (const d of cal ? (cal.schoolHolidays ? cal.schoolHolidays(y) : []) : schoolHolidays(y)) if (isUse(d)) off.add(d);
  const use = []; for (let d = 0; d < 365; d++) if (isUse(d) && !off.has(d)) use.push(d);
  const extra = profile.daysPerYear ? use.length - profile.daysPerYear : 0;
  if (extra > 0) { const step = use.length / extra; for (let j = 0; j < extra; j++) off.add(use[Math.floor((j + 0.5) * step)]); }
  return off;
}

// month and day of file day d (for the EnergyPlus special days)
export function dateOf(y, d) {
  const t = new Date(Date.UTC(y, 0, 1 + calOf(y, d)));
  return [t.getUTCMonth() + 1, t.getUTCDate()];
}

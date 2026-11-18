// Small SVG chart helpers. Colors come from CSS custom properties so light/dark themes work.
import * as I18N from './i18n.js';

export const MONTHS = I18N.L(['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
export const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString(I18N.LOCALE, { maximumFractionDigits: d, minimumFractionDigits: d }));
export const fmtK = (v) => (Math.abs(v) >= 10000 ? fmt(v / 1000, 1) + ' MWh' : fmt(v) + ' kWh');

function svgBox(container, w, h) {
  container.innerHTML = '';
  const s = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', role: 'img' }, container);
  s.style.display = 'block';
  return s;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * e >= v) return m * e;
  return 10 * e;
}

function tooltipFor(container) {
  let t = container.querySelector('.chart-tip');
  if (!t) { t = document.createElement('div'); t.className = 'chart-tip'; t.hidden = true; container.style.position = 'relative'; container.appendChild(t); }
  return t;
}
function bindTip(container, node, html) {
  node.addEventListener('mouseenter', () => { const t = tooltipFor(container); t.innerHTML = html; t.hidden = false; });
  node.addEventListener('mousemove', (e) => { const t = tooltipFor(container); const r = container.getBoundingClientRect(); t.style.left = `${Math.min(r.width - 160, e.clientX - r.left + 12)}px`; t.style.top = `${e.clientY - r.top + 12}px`; });
  node.addEventListener('mouseleave', () => { tooltipFor(container).hidden = true; });
}

// Monthly bars: series = [{ label, values[12], color }], band = [[lo, hi] x12] optional, points = [12] optional (measured)
const widthOf = (c, fallback = 640) => Math.max(300, Math.round(c.clientWidth || fallback));
export function monthly(container, { series, band, points, unit = 'kWh', height = 210 }) {
  const W = widthOf(container), H = height, L = 52, R = 10, T = 26, B = 26;
  const s = svgBox(container, W, H);
  const months = MONTHS;
  const all = [...series.flatMap((x) => x.values), ...(band ? band.map((b) => b[1]) : []), ...(points || []).filter((v) => v != null)];
  const ymax = niceMax(Math.max(1, ...all));
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  const bw = (W - L - R) / 12;
  const big = ymax >= 10000;
  for (let k = 0; k <= 4; k++) {
    const v = (ymax * k) / 4;
    el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }, s);
    el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, s).textContent = fmt(big ? v / 1000 : v, big && ymax < 40000 ? 1 : 0);
  }
  el('text', { x: L - 6, y: 11, 'text-anchor': 'end', class: 'tick' }, s).textContent = big ? 'MWh' : unit;
  const nS = series.length;
  months.forEach((mn, m) => {
    const x0 = L + m * bw;
    let acc = 0;
    series.forEach((sr) => {
      const v = sr.values[m];
      if (sr.stack) {
        const r = el('rect', { x: x0 + bw * 0.18, width: bw * 0.64, y: y(acc + v), height: Math.max(0, y(acc) - y(acc + v)), fill: sr.color, rx: 1.5 }, s);
        bindTip(container, r, `${mn} · ${sr.label}<br><b>${fmtK(v)}</b>`);
        acc += v;
      }
    });
    series.filter((sr) => !sr.stack).forEach((sr, si, arr) => {
      const v = sr.values[m];
      const w = (bw * 0.7) / arr.length;
      const r = el('rect', { x: x0 + bw * 0.15 + si * w, width: w - 1, y: y(v), height: Math.max(0, y(0) - y(v)), fill: sr.color, rx: 1.5 }, s);
      bindTip(container, r, `${mn} · ${sr.label}<br><b>${fmtK(v)}</b>`);
    });
    if (band) {
      const [lo, hi] = band[m];
      el('line', { x1: x0 + bw / 2, x2: x0 + bw / 2, y1: y(lo), y2: y(hi), class: 'band' }, s);
      el('line', { x1: x0 + bw / 2 - 5, x2: x0 + bw / 2 + 5, y1: y(lo), y2: y(lo), class: 'band' }, s);
      el('line', { x1: x0 + bw / 2 - 5, x2: x0 + bw / 2 + 5, y1: y(hi), y2: y(hi), class: 'band' }, s);
    }
    if (points && points[m] != null) {
      const c = el('circle', { cx: x0 + bw / 2, cy: y(points[m]), r: 4.5, class: 'meas' }, s);
      bindTip(container, c, `${mn} · ${I18N.L('实测', 'Measured', 'Gemessen')}<br><b>${fmtK(points[m])}</b>`);
    }
    el('text', { x: x0 + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, s).textContent = mn;
  });
  return s;
}

// Horizontal bars: items = [{ label, value, color, lo, hi, note }]
export function hbars(container, items, { unit = 'kWh/a', max, height, signed = false, valueFmt, selected = -1, onPick = null } = {}) {
  const W = widthOf(container), rowH = 26, R = 92, T = 6;
  // Label column sized to the longest label (measured), so long labels are not cut off; at most half the width.
  let need = 0;
  try {
    const c = (hbars.ctx = hbars.ctx || document.createElement('canvas').getContext('2d'));
    c.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    need = Math.max(...items.map((i) => c.measureText(String(i.label)).width)) + 14;
  } catch { need = 7 * Math.max(...items.map((i) => String(i.label).length)) + 14; }
  const L = Math.round(Math.min(Math.max(60, need), W * 0.5));
  const H = height || T * 2 + rowH * items.length;
  const s = svgBox(container, W, H);
  const vmax = max || niceMax(Math.max(1e-9, ...items.map((i) => Math.abs(i.hi ?? i.value))));
  const zero = signed ? L + (W - L - R) / 2 : L;
  const scale = (signed ? (W - L - R) / 2 : W - L - R) / vmax;
  if (signed) el('line', { x1: zero, x2: zero, y1: 0, y2: H, class: 'axis' }, s);
  items.forEach((it, i) => {
    const yy = T + i * rowH;
    if (i === selected) el('rect', { x: 0, y: yy + 1, width: W, height: rowH - 2, rx: 4, class: 'sel' }, s);
    el('text', { x: L - 8, y: yy + rowH / 2 + 4, 'text-anchor': 'end', class: i === selected ? 'lbl on' : 'lbl' }, s).textContent = it.label;
    const v = it.value;
    const x0 = v >= 0 ? zero : zero + v * scale;
    const r = el('rect', { x: x0, y: yy + 5, width: Math.max(0.5, Math.abs(v) * scale), height: rowH - 10, fill: it.color || 'var(--c1)', rx: 2 }, s);
    if (it.lo != null && it.hi != null) {
      el('line', { x1: zero + it.lo * scale, x2: zero + it.hi * scale, y1: yy + rowH / 2, y2: yy + rowH / 2, class: 'band' }, s);
      el('line', { x1: zero + it.lo * scale, x2: zero + it.lo * scale, y1: yy + 7, y2: yy + rowH - 7, class: 'band' }, s);
      el('line', { x1: zero + it.hi * scale, x2: zero + it.hi * scale, y1: yy + 7, y2: yy + rowH - 7, class: 'band' }, s);
    }
    el('text', { x: W - R + 6, y: yy + rowH / 2 + 4, class: 'val' }, s).textContent = valueFmt ? valueFmt(it) : `${fmt(v)} ${unit}`;
    let target = r;
    if (onPick) {   // whole row is the hit area; drawn last so it sits on top
      target = el('rect', { x: 0, y: yy, width: W, height: rowH, fill: 'transparent', class: 'hit', tabindex: 0, role: 'button', 'aria-label': it.label }, s);
      target.addEventListener('click', () => onPick(it, i));
      target.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(it, i); } });
    }
    bindTip(container, target, `${it.label}<br><b>${valueFmt ? valueFmt(it) : fmt(v) + ' ' + unit}</b>${it.note ? '<br>' + it.note : ''}`);
  });
  return s;
}

// Prior vs posterior histograms for one parameter
export function dist(container, { prior, post, label, unit = '', log = false, width = 300, height = 110, mark = null }) {
  const W = container.clientWidth ? Math.round(container.clientWidth) : width, H = height, L = 8, R = 8, T = 18, B = 20;
  const s = svgBox(container, W, H);
  const tr = (v) => (log ? Math.log(Math.max(1e-6, v)) : v);
  const all = [...prior, ...(post || [])].map(tr).sort((a, b) => a - b);
  const lo = all[Math.floor(0.01 * (all.length - 1))], hi = all[Math.ceil(0.99 * (all.length - 1))];
  const nb = 24, bw = (hi - lo) / nb || 1;
  const hist = (arr) => { const h = new Array(nb).fill(0); for (const v of arr) { const k = Math.floor((tr(v) - lo) / bw); if (k >= 0 && k < nb) h[k]++; } const m = arr.length || 1; return h.map((c) => c / m); };
  const hp = hist(prior), hq = post ? hist(post) : null;
  const ymax = Math.max(...hp, ...(hq || [0])) || 1;
  const x = (k) => L + ((W - L - R) * k) / nb;
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  const path = (h) => 'M' + h.map((v, k) => `${x(k)},${y(v)} ${x(k + 1)},${y(v)}`).join(' L') + ` L${x(nb)},${y(0)} L${x(0)},${y(0)} Z`;
  el('path', { d: path(hp), class: 'h-prior' }, s);
  if (hq) el('path', { d: path(hq), class: 'h-post' }, s);
  const inv = (t) => (log ? Math.exp(t) : t);
  if (mark != null && Number.isFinite(mark)) {
    const xm = L + ((W - L - R) * (tr(mark) - lo)) / (hi - lo || 1);
    if (xm >= L - 1 && xm <= W - R + 1) el('line', { x1: xm, x2: xm, y1: T - 4, y2: H - B, class: 'truth' }, s);
  }
  el('text', { x: L, y: 12, class: 'lbl' }, s).textContent = label;
  el('text', { x: L, y: H - 5, class: 'tick' }, s).textContent = fmt(inv(lo), 2);
  el('text', { x: W - R, y: H - 5, 'text-anchor': 'end', class: 'tick' }, s).textContent = `${fmt(inv(hi), 2)} ${unit}`;
  return s;
}

// Category bars (two series)
export function cats(container, { labels, a, b, aLabel = I18N.L('先验', 'Prior', 'Prior'), bLabel = I18N.L('后验', 'Posterior', 'Posterior'), height = 150 }) {
  const W = widthOf(container), H = height, L = 10, R = 10, T = 18, B = 34;
  const s = svgBox(container, W, H);
  const n = labels.length, bw = (W - L - R) / n;
  const ymax = Math.max(...a, ...(b || [0]), 0.01);
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  labels.forEach((lb, i) => {
    const x0 = L + i * bw;
    const ra = el('rect', { x: x0 + bw * 0.14, width: bw * (b ? 0.34 : 0.7), y: y(a[i]), height: y(0) - y(a[i]), class: 'c-prior', rx: 1.5 }, s);
    bindTip(container, ra, `${lb}<br>${aLabel} ${(a[i] * 100).toFixed(1)}%`);
    if (b) { const rb = el('rect', { x: x0 + bw * 0.5, width: bw * 0.34, y: y(b[i]), height: y(0) - y(b[i]), class: 'c-post', rx: 1.5 }, s); bindTip(container, rb, `${lb}<br>${bLabel} ${(b[i] * 100).toFixed(1)}%`); }
    const parts = lb.includes(' ') ? [lb.split(' ')[0], lb.split(' ').slice(1).join(' ')] : [lb, ''];
    const t = el('text', { x: x0 + bw / 2, y: H - 20, 'text-anchor': 'middle', class: 'tick' }, s); t.textContent = parts[0];
    const t2 = el('text', { x: x0 + bw / 2, y: H - 7, 'text-anchor': 'middle', class: 'tick sub' }, s); t2.textContent = parts[1];
  });
  return s;
}

// Correlation heatmap
export function heat(container, { keys, labels, C }) {
  const n = keys.length, cell = 26, L = 120, T = 110;
  const W = L + n * cell + 10, H = T + n * cell + 10;
  const s = svgBox(container, W, H);
  const col = (v) => {
    const a = Math.min(1, Math.abs(v));
    return v >= 0 ? `color-mix(in oklab, var(--pos) ${Math.round(a * 100)}%, var(--surface))` : `color-mix(in oklab, var(--neg) ${Math.round(a * 100)}%, var(--surface))`;
  };
  keys.forEach((k, i) => {
    el('text', { x: L - 6, y: T + i * cell + cell / 2 + 4, 'text-anchor': 'end', class: 'tick' }, s).textContent = labels[i];
    const t = el('text', { x: L + i * cell + cell / 2, y: T - 6, class: 'tick', transform: `rotate(-50 ${L + i * cell + cell / 2} ${T - 6})` }, s);
    t.textContent = labels[i];
    keys.forEach((_, j) => {
      const r = el('rect', { x: L + j * cell, y: T + i * cell, width: cell - 1, height: cell - 1, fill: col(C[i][j]) }, s);
      bindTip(container, r, `${labels[i]} × ${labels[j]}<br>${I18N.L('相关系数', 'Correlation', 'Korrelation')} <b>${C[i][j].toFixed(2)}</b>`);
    });
  });
  return s;
}

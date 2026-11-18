// Street-level photos of the selected building (Mapillary, js/mapillary.js), shared by the Overview card (main.js)
// and the hidden lab entries. One search per building, cached by building id; the camera positions go to the map through
// ctx.setPhotos. Without a token (config.local.json) only the link to the Mapillary web app is shown.
import { L, LOCALE } from './i18n.js';
import { token, appUrl, imageUrl, viewsFor, viewX } from './mapillary.js';

const cache = new Map();   // building id → Promise<{ views } | { noToken } | { error }>
function load(m) {
  if (!cache.has(m.id)) {
    cache.set(m.id, (async () => {
      const tok = await token();
      if (!tok) return { noToken: true };
      try { return { views: await viewsFor(m.lonlatOuter, tok, { neighbours: m.nbLonLat }) }; } catch (e) { cache.delete(m.id); return { error: e.message }; }
    })());
  }
  return cache.get(m.id);
}

export const photoLink = (h, m, id) => h('a', { href: appUrl(m.center.lat, m.center.lon), target: '_blank', rel: 'noopener', id: id || null, class: 'mly-link' },
  L('在 Mapillary 打开这里', 'Open this place in Mapillary', 'Diesen Ort in Mapillary öffnen') + ' ↗');

// Fill `box` with the photos of building m. ctx: { h, fmt, info, setPhotos, tokenHint } (tokenHint: explain how to add
// a token when there is none; only the lab does). A click on a photo opens it in the Mapillary web app, turned to the building.
export async function fillPhotos(box, m, ctx) {
  const { h, fmt } = ctx;
  const line = (cls, ...kids) => h('p', { class: `ph-line${cls ? ' ' + cls : ''}` }, ...kids);
  box.dataset.for = m.id;
  if (!box.firstChild || box.dataset.shown !== m.id) box.replaceChildren(line('mute', L('正在找照片…', 'Looking for photos…', 'Suche nach Fotos …')));
  const r = await load(m);
  if (box.dataset.for !== m.id) return;   // another building was picked meanwhile
  box.dataset.shown = m.id;
  if (r.noToken) {
    ctx.setPhotos?.(null);
    box.replaceChildren(...(ctx.tokenHint ? [line('mute', L('没有 Mapillary 令牌：照片只能在网站上看', 'No Mapillary token: photos only on the website', 'Kein Mapillary-Token: Fotos nur auf der Website'),
      ctx.info(L('在 mapillary.com/dashboard/developers 注册一个应用，把它的 client token 写进项目根目录的 config.local.json（格式见 config.local.example.json）。这个文件不进 git，令牌只放在请求头里发给 Mapillary。',
        'Register an app at mapillary.com/dashboard/developers and put its client token into config.local.json in the project root (format in config.local.example.json). Git ignores this file; the token goes to Mapillary only in the request header.',
        'Registrieren Sie eine App unter mapillary.com/dashboard/developers und tragen Sie ihr Client-Token in config.local.json im Projektverzeichnis ein (Format in config.local.example.json). Git ignoriert diese Datei; das Token geht nur im Anfrage-Header an Mapillary.')))] : []));
    return;
  }
  if (r.error) { ctx.setPhotos?.(null); box.replaceChildren(line('mute', L(`Mapillary 没有回应（${r.error}）`, `Mapillary did not answer (${r.error})`, `Mapillary hat nicht geantwortet (${r.error})`))); return; }
  const views = r.views;
  ctx.setPhotos?.(views);
  if (!views.length) { box.replaceChildren(line('mute', L('60 m 内没有拍到这栋楼的照片', 'No photo within 60 m shows this building', 'Kein Foto im Umkreis von 60 m zeigt dieses Gebäude'))); return; }
  const date = (ms) => (ms ? new Date(ms).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short' }) : '–');
  // A panorama is shown as a window of about 110° turned toward the building (background repeat-x wraps at 0/360°):
  // with the 2:1 image drawn at 220 % of the 4:3 box height, image width = 4.4 H and box width = 4/3 H, so putting the
  // image x at the box centre needs background-position-x = (4.4 x − 2/3) / (4.4 − 4/3) of the free width. A normal
  // photo is shifted the same way within its own overflow (object-fit: cover), as far as it can go. Two small marks
  // (.ph-at, top and bottom) show where the building is in the picture.
  const panoPos = (x) => `${(((4.4 * x - 2 / 3) / (4.4 - 4 / 3)) * 100).toFixed(2)}% 45%`;
  const mark = () => h('span', { class: 'ph-at', 'aria-hidden': 'true' });
  const shift = (img, at, x) => {   // centre the building in a cropped normal photo, then place the mark where it ends up
    const r = img.naturalWidth / img.naturalHeight / (4 / 3);   // image width in box widths when the heights match
    if (!(r > 1.001)) { at.style.left = `${(100 * x).toFixed(1)}%`; return; }
    const p = Math.max(0, Math.min(1, (x * r - 0.5) / (r - 1)));
    img.style.objectPosition = `${(100 * p).toFixed(1)}% 50%`;
    at.style.left = `${(100 * (x * r - p * (r - 1))).toFixed(1)}%`;
  };
  box.replaceChildren(h('div', { class: 'photos' }, ...views.map((v, i) => { const x = viewX(v); const at = mark(); return h('a', { class: 'ph', href: imageUrl(v.id, x, 0.47), target: '_blank', rel: 'noopener',
    title: v.pano ? L('在 Mapillary 里打开这张全景，镜头朝向这栋楼', 'Open this panorama in Mapillary, turned toward this building', 'Dieses Panorama in Mapillary öffnen, zum Gebäude gedreht')
      : L('在 Mapillary 里打开这张照片', 'Open this photo in Mapillary', 'Dieses Foto in Mapillary öffnen') },
  !v.thumb ? null : h('span', { class: 'ph-frame' },
    v.pano ? h('span', { class: 'ph-pano', role: 'img', 'aria-label': L(`全景 ${i + 1}，朝向这栋楼`, `Panorama ${i + 1}, toward this building`, `Panorama ${i + 1}, zum Gebäude`), style: `background-image:url("${v.thumb}");background-position:${panoPos(x)}` })
      : h('img', { src: v.thumb, alt: L(`照片 ${i + 1}`, `Photo ${i + 1}`, `Foto ${i + 1}`), loading: 'lazy', onload: (e) => shift(e.target, at, x) }),
    at),
  h('span', { class: 'ph-k' }, h('b', {}, String(i + 1)), ` ${date(v.capturedAt)} · ${fmt(v.dist)} m${v.pano ? ' · 360°' : ''}`),
  h('span', { class: 'ph-c' }, `© ${v.creator || 'Mapillary'} · Mapillary · CC BY-SA 4.0`)); })));
}

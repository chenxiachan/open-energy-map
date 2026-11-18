// MapLibre map with OpenFreeMap vector tiles, 3D building extrusions and the selected building highlighted.
/* global maplibregl */

const STYLE = { light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' };

export function createMap(container, { onClick, onCityHover, dark = false, center = [11.5679, 48.1497] }) {
  const map = new maplibregl.Map({
    container, style: dark ? STYLE.dark : STYLE.light, center, zoom: 15.6, pitch: 52, bearing: -18, maxPitch: 75,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  let sel = null, nb = null, cam = null, wcam = null, isDark = dark;   // cam: Mapillary cameras of the photo card; wcam: the street walk (js/walk.js)
  let inset = 0;   // px of the map hidden under the street walk at the top
  let saved = null;   // the map view before the small-map mode
  // City overview (data/city/grid.json via main.js): the 100 m Zensus cells at every zoom, drawn flat under the 3D
  // buildings (no coarser layer when zoomed out: the cells keep the texture of where buildings are). They fade as one
  // zooms in to pick buildings; thin cell borders appear only from zoom 14, where a cell is large enough to read.
  // city = { c100: FeatureCollection, metric, breaks: [k numbers], colors: { light: [k + 1], dark: [k + 1] }, show }; a
  // categorical metric has cats: [k values] and colors: { light: [k + 1], dark: [k + 1] }, the last for any other value
  let city = null;
  const CITY = ['city100', 'city100-edge'];
  const cityColor = () => {
    const c = city.colors[isDark ? 'dark' : 'light'], v = ['get', city.metric];
    return ['case', ['==', v, null], 'rgba(0,0,0,0)', city.cats ? ['match', v, ...city.cats.flatMap((k, i) => [k, c[i]]), c[city.cats.length]] : ['step', v, c[0], ...city.breaks.flatMap((b, i) => [b, c[i + 1]])]];
  };
  const hasValue = () => ['!=', ['get', city.metric], null];
  const addCity = () => {
    if (!city) return;
    if (!map.getSource('city100')) map.addSource('city100', { type: 'geojson', data: city.c100, buffer: 16 });
    const before = map.getLayer('b3d') ? 'b3d' : undefined, vis = { visibility: city.show ? 'visible' : 'none' };
    // no antialiasing: neighbouring cells share exact edges, so they meet without the hairline seams of blended edges
    // cells without a value for the metric (e.g. no building in the scope of the bill comparison) are not drawn at all
    if (!map.getLayer('city100')) map.addLayer({ id: 'city100', type: 'fill', source: 'city100', layout: vis, filter: hasValue(),
      paint: { 'fill-antialias': false, 'fill-color': cityColor(), 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.85, 13, 0.74, 15.5, 0.5, 17.5, 0.26] } }, before);
    if (!map.getLayer('city100-edge')) map.addLayer({ id: 'city100-edge', type: 'line', source: 'city100', minzoom: 14, layout: vis,
      filter: hasValue(),
      paint: { 'line-color': isDark ? '#1b1e21' : '#f2f2ee', 'line-width': 0.8, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.7] } }, before);
  };

  const addLayers = () => {
    const src = Object.keys(map.getStyle().sources).find((k) => map.getStyle().sources[k].type === 'vector');
    // hide flat building fills of the base style, add our own extrusion
    for (const l of map.getStyle().layers) if (l['source-layer'] === 'building' && l.type !== 'fill-extrusion' && map.getLayer(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
    for (const l of map.getStyle().layers) if (l.type === 'fill-extrusion' && map.getLayer(l.id)) map.removeLayer(l.id);
    if (src && !map.getLayer('b3d')) {
      map.addLayer({
        id: 'b3d', type: 'fill-extrusion', source: src, 'source-layer': 'building', minzoom: 13,
        paint: {
          'fill-extrusion-color': isDark ? '#3a3f45' : '#dcdcd6',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          // fade in from zoom 13 to 14.2: zoomed out, the city cells carry the picture and small boxes only clutter it
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, isDark ? 0.85 : 0.8],
        },
      });
    }
    addCity();
    if (!map.getSource('nb')) map.addSource('nb', { type: 'geojson', data: nb || empty() });
    if (!map.getSource('sel')) map.addSource('sel', { type: 'geojson', data: sel || empty() });
    if (!map.getSource('cam')) map.addSource('cam', { type: 'geojson', data: cam || empty() });
    if (!map.getSource('walkcam')) map.addSource('walkcam', { type: 'geojson', data: wcam || empty() });
    if (!map.getLayer('cam-ray')) map.addLayer({ id: 'cam-ray', type: 'line', source: 'cam', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': isDark ? '#f2b33d' : '#b35c00', 'line-width': 2, 'line-opacity': 0.9 } });
    if (!map.getLayer('cam-pt')) map.addLayer({ id: 'cam-pt', type: 'circle', source: 'cam', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': isDark ? '#f2b33d' : '#b35c00', 'circle-stroke-width': 2, 'circle-stroke-color': isDark ? '#1b1e21' : '#ffffff' } });
    if (!map.getLayer('cam-no')) map.addLayer({ id: 'cam-no', type: 'symbol', source: 'cam', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['get', 'n'], 'text-size': 10, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': isDark ? '#1b1e21' : '#ffffff' } });
    // the street walk's camera: a cone of its field of view under a dot, in the orange of the photo cameras
    if (!map.getLayer('walkcam-cone')) map.addLayer({ id: 'walkcam-cone', type: 'fill', source: 'walkcam', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': isDark ? '#f2b33d' : '#b35c00', 'fill-opacity': 0.3 } });
    if (!map.getLayer('walkcam-pt')) map.addLayer({ id: 'walkcam-pt', type: 'circle', source: 'walkcam', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': isDark ? '#f2b33d' : '#b35c00', 'circle-stroke-width': 2.5, 'circle-stroke-color': isDark ? '#1b1e21' : '#ffffff' } });
    if (!map.getLayer('nb-line')) map.addLayer({ id: 'nb-line', type: 'line', source: 'nb', paint: { 'line-color': isDark ? '#7ea6e0' : '#3c6aa8', 'line-width': 1, 'line-opacity': 0.55 } });
    if (!map.getLayer('sel-3d')) map.addLayer({ id: 'sel-3d', type: 'fill-extrusion', source: 'sel', paint: { 'fill-extrusion-color': isDark ? '#3fb8b5' : '#0e7c7b', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.92 } });
  };
  // MapLibre 4 fires only 'styledata' after setStyle(); add our layers once the new style is usable
  const ensure = () => { if (map.getStyle() && map.getStyle().layers && !map.getLayer('sel-3d')) { try { addLayers(); } catch (e) { setTimeout(ensure, 200); } } };
  map.on('load', ensure);
  map.on('styledata', ensure);
  map.on('click', (e) => onClick(e.lngLat.lng, e.lngLat.lat));
  map.on('mousemove', (e) => {
    const f = map.getLayer('b3d') ? map.queryRenderedFeatures(e.point, { layers: ['b3d'] }) : [];
    map.getCanvas().style.cursor = f.length ? 'pointer' : '';
    if (!onCityHover) return;
    const layers = city?.show && map.getLayer('city100') ? ['city100'] : [];
    // the cell readout also over buildings while zoomed out (below 15 the buildings are small and the cells are the point)
    const c = layers.length && (!f.length || map.getZoom() < 15) ? map.queryRenderedFeatures(e.point, { layers }) : [];
    onCityHover(c.length ? c[0].properties : null, e.point);
  });
  map.on('mouseout', () => onCityHover?.(null));
  map.on('movestart', () => onCityHover?.(null));

  function empty() { return { type: 'FeatureCollection', features: [] }; }
  return {
    map,
    setSelection(model) {
      const ring = (r) => { const c = r.slice(); c.push(r[0]); return c; };
      sel = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { h: model.height + (model.roof.ridgeHeight || 0) * 0.5 }, geometry: { type: 'Polygon', coordinates: [ring(model.lonlatOuter)] } }] };
      nb = { type: 'FeatureCollection', features: (model.nbLonLat || []).map((r) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(r)] } })) };
      map.getSource('sel')?.setData(sel);
      map.getSource('nb')?.setData(nb);
    },
    // Mapillary cameras: a numbered dot per photo and a 14 m ray along its heading (for a 360° photo: toward the building); null clears
    setPhotos(views) {
      const f = [];
      for (const [i, v] of (views || []).entries()) {
        f.push({ type: 'Feature', properties: { n: String(i + 1) }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } });
        const dir = v.pano ? v.look : v.heading;   // a panorama: the direction its card window and link turn to
        if (dir != null) {
          const k = 14 / 110540, a = (dir * Math.PI) / 180;
          f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[v.lon, v.lat], [v.lon + (k * Math.sin(a)) / Math.cos((v.lat * Math.PI) / 180), v.lat + k * Math.cos(a)]] } });
        }
      }
      cam = { type: 'FeatureCollection', features: f };
      map.getSource('cam')?.setData(cam);
    },
    // The street walk (js/walk.js): where its camera stands and looks, as a 24 m cone of the horizontal field of view;
    // null clears. setTopInset keeps the map centred in the part left visible under the walk; follow pans only when
    // the camera leaves that part (always, for the small map of the full-screen walk).
    setWalkCam(c) {
      const f = [];
      if (c) {
        const k = 24 / 110540, cl = Math.cos((c.lat * Math.PI) / 180), half = Math.min(80, (c.hfov || 60) / 2);
        const at = (a) => [c.lon + (k * Math.sin((a * Math.PI) / 180)) / cl, c.lat + k * Math.cos((a * Math.PI) / 180)];
        const arc = Array.from({ length: 9 }, (_, i) => at(c.bearing - half + (i * 2 * half) / 8));
        f.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[c.lon, c.lat], ...arc, [c.lon, c.lat]]] } });
        f.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } });
      }
      wcam = { type: 'FeatureCollection', features: f };
      map.getSource('walkcam')?.setData(wcam);
    },
    setTopInset(px) { inset = px; map.easeTo({ padding: { top: px, bottom: 0, left: 0, right: 0 }, duration: 300 }); },
    follow(lon, lat, o = {}) {
      if (o.always) { map.jumpTo({ center: [lon, lat], padding: { top: 0, bottom: 0, left: 0, right: 0 } }); return; }   // the small map of the full-screen walk
      const p = map.project([lon, lat]), c = map.getContainer(), m = 40;
      if (p.x < m || p.x > c.clientWidth - m || p.y < inset + m || p.y > c.clientHeight - m) map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 17.5), duration: 500 });
    },
    // small map in the corner of the full-screen walk: straight down, north up, zoom 17; the old view comes back after
    miniMode(on) {
      if (on && !saved) { saved = { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), center: map.getCenter() }; map.stop(); inset = 0; map.jumpTo({ zoom: 17, pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } }); }
      else if (!on && saved) { map.jumpTo(saved); saved = null; }
    },
    flyTo(lon, lat) { map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 17), pitch: 55, speed: 1.4 }); },
    setDark(d) {
      isDark = d;
      map.setStyle(d ? STYLE.dark : STYLE.light, { diff: false });
      // re-add our layers once the new style has loaded (poll: MapLibre's style events are unreliable here)
      let n = 0;
      const t = setInterval(() => {
        n++;
        if (map.getStyle()?.layers?.length && !map.getLayer('sel-3d')) { try { addLayers(); } catch { /* retry */ } }
        if (map.getLayer('sel-3d') || n > 60) clearInterval(t);
      }, 250);
    },
    resize() { map.resize(); },
    setCity(c) { city = c; for (const id of CITY) if (map.getLayer(id)) map.removeLayer(id); if (map.getSource('city100')) map.removeSource('city100'); if (map.getLayer('b3d')) addCity(); },
    setCityStyle({ metric, breaks, cats, colors, show }) {
      if (!city) return;
      Object.assign(city, metric ? { metric, breaks, cats, colors } : {}, show == null ? {} : { show });
      if (!map.getLayer('city100')) return;
      map.setPaintProperty('city100', 'fill-color', cityColor());
      for (const id of CITY) map.setFilter(id, hasValue());
      for (const id of CITY) map.setLayoutProperty(id, 'visibility', city.show ? 'visible' : 'none');
    },
    zoom() { return map.getZoom(); },
    // bbox [lon0, lat0, lon1, lat1] of a layer that covers only a pilot area: frame it unless most of it is in view and
    // it fills a fair part of the view
    showArea(bb) {
      const v = map.getBounds(), a = (bb[2] - bb[0]) * (bb[3] - bb[1]), va = (v.getEast() - v.getWest()) * (v.getNorth() - v.getSouth());
      const ix = Math.max(0, Math.min(v.getEast(), bb[2]) - Math.max(v.getWest(), bb[0])) * Math.max(0, Math.min(v.getNorth(), bb[3]) - Math.max(v.getSouth(), bb[1]));
      if (ix > 0.5 * a && a > 0.1 * va) return;
      map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 40, pitch: 35, bearing: map.getBearing(), maxZoom: 15, duration: 900 });
    },
    // the city legend sits in MapLibre's bottom-left control slot, so it never covers the attribution (bottom right)
    mountLegend(el) { map.addControl({ onAdd: () => el, onRemove: () => el.remove() }, 'bottom-left'); },
  };
}

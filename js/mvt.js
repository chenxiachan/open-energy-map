// Minimal Mapbox Vector Tile decoder (protobuf, spec 2.1), enough for the Mapillary coverage tiles (js/mapillary.js in
// the browser, tools/mapillary_coverage.mjs in Node). No dependencies.
export function decodeMVT(buf) {
  let pos = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const skip = (wt) => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) { const l = varint(); pos += l; } else if (wt === 5) pos += 4; else throw new Error('wire type ' + wt); };
  const msg = (end, onField) => { while (pos < end) { const k = varint(), f = Math.floor(k / 8), wt = k & 7; if (!onField(f, wt)) skip(wt); } };
  const str = (l) => { const s = new TextDecoder().decode(buf.subarray(pos, pos + l)); pos += l; return s; };
  const packed = () => { const l = varint(), end = pos + l, a = []; while (pos < end) a.push(varint()); return a; };
  const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const layers = {};
  msg(buf.length, (f, wt) => {
    if (f !== 3 || wt !== 2) return false;
    const l = varint(), end = pos + l;
    const L = { name: '', keys: [], values: [], extent: 4096, feats: [] };
    msg(end, (g, wt2) => {
      if (g === 1) { L.name = str(varint()); return true; }
      if (g === 3) { L.keys.push(str(varint())); return true; }
      if (g === 5) { L.extent = varint(); return true; }
      if (g === 4) {
        const vl = varint(), vend = pos + vl; let v = null;
        msg(vend, (h, wt3) => {
          if (h === 1) { v = str(varint()); return true; }
          if (h === 2) { v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true); pos += 4; return true; }
          if (h === 3) { v = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true); pos += 8; return true; }
          if (h === 4 || h === 5) { v = varint(); return true; }
          if (h === 6) { v = zz(varint()); return true; }
          if (h === 7) { v = !!varint(); return true; }
          return false;
        });
        L.values.push(v); return true;
      }
      if (g === 2) {
        const fl = varint(), fend = pos + fl, F = { id: null, tags: [], type: 0, geom: [] };
        msg(fend, (h, wt3) => {
          if (h === 1) { F.id = varint(); return true; }
          if (h === 2) { F.tags = packed(); return true; }
          if (h === 3) { F.type = varint(); return true; }
          if (h === 4) { F.geom = packed(); return true; }
          return false;
        });
        L.feats.push(F); return true;
      }
      return false;
    });
    layers[L.name] = L;
    return true;
  });
  return layers;
}
// properties and the first point of a feature (tile coordinates 0..extent)
export function props(L, F) { const p = {}; for (let i = 0; i < F.tags.length; i += 2) p[L.keys[F.tags[i]]] = L.values[F.tags[i + 1]]; return p; }
export function firstPoint(F) { if (!F.geom.length) return null; const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2); return [zz(F.geom[1]), zz(F.geom[2])]; }
// all parts of a feature as arrays of [x, y] in tile coordinates: the lines of a line feature, the rings of a polygon
// (closed; exterior rings and holes in the order of the tile, told apart by their winding)
export function featureGeometry(F) {
  const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2), g = F.geom, out = [];
  let x = 0, y = 0, i = 0, cur = null;
  while (i < g.length) {
    const c = g[i++], id = c & 7, n = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < n; k++) { x += zz(g[i++]); y += zz(g[i++]); if (id === 1) { cur = [[x, y]]; out.push(cur); } else cur?.push([x, y]); }
    } else if (id === 7 && cur?.length) cur.push(cur[0]);
  }
  return out;
}
// tile coordinates → lon/lat
export function toLonLat(z, x, y, ext, px, py) {
  const n = 2 ** z, lon = ((x + px / ext) / n) * 360 - 180;
  const yy = Math.PI * (1 - (2 * (y + py / ext)) / n), lat = (Math.atan(Math.sinh(yy)) * 180) / Math.PI;
  return [lon, lat];
}

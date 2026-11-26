// OSM record + neighbours → BModel geometry (CONTRACT §2). Envelope/usage parameters are added by archetype.js.
import {
  makeFrame, centroid, signedArea, orient, simplifyRing, edgeAzimuth, azToOrient, obb, mergeIntervals, pointInRing,
} from './geo.js';
import { L as tr } from './i18n.js';
import { osmRule, osmDefaults, loadOsmDefaults, setOsmDefaults } from './osmdefaults.js';
import { zensusNonRes, livingKappa, setLivingArea, livingArea } from './livingarea.js';

export { loadOsmDefaults, setOsmDefaults, osmDefaults, setLivingArea, livingArea };

const UNHEATED = new Set(['garage', 'garages', 'shed', 'carport', 'roof', 'hut', 'greenhouse', 'allotment_house', 'parking',
  'parking_entrance', 'barn', 'cowshed', 'stable', 'silo', 'storage_tank', 'transformer_tower', 'bunker', 'container',
  'kiosk', 'toilets', 'service', 'boathouse', 'ruins', 'construction', 'tent', 'farm_auxiliary', 'gazebo', 'bridge',
  // structures and unheated annexes OSM also tags as buildings (counts in Munich, 2026-11-07: elevator 107, outbuilding 70,
  // conservatory 67, grandstand 37, glasshouse 22, substation 16, collapsed 16, tower 14, tomb 14, shelter 12, …)
  'elevator', 'outbuilding', 'conservatory', 'grandstand', 'glasshouse', 'substation', 'collapsed', 'tower', 'tomb', 'shelter',
  'tech_cab', 'stairs', 'staircase', 'slurry_tank', 'shrine', 'demolished', 'bicycle_parking', 'waste_shelter', 'chimney',
  'water_tower', 'constuction', 'garden_house', 'cot']);

const RES_USAGE = new Set(['sfh', 'th', 'mfh', 'ab']);

const STRUCTURE_TAG = {
  man_made: new Set(['obelisk', 'tower', 'chimney', 'mast', 'water_tower', 'silo', 'storage_tank', 'monitoring_station', 'cross', 'campanile', 'lighthouse']),
  historic: new Set(['monument', 'memorial', 'wayside_shrine', 'wayside_cross', 'column']),   // not city_gate: Isartor and Karlstor have heated rooms
};

const num = (v) => {
  if (v == null) return NaN;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

// Rules that use the cadastre's LoD2 cover (tools/structures_scan.mjs → data/lod2 tiles, st / nc):
// a structure (monument, tower, chimney, shaft): tall and slender, generic building tag, no address, no LoD2 building;
const STRUCTURE_U = (st) => ({ usage: 'other', heated: false, src: tr(`OSM 标为 building，但地籍 LoD2 里没有这栋；占地 ${st[0]} m²、高 ${st[1]} m，细高，判为纪念碑、塔或柱等构筑物`, `Tagged as a building in OSM, but the cadastre's LoD2 has no building here; ${st[0]} m² footprint, ${st[1]} m tall and slender: a structure such as a monument, tower or column`, `In OSM als Gebäude erfasst, im LoD2 des Katasters gibt es hier aber kein Gebäude; ${st[0]} m² Grundfläche, ${st[1]} m hoch und schlank: ein Bauwerk wie ein Denkmal, Turm oder eine Säule`) });
// an outbuilding: generic building=yes, no address, 25–60 m², no LoD2 building under it (2,412 in Munich, mostly
// garages and sheds; smaller ones are unheated already by the 25 m² rule of classifyUsage). Unheated, not a house.
const outbuilding = (rec, fp, opts) => !!opts.lod2?.noCover?.has(rec.id) && rec.tags.building === 'yes' && fp < 60
  && !['addr:housenumber', 'amenity', 'shop', 'office'].some((k) => rec.tags[k]);
// housing by the size rule only, but the Zensus 2022 cells around hold far less living area than the model puts there
// (data/zensus/living.json, tools/zensus_check.mjs): an exhibition hall, office block or palace, not a dwelling. Heated,
// with the office profile from two storeys up, like the cadastre's business buildings in cadastreUsage.
const fmtM2 = (v) => Math.round(v).toLocaleString('en-GB');
const ZENSUS_U = ([z, m], floors) => ({ usage: floors >= 2 ? 'office' : 'other', heated: true, src: tr(`building=yes，按规模本应推为住宅；但 Zensus 2022 在这栋楼周围的 100 m 格子里只有 ${fmtM2(z)} m² 居住面积，模型的住宅在这里已有 ${fmtM2(m)} m²（含本楼）：按非住宅处理`, `building=yes, which the size rule would call housing; but Zensus 2022 counts only ${fmtM2(z)} m² of living area in the 100 m cells around it, while the model's housing there comes to ${fmtM2(m)} m² including this building: treated as non-residential`, `building=yes, nach der Größenregel ein Wohngebäude; der Zensus 2022 zählt in den 100-m-Zellen um das Gebäude aber nur ${fmtM2(z)} m² Wohnfläche, während das Modell dort einschließlich dieses Gebäudes ${fmtM2(m)} m² Wohnfläche ansetzt: als Nichtwohngebäude behandelt`) });
// an open structure: a weather shelter, a garden temple or pavilion, or a generic building with zero storeys (OSM
// building:levels=0 means a roof without floors). No enclosed envelope, so not heated. Found on 2026-11-08 (the
// Dianatempel in the Hofgarten: building=yes, building:levels=0, dome; the Monopteros, the Chinese Tower, shelters that
// the size rule had made into houses). Temples and pavilions with an address, an amenity, a shop or an office, or with a
// public or residential function in the cadastre (Feringasaal, Aryatara Institut) stay buildings.
export function openStructure(tags, fn) {
  const b = tags.building || 'yes', busy = ['addr:housenumber', 'shop', 'office'].some((k) => tags[k]) || (tags.amenity && tags.amenity !== 'shelter');
  if (tags.amenity === 'shelter') return 'amenity=shelter';
  if (busy) return null;
  const c = String(fn || '');
  if ((b === 'temple' || b === 'pavilion') && !c.startsWith('31001_1') && !c.startsWith('31001_3')) return `building=${b}`;
  if (b === 'yes' && tags['building:levels'] != null && parseFloat(tags['building:levels']) === 0 && !(parseFloat(tags['roof:levels']) > 0)) return 'building:levels=0';
  return null;
}
const OPEN_U = (why) => ({ usage: 'other', heated: false, src: tr(`${why}，无门牌：开敞构筑物（亭、廊、避雨棚），没有围合的外壳，不供暖`, `${why}, no address: an open structure (pavilion, garden temple, shelter) with no enclosed envelope, not heated`, `${why}, keine Adresse: ein offenes Bauwerk (Pavillon, Gartentempel, Unterstand) ohne geschlossene Hülle, unbeheizt`) });
const OUTBUILDING_U = () => ({ usage: 'other', heated: false, src: tr('building=yes，无门牌，地籍 LoD2 里没有这栋，占地 < 60 m²：按不供暖的附属建筑处理', 'building=yes, no address, no LoD2 building in the cadastre, footprint < 60 m²: treated as an unheated outbuilding', 'building=yes, keine Adresse, kein LoD2-Gebäude im Kataster, Grundfläche < 60 m²: als unbeheiztes Nebengebäude behandelt') });

// Building function of the cadastre (ALKIS Gebäudefunktion, carried by the Bavarian LoD2: lod2Record().fn) for OSM
// buildings tagged only building=yes, whose usage the size rule would guess. Codes by group: 31001_1xxx residential
// (kept), 31001_2xxx business, 2460–2465 garages and car parks, 2500–2799 utility and farm, 31001_3xxx public
// (3020s education, 3050s health, 3060s social, 3030s / 3040s / 3080s / 3090s culture, religion, cemetery, transport),
// 9998 not specified (kept), other object types (51009, 53001, …) are structures. Returns null to keep the guess.
const CAD = {
  biz: [tr('商业或工业建筑', 'business or industrial building', 'Gebäude für Wirtschaft oder Gewerbe')],
  garage: [tr('车库或停车楼', 'garage or car park', 'Garage oder Parkhaus')],
  util: [tr('供能、处理或农业建筑', 'utility, disposal or farm building', 'Gebäude für Ver- und Entsorgung oder Landwirtschaft')],
  edu: [tr('教育、研究或社会设施', 'education, research or social building', 'Gebäude für Bildung, Forschung oder soziale Zwecke')],
  health: [tr('医疗建筑', 'health care building', 'Gebäude für Gesundheitswesen')],
  pub: [tr('公共建筑', 'public building', 'Gebäude für öffentliche Zwecke')],
  culture: [tr('文化、宗教或交通等公共建筑', 'cultural, religious, transport or similar building', 'Gebäude für Kultur, Religion, Verkehr o. Ä.')],
  structure: [tr('构筑物，不是建筑', 'a structure, not a building', 'ein Bauwerk, kein Gebäude')],
};
export function cadastreUsage(fn, resShare, floors) {
  if (!fn) return null;
  const [obj, code] = fn.split('_'), c = +code;
  const out = (usage, heated, g) => ({ usage, heated, src: tr(`building=yes；地籍 LoD2 的建筑功能 ${fn}：${CAD[g][0]}`, `building=yes; building function in the cadastre's LoD2 ${fn}: ${CAD[g][0]}`, `building=yes; Gebäudefunktion im LoD2 des Katasters ${fn}: ${CAD[g][0]}`) });
  if (obj !== '31001') return out('other', false, 'structure');
  if (c === 9998 || (c >= 1000 && c < 2000) || resShare >= 50) return null;
  if (c >= 2460 && c <= 2465) return out('other', false, 'garage');
  if (c >= 2500 && c < 2800) return out('other', false, 'util');
  if (c >= 2000 && c < 3000) return out(floors >= 2 ? 'office' : 'other', true, 'biz');
  if (c === 3065) return { ...out('education', true, 'edu'), profile: 'classroom' };   // nursery: DIN V 18599-10 profile 8
  if ((c >= 3020 && c < 3030) || (c >= 3060 && c < 3070)) return out('education', true, 'edu');
  if (c >= 3050 && c < 3060) return out('office', true, 'health');
  if ((c >= 3030 && c < 3050) || (c >= 3080 && c < 3100) || c >= 3100) return out('other', true, 'culture');
  if (c >= 3000 && c < 3100) return out('office', true, 'pub');
  return null;
}

export function classifyUsage(tags, footprint, floorsGuess) {
  const b = tags.building || 'yes';
  const use = tags['building:use'] || '';
  if (UNHEATED.has(b)) return { usage: 'other', heated: false, src: `building=${b}` };
  // monuments, towers and chimneys that OSM also tags as buildings (kept by tools/build_osm_tiles.py from 2026-11-07 on)
  if (STRUCTURE_TAG.man_made.has(tags.man_made) && !(tags.man_made === 'tower' && footprint >= 150)) return { usage: 'other', heated: false, src: `man_made=${tags.man_made}` };
  if (STRUCTURE_TAG.historic.has(tags.historic)) return { usage: 'other', heated: false, src: `historic=${tags.historic}` };
  if (['house', 'detached', 'bungalow', 'farm', 'cabin'].includes(b)) return { usage: 'sfh', heated: true, src: `building=${b}` };
  if (['semidetached_house', 'terrace'].includes(b)) return { usage: 'th', heated: true, src: `building=${b}` };
  if (['apartments', 'residential', 'dormitory'].includes(b) || use === 'residential') {
    const big = footprint * floorsGuess > 1500 || floorsGuess >= 6;
    return { usage: big ? 'ab' : 'mfh', heated: true, src: tr(`building=${b}，按规模分为${big ? '大型' : '一般'}多户住宅`, `building=${b}, classed by size as ${big ? 'a large apartment block' : 'a multi-family house'}`, `building=${b}, nach Größe eingestuft als ${big ? 'großes Mehrfamilienhaus' : 'Mehrfamilienhaus'}`) };
  }
  if (['office', 'commercial', 'government', 'civic', 'public', 'bank', 'townhall'].includes(b) || tags.office || use === 'office')
    return { usage: 'office', heated: true, src: `building=${b}` };
  if (['university', 'school', 'college', 'kindergarten'].includes(b) || ['university', 'school', 'college', 'kindergarten'].includes(tags.amenity)) {
    // schools and nurseries: DIN V 18599-10 profile 8 (classroom, group room); universities and colleges keep profile 4
    const cls = ['school', 'kindergarten'].includes(b) || ['school', 'kindergarten'].includes(tags.amenity);
    return { usage: 'education', heated: true, src: `building=${b}${tags.amenity ? ', amenity=' + tags.amenity : ''}`, ...(cls ? { profile: 'classroom' } : {}) };
  }
  if (['retail', 'supermarket', 'shop'].includes(b) || tags.shop) return { usage: 'retail', heated: true, src: `building=${b}` };
  if (['industrial', 'warehouse', 'manufacture'].includes(b)) return { usage: 'other', heated: true, src: tr(`building=${b}（工业，按其他处理）`, `building=${b} (industrial, treated as other)`, `building=${b} (Industrie, als sonstige Nutzung behandelt)`) };
  if (['church', 'chapel', 'cathedral', 'mosque', 'synagogue', 'temple', 'religious'].includes(b)) return { usage: 'other', heated: true, src: `building=${b}` };
  if (['hotel', 'hospital'].includes(b)) return { usage: 'office', heated: true, src: tr(`building=${b}（按办公类剖面近似）`, `building=${b} (approximated with the office profile)`, `building=${b} (mit dem Nutzungsprofil Bürogebäude angenähert)`) };
  if (['museum', 'fire_station', 'police', 'courthouse', 'library'].includes(b)) return { usage: 'office', heated: true, src: `building=${b}` };
  if (['restaurant', 'kiosk_heated', 'mall', 'department_store'].includes(b)) return { usage: 'retail', heated: true, src: `building=${b}` };
  // any other specific value is not a dwelling (stadium, train_station, sports_centre, hangar, …; checked against
  // Zensus 2022 living area, tools/zensus_check.mjs: such values ran into the size rule and became apartment blocks)
  if (b !== 'yes') return { usage: 'other', heated: true, src: tr(`building=${b}（非住宅，按其他处理）`, `building=${b} (not residential, treated as other)`, `building=${b} (kein Wohngebäude, als sonstige Nutzung behandelt)`) };
  // building=yes: by size, unless the cadastre says otherwise (cadastreUsage, buildGeometry)
  if (footprint < 25) return { usage: 'other', heated: false, src: tr('building=yes，占地 < 25 m²，可能是附属建筑', 'building=yes, footprint < 25 m², probably an outbuilding', 'building=yes, Grundfläche < 25 m², vermutlich ein Nebengebäude') };
  if (footprint < 220 && floorsGuess <= 3) return { usage: 'sfh', heated: true, inferred: true, src: tr('building=yes，按占地与层数推为独栋住宅', 'building=yes, inferred as a single-family house from footprint and storeys', 'building=yes, nach Grundfläche und Geschossen als Einfamilienhaus eingestuft') };
  return { usage: footprint * floorsGuess > 1500 ? 'ab' : 'mfh', heated: true, inferred: true, src: tr('building=yes，按规模推为多户住宅', 'building=yes, inferred as a multi-family house from its size', 'building=yes, nach Größe als Mehrfamilienhaus eingestuft') };
}

// ---------- default rules (data/osm_defaults.json via osmdefaults.js; no registry → the built-in rules below) ----------
const HOLDOUT = tr('OSM 留出统计', 'OSM holdout statistics', 'OSM-Holdout-Statistik');

// Distance band from the registry centre (Marienplatz); null when no registry is loaded.
export function distanceBand(lon, lat) {
  const meta = osmDefaults()?.meta;
  if (!meta) return null;
  const r = Math.PI / 180, { lat: lat0, lon: lon0 } = meta.centre;
  const a = Math.sin(((lat - lat0) * r) / 2) ** 2 + Math.cos(lat * r) * Math.cos(lat0 * r) * Math.sin(((lon - lon0) * r) / 2) ** 2;
  const d = 2 * 6371 * Math.asin(Math.sqrt(a));
  return (meta.distanceBands.find((x) => x.maxKm == null || d < x.maxKm) || meta.distanceBands[meta.distanceBands.length - 1]).id;
}
function fpIndex(fp) {
  const e = osmDefaults().meta.footprintBands.edges;
  let i = 0;
  while (i < e.length && fp >= e[i]) i++;
  return i;
}
const bandLabel = (band) => osmDefaults().meta.distanceBands.find((x) => x.id === band)?.label || band;
const fpLabel = (i) => `${osmDefaults().meta.footprintBands.labels[i]} m²`;

// storeys: median by building tag × distance band × footprint band, falling back to tag × band, then tag
function ruleStoreys(b, fp, band) {
  const t = osmRule('storeys')?.table?.[b];
  if (!t || !band) return null;
  const i = fpIndex(fp), c = t[band];
  if (c && c.fp && c.fp[i]) return { floors: c.fp[i], cell: `building=${b}, ${bandLabel(band)}, ${fpLabel(i)}` };
  if (c && c.all) return { floors: c.all, cell: `building=${b}, ${bandLabel(band)}` };
  return t.all ? { floors: t.all, cell: `building=${b}` } : null;
}
// roof: most common shape (pitched → gabled, else flat) by building tag × footprint band, falling back to tag
function ruleRoof(b, fp) {
  const t = osmRule('roofShape')?.table?.[b];
  if (!t) return null;
  const i = fpIndex(fp);
  if (t.fp && t.fp[i]) return { shape: t.fp[i], cell: `building=${b}, ${fpLabel(i)}` };
  return t.all ? { shape: t.all, cell: `building=${b}` } : null;
}
// storey height by type (and distance band where the table splits)
function ruleStoreyHeight(usage, heated, band) {
  const v = osmRule('storeyHeight')?.table?.[heated ? usage : 'unheated'];
  const x = v && typeof v === 'object' ? v[band] : v;
  return Number.isFinite(x) ? x : null;
}
const ruleAtticHeated = (usage) => osmRule('atticHeated')?.table?.[usage] === true;
// histogram of true / default storeys for the type × band, [[ratio, weight], ...]
function ruleFloorsPrior(usage, heated, band) {
  const t = osmRule('floorsPrior')?.table?.[heated ? usage : 'unheated'];
  return (t && (t[band] || t.all)) || null;
}

// Heights. OSM `height` is total height (to ridge). Returns eaves height, storeys, roof.
// opts: fp (footprint for the rule tables, default the outer ring), band (distance band, null = built-in rules),
// storey (storey height in m), storeyRule (the storey height comes from the registry, for the source text).
export function inferHeight(tags, ringLocal, opts = {}) {
  const src = {};
  const b = tags.building || 'yes';
  const levels = num(tags['building:levels']);
  const roofLevels = num(tags['roof:levels']);
  const hTot = num(tags.height);
  const roofH = num(tags['roof:height']);
  const fpRule = opts.fp ?? Math.abs(signedArea(ringLocal));
  let shape = tags['roof:shape'];
  if (shape) src.roof = 'osm:roof:shape';
  else {
    const rs = opts.band ? ruleRoof(b, fpRule) : null;
    if (rs) {
      shape = rs.shape;
      src.roof = tr(`默认规则：按标签和占地面积的多数屋顶形状（${rs.cell}；${HOLDOUT}）`, `Default rule: most common roof shape by tag and footprint (${rs.cell}; ${HOLDOUT})`, `Standardregel: häufigste Dachform nach OSM-Tag und Grundfläche (${rs.cell}; ${HOLDOUT})`);
    } else {
      shape = ['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'apartments', 'residential', 'farm'].includes(b) ? 'gabled' : 'flat';
      src.roof = 'default';
    }
  }
  const pitched = !['flat', 'skillion'].includes(shape);
  const box = obb(ringLocal);
  let ridge = 0;
  if (pitched) {
    if (Number.isFinite(roofH)) { ridge = roofH; src.ridge = 'osm:roof:height'; }
    else if (Number.isFinite(roofLevels) && roofLevels > 0) { ridge = Math.min(2.7 * roofLevels + 0.8, 9); src.ridge = 'osm:roof:levels'; }
    else { ridge = Math.min((Math.min(box.w, box.h) / 2) * Math.tan((38 * Math.PI) / 180), 8); src.ridge = 'geometry'; }
  } else if (shape === 'skillion') ridge = 0;
  const nonRes = ['office', 'commercial', 'retail', 'university', 'school', 'college', 'industrial', 'warehouse', 'hospital', 'government', 'public', 'civic'].includes(b);
  const storeyDefault = nonRes ? 3.6 : 3.0;
  const storey = opts.storey || storeyDefault;
  const sTxt = storey.toFixed(1);
  const ruleNote = tr(`默认层高规则：按类型和距离，${HOLDOUT}`, `default storey height rule by type and distance, ${HOLDOUT}`, `Standardregel für die Geschosshöhe nach Typ und Entfernung zum Zentrum, ${HOLDOUT}`);
  let floors, eaves, floorsDefault = false;
  if (Number.isFinite(levels) && levels > 0) {
    floors = Math.round(levels); src.floors = 'osm:building:levels';
    if (Number.isFinite(hTot)) { eaves = Math.max(hTot - ridge, floors * 2.4); src.height = 'osm:height'; }
    else {
      eaves = floors * storey;
      src.height = opts.storeyRule ? tr(`层数 × ${sTxt} m（${ruleNote}）`, `storeys × ${sTxt} m (${ruleNote})`, `Geschosse × ${sTxt} m (${ruleNote})`) : tr(`层数 × ${sTxt} m`, `storeys × ${sTxt} m`, `Geschosse × ${sTxt} m`);
    }
  } else if (Number.isFinite(hTot)) {
    eaves = Math.max(hTot - ridge, 2.5); src.height = 'osm:height';
    floors = Math.max(1, Math.round(eaves / storey));
    src.floors = opts.storeyRule ? tr(`高度 ÷ ${sTxt} m（${ruleNote}）`, `height ÷ ${sTxt} m (${ruleNote})`, `Höhe ÷ ${sTxt} m (${ruleNote})`) : tr(`高度 ÷ ${storeyDefault} m`, `height ÷ ${storeyDefault} m`, `Höhe ÷ ${storeyDefault} m`);
  } else {
    const fp = Math.abs(signedArea(ringLocal));
    const rf = opts.band ? ruleStoreys(b, fpRule, opts.band) : null;
    if (rf) {
      floors = rf.floors;
      src.floors = tr(`默认规则：按标签、距离和占地面积的中位数（${rf.cell}；${HOLDOUT}）`, `Default rule: median by tag, distance and footprint (${rf.cell}; ${HOLDOUT})`, `Standardregel: Median nach OSM-Tag, Entfernung zum Zentrum und Grundfläche (${rf.cell}; ${HOLDOUT})`);
    } else {
      if (['bungalow'].includes(b)) floors = 1;
      else if (['house', 'detached', 'semidetached_house', 'terrace', 'farm'].includes(b)) floors = 2;
      else if (['apartments', 'residential', 'dormitory'].includes(b)) floors = 4;
      else if (['office', 'commercial', 'hotel'].includes(b)) floors = 4;
      else if (['university', 'school', 'college', 'hospital'].includes(b)) floors = 3;
      else if (UNHEATED.has(b)) floors = 1;
      else floors = fp < 40 ? 1 : fp < 150 ? 2 : 3;
      src.floors = tr('default（OSM 无层数和高度）', 'default (OSM has no storeys or height)', 'Standardwert (OSM ohne Geschosszahl und Höhe)');
    }
    eaves = floors * storey;
    src.height = opts.storeyRule ? tr(`默认规则：层数 × ${sTxt} m（层高按类型和距离；${HOLDOUT}）`, `Default rule: storeys × ${sTxt} m (storey height by type and distance; ${HOLDOUT})`, `Standardregel: Geschosse × ${sTxt} m (Geschosshöhe nach Typ und Entfernung zum Zentrum; ${HOLDOUT})`) : 'default';
    floorsDefault = true;
  }
  const attic = pitched ? (Number.isFinite(roofLevels) && roofLevels >= 1 ? 'heated' : 'unheated') : 'none';
  return {
    height: +eaves.toFixed(2), floors, floorHeight: +(eaves / floors).toFixed(2),
    roof: { shape, ridgeHeight: +ridge.toFixed(2), attic, roofLevels: Number.isFinite(roofLevels) ? roofLevels : 0 },
    src, storey, floorsDefault,
  };
}

// Storeys, height and usage. With a registry the storey height depends on the usage, which depends on the storeys,
// so the height is inferred once with the built-in storey height, the usage classified, and the height redone with
// the rule's storey height (one pass, no iteration).
export function heightAndUsage(tags, ring, fp, lon, lat) {   // also used by js/walk.js for every building of the street model
  const band = osmDefaults() ? distanceBand(lon, lat) : null;
  let H = inferHeight(tags, ring, { fp, band });
  let U = classifyUsage(tags, fp, H.floors);
  const storey = band ? ruleStoreyHeight(U.usage, U.heated, band) : null;
  if (storey != null) {
    H = inferHeight(tags, ring, { fp, band, storey, storeyRule: true });
    U = classifyUsage(tags, fp, H.floors);
  }
  return { H, U, band };
}

// Party walls: overlap of facade edges with (nearly) collinear neighbour edges.
function partyIntervals(a, b, nbRings, tolDist = 0.9, tolDeg = 12) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 0.5) return [];
  const ux = dx / L, uy = dy / L;
  const iv = [];
  for (const ring of nbRings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const ex = q[0] - p[0], ey = q[1] - p[1];
      const le = Math.hypot(ex, ey);
      if (le < 0.3) continue;
      const cos = Math.abs((ex * ux + ey * uy) / le);
      if (cos < Math.cos((tolDeg * Math.PI) / 180)) continue;
      const dp = Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
      const dq = Math.abs((q[0] - a[0]) * uy - (q[1] - a[1]) * ux);
      if (dp > tolDist || dq > tolDist) continue;
      let t0 = ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / L, t1 = ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / L;
      if (t0 > t1) [t0, t1] = [t1, t0];
      t0 = Math.max(0, t0); t1 = Math.min(1, t1);
      if (t1 - t0 > 0.02) iv.push([t0, t1]);
    }
  }
  return mergeIntervals(iv);
}

// LoD2 (Bavarian LoD2, matched to OSM by tools/lod2_match.mjs; data/lod2/t_<tile>.json). The single-prism model takes
// equivalents: eaves = wall area / ground perimeter (keeps the external wall area), roof height from the volume.
const LOD2_ROOF = { 1000: 'flat', 2100: 'skillion', 2200: 'skillion', 3100: 'gabled', 3200: 'hipped', 3300: 'hipped', 3400: 'gabled', 3500: 'pyramidal', 3600: 'pyramidal', 3700: 'gabled', 3800: 'skillion', 3900: 'gabled', 4000: 'pyramidal', 5000: 'flat', 9999: 'flat' };
export const LOD2_ROOF_DE = { 1000: 'Flachdach', 2100: 'Pultdach', 2200: 'versetztes Pultdach', 3100: 'Satteldach', 3200: 'Walmdach', 3300: 'Krüppelwalmdach', 3400: 'Mansarddach', 3500: 'Zeltdach', 3600: 'Kegeldach', 3700: 'Kuppeldach', 3800: 'Sheddach', 3900: 'Bogendach', 4000: 'Turmdach', 5000: 'Mischform', 9999: 'sonstige' };
export function lod2Record(a) {
  if (!a) return null;
  const [eaves, ridge, storeys, roofType, measuredHeight, volume, groundArea, wallArea, id, n, mode, ratio, eavesLowest, fn, resShare] = a;
  return { eaves, ridge, eavesLowest: eavesLowest || null, storeys: storeys || null, roofType, shape: LOD2_ROOF[roofType] || 'flat', roofDE: LOD2_ROOF_DE[roofType] || String(roofType), measuredHeight, volume, groundArea, wallArea, lod2: `DEBY_LOD2_${id}`, n, mode, ratio, fn: fn || null, resShare: resShare ?? null };
}
// Put a LoD2 record into a model built from OSM. The eaves equivalent (wall area / perimeter) includes gable walls:
// right for the wall area, too high for the storey height h_G of the GEG reference area. For pitched roofs the main
// eaves is the official lowest eaves when it is at least 0.72 of the equivalent (no low annex), else 0.92 × the
// equivalent (the typical ratio without annex). Storeys: LoD2, else the OSM building:levels tag, else main eaves /
// storey height. If LoD2 storeys would give less than 2.4 m per storey under a pitched roof, the cadastre has counted
// the attic storey: one storey less below the eaves, and the attic counts as heated.
export function applyLoD2(m, L2) {
  const pitched = !['flat', 'skillion'].includes(L2.shape) && L2.ridge > 0;
  const osmLevels = /^osm:building:levels/.test(m.geomSrc.floors || '');
  const lowOK = L2.eavesLowest > 2 && L2.eavesLowest / L2.eaves >= 0.72;
  const wallH = pitched ? (lowOK ? Math.min(L2.eavesLowest, L2.eaves) : 0.92 * L2.eaves) : L2.eaves;
  const atticCounted = pitched && L2.storeys >= 2 && wallH / L2.storeys < 2.4;
  // housing: a LoD2 storey count giving less than 2.3 m or more than 5 m per storey is a register error (e.g. 1 storey
  // for a 36 m block); then the OSM storeys, else the wall height / default storey height
  const lodFloors = L2.storeys ? L2.storeys - (atticCounted ? 1 : 0) : null;
  const residential = ['sfh', 'th', 'mfh', 'ab'].includes(m.usage);
  const lodOK = lodFloors && (!residential || (wallH / lodFloors >= 2.3 && wallH / lodFloors <= 5));
  m.height = L2.eaves;
  m.floors = lodOK ? lodFloors : osmLevels ? m.floors : Math.max(1, Math.round(wallH / (m.storeyDefault || 3)));
  // other buildings: under 2.3 m per storey the count belongs to a tower on a wider podium, whose wall height the
  // equivalent eaves averages down, or it is wrong (2026-11-08: about 1,500 buildings, e.g. a glass cafeteria with 6
  // storeys in 11 m); then wall height / default storey height, which keeps the floor area consistent with the volume
  const nonresFix = !residential && wallH / m.floors < 2.3;
  if (nonresFix) m.floors = Math.max(1, Math.round(wallH / (m.storeyDefault || 3.5)));
  m.floorHeight = +(wallH / m.floors).toFixed(2);
  m.hGBias = 0.3;   // measured wall height: storey height h_G may run high by up to 0.3 m (computeAreas)
  m.roof = { ...m.roof, shape: pitched ? L2.shape : L2.shape === 'skillion' ? 'skillion' : 'flat', ridgeHeight: pitched ? L2.ridge : 0,
    attic: pitched ? (lodOK && atticCounted ? 'heated' : m.roof.attic === 'none' ? 'unheated' : m.roof.attic) : 'none', roofLevels: lodOK && atticCounted ? 1 : m.roof.roofLevels };
  m.floorsPrior = null;   // storeys and height are measured
  const tag = `LoD2 ${L2.lod2.replace('DEBY_LOD2_', '')}${L2.n > 1 ? ` +${L2.n - 1}` : ''}`;
  m.geomSrc = { ...m.geomSrc,
    height: tr(`${tag}：墙面积 ÷ 周长`, `${tag}: wall area ÷ perimeter`, `${tag}: Wandfläche ÷ Umfang`),
    floors: nonresFix ? tr(`${tag}：按登记层数每层不到 2.3 m，改为檐口 ÷ ${m.storeyDefault || 3.5} m`, `${tag}: under 2.3 m per storey with the recorded storeys, so eaves ÷ ${m.storeyDefault || 3.5} m`, `${tag}: mit der erfassten Geschosszahl unter 2,3 m je Geschoss, daher Traufhöhe ÷ ${m.storeyDefault || 3.5} m`) : lodOK ? (atticCounted ? tr(`${tag}：地上 ${L2.storeys} 层，其中 1 层在屋顶内`, `${tag}: ${L2.storeys} storeys above ground, one of them in the roof`, `${tag}: ${L2.storeys} oberirdische Geschosse, davon eines im Dach`) : tr(`${tag}：地上层数`, `${tag}: storeys above ground`, `${tag}: oberirdische Geschosse`)) : osmLevels ? m.geomSrc.floors : tr(`${tag}：檐口 ÷ ${m.storeyDefault || 3} m`, `${tag}: eaves ÷ ${m.storeyDefault || 3} m`, `${tag}: Traufhöhe ÷ ${m.storeyDefault || 3} m`),
    roof: tr(`${tag}：${L2.roofDE}`, `${tag}: ${L2.roofDE}`, `${tag}: ${L2.roofDE}`), ridge: tr(`${tag}：由体积折算`, `${tag}: from the volume`, `${tag}: aus dem Volumen abgeleitet`), ...(lodOK && atticCounted ? { attic: tr(`${tag}：阁楼层计入地上层数，按供暖计`, `${tag}: the attic storey is counted above ground, so it counts as heated`, `${tag}: Das Dachgeschoss zählt zu den oberirdischen Geschossen und gilt daher als beheizt`) } : {}) };
  m.lod2 = L2;
  return m;
}

// opts.lod2: Map OSM id → LoD2 array (data/lod2 tiles); neighbours then take their LoD2 heights for shading and party walls.
// opts.heightOf(rec) → eaves in m or null: neighbour heights by another city's rule (Singapore); without it nothing changes.
export function buildGeometry(rec, nbRecs, opts = {}) {
  const [clon, clat] = centroid(rec.outer);
  const F = makeFrame(clat, clon);
  const toL = (ring) => ring.map(([lon, lat]) => F.toLocal(lon, lat));
  let outer = orient(simplifyRing(toL(rec.outer)), true);
  if (outer.length < 3) outer = orient(toL(rec.outer), true);
  const holes = rec.holes.map((h) => orient(simplifyRing(toL(h)), false)).filter((h) => h.length >= 3 && Math.abs(signedArea(h)) > 4);
  const fp = Math.abs(signedArea(outer)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);

  const { H, U: U0, band } = heightAndUsage(rec.tags, outer, fp, clon, clat);
  // a structure, not a building (tools/structures_scan.mjs: no LoD2 building of the cadastre here, generic building tag,
  // no address, tall and slender, e.g. the obelisk on Karolinenplatz): not heated, not modelled
  const st = opts.lod2?.structures?.get(rec.id);
  const L2rec = opts.lod2 ? lod2Record(opts.lod2.get(rec.id)) : null;
  const U1 = U0.inferred && L2rec ? cadastreUsage(L2rec.fn, L2rec.resShare, L2rec.storeys || H.floors) || U0 : U0;
  // housing by the size rule and not confirmed by the cadastre (function residential 1xxx): checked against Zensus
  const guessed = !!U1.inferred && RES_USAGE.has(U1.usage) && !String(L2rec?.fn || '').startsWith('31001_1');
  const zr = !st && guessed ? zensusNonRes(rec.id) : null;
  const open = openStructure(rec.tags, L2rec?.fn);
  const U = st ? STRUCTURE_U(st) : open ? OPEN_U(open) : outbuilding(rec, fp, opts) ? OUTBUILDING_U() : zr ? ZENSUS_U(zr, H.floors) : U1;
  // attic: single-family and terraced houses with a pitched roof and no roof:levels count as heated (registry rule)
  if (band && H.roof.attic === 'unheated' && rec.tags['roof:levels'] == null && ruleAtticHeated(U.usage)) {
    H.roof.attic = 'heated';
    H.src.attic = tr(`默认规则：独栋和联排住宅的坡屋顶阁楼按供暖计（${HOLDOUT}）`, `Default rule: the pitched roof attic of single-family and terraced houses counts as heated (${HOLDOUT})`, `Standardregel: Bei Einfamilien- und Reihenhäusern mit geneigtem Dach gilt das Dachgeschoss als beheizt (${HOLDOUT})`);
  }
  // storeys and height both defaulted: histogram of true / default storeys for the prior (archetype.js makePrior → p.hScale)
  const floorsPrior = H.floorsDefault && band ? ruleFloorsPrior(U.usage, U.heated, band) : null;

  // neighbours: skip parts of this building (centroid inside our outline) and tiny sheds for adjacency
  const nbs = [];
  for (const n of nbRecs) {
    const ringL = toL(n.outer);
    const c = centroid(ringL);
    if (n.part && pointInRing(c, outer)) continue;
    const nc = centroid(n.outer);
    const { H: hn, U: un } = heightAndUsage(n.tags, ringL, Math.abs(signedArea(ringL)), nc[0], nc[1]);
    const ln = !n.part && opts.lod2 ? lod2Record(opts.lod2.get(n.id)) : null;
    const unC = un.inferred && ln ? cadastreUsage(ln.fn, ln.resShare, ln.storeys || hn.floors) : null;
    // opts.heightOf(n) → eaves height in m or null: a city's own height rule for the neighbours (js/model_sg.js); absent in Munich
    const hx = !ln && opts.heightOf ? opts.heightOf(n) : null;
    nbs.push({ id: n.id, outer: ringL, holes: n.holes.map(toL), height: ln ? +(ln.eaves + ln.ridge * 0.5).toFixed(1) : hx != null ? +hx.toFixed(1) : +(hn.height + hn.roof.ridgeHeight * 0.5).toFixed(1),
      eaves: ln ? ln.eaves : hx != null ? hx : hn.height, heated: (unC ? unC.heated : un.heated) && !n.part && !opts.lod2?.structures?.has(n.id) && !outbuilding(n, Math.abs(signedArea(ringL)), opts) && !openStructure(n.tags || {}, ln?.fn), part: n.part, tags: n.tags, lod2: !!ln });
  }
  const adjRings = nbs.filter((n) => n.heated && n.eaves >= 2.5);

  const facades = [];
  const rings = [outer, ...holes];
  rings.forEach((ring, ri) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.3) continue;
      const az = edgeAzimuth(a, b);
      // party intervals with each neighbour (keep heights per neighbour)
      const parts = [];
      for (const n of adjRings) {
        for (const [t0, t1] of partyIntervals(a, b, [n.outer, ...n.holes])) parts.push({ t0, t1, h: n.eaves });
      }
      parts.sort((p, q) => p.t0 - q.t0);
      // flatten overlapping party parts (take the taller neighbour)
      const cuts = [...new Set([0, 1, ...parts.flatMap((p) => [p.t0, p.t1])])].sort((x, y) => x - y);
      const segs = [];
      for (let k = 0; k < cuts.length - 1; k++) {
        const m = (cuts[k] + cuts[k + 1]) / 2;
        if (cuts[k + 1] - cuts[k] < 1e-4) continue;
        const cover = parts.filter((p) => p.t0 <= m && p.t1 >= m);
        const seg = cover.length
          ? { t0: cuts[k], t1: cuts[k + 1], exposed: false, neighborHeight: Math.max(...cover.map((p) => p.h)) }
          : { t0: cuts[k], t1: cuts[k + 1], exposed: true, neighborHeight: null };
        const last = segs[segs.length - 1];
        if (last && last.exposed === seg.exposed && last.neighborHeight === seg.neighborHeight) last.t1 = seg.t1;
        else segs.push(seg);
      }
      const exposedLen = segs.reduce((s, g) => s + (g.exposed ? g.t1 - g.t0 : 0), 0);
      facades.push({
        id: `F${facades.length}`, ring: ri, a: a.map((v) => +v.toFixed(2)), b: b.map((v) => +v.toFixed(2)),
        length: +length.toFixed(2), azimuth: +az.toFixed(1), orient: azToOrient(az),
        exposed: +exposedLen.toFixed(3), segments: segs.map((g) => ({ ...g, t0: +g.t0.toFixed(4), t1: +g.t1.toFixed(4) })), wwr: 0,
      });
    }
  });

  return {
    id: rec.id,
    name: rec.tags.name || null,
    address: rec.tags['addr:street'] ? `${rec.tags['addr:street']} ${rec.tags['addr:housenumber'] || ''}`.trim() + (rec.tags['addr:postcode'] ? `, ${rec.tags['addr:postcode']} München` : '') : null,
    center: { lat: clat, lon: clon },
    outer: outer.map((p) => p.map((v) => +v.toFixed(2))),
    holes: holes.map((h) => h.map((p) => p.map((v) => +v.toFixed(2)))),
    height: H.height, floors: H.floors, floorHeight: H.floorHeight, roof: H.roof, floorsPrior, storeyDefault: H.storey,
    hGBias: H.src.height === 'osm:height' ? 0.3 : 0,   // see anFactorMean
    basement: ['sfh', 'th', 'mfh', 'ab'].includes(U.usage) ? 'unheated' : 'none',
    usage: U.usage, profile: U.profile || null, heated: U.heated, usageSrc: U.src, usageInferred: guessed && U === U1, geomSrc: H.src,
    facades,
    neighbors: nbs.map((n) => ({ id: n.id, outer: n.outer.map((p) => p.map((v) => +v.toFixed(2))), holes: n.holes, height: n.height, heated: n.heated })),
    structure: st ? { footprint: st[0], height: st[1] } : null,
    noLoD2: !!opts.lod2?.noCover?.has(rec.id),
    osmTags: rec.tags,
    lonlatOuter: rec.outer,
  };
}

// Exposed wall area of a facade, including the part of a party wall above a lower neighbour.
export function facadeExposedArea(f, height) {
  let a = 0;
  for (const s of f.segments) {
    const L = (s.t1 - s.t0) * f.length;
    if (s.exposed) a += L * height;
    else if (s.neighborHeight != null) a += L * Math.max(0, height - s.neighborHeight);
  }
  return a;
}

// GEG reference area of residential buildings per m³ gross volume: 0.32 for storey heights 2.5–3.0 m, else 1/h_G − 0.04.
export const anFactor = (hG) => (hG >= 2.5 && hG <= 3.0 ? 0.32 : Math.max(0.2, 1 / hG - 0.04));
// Storey heights from measured heights (LoD2, OSM height) run high by up to about 0.3 m (plinth, parapet, wall under the
// roof), and many lie near the 3.0 m step, where the factor drops by about 8%. So the point value takes the factor's
// mean over h_G − δ, δ uniform on [0, m.hGBias] (7 points), and each prior draw samples δ (archetype.js → p.anScale).
// The bias only lowers h_G down to 2.5 m (real storey heights below that are rare; a lower measured value points to a
// wrong storey count, not to a plinth), and a measured value already below 2.5 m is left as it is.
export const anFactorAt = (hG, d) => anFactor(hG < 2.5 ? hG : Math.max(2.5, hG - d));
export function anFactorMean(hG, bias) {
  if (!(bias > 0)) return anFactor(hG);
  let s = 0; for (let k = 0; k <= 6; k++) s += anFactorAt(hG, (bias * k) / 6);
  return s / 7;
}

// Areas per CONTRACT §2 (needs facade wwr). GEG reference area for residential: A_N from gross volume.
export function computeAreas(m) {
  const fpOuter = Math.abs(signedArea(m.outer));
  const fpHoles = m.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
  const footprint = fpOuter - fpHoles;
  const atticHeated = m.roof.attic === 'heated';
  const atticVol = atticHeated ? footprint * m.roof.ridgeHeight * 0.5 : 0;
  const volume = footprint * m.height + atticVol;
  const grossFloor = footprint * m.floors + (atticHeated ? footprint * 0.6 * Math.max(1, m.roof.roofLevels || 1) : 0);
  const hG = m.floorHeight;
  const residential = ['sfh', 'th', 'mfh', 'ab'].includes(m.usage);
  let netFloor;
  const anF = residential ? anFactorMean(hG, m.hGBias) : null;
  if (residential) netFloor = anF * volume;
  else netFloor = 0.85 * grossFloor;
  // living area: A_N / 1.2 (GEG §82(2)) scaled to the Zensus 2022 living area by house type and storey height (livingarea.js)
  const living = residential ? (netFloor / 1.2) * livingKappa(m.usage, hG) : null;
  let facadeGross = 0, facadeExposed = 0, window = 0;
  for (const f of m.facades) {
    facadeGross += f.length * m.height;
    const ex = facadeExposedArea(f, m.height);
    f.exposedArea = +ex.toFixed(2);
    f.windowArea = +(ex * f.wwr).toFixed(2);
    facadeExposed += ex;
    window += f.windowArea;
  }
  const pitch = m.roof.ridgeHeight > 0 ? Math.atan(m.roof.ridgeHeight / Math.max(2, Math.sqrt(footprint) / 2)) : 0;
  const roof = atticHeated ? footprint / Math.cos(pitch) : footprint;
  m.areas = {
    footprint: +footprint.toFixed(1), grossFloor: +grossFloor.toFixed(1), netFloor: +netFloor.toFixed(1), anFactor: anF, living: living == null ? null : +living.toFixed(1),
    facadeGross: +facadeGross.toFixed(1), facadeExposed: +facadeExposed.toFixed(1), window: +window.toFixed(1),
    opaqueWall: +(facadeExposed - window).toFixed(1), roof: +roof.toFixed(1), groundFloor: +footprint.toFixed(1), volume: +volume.toFixed(1),
    envelope: +(facadeExposed + roof + footprint).toFixed(1),
  };
  return m.areas;
}

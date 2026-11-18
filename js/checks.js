// Self-check ("打分表") for a quick model. Each item states what is measured and how it is judged.
// Following the EnergyRSI lesson: separate "looks plausible" from "is anchored to evidence", and say which is which.
import { fmt } from './charts.js';
import { L } from './i18n.js';

const G_DATA = L('数据锚定', 'Data anchoring', 'Datengrundlage'), G_GEOM = L('几何', 'Geometry', 'Geometrie'), G_PHYS = L('物理合理性', 'Physical plausibility', 'Physikalische Plausibilität'), G_RES = L('研究模型', 'Research model', 'Forschungsmodell');

const EUI_RANGE = [ // heating useful energy kWh/(m²a), wide empirical bands by construction period (estimated)
  { to: 1978, lo: 90, hi: 320 }, { to: 1994, lo: 60, hi: 200 }, { to: 2009, lo: 30, hi: 130 }, { to: 9999, lo: 8, hi: 70 },
];

export function runChecks(model, res, ex) {
  const out = [];
  // go: [tab, selector] of the place in the page that shows what this check looks at (used by the drill-down)
  const GO = {}; let cur = null;
  const add = (group, title, status, detail, how) => { out.push({ group, title, status, detail, how, go: GO[cur] || null }); cur = null; };
  const at = (key) => { cur = key; return add; };
  Object.assign(GO, { height: ['params', '#pp-geom'], age: ['params', '#pp-age'], bills: ['calib', '#cy'], user: ['params', '#pp-table'], geom: ['params', '#pp-geom'], party: ['balance', '#bal-facades'], shade: ['balance', '#bal-facades'], demand: ['balance', '#bal-loss'], peak: ['balance', '#bal-peak'], closure: ['balance', '#bal-gain'] });
  const A = model.areas;
  // --- data anchoring
  const gs = model.geomSrc || {};
  at('height')(G_DATA, L('高度来源', 'Height source', 'Quelle der Höhe'), gs.height === 'osm:height' || gs.height?.startsWith('LoD2') ? 'pass' : gs.floors?.startsWith('osm') ? 'pass' : 'warn',
    L(`高度：${gs.height}；层数：${gs.floors}`, `Height: ${gs.height}; storeys: ${gs.floors}`, `Höhe: ${gs.height}; Geschosse: ${gs.floors}`),
    L('有 LoD2 实测、或 OSM 有 height 或 building:levels 记为通过；只有默认值时提醒，层数直接决定体积和楼面积。', 'Pass with measured LoD2, or if OSM has height or building:levels. Warn if only defaults are available, because the storey count sets the volume and floor area.', 'Bestanden bei gemessenem LoD2 oder wenn OSM height oder building:levels enthält. Warnung, wenn nur Standardwerte vorliegen, denn die Geschosszahl bestimmt Volumen und Geschossfläche.'));
  // the cadastre: is there a LoD2 building (from the building register) under the OSM outline?
  if (model.lod2 || model.noLoD2) at('geom')(G_DATA, L('地籍核对', 'Cadastre check', 'Katasterabgleich'), model.lod2 ? 'pass' : 'warn',
    model.lod2 ? L(`与 LoD2 建筑 ${model.lod2.lod2} 对上`, `Matches the LoD2 building ${model.lod2.lod2}`, `Passt zum LoD2-Gebäude ${model.lod2.lod2}`)
      : L('巴伐利亚 LoD2（来自地籍）在这里没有建筑：可能是新建、已拆除或附属构筑物', 'The Bavarian LoD2 (from the cadastre) has no building here: it may be new, demolished or an ancillary structure', 'Das bayerische LoD2 (aus dem Kataster) hat hier kein Gebäude: es kann neu, abgerissen oder ein Nebenbauwerk sein'),
    L('OSM 轮廓下有 LoD2 建筑为通过；完全没有 LoD2 覆盖时提醒。纪念碑、烟囱这类细高构筑物会直接排除，不建模。', 'Pass when a LoD2 building lies under the OSM outline; warn when there is no LoD2 cover at all. Tall, slender structures such as monuments or chimneys are left out and not modelled.', 'Bestanden, wenn unter dem OSM-Umriss ein LoD2-Gebäude liegt; Warnung, wenn es gar keine LoD2-Abdeckung gibt. Schlanke Bauwerke wie Denkmäler oder Schornsteine werden ausgeschlossen und nicht modelliert.'));
  at('age')(G_DATA, L('建成年代来源', 'Construction age source', 'Quelle des Baujahrs'), ex.ageInfo.kind === 'osm' ? 'pass' : ex.ageInfo.kind === 'zensus' ? 'info' : 'warn',
    ex.ageInfo.src, L('OSM start_date 为通过；Zensus 网格分布只给概率，记为信息；两者都没有时提醒。年代决定全部构件 U 值。', 'Pass with an OSM start_date. A Zensus grid distribution only gives probabilities, so it counts as info. Warn if neither exists. The age sets every element U-value.', 'Bestanden bei OSM start_date. Eine Zensus-Rasterverteilung liefert nur Wahrscheinlichkeiten und zählt daher als Info. Warnung, wenn beides fehlt. Das Baujahr bestimmt alle U-Werte der Bauteile.'));
  at('bills')(G_DATA, L('实测数据', 'Measured data', 'Messdaten'), ex.calibrated ? 'pass' : 'warn', ex.calibrated ? L('已用账单标定', 'Calibrated against bills', 'Mit Abrechnungen kalibriert') : L('尚未输入账单，结果只是先验估计', 'No bills entered yet. The results are prior estimates only.', 'Noch keine Abrechnungen eingegeben. Die Ergebnisse sind nur A-priori-Schätzungen.'),
    L('没有实测，所有分数只说明"像"，不说明"准"。', 'Without measurements, every score shows only that the model looks plausible, not that it is accurate.', 'Ohne Messwerte zeigt jede Bewertung nur, dass das Modell plausibel wirkt, nicht, dass es genau ist.'));
  const nUser = Object.values(model.params).filter((p) => p.source === 'user').length;
  at('user')(G_DATA, L('用户提供的参数', 'Parameters given by the user', 'Selbst angegebene Parameter'), nUser ? 'pass' : 'info', L(`${nUser} 项`, `${nUser}`, `${nUser}`), L('每一项用户确认的参数都会缩小先验。', 'Every parameter the user confirms narrows the prior.', 'Jeder von Ihnen bestätigte Parameter engt den Prior ein.'));
  // --- geometry
  at('geom')(G_GEOM, L('占地与体积', 'Footprint and volume', 'Grundfläche und Volumen'), A.footprint > 20 && A.volume > 50 ? 'pass' : 'fail', L(`占地 ${fmt(A.footprint)} m²，体积 ${fmt(A.volume)} m³`, `Footprint ${fmt(A.footprint)} m², volume ${fmt(A.volume)} m³`, `Grundfläche ${fmt(A.footprint)} m², Volumen ${fmt(A.volume)} m³`), L('占地 > 20 m² 且体积 > 50 m³。', 'Footprint > 20 m² and volume > 50 m³.', 'Grundfläche > 20 m² und Volumen > 50 m³.'));
  const party = model.facades.reduce((s, f) => s + f.length * (1 - f.exposed), 0), per = model.facades.reduce((s, f) => s + f.length, 0);
  at('party')(G_GEOM, L('共用墙识别', 'Party wall detection', 'Erkennung von Gebäudetrennwänden'), 'info', L(`共用墙占外周长 ${fmt((100 * party) / per, 0)}%`, `Party walls are ${fmt((100 * party) / per, 0)}% of the perimeter`, `Gebäudetrennwände machen ${fmt((100 * party) / per, 0)}% des Umfangs aus`), L('与相邻供暖建筑共线且距离 < 0.9 m 的边记为共用墙，高出邻楼的部分仍算外墙。', 'Edges collinear with a heated neighbour and closer than 0.9 m count as party wall. The part above the neighbour still counts as external wall.', 'Kanten, die mit einem beheizten Nachbargebäude kollinear sind und näher als 0,9 m liegen, gelten als Gebäudetrennwand. Der Teil oberhalb des Nachbargebäudes zählt weiterhin als Außenwand.'));
  const svf = ex.shading ? Array.from(ex.shading.svf) : [];
  const exposedF = model.facades.map((f, i) => [f, i]).filter(([f]) => f.exposed > 0);
  if (svf.length && exposedF.length) {
    const m = exposedF.reduce((s, [f, i]) => s + svf[i], 0) / exposedF.length;
    at('shade')(G_GEOM, L('周边遮挡', 'Shading by surroundings', 'Verschattung durch die Umgebung'), m > 0.4 ? 'pass' : 'info', L(`外露立面的平均天空可视比 ${fmt(m * 100, 0)}%`, `Mean sky view factor of the exposed facades ${fmt(m * 100, 0)}%`, `Mittlerer Himmelssichtfaktor der freiliegenden Fassaden ${fmt(m * 100, 0)}%`), L('用周边 150 m 内建筑体块做光线遮挡；值低说明窗户得热明显减少。', 'Building blocks within 150 m shade the facades. A low value means clearly lower solar gains through the windows.', 'Gebäudekörper im Umkreis von 150 m verschatten die Fassaden. Ein niedriger Wert bedeutet deutlich geringere solare Gewinne durch die Fenster.'));
  }
  // --- physics plausibility
  const cls = ex.ageClass;
  const y = cls ? (cls.to ?? 2025) : 2025;
  const band = EUI_RANGE.find((b) => y <= b.to);
  const q = res.annual.heatPerM2;
  at('demand')(G_PHYS, L('采暖需求强度', 'Heating demand intensity', 'Spezifischer Heizwärmebedarf'), q >= band.lo && q <= band.hi ? 'pass' : 'warn',
    L(`${fmt(q, 0)} kWh/(m²·a)，${cls ? cls.label : ''}的经验范围 ${band.lo}–${band.hi}`, `${fmt(q, 0)} kWh/(m²·a). Empirical range${cls ? ` for ${cls.label}` : ''}: ${band.lo}–${band.hi}`, `${fmt(q, 0)} kWh/(m²·a). Erfahrungsbereich${cls ? ` für ${cls.label}` : ''}: ${band.lo}–${band.hi}`),
    L('经验范围是宽带（估计值），超出不一定错，但需要看原因。', 'The empirical range is a wide band (estimated). A value outside it is not necessarily wrong, but the reason needs a look.', 'Der Erfahrungsbereich ist ein breites Band (geschätzt). Ein Wert außerhalb ist nicht unbedingt falsch, aber die Ursache sollte geprüft werden.'));
  const pk = res.annual.peakHeat / Math.max(1, A.netFloor);
  at('peak')(G_PHYS, L('峰值热负荷', 'Peak heating load', 'Maximale Heizlast'), pk > 8 && pk < 160 ? 'pass' : 'warn', `${fmt(pk, 0)} W/m²`, L('8–160 W/m² 之间为通过。', 'Pass between 8 and 160 W/m².', 'Bestanden zwischen 8 und 160 W/m².'));
  const u = res.balance?.utilisation;
  at('closure')(G_PHYS, L('热平衡闭合', 'Heat balance closure', 'Schließung der Wärmebilanz'), u != null && u > 0.5 && u <= 1 ? 'pass' : 'warn', L(`得热利用率 ${u != null ? fmt(u, 2) : '–'}`, `Gain utilisation factor ${u != null ? fmt(u, 2) : '–'}`, `Ausnutzungsgrad der Wärmegewinne ${u != null ? fmt(u, 2) : '–'}`), L('损失 − 利用的得热 = 供暖需求，利用率应在 0.5–1。', 'Losses minus utilised gains equal the heating demand. The utilisation factor should lie between 0.5 and 1.', 'Verluste abzüglich genutzter Gewinne ergeben den Heizwärmebedarf. Der Ausnutzungsgrad sollte zwischen 0,5 und 1 liegen.'));
  if (ex.rotated) {
    const d = (ex.rotated.annual.heat - res.annual.heat) / res.annual.heat;
    const ok = Math.abs(d) < 0.2 && Math.abs(d) > 0.0005;
    add(G_PHYS, L('旋转 90° 响应', 'Response to a 90° rotation', 'Reaktion auf eine Drehung um 90°'), ok ? 'pass' : 'warn', L(`把所有立面朝向转 90°，采暖需求变化 ${fmt(d * 100, 1)}%`, `Turning every facade by 90° changes the heating demand by ${fmt(d * 100, 1)}%`, `Eine Drehung aller Fassaden um 90° ändert den Heizwärmebedarf um ${fmt(d * 100, 1)}%`),
      L('借鉴 EnergyRSI 打分表：朝向应该有影响（太阳得热），但不应翻倍。完全没变化说明日照没起作用。', 'Taken from the EnergyRSI scorecard. Orientation should matter (solar gains), but it should not double the demand. No change at all means the sun has no effect.', 'Übernommen aus dem EnergyRSI-Bewertungsschema. Die Ausrichtung sollte eine Rolle spielen (solare Gewinne), den Bedarf aber nicht verdoppeln. Gar keine Änderung bedeutet, dass die Sonne keine Wirkung hat.'));
  }
  const oh = res.annual.overheatHours;
  if (model.params.T_cool.value == null) add(G_PHYS, L('夏季过热', 'Summer overheating', 'Sommerliche Überhitzung'), oh < 0.06 * res.annual.occHours ? 'pass' : 'warn', L(`使用时段操作温度 > 26 °C：${fmt(oh)} h`, `Operative temperature > 26 °C during occupancy: ${fmt(oh)} h`, `Operative Temperatur > 26 °C während der Nutzungszeit: ${fmt(oh)} h`), L('超过使用时段 6% 时提醒（无制冷建筑）。', 'Warn above 6% of the occupied hours (buildings without cooling).', 'Warnung bei mehr als 6 % der Nutzungsstunden (Gebäude ohne Kühlung).'));
  return out;
}

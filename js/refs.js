// Structured references: for each parameter, which document, which page or table, and a link that opens it there.
// Page numbers are PDF page indices as verified in data/archetypes_sources.md ("PDF p. N"), so #page=N lands on them.
// Where only a printed page or table is known, the link opens the document and the text names the table.
// Values without a public source are returned as tier 'default' (assumed) with the rule spelled out.
import { L } from './i18n.js';

let SRC = {};
export function setSources(list) { SRC = Object.fromEntries((list || []).map((s) => [s.id, s])); }

const DOC = 'data/archetypes_sources.md';
const GEG = (n) => `https://www.gesetze-im-internet.de/geg/anlage_${n}.html`;
export const ZENSUS = 'https://www.destatis.de/DE/Themen/Gesellschaft-Umwelt/Bevoelkerung/Zensus2022/_inhalt.html';
const url = (id, page) => (SRC[id]?.url ? SRC[id].url + (page ? `#page=${page}` : '') : null);
const ref = (id, label, where, page, tier = 'archetype') => ({ label, where, url: url(id, page), tier });
const assumed = (where, link = DOC) => ({ label: L('估算', 'Assumed', 'Annahme'), where, url: link, tier: 'default' });

const IWU15 = 'IWU 2015', IWU18 = 'IWU 2018', DENA = 'dena 2023', BBSR = 'BBSR 2023';
const DIN_VIA_DENA = (tab = 'Tab. 6') => ref('DENA2023', DENA, L(`DIN V 18599-10:2018 表 4 的转引，见 ${tab}（印刷页第 34 页）；标准原文收费`, `DIN V 18599-10:2018 Table 4 as reproduced in ${tab} (printed p. 34); the standard itself is paid`, `DIN V 18599-10:2018 Tab. 4, wiedergegeben in ${tab} (gedruckte S. 34); die Norm selbst ist kostenpflichtig`));

// GEG annexes named in a source string, e.g. "GEG Anlage 4 Nr. 2 / Anlage 9 Nr. 3.2".
export function gegRefs(src) {
  const out = [];
  for (const m of String(src || '').matchAll(/Anlage (\d+)(?: Nr\. ([\d.]+))?/g)) {
    out.push({ label: `GEG Anlage ${m[1]}`, where: m[2] ? `Nr. ${m[2]}` : '', url: GEG(m[1]), tier: 'archetype' });
  }
  return out;
}

// ctx: { param, modern, comp, residential, carrier: {src}, system: {src}, osmUrl }
export function refsFor(key, ctx = {}) {
  const p = ctx.param || {};
  if (p.source === 'user') return [{ label: L('用户填写', 'User input', 'Eigene Eingabe'), where: L('在本页填写，覆盖下面的默认来源', 'Entered on this page; overrides the default source below', 'Auf dieser Seite eingegeben; ersetzt die unten genannte Standardquelle'), url: null, tier: 'user' }, ...refsFor(key, { ...ctx, param: { ...p, source: ctx.defaultSource || 'archetype' } }).filter((r) => r.tier !== 'user')];
  if (p.source === 'calibrated') return [{ label: L('账单标定', 'Bill calibration', 'Kalibrierung mit Abrechnungen'), where: L('账单标定后验中位数；先验来源见下', 'Posterior median of the bill calibration; the prior source follows', 'Posterior-Median der Kalibrierung mit Abrechnungen; die Quelle des Priors folgt'), url: null, tier: 'calibrated' }];
  const orig = ref('IWU2015', IWU15, L('附录 C.1「Wärmeschutz Variante 1」：原始状态 U 值，PDF 第 106 页', 'Annex C.1 "Wärmeschutz Variante 1": U-values of the original state, PDF p. 106', 'Anhang C.1 „Wärmeschutz Variante 1“: U-Werte des Ursprungszustands, PDF S. 106'), 106);
  switch (key) {
    case 'U_wall': case 'U_roof': case 'U_floor': case 'U_window': {
      // ctx.share: probability that the element was retrofitted (1 = yes, 0 = no); the point value mixes both states
      const q = ctx.share ?? 0, out = [];
      if (q < 1) out.push(orig);
      if (q > 0) {
        out.push(key === 'U_window'
          ? ref('IWU2022', 'IWU 2022', L('表 3：2016 年窗户平均 U 值 2.11（独栋）/ 2.04（多户），改造比例 54% / 60%，未改造 2.7，反推改造后约 1.6', 'Table 3: mean window U in 2016 of 2.11 (houses) / 2.04 (apartments) at 54% / 60% modernised and 2.7 unmodernised, implying about 1.6 after modernisation', 'Tab. 3: mittlerer U-Wert der Fenster 2016 von 2,11 (Einfamilienhäuser) / 2,04 (Mehrfamilienhäuser) bei einem Modernisierungsanteil von 54 % / 60 % und 2,7 unmodernisiert; daraus folgen etwa 1,6 nach der Modernisierung'))
          : ref('IWU2018', IWU18, L(`后加保温的平均厚度：${{ U_wall: '表 33，墙 9.0 cm', U_roof: '表 35，屋顶/顶层楼板 13.3 cm', U_floor: '表 38，地面 7.7 cm' }[key]}（1978 年以前的楼）；U = 1/(1/U₀ + d/λ)，λ = 0.035，屋顶椽间 0.045`, `Mean added insulation: ${{ U_wall: 'Table 33, wall 9.0 cm', U_roof: 'Table 35, roof / top ceiling 13.3 cm', U_floor: 'Table 38, floor 7.7 cm' }[key]} (buildings up to 1978); U = 1/(1/U₀ + d/λ), λ = 0.035, 0.045 between rafters`, `Mittlere Dicke der nachträglichen Dämmung: ${{ U_wall: 'Tab. 33, Wand 9,0 cm', U_roof: 'Tab. 35, Dach / oberste Geschossdecke 13,3 cm', U_floor: 'Tab. 38, Fußboden 7,7 cm' }[key]} (Gebäude bis 1978); U = 1/(1/U₀ + d/λ), λ = 0,035 (zwischen den Sparren 0,045)`)));
        if (key !== 'U_window') out.push(assumed(L('λ 的取值，以及把 1978 年以前楼的平均厚度用于所有年代，属推导估算（来源文档 §G）', 'The λ values, and using the mean thickness of pre-1978 buildings for every age class, are derived estimates (source notes §G)', 'Die λ-Werte und die Übertragung der mittleren Dämmdicke von Gebäuden vor 1978 auf alle Baualtersklassen sind abgeleitete Schätzungen (Quellendokumentation §G)')));
      }
      if (ctx.state === 'unknown') out.push(ref('IWU2018', IWU18, key === 'U_window' ? L('表 39：1995 年以后窗户的比例，按年代（2016 实测，按表 43 的年改造率外推到 2026，外推属估算）', 'Table 39: share of windows from 1995 or later, by age class (measured 2016, projected to 2026 with the annual rates of Table 43; the projection is an estimate)', 'Tab. 39: Anteil der Fenster ab 1995, nach Baualtersklasse (erhoben 2016, mit den jährlichen Raten aus Tab. 43 auf 2026 fortgeschrieben; die Fortschreibung ist eine Schätzung)') : L('表 18：后加保温的比例，按年代（2016 实测，按表 43 的年改造率外推到 2026，外推属估算）', 'Table 18: share with added insulation, by age class (measured 2016, projected to 2026 with the annual rates of Table 43; the projection is an estimate)', 'Tab. 18: Anteil mit nachträglicher Dämmung, nach Baualtersklasse (erhoben 2016, mit den jährlichen Raten aus Tab. 43 auf 2026 fortgeschrieben; die Fortschreibung ist eine Schätzung)')));
      if (key === 'U_roof' || key === 'U_floor') out.push(ref('IWU2015', IWU15, L('不供暖阁楼或地下室的温度修正另计，见 F 系数（PDF 第 87 页）', 'Unheated attics and basements are handled by the separate F factor (PDF p. 87)', 'Unbeheizte Dachgeschosse und Keller werden über den separaten F-Faktor berücksichtigt (PDF S. 87)'), 87));
      return out;
    }
    case 'g_window': {
      const q = ctx.share ?? 0, out = [];
      if (q > 0) out.push({ label: 'GEG Anlage 1', where: L('参照建筑的窗 g = 0.6，用于更换后的低辐射玻璃', 'Reference building window g = 0.6, used for replacement low-e glazing', 'Fenster des Referenzgebäudes g = 0,6; verwendet für ausgetauschte Fenster mit Wärmeschutzverglasung'), url: GEG(1), tier: 'archetype' });
      if (q < 1) out.push(ref('IWU2015', IWU15, L('TABULA 计算表 MFH_E：双层中空玻璃 g = 0.75，PDF 第 87 页', 'TABULA sheet MFH_E: double insulating glazing g = 0.75, PDF p. 87', 'TABULA-Berechnungsblatt MFH_E: Zweischeiben-Isolierverglasung g = 0,75, PDF S. 87'), 87), ref('IWU2015', IWU15, L('三层玻璃 g = 0.50（MFH_L），PDF 第 100 页', 'Triple glazing g = 0.50 (MFH_L), PDF p. 100', 'Dreifachverglasung g = 0,50 (MFH_L), PDF S. 100'), 100));
      return out;
    }
    case 'frameFrac': return [ref('IWU2015', IWU15, L('TABULA 标准窗框比例 F_F = 0.30，PDF 第 87 页', 'TABULA standard frame fraction F_F = 0.30, PDF p. 87', 'TABULA-Standardwert Rahmenanteil F_F = 0,30, PDF S. 87'), 87), ref('IWU2015', IWU15, L('同上，PDF 第 100 页', 'Same, PDF p. 100', 'Ebenso, PDF S. 100'), 100)];
    case 'dU_tb': return [ref('IWU2015', IWU15, L('附录 C.1：A–I 类 0.10，J–L 类 0.05 W/(m²K)，PDF 第 106 页', 'Annex C.1: 0.10 W/(m²K) for classes A–I, 0.05 for J–L, PDF p. 106', 'Anhang C.1: 0,10 W/(m²K) für die Klassen A–I, 0,05 für J–L, PDF S. 106'), 106)];
    case 'n50': return [assumed(L('换过窗的楼取 0.75 倍，点值按换窗概率取期望；0.75 没有出处', 'Buildings with replaced windows take 0.75 times the value, and the point value uses the expected factor; the 0.75 has no source', 'Bei Gebäuden mit ausgetauschten Fenstern wird der Wert mit 0,75 multipliziert; der Punktwert verwendet den Erwartungswert dieses Faktors; für 0,75 gibt es keine Quelle')), assumed(L('按年代估算，TABULA 只给渗透换气 0.20 1/h（PDF 第 87 页）；说明见来源文档 §A.5', 'Estimated by age class. TABULA gives only an infiltration air change of 0.20 1/h (PDF p. 87); see the source notes §A.5', 'Nach Baualtersklasse geschätzt. TABULA nennt nur einen Infiltrationsluftwechsel von 0,20 1/h (PDF S. 87); siehe Quellendokumentation §A.5')), ref('IWU2015', IWU15, L('TABULA 渗透换气 0.20 1/h，PDF 第 87 页', 'TABULA infiltration 0.20 1/h, PDF p. 87', 'TABULA-Infiltrationsluftwechsel 0,20 1/h, PDF S. 87'), 87)];
    case 'Cm': return [ref('IWU2015', IWU15, L('TABULA c_m = 45 Wh/(m²K)，即 ISO 13790 中等，PDF 第 87 页', 'TABULA c_m = 45 Wh/(m²K), the ISO 13790 medium class, PDF p. 87', 'TABULA c_m = 45 Wh/(m²K), die Klasse „mittel“ nach ISO 13790, PDF S. 87'), 87), assumed(L('重型构造的建议值是开发者判断，没有出处', 'The heavy-construction suggestion is the developer’s judgement, without a source', 'Der Vorschlag für schwere Bauweise ist eine Einschätzung des Entwicklers, ohne Quelle'))];
    case 'F_floor': return [ref('IWU2015', IWU15, L('TABULA 地下室顶板和地面 b = 0.50，PDF 第 87 页', 'TABULA b = 0.50 for basement ceiling and slab, PDF p. 87', 'TABULA b = 0,50 für Kellerdecke und Bodenplatte, PDF S. 87'), 87), ref('IWU2015', IWU15, L('同上，PDF 第 100 页', 'Same, PDF p. 100', 'Ebenso, PDF S. 100'), 100)];
    case 'F_roof': return [assumed(L('不供暖阁楼取 0.85：由 TABULA MFH_E 的附加热阻折算，未在标准表中核实', 'Unheated attic 0.85: derived from the extra resistance on the TABULA MFH_E sheet, not checked against a standard table', 'Unbeheiztes Dachgeschoss 0,85: abgeleitet aus dem Zusatzwiderstand auf dem TABULA-Berechnungsblatt MFH_E, nicht mit einer Normtabelle abgeglichen')), ref('IWU2015', IWU15, L('TABULA MFH_E 计算表，PDF 第 87 页', 'TABULA sheet MFH_E, PDF p. 87', 'TABULA-Berechnungsblatt MFH_E, PDF S. 87'), 87)];
    case 'T_heat': case 'setback': case 'n_vent': case 'dhw':
      return ctx.residential
        ? [DIN_VIA_DENA(), ...(key === 'dhw' ? [ref('DENA2023', DENA, L('热水公式在印刷页第 35 页', 'DHW formula on printed p. 35', 'Formel für Trinkwarmwasser auf der gedruckten S. 35'))] : [])]
        : [ref('BBSR2023', BBSR, L('非住宅使用剖面，DIN V 18599-10 的转引（表 5-x，按用途）', 'Non-residential usage profiles as reproduced from DIN V 18599-10 (Table 5-x, by use)', 'Nutzungsprofile für Nichtwohngebäude, wiedergegeben aus DIN V 18599-10 (Tab. 5-x, nach Nutzung)'))];
    case 'Q_int':
      return ctx.residential
        ? [ref('IWU2015', IWU15, L('TABULA 标准内部得热 3.0 W/m²，PDF 第 75 页', 'TABULA standard internal gains 3.0 W/m², PDF p. 75', 'TABULA-Standardwert für interne Wärmegewinne 3,0 W/m², PDF S. 75'), 75), DIN_VIA_DENA('Tab. 6')]
        : [ref('BBSR2023', BBSR, L('非住宅使用剖面（表 5-x，按用途）', 'Non-residential usage profiles (Table 5-x, by use)', 'Nutzungsprofile für Nichtwohngebäude (Tab. 5-x, nach Nutzung)'))];
    case 'heatedFrac': return [assumed(L('默认全部面积供暖', 'Default: whole floor area heated', 'Standardannahme: gesamte Fläche beheizt'))];
    case 'hr_eff': return [ref('IWU2015', IWU15, L('改造包 2 的机械通风热回收 80%（附录 D）', 'Package 2 mechanical ventilation with 80% heat recovery (Annex D)', 'Modernisierungspaket 2: mechanische Lüftung mit 80 % Wärmerückgewinnung (Anhang D)'))];
    case 'T_cool': return [assumed(L('默认不制冷；制冷时 25 °C', 'Default: no cooling; 25 °C if cooled', 'Standardannahme: keine Kühlung; 25 °C bei Kühlung'))];
    case 'system': return p.source === 'zensus'
      ? [{ label: 'Zensus 2022', where: L('「Energieträger der Heizung」网格，按住宅单元统计，取本格最多的能源载体；数据见 data/zensus/heizung.json', 'grid "Energieträger der Heizung", counted by dwellings; the largest carrier in the cell is used; data in data/zensus/heizung.json', 'Gitterdaten „Energieträger der Heizung“, gezählt nach Wohnungen; verwendet wird der häufigste Energieträger in der Zelle; Daten in data/zensus/heizung.json'), url: ZENSUS, tier: 'zensus' },
        assumed(L('燃气时锅炉类型仍按年代估算：1995 年前旧锅炉，之后冷凝锅炉', 'For gas, the boiler type is still estimated from age: old boiler before 1995, condensing boiler after', 'Bei Gas wird der Kesseltyp weiterhin nach Baujahr geschätzt: vor 1995 Altgerät, danach Brennwertkessel'))]
      : [assumed(L('按年代估算：1995 年前旧燃气锅炉，2016 年前冷凝锅炉，之后空气源热泵（附近没有 Zensus 供暖数据）', 'Estimated from age: old gas boiler before 1995, condensing boiler before 2016, air-source heat pump after (no Zensus heating data nearby)', 'Nach Baujahr geschätzt: vor 1995 Gaskessel (Altgerät), vor 2016 Brennwertkessel, danach Luft-Wasser-Wärmepumpe (keine Zensus-Heizungsdaten in der Nähe)'))];
    case 'eta_sys': return [ref('IWU2015', IWU15, ctx.system?.src || L('附录 D 楼型表中的供暖系统损失', 'Heating system losses on the Annex D building sheets', 'Anlagenverluste auf den Gebäudedatenblättern in Anhang D')), ...(ctx.system?.estimated ? [assumed(L('由附录 D 的数值换算，属估算', 'Derived from the Annex D values; an estimate', 'Aus den Werten in Anhang D abgeleitet; eine Schätzung'))] : [])];
    case 'co2': case 'fp': {
      const s = ctx.carrier?.src || '';
      if (/SWM/.test(s)) return [{ label: 'SWM', where: L('慕尼黑热网 GEG 证书；CO₂ 取 Carnot 法 119.1 g/kWh（GEG 方法为 0）', 'Munich network GEG certificate; CO₂ by the Carnot method, 119.1 g/kWh (the GEG method gives 0)', 'GEG-Bescheinigung des Münchner Fernwärmenetzes; CO₂ nach der Carnot-Methode, 119,1 g/kWh (die GEG-Methode ergibt 0)'), url: url('SWM2026'), tier: 'archetype' }];
      const g = gegRefs(s).filter((r) => (key === 'co2' ? r.label.endsWith(' 9') : r.label.endsWith(' 4')));
      return g.length ? g : [{ label: 'GEG', where: s, url: GEG(key === 'co2' ? 9 : 4), tier: 'archetype' }];
    }
    default:
      if (key.startsWith('WWR_')) return [assumed(L('所有楼都按楼型取固定值（1919 年以前另取一档），四个朝向相同，没有出处。计划：住宅改用 IWU 附录 D 样板楼按楼型和年代的实际窗面积（查表）；非住宅暂无公开表，仍是估算', 'Every building takes a fixed value by type (another one before 1919), the same on all four sides, without a source. Planned: residential buildings take the actual window areas of the IWU Annex D example buildings by type and age (table); non-residential buildings have no public table yet and stay assumed', 'Jedes Gebäude erhält einen festen Wert nach Gebäudetyp (einen anderen vor 1919), auf allen vier Seiten gleich, ohne Quelle. Geplant: Wohngebäude übernehmen die tatsächlichen Fensterflächen der IWU-Beispielgebäude aus Anhang D nach Typ und Baualtersklasse (Tabelle); für Nichtwohngebäude gibt es noch keine öffentliche Tabelle, sie bleiben eine Annahme'))];
      return p.note ? [{ label: L('说明', 'Note', 'Hinweis'), where: p.note, url: null, tier: p.source || 'default' }] : [];
  }
}

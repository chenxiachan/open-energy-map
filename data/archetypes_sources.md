# archetypes_de.json — sources and verification status

Compiled 2026-11-04 for the Munich energy-map tool. Each number in `archetypes_de.json` falls into one of three groups:

- **verified**: read directly from the cited table or page, which I downloaded and parsed myself.
- **derived**: computed from verified numbers by a stated rule, such as a median, an area-weighted mean or a unit conversion.
- **estimated**: my judgement, or a value from a secondary source I could not check against the primary. All of these carry `"estimated": true`, or a field-level `*_estimated` flag.

Annex C.1 of IWU 2015 was parsed by word coordinates (`pdftotext -bbox`), so that blank cells do not shift columns. Each row was then spot-checked against the page layout.

## Main sources

| id | reference | url |
|---|---|---|
| IWU2015 | Loga, T.; Stein, B.; Diefenbach, N.; Born, R.: *Deutsche Wohngebäudetypologie. Beispielhafte Maßnahmen zur Verbesserung der Energieeffizienz von typischen Wohngebäuden*, 2. erw. Aufl., IWU Darmstadt, 10.02.2015 (TABULA/EPISCOPE), 281 pp. | https://www.iwu.de/fileadmin/publikationen/gebaeudebestand/episcope/2015_IWU_LogaEtAl_Deutsche-Wohngeb%C3%A4udetypologie.pdf |
| GEG | Gebäudemodernisierungsgesetz (GModG), the former Gebäudeenergiegesetz (GEG), of 8.8.2020 (BGBl. I S. 1728), last amended by Art. 4 G v. 23.7.2026 (BGBl. 2026 I Nr. 226). Text retrieved 2026-11-04. | https://www.gesetze-im-internet.de/geg/BJNR172810020.html |
| IWU2018 | Cischinsky, H.; Diefenbach, N.: *Datenerhebung Wohngebäudebestand 2016*, IWU Darmstadt 2018 | https://www.iwu.de/fileadmin/publikationen/gebaeudebestand/2018_IWU_CischinskyEtDiefenbach_Datenerhebung-Wohngeb%C3%A4udebestand-2016.pdf |
| IWU2010 | Diefenbach, N. et al.: *Datenbasis Gebäudebestand*, IWU Darmstadt 2010 | https://www.iwu.de/fileadmin/publikationen/gebaeudebestand/datenbasis/Endbericht_Datenbasis.pdf |
| IWU2022 | Müller, A.; Heit, P.: *Anpassung der mittleren Typgebäude für Altbauten mit Daten der Datenerhebung Wohngebäudebestand 2016*, IWU Working Paper, 05.01.2022 | https://www.iwu.de/fileadmin/publikationen/arbeitspapier/2022-01-05_IWU_MuellerEtHeit_Working-Paper-Anpassung-der-mittleren-Typgebaeude-fuer-Altbauten-2016.pdf |
| DIBt2014 | DIBt / Fachkommission Bautechnik: Auslegungsfragen EnEV Teil 19, Auslegung XIX-4 (A_N) | https://enev-online.com/enev_2014_praxisdialog/140811_19.04_dibt_ermittlung_gebaeudenutzflaeche_an.pdf |
| SWM2026 | SWM district-heating certificates (TU Dresden, Dr.-Ing. T. Sander, FW 309), operating data 2025, issued 22.06.2026 | see §F |
| ISE2025 | Fraunhofer ISE press release on the heat-pump field test in existing houses (2025) | https://www.ise.fraunhofer.de/de/presse-und-medien/presseinformationen/2025/waermepumpen-heizen-auch-im-altbau-klimafreundlich-forschungsprojekt-des-fraunhofer-ise-abgeschlossen.html |
| OEMOF | oemof-thermal docs, compression heat pumps (Carnot quality grades, citing VDE ETG 2015) | https://oemof-thermal.readthedocs.io/en/master/compression_heat_pumps_and_chillers.html |

**Surprise: the law has been renamed.** On gesetze-im-internet.de the GEG now appears as "Gebäudemodernisierungsgesetz – GModG", last amended 23.07.2026. The URL path is still `/geg/`. Anlagen 1, 4, 7, 9 and 10 carry the same values as before; the Fundstelle notes still point to BGBl. I 2020. In the JSON, "GEG" refers to this current text.

---

## A. Residential envelope (IWU 2015 / TABULA DE)

### A.1 Age classes — verified
IWU 2015 Bild 1 (PDF p. 9) uses exactly the 12 classes in the brief: A ≤1859, B 1860–1918, C 1919–1948, D 1949–1957, E 1958–1968, F 1969–1978, G 1979–1983, H 1984–1994, I 1995–2001, J 2002–2009, K 2010–2015, L 2016–.

Three minor inconsistencies inside the brochure:
- Tab. 4 (p. 17) labels A as "bis 1860" and B as "1861–1918".
- Several new-build tables call K "2009 … 2015".
- The class C.1 tables and building sheets use 1859/1860 and 2010.

The JSON follows Bild 1 and C.1.

There are also special classes not used here: East-German industrial housing NBL_D…H (1946–1990) and a prefab sub-type EFH_F/F.

### A.2 Building types — verified definitions
IWU 2015 Tab. 4 (p. 17) defines the types:
- **EFH**: detached 1–2-family house.
- **RH**: 1–2-family semi-detached or terraced house.
- **MFH**: 3–12 dwellings.
- **GMH**: ≥13 dwellings. Mapped to `ab`.
- **HH**: high-rise. Exists for E and F only and is not mapped. Its values (HH_E, HH_F) equal GMH except the window and floor details.

**Gaps and how they were filled.** IWU has no example for RH_A, GMH_A or GMH_G…L. These entries reuse EFH_A or MFH_x, carry `"reusedFrom"` and are set `"estimated": true`.

### A.3 U-values of the original state — verified (example buildings)
Source tables in IWU 2015 Annex C.1:
- **PDF p. 105**, "Hüllflächen-Daten": element areas and element category per column (Bauteil 1…10). The categories are:
  - DA = roof
  - OG = top-floor ceiling to unheated attic
  - AW = external wall
  - KWE = wall to ground (RH_K/L only; not used)
  - BK = basement ceiling
  - BE = floor slab on ground
  - FE = window
  - AT = door
- **PDF p. 106**, "Wärmeschutz Variante 1": U-values of the original state. The building sheets in Annex D confirm that Variante 1 = "Ist-Zustand", Variante 2 = Modernisierungspaket 1 "konventionell" and Variante 3 = Paket 2 "zukunftsweisend". Example check, EFH_A: Paket 1 roof 0.41, wall 0.35, window 1.6, floor 0.49; Paket 2 0.14, 0.14, 0.80, 0.27.

How the JSON uses them:
- `U_roof` and `U_floor` are the example building's own elements, area-weighted where it has two (e.g. MFH_C has both DA and OG). `roofIs` and `floorIs` say which element it is.
- `U_roofPitched`, `U_topCeiling`, `U_basementCeiling` and `U_slab` are given for every entry, so `archetype.js` can choose by `roof.attic` and `basement`. When the example lacks that element, the value is borrowed from another type of the same class; the `reuse` field records this, and borrowed values should be treated as estimated.
- **Class A top ceiling**: no example in any type. I used RH_B's timber-joist ceiling (1.0), not EFH_A's 2.6 pitched roof.
- **Classes J–L top ceiling**: set equal to the pitched-roof value.
- These are **component U-values without the extra resistance of unheated attics or basements**. TABULA adds that resistance separately; on the MFH_E sheet (p. 87), OG 0.60 becomes 0.51 and BK 1.60 becomes 1.08 with b = 0.5. So apply `F_roof` / `F_floor` in the model.

**Example-specific oddities:**
- **EFH_G window U = 4.3.** The example has metal frames without a thermal break (Annex D sheet). This is not representative of 1979–83 houses. The JSON uses 2.8 (`estimated: true`) and keeps 4.3 under `iwuExample`.
- **EFH_H window 3.2.** Thermally broken aluminium. Kept as is.
- **Windows in classes A–H are already later replacements.** U 2.7–3.0 represents later double insulating glazing; the sheets say "in späteren Jahren modernisiert, Original-Fenster nicht mehr erhalten". Single glazing (~5) is not the IWU default.
- **K and L are designs, not survey data.** Each example exists in three supply variants: gas condensing + solar DHW, biomass, and heat pump. The envelope is tuned so each variant just meets EnEV 2009/2014 (K) or EnEV 2016 (L). The JSON uses the gas variant and lists the heat-pump and biomass variants under `altDesignVariants`. Real new builds since about 2016 are mostly heat-pump houses, whose envelope is often weaker: for SFH_L, wall 0.26–0.30 vs 0.17 in the gas variant.

### A.4 g-values
IWU's C.1 tables give no g-value. TABULA uses g_gl,n per glazing.

| Glazing | g | Status | Source |
|---|---|---|---|
| Double insulating glazing, U_w 2.7–3.0 | 0.75 | verified | TABULA calculation sheet MFH_E, PDF p. 87 |
| Triple glazing, U_w 0.70 | 0.50 | verified | TABULA sheet MFH_L Var. 013, PDF p. 100 |
| Low-e double glazing (U_w ≈ 1.3) | 0.60 | value verified; use as typical value is an estimate | GEG Anlage 1 reference window (U_w 1.3, g = 0.60) |
| Early low-e, U 1.6–1.9 (class I) | 0.65 | estimated | — |
| U_w 1.1 (class L) | 0.55 | estimated | — |

### A.5 Period defaults (`periodDefaults`)
- **`dU_tb`** — verified. IWU 2015 C.1 p. 106 gives 0.10 W/(m²K) for every type in A–I and 0.05 in J–L. In the packages: 0.15 for A/B Paket 1 (internal insulation) and 0.05 for Paket 2. The GEG reference building uses 0.05 (Anlage 1 Nr. 2).
- **`frameFrac` = 0.30** — verified. TABULA standard F_F on the sheets at p. 87 and p. 100.
- **`n_inf_tabula`** — verified. The TABULA reference calculation uses an infiltration air change of 0.20 1/h for existing buildings (MFH_E sheet, p. 87) and 0.05 1/h for the airtight new build with MVHR (p. 100).
- **`n50`** — estimated. I could not verify a table of typical n50 by construction period. The DIN V 18599-2 "Kategorie I–IV" default values were not accessible. The verified anchor is GEG §26(2): for tested new buildings, ≤3.0 1/h without mechanical ventilation and ≤1.5 1/h with it. For volumes over 1,500 m³ the limit is q50 ≤ 4.5 or 2.5 m³/(h·m²) of envelope area. The JSON values (A 10 … H 4, I 3, J 2.5, K 2.0, L 1.5) are typical literature magnitudes for unrefurbished stock, with a wide lognormal spread (`n50_gsd`). As a rough conversion, n_inf ≈ 0.07·n50 for moderately shielded buildings (DIN EN 832 / DIN V 4108-6 type rule, not verified here).
- **`Cm`** — estimated. TABULA uses c_m = 45 Wh/(m²K) for all buildings (p. 87 and p. 100), i.e. 162 kJ/(m²K) per conditioned floor area, which is the ISO 13790 "medium" class (165 kJ). The JSON uses medium for all classes and suggests heavy (260 kJ) for multi-storey concrete-slab MFH/AB in D–H. That suggestion is my judgement and is not sourced.
- **Temperature correction factors `F_floor` / `F_roof`** — not in the JSON as sourced values. TABULA uses b = 0.50 for the basement ceiling and the slab on ground (sheets p. 87 and p. 100), and handles unheated attics by adding a resistance, which amounts to about 0.85 for MFH_E. DIN V 4108-6 tabulates Fx (≈0.8 attic, ≈0.5–0.6 basement or ground), but I did not verify that table. Suggested defaults: F_floor 0.5, F_roof 0.85 (estimated).

---

## B. Refurbishment packages

### B.1 `refurb.usual` / `refurb.advanced` — derived from verified data
Medians over the 28 examples of classes A–H in IWU 2015 C.1 p. 107:
- **Variante 2 = Paket 1 "konventionell".** IWU p. 25: corresponds to practical implementation of the EnEV 2014 minimum requirements.
- **Variante 3 = Paket 2 "zukunftsweisend".** IWU p. 25: corresponds to passive-house component standards.

| element | usual median (range) | advanced median (range) |
|---|---|---|
| wall | 0.23 (0.18–0.40) | 0.13 (0.11–0.14) |
| pitched roof | 0.41 (0.18–0.41) | 0.14 (0.09–0.14) |
| top ceiling | 0.20 (0.17–0.25) | 0.10 (0.09–0.11) |
| basement ceiling | 0.30 (0.25–0.36) | 0.23 (0.20–0.26) |
| slab | 0.32 (0.30–0.49) | 0.23 (0.23–0.27) |
| window | 1.3 (1.3–1.6; 1.6 for historic A/B) | 0.80 |
| door | 1.3 | 0.80 |
| dU_tb | 0.10 (0.15 for A/B) | 0.05 |

Notes on the table:
- **Pitched roof, usual: 0.41.** This is IWU's 12 cm between-rafter insulation (IWU Tab. 10, p. 26: Steildach Effizienzniveau 1 = 0.24…0.45). IWU applies 0.41 even to J where the original roof is 0.20–0.25, so use min(original, package). A full re-roofing must reach 0.24 under GEG Anlage 7 Nr. 5b, so `U_roof` for `usual` is set to 0.24.
- **Advanced ventilation.** Paket 2 adds "Lüftungsanlage mit 80 % Wärmerückgewinnung (Voraussetzung: luftdichte Gebäudehülle)", from the Annex D sheets. Hence `hr_eff` = 0.80, plus `n_inf` 0.05 (p. 100).
- **Per-example packages** are also given inside each envelope entry (`pkgUsual`, `pkgAdvanced`).

### B.2 `refurb.gegAnlage7` — verified
GEG Anlage 7 (zu § 36), current text. Values for residential buildings and zones ≥19 °C:

| element | U_max (W/(m²K)) |
|---|---|
| wall, replacement or external insulation/cladding/new render (1a/1b) | 0.24 |
| window (2a) | 1.3 |
| roof window (2b) | 1.4 |
| glazing only (2c), U_g | 1.1 |
| curtain wall (2d) | 1.5 |
| new external doors (4) | 1.8 |
| roof, top ceiling, attic walls (5a/5b) | 0.24 |
| flat roof with sealing (5c) | 0.20 |
| walls/floors to ground or unheated rooms (6a/6b) | 0.30 |
| floor built up from the heated side (6c) | 0.50 |
| ceilings to outside air (6d/6e) | 0.24 |

Footnotes:
- **Footnote 1.** If insulation thickness is technically limited, the maximum possible thickness with λ ≤ 0.035 W/(mK) is enough (0.045 for blown-in or renewable materials).
- **Footnote 5.** 5b, 5c, 6b, 6c and 6e do not apply if the element was built or renewed after 31.12.1983 in compliance with energy-saving rules.

Zones at 12–19 °C have weaker limits (0.35 / 1.9), given in the JSON. The GEG reference building, Anlage 1, is also included: wall 0.28, floor 0.35, roof 0.20, window 1.3 with g 0.60, door 1.8, ΔU_WB 0.05.

---

## C. Usage profiles

### Sources and checking
DIN V 18599-10:2018-09 is paywalled, and it is still the edition GEG cites. It has since been superseded by DIN/TS 18599-10:2025-10, which changes some values, e.g. 750 lx for offices and lecture halls; do not mix editions. The values come from two official secondary sources that reproduce the DIN tables:
- **DENA2023**: dena, *Leitfaden Energetische Gebäudebilanzierung nach DIN V 18599* (2023). https://www.dena.de/fileadmin/dena/Publikationen/PDFs/2023/LEITFADEN_ENERGETISCHE_GEBAEUDEBILANZIERUNG_NACH_DIN_V_18599.pdf
- **BBSR2023**: BBSR/FIB, *Leitfaden für Energiebedarfsausweise im Nichtwohnungsbau*, GEG 2023 edition. https://fib-bund.de/Inhalt/Leitfaden/Energieausweise/2023-09_Leitfaden-energiebedarfsausweise-nichtwohnungsbau-2023-dl.pdf

The research was delegated to a subagent. I re-read these tables in the downloaded PDFs myself:
- DENA2023 Tab. 6 (residential, printed p. 34), including the DHW formula on p. 35;
- DENA2023 Tab. 4 (persons and equipment gains);
- DENA2023 Tab. 5 (DHW);
- BBSR2023 Tab. 5-22 (seminar room, p. 118–119).

The remaining profile values (office times and ventilation, retail, classroom) were read by the subagent from DENA2023 Tab. 1–3 and BBSR2023 Tab. 5-5 and 5-13. I did not re-read those.

**How the gains are averaged.** Q_int [W/m²] = (q_I,p + q_I,fac) [Wh/(m²·d)] / daily usage hours, per usage day. These are the "mittel" occupancy values. Lighting is not part of the DIN gain table; the `Q_int_lighting` values are my estimates.

### residential
Verified, DIN V 18599-10:2018 Tab. 4 via DENA2023 Tab. 6. EFH means ≤2 dwellings; the area basis is NGF.

| parameter | value |
|---|---|
| usage | 0–24 h, 365 d |
| heating operation | 06–23 h (17 h) |
| reduced operation | 23–06 h (7 h); EFH switch-off, MFH set-back |
| set-back | 4 K |
| set points | heating 20 °C; cooling 25 °C if cooled |
| n_nutz | 0.5 1/h (0.45 1/h demand-controlled) |
| internal gains | 45 Wh/(m²·d) EFH, 90 Wh/(m²·d) MFH, i.e. 1.875 / 3.75 W/m² (`Q_intByType`) |
| co-heated share a_tb | 0.25 EFH, 0.15 MFH |
| DHW (2018 rule) | Q_w,b = max(16.5 − 0.05·A_NGF per dwelling; 8.5) kWh/(m²a) |

Notes:
- **DHW change since 2011.** The familiar 12 / 16 kWh/(m²a) are the *2011* values.
- **DHW defaults.** The JSON defaults (sfh 9.5, th 10.5, mfh 13.0, ab 13.5) assume 140 / 120 / 70 / 60 m² NGF per dwelling. Those sizes are estimates.
- **`Q_int` default = 3.0 W/m²** is the TABULA standard (IWU2015 p. 75, verified), chosen as a middle value. Prefer `Q_intByType` for DIN consistency.

The older EnEV path, DIN V 4108-6 / DIN V 4701-10, is given only for context. The subagent read it from IWU 2004 Tab. 7, the EnEV 2014 Anlage 1 consolidated text, and the Unipor/Himburg guides; I did not re-check it:
- θ_i 19 °C;
- q_i 5 W/m² per A_N;
- n 0.7 1/h (0.6 with tightness test);
- DHW 12.5 kWh/(m²a) per A_N.

### office (profile 1 Einzelbüro; profile 2 identical except lighting room factors)

| parameter | value |
|---|---|
| usage | 07–18 (11 h/d), 250 d/a (≈ 5 d/week) |
| heating/RLT | 05–18 (13 h) |
| set points | 21 °C heating / 24 °C cooling |
| set-back | 4 K outside operation |
| outdoor air | 4 m³/(h·m²); building minimum 2.5 |
| relative absence C_RLT / part-operation F_RLT | 0.3 / 0.7 |
| gains | persons 30 + equipment 43 Wh/(m²·d), i.e. 2.7 + 3.9 = 6.6 W/m² over 11 h |
| lighting | 500 lx |

- **Lighting (estimated).** LPD 8 W/m² for a modern installation. The BBSR LED guide's designed examples give 7.6 W/m² for LED and 10.6 for fluorescent, as reported by the subagent; the GEG reference-building tabular value is ≈20 W/m². Mean lighting gain ≈2.5 W/m² after absence and daylight, so `Q_int` ≈ 9.1 W/m².
- **`n_vent` = V_min·(1 − C_RLT)/3 m = 0.93 1/h**: an estimate of the occupancy-averaged rate. The consumer should use the actual clear height.
- **DHW: `dhw` = 0.** GEG Anlage 6 Nr. 1 (simplified method, office buildings) sets 0, verified in the GEG text. The DIN Tab. 7 alternative is 30 Wh/(m²·d) office area, i.e. 7.5 kWh/(m²a) (`dhwAlt`). DIN allows DHW to be neglected below 0.2 kWh/(person·d).
- **Open-plan variant** (profile 3): 102 Wh/(m²·d) → 9.3 W/m²; outdoor air 6 m³/(h·m²).

### education
Main profile = **profile 4 "Besprechung/Sitzungszimmer/Seminar"**. DIN assigns seminar rooms here, not to 8 or 9. Verified in BBSR2023 Tab. 5-22:

| parameter | value |
|---|---|
| usage | 07–18, 250 d/a |
| heating/RLT | 05–18 |
| set points | 21 / 24 °C |
| set-back | 4 K |
| outdoor air | 15 m³/(h·m²) (20 m³/(h·person)) |
| C_RLT / F_RLT | 0.5 / 0.5 |
| lighting | 500 lx |
| occupancy | 3 m²/person |
| gains | persons 23.3 W/m² × 4 h = 93; equipment 2 W/m² × 4 h = 8 Wh/(m²·d); i.e. 9.2 W/m² over 11 h, plus ≈2.5 W/m² lighting (estimated) |

Variants:
- **`lectureHall`** (profile 9, Hörsaal), only partly found. From DIN excerpts and secondary tools (baunormenlexikon, energie-m), unverified by me: 08–18, 150 d/a, 30 m³/(h·m²), 500 lx. Set points, gains and set-back are **estimated**: 21/24 °C, ≈18 W/m².
- **`classroom`** (profile 8, school), via BBSR2023 Tab. 5-5 as read by the subagent: 08–15 (7 h), 200 d/a, heating 06–15, 21/24 °C, 10 m³/(h·m²), 300 lx, gains 100 + 20 Wh/(m²·d) → 17.1 W/m². DHW 13 kWh/(m²a) from GEG Anlage 6 Nr. 6 (65 Wh/(m² NGF·d) × 200 d), verified.

A university building is a mix of profiles. The JSON does not invent a blend.

### classroom (profile 8 Klassenzimmer, Gruppenraum Kindergarten) — verified, added 2026-11-16
Used for buildings tagged `building=school|kindergarten` or `amenity=school|kindergarten` in OSM, and cadastral function
3065 (nursery); universities, colleges and the generic cadastral 3020 keep profile 4. Values from DIN V 18599-10:2018-09
Tab. 5 as reproduced in dena (2023), *Leitfaden Energetische Gebäudebilanzierung nach DIN V 18599*, Tab. 2–4, pp. 30–32:

| parameter | value |
|---|---|
| use | 08:00–15:00, 7 h/d, 200 d/a (the guide, p. 29: school holidays already allowed for) |
| heating | 9 h/d, 200 d/a |
| set points | 21 °C heating / 24 °C cooling, set-back 4 K |
| outdoor air | V_A 10 m³/(h·m²), building minimum V_A,Geb 2.5 |
| relative absence C_RLT / part-operation F_RLT | 0.25 / 0.9 |
| gains | persons 100 + equipment 20 Wh/(m²·d), i.e. 17.14 W/m² over 7 h |

- **Calendar.** The hourly schedule takes the Bavarian public holidays and the Bavarian school holidays by rule
  (`js/holidays.js`), about 188 school days a year; the profile's 200 is not enforced.
- **`n_vent` = V_A·(1 − C_RLT)/3 m = 2.5 1/h.**

### Ventilation of non-residential buildings with window ventilation (all profiles) — verified structure, 2026-11-16
DIN V 18599-2 sets the window air change from the usage-related minimum outdoor air of DIN V 18599-10, presence-
dependent (dena 2023, p. 32 and p. 134), and lets the infiltration count towards it: during use the windows add
Δn_win = n_nutz − n_inf − 0.1 on top of 0.1 h⁻¹, i.e. n_win = 0.1 + Δn_win (equation as reproduced in the support note
of a DIN V 18599 software vendor, Gl. 68/69); outside use 0.1 h⁻¹ remains. `js/rc5.js` and the EnergyPlus export
apply: during use the windows add max(0.1 h⁻¹ · V, n_vent · 3 m · A_N − n_inf · V), outside use 0.1 h⁻¹ · V, with V the
air volume 0.8 · V_e. Before 2026-11-16 the model added n_vent · V on top of the infiltration and kept 10 % of n_vent
outside use. The seasonal (outside-temperature) correction of DIN V 18599-2 is not applied: its equation was not
available.

### retail (profile 6 Einzelhandel/Kaufhaus)

| parameter | value |
|---|---|
| usage | 08–20 (12 h), 300 d/a (≈ 6 d/week) |
| heating | 06–20 |
| set points | 21 / 24 °C |
| set-back | 4 K |
| outdoor air | 4 m³/(h·m²) |
| C_RLT / F_RLT | 0.5 / 1 |
| lighting | 300 lx, kVB 1.5 |
| gains | persons 84 + equipment 24 Wh/(m²·d), i.e. 7.0 + 2.0 W/m² over 12 h (persons verified in DENA2023 Tab. 4) |

- **Lighting (estimated).** LPD 8 W/m², on during all opening hours, so `Q_int` ≈ 17 W/m².
- **DHW.** `dhw` = 0 per GEG Anlage 6 Nr. 4 (retail ≤1000 m²). DIN alternative: 10 Wh/(m²·d) sales area, i.e. 3.0 kWh/(m²a).
- **Food retail with refrigeration** (profile 7): equipment −170 Wh/(m²·d) with condensers outside the zone, +85 with condensers inside.

### Global defaults (`meta.defaults`)

| default | value | status | source |
|---|---|---|---|
| frameFrac | 0.30 | verified | TABULA sheets p. 87 and p. 100 |
| shadeWinter | 0.6 vertical / 0.8 horizontal | verified | TABULA F_sh (p. 75, p. 87) |
| F_W | 0.9 | verified | TABULA sheets |
| F_floor | 0.5 | verified as TABULA b_tr | TABULA sheets |
| F_roof (unheated attic) | 0.85 | derived | MFH_E sheet |
| shadeCtrl | 0.25 | estimated | GEG Anlage 5 uses F_C ≤ 0.30 as a condition |
| heatedFrac | 1.0 | estimated | — |

---

## D. Heating systems and carriers

### D.1 Seasonal efficiencies (`systems`)
**Basis.** η = useful heat delivered / final energy on net calorific value H_i, consistent with GEG/DIN V 18599. IWU 2015 gives "Energieaufwand für 1 kWh Wärme" on the H_s basis: "Bei Brennstoffen beziehen sich diese Angaben auf den oberen Heizwert (Brennwert)" (§5.2, text under Bild 10). I converted with H_s/H_i = 1.11 (gas), 1.06 (oil) and 1.08 (wood). These are the usual tabulated ratios; I did not re-verify them in DIN V 18599-1.

| key | η default (range) | basis |
|---|---|---|
| gas_cond | 0.92 (0.85–0.98) | IWU sheets, condensing + minimised losses: 1.10–1.13 kWh_Hs/kWh, i.e. ≈1.0 kWh_Hi/kWh. The default is lowered for typical existing distribution. **estimated** |
| gas_old | 0.80 (0.70–0.90) | IWU sheets "Ist-Zustand", low-temperature boiler with high distribution losses: 1.21–1.54 kWh_Hs (median 1.38 → η ≈ 0.80). MFH_E generator e_g = 1.23 (p. 88). **estimated** (derived) |
| oil | 0.80 (0.70–0.92) | IWU EFH_E/MFH_E variant 2: LT oil boiler 1.35–1.40 kWh_Hs (η 0.76–0.79); oil condensing 1.17–1.18 kWh_Hs (η ≈ 0.90). **estimated** (derived) |
| district | 0.95 (0.90–0.99) | substation and in-house distribution only. **estimated** |
| hp_air, hp_ground | 0.95 (distribution multiplier) | COP from `hpModel`. `spf` from ISE2025: air/water mean 3.4 (2.6–4.9), ground 4.3 (3.6–5.4), 77 heat pumps in existing 1–3-family houses. The predecessor project WPsmart im Bestand gave 3.1 / 4.1. **estimated** (field data verified) |
| pellet | 0.80 (0.70–0.88) | IWU MFH variant 3 MP2: 1.33 kWh_Hs (η ≈ 0.81). **estimated** (derived) |
| electric | 1.00 (0.95–1.0) | IWU EFH_E/MFH_E variant 3, night-storage heaters: 0.99–1.00. **verified** |

The IWU 2015 heat-pump sheets (EFH_E MP1: 0.56 kWh electricity per kWh heat) are based on the conservative 2005 KVEP tables. They were **not** used, because they are far below measured field SPFs.

Boiler stock context, IWU2010 Tab. 5.7-3: in 2010, 40.7 % of gas boilers and 6.1 % of oil boilers were condensing. Of those installed since 2007, 88.5 % (gas) and 53.1 % (oil) were condensing.

### D.2 Carriers (`carriers`) — verified (GEG Anlage 4 and Anlage 9 Nr. 3)

| carrier | f_p,ne | CO2-eq g/kWh |
|---|---|---|
| heating oil | 1.1 | 310 |
| natural gas | 1.1 | 240 |
| LPG | 1.1 | 270 |
| wood | 0.2 | 20 |
| grid electricity | 1.8 | 560 |
| on-site PV/wind electricity | 0.0 | 0 |

**District heating.** GEG Anlage 4 has **no generic district-heating factor**. §22(2)–(4) say to use the supplier's certified value (minimum 0.3, with an RE/waste-heat bonus per §22(3)), or otherwise the value tabulated in the calculation method. I put f_p = 0.7 as a generic default: it is the DIN V 18599-1 value for fossil CHP district heat as I remember it, not verified, hence `estimated: true`. The CO2 options are verified, from Anlage 9 Nr. 3.20–3.25:

| district heat source | g/kWh |
|---|---|
| CHP ≥70 %, coal | 300 |
| CHP ≥70 %, gas/liquid | 180 |
| CHP ≥70 %, renewable | 40 |
| heating plant, coal | 400 |
| heating plant, gas/liquid | 300 |
| heating plant, renewable | 60 |
| waste incineration | 20 |

The JSON default is 180. For Munich, use `munich.districtHeating` (§F).

A large heat pump in a network uses f_p 1.2 for its electricity (§22(2)).

### D.3 Heat-pump COP model (`hpModel`) — estimated, from cited parameters
- COP = η_C · T_sink / (T_sink − T_source), temperatures in K.
- Carnot quality grade η_C: air 0.40, brine/ground 0.55, groundwater 0.50. From the oemof-thermal docs, which cite the VDE ETG study "Potenziale für Strom im Wärmemarkt bis 2050" (2015); I did not open the VDE PDF myself.
- Supply temperatures:
  - Floor heating 35 °C and radiators 55 °C: the maximum distribution temperatures of the IWU K/L heat-pump variants (IWU 2015 Tab. 23, p. 126). **verified** as IWU design values.
  - Old radiator systems 70 °C: estimated.
- Heating curve: linear between design conditions and the heating limit. Munich design outdoor temperature ≈ −16 °C; estimated, DIN/TS 12831-1 not checked.
- **Sanity check:** with these numbers a Munich house should land near the Fraunhofer field means of 3.4 (air) and 4.3 (ground). Calibrate η_C if not.

---

## E. Energy performance classes and reference area — verified
- **`classes`** — GEG Anlage 10 (zu § 86): A+ ≤30, A ≤50, B ≤75, C ≤100, D ≤130, E ≤160, F ≤200, G ≤250, H >250 kWh/(m²·a) **final energy** per m² Gebäudenutzfläche. §86(2): the class follows directly from final-energy demand or consumption.
- **`referenceArea`**:
  - GEG §25(10): A_N per DIN V 18599-1:2018-09 Gl. 30; Gl. 31 if the mean storey height (floor to floor) is >3 m or <2.5 m.
  - The formulas A_N = 0.32 m⁻¹·V_e and A_N = (1/h_G − 0.04 m⁻¹)·V_e are verified from DIBt Auslegung XIX-4, which quotes EnEV 2013 Anlage 1 Nr. 1.3.3, the source of the DIN equations. DIBt also rules that top attic storeys are excluded from the h_G average.
  - Consumption certificates only, GEG §82(2): if A_N is unknown, A_N = 1.2 × living area, or 1.35 × living area for buildings with ≤2 dwellings and a heated basement. Decentral DHW adds a flat 20 kWh/(m²a), and cooling adds 6 kWh/(m²a).
- IWU/TABULA energy figures use the conditioned net floor area A_C,ref (≈ NGF), not A_N. The example buildings list both (`exampleBuilding.A_C_ref`, `A_N`); e.g. EFH_E has A_C,ref 121.2 m² and A_N 160.9 m².

---

## F. Munich
The SWM numbers come from a delegated web-research subagent. That agent opened the three SWM PDFs itself and reported the values below; I did not re-open them.

| item | value | status | source |
|---|---|---|---|
| network | Wärmeverbundnetz München Stadt, Martinsried, Unterföhring und Region Süd (SWM Versorgungs GmbH) | verified | |
| f_p per GEG §22(2)/(3), "nach GEG zu verwenden" | 0.29 | verified | https://www.swm.de/dam/doc/geschaeftskunden/fernwaerme/2025/zertifikat-geg-waermeverbundnetz-muc-stadt-martinsried-unterfoehring-region-sued.pdf |
| CO2 per GEG Anlage 9 Nr. 1c (FW 309-1) | 0.0 g/kWh | verified | same |
| f_p, Carnot method (FW 309-6) | 0.56 | verified | https://www.swm.de/dam/doc/geschaeftskunden/fernwaerme/2025/zertifikat-carnot-waermeverbundnetz-muc-stadt-martinsried-unterfoehring-region-sued.pdf |
| CO2, Carnot method incl. upstream | 119.1 g/kWh | verified | same |
| 2025 mix | gas 66.7 %, waste incineration 19.9 %, geothermal 11.1 %, biomass 2.1 %; CHP 78.4 %; RE + waste heat 33.2 %; 4,872,504 MWh | verified | https://www.swm.de/dam/doc/geschaeftskunden/fernwaerme/2025/2025-zertifizierung-waermelieferung-muc-stadt-martinsried-unterfoehring-region-sued.pdf |
| validity | data 2025, issued 22.06.2026, valid to 21.06.2029 | verified | |
| Riem network | f_p 0.40, 87.2 g/kWh | unverified (search snippet) | https://www.swm.de/dam/doc/geschaeftskunden/fernwaerme/2025/zertifikat-geg-waermenetz-riem.pdf |
| district-heating share of Munich heat demand | ≈30 % | **estimated / secondary** (press summary of the 2024 municipal heat plan, not an official document) | |
| heat-plan target 2045 | 62 % of households on district heating, 33 % on heat pumps | unverified secondary | |

**Recommendation.** For CO2 use 119 g/kWh. The GEG value of 0 g/kWh is an allocation artefact: the CHP fuel is credited to electricity. For a "certificate-style" primary energy use f_p = 0.29.

I found no Munich-specific Zensus 2022 breakdown by heating type or construction year. It can be queried at ergebnisse.zensus2022.de for Gemeinde München.

---

## G. Modernisation priors (`modernisation`)

**Event definitions** (Germany-wide, all residential buildings):
- wall/roof/floor: at least part of the element insulated after construction;
- windows: window installation year ≥1995, i.e. low-e glazing;
- heating: main heat generator replaced at least once.

### What was measured (IWU2018, survey of >10,000 owners, state end of 2016)
**Wall, roof and floor — verified.** Source is IWU2018 Tab. 18, "Nachträgliche Wärmedämmung nach Baualtersklassen".

| period | wall: buildings / area | roof: buildings / area | floor: buildings / area |
|---|---|---|---|
| ≤1948 | 40.7 % / 29.6 % | 68.0 % / 61.2 % | 21.8 % / 17.5 % |
| 1949–57 | 42.1 % / 32.9 % | 67.6 % / 60.9 % | 18.6 % / 14.9 % |
| 1958–68 | 41.1 % / 29.6 % | 62.2 % / 56.1 % | 16.2 % / 13.0 % |
| 1969–78 | 26.7 % / 20.2 % | 43.9 % / 39.5 % | 11.5 % / 9.2 % |
| 1979–94 | 11.8 % / 9.9 % | 21.1 % / 19.0 % | 5.9 % / 4.7 % |
| ≥1995 | 2.8 % / 2.2 % | 4.0 % / 3.6 % | 1.9 % / 1.5 % |

The standard errors (±1–4 points) are stored in the JSON.

**Windows:**
- Up to 1978 — verified, IWU2018 Tab. 39: 57.2 % of buildings have windows from 1995 or later (1.4 % single, 49.7 % double, 6.1 % triple glazing).
- No age-class breakdown exists beyond that. For 1979–94 I estimate 0.22, from the all-building share of 60.2 % and the stock mix; for ≥1995, 0.03. Both **estimated**.

**Partial area.** If modernised, the insulated fraction of the element for buildings up to 1978 is: wall 73.9 %, roof 90.1 %, floor 80.1 % (IWU2018 Tab. 15).

**Regional differences.** IWU2018 Tab. 19 and 20 show them to be small (in percentage points). For "alte Bundesländer Süd" (incl. Bayern) the area shares are 25.4 / 53.4 / 14.4 %, against a German average of 27.8 / 54.9 / 14.2 %. So no Munich adjustment was made.

**Heating — estimated.**
- Main-generator renewal rate 2010–2016: 3.27 %/a (≤1978), 2.69 %/a (1979–2009), 2.64 %/a in the old Länder South (IWU2018 Tab. 54).
- In 2010 only 6.6 % of gas and 16.3 % of oil boilers dated from before 1987 (IWU2010 Tab. 5.7-2).
- Hence the estimates: 0.98 (≤1968), 0.97 (1969–78), 0.90 (1979–94), 0.55 (≥1995).

### Projection to 2026 (the JSON's main fields) — estimated
- p2026 = p2016 + (1 − p2016)·(1 − (1 − r)¹⁰).
- r is the annual share of buildings with a measure in 2010–2016 (IWU2018 Tab. 43, not area-weighted). For buildings up to 1978: wall 1.51 %, roof 2.52 %, floor 0.67 %, windows 4.39 %. For 1979–94 the all-building rates (1.05 / 1.69 / 0.46 / 3.33 %) are used, and half of those for ≥1995.
- `*Range` = [p2016, min(0.95, p2016 + 10·r)].
- Activity after 2016 was not measured: subsidies rose after 2020 and activity slumped in 2024. Use the ranges as prior width, or use `measured2016` if you prefer only measured data.

### Typical U after past modernisation (`typicalUAfter`) — estimated (derived)
Mean post-construction insulation thickness for buildings up to 1978:
- wall 9.0 cm (IWU2018 Tab. 33);
- roof/top ceiling 13.3 cm (Tab. 35);
- floor 7.7 cm (Tab. 38).

Using U = 1/(1/U0 + d/λ) with λ = 0.035 W/(mK) (roof λ_eff 0.045 for rafters) and U0 = 1.4 / 1.0 / 1.2 gives wall ≈0.30, roof ≈0.25, floor ≈0.33. For windows: IWU2022 Tab. 3 gives mean window U 2016 of 2.11 (EZFH) and 2.04 (MFH) at 54 % / 60 % modernised share and 2.7 unmodernised, which implies U ≈ 1.6 for modernised windows; the JSON uses 1.5. Past retrofits are thus weaker than the TABULA usual package.

---

## H. Zensus 2022 → TABULA (`zensusMap`)
- **Rule.** Each Zensus construction-year class is split over the overlapping TABULA classes in proportion to the number of years. For example, 1949–1978 → D 9/30, E 11/30, F 10/30; 2001–2010 → I 1/10, J 8/10, K 1/10.
- **"<1919"** — estimated as A 0.10, B 0.90.
  - Germany-wide, IWU2015 Tab. 4 (Zensus 2011) puts class A at 22 % of pre-1919 residential buildings, 15 % of their dwellings and 17 % of their living area.
  - Munich's pre-1919 stock is dominated by the Gründerzeit expansion, and much of the older core was destroyed in WWII. So A is lower; plausible range 0.03–0.20.
- Within-class weights are uniform in time. Construction activity was not uniform (the 1960s–70s boom), so weights by actual completions would shift 1949–1978 towards E/F. Not done here.

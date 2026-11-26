# archetypes_sg.json: sources and verification status

Compiled 2026-11-25 for the Singapore version of Open Energy Map (branch `singapore`), following
`docs/singapore-contract.md` §3–4 and the semantics of `js/rc5.js` as committed on 2026-11-25. Every value in
`archetypes_sg.json` is `{ value, p10, p90, source, tier }`:

- **observed**: computed from measured or reported data of Singapore buildings or households (BCA building records,
  SingStat surveys, EMA statistics, field studies). I opened the data and computed the statistic myself, or read the
  number in the table.
- **published_table**: read from a code, standard or official table (BCA codes, Green Mark, NEA labels, SS 553 as
  reproduced by NEA, ISO 13790 classes).
- **assumed**: my judgement, or a derivation that needs at least one assumed input. The `rule` field states the
  derivation. Ranges of assumed values are deliberately wide.

Two research subagents read part of the residential and HDB material. I re-read the key numbers in the saved files:
HES ownership (Table Builder JSON), Census household size, EMA Table 3.5 and 2.3 extracts, the HDB precast guide
(2.8 m, 150 mm façade), the BTO brochures (tinted glass, roof, walls), the HDB green-bond annex (Green Mark 2014),
the HDB 2017 press release (precast since the 1980s, PPVC), the SUTD report (52.7 %), Wong et al. 2002 (1,600 ppm,
23–28 °C at 22 °C setting), Feriadi et al. 2002 (Table 1) and the Tampines Town Council accounts. Items I could not
re-read are marked as secondary in the text.

## Choices made where the brief left room

1. **COP_cool of central plants is the total system** (chillers, pumps, cooling towers and AHU/FCU fans; Green Mark's
   TSE), because rc5 has no fan term. AHU/FCU fans are therefore not in `P_equip` or `E_other`. `COP_plant` is given
   for a model that wants to book the fans elsewhere. District cooling is the building meter only (air side).
2. **Reference area.** Non-residential values are per m² GFA (the BCA EUI basis); residential values per m² of
   dwelling floor area (HDB resale `floor_area_sqm`). `areaBasis` and `refAreaFactor` give the conversion; see
   `meta.schemaNotes`.
3. **Residential coolFrac includes AC ownership and use**: coolFrac = acOwnership × acUseShare × 0.8 × bedroomShare.
4. **Residential Q_lat is a 24-h mean per m² of reference area** (coordinator's request); the sleepers' gains per m² of
   cooled bedroom are given separately (`Q_int_acZone`, `Q_lat_acZone`).
5. **Residential non-cooling end uses are anchored on EMA 2017**, the year of NEA's metered household study, so the
   residential validation must use other years or planning areas.
6. **Eras.** HDB: five eras by completion year at documented construction changes. Non-residential: four eras at the
   envelope rule changes (1979, 2008, 2021). Condos: before and after RETV (2008).

## Main sources

| id | reference | url | file in `~/EnergyMapData/sg/docs/` |
|---|---|---|---|
| BCA_ENV2008 | BCA: Code on Envelope Thermal Performance for Buildings (ETTV, RTTV, RETV, roof U limits), Jan 2008 (file "Envelope Code - Jan 2008 R3b"), 84 pp. | https://file.go.gov.sg/bca-envl-therm-code.pdf | bca-envl-therm-code.pdf |
| BCA_ESC4 | BCA: Code for Environmental Sustainability of Buildings, Edition 4.0, September 2021 (minimum standard under the Building Control (Environmental Sustainability) Regulations 2008). | https://isomer-user-content.by.gov.sg/338/e10c055b-7b54-4405-852b-fa3f661af697/es-code_reg-2008_edition-4-0.pdf | es-code_reg-2008_edition-4-0.pdf |
| BCA_EMG2024 | BCA: Green Mark 2021 Energy Modelling Guidelines, R2 (effective 1 Jan 2024). | https://isomer-user-content.by.gov.sg/338/1631faa3-e215-478c-8016-4076f3ffd65b/20240101_energymodellingguideline_r2.pdf | 20240101_energymodellingguideline_r2.pdf |
| BCA_ETG2024 | BCA: Green Mark 2021 Energy Efficiency Section, Technical Guide R2.1 (19 Nov 2024). | https://isomer-user-content.by.gov.sg/338/2da76077-68c5-49b6-8c16-64332df8db2f/20241119_energy-technical-guide_r2-1.pdf | 20241119_energy-technical-guide_r2-1.pdf |
| BCA_BEBR2023 | BCA: Building Energy Benchmarking Report (Statistics and Figures) 2023 (2022 electricity, 1,058 buildings). | https://www1.bca.gov.sg/docs/default-source/docs-corp-buildsg/sustainability/bca-building-energy-benchmarking-report-2023.pdf (retrieved via web.archive.org) | bca-building-energy-benchmarking-report-2023.pdf |
| BCA_BEBRDATA | BCA: Building Energy Benchmarking Report and Building Energy Performance Data (XLSX; sheet "Dataset", 995 buildings, EUI 2022–2025, GUI 2023–2025, AC system, AC floor area, chiller year, plant and air-side kW/RT). Retrieved 2026-11-25. | https://go.gov.sg/bca-bebr-data | bca-bebr-data.xlsx |
| BCA_SLE | BCA: Super Low Energy Building Technology Roadmap, Figure 3 "Typical Office Building Energy Usages" (printed p. 6). | https://www1.bca.gov.sg/docs/default-source/docs-corp-buildsg/digitalisation/sle_tech_roadmap_report.pdf (retrieved via web.archive.org) | bca-sle-technology-roadmap.pdf |
| NEA_ACMV | NEA: Singapore Certified Energy Manager (SCEM) programme, Air-Conditioning and Mechanical Ventilation (ACMV) Systems (reproduces SS 553 and SS 530:2014 values). | https://www.nea.gov.sg/docs/default-source/cmd-documents/energy-efficiency/industrial-sector/scem/acmv.pdf | nea-scem-acmv.pdf |
| SS553_2026P | Enterprise Singapore: SS 553:2026 Code of practice for air-conditioning and mechanical ventilation in buildings, free preview (foreword lists the changes). | https://www.singaporestandardseshop.sg/Product/SSPdtDetail/c417dc9a-0cca-4562-a19e-b076c9a4957e | ss553-2026-preview.pdf |
| NEA_MEPS | NEA: Minimum Energy Performance Standards (household sector web page), accessed 2026-11-25. | https://www.nea.gov.sg/our-services/climate-change-energy-efficiency/energy-efficiency/household-sector/minimum-energy-performance-standards | – |
| NEA_TICK | NEA: Tick Rating (household sector web page), accessed 2026-11-25. | https://www.nea.gov.sg/our-services/climate-change-energy-efficiency/energy-efficiency/household-sector/tick-rating | – |
| NEA_LABEL | NEA: The Energy Label (household sector web page; label assumptions 8 h/day use for single-phase air conditioners), accessed 2026-11-25. | https://www.nea.gov.sg/our-services/climate-change-energy-efficiency/energy-efficiency/household-sector/the-energy-label | – |
| NEA_MEPS2021 | NEA news release, 8 June 2021: NEA to enhance Minimum Energy Performance Standards (MEPS) for refrigerators, clothes dryers and air-conditioners (effective 1 Jan 2022). | https://www.nea.gov.sg/media/news/news/index/nea-to-enhance-minimum-energy-performance-standards-(meps)-for-refrigerators-clothes-dryers-and-air-conditioners | – |
| MOE2019 | MOE press release, 15 Aug 2018: School terms and holidays for 2019. | https://moe.gov.sg/news/press-releases/20180815-school-terms-and-holidays-for-2019 | – |
| ISO13790 | ISO 13790:2008 Table 12 (effective mass classes: very light 80, light 110, medium 165, heavy 260, very heavy 370 kJ/(m²K)), as implemented in js/rc5.js amFactor. | – | – |
| HES2023 | SingStat: Household Expenditure Survey 2023, Table Builder 18013 "Resident Households with Specified Consumer Durables/Services by Type of Dwelling" (also TB18081 HES 2017/18, TB18103 HES 2012/13; Report on the HES 2023, Chart 5.8). | https://tablebuilder.singstat.gov.sg/table/CT/18013 | singstat/tablebuilder_18013.json; tablebuilder_18081.json; tablebuilder_18103.json; hes2023_report_singstat_via_zbw.pdf |
| CENSUS2020 | SingStat: Census of Population 2020, Statistical Release 2 (Households, Geographic Distribution, Transport and Difficulty in Basic Activities), Table 1 and Chart 2.2; average household size by dwelling type from Table Builder 17863. | https://tablebuilder.singstat.gov.sg/table/CT/17863 | singstat/census2020_SR2_households_housing.pdf; tablebuilder_17863.json; tablebuilder_17472.json |
| EMA_SES | EMA: Singapore Energy Statistics 2026, Table 2.3 (grid emission factor 2005–2025) and Table 3.5 (average monthly household electricity by dwelling type, per account). | https://www.ema.gov.sg/content/dam/corporate/resources/singapore-energy-statistics/excel/SES_tabular.xlsx.coredownload.xlsx | ema/SES2026_T2.3_grid_emission_factor_2005_2025.csv; ema/SES2026_T3.5_national_avg_monthly_household_kwh_by_dwelling.csv |
| NEA_HECS2017 | NEA press release, 5 May 2018: "Four in five households motivated to save energy if they can save money" (Household Energy Consumption Study 2017, 550 households metered for one week) and its Annex A infographic. | https://www.nea.gov.sg/media/news/news/index/four-in-five-households-motivated-to-save-energy-if-they-can-save-money-nea-study | – |
| HDB_PRECAST | BCA/HDB: HDB Precast Pictorial Guide (2014), §1.5 (floor-to-floor heights) and Fig. 2A (component thicknesses). | https://bca.gov.sg/publications/BuildabilitySeries/others/HDB_Precast_pictorial_guide_BCA.PDF | hdb/bca_hdb_precast_pictorial_guide.pdf |
| HDB_BTO2024 | HDB sales brochures Teban Breeze (BTO June 2024) and Teban Heights (BTO Oct 2025): floor areas and "Specifications for Building Materials". | https://assets.hdb.gov.sg/residential/buying-a-flat/finding-a-flat/sales-brochure/25OCTBTO_pdf_selection/teban_heights.pdf | hdb/bto_brochure_24JUN_teban_breeze.pdf; hdb/bto_brochure_25OCT_teban_heights.pdf |
| HDB_RESALE | HDB via data.gov.sg: Resale flat prices based on registration date from Jan-2017 onwards (d_8b84c4ee58e3cfc0ece0d773c8ca6abc), 245,642 transactions to Nov 2026; floor_area_sqm by flat_type and lease_commence_date. Statistics computed for this table (scratch script). | https://data.gov.sg/datasets/d_8b84c4ee58e3cfc0ece0d773c8ca6abc/view | – |
| HDB2017PR | HDB press release, 6 Sep 2017: New Initiatives to Boost Construction Productivity in HDB Projects (precast since the 1980s; PBU; PPVC pilot). | https://www.nas.gov.sg/archivesonline/data/pdfdoc/20170906007/Embargoed%20till%206%20Sep%2017_8pm_Press%20Release_HDB%20Construction%20Productivity.pdf | hdb/hdb_pr_20170906_construction_productivity.pdf |
| HDB2022GB | HDB press release annex, 16 Mar 2022 (green bond): Green Mark Gold for all new developments from 2014, GoldPLUS later; solar since 2008, SolarNova 2015. | – | hdb/hdb_pr_20220316_green_bond_annex.pdf |
| HDB2025ANNEX | HDB press release annex, 3 Feb 2025 (Green Towns Programme: cool coatings, lift energy regeneration, smart LED lighting, sub-meters). | – | hdb/hdb_pr_20250203_cool_coatings_annex.pdf |
| HDB_AR2025 | HDB Annual Report 2024/25 (solar status p36). | https://www.hdb.gov.sg/-/media/hdb-pulse/reports/annual-reports-and-financial-statements/HDB_AR2025.pdf | hdb/HDB_AR2025.pdf |
| HDB_AR2122 | HDB Annual Report 2021/22 (solar and common-area energy, p13). | – | hdb/HDB_AR_FY21.pdf |
| HDB_KEYSTATS | HDB Key Statistics 2025/26 (dwelling units by town, p11; 2-room Flexi 46 m², p22). | – | hdb/HDB-KeyStats-2026.pdf |
| CLC2015 | Centre for Liveable Cities (2015): Built by Singapore: From Slums to a Sustainable Built Environment, Urban Systems Studies. | https://clc.gov.sg/docs/default-source/urban-systems-studies/uss-built-by-singapore.pdf | hdb/clc_uss_built_by_singapore.pdf |
| ISARC2000 | Ting, S.K.; Jin, H.F. (2000): Prefabrication in the Singapore construction industry. ISARC 2000, paper 066 (conference paper). | https://www.iaarc.org/publications/fulltext/isarc2000-066_WB2.pdf | papers/isarc2000_066_singapore_precast.pdf |
| BCA_DFMA2020 | BCA: Factsheet on Design for Manufacturing and Assembly (DfMA), Annex B, March 2020. | https://isomer-user-content.by.gov.sg/338/5af1f7e8-f086-466c-b8db-5ba6a00df72b/annex-b.pdf | bca/bca_2020-03_annexB_DfMA_factsheet.pdf |
| DENG2022 | Deng, J.-Y.; Wong, N.H. et al. (2022): Indoor Thermal Environment in Different Generations of Naturally Ventilated Public Residential Buildings in Singapore. Atmosphere 13(12):2118, doi:10.3390/atmos13122118 (simulation study). | https://doi.org/10.3390/atmos13122118 | papers/deng2022_atmosphere_13_2118_HDB_generations.pdf |
| SUTD2026 | SUTD Lee Kuan Yew Centre for Innovative Cities (2026): Towards a Climate Resilient Citizenry, WG1 Technical Report (416 HDB households; research report, not peer-reviewed). | https://www.sutd.edu.sg/lkycic/wp-content/uploads/sites/16/2026/05/CRC-WG1-Technical-Report_Final.pdf | papers/sutd_lkycic_CRC_WG1_technical_report_2026.pdf |
| HAPPLE2017 | Happle, G.; Wilhelm, E.; Fonseca, J.A.; Schlueter, A. (2017): Determining air-conditioning usage patterns in Singapore from distributed, portable sensors. Energy Procedia 122:313–318, doi:10.1016/j.egypro.2017.07.328. | https://doi.org/10.3929/ethz-b-000185718 | papers/Happle2017_EnergyProcedia_AC_usage_SG.pdf |
| CHUA2010 | Chua, K.J.; Chou, S.K. (2010): Energy performance of residential buildings in Singapore. Energy 35(2):667–678, doi:10.1016/j.energy.2009.10.039 (paywalled; cited via HAPPLE2017). | https://doi.org/10.1016/j.energy.2009.10.039 | – |
| YANG2017 | Yang, B.; Olofsson, T. (2017): Indoor Built Environ 26(1):21–31, doi:10.1177/1420326X15604206 (229 questionnaires; abstract and HAPPLE2017 citation only). | https://doi.org/10.1177/1420326X15604206 | – |
| WONG2002 | Wong, N.H.; Huang, B.; Tham, K.W.; Sekhar, S.C.; Cheong, K.W.D. (2002): IAQ in air-conditioned and naturally ventilated bedrooms of HDB flats. Proceedings Indoor Air 2002, p. 486 (journal version Build Environ 39(9):1115, doi:10.1016/j.buildenv.2004.01.024). | – | papers/Wong2002_IndoorAir_IAQ_bedrooms_SG_CIB7451.pdf |
| FERIADI2002 | Feriadi, H.; Wong, N.H.; Sekhar, S.C.; Cheong, K.W.D.; Tham, K.W. (2002): Thermal comfort in naturally ventilated houses (Singapore and Indonesia). Proceedings Indoor Air 2002, Table 1. | – | papers/Feriadi2002_IndoorAir_NV_housing_SG_ID_CIB7768.pdf |
| TAMPINES_TC | Tampines Town Council: Annual Report FY2023/24, Income and Expenditure Statement ("Water and electricity" S$10,450,044). | – | towncouncil/tampines_tc_annual_report_FY2023-24.pdf |
| PUB2022 | PUB: Handbook on Application for Water Supply (2022), §2.2. | – | pub/pub_handbook_application_water_supply_2022.pdf |
| URA_DC | URA Development Control handbook: Flats/Condominiums building height (storey heights for computing height); Commercial building height (maximum floor-to-floor 5 m). | https://www.ura.gov.sg/Corporate/Guidelines/Development-Control | ura/ura_dc_summary_flats_condominiums_v2.pdf; ura/ura_dc_summary_commercial.pdf |
| URA_LANDED | URA circular URA/PB/2015/02-DCG (11 Feb 2015): landed housing design flexibility. | – | ura/ura_dc19-08_landed_design_flexibility.pdf |
| BRUELISAUER2014 | Bruelisauer, M. et al. (2014): Stuck in a stack – Temperature measurements of the microclimate around split type condenser units in a high rise building in Singapore. Energy and Buildings 71:28–37, doi:10.1016/j.enbuild.2013.11.056 (not re-read). | https://doi.org/10.1016/j.enbuild.2013.11.056 | – |
| MSE_GO25 | Ministry of Sustainability and the Environment, news release 16 May 2025: Launch of Go 25 National Movement (indoor air-conditioning at or above 25 °C for homes, offices and buildings; "providing alternatives such as fans"; up to 12 % saving per degree from 23 to 25 °C in offices, Ngee Ann Polytechnic CfES study). Read 2026-11-26. | https://www.mse.gov.sg/latest-news/launch-of-go25-national-movement/ | – |
| NEA_HOME2016 | NEA: Resource Efficiency Guide for New Home Owners (PDF of 25 Jan 2016), p. 4 ("Install fans to keep cool"; "Ceiling fans are more effective than standing fans"; curtains, blinds or solar window films). No fan wattage is given. Read 2026-11-26. | https://www.nea.gov.sg/docs/default-source/default-document-library/resource-efficiency-guide-for-homeowners.pdf | nea/nea_resource_efficiency_guide_new_home_owners_2016.pdf |
---

## A. Residential envelope

### A.1 HDB eras (`types.hdb.eras`, by completion year)
The eras follow the documented changes in HDB construction:

| era | years | evidence |
|---|---|---|
| hdb_1960_1979 | to 1979 | cast in-situ method in the 1960s (CLC2015 PDF p. 28–29); HDB brick factory 1972–1998, closed "due to the increasing use of precast" (PDF p. 19) |
| hdb_1980_1989 | 1980–1989 | first prefabrication contracts for 3- and 4-room flats in Hougang, Tampines, Yishun (CLC2015 PDF p. 28–29); precast "since the 1980s" (HDB2017PR p. 2) |
| hdb_1990_1999 | 1990–1999 | precast level of the public sector 28 % in 1998 (ISARC2000 p. 4, conference paper) |
| hdb_2000_2013 | 2000–2013 | standard precast components: main façade 150 mm, bathroom/corridor/service-yard façade 100 mm, gable end ≥ 175 mm, infill 100/120 mm (HDB_PRECAST Fig. 2A, PDF p. 10); RETV for residential from 2008 (BCA_ENV2008 §3.5) |
| hdb_2014_plus | 2014– | Green Mark Gold for all new developments from 2014, GoldPLUS later (HDB2022GB p. 2); prefabricated bathroom units piloted at Fernvale Lea (completed Jan 2016) and PPVC piloted at Valley Spring @ Yishun (2017), target 35 % of projects by 2019 (HDB2017PR p. 1–4); PPVC 30 % and APCS 45 % of 2020 launches (BCA_DFMA2020 p. 1) |

PPVC is a construction method, not an envelope change: the modules are concrete, so it does not change the U-values
here. I found no PPVC share after 2020.

**Walls.** HDB publishes no U-values. U-values follow from the component thicknesses with the Code's k-values (§C.3):
150 mm precast 3.27 (the Code's own residential example E1.4(d) gets the same 3.27), 100 mm panels 3.69, plastered
115 mm brick 2.76, 230 mm brick 1.98. The 1960s–70s brick infill is my reading of the CLC history (cast in-situ frames
and HDB's own brick production); I found no HDB document that states it. Current brochures list "reinforced concrete/
precast panels/ drywall partition system/ precast lightweight concrete partitions" (HDB_BTO2024, PDF p. 15–16 of
Teban Heights).

**Windows.** Current brochures: "Aluminium framed windows with tinted glass". No glazing g or low-e specification was
found. DENG2022 (a simulation) assumes 8 mm grey glass, SHGC 0.71, U 5.5; I use 0.71 as p90 of the 2014+ era and 0.60
as value (tinted). Older eras use clear or tinted single glazing, g 0.70–0.72 (assumed). RETV hardly constrains HDB
glazing: with WWR 0.25, U_w 3.27 and U_f 5.8 the RETV of 25 W/m² allows SC up to 0.98 (derived, §C.2), and the
deemed-to-satisfy rule (WWR < 0.3, SC < 0.7; BCA_ENV2008 §10.1) allows g up to 0.61.

**Roof.** "Reinforced concrete roof slab with precast concrete secondary roofing" (HDB_BTO2024); insulation is not
specified. The uninsulated slab is 2.41 W/(m²K) (§C.3). A ventilated secondary roof shades the slab, which rc5 does not
model, so older eras use 2.0 (1.2–2.6) and later eras the residential roof limits (heavy roof ≤ 1.5, BCA_ESC4 RB01-2):
1.6 for 2000–2013 and 1.2 for 2014 onwards (`assumed`).

**Floor.** The lowest flats sit over an open void deck: 150 mm RC with screed and tiles gives 2.60 W/(m²K) with
F_floor 1.0 (the void deck is outside air).

**Storey height.** HDB_PRECAST §1.5 (PDF p. 6): "typical floor-to-floor height shall be 2.8m", 3.6 m from the first to
the second storey, 2.8 m for the top floor. DENG2022 Table 2 gives the 7th-storey level of its 1970s and 1980s blocks as
17.1 m, i.e. 3.6 m + 5 × 2.7 m, and of its 1990s block as 23.2 m at the 9th storey, i.e. 3.6 + 7 × 2.8 m. So the two
oldest eras use 2.7 m (derived) and the later ones 2.8 m (published). Level 1 is usually a void deck without flats.

**Mass, air tightness, frames.** Cm heavy, 260 kJ/(m²K) (ISO 13790 class; concrete slabs and walls). n50 has no
Singapore source and is `assumed` 10 (5–20) for the two oldest eras, 8 (4–15) for 1990–2013 and 6 (3–12) for 2014
onwards. Frame fraction 0.20 (0.12–0.30) assumed.

### A.2 Condominiums and landed houses
No official construction statistics were found. Condo walls 2.6 (1.9–3.3) and landed walls 2.4 (1.9–3.0) are derived
from the Code k-values for lightweight block, brick and RC. Condo glazing after 2008 is limited by RETV: g = 0.87 ×
SC_max at RETV 25 W/m² and WWR 0.35 gives 0.65 (p90), RETV 22 (BCA_ESC4, 2021) at WWR 0.45 gives 0.42 (p10), value 0.52.
Condo storey height 3.2 (2.9–3.6) m: URA computes building height with 3.6 m per storey (5.0 m first storey) for flats
and condominiums (URA_DC), which is an upper bound for computing height, not a typical value. Landed: URA dropped the
landed floor-to-floor guideline in 2015 and caps overall height at 12.0 m (2 storeys) and 15.5 m (3 storeys)
(URA_LANDED); 3.3 (3.0–3.8) m assumed. Commercial: URA caps floor-to-floor at 5 m incl. mezzanine (URA_DC); office
4.0 (3.6–4.5) and retail 4.5 (4.0–5.5) m assumed.

---

## B. Households, AC use and residential gains (`households.byDwelling`, residential `params`)

### B.1 Main table
Values per dwelling type. coolFrac, Q_int, Q_lat, P_light, P_equip are W/m² (coolFrac 0–1), E_other kWh/(m²a), all per
m² of dwelling floor area.

| dwelling | households 2020 | persons | AC 2017/18 | AC 2023 | floor area m² (P10–P90) | bedroom share | coolFrac | Q_int | Q_lat | P_light | P_equip | E_other | EMA kWh/month 2017 / 2019 / 2023 / 2024 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HDB 1- & 2-room (incl. studio) | 88,814 | 2.09 | 0.251 | 0.326 | 42 (31–48) | 0.24 | 0.043 | 2.09 | 2.43 | 0.33 | 3.03 | 7.2 | 168.9 / 161.2 / 171.2 / 175.7 |
| HDB 3-room | 242,388 | 2.54 | 0.652 | 0.704 | 67 (60–74) | 0.34 | 0.13 | 1.59 | 1.9 | 0.34 | 3.1 | 7.4 | 275.8 / 266.4 / 269.0 / 276.1 |
| HDB 4-room | 434,277 | 3.29 | 0.791 | 0.823 | 93 (86–104) | 0.35 | 0.157 | 1.49 | 1.78 | 0.33 | 3.02 | 7.2 | 372.9 / 359.0 / 369.7 / 380.7 |
| HDB 5-room & executive | 314,609 | 3.67 | 0.888 | 0.894 | 124 (110–150) | 0.28 | 0.136 | 1.24 | 1.48 | 0.3 | 2.76 | 6.6 | 453.9 / 436.1 / 451.0 / 464.0 |
| Condominiums & other apartments | 220,102 | 3.29 | 0.987 | 0.978 | 110 (70–160) | 0.29 | 0.182 | 1.26 | 1.51 | 0.4 | 3.65 | 8.7 | 533.5 / 521.5 / 515.4 / 522.0 |
| Landed properties | 68,425 | 4.38 | 0.966 | 0.985 | 250 (150–450) | 0.24 | 0.151 | 0.74 | 0.88 | 0.39 | 3.61 | 8.6 | 1197.7 / 1147.5 / 1175.3 / 1208.2 |
### B.2 Sources of the columns
- **Households 2020.** CENSUS2020 SR2 Table 1 (PDF p. 82–83): HDB 1–2-room 88,814; 3-room 242,388; 4-room 434,277;
  5-room & executive 314,609; condominiums & other apartments 220,102; landed 68,425 (total 1,372,559).
- **Persons per household.** Table Builder 17863, 2020 (two decimals, rounding to SR2 Chart 2.2): 2.09, 2.54, 3.29,
  3.67, 3.29, 4.38; total 3.22. The 2025 values are lower (1.92, 2.43, 3.16, 3.48, 3.15, 4.13). Distribution of
  household sizes (computed from SR2 Table 1, % with 1/2/3/4/5/6+ persons): 4-room 11.9/22.4/23.1/22.5/11.7/8.3;
  5-room & executive 7.8/18.0/21.0/25.2/15.8/12.2; 1–2-room 41.7/32.0/13.6/6.3/3.6/2.8.
- **AC ownership.** HES: Table Builder 18013 (2023), 18081 (2017/18), 18103 (2012/13), row "Air Conditioner", % of
  resident households with at least one unit. 2023: all 81.9 (SE 0.36), HDB 77.3, 1–2-room 32.6, 3-room 70.4, 4-room
  82.3, 5-room & executive 89.4, condominiums 97.8, landed 98.5. HES records availability as yes/no only (HES 2023
  Annex A(v)), so the number of units per household is unknown. HES does not ask about water heaters.
- **Floor area.** HDB_RESALE (245,642 transactions 2017–2026, transaction-weighted, not stock-weighted): P10/P50/P90
  2-room 40/47/48, 3-room 60/67/74, 4-room 86/93/104, 5-room 110/117/127, executive 130/146/154, 1-room 31 m². By lease
  decade (`types.hdb.flatAreaByLeaseDecade`), e.g. 4-room 1980s 98, 1990s 103, 2000s 90, 2010s 93 m². HDB's own plan
  areas (HDB_BTO2024, Teban Breeze): 2-room Flexi 49 m² approx. (46 m² internal, also HDB_KEYSTATS p. 22), 3-room 69,
  4-room 94 (90 internal), 5-room 114 m²; "approx." includes the AC ledge. Condo 110 and landed 250 m² are assumed.
- **Bedrooms.** 1, 2, 3, 3 (+ study), 3, 4 bedrooms; bedroom area 12.5 m² master and 10 m² others (assumed from typical
  plans, not measured).
- **AC use.** acUseShare 0.68 = SUTD2026 p. 46 (52.7 % of 416 HDB households use AC at night during sleep "often or
  always"; only 14.2 % use it regularly while awake) divided by HES 2023 HDB ownership 77.3 %. YANG2017 (abstract, and
  as cited by HAPPLE2017): most respondents use AC 3–6 months a year, 21 % more than 6 months, 40 % through the night
  (> 6 h), the rest 1–6 h. Private housing 0.8 (assumed).
- **AC hours.** acStart 22 (21–23), acEnd 6 (5–8): CHUA2010 as cited by HAPPLE2017 (switched on between 21:00 and 23:00,
  off between 06:00 and 08:00; about 100 households; paywalled, secondary); HAPPLE2017 measured the share of students
  exposed to AC (peak 60 % at 21:00–22:00, mean exposure 6.2 h/day); NEA_LABEL assumes 8 h/day.
- **Set point.** T_cool 25 °C: NEA_HECS2017 infographic (read by a subagent): 54 % of households set the AC to 25 °C or
  higher in 2017 (49 % in 2012), so the median setting is at about 25 °C. WONG2002 (three HDB 5-room flats, overnight):
  AC bedrooms measured 23–28 °C although all units were set at 22 °C. p10/p90 23–27 °C (assumed from that spread).
- **RH.** Split units have no humidistat; 0.60 (0.50–0.70) assumed. FERIADI2002 Table 1 (538 Singapore samples in
  naturally ventilated homes): air 28.5 °C / RH 75.1 % (rainy season), 29.7 °C / 71.2 % (hot season); WONG2002: NV
  bedrooms 29–30 °C, RH 70–75 %.
- **Closed AC bedroom air change.** WONG2002: CO2 reaches about 1,600 ppm overnight in AC bedrooms without fresh air
  (550–600 ppm in NV bedrooms). Steady state with 2 sleepers × 12.6 L/h CO2 (assumed) over 1,150 ppm excess gives
  22 m³/h, 0.7 h⁻¹ for a 30 m³ bedroom; with infiltration 0.07 × n50 (≈ 0.56 at n50 8) the extra n_vent is about 0.15;
  set 0.2 (0.05–0.6).
- **Windows open, n_nat.** No measured window-open air change rate for Singapore flats was found. DENG2022 simulates
  80 h⁻¹ (a model input, not a measurement). n_nat 10 (3–30) h⁻¹ is `assumed`.
- **natCtrl 0.** SUTD2026 p. 46: fans (76.4 % often or always) and window opening (mean 3.95 of 5) are the common
  strategies; this supports windows open whenever the AC is off. pOne 0.2 is an assumed share for sampling.
- **hPart 2.5 (1.5–4.0) W/K per m²**: 0.8–1.5 m² of partition and door per m² of bedroom floor × U 2.2 (drywall) to
  2.9 W/(m²K) (100 mm concrete with R_i 0.12 on both sides, BCA_ENV2008 Table C5/C6). rc5's default is 2.0.
- **Q_int (24-h mean, occupants only)** = hhSize × 0.7 presence × 60 W / floor area. **Q_lat (24-h mean)** = (hhSize ×
  0.7 × 35 W + moisture from cooking, bathing and drying 1.8–4 kg/day × 2,450 kJ/kg) / floor area. Person heat after
  ASHRAE Fundamentals Ch. 18 Table 1 (not re-read); presence and moisture assumed. Sleepers in the cooled bedrooms:
  Q_int_acZone = hhSize × 0.9 × 45 W / bedroom area, Q_lat_acZone with 30 W (for information).
- **P_light, P_equip, E_other.** NEA_HECS2017 (550 households metered for a week in 2016–17): air-conditioners 24 %,
  refrigerators 17 %, water heaters 11 % (these three verified in the release text); lamps 6 %, fans 4 %, TVs 3 %,
  modems/routers/computers 3 %, other kitchen appliances 2 %, kettles/air-pots 2 %, set-top boxes/consoles 1 %,
  washing machines/irons 1 %, others 26 % (read from the Annex A infographic by a subagent). Lighting = 6 %, equipment
  = 55 % (refrigerators, fans, TVs, computers, set-top boxes, washing, others), E_other = 15 % (water heaters, kitchen
  appliances, kettles) of the EMA 2017 mean electricity per household account of the dwelling type (EMA_SES Table 3.5),
  divided by the floor area and (for W/m²) 8,760 h. AC (24 %) is left to the model. The shares are national, not by
  dwelling type; p10/p90 ×0.6–1.6 (lighting, E_other) and ×0.7–1.3 (equipment) are assumed. Gas cooking and gas water
  heaters are not electricity: EMA town gas per account in 2024 (kWh/month): 1–2-room 36, 3-room 51, 4-room 63,
  5-room & executive 70, condo 86, landed 134 (subagent extract of EMA chart file natavg-tg-2026.csv).

### B.3 EMA household electricity and common property
EMA_SES Table 3.5 gives the average monthly electricity per household account by dwelling type (2005 to 1H 2026; 2019:
HDB 1–2-room 161.2, 3-room 266.4, 4-room 359.0, 5-room & executive 436.1, private apartments and condominiums 521.5,
landed 1,147.5 kWh). These are validation targets (`electricityEMA_kWhPerMonth`). The tables are per household account,
and SES lists "Town Councils & Public Housing Common Services" as a non-residential sub-row of the solar tables (Tables
2.6, 2.7), so HDB common property is not in household electricity. EMA does not state this exclusion in words in the
documents read; the Town Councils pay for lifts, common lighting and pumps from their own accounts (TAMPINES_TC).

**HDB common property, `types.hdb.commonProperty.E_common` = 340 (150–700) kWh per dwelling and year, `assumed`.**
HDB does not publish kWh per block (it has been installing sub-meters in block switch rooms since 2025, HDB2025ANNEX
p. 2). Derivation: Tampines Town Council spent S$10,450,044 on "Water and electricity" in FY2023/24 (TAMPINES_TC,
Income and Expenditure Statement) for a town of 86,927 HDB dwelling units (HDB_KEYSTATS p. 11), about S$120 per
dwelling. With an assumed electricity share of 0.85 and an assumed tariff of S$0.30/kWh this is about 340 kWh. Town and
Town Council boundaries differ and the figure includes commercial units and car parks. Context: lift energy
regeneration cuts lift energy by about 20 % and smart LED lighting up to 60 % (HDB2025ANNEX p. 1); blocks with solar PV
can reach net-zero common-area energy during the day (HDB_AR2122 p. 13); 455 MWp of SolarNova capacity was committed by
2025 (HDB_AR2025 p. 36). Water above 25 m (direct mains limit) needs roof tanks, above 37 m transfer pumps (PUB2022
§2.2), so pump energy grows with block height.

## C. Non-residential envelope (`nrEras`, `nrEnvelope`)

### C.1 Regulatory eras, verified
- **1979.** OTTV entered the Building Control Regulations in 1979 and applied only to air-conditioned non-residential
  buildings (BCA_ENV2008 §3.1, PDF p. 5). The OTTV limit of 45 W/m² is quoted by secondary sources; I did not find it in a
  primary document, so the 1979–2007 glazing values are `assumed`.
- **2008.** ETTV replaced OTTV, maximum 50 W/m² (BCA_ENV2008 §4.2, PDF p. 7); RETV for residential buildings, maximum
  25 W/m² (§8.2, PDF p. 11); roof U limits by weight group for air-conditioned buildings: light (< 50 kg/m²) 0.5, medium
  (50–230) 0.8, heavy (> 230) 1.2 W/(m²K) (Table C4, PDF p. 34).
- **2021.** The Code for Environmental Sustainability of Buildings, Edition 4.0 (Sept 2021) sets the base
  requirements for new buildings and major retrofits ≥ 5,000 m² GFA (BCA_ESC4 §1): non-residential ETTV ≤ 45 W/m²
  (Table 4.1(b)); residential RETV ≤ 22 W/m² or a deemed-to-satisfy table of glass SC by WWR (WWR < 0.30: SC ≤ 0.67 …
  0.45–0.50: SC ≤ 0.43), and residential roof U ≤ 0.8 / 1.1 / 1.5 W/(m²K) for light / medium / heavy roofs
  (Table 4.1(a), RB01-1, RB01-2). The GM:2021 reference model uses ETTV 45 W/m² (BCA_EMG2024 item 1.1), and GM:2021
  asks ETTV ≤ 40 W/m² for GoldPLUS and 38 or 35 for Platinum and SLE depending on the building type (BCA_ETG2024 PDF p. 19).

The eras are chosen at these rule changes because they are the only dated, documented steps in envelope performance.
The 2008–2020 era also carries the minimum Green Mark of the 2008 Environmental Sustainability Regulations.

### C.2 Formulas used, verified
- ETTV = 12(1 − WWR)U_w + 3.4·WWR·U_f + 211·WWR·CF·SC (BCA_ENV2008 §5, PDF p. 7).
- RETV = 3.4(1 − WWR)U_w + 1.3·WWR·U_f + 58.6·WWR·CF·SC (§9.1, PDF p. 11).
- Solar correction factors for vertical walls, ETTV (Table C1, PDF p. 32): N 0.80, NE 0.97, E 1.13, SE 0.98, S 0.83, SW 1.06, W 1.23,
  NW 1.03; mean of N, E, S, W = 1.00. RETV (Table C3): N 0.83, E 1.18, S 0.86, W 1.26; mean 1.03.
- SC is the shading coefficient relative to 3 mm clear glass; g = 0.87 × SC (the usual conversion; the Code defines SC
  through 3 mm clear glass, Appendix B, PDF p. 20–23).

### C.3 U-values, derived
U = 1 / (R_o + Σ d/k + R_i) with the Code's k-values (Table C5: brick plastered 0.807, concrete 1.442, cement plaster
0.533, lightweight concrete 960 kg/m³ 0.303, polystyrene 0.035, tiles 1.298 W/(mK)) and film resistances (Table C6:
walls R_o 0.044, R_i 0.120; flat roofs R_o 0.055, R_i 0.162 m²K/W):

| construction | U W/(m²K) |
|---|---|
| 115 mm brick, 15 mm plaster both sides | 2.76 |
| 230 mm brick, 15 mm plaster both sides | 1.98 |
| 100 mm precast concrete, 5 + 15 mm plaster | 3.69 |
| 125 mm precast concrete | 3.47 |
| 150 mm precast concrete (the Code's own worked example E1.4(d): 3.27) | 3.27 |
| 200 mm RC, 12 mm finishes both sides (Code example D1.3: 2.99 with tiles) | 2.88 |
| 100 mm lightweight concrete 960 kg/m³ | 1.88 |
| RC flat roof 150 mm + 50 mm screed, no insulation | 2.41 |
| same + 25 / 50 / 75 mm polystyrene | 0.89 / 0.54 / 0.39 |
| 150 mm RC floor over an open void deck, screed and tiles | 2.60 |
| 6 mm single glass (8 mm: 5.82 in Code example E1.4(a)) | 5.89 |
| 8 mm double glazing with 8 mm air gap (Code example) | 3.45 |

Single glazing in aluminium frames is taken as the glass value (frame U is similar and not separated).

### C.4 Glazing g, derived from the ETTV limit
For 2008–2020 and 2021 onwards, g is the largest value that meets the ETTV limit for a typical façade:
g = 0.87 × (ETTV − 12(1 − WWR)U_w − 3.4·WWR·U_f) / (211·WWR·CF), CF 1.0. With ETTV 50: WWR 0.5, U_w 2.0, U_f 2.8 gives
0.27; WWR 0.4, U_w 1.0, U_f 2.8 gives 0.40 (these are p10 and p90; value 0.32). With ETTV 45: 0.23 to 0.35 (value 0.28).
Before 2008 the g-values are `assumed`: clear or tinted single glazing before 1979 (0.65; the Code's worked examples use
SC 0.61–0.7 for single glazing, g 0.53–0.61, and clear float is about 0.8), tinted or reflective glass in the OTTV era
(0.45, 0.30–0.62).

## D. Non-residential use

### D.1 Air-conditioned share `coolFrac`, observed
BCA_BEBRDATA, sheet "Dataset", column "AC Floor Area Percentage" (AC floor area / GFA), records with a share of 0 removed
(they read as missing). Office 0.81 (P10 0.53, P90 0.95; n = 230), retail 0.85 (0.46–1.00; 106), hotel 0.87
(0.57–0.99; 85), mixed 0.81 (0.40–0.98; 250), hospital or specialist clinic 0.74 (0.36–0.95; 26), polyclinic or private
clinic 0.67 (0.43–0.87; 11), nursing home 0.11 (0.05–0.20; 44), autonomous university 0.65 (0.46–0.81; 10), other
educational institution 0.67 (0.54–0.90; 22), community 0.16, civic 0.46, cultural 0.75, sports centre 0.11, recreation
club 0.42. The data cover buildings of at least 5,000 m² GFA that report to BCA, so they say nothing about small shops
or schools. No such data exist for MOE schools or industrial buildings: their `coolFrac` is `assumed`.

### D.2 AC system mix `systemPrior`, observed
BCA_BEBRDATA "Type of AC System" counted by building type (share of buildings). Office: water-cooled plant 0.56,
unitary (VRF/split) 0.21, district cooling 0.12, air-cooled plant 0.07, water-cooled package 0.02. Retail: 0.62 / 0.25 /
0.01 / 0.06 / 0.04. Hotel: 0.70 / 0.21 / 0.02 / 0.05 / 0.02. Mixed: 0.65 / 0.19 / 0.10 / 0.03 / 0.02. Nursing homes and
community buildings are mostly unitary (0.91, 0.86).

### D.3 Schedules, published
- **Office.** BCA_EMG2024 Table 2 (PDF p. 23; default schedules for office space, reference and proposed model): ACMV on 07:00–19:00
  on weekdays, off on Saturday and Sunday; occupancy 50 % at 08–09, 95 % at 09–12 and 13–18, 50 % at 12–13 and 18–19;
  lighting 100 % at 08–19 except 50 % at 12–13; receptacles 90 % in office hours, 50 % at the shoulders, 5 % otherwise.
  Means over the AC hours 07–19: occupancy 0.76, lighting 0.875, receptacles 0.73. These shares are folded into Q_int,
  P_light and P_equip, which are means over start–end.
- **Retail.** BCA_ETG2024 (TSE operating hours, PDF p. 34): retail malls 10 a.m. to 10 p.m.; hotels 24 hours; office
  buildings 9 a.m. to 6 p.m. Monday to Friday (that window is for the TSE check; the modelling schedule above is longer).
  BCA_EMG2024 Table 3 (retail in office buildings): ACMV 10:00–22:00, lighting and receptacles 100 %, receptacles 10 %
  outside, occupancy mean 0.61.
- **Schools.** MOE2019: 2019 terms 2 Jan–15 Mar, 25 Mar–31 May, 1 Jul–6 Sep, 16 Sep–15 Nov (about 39 weeks); the daily
  hours are `assumed`.

### D.4 Internal gains
- **Occupancy density, published as design values.** BCA_EMG2024 Table 1 (PDF p. 22, from the Fire Code): admin office 10 m²/person,
  meeting room 1.5, shop 5, restaurant 1.5. These are design densities, so the gains derive from them with stated
  reductions (office: 0.7 office share of GFA × 0.7 actual/design) and carry `assumed`.
- **Person heat.** 75 W sensible and 55 W latent for office work (ASHRAE Handbook Fundamentals, Ch. 18 Table 1). I did
  not re-read this paywalled table, so every gain built on it is `assumed`.
- **Lighting, published budgets.** BCA_ETG2024 Table 2A (PDF p. 47–49), column D "SS 530 Reference Lighting Power Budget" and GM:2021
  Pathway 2 limits (GoldPLUS / Platinum / SLE), W/m²: offices, classrooms, lecture theatres 12 (6 / 5.5 / 5);
  laboratories 16 (8 / 7 / 6); retail general 15 (10 / 7 / 6), jewellery 35, clothing and cosmetics 25, supermarkets and
  others 20; corridors 7; lobbies and atria 10; hotel guest rooms 12 (9 / 7 / 5); manufacturing 13–14 (8); warehouses 7
  (6); car parks 3. The installed stock lies between these budgets (old fluorescent near the SS 530 budget, LED near the
  Green Mark values); P_light is set inside that band and `assumed`. Office check: BCA_SLE Fig. 3 gives lighting 15 % of
  a typical office's electricity; with the 2025 office median EUI of 132 kWh/(m²a) (BCA_BEBRDATA, n = 241) and 3,000
  use hours that is 6.6 W/m², close to the value 7.
- **Receptacles.** BCA_EMG2024 item 3.1 (PDF p. 9) reference values: computer-intensive offices 22, general office 16, large
  conference 11, tertiary schools 8, primary and secondary schools 5 W/m² (from ASHRAE 90.1-2013); data rooms 215 W/m².
  These are nominal design values; P_equip applies the Table 2 schedule mean (0.73), the office share of GFA (0.75) and
  a measured-to-nominal factor of 0.8 (assumed).
- **BCA_SLE Fig. 3, typical office** (verified): cooling 60 %, lighting 15 %, ventilation 10 %, lifts and escalators 10 %,
  others 5 %; the text adds that plug loads may reach 25 % of a building's consumption. Used for E_other (lifts and
  others, 15 % of 132 = 20 kWh/(m²a)).
- **Hotels.** GFA per room 59 m² (P10 23, P90 122; BCA_BEBRDATA, total GFA / number of hotel rooms, n = 86), `observed`.
  Room occupancy 0.8 is `assumed`; STB is reported to give 86.9 % for 2019, which I did not re-read.

### D.5 Indoor conditions, published
NEA_ACMV printed pp. 162–163 (PDF p. 170) reproduces SS 553: normal design dry bulb for comfort air conditioning 23–25 °C; operative
temperature 24–26 °C while the system runs; air speed ≤ 0.30 m/s; average RH ≤ 65 % for new and ≤ 70 % for existing
buildings. SS 553:2026 (preview, foreword item e) has since "updated the design dry-bulb temperature and relative humidity
range"; the new numbers are behind the paywall. SS 554:2016 itself was not accessible; according to the Singapore Standards eShop description (not re-read) it
excludes residential premises, hospitals, polyclinics, laboratories and factory production areas from its scope.

### D.6 Outdoor air
SS 553:2016 Table 1 (outdoor air per person and per m²) is paywalled and not reproduced in any open document I found.
V_oa values are `assumed` and converted to rc5's n_vent = V_oa / 3 m.

## E. Cooling systems (`systems`)

### E.1 Central plants, observed
BCA_BEBRDATA reports the chilled-water system efficiency (chillers, pumps, cooling towers) and the air-side efficiency
(AHU/FCU fans) in kW/RT. COP_cool for central systems is the total system efficiency TSE = plant + air side, because rc5
has no separate fan term (Green Mark defines TSE the same way, BCA_ETG2024 Pathway 2; BCA_ESC4 §2 "TSE").

| system | n | TSE kW/RT P10 / median / P90 | COP_cool median (P10–P90) |
|---|---|---|---|
| water-cooled plant | 305 | 0.713 / 0.882 / 1.322 | 3.99 (2.66–4.93) |
| air-cooled plant | 16 | 0.839 / 1.160 / 1.850 | 3.03 (1.90–4.19) |
| district cooling, air side only | 34 | 0.167 / 0.207 / 0.60 | 17.0 (5.9–21.1) |

Water-cooled plant alone: median 0.63 kW/RT (0.55–0.80, n = 479); by year of the newest chiller: before 2000 0.795
(n 16), 2000–09 0.705 (44), 2010–14 0.650 (127), 2015–19 0.624 (153), 2020 on 0.599 (110). Air side median 0.25
(0.13–0.60, n 313). These are self-reported values of buildings ≥ 5,000 m² GFA for the latest reporting year; I used
them as reported and dropped plant values outside 0.3–2.0 and air-side values outside 0.03–1.0 kW/RT.

Limits for comparison (published): GM:2021 TSE ≤ 0.8 / 0.74 / 0.68 kW/RT for GoldPLUS / Platinum / SLE in new offices
and 0.9 for existing buildings (BCA_ETG2024 Pathway 2 table and Table 1B notes); ES Code TSE ≤ 0.85 (new) and 0.9
(existing, major retrofit), water side ≤ 0.63 for new commercial buildings, air-cooled TSE ≤ 1.0, unitary outdoor units
≤ 0.78 kW/RT incl. site derating (BCA_ESC4 NRB03-2(a)); district cooling air side ≤ 0.2 (new) or 0.25 (existing)
kW/RT (BCA_ETG2024 Table 1C, PDF p. 7). The NEA ACMV manual (p. 29) notes that new and retrofitted water-cooled plants
"conveniently" reach 0.65 kW/RT (COP 5.4). SS 530:2014 minimum chiller COP, e.g. water-cooled centrifugal
1055–1407 kW: 6.286 full load (path A) (NEA_ACMV Table 1.1, PDF p. 35).

### E.2 District cooling and the building meter
In BCA_BEBRDATA the 2025 median office EUI is 108 kWh/(m²a) on district cooling (n 28) against 137 with water-cooled
plants (n 136). BCA_BEBR2023 (footnote 1) restricts the benchmarks to buildings "with centralised or unitary cooling
systems". Both point to EUI being the electricity on the building's own meter without the purchased chilled water;
BCA does not say so in the documents I read. For validation against BCA EUI, district-cooled buildings should use the
`dcs` entry (air side only).

### E.3 Unitary systems and residential units, published labels and assumed field factor
- NEA_MEPS (accessed 2026-11-25): casement/window COP100 > 3.78; single-split weighted COP > 4.86 (standby ≤ 18 W);
  multi-split > 5.50; portable ≥ 3.0; VRF IEER ≥ 4.35. Weighted COP = 0.4 × COP100 + 0.6 × COP50.
- NEA_TICK: window/casement 2 ticks 3.78–4.29, 3 ticks 4.29–4.86, 4 ticks ≥ 4.86, 5 ticks ≥ 5.50 (COP100); split
  inverter 4 ticks weighted COP ≥ 4.86, 5 ticks ≥ 5.50; VRF IEER 1 tick 4.35–4.80 … 5 ticks ≥ 6.15. The page says the
  revised rating system took effect on 1 September 2014.
- NEA_MEPS2021 (8 June 2021, effective 1 Jan 2022): window/casement MEPS from ≥ 2.9 to ≥ 3.78; split inverter weighted
  COP from ≥ 3.78 to ≥ 4.04.
- NEA_LABEL: the label's annual kWh assumes 8 h/day use for single-phase air conditioners, 12 h for VRF.
- Rated values are test values. The stock in 2019 holds units bought over roughly 2008–2019, rated about 3.3–5.0. I found
  no Singapore field measurement of split-unit COP, so COP_cool = rated × field factor 0.8 (0.6–1.0) is `assumed`.

---

## F. Grid emission factor (`gridEF`), observed
EMA_SES Table 2.3 (SES 2026), average operating margin GEF in kg CO2/kWh: 2005 0.526, 2010 0.508, 2015 0.422, 2017
0.421, 2018 0.421, 2019 0.409, 2020 0.407, 2021 0.409, 2022 0.417, 2023 0.412, 2024 0.4009 (revised from 0.402), 2025
0.4044; build margin alongside. The data.gov.sg series (d_3de362b5) gives 4 decimals to 2020 (2019 0.4085, 2020
0.4080).

---

## G. Gaps: assumed values with the widest ranges
| parameter | value (P10–P90) | why wide |
|---|---|---|
| n_nat residential | 10 (3–30) h⁻¹ | no measured window-open air change for Singapore flats |
| P_equip industrial | 10 (2–40) W/m² | process loads unknown; dominate many factories |
| E_other industrial | 15 (5–80) kWh/(m²a) | as above |
| U_roof industrial | 1.5 (0.5–6.0) | metal deck with or without insulation |
| COP_cool district cooling (meter) | 17.0 (5.9–21.1) | air-side kW/RT reported 0.17–0.60 |
| coolFrac other | 0.35 (0.05–0.80) | BCA subtype medians span 0.11–0.75 |
| retail P_equip | 15 (6–30) W/m² | tenant loads (F&B, refrigeration) unmeasured |
| retail E_other | 40 (15–80) kWh/(m²a) | escalators, kitchens, car parks |
| n50 (all types) | 4–10 with ×2 ranges | no Singapore air-tightness data |
| condo E_common | 800 (300–2,000) kWh/dwelling | no MCST data read |
| HDB E_common | 340 (150–700) kWh/dwelling | derived from one Town Council's spending with assumed tariff and share |
| education (school) coolFrac | 0.20 (0.10–0.40) | no data for MOE schools |
| residential coolFrac | e.g. 4-room 0.157 (0.07–0.30) | product of ownership (observed), use share, bedrooms cooled and bedroom share |
| split COP_cool | 3.2 (2.3–4.3) | rated values only, field factor assumed |

Also not found: SS 553:2016 outdoor-air rates and SS 554 comfort tables (paywalled); office plug loads measured in
Singapore; condominium and landed floor areas and constructions; HDB glazing beyond "tinted"; water heater and cooking
fuel shares; NEA appliance kWh by flat type; AC units per household.

## H. Conflicts between sources
- **Household appliance shares.** NEA study 2012 (REACH 2015 consultation pie chart, read by a subagent): AC 36.7 %,
  water heater 20.9 %, refrigerator 18.5 %, lighting 4.3 %. NEA study 2017: AC 24 %, water heaters 11 %, refrigerators
  17 %, lamps 6 %, others 26 %. NEA's undated "Household Electricity Consumption Profile" page: AC about 30 %,
  refrigerator 20 %, lighting 15 %, water heater 10 %. The JSON uses 2017 (the most recent metered study).
- **Grid emission factor** 2020: 0.407 (SES 2026) vs 0.4080 (data.gov.sg); 2024 revised 0.402 → 0.401.
- **HDB wall**: 150 mm precast façade (HDB_PRECAST) vs 30 cm RC in DENG2022's model.
- **HDB glazing**: tinted (brochures) vs SHGC 0.71 grey (DENG2022) vs SC 0.7 "clear" 8 mm in the Code's example.
- **AC ownership vs use**: 81.9 % of households own AC (HES 2023); at most 60 % of students were exposed at 21–22 h
  (HAPPLE2017); 52.7 % of HDB households use it at night often or always (SUTD2026).
- **Office hours**: BCA_EMG2024 Table 2 runs the AC 07–19; BCA_ETG2024 uses 09–18 for the TSE check.
- **SS 553 indoor conditions**: NEA_ACMV reproduces 23–25 °C design and RH ≤ 65/70 %; SS 553:2026 changed them
  (numbers not public).
- **District cooling in BCA EUI**: not stated by BCA; the data imply chilled water is off the building meter (§E.2).

## I. Files and scripts
Saved documents (all under `~/EnergyMapData/sg/docs/`): `bca-envl-therm-code.pdf`, `es-code_reg-2008_edition-4-0.pdf`,
`20240101_energymodellingguideline_r2.pdf`, `20241119_energy-technical-guide_r2-1.pdf`,
`20240101_healthwellbeing_technical_guide_r2.pdf` (read, nothing used), `bca-building-energy-benchmarking-report-2023.pdf`,
`bca-bebr-data.xlsx`, `bca-sle-technology-roadmap.pdf`, `nea-scem-acmv.pdf`, `ss553-2026-preview.pdf`;
`bca/bca_2020-03_annexB_DfMA_factsheet.pdf`; `hdb/` (precast guide, CLC 2015, 2017 press release, 2022 and 2025 annexes,
annual reports 2021/22 and 2024/25, Key Statistics 2025/26, two BTO brochures); `papers/` (Happle 2017, Deng 2022,
Feriadi 2002, Wong 2002, ISARC 2000, SUTD 2026); `singstat/` (HES 2023 report, Census 2020 SR2, Table Builder JSON
17472, 17491, 17863, 18013, 18081, 18103, M211241); `ema/` (SES 2026 extracts of Tables 2.3 and 3.5, chart files
`natavg-elect-4.csv`, `natavg-tg-2026.csv`, `electricity-map-5.csv`, `GridEmm2t2024.csv`, `ElecConsumptionSector.csv`,
`FinalEnergyConsumption-Households1.csv`); `datagovsg/` (GEF 2005–2020, town gas by dwelling, NEA carbon intensity);
`towncouncil/` (Tampines FY2016/17 and FY2023/24, Tanjong Pagar FY2024/25, East Coast FY2016/17); `ura/` (flats and
condominiums, commercial, landed); `pub/` (water supply handbook 2022).

The JSON was generated by a script in the session scratchpad (not in the repo): BCA statistics from
`bca-bebr-data.xlsx` (sheet "Dataset") with plant values outside 0.3–2.0 and air-side values outside 0.03–1.0 kW/RT
dropped and AC floor shares of 0 dropped; U-values from the Code's k-values; resale floor areas from the data.gov.sg
CSV. The rules are repeated in the `rule` fields.

## J. Retrofit measures (`retrofit`), 2026-11-26

The Retrofit tab of the Singapore page (js/retrofit_sg.js) sets rc5 inputs to these targets on the same parameter draws
as the current state. A measure never makes an input worse: it takes the better of the draw and the target. Every page
and table below was read in the local PDF (pdftotext) or on the web page itself.

| measure | input | target | source (page or table) | tier |
|---|---|---|---|---|
| Efficient AC, unitary | `COP_cool` | split and window 5 ticks: rated 5.50 × field factor 0.8 = 4.40; VRF 5 ticks: IEER 6.15 × 0.75 = 4.61; unitary (mixed) 4.51 | NEA_TICK tables (casement and window COP100% ≥ 5.50; single- and multi-split weighted COP ≥ 5.50; three-phase VRF IEER ≥ 6.15; page updated 1 July 2026); BCA_ESC4 RB02-1, Table 4.1(a), p. 6 (5-tick split units in new residential buildings) | assumed (the field factor is the assumed one of the stock rule, E.3) |
| Efficient AC, central plant | `COP_cool` | COP = 3.517 / TSE; TSE 0.74 kW/RT (office, retail mall, hotel, IHL) or 0.75 (schools, hospitals, polyclinics, nursing homes, light industry, other) | BCA_ETG2024 §8, p. 33, Pathway 2 table, Platinum column | published_table |
| Efficient AC, residential central plant | `COP_cool` | 0.67 kW/RT | BCA_ESC4 RB02-1 note 2, p. 6 | assumed (taken as the total system; the code does not say) |
| Efficient AC, district cooling | `COP_cool` (building meter) | air side 0.18 kW/RT | BCA_ETG2024 p. 10 (DCS, DDC or CCS: air side in lieu of TSE; GoldPLUS 0.2, Platinum 0.18, SLE 0.16) | published_table |
| Solar control film or low-e glazing | `g_window` | g = 0.87 × SC at the WWR of the draw; non-residential SC 0.51 / 0.41 / 0.35 / 0.30 / 0.27 / 0.22 for WWR < 0.20 / < 0.25 / < 0.30 / < 0.35 / < 0.40 / ≤ 0.50; residential 0.67 / 0.59 / 0.52 / 0.48 / 0.43 for < 0.30 / < 0.35 / < 0.40 / < 0.45 / ≤ 0.50 | BCA_ESC4 NRB01-1(b), Table 4.1(b), p. 7; RB01-1(b), Table 4.1(a), p. 5; g/SC as C.2 | published_table |
| External shading | `g_window` × SC2 | horizontal projection R1 = 0.5 at 0°: SC2 0.7210 (N, S), 0.7248 (E, W), weighted by the window irradiation of each facade in the model | BCA_ENV2008 Appendix B2.1 p. 21 (SC = SC1 × SC2), Table C12 p. 42, Table C13 p. 43 | published_table for SC2; assumed for R1 (projection half the window height) |
| Roof insulation | `U_roof` | residential light 0.8, medium 1.1, heavy 1.5; non-residential 0.5, 0.8, 1.2 W/(m²K); HDB heavy (RC slab, HDB_BTO2024), condominium and other non-residential heavy, landed medium, industrial light | BCA_ESC4 RB01-2, Table 4.1(a), p. 5; NRB01-2(b), Table 4.1(b), p. 7 | published_table for the limits; the weight group is assumed except for HDB |
| LED lighting (non-residential) | `P_light` | Green Mark Platinum budget through the derivation of the type value, as a ratio to it: office 0.875 × 5.5 = 4.81 W/m² (ratio 0.687); retail × 7/15; hotel × 7/12; mixed development 4.75 (blend of office and retail); education × 5.5/12; healthcare × 0.46; industrial × 6.5/13; other × 7/16 | BCA_ETG2024 Table 2A pp. 47–49 (column B, Platinum, and column D, SS 530); BCA_EMG2024 Table 2 (office lighting mean 0.875) | published_table (office); assumed (the other types, whose type values are themselves assumed blends) |
| AC at 25 °C | `T_cool` | 25 °C | MSE_GO25; NEA_ACMV p. 162–163 (SS 553 design dry bulb 23–25 °C) | published_table |
| Fans with the 25 °C set point (housing) | electricity | 30 W ceiling fan per AC bedroom of 12.5 m² = 2.4 W per m² of AC floor while the AC runs, where the set point rises by 1 K or more; × (1 + 1/COP) for the fan heat the AC removes | NEA_HOME2016 p. 4 for the advice; the wattage is not published there | assumed |

Rules and checks:
- The target of the AC measure follows the cooling system of each draw (systems shares, B and D.2), so a building with an
  unknown system mixes the targets of its possible systems.
- Non-residential buildings get no fans: 25 °C lies within the SS 553 design range.
- `tests/sg_calib_retro.mjs` checks on six preset buildings that no measure raises the median electricity, that every
  changed draw of a building with AC in the day saves (all measures but roof insulation), and that the package saves at
  least as much as the best single measure.
- Model results worth knowing: in flats with AC at night only, roof insulation saves almost nothing and raises the load
  slightly in some draws (the roof gives heat off to the night sky, less so when insulated); the 25 °C set point with
  fans raises electricity by up to about 0.9 kWh/(m²a) in draws whose set point rises by only about 1 K, and saves on
  average.

Left out, because the model cannot express them or no source fixes them:
- Cool roof or cool facade paint: rc5 has no absorptance input (α 0.5 for walls and 0.6 for roofs are fixed after ISO 13790
  §11.3 in js/rc5.js). HDB2025ANNEX describes cool coatings, but they cannot be modelled here.
- Internal blinds: `shadeCtrl` already stands for the curtains and blinds in use (0.7, assumed), and no published
  transmittance of blinds for Singapore was read. NEA_HOME2016 advises curtains, blinds or solar films without values.
- LED lighting in flats: the Green Mark lighting budgets of residential buildings cover only common areas (BCA_ETG2024 §12,
  p. 47), and common areas are not in the model. NEA_HECS2017 puts lamps at 6 % of household electricity.

## K. Bill calibration (js/calib_sg.js), 2026-11-26

- What a bill covers: a non-residential building or a landed house is the whole building; an HDB flat or a
  condominium unit is one dwelling, compared with the model's electricity per m² × the floor area of the flat (default
  `households.byDwelling.<row>.floorArea`; for HDB the inputs of that flat type's household row); the households of a block
  are the building's electricity of the model, which has no common property (B.3: lifts, corridor lighting and pumps are
  paid by the Town Council or the MCST and are not in household bills).
- Weather and grid factor of the bill year (`gridEF`, F). Meter-reading periods shift the model by half a month, the
  kernel of `data/sg/calib_residential.json` (billingKernelMonths 0.5); in leap years February is × 29/28 because the
  weather files have 8,760 hours.
- The posterior written back keeps every sampled input as its posterior median and P10–P90 with the tier
  `billcal` ("Bill-calibrated", distinct from `calibrated` of the BCA and EMA calibrations), and the ranges of the page
  come from the posterior particles.

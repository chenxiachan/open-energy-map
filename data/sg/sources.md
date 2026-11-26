# Singapore data sources

All files retrieved on 2026-11-25 unless noted. Raw files are kept outside the repo in `~/EnergyMapData/sg/<source>/`.
Sizes are the raw download. Scripts are in `tools/sg/` and run with `python -I -B` (-B: no __pycache__ in the synced project folder; a venv with osmium, shapely, numpy,
openpyxl; Python 3.13).

Licence notes. The Singapore Open Data Licence v1.0 (SODL, https://data.gov.sg/open-data-licence) asks for a visible
credit ("Contains information from <dataset> accessed on <date> from data.gov.sg which is made available under the
terms of the Singapore Open Data Licence version 1.0") and a link to the licence. GlobalBuildingAtlas LoD1 heights are
CC BY-NC 4.0 (non-commercial): see the note at the end.

## Files under data/sg and what they come from

| output | inputs | script |
|---|---|---|
| `osm/index.json`, `osm/t_*.json` | OSM PBF, MP2019 subzones (clip) | `build_osm_tiles_sg.py` |
| `x.hdb`, `x.lu`, `x.gpr`, `x.gprt`, `x.pa`, `x.sz` in the tiles | HDB footprints, HDB Property Information, MP2019 land use, MP2019 subzones | `join_sg.py` |
| `osm/addr.json` | tiles (incl. `x.hdb`), OSM address points | `extract_addr_points_sg.py`, `build_addr_index_sg.py` |
| `bca.json`, `x.bca` in the tiles | BCA listings 2017-18, 2019, 2020, BCA BEBR 2022-2025, Green Mark Buildings, `osm/addr.json` | `build_bca_sg.py`, `match_bca_sg.py` |
| `x.gba` in the tiles | GBA LoD1 tile clipped to Singapore | `clip_gba_sg.py`, `join_gba_sg.py` |
| `weather/*` | Open-Meteo ERA5, Changi monthly climate (MSS, T correction), Solargis long-term GHI (scaling) | `build_weather_sg.py` (checked with `check_weather_sg.py`) |
| `holidays.json`, `ref/*` | data.gov.sg, EMA SES 2026 | `build_ref_sg.py` |

Build order (each later step reads what the earlier ones wrote; `join_sg.py` resets `x` on every record, so the
steps after it must be run again when it is run):

```
python -I -B tools/sg/build_ref_sg.py ~/EnergyMapData/sg data/sg
python -I -B tools/sg/build_weather_sg.py ~/EnergyMapData/sg/openmeteo/era5_2010_2017.json ~/EnergyMapData/sg/openmeteo/era5_2018_2026.json data/sg/weather \
    --tcorr data/sg/ref/mss_climate_monthly.json \
    --ghi-ref ~/EnergyMapData/sg/solargis/gsa_lta_1.35_103.82.json ~/EnergyMapData/sg/solargis/gsa_lta_1.30_103.85.json ~/EnergyMapData/sg/solargis/gsa_lta_1.37_103.98.json
    # raw versions: leave out --tcorr and/or --ghi-ref; --ghi-order before scales GHI before the Erbs split;
    # --split era5 keeps ERA5's own DNI / DHI. build_ref_sg.py must run first (it writes mss_climate_monthly.json).
python -I -B tools/sg/build_osm_tiles_sg.py ~/EnergyMapData/sg/osm/malaysia-singapore-brunei-261124.osm.pbf data/sg/osm --clip ~/EnergyMapData/sg/datagov/d_8594ae9ff96d0c708bc2af633048edfb.geojson
python -I -B tools/sg/join_sg.py data/sg/osm ~/EnergyMapData/sg/datagov
python -I -B tools/sg/extract_addr_points_sg.py ~/EnergyMapData/sg/osm/malaysia-singapore-brunei-261124.osm.pbf ~/EnergyMapData/sg/osm/addr_points_bbox.tsv
python -I -B tools/sg/build_addr_index_sg.py data/sg/osm ~/EnergyMapData/sg/osm/addr_points_bbox.tsv
python -I -B tools/sg/build_bca_sg.py ~/EnergyMapData/sg/datagov data/sg/bca.json --bebr ~/EnergyMapData/sg/docs/bca-bebr-data.xlsx
python -I -B tools/sg/match_bca_sg.py data/sg ~/EnergyMapData/sg/datagov/d_da116ef216e3fb501846e1c9faf7e683.geojson
python -I -B tools/sg/clip_gba_sg.py <LoD1 json> <ODbL polygon geojson> ~/EnergyMapData/sg/gba/gba_sgp_odbl_lod1.geojsonl
python -I -B tools/sg/join_gba_sg.py data/sg/osm ~/EnergyMapData/sg/gba/gba_sgp_odbl_lod1.geojsonl
python -I -B tools/sg/check_weather_sg.py data/sg/weather <Changi TMYx .epw> data/sg/ref/mss_climate_monthly.json --gsa ~/EnergyMapData/sg/solargis/*.json
```

`tools/sg/fetch_datagov.py <out dir> <id> ...` downloads data.gov.sg datasets (metadata, then the v1 open API
`https://api-open.data.gov.sg/v1/public/api/datasets/<id>/poll-download`, `initiate-download` when needed, with pauses).

## Datasets

### OpenStreetMap buildings
- URL: https://download.geofabrik.de/asia/malaysia-singapore-brunei/malaysia-singapore-brunei-261124.osm.pbf
  (md5 f770a1c480a82bfa809039b9de0ba0d9), data timestamp 2026-11-24T21:21:23Z
- Licence: ODbL 1.0, "© OpenStreetMap contributors"
- Size: 253.8 MB (intermediate; only the Singapore buildings are kept)
- Scripts: `build_osm_tiles_sg.py` (bbox 103.59-104.10 E, 1.15-1.48 N, clipped to the MP2019 subzones + 150 m),
  `extract_addr_points_sg.py` (address points, 1.0 MB TSV, raw folder)

### HDB Property Information (data.gov.sg d_17f5382f26140b1fdae0ba2ef6239d2f)
- URL: https://data.gov.sg/datasets/d_17f5382f26140b1fdae0ba2ef6239d2f/view (last updated 2026-10-08)
- Licence: SODL v1.0, Housing & Development Board
- Size: 0.95 MB CSV. Script: `join_sg.py`

### HDB Existing Building (data.gov.sg d_16b157c52ed637edd6ba1232e026258d)
- URL: https://data.gov.sg/datasets/d_16b157c52ed637edd6ba1232e026258d/view (last updated 2026-11-08)
- Licence: SODL v1.0, Housing & Development Board
- Size: 57.5 MB GeoJSON (13,509 footprints). Script: `join_sg.py`

### URA Master Plan 2019 Land Use layer (data.gov.sg d_90d86daa5bfaa371668b84fa5f01424f)
- URL: https://data.gov.sg/datasets/d_90d86daa5bfaa371668b84fa5f01424f/view (last updated 2026-10-18)
- Licence: SODL v1.0, Urban Redevelopment Authority
- Size: 174.3 MB GeoJSON (113,213 polygons; intermediate). Script: `join_sg.py`

### URA MP2019 Subzone Boundary (No Sea) and Planning Area Boundary (No Sea)
- URLs: https://data.gov.sg/datasets/d_8594ae9ff96d0c708bc2af633048edfb/view (332 subzones),
  https://data.gov.sg/datasets/d_4765db0e87b9c86336792efe8a1f7a66/view (55 planning areas)
- Licence: SODL v1.0, Urban Redevelopment Authority
- Size: 3.2 MB and 2.1 MB GeoJSON. Scripts: `build_ref_sg.py` (simplified copies), `join_sg.py`, `build_osm_tiles_sg.py`

### BCA Listing of Building Energy Performance Data (data.gov.sg collection 22)
- 2017-18: https://data.gov.sg/datasets/d_16e7a5921aef24f610f808b16d1480ce/view (CSV, 0.11 MB)
- 2019: https://data.gov.sg/datasets/d_58ef51877ac0e3018292f6de814af5f7/view (XLSX, 0.10 MB)
- 2020: https://data.gov.sg/datasets/d_e86d8a219d0936dbb321ade068a381da/view (CSV, 0.13 MB)
- Licence: SODL v1.0, Building and Construction Authority. Scripts: `build_bca_sg.py`, `match_bca_sg.py`

### BCA Building Energy Benchmarking Report data 2022-2025
- URL: https://go.gov.sg/bca-bebr-data (file `bca-bebr-data.xlsx`, sheet "Dataset", 995 buildings), saved by the
  parameter agent on 2026-11-25 to `~/EnergyMapData/sg/docs/bca-bebr-data.xlsx` (0.40 MB)
- Licence: BCA website terms (not checked by the data agent)
- Scripts: `build_bca_sg.py --bebr`, `match_bca_sg.py`

### BCA Green Mark Buildings (GEOJSON) (data.gov.sg d_da116ef216e3fb501846e1c9faf7e683)
- URL: https://data.gov.sg/datasets/d_da116ef216e3fb501846e1c9faf7e683/view (2,919 points with postcode)
- Licence: SODL v1.0. Size 2.1 MB. Used only to place BCA postcodes that OSM does not carry (`match_bca_sg.py`).
  The CSV version (d_c4bd082b48fa7611713f39e23d250c27, 1.4 MB) was downloaded but is not used.

### Census of Population 2020
- Population by planning area / subzone x dwelling: https://data.gov.sg/datasets/d_7f243956483d5901f237e6f87b096636/view
- Households by planning area x dwelling: https://data.gov.sg/datasets/d_388f9c61f437a588b47b008a012d13fa/view
- Licence: SODL v1.0, Singapore Department of Statistics. Size 18 kB and 2 kB. Script: `build_ref_sg.py`

### EMA Singapore Energy Statistics 2026
- URL: https://www.ema.gov.sg/resources/singapore-energy-statistics/chapter3 , file
  https://www.ema.gov.sg/content/dam/corporate/resources/singapore-energy-statistics/excel/SES_tidy.xlsx.coredownload.xlsx
  (6.2 MB, "accurate as of Sep 2026"); tables 3.2, 3.3, 3.4, 3.5 and 4.1 are used.
  The site is behind a bot filter; the files were fetched through a headless Chromium session that first opened the
  chapter page (Playwright), with the same User-Agent tag.
- Licence: EMA website terms of use (not checked in detail). Older single-year extracts of Table 3.5 are on
  data.gov.sg under SODL.
- Script: `build_ref_sg.py` -> `ref/ema_household.json`, `ref/ses_sector.json`
- Checked but not used as input: data.gov.sg d_f68e309cf17d4b562ab6cefc1b9cf998 (2.0 MB GeoJSON, titled "..., 2011").
  It holds one annual value per planning area for public housing only (TOTAL = all HDB, 1-2 / 3 / 4 / 5-room and
  executive), equal to the Table 3.5 annual values of 2011 for the six planning areas compared. The sister datasets are
  the years 2009-2013. Their metadata "coverage start 2014-07-31" is wrong.

### Public holidays (data.gov.sg d_8ef23381f9417e4d4254ee8b4dcdb176, "Singapore Public Holidays (consolidated)")
- URL: https://data.gov.sg/datasets/d_8ef23381f9417e4d4254ee8b4dcdb176/view (last updated 2026-07-03)
- Licence: SODL v1.0, Ministry of Manpower. Size 3.5 kB. Covers 2020-2027 only. Script: `build_ref_sg.py`

### Monthly station climate (data.gov.sg d_1744ca68dc7ed37221b17c441042405e)
- "Air Temperature And Sunshine, Relative Humidity And Rainfall, Monthly" (SingStat, from MSS), 32.6 kB CSV
- Licence: SODL v1.0. `ref/mss_climate_monthly.json`; since 2026-11-26 also the target of the dry-bulb correction
  in `build_weather_sg.py --tcorr` (mean daily maximum and minimum), and used in `check_weather_sg.py`

### Weather: Open-Meteo historical weather API (ERA5 / ERA5-Land)
- URL: `https://archive-api.open-meteo.com/v1/archive?latitude=1.35&longitude=103.82&timezone=GMT&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,shortwave_radiation,direct_normal_irradiance,diffuse_radiation`
  with start/end 2010-01-01 to 2017-12-31 and 2018-01-01 to 2026-01-01 (grid point 1.3708 N, 103.8024 E, 39 m)
- Licence: CC BY 4.0 (Open-Meteo); ERA5 from the Copernicus Climate Change Service
- Size: 3.6 MB + 3.6 MB JSON. Script: `build_weather_sg.py`. Processing (2026-11-26, see `docs/sg-data-report.md`):
  dry bulb bias-corrected per year and month to the Changi mean daily maximum and minimum (MSS monthly climate,
  data.gov.sg d_1744ca68dc7ed37221b17c441042405e, SODL), dew point unchanged, RH recomputed; DHI and DNI derived from
  GHI with Erbs et al. (1982); GHI, DHI and DNI then scaled by 12 monthly factors (0.904-0.954) to the mean Solargis
  long-term GHI of three points, 1,648 kWh/m2 per year (Global Solar Atlas API, see below; agrees with the NEA
  ground mean of 1,636-1,661). One coastal station (Changi) stands for the whole island.

### Weather checks and references
- Changi TMYx 2011-2025: https://climate.onebuilding.org/WMO_Region_5_Southwest_Pacific/SGP_Singapore/SGP_SG_Singapore-Changi.Intl.AP.486980_TMYx.2011-2025.zip
  (0.40 MB; terms of climate.onebuilding.org, not checked)
- Solargis long-term averages through the Global Solar Atlas API, `https://api.globalsolaratlas.info/data/lta?loc=<lat>,<lon>`
  for 1.35/103.82, 1.37/103.98, 1.30/103.85 (2.7 kB JSON each, Solargis model version 2.2.68, period to 2025;
  Global Solar Atlas terms, not checked). Since 2026-11-26 the monthly GHI of the three points (mean) is the scaling
  reference of `build_weather_sg.py --ghi-ref`.
- NEA ground GHI 15-year table quoted in the REC whitepaper
  https://www.recgroup.com/sites/default/files/documents/whitepaper_irradiance_study_singapore.pdf (read, not stored)

### GlobalBuildingAtlas (Zhu et al., https://github.com/zhu-xlab/GlobalBuildingAtlas)
- LoD1 heights: https://huggingface.co/datasets/zhu-xlab/GBA.LoD1/resolve/main/LoD1/oceania/e100_n05_e105_n00.json
  (723.4 MB, deleted after clipping), licence CC BY-NC 4.0
- Polygons (OSM- and Microsoft-derived, ODbL): https://huggingface.co/datasets/zhu-xlab/GBA.ODbLPolygon/resolve/main/oceania/e100_n05_e105_n00.geojson
  (883.3 MB, deleted after clipping), licence ODbL
- Kept: `~/EnergyMapData/sg/gba/gba_sgp_odbl_lod1.geojsonl` (55.0 MB, 132,310 polygons of region SGP with height and var)
- Scripts: `clip_gba_sg.py`, `join_gba_sg.py`
- Licence note: `x.gba` carries CC BY-NC 4.0 values into the tiles. A public map with them must credit GBA and stays
  non-commercial for that layer; whether this fits the project licence is for the coordinator to decide.

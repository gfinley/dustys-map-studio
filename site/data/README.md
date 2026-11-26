# 1941 Southeast Asia & Western Pacific Land Airfields (GeoJSON)

Standalone RFC 7946 GeoJSON datasets mapping **163 historical land airfields** (94 military, 69 civilian) operational or usable as of **late 1941 (eve of the Pacific War, December 1941)** across Southeast Asia and the Western Pacific.

## Files

| File | Features | Description |
| --- | ---: | --- |
| [`airfields_1941_se_asia_western_pacific.geojson`](airfields_1941_se_asia_western_pacific.geojson) | 163 | Combined master layer (all military and civilian land airfields) |
| [`airfields_1941_se_asia_western_pacific_military.geojson`](airfields_1941_se_asia_western_pacific_military.geojson) | 94 | Military land airfields (air force bases, auxiliary strips, and secret dispersal fields) |
| [`airfields_1941_se_asia_western_pacific_civilian.geojson`](airfields_1941_se_asia_western_pacific_civilian.geojson) | 69 | Civilian land airfields (international airports, domestic airline hubs, and civil landing grounds) |

> **Disjoint partition for clean map overlays:** The `military` and `civilian` files form an exact disjoint partition (`94 + 69 = 163`) so both layers can be displayed simultaneously in Dusty's Map Studio or QGIS without duplicate overlapping points. Facilities used by both civil airlines and military air forces in 1941 (such as Kallang Airport, Don Muang, Tan Son Nhut, Kemayoran/Tjililitan/Andir, Ipoh, and Nielson Field) are tagged with `"dual_use": true`.

## Scope & Historical Criteria

- **Timeframe:** Late 1941 (~7–8 December 1941). Airfields constructed solely during 1942–1945 (e.g., RAF Changi, North Borneo/Sabah Japanese wartime strips at Labuan/Jesselton/Sandakan, Lipa/Fernando AB, Morotai, and post-war airports such as Suvarnabhumi, KLIA, Soekarno-Hatta, Juanda, Mactan) are excluded.
- **Land airfields only:** Pure seaplane bases and flying-boat water anchorages (e.g., Cavite/Sangley Point, Morokrembangan, Tandjong Priok, Halong/Ambon, Kakas, Sattahip) are excluded.
- **Regions covered:**
  - **Philippines** — 35 airfields (15 military, 20 civilian)
  - **Malaya & Singapore** — 26 airfields (18 military, 8 civilian)
  - **Borneo (Sarawak & Dutch Kalimantan)** — 10 airfields (7 military, 3 civilian)
  - **Dutch East Indies (Java, Sumatra, Sulawesi, Lesser Sundas, Moluccas, Dutch New Guinea) & Portuguese Timor** — 42 airfields (24 military, 18 civilian)
  - **French Indochina (Vietnam, Cambodia, Laos)** — 25 airfields (15 military, 10 civilian)
  - **Thailand (Siam)** — 25 airfields (15 military, 10 civilian)

## Feature Properties Schema

Each feature is a `Point` in WGS84 (`EPSG:4326`, `[longitude, latitude]`) with:

- `id`: Stable slug identifier (e.g., `ph-clark-field`, `sg-kallang-airport`)
- `name`: Historical 1941 name
- `alternate_names`: Colonial, modern, or alternate spellings
- `category`: `"military"` or `"civilian"`
- `dual_use`: `true` if used by both military and civil aviation in 1941
- `airfield_type`: `"land_airfield"`
- `facility_class`: `"major_military_airbase"`, `"military_airfield"`, `"military_auxiliary_strip"`, `"secret_dispersal_airfield"`, `"international_civil_airport"`, `"domestic_civil_airport"`, or `"civil_landing_ground"`
- `region` / `subregion`: Theater region and island/zone
- `territory_1941` / `modern_country`: 1941 geopolitical territory and modern country
- `control_dec_1941` / `alignment_dec_1941`: Control & strategic alignment on 7–8 December 1941
- `operator_1941`: Air force(s) and/or civil airline(s)
- `surface_1941` / `runway_notes_1941`: Historical runway surface and specifications
- `status_dec_1941`: `"operational"` or `"under_construction_usable"`
- `notes`: Historical context as of December 1941
- `modern_equivalent`: Modern airport/ICAO/IATA identifier or `"Defunct (...)"`
- `marker-color`, `marker-symbol`, `marker-size`, `title`: [simplestyle-spec](https://github.com/mapbox/simplestyle-spec) hints for instant styled rendering in GitHub, geojson.io, Mapbox, and QGIS.

## Regenerating

```bash
python3 scripts/build_1941_airfields.py
```

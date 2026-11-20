# Open Energy Map for agents

A command line tool and an MCP server that give the energy model of one building as JSON. Every number comes with its range, and every input with its source tier and references down to the document and page. An LLM agent that uses it can quote building energy it can trace, instead of making it up.

The tool runs the same modules and data as the [map](https://chenxiachan.github.io/open-energy-map/), so the numbers match the page. It needs Node.js 18 or later and a clone of this repository. It has no dependencies, needs no account or key, and works offline. Coverage so far: Munich and its surroundings.

## Command line

```bash
node agent/oem.mjs find "Schellingstraße 51"
node agent/oem.mjs building --address "Schellingstraße 51, München"
node agent/oem.mjs building --at 48.148862 11.568004
node agent/oem.mjs building --id w34107320 --assume refurbished.windows=yes --assume system=hp_air
node agent/oem.mjs building --lod2 DEBY_LOD2_4958835
node agent/oem.mjs energy-ade --address "Schellingstraße 51, München" --out schellingstr51.gml
```

`energy-ade` writes the same building as CityGML 2.0 with the Energy ADE 3.0 (beta 7), the file of the Export tab of the page: LoD2 boundary surfaces, the thermal zone and usage zone, the constructions, the heat generator and the energy demand with its hourly series. The ranges, tiers and references of the JSON are in the generic attribute sets `OEM_result_*`, `OEM_input_*` and `OEM_provenance` of the building, since Energy ADE 3.0 has no element for them.

| Option | Meaning |
|---|---|
| `--id`, `--lod2`, `--at LAT LON`, `--address` | The building: an OSM id (`w…` or `r…`), a LoD2 id (`DEBY_LOD2_…`), a point or an address, taken in this order |
| `--assume key=value` | What is known, entered as user input as on the page: `age_class=A…L`, `system=gas_cond…`, `usage=mfh…`, `storeys=5`, `height_m=16`, `refurbished.wall=yes`, or any input such as `U_wall=0.3` |
| `--summary` | A shorter result: each input with its tier, prior range and first reference |
| `--samples N` | Draws of the prior for the ranges (100 to 1000, default 300) |
| `--lang en\|de\|zh` | Language of labels and notes (default English) |

## MCP server

```bash
node agent/oem.mjs mcp
```

The server speaks MCP over stdio and offers two tools:

- `find_building` searches addresses and building names and returns OSM ids, coordinates and links to the map.
- `building_energy` returns the model of one building. Arguments: `osm_id` (with `lat` and `lon`), `lod2_id`, `lat` and `lon`, or `address`; optional `assume`, `samples` and `detail` (`summary`, the default, or `full`).

Claude Code:

```bash
claude mcp add open-energy-map -- node /path/to/open-energy-map/agent/oem.mjs mcp
```

Claude Desktop, Cursor, Windsurf, Gemini CLI and most other clients (`mcpServers` in the client's configuration; VS Code and the Codex CLI use their own keys, see the [main README](../README.md#for-ai-agents)):

```json
{
  "mcpServers": {
    "open-energy-map": { "command": "node", "args": ["/path/to/open-energy-map/agent/oem.mjs", "mcp"] }
  }
}
```

## Which building

An address does not always name one building. Several buildings can share an address (a school and its sports hall), and the same street and number exist in several municipalities around Munich. The tool therefore takes an address only when it fits exactly one building:

- The house number must match. If it is not in the index, the tool says so and lists the numbers that exist on the street; it does not take the nearest one.
- "München" in the query keeps the buildings in the city of Munich (postcodes 80331 to 81929). A postcode narrows the search further. The index keeps no municipality names, so a word such as "Gauting" that matches nothing is left out, and the reply says so.
- If more than one building fits, `building_energy` returns `"status": "ambiguous"` and the candidates, each with name, postcode, OSM building type, footprint, storeys and LoD2 id, and no model. The agent asks the person or chooses, then calls again with the `osm_id` and `lat`, `lon` of one candidate.

Two identifiers come back in `building.identity`:

| Identifier | What it is |
|---|---|
| `osm_id` | The OSM way or relation (`w34107320`). Unique in the OSM snapshot of the data (`osm_snapshot`), but it can change when mappers redraw an outline. Keep the point as well: `map_url` carries both, and a stale id falls back to the building at the point (the result then says so in `note`). |
| `lod2_id` | The `gml:id` of the building in the LoD2 model of the Bavarian survey (CityGML, city of Munich only), the key to join with other city models. |

The two do not always match one to one. About one OSM outline in five covers several LoD2 buildings (`lod2_buildings_under_outline`; the index keeps the largest), and about 5,400 LoD2 buildings are split into several OSM outlines (`outlines_sharing_lod2`). The map models each OSM outline as a building, so a `lod2_id` that is split returns the outlines as candidates.

## What comes back

| Field | Content |
|---|---|
| `building` | OSM id, address, use, storeys, height, roof, `identity`, reference area, construction age with its prior, and links to the map and to OSM |
| `results` | Heating demand, final energy (with carrier, system and energy class), primary energy, CO₂ and peak load. Each has `value` (the model with the point values of the inputs) and `p10_p90` with `median` (the dark band on the page). If the construction age is uncertain, `p10_p90_all_ages` gives the range over all ages (the light band) |
| `inputs` | Every input: value, unit, `tier`, a note on how the value was set, the prior range and the references (document, page, link) |
| `uncertainty` | The share of each input in the variance of the heating demand |
| `checks` | The self-checks of the page |
| `sources`, `licence`, `cite`, `disclaimer` | Data credits and terms |

The tiers say what kind of evidence a value rests on:

| Tier | Meaning |
|---|---|
| `observed` | Measured or mapped for this building: OSM, LoD2, geometry |
| `published_table` | A published table or statistic: IWU / TABULA, DIN V 18599 via dena, GEG, Zensus 2022 |
| `assumed` | An assumption, with the rule stated |
| `user_input` | Given by the caller with `assume` |

When an agent reports a number, it should give the range, name the tiers of the inputs that drive it (`uncertainty.shares`) and link `map_url` so a person can check. Assumed inputs are not facts about the building.

## Licence

The code and model are under the PolyForm Noncommercial License 1.0.0; the results are under CC BY-NC 4.0; third-party data keep their licences (see `sources` in each result). Commercial use needs a licence: x.c.chen@tum.de. The results are research estimates for reference only. They do not replace an energy performance certificate or an on-site assessment.

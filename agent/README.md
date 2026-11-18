# Open Energy Map for agents

A command line tool and an MCP server that give the energy model of one building as JSON. Every number comes with its range, and every input with its source tier and references down to the document and page. An LLM agent that uses it can quote building energy it can trace, instead of making it up.

The tool runs the same modules and data as the [map](https://chenxiachan.github.io/open-energy-map/), so the numbers match the page. It needs Node.js 18 or later and a clone of this repository. It has no dependencies, needs no account or key, and works offline. Coverage so far: Munich and its surroundings.

## Command line

```bash
node agent/oem.mjs find "Schellingstraße 51"
node agent/oem.mjs building --address "Schellingstraße 51, München"
node agent/oem.mjs building --at 48.148862 11.568004
node agent/oem.mjs building --id w34107320 --assume refurbished.windows=yes --assume system=hp_air
```

| Option | Meaning |
|---|---|
| `--address`, `--at LAT LON`, `--id` | The building: an address, a point, or an OSM id (`w…` or `r…`) |
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
- `building_energy` returns the model of one building. Arguments: `address`, or `lat` and `lon`, or `osm_id`; optional `assume`, `samples` and `detail` (`summary`, the default, or `full`).

Claude Code:

```bash
claude mcp add open-energy-map -- node /path/to/open-energy-map/agent/oem.mjs mcp
```

Claude Desktop and other clients (`mcpServers` in the client's configuration):

```json
{
  "mcpServers": {
    "open-energy-map": { "command": "node", "args": ["/path/to/open-energy-map/agent/oem.mjs", "mcp"] }
  }
}
```

## What comes back

| Field | Content |
|---|---|
| `building` | OSM id, address, use, storeys, height, roof, LoD2 id, reference area, construction age with its prior, and links to the map and to OSM |
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

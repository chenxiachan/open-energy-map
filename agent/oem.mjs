#!/usr/bin/env node
// Open Energy Map on the command line and as an MCP server, for people and for LLM agents. No dependencies beyond
// Node 18+; the data come from this repository. See agent/README.md.
//
//   node agent/oem.mjs find "Schellingstraße 51"
//   node agent/oem.mjs building --address "Schellingstraße 51, München"
//   node agent/oem.mjs building --at 48.150761 11.573679 --assume age_class=B --assume refurbished.windows=yes
//   node agent/oem.mjs building --lod2 DEBY_LOD2_4958835
//   node agent/oem.mjs mcp            (MCP server on stdio: tools find_building and building_energy)
//
// Options: --lang en|de|zh (default en), --samples N (100–1000, default 300), --summary (shorter result), --compact (one line)

const argv = process.argv.slice(2);
const flag = (k) => argv.includes('--' + k);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i > -1 && i + 1 < argv.length ? argv[i + 1] : d; };
const lang = ['en', 'de', 'zh'].includes(opt('lang')) ? opt('lang') : 'en';
const cmd = argv[0];

const HELP = `Open Energy Map: building energy you can trace to its source (first city: Munich)

  node agent/oem.mjs find <query> [--limit 10]
      Addresses and building names in the local data, with OSM ids and coordinates. The house number must match;
      if it does not, the numbers that exist on the street come back with exact: false.
  node agent/oem.mjs building (--id <osm id> [--at <lat> <lon>] | --lod2 <DEBY_LOD2_…> | --at <lat> <lon> | --address <text>)
                              [--assume key=value ...] [--samples 300]
      An address that fits several buildings (several buildings at one address, or the same street and number in
      several municipalities) returns status "ambiguous" with the candidates instead of a model.
      The energy model of one building as JSON: heating demand, final energy, CO2 and peak load with P10-P90
      ranges, every input with its source tier and references, where the uncertainty comes from, self-checks.
      --assume  age_class=A..L  system=gas_cond|gas_old|oil|district|hp_air|hp_ground|pellet|electric
                usage=sfh|th|mfh|ab|office|education|retail|other  storeys=N  height_m=X
                refurbished.windows|wall|roof|floor=yes|no  <input>=<number> (e.g. U_wall=0.3, T_heat=21)
  node agent/oem.mjs mcp
      MCP server on stdio with the tools find_building and building_energy.

  --lang en|de|zh   language of labels and notes (default en)
  --summary         shorter result: each input with its tier, prior range and first reference
  --compact         print one line of JSON`;

const core = await import('./core.mjs');
const out = (o) => process.stdout.write(JSON.stringify(o, null, flag('compact') ? 0 : 1) + '\n');

function parseAssume() {
  const a = { refurbished: {}, params: {} };
  argv.forEach((x, i) => {
    if (x !== '--assume') return;
    const [k, v] = String(argv[i + 1] || '').split('=');
    if (!k || v == null) throw new core.UserError(`--assume needs key=value, got ${argv[i + 1]}`);
    if (k.startsWith('refurbished.')) a.refurbished[k.slice(12)] = v;
    else if (['age_class', 'system', 'usage'].includes(k)) a[k] = v;
    else if (['storeys', 'height_m'].includes(k)) a[k] = +v;
    else a.params[k] = +v;
  });
  return a;
}

async function cli() {
  if (!cmd || cmd === 'help' || flag('help')) { console.log(HELP); return; }
  await core.init(lang);
  if (cmd === 'find') {
    const q = argv.slice(1).filter((x, i, a) => !x.startsWith('--') && !(a[i - 1] || '').startsWith('--')).join(' ');
    out(await core.findBuildings(q, +opt('limit', 10)));
  } else if (cmd === 'building') {
    const i = argv.indexOf('--at');
    const where = { address: opt('address'), osm_id: opt('id'), lod2_id: opt('lod2'), lat: i > -1 ? +argv[i + 1] : undefined, lon: i > -1 ? +argv[i + 2] : undefined };
    out(await core.buildingEnergy(where, parseAssume(), { samples: +opt('samples', 300), detail: flag('summary') ? 'summary' : 'full' }));
  } else throw new core.UserError(`Unknown command ${cmd}. Run node agent/oem.mjs help`);
}

// ---------- MCP server (JSON-RPC 2.0 over stdio, one message per line) ----------
const TOOLS = [
  {
    name: 'find_building',
    title: 'Find a building',
    description: 'Search addresses and building names in the area Open Energy Map covers so far (Munich and its surroundings). Returns matches with OSM id, postcode, coordinates and a link to the map. The house number must match exactly; if it is not in the index, the numbers that exist on that street come back with exact: false. One address can hold several buildings, and the same street and number exist in several municipalities around Munich (the postcode tells them apart; in_munich is true for the city of Munich). Then call building_energy with the osm_id and lat/lon of the building meant.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Street and house number, ideally with postcode or "München", or a building name, e.g. "Arcisstraße 21, 80333 München"' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, required: ['query'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'building_energy',
    title: 'Energy model of a building',
    description: 'The energy model of one building from open data, as on the Open Energy Map page: heating demand, final energy, CO2 and peak load, each with a P10-P90 range, plus every input with its value, its source tier (observed, published_table, assumed, user_input) and references down to the document and page. When you report a number, give the range and name the tier of the inputs that drive it (see uncertainty.shares); do not present assumed inputs as facts. Pass what the user knows as assume (it enters as user input and narrows the range). Identify the building by osm_id (with lat/lon), lod2_id, lat/lon, or address, taken in this order. An address that fits several buildings returns status "ambiguous" with candidates (name, use, footprint, storeys, LoD2 id) and no model: ask the user or choose, then call again with the osm_id and lat/lon of one candidate. The result carries building.identity: the OSM id with its snapshot date and the gml:id of the official LoD2 model. Results are research estimates, not an energy performance certificate.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street and house number, ideally with postcode or "München", e.g. "Schellingstraße 51, 80799 München"' },
        lat: { type: 'number' }, lon: { type: 'number' },
        osm_id: { type: 'string', description: 'OSM id as w<number> or r<number>, from find_building or a candidate; pass lat/lon with it' },
        lod2_id: { type: 'string', description: 'gml:id of the building in the Bavarian LoD2 model (CityGML), e.g. "DEBY_LOD2_4958835"; city of Munich only' },
        assume: {
          type: 'object', description: 'What is known about the building; each value enters as user input',
          properties: {
            age_class: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'], description: 'Construction period: A ≤1859, B 1860–1918, C 1919–48, D 1949–57, E 1958–68, F 1969–78, G 1979–83, H 1984–94, I 1995–2001, J 2002–09, K 2010–15, L ≥2016' },
            system: { type: 'string', enum: ['gas_cond', 'gas_old', 'oil', 'district', 'hp_air', 'hp_ground', 'pellet', 'electric'] },
            usage: { type: 'string', enum: ['sfh', 'th', 'mfh', 'ab', 'office', 'education', 'retail', 'other'] },
            storeys: { type: 'integer', minimum: 1 }, height_m: { type: 'number', exclusiveMinimum: 0 },
            refurbished: { type: 'object', description: 'yes or no per element', properties: { windows: { type: 'string', enum: ['yes', 'no'] }, wall: { type: 'string', enum: ['yes', 'no'] }, roof: { type: 'string', enum: ['yes', 'no'] }, floor: { type: 'string', enum: ['yes', 'no'] } } },
            params: { type: 'object', description: 'Inputs by key, e.g. {"U_wall": 0.3, "T_heat": 21}; keys as in the inputs of the result', additionalProperties: { type: 'number' } },
          },
        },
        samples: { type: 'integer', minimum: 100, maximum: 1000, default: 300, description: 'Draws of the prior for the ranges' },
        detail: { type: 'string', enum: ['summary', 'full'], default: 'summary', description: 'summary: each input with its tier, prior range and first reference; full: every reference, note and check' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function mcp() {
  await core.init(lang);
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const handle = async (msg) => {
    const { id, method, params = {} } = msg;
    if (method === 'initialize') return reply(id, {
      protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'open-energy-map', title: 'Open Energy Map', version: core.VERSION },
      instructions: 'Building energy you can trace to its source. building_energy returns ranges and the source tier of every input; report the range and the tiers, and link map_url so the user can check. An address can fit several buildings: if the result says status "ambiguous", do not pick silently; ask or explain your choice, then call again with the osm_id and lat/lon. Coverage so far: Munich and its surroundings.',
    });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const a = params.arguments || {};
      try {
        const r = params.name === 'find_building' ? { matches: await core.findBuildings(a.query || '', a.limit || 10) }
          : params.name === 'building_energy' ? await core.buildingEnergy({ address: a.address, lat: a.lat, lon: a.lon, osm_id: a.osm_id, lod2_id: a.lod2_id }, a.assume || {}, { samples: a.samples, detail: a.detail === 'full' ? 'full' : 'summary' })
          : null;
        if (!r) return fail(id, -32602, `Unknown tool ${params.name}`);
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r });
      } catch (e) {
        // errors of the input go back to the model as a tool result it can act on
        return reply(id, { content: [{ type: 'text', text: e instanceof core.UserError ? e.message : `Internal error: ${e.message}` }], isError: true });
      }
    }
    if (id === undefined) return;   // notifications (initialized, cancelled) need no answer
    return fail(id, -32601, `Method not found: ${method}`);
  };
  let buf = '', chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      chain = chain.then(() => handle(msg)).catch((e) => process.stderr.write(String(e && e.stack || e) + '\n'));
    }
  });
  process.stdin.on('end', () => chain.then(() => process.exit(0)));
}

try {
  if (cmd === 'mcp') await mcp(); else await cli();
} catch (e) {
  if (e instanceof core.UserError) { process.stderr.write(e.message + '\n'); process.exit(2); }
  throw e;
}

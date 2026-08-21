const fs = require("fs");
const path = require("path");

const [sourcePath, areaId, southArg, westArg, northArg, eastArg] = process.argv.slice(2);
if (!sourcePath || !areaId || !eastArg) {
  console.error("Usage: node scripts/import-osm-expected-blocks.js <map.osm> <area-id> <south> <west> <north> <east>");
  process.exit(1);
}

const bounds = { south: Number(southArg), west: Number(westArg), north: Number(northArg), east: Number(eastArg) };
const publicHighways = new Set(["residential", "living_street", "unclassified", "tertiary", "secondary", "primary"]);
const decode = (value = "") => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
const xml = fs.readFileSync(sourcePath, "utf8");
const nodes = new Map();

for (const match of xml.matchAll(/<node\b[^>]*\bid="(\d+)"[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>/g)) {
  nodes.set(match[1], [Number(match[2]), Number(match[3])]);
}

const ways = [];
for (const match of xml.matchAll(/<way\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
  const [, id, body] = match;
  const tags = Object.fromEntries(Array.from(body.matchAll(/<tag\s+k="([^"]+)"\s+v="([^"]*)"\s*\/>/g), (tag) => [decode(tag[1]), decode(tag[2])]));
  const nodeIds = Array.from(body.matchAll(/<nd\s+ref="(\d+)"\s*\/>/g), (node) => node[1]);
  if (tags.highway && nodeIds.length >= 2) ways.push({ id, tags, nodeIds });
}

const nodeWays = new Map();
for (const way of ways) {
  if (!publicHighways.has(way.tags.highway) || !way.tags.name || way.tags.access === "private") continue;
  for (const nodeId of new Set(way.nodeIds)) {
    if (!nodeWays.has(nodeId)) nodeWays.set(nodeId, new Set());
    nodeWays.get(nodeId).add(way.tags.name.toUpperCase());
  }
}

// Liang-Barsky clipping keeps every emitted line segment inside the requested rectangle.
function clipEdge(start, end) {
  const x0 = start[1]; const y0 = start[0];
  const dx = end[1] - x0; const dy = end[0] - y0;
  let t0 = 0; let t1 = 1;
  const checks = [[-dx, x0 - bounds.west], [dx, bounds.east - x0], [-dy, y0 - bounds.south], [dy, bounds.north - y0]];
  for (const [p, q] of checks) {
    if (p === 0 && q < 0) return null;
    if (p === 0) continue;
    const ratio = q / p;
    if (p < 0) t0 = Math.max(t0, ratio);
    else t1 = Math.min(t1, ratio);
    if (t0 > t1) return null;
  }
  return [
    [y0 + t0 * dy, x0 + t0 * dx],
    [y0 + t1 * dy, x0 + t1 * dx]
  ];
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function clippedParts(nodeIds) {
  const parts = [];
  let current = [];
  for (let index = 1; index < nodeIds.length; index += 1) {
    const clipped = clipEdge(nodes.get(nodeIds[index - 1]), nodes.get(nodeIds[index]));
    if (!clipped) {
      if (current.length >= 2) parts.push(current);
      current = [];
      continue;
    }
    if (!current.length || !samePoint(current.at(-1), clipped[0])) {
      if (current.length >= 2) parts.push(current);
      current = [clipped[0]];
    }
    if (!samePoint(current.at(-1), clipped[1])) current.push(clipped[1]);
  }
  if (current.length >= 2) parts.push(current);
  return parts;
}

function endpointLabel(nodeId, streetName) {
  const crossStreets = Array.from(nodeWays.get(nodeId) || []).filter((name) => name !== streetName.toUpperCase());
  return crossStreets.length ? crossStreets.join(" / ") : `OSM node ${nodeId}`;
}

let additions = [];
for (const way of ways) {
  const excluded = !publicHighways.has(way.tags.highway) || !way.tags.name || way.tags.access === "private";
  let start = 0;
  for (let index = 1; index < way.nodeIds.length; index += 1) {
    const isIntersection = (nodeWays.get(way.nodeIds[index])?.size || 0) > 1;
    if (!isIntersection && index !== way.nodeIds.length - 1) continue;
    const segmentNodeIds = way.nodeIds.slice(start, index + 1);
    clippedParts(segmentNodeIds).forEach((geometry, partIndex) => additions.push({
      id: `${areaId}-osm-${way.id}-${segmentNodeIds[0]}-${segmentNodeIds.at(-1)}-${partIndex}`,
      streetName: way.tags.name || `Unnamed ${way.tags.highway}`,
      from: endpointLabel(segmentNodeIds[0], way.tags.name || ""),
      to: endpointLabel(segmentNodeIds.at(-1), way.tags.name || ""),
      geometry,
      ...(excluded ? { excluded: true, exclusionReason: "Alley, service/ramp, unnamed, private, or non-motorized way" } : {})
    }));
    start = index;
  }
}

// Denver route 4043 begins at the railroad crossing, which is not an OSM
// street intersection. Split this OSM block there so its verified schedule
// is not hidden by an unavailable-data route for the Navajo–railroad gap.
if (areaId === "w5-alameda-federal-i25") {
  const mapleBlockId = `${areaId}-osm-16985097-176075661-176094070-0`;
  additions = additions.flatMap((block) => block.id === mapleBlockId ? [
    {
      id: `${areaId}-osm-maple-navajo-rrx`,
      streetName: "West Maple Avenue",
      from: "South Navajo Street",
      to: "Railroad crossing",
      geometry: [
        [39.7139348, -105.003895],
        [39.7139348, -105.0039931],
        [39.7139346, -105.0045292],
        [39.7139353, -105.0048502],
        [39.7139480704729, -105.004865723319]
      ]
    },
    {
      id: `${areaId}-osm-maple-rrx-pecos`,
      streetName: "West Maple Avenue",
      from: "Railroad crossing",
      to: "South Pecos Street",
      geometry: [
        [39.7139480704729, -105.004865723319],
        [39.7139579572002, -105.006150665299],
        [39.7139368272392, -105.006267226589]
      ]
    }
  ] : [block]);
}

if (areaId === "w50-vrain-infill") {
  const vrainTailId = `${areaId}-osm-16988782-4591290006-13261557972-0`;
  const west50ReturnId = `${areaId}-osm-659797714-176084043-4591290006-0`;
  additions = additions.flatMap((block) => {
    if (block.id === vrainTailId) {
      return [
        {
          id: `${areaId}-osm-vrain-w50-denver-end`,
          streetName: "Vrain Street",
          from: "West 50th Avenue",
          to: "Denver maintenance end",
          geometry: [
            [39.7882941, -105.0462419],
            [39.7885553866327, -105.046231929618]
          ]
        },
        {
          id: `${areaId}-osm-vrain-beyond-denver-end`,
          streetName: "Vrain Street",
          from: "Denver maintenance end",
          to: "OSM node 13261557972",
          geometry: [
            [39.7885553866327, -105.046231929618],
            [39.7886871, -105.0462386]
          ]
        }
      ];
    }
    if (block.id === west50ReturnId) {
      return [{
        ...block,
        id: `${areaId}-osm-w50-beyond-denver-end`,
        from: "Denver route 11791 end",
        geometry: [
          [39.7875193292601, -105.048173494815],
          ...block.geometry
        ]
      }];
    }
    return [block];
  });
}

// Denver's northern boundary follows Sand Creek here instead of one latitude:
// it runs along E 54th Avenue east of Brighton Boulevard, then falls diagonally
// to just north of E 52nd Avenue at York Street. These five blocks sit on the
// Commerce City side of that diagonal, at and past the York Street bridge over
// the creek, so Denver never sweeps them.
if (areaId === "i70-e54-york-colorado") {
  const commerceCityBlockIds = new Set([
    `${areaId}-osm-365446753-3694617567-175951614-0`,
    `${areaId}-osm-365446761-3694617567-3694617582-0`,
    `${areaId}-osm-365446766-3694619355-3694617567-0`,
    `${areaId}-osm-427836008-175951614-4270096677-0`,
    `${areaId}-osm-1536738401-175951614-13999298638-0`
  ]);
  additions = additions.map((block) => commerceCityBlockIds.has(block.id)
    ? { ...block, excluded: true, exclusionReason: "North of the Denver–Commerce City line at Sand Creek" }
    : block);
}

// The requested rectangle reaches west to North Lipan Street so both of its
// curbs are included, but everything at or west of North Kalamath Street and at
// or south of West 5th Avenue was already imported and mapped as
// w5-alameda-federal-i25. Only the Lipan block between West 5th and West 6th is
// new ground, and it crosses that north edge rather than sitting inside it, so
// excluding the blocks that fall wholly within the published rectangle keeps the
// manifest free of duplicate expected blocks without losing coverage.
if (areaId === "w6-alameda-lipan-broadway") {
  const publishedWest = -105.0002;
  const publishedNorth = 39.7244;
  additions = additions.map((block) => block.excluded || !block.geometry.every(([lat, lon]) => lon <= publishedWest && lat <= publishedNorth)
    ? block
    : { ...block, excluded: true, exclusionReason: "Already published in the W 5th Avenue–W Alameda Avenue, Federal–I-25 area" });
}

const manifestPath = path.join(__dirname, "..", "data", "inventory-expected-blocks.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.blocks = [...manifest.blocks.filter((block) => !String(block.id).startsWith(`${areaId}-osm-`)), ...additions];
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Imported ${additions.length} clipped intersection blocks for ${areaId}; ${additions.filter((block) => !block.excluded).length} require public-road coverage.`);

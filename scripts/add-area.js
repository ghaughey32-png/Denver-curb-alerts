const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { auditInventory } = require("./lib/inventory-auditor.js");
const { bumpAssetVersions } = require("./lib/asset-versions.js");

const ROOT = path.join(__dirname, "..");
const AREAS_PATH = path.join(ROOT, "data", "coverage-pilot-areas.json");
const MANIFEST_PATH = path.join(ROOT, "data", "inventory-expected-blocks.json");
const INVENTORY_PATH = path.join(ROOT, "public", "denver-west-routes.json");
const README_PATH = path.join(ROOT, "README.md");
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
// Ways are clipped to the requested rectangle, but the importer names each block
// after the cross streets at its endpoints, and it can only do that for ways it
// actually has. Fetching a slightly larger extract keeps those labels populated
// along the edges.
const EXTRACT_PADDING_DEGREES = 0.002;

const USAGE = `Usage: node scripts/add-area.js <area-id> [options]

Required:
  --label   "<north>–<south>, <west>–<east>"   human label for the pilot area
  --summary "<north>–<south> from <west>–<east>"  phrase added to the payload label
  --south <lat> --west <lon> --north <lat> --east <lon>

Optional:
  --readme  <phrase>   README wording (defaults to --summary)
  --osm     <file>     use an existing .osm extract instead of querying Overpass
  --origin  <url>      APP_ORIGIN for the Denver crawl (default http://127.0.0.1:3000)
  --tag     <slug>     asset cache-busting tag (default <yyyymmdd>-<area-id>)
  --skip-map           import and sync only; do not query Denver
  --no-version         leave the public/ asset versions alone`;

function parseArguments(argv) {
  const [areaId, ...rest] = argv;
  if (!areaId || areaId.startsWith("--")) throw new Error(USAGE);

  const flags = { origin: "http://127.0.0.1:3000" };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}\n\n${USAGE}`);
    const name = token.slice(2);
    if (name === "skip-map" || name === "no-version") {
      flags[name] = true;
      continue;
    }
    const value = rest[index += 1];
    if (value === undefined) throw new Error(`Flag --${name} needs a value\n\n${USAGE}`);
    flags[name] = value;
  }

  for (const required of ["label", "summary", "south", "west", "north", "east"]) {
    if (!flags[required]) throw new Error(`Missing --${required}\n\n${USAGE}`);
  }

  const bounds = {
    south: Number(flags.south), west: Number(flags.west),
    north: Number(flags.north), east: Number(flags.east)
  };
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${flags[name]}`);
  }
  if (bounds.south >= bounds.north) throw new Error("--south must be below --north");
  if (bounds.west >= bounds.east) throw new Error("--west must be west of --east");

  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return {
    areaId,
    label: flags.label,
    summary: flags.summary,
    readme: flags.readme || flags.summary,
    bounds,
    osmPath: flags.osm || null,
    origin: flags.origin,
    tag: flags.tag || `${today}-${areaId}`,
    skipMap: Boolean(flags["skip-map"]),
    skipVersion: Boolean(flags["no-version"])
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const overlaps = (a, b) => a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;

function step(message) {
  console.log(`\n→ ${message}`);
}

function run(scriptRelativePath, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, scriptRelativePath), ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) throw new Error(`${scriptRelativePath} exited with status ${result.status}`);
}

async function fetchExtract(areaId, bounds) {
  const target = path.join(ROOT, "data", `osm-extract-${areaId}.osm`);
  if (fs.existsSync(target)) {
    console.log(`  reusing cached extract ${path.relative(ROOT, target)}`);
    return target;
  }

  const box = [
    bounds.south - EXTRACT_PADDING_DEGREES, bounds.west - EXTRACT_PADDING_DEGREES,
    bounds.north + EXTRACT_PADDING_DEGREES, bounds.east + EXTRACT_PADDING_DEGREES
  ].join(",");
  const query = `[out:xml][timeout:180];\n(\n  way["highway"](${box});\n);\n(._;>;);\nout meta;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      console.log(`  querying ${new URL(endpoint).host} (attempt ${attempt})`);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          // Overpass answers 406 to requests that arrive without a User-Agent,
          // which is what Node sends by default.
          headers: { "User-Agent": "denver-curb-alerts pipeline (scripts/add-area.js)" },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(180000)
        });
        const body = await response.text();
        // Overpass reports "server is probably too busy" as a 200 with an HTML
        // body, so the presence of way elements is the only reliable success test.
        if (response.ok && body.includes("<way")) {
          fs.writeFileSync(target, body, "utf8");
          console.log(`  wrote ${path.relative(ROOT, target)} (${(body.length / 1e6).toFixed(1)} MB)`);
          return target;
        }
        console.log(`  no usable payload (HTTP ${response.status})`);
      } catch (error) {
        console.log(`  request failed: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
  throw new Error("Overpass never returned a usable extract; retry later or pass --osm");
}

function measureCoverage(areaId) {
  const inventory = readJson(INVENTORY_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const blocks = manifest.blocks.filter((block) => String(block.id).startsWith(`${areaId}-osm-`) && !block.excluded);
  const audit = auditInventory({ routes: inventory.routes, blocks, generateUnavailable: false });
  return { blocks: blocks.length, counts: audit.report.counts, gaps: audit.unexplainedGaps };
}

// Every step after the first writes something. The heavyweight artifacts (the
// block manifest, the published inventory) are rewritten idempotently by the
// scripts that own them, so a failed run can simply be re-run. The two small
// curated files cannot — a half-added area entry or a duplicated README phrase
// would survive and quietly corrupt the next run, so they are restored on error.
function snapshotCuratedFiles() {
  const files = [AREAS_PATH, README_PATH];
  const contents = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));
  return () => {
    for (const [file, content] of contents) {
      if (fs.readFileSync(file, "utf8") !== content) {
        fs.writeFileSync(file, content, "utf8");
        console.error(`  restored ${path.relative(ROOT, file)}`);
      }
    }
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const areasDocument = readJson(AREAS_PATH);

  if (areasDocument.areas.some((area) => area.id === options.areaId)) {
    throw new Error(`Area ${options.areaId} is already in data/coverage-pilot-areas.json`);
  }
  const collisions = areasDocument.areas.filter((area) => overlaps(options.bounds, area));
  if (collisions.length) {
    throw new Error(`Rectangle overlaps ${collisions.map((area) => area.id).join(", ")}; areas must tile, not stack`);
  }

  const rollback = snapshotCuratedFiles();
  try {
    await addArea(options, areasDocument);
  } catch (error) {
    console.error("\nFailed part-way through; rolling the curated files back.");
    rollback();
    throw error;
  }
}

async function addArea(options, areasDocument) {
  step(`Recording ${options.areaId} in data/coverage-pilot-areas.json`);
  areasDocument.areas.push({
    id: options.areaId,
    label: options.label,
    north: options.bounds.north,
    south: options.bounds.south,
    west: options.bounds.west,
    east: options.bounds.east,
    published: true
  });
  writeJson(AREAS_PATH, areasDocument);

  step("Fetching the OpenStreetMap extract");
  const osmPath = options.osmPath || await fetchExtract(options.areaId, options.bounds);

  step("Importing expected blocks");
  run("scripts/import-osm-expected-blocks.js", [
    osmPath, options.areaId,
    String(options.bounds.south), String(options.bounds.west),
    String(options.bounds.north), String(options.bounds.east)
  ]);

  if (options.skipMap) {
    console.log("\n  --skip-map: leaving the Denver crawl for a later run");
  } else {
    step(`Mapping against Denver via ${options.origin}`);
    run("scripts/map-area-approach-3.js", [options.areaId], { APP_ORIGIN: options.origin });
  }

  step("Reconciling published coverage");
  run("scripts/sync-expected-coverage.js", []);

  step("Measuring the published result");
  const measured = measureCoverage(options.areaId);
  console.log(`  ${JSON.stringify(measured.counts)}`);
  if (measured.counts["unexplained-gap"] > 0) {
    throw new Error(`${measured.counts["unexplained-gap"]} blocks are still unexplained gaps; the area is not publishable yet`);
  }

  step("Recording the coverage expectations and labels");
  const saved = readJson(AREAS_PATH);
  const area = saved.areas.find((candidate) => candidate.id === options.areaId);
  area.coverage = {
    testName: options.summary,
    expectedPublicBlocks: measured.blocks,
    minimumScheduled: measured.counts.scheduled
  };
  saved.payloadAreaLabel.segments.push(options.summary);
  writeJson(AREAS_PATH, saved);

  const readme = fs.readFileSync(README_PATH, "utf8");
  const anchor = "; and the existing";
  if (!readme.includes(anchor)) throw new Error("Could not find the README inventory sentence to extend");
  fs.writeFileSync(README_PATH, readme.replace(anchor, `; ${options.readme}${anchor}`), "utf8");

  step("Re-running sync so the payload carries the new label");
  run("scripts/sync-expected-coverage.js", []);

  if (options.skipVersion) {
    console.log("\n  --no-version: public/ asset versions left untouched");
  } else {
    step("Bumping the versioned asset constants");
    const { previous, next } = bumpAssetVersions(options.tag);
    console.log(`  tag  ${previous.assetTag} → ${next.assetTag}`);
    console.log(`  json v${previous.inventoryVersion} → v${next.inventoryVersion}, cache v${previous.inventoryCacheVersion} → v${next.inventoryCacheVersion}, shell v${previous.shellVersion} → v${next.shellVersion}`);
  }

  console.log(`\n${options.areaId}: ${measured.counts.scheduled} scheduled, ${measured.counts.unavailable} unavailable, 0 unexplained gaps.`);
  console.log("Next: npm run audit:inventory, then commit.");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});

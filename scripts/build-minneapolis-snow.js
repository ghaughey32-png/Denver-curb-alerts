// Builds public/minneapolis-snow.json, the Minneapolis snow emergency curb map, from three City of
// Minneapolis open datasets. The rules for turning polygons into curbs, and for what happens where the
// city's datasets disagree, are in scripts/lib/minneapolis-snow.js.
//
//   npm run build:mpls-snow                 build from the cached downloads, fetching any missing
//   npm run build:mpls-snow -- --refresh    fetch everything again (the season refresh)
//   npm run build:mpls-snow -- --dry-run    build and report, write nothing to public/
//
// This is not a Denver crawl: the city serves its data as ordinary ArcGIS feature services, about
// thirty paged requests in all, and the downloads are cached under data/mpls-snow-cache/ so a rebuild
// after a logic change needs no network at all.
//
// Two gates stand between a build and the published file, in the spirit of assertNoCoverageCollapse
// in scripts/build-static-inventory.js: the curb count may not fall more than MAX_CURB_DROP below the
// published file's, and the published curbs are checked against tickets the city actually wrote in
// past snow emergencies. A ticket whose nearby curbs all say "you may park" is a driver the app would
// have told to stay; past MAX_CONTRADICTED_RATE the build refuses to publish.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { buildSnowCurbs, checkAgainstTickets } = require("./lib/minneapolis-snow.js");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "mpls-snow-cache");
const OUTPUT_PATH = path.join(ROOT, "public", "minneapolis-snow.json");
const REPORT_PATH = path.join(ROOT, "data", "mpls-snow-report.json");
const SERVICE_ROOT = "https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services";

const SOURCES = {
  strips: {
    service: "Snow_Emergency_Routes",
    outFields: "OBJECTID,DAY1,DAY2,DAY3,WINTERRULES"
  },
  centrelines: {
    service: "PW_Street_Centerline",
    outFields: "OBJECTID,STREET_O_NAME,SNOW_EMERGENCY_ROUTE,JURISDICTION"
  },
  addresses: {
    service: "EAS_Addresses",
    outFields: "AddrNum,StreetName,StreetType,PostDir",
    where: "StatusCode='ACTIVE' AND IsAlias='N'"
  }
};

// Tickets written in past snow emergencies, one service per emergency, named by the city
// Snow_Emergency_<Name>_Tags_<year>. Add each new season's as the city publishes them.
const TICKET_SERVICES = ["Snow_Emergency_Bridge_Tags_2025", "Snow_Emergency_Jefferson_Tags_2025"];

const MAX_CURB_DROP = 0.1;
const MAX_CONTRADICTED_RATE = 0.05;
const USER_AGENT = "CurbAlerts/1.0 (+https://www.curbalerts.co; support@curbalerts.co)";

function getJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, timeout: 60000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200 || body.error) {
            throw new Error(`HTTP ${response.statusCode}: ${JSON.stringify(body.error || body).slice(0, 200)}`);
          }
          resolve(body);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  }).catch(async (error) => {
    if (attempt >= 4) throw new Error(`${url}: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    return getJson(url, attempt + 1);
  });
}

// Pages through a layer at its own maxRecordCount, which differs by service (2,000 for the snow
// strips, 1,000 for the centrelines, 16,000 for the addresses); asking for more than the service
// allows silently returns less, which is how a first attempt got 7,000 of 13,021 centrelines.
async function fetchLayer(service, { outFields, where = "1=1", returnGeometry = true }) {
  const layerUrl = `${SERVICE_ROOT}/${service}/FeatureServer/0`;
  const meta = await getJson(`${layerUrl}?f=json`);
  const pageSize = Math.min(Number(meta.maxRecordCount) || 1000, 16000);
  const { count } = await getJson(`${layerUrl}/query?${new URLSearchParams({ where, returnCountOnly: "true", f: "json" })}`);
  const features = [];
  for (let offset = 0; offset < count; offset += pageSize) {
    const params = new URLSearchParams({
      where,
      outFields,
      returnGeometry: String(returnGeometry),
      outSR: "4326",
      geometryPrecision: "7",
      orderByFields: meta.objectIdField || "OBJECTID",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "json"
    });
    const page = await getJson(`${layerUrl}/query?${params}`);
    features.push(...(page.features || []));
    process.stdout.write(`  ${service}: ${features.length}/${count}\r`);
  }
  process.stdout.write("\n");
  if (features.length !== count) {
    throw new Error(`${service}: fetched ${features.length} features but the service reports ${count}.`);
  }
  return { features, dataEditedAt: meta.editingInfo?.dataLastEditDate || null, fetchedAt: new Date().toISOString() };
}

async function loadCached(name, service, options, refresh) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!refresh && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  console.log(`Fetching ${service}...`);
  const layer = await fetchLayer(service, options);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(layer));
  return layer;
}

function readPublished() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Only what the page and the server read goes out: a curb carries its city reading and conflict
// notes only when they differ from the published rule, which is about 2% of curbs.
function slimCurb(curb) {
  const out = { id: curb.id, street: curb.street, sideKey: curb.sideKey, days: curb.days };
  if (curb.parity) out.parity = curb.parity;
  if (curb.conflicts.length) {
    out.cityDays = curb.cityDays;
    out.conflicts = curb.conflicts;
  }
  out.geometry = curb.geometry;
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const dryRun = args.includes("--dry-run");

  const strips = await loadCached("strips", SOURCES.strips.service, SOURCES.strips, refresh);
  const centrelines = await loadCached("centrelines", SOURCES.centrelines.service, SOURCES.centrelines, refresh);
  const addresses = await loadCached("addresses", SOURCES.addresses.service, SOURCES.addresses, refresh);
  const ticketLayers = [];
  for (const service of TICKET_SERVICES) {
    ticketLayers.push(
      await loadCached(`tickets-${service}`, service, { outFields: "Day,Address,Latitude,Longitude", returnGeometry: false }, refresh)
    );
  }

  const previous = readPublished();
  console.log("Building curbs...");
  const { curbs, report } = buildSnowCurbs({
    strips: strips.features,
    centrelineFeatures: centrelines.features,
    addressFeatures: addresses.features,
    previousCurbs: previous?.curbs || []
  });

  const tickets = ticketLayers.flatMap((layer) => layer.features.map((feature) => feature.attributes));
  report.tickets = { services: TICKET_SERVICES, ...checkAgainstTickets(curbs, tickets) };

  const payload = {
    city: "minneapolis",
    generatedAt: new Date().toISOString(),
    sources: {
      strips: { service: SOURCES.strips.service, dataEditedAt: strips.dataEditedAt, fetchedAt: strips.fetchedAt },
      centrelines: { service: SOURCES.centrelines.service, dataEditedAt: centrelines.dataEditedAt, fetchedAt: centrelines.fetchedAt },
      addresses: { service: SOURCES.addresses.service, dataEditedAt: addresses.dataEditedAt, fetchedAt: addresses.fetchedAt }
    },
    curbs: curbs.map(slimCurb)
  };
  const serialized = JSON.stringify(payload);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify({ ...report, payloadBytes: serialized.length }, null, 2)}\n`);

  console.log(`Strips ${report.strips}; curbs ${report.curbs}; unmatched strips ${report.stripsUnmatched}; no geometry ${report.stripsWithoutGeometry}; unreadable days ${report.stripsWithUnreadableDays}`);
  console.log(`Side parity from addresses: ${JSON.stringify(report.parity)}`);
  console.log(`Made stricter where city sources disagree: ${JSON.stringify(report.conflicts)}`);
  console.log(`Ids carried forward ${report.idsCarriedForward}, retired ${report.idsRetired}`);
  let worstContradicted = 0;
  Object.entries(report.tickets.byDay).forEach(([day, bucket]) => {
    const placed = bucket.explained + bucket.contradicted;
    const rate = placed ? bucket.contradicted / placed : 0;
    worstContradicted = Math.max(worstContradicted, rate);
    console.log(
      `Day ${day} tickets: ${bucket.tickets}; explained ${bucket.explained} (${((bucket.explained / (placed || 1)) * 100).toFixed(1)}% of placed); ` +
        `contradicted ${bucket.contradicted}; no curb within 20 m ${bucket.noCurb}`
    );
  });
  console.log(`Payload ${(serialized.length / 1e6).toFixed(2)} MB. Report written to ${path.relative(ROOT, REPORT_PATH)}.`);

  if (worstContradicted > MAX_CONTRADICTED_RATE) {
    throw new Error(
      `Refusing to publish: ${(worstContradicted * 100).toFixed(1)}% of a day's placed tickets fall on curbs this build says are legal ` +
        `(limit ${MAX_CONTRADICTED_RATE * 100}%).`
    );
  }
  const previousCount = previous?.curbs?.length || 0;
  if (previousCount && curbs.length < previousCount * (1 - MAX_CURB_DROP) && process.env.ALLOW_COVERAGE_DROP !== "1") {
    throw new Error(
      `Refusing to publish: ${curbs.length} curbs against ${previousCount} published. Set ALLOW_COVERAGE_DROP=1 if the city really removed them.`
    );
  }
  if (dryRun) {
    console.log("Dry run: public/minneapolis-snow.json left unchanged.");
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, serialized);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

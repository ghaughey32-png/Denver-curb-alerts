// Builds public/boston-sweeping.json, the Boston street sweeping curb map, from the City of Boston's
// open data. The rules for placing schedule rows on streets, and the shape of a curb, are in
// scripts/lib/boston-sweeping.js.
//
//   npm run build:boston-sweeping                 build from the cached downloads, fetching any missing
//   npm run build:boston-sweeping -- --refresh    fetch everything again
//   npm run build:boston-sweeping -- --dry-run    build and report, write nothing to public/
//
// This is not a Denver crawl: the schedule is one CSV (9fdbdcad-..., about 3,800 rows) and the street
// layer one GeoJSON file (about 22 MB), both from data.boston.gov. Downloads are cached under
// data/boston-sweeping-cache/, so a rebuild after a logic change needs no network at all.
//
// Boston publishes no current ticket data, so the gates are the join itself: a schedule row is published
// only if the path found for it is within the length band of the row's own `miles` AND its `losta`/`hista`
// stations (feet along the street, which the join never reads) agree with where the path sits. Two gates stand
// between a build and the published file: the confident share of odd/even rows may not fall below
// MIN_CONFIDENT_SHARE (nor more than a point below the published file's), and the curb count may not
// fall more than MAX_CURB_DROP below the published file's (ALLOW_COVERAGE_DROP=1 overrides). The floor can
// be waived once with --accept-below-floor, which is written into the payload as `belowFloor`.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { parseCsv, buildBostonCurbs } = require("./lib/boston-sweeping.js");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "boston-sweeping-cache");
const OUTPUT_PATH = path.join(ROOT, "public", "boston-sweeping.json");
const REPORT_PATH = path.join(ROOT, "data", "boston-sweeping-report.json");
const SCHEDULE_RESOURCE = "9fdbdcad-67c8-4b23-b6ec-861e77d56227";
const SCHEDULE_URL = `https://data.boston.gov/datastore/dump/${SCHEDULE_RESOURCE}?format=csv`;
const SEGMENTS_URL =
  "https://data.boston.gov/dataset/b9b8b634-f28a-410f-9727-b53d0d006308/resource/e850cfd2-2c6e-4af6-9ac4-e03019412d1e/download/boston_street_segments_sam_system.geojson";

const MIN_CONFIDENT_SHARE = 0.9;
const MAX_SHARE_DROP = 0.01;
const MAX_CURB_DROP = 0.1;
const USER_AGENT = "CurbAlerts/1.0 (+https://www.curbalerts.co; support@curbalerts.co)";

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: 180000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) reject(new Error(`${url}: HTTP ${response.statusCode}`));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

async function loadCached(name, url, refresh) {
  const file = path.join(CACHE_DIR, name);
  if (!refresh && fs.existsSync(file)) return { text: fs.readFileSync(file, "utf8"), fetchedAt: fs.statSync(file).mtime.toISOString() };
  console.log(`Fetching ${name}...`);
  const text = await download(url);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, text);
  return { text, fetchedAt: new Date().toISOString() };
}

function readPublished() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a");

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const dryRun = args.includes("--dry-run");
  // A deliberate, recorded exception to the confident-share floor. The payload says so, so a published
  // file can never be mistaken for one that cleared the bar.
  const acceptBelowFloor = args.includes("--accept-below-floor");

  const schedule = await loadCached("schedule.csv", SCHEDULE_URL, refresh);
  const segments = await loadCached("segments.geojson", SEGMENTS_URL, refresh);
  const rows = parseCsv(schedule.text);
  const features = JSON.parse(segments.text).features;
  if (rows.length < 3000 || features.length < 15000) {
    throw new Error(`Refusing to build: ${rows.length} schedule rows and ${features.length} street segments look like a partial download.`);
  }

  console.log("Building curbs...");
  const { curbs, report } = buildBostonCurbs({ rows, features });
  const previous = readPublished();

  const payload = {
    city: "boston",
    generatedAt: new Date().toISOString(),
    source: {
      schedule: { resource: SCHEDULE_RESOURCE, fetchedAt: schedule.fetchedAt },
      segments: { dataset: "boston-street-segments-sam-system", fetchedAt: segments.fetchedAt }
    },
    curbs
  };
  const serialized = JSON.stringify(payload);

  const { unpublished, rowsEndingBeforeStart, ...summary } = report;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(
    REPORT_PATH,
    `${JSON.stringify({ ...summary, rowsEndingBeforeStart, unpublished, payloadBytes: serialized.length }, null, 2)}\n`
  );

  console.log(`Rows ${report.rows}; odd/even ${report.oddEvenRows}; curbs ${report.curbs} (${report.medianCurbs} median)`);
  console.log(
    `Odd/even rows placed confidently: ${report.confidentOddEvenRows} of ${report.oddEvenRows} (${percent(report.confidentOddEvenRows, report.oddEvenRows)})`
  );
  console.log(`All rows: confident ${report.confidentRows} (${report.confidentLeafEndRows} using a leaf end), partial ${report.partialRows}, unpublished ${report.rows - report.confidentRows}`);
  console.log(
    `Station check: ${report.stations.agree} agree, ${report.stations.mismatch} withdrawn, ${report.stations.unchecked} unchecked (alone on their street); ` +
      `odd/even rows confident AND station-checked: ${percent(report.confidentCheckedOddEvenRows, report.oddEvenRows)}`
  );
  console.log(`Length fit of confident rows: ${JSON.stringify(report.confidentRatios)}`);
  console.log(`Why rows are not published: ${JSON.stringify(report.statuses)}`);
  console.log(`Sides guessed from convention on ${report.ambiguousSideSegments} segment sides; ${report.rowsEndingBeforeStart.length} rows end before they start`);
  console.log(`Overnight curbs ${report.overnightCurbs}; standing (every-night) curbs ${report.standingCurbs}`);
  console.log(`Payload ${(serialized.length / 1e6).toFixed(2)} MB. Report written to ${path.relative(ROOT, REPORT_PATH)}.`);

  if (report.confidentShare < MIN_CONFIDENT_SHARE) {
    if (!acceptBelowFloor) {
      throw new Error(
        `Refusing to publish: ${(report.confidentShare * 100).toFixed(1)}% of odd/even rows placed confidently (floor ${MIN_CONFIDENT_SHARE * 100}%). ` +
          "Pass --accept-below-floor to publish anyway; the payload will record that."
      );
    }
    console.log(`NOTE: ${(report.confidentShare * 100).toFixed(1)}% is below the ${MIN_CONFIDENT_SHARE * 100}% floor; publishing anyway because --accept-below-floor was passed.`);
    payload.belowFloor = { floor: MIN_CONFIDENT_SHARE, share: Number(report.confidentShare.toFixed(4)), acceptedAt: new Date().toISOString() };
  }
  const previousShare = previous?.confidentShare;
  if (previousShare && report.confidentShare < previousShare - MAX_SHARE_DROP) {
    throw new Error(
      `Refusing to publish: confident share fell from ${(previousShare * 100).toFixed(1)}% to ${(report.confidentShare * 100).toFixed(1)}%.`
    );
  }
  payload.confidentShare = Number(report.confidentShare.toFixed(4));
  const previousCount = previous?.curbs?.length || 0;
  if (previousCount && curbs.length < previousCount * (1 - MAX_CURB_DROP) && process.env.ALLOW_COVERAGE_DROP !== "1") {
    throw new Error(
      `Refusing to publish: ${curbs.length} curbs against ${previousCount} published. Set ALLOW_COVERAGE_DROP=1 if the city really removed them.`
    );
  }
  if (dryRun) {
    console.log("Dry run: public/boston-sweeping.json left unchanged.");
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload));
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

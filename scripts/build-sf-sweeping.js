// Builds public/sf-sweeping.json, the San Francisco street sweeping curb map, from the City and County
// of San Francisco's open data. The rules for turning rows into curbs, and the shape of a curb, are in
// scripts/lib/sf-sweeping.js.
//
//   npm run build:sf-sweeping                 build from the cached downloads, fetching any missing
//   npm run build:sf-sweeping -- --refresh    fetch everything again
//   npm run build:sf-sweeping -- --dry-run    build and report, write nothing to public/
//
// This is not a Denver crawl: the schedule is one dataset (yhqp-riqs, about 38,000 rows) read in four
// pages, plus one page-set of recent street cleaning tickets (ab4h-6ztd) for the gate. Downloads are
// cached under data/sf-sweeping-cache/, so a rebuild after a logic change needs no network at all.
//
// Two gates stand between a build and the published file, as in scripts/build-minneapolis-snow.js:
// the curb count may not fall more than MAX_CURB_DROP below the published file's, and the curbs are
// checked against street cleaning tickets the city actually wrote. A ticket no nearby curb explains
// is a driver the app would have told to stay; past MAX_CONTRADICTED_RATE of matched tickets the
// build refuses to publish. The gate is the overall figure. Daytime and overnight blocks are
// reported apart because overnight windows are known to be weaker (HISTORY.md, "SF missing blocks
// and time windows, explained"), and that weakness is the reason overnight copy stays hedged.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { buildSfCurbs, checkAgainstTickets } = require("./lib/sf-sweeping.js");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "data", "sf-sweeping-cache");
const OUTPUT_PATH = path.join(ROOT, "public", "sf-sweeping.json");
const REPORT_PATH = path.join(ROOT, "data", "sf-sweeping-report.json");
const SODA_ROOT = "https://data.sf.gov/resource";
const SWEEPING_DATASET = "yhqp-riqs";
const TICKET_DATASET = "ab4h-6ztd";

const PAGE_SIZE = 10000;
const TICKET_SAMPLE = 30000;
const MAX_CURB_DROP = 0.1;
const MAX_CONTRADICTED_RATE = 0.05;
const USER_AGENT = "CurbAlerts/1.0 (+https://www.curbalerts.co; support@curbalerts.co)";

function getJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, timeout: 120000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`);
          resolve(JSON.parse(text));
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

// Pages a Socrata dataset. The sort key must be stable between pages or rows repeat and vanish across
// them; :id is the row's own, and a count mismatch fails the build rather than publish a partial map.
async function fetchRows(dataset, { select, where, order, limit }) {
  const total = limit ?? Number((await getJson(`${SODA_ROOT}/${dataset}.json?${new URLSearchParams({ $select: "count(*)", ...(where ? { $where: where } : {}) })}`))[0].count);
  const rows = [];
  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      $limit: String(Math.min(PAGE_SIZE, total - offset)),
      $offset: String(offset),
      $order: order
    });
    if (select) params.set("$select", select);
    if (where) params.set("$where", where);
    const page = await getJson(`${SODA_ROOT}/${dataset}.json?${params}`);
    rows.push(...page);
    process.stdout.write(`  ${dataset}: ${rows.length}/${total}\r`);
    if (page.length < Math.min(PAGE_SIZE, total - offset)) break;
  }
  process.stdout.write("\n");
  if (!limit && rows.length !== total) throw new Error(`${dataset}: fetched ${rows.length} rows but the dataset reports ${total}.`);
  return { rows, fetchedAt: new Date().toISOString() };
}

async function loadCached(name, dataset, options, refresh) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Fetching ${dataset}...`);
  const result = await fetchRows(dataset, options);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

function readPublished() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function percent(part, whole) {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const dryRun = args.includes("--dry-run");

  const sweeping = await loadCached("sweeping", SWEEPING_DATASET, { order: ":id" }, refresh);
  // Only the most recent tickets that carry coordinates: the city geocodes with a lag, so the very
  // newest tickets have none. Only the fields the check reads are kept; no plate or citation number.
  const tickets = await loadCached(
    "tickets",
    TICKET_DATASET,
    {
      select: "citation_issued_datetime,citation_location,latitude,longitude",
      where: "violation_desc='STR CLEAN' AND citation_issued_datetime IS NOT NULL AND latitude IS NOT NULL",
      order: "citation_issued_datetime DESC, citation_number",
      limit: TICKET_SAMPLE
    },
    refresh
  );

  const previous = readPublished();
  console.log("Building curbs...");
  const { curbs, report } = buildSfCurbs({ rows: sweeping.rows, previousCurbs: previous?.curbs || [] });
  const check = checkAgainstTickets(curbs, tickets.rows);
  const sampleDates = tickets.rows.map((ticket) => ticket.citation_issued_datetime.slice(0, 10)).sort();
  report.tickets = { dataset: TICKET_DATASET, from: sampleDates[0], to: sampleDates[sampleDates.length - 1], ...check };

  const payload = {
    city: "san-francisco",
    generatedAt: new Date().toISOString(),
    source: { dataset: SWEEPING_DATASET, fetchedAt: sweeping.fetchedAt },
    curbs
  };
  const serialized = JSON.stringify(payload);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify({ ...report, payloadBytes: serialized.length }, null, 2)}\n`);

  console.log(
    `Rows ${report.rows}; curbs ${report.curbs}; no line ${report.rowsWithoutLine}; unreadable ${report.rowsUnreadable}; ` +
      `holiday-only rows ${report.rowsHolidayOnly}`
  );
  console.log(`Overnight (move the night before) curbs ${report.overnightCurbs}; 5th week unconfirmed curbs ${report.week5UnconfirmedCurbs}`);
  console.log(`Sides: ${report.sideDisagreesWithCity} disagree with the city's own compass word; ${report.curbsWithOpposite} curbs have an opposite`);
  console.log(`Ids carried forward ${report.idsCarriedForward}, retired ${report.idsRetired}`);
  console.log(`Tickets ${check.tickets} (${report.tickets.from} to ${report.tickets.to}), ${check.unreadable} unreadable`);
  console.log(`  no candidate curb: ${check.noCandidate} (${percent(check.noCandidate, check.tickets)})`);
  console.log(`  consistent: ${check.consistent} of ${check.matched} matched (${percent(check.consistent, check.matched)}); contradicted ${check.contradicted}`);
  console.log(`  daytime blocks:   ${percent(check.daytime.consistent, check.daytime.tickets)} of ${check.daytime.tickets}`);
  console.log(`  overnight blocks: ${percent(check.overnight.consistent, check.overnight.tickets)} of ${check.overnight.tickets}`);
  console.log(`  5th-week days:    ${percent(check.fifthWeek.consistent, check.fifthWeek.tickets)} of ${check.fifthWeek.tickets}`);
  console.log(`Payload ${(serialized.length / 1e6).toFixed(2)} MB. Report written to ${path.relative(ROOT, REPORT_PATH)}.`);

  const contradictedRate = check.matched ? check.contradicted / check.matched : 0;
  if (contradictedRate > MAX_CONTRADICTED_RATE) {
    throw new Error(
      `Refusing to publish: ${(contradictedRate * 100).toFixed(1)}% of matched street cleaning tickets are not explained by these curbs ` +
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
    console.log("Dry run: public/sf-sweeping.json left unchanged.");
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, serialized);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

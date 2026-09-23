// Refreshes the sweep dates on the routes already published, and nothing else.
//
// Denver returns a rolling window of upcoming dates rather than a rule you can evaluate forever,
// so the payload goes stale roughly two months after the crawl that built it. build:inventory is
// the wrong way to fix that: its REGIONS grid covers 10 of the 60 published areas, so a "full
// rebuild" deletes the other 50 and republishes them as pink (see AGENTS.md). This script asks
// Denver about the routes we already have, at their own coordinates, and updates their dates in
// place.
//
// It cannot lose coverage, which is the whole point. No route is ever removed, no geometry is
// touched, and a lookup that fails simply leaves that route's old dates alone. The worst outcome
// of a bad run is that nothing changed.
//
// sweepType is deliberately NOT updated. It decides the curb colour, and a route moving between
// Scheduled, Weekly and Nightly changes what the map tells a driver, so a divergence is reported
// for a human rather than applied silently.
const fs = require("fs");
const path = require("path");
const { runPool } = require("./build-static-inventory.js");
const { bumpInventoryVersion, writeAssetVersionLock } = require("./lib/asset-versions.js");

const APP_ORIGIN = process.env.APP_ORIGIN || "http://127.0.0.1:3000";
const OUTPUT_PATH = path.join(__dirname, "..", "public", "denver-west-routes.json");
// Denver never answers 429. Across 38,461 responses over two days it returned 34,645 200s and
// 3,816 502s and not one rate-limit status, so this is not a limiter saying "slow down" -- it is a
// small city service falling over under concurrent load, which is why it degrades gradually rather
// than switching off, and why recovery takes about a day.
//
// That makes concurrency the lever that matters. A rate limiter counts requests however they
// arrive; an overloaded backend cares how many are in flight at once. So the refresh runs gentler
// than the crawler it borrows runPool from: one request at a time, with a longer breather between
// rounds. It is slower and it is meant to be -- this is a background job that has all day, and the
// two runs that tried to hurry got nothing written on the second one.
//
// Override for a machine or a day where Denver is livelier:
//   npm run refresh:schedules -- --concurrency=2 --round-pause=20 --round-size=600
const REFRESH_CONCURRENCY = 1;
const ROUND_PAUSE_MS = 30000;
// Smaller rounds than the crawler's 1200 because every round is a checkpoint: at one request at a
// time this saves progress about every seven minutes instead of every twenty.
const ROUND_SIZE = 600;

// Numeric --flag=value, falling back to the default when absent or nonsense. A typo must not
// silently turn the gentle profile into the one that has already failed twice.
function readNumericFlag(args, name, fallback) {
  const raw = args.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.split("=")[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CHECKPOINT_PATH = path.join(__dirname, "..", "data", "schedule-refresh-checkpoint.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A full refresh is tens of thousands of lookups and Denver will throttle before the end of one.
// Writing only at the end therefore means never finishing: that first abort discarded 11,216
// refreshed routes. So every round is persisted, and the checkpoint records which routes are
// already done so the next run picks up instead of starting over.
function readCheckpoint(maxAgeHours = 36) {
  try {
    const saved = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
    const ageHours = (Date.now() - new Date(saved.updatedAt).getTime()) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) return null;
    return { ids: new Set(saved.refreshedIds || []), ageHours };
  } catch {
    return null;
  }
}

function writeCheckpoint(state) {
  fs.writeFileSync(
    CHECKPOINT_PATH,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), refreshedIds: [...state.refreshedIds] }, null, 2)}\n`,
    "utf8"
  );
}

function clearCheckpoint() {
  try {
    fs.unlinkSync(CHECKPOINT_PATH);
  } catch {
    /* nothing to clear */
  }
}

const hasGeometry = (route) => Array.isArray(route.map && route.map.path) && route.map.path.length >= 1;

// Only routes that carry a real Denver schedule. A pink fallback has no dates to refresh by
// definition, and asking about one would just rediscover that Denver has nothing there.
function selectRefreshableRoutes(routes) {
  return routes.filter((route) => route.sweepType !== "Unavailable" && hasGeometry(route));
}

// The middle of a route's own geometry, which is the point most likely to sit on it. path[0] is an
// endpoint and endpoints land on intersections, where Denver may answer about the cross street.
function getLookupPoint(route) {
  const p = route.map.path;
  return p[Math.floor(p.length / 2)];
}

// One point per still-stale route, deduplicated: neighbouring routes can share a midpoint, and
// asking twice wastes a request against a service that is already rate-limiting us.
function buildLookupPoints(routes, refreshedIds, roundSize = ROUND_SIZE) {
  const seen = new Set();
  const points = [];
  for (const route of routes) {
    if (refreshedIds.has(String(route.id))) continue;
    const [lat, lon] = getLookupPoint(route);
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ lat, lon });
    if (points.length >= roundSize) break;
  }
  return points;
}

// Applies one round's answers. Mutates the routes in `byId`, which are the payload's own objects.
function applyRefresh(byId, summaries, state) {
  for (const summary of summaries) {
    if (!summary || !Array.isArray(summary.routes)) continue;
    for (const fresh of summary.routes) {
      const route = byId.get(String(fresh.id));
      if (!route) continue;

      state.refreshedIds.add(String(fresh.id));

      if (fresh.sweepType && fresh.sweepType !== route.sweepType) {
        state.sweepTypeDivergences.push(`${route.id} ${route.streetName}: ${route.sweepType} -> ${fresh.sweepType}`);
      }

      const before = JSON.stringify(route.schedules || []);
      if (Array.isArray(fresh.schedules)) {
        route.schedules = fresh.schedules;
      }
      if (fresh.leftSweepingRule) route.leftSweepingRule = fresh.leftSweepingRule;
      if (fresh.rightSweepingRule) route.rightSweepingRule = fresh.rightSweepingRule;
      if (typeof fresh.isPosted === "boolean") route.isPosted = fresh.isPosted;

      if (JSON.stringify(route.schedules || []) !== before) state.changed += 1;
    }
  }
}

function describeDateRange(routes) {
  const dates = new Set();
  for (const route of routes) {
    for (const entry of route.schedules || []) {
      const m = String(entry.Date || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) dates.add(`${m[3]}-${m[1]}-${m[2]}`);
    }
  }
  const sorted = [...dates].sort();
  return { first: sorted[0] || null, last: sorted[sorted.length - 1] || null, count: sorted.length };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const noResume = args.includes("--no-resume");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
  const concurrency = readNumericFlag(args, "concurrency", REFRESH_CONCURRENCY);
  const roundSize = readNumericFlag(args, "round-size", ROUND_SIZE);
  const roundPauseMs = readNumericFlag(args, "round-pause", ROUND_PAUSE_MS / 1000) * 1000;

  const payload = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  const routesBefore = payload.routes.length;
  const targets = selectRefreshableRoutes(payload.routes).slice(0, limit);
  const byId = new Map(targets.map((route) => [String(route.id), route]));

  const rangeBefore = describeDateRange(payload.routes);
  console.log(`Payload: ${routesBefore} routes, ${targets.length} with a real schedule to refresh.`);
  console.log(`Dates now: ${rangeBefore.first} -> ${rangeBefore.last} (${rangeBefore.count} distinct)`);
  console.log(`Pace: ${concurrency} request(s) at a time, ${roundSize} per round, ${roundPauseMs / 1000}s between rounds.`);

  const state = { refreshedIds: new Set(), changed: 0, sweepTypeDivergences: [] };

  // Denver throttles before a full pass finishes, so a run is expected to be one of several.
  const resumed = noResume ? null : readCheckpoint();
  if (resumed) {
    for (const id of resumed.ids) if (byId.has(id)) state.refreshedIds.add(id);
    console.log(`Resuming: ${state.refreshedIds.size} route(s) already refreshed ${resumed.ageHours.toFixed(1)}h ago.`);
  }
  console.log("");

  let bumpedThisRun = false;
  const persist = () => {
    payload.generatedAt = new Date().toISOString();
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload)}\n`, "utf8");
    // The payload's bytes move on the first write of a run, so its "?v=" has to move with them or
    // the cache-first service worker serves the old copy from Cache Storage forever. Once per run
    // is enough; later rounds just re-record the lock against the version already bumped to.
    if (!bumpedThisRun) {
      const bumped = bumpInventoryVersion();
      bumpedThisRun = true;
      console.log(`  (bumped the inventory to ?v=${bumped.inventory.next}, shell v${bumped.shell.next})`);
    } else {
      writeAssetVersionLock();
    }
    writeCheckpoint(state);
  };

  let round = 0;
  let throttled = null;

  while (state.refreshedIds.size < targets.length) {
    const points = buildLookupPoints(targets, state.refreshedIds, roundSize);
    if (!points.length) break;

    round += 1;
    const before = state.refreshedIds.size;
    const urls = points.map((p) => `${APP_ORIGIN}/api/denver/sweeping?latitude=${p.lat}&longitude=${p.lon}`);
    console.log(`Round ${round}: asking about ${urls.length} points (${targets.length - before} routes still stale)`);

    let summaries;
    try {
      summaries = await runPool(urls, { concurrency });
    } catch (error) {
      // The abort guard is doing its job. Everything refreshed so far is real and worth keeping,
      // so stop asking and fall through to the write rather than throwing it all away.
      if (/throttl/i.test(error.message)) {
        throttled = error.message;
        break;
      }
      throw error;
    }

    applyRefresh(byId, summaries, state);
    const gained = state.refreshedIds.size - before;
    console.log(`  refreshed ${gained} more route(s); ${state.refreshedIds.size}/${targets.length} done`);

    if (payload.routes.length !== routesBefore) {
      throw new Error(`Refusing to continue: route count moved from ${routesBefore} to ${payload.routes.length}. This script must never add or remove a route.`);
    }

    if (!dryRun && state.changed) persist();
    console.log("");

    if (!gained) {
      console.log("Round made no progress; stopping rather than looping.");
      break;
    }

    if (state.refreshedIds.size < targets.length) await sleep(roundPauseMs);
  }

  const stale = targets.length - state.refreshedIds.size;
  const rangeAfter = describeDateRange(payload.routes);

  console.log("=== result ===");
  console.log(`routes refreshed      : ${state.refreshedIds.size} of ${targets.length}`);
  console.log(`  with changed dates  : ${state.changed}`);
  console.log(`left with old dates   : ${stale}`);
  console.log(`dates after           : ${rangeAfter.first} -> ${rangeAfter.last} (${rangeAfter.count} distinct)`);

  if (state.sweepTypeDivergences.length) {
    console.log(`\nsweepType divergences NOT applied (they change curb colour; review by hand): ${state.sweepTypeDivergences.length}`);
    state.sweepTypeDivergences.slice(0, 20).forEach((line) => console.log(`  ${line}`));
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  if (!state.changed) {
    console.log("\nNo dates changed; leaving the payload and its version alone.");
    return;
  }

  if (throttled) {
    console.log(`\nStopped early: ${throttled}`);
    console.log(`Everything refreshed so far IS written. Re-run in a few hours to pick up the remaining ${stale}; it resumes from the checkpoint automatically.`);
  } else {
    clearCheckpoint();
    console.log("\nEvery route refreshed. Checkpoint cleared.");
  }

  console.log("Run npm test before committing.");
}

module.exports = {
  selectRefreshableRoutes,
  getLookupPoint,
  buildLookupPoints,
  applyRefresh,
  describeDateRange,
  readNumericFlag,
  readCheckpoint,
  writeCheckpoint,
  clearCheckpoint,
  CHECKPOINT_PATH
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

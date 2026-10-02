# AGENTS.md

Instructions for any AI coding tool working in this repo (Claude Code, Codex, and anything else).
This is the single source of truth. `CLAUDE.md` is a pointer to this file and must stay a pointer.

**This file holds the rules; [HISTORY.md](HISTORY.md) holds the reasons.** Each rule here is kept to
a sentence or two, and a *why:* pointer names the `HISTORY.md` section that records the measurement
or incident behind it. Do not read `HISTORY.md` whole — it is about 160 KB. `grep` it for the named
section when you are about to change, work around, or argue with a rule, and read that section
first: most of these rules were learned by getting them wrong once. New durable rules go here as
one or two sentences; the investigation that produced them goes in `HISTORY.md`, dated.

## What this is

**Denver Curb Alerts** — a street-sweeping / parking-ticket-avoidance app for Denver: a website
(map only) and an iPhone app (map plus reminders, sold by subscription). It proxies the city's
public sweeping API, draws curb segments on a Leaflet map, separates left-side from right-side
sweeping rules, and schedules reminders.

Deliberately minimal stack:

- `server.js` — a zero-framework `node:http` server. Static files + `/api/*`. No Express.
- `lib/accounts.js`, `lib/email.js`, `lib/events.js`, `lib/apns.js` — the only server runtime outside
  `server.js`. `accounts.js` is pure; `email.js` is pure apart from `sendEmail`.
- `public/app.js` — the entire client, vanilla JS loaded by a plain `<script>` tag.
- **No bundler, no transpiler, no build step for client code.** What is in `public/` is what ships.
- Two dependencies (`pg`, `web-push`), both lazily `require`d so the app boots without
  `npm install`. Accounts, email, Apple push and the removed Stripe integration added none —
  `node:crypto`, `node:https` and `node:http2` cover them.
- CommonJS everywhere, including tests and scripts. There is no `"type": "module"`.
- `ios/` — the SwiftUI shell, which bundles `public/` and implements the native bridge.

Storage is Postgres when `DATABASE_URL` is set, JSON files under `data/` otherwise. Deployment is
Render only (`render.yaml`), deploying `main`; work happens on `develop` (see **Working across
Claude Code and Codex**). **`https://www.curbalerts.co` is the canonical origin** — Render 301s the
bare domain to `www`, so `www` is what browsers send as `Origin` and what `APP_ORIGIN` and
`HOSTED_APP_ORIGIN` in `public/app.js` must say. DNS is on Cloudflare with records **DNS only**;
proxying can break Render's certificate renewal. The old `denver-curb-alerts-2.onrender.com` still
serves and stays in `BUILT_IN_CREDENTIALED_ORIGINS`.

See [README.md](README.md) for product behavior and the reminder cadence. Parked product ideas live
in [IDEAS.md](IDEAS.md), which is a backlog, not instructions.

## Commands

| Command | Notes |
| --- | --- |
| `npm start` | Serves on `127.0.0.1:3000`. Must be running before `add:area`, `refresh:schedules`, `build:inventory`, `build:review-queue`. |
| `npm test` | `node --test test/*.test.js`. About a second; spawns real servers. |
| `npm run audit:inventory` | Offline coverage gate. Run before every handoff. |
| `npm run add:area -- <area-id> [flags]` | Adds a whole new pilot area in one command — see below. **Network: crawls Denver.** |
| `npm run refresh:schedules` | Refreshes sweep dates on published routes. Cannot lose coverage. **~80 min of Denver lookups.** |
| `npm run build:inventory` | **Not a full-city rebuild** — its grid covers 10 of 60 areas. See the warning below. **Network.** |
| `npm run rebuild:offline` | Reclassifies the published inventory, no network, ~1 min. Rewrites `public/`. |
| `npm run map:area -- <area-id>` | Staged discovery for one area. **Defaults `APP_ORIGIN` to production.** |
| `npm run build:review-queue -- <overpass.json> [area-id]` | Human-review queue. Never touches the published inventory. |
| `npm run sync:coverage` | Offline reconciliation. Rewrites published files. |
| `npm run sync:city-limits` | Applies the city-limits rule retroactively. No network; follow with `sync:coverage`. |
| `npm run lock:assets` | Re-records `data/asset-version-lock.json` after a hand-bumped `?v=`. |
| `npm run check:city-limits` | Audits our city line against Denver's own boundary. Reports only. Network on first run. |
| `npm run events` | Prints the analytics funnel. Needs `ISSUE_REPORT_ADMIN_TOKEN`. |
| `npm run push -- "Title" "Body" …` | Apple push broadcast. Dry run unless `--send`. |
| `npm run snow -- declare\|cancel\|status` | Declares or cancels a snow emergency through the admin route. Dry run unless `--send`; `--token=<hex>` limits it to one phone. **Outward-facing.** |
| `npm run build:mpls-snow` | Builds `public/minneapolis-snow.json` from the city's open data, cached in `data/mpls-snow-cache/`. `--refresh` refetches, `--dry-run` writes nothing to `public/`. |

Not wired to npm: `node scripts/import-osm-expected-blocks.js <map.osm> <area-id> <south> <west> <north> <east>`.

### Expensive and outward-facing commands need an explicit go-ahead

**Do not run any of these on your own initiative** — only when the user asks in this session, or
when a plan the user approved names the command. Otherwise stop and propose it, saying what it will
cost and what it will rewrite. A green `npm test` is never a reason to run one "to be sure".

- **Crawls of Denver's API:** `build:inventory`, `refresh:schedules`, `map:area`, `add:area` (unless
  `--skip-map`). They take tens of minutes to hours, lean on a small city service, and rewrite the
  published inventory. A classification or matching fix needs `rebuild:offline`, never a crawl.
- **Rewrites of generated artifacts:** `rebuild:offline`, `sync:coverage`, `sync:city-limits`,
  `build:mpls-snow` without `--dry-run`. Cheap
  in time, but they change the 12 MB payload and the coverage report, which is a large diff to
  review and to hand to the other tool.
- **Anything that leaves the machine:** `npm run push -- … --send`, `xcodebuild archive` /
  `-exportArchive` uploads to App Store Connect (each spends a build number), `git push`, and
  releasing to `main`.
- **Reading `data/` files whole.** `data/` is ~360 MB and the expected-block manifest alone is 36 MB;
  `grep`, `jq` or a short `node -e` for the part you need.

`npm test`, `npm run audit:inventory`, `lock:assets`, `check:city-limits` once cached, `npm run
events`, and the `npm run push` dry run are cheap and fine to run whenever useful. Building the iOS
app for the simulator is fine too.

### Adding a pilot area

`add:area` is the one command to reach for: it fetches the OpenStreetMap extract, imports expected
blocks, crawls Denver, reconciles coverage, records expectations, extends the payload and README
labels, and bumps the versioned assets.

```
npm start   # in another shell
npm run add:area -- colfax-w7-osage-broadway \
  --label "W Colfax Avenue–W 7th Avenue, N Osage Street–N Broadway" \
  --summary "W 7th–W Colfax from Osage–Broadway" \
  --readme "W 7th–W Colfax from Osage to Broadway" \
  --south 39.7262 --west -105.0058 --north 39.7406 --east -104.987
```

- It refuses an existing id or an overlapping rectangle — areas tile, never stack. On failure it
  restores `data/coverage-pilot-areas.json` and `README.md`; everything else is idempotent, so rerun.
  Flags: `--osm <file>`, `--skip-map`, `--no-version`, `--origin`. The extract is cached at
  `data/osm-extract-<area-id>.osm`.
- Pick the rectangle about 0.0005° past each boundary street's centreline.
- **Abutting areas must share an edge value exactly.** `add:area` checks overlap only, so a mismatch
  leaves a sliver nothing imports and every block in it renders blank. To find seams, grid the region
  at **0.0003°**, drop cells inside any area or outside `isPointInsideDenver`, and flood-fill the
  rest: seams come out as lines one or two cells thick. Never dismiss a one-cell column as grid
  resolution — read the two edge values. Pairwise edge comparison over-reports; the flood fill is
  ground truth. *Why:* HISTORY.md § Adding a pilot area (three seams closed 2026-08-27, the Alameda
  band and why it took three L-shaped areas).
- **Polo Club's private ways are listed in `privateWayIds` in
  [scripts/import-osm-expected-blocks.js](scripts/import-osm-expected-blocks.js)**, because OSM has
  lost their `access=private` tag. Never patch a cached `.osm` instead (they are gitignored). Drop an
  id only when OSM has the tag back.
- Overpass answers 406 without a User-Agent header; anything querying it must set one.

## Hard rules

### Generated artifacts and asset versions

- **Never hand-edit generated artifacts**; regenerate with the owning script:
  `public/denver-west-routes.json` (decided in one place,
  [scripts/lib/publish-payload.js](scripts/lib/publish-payload.js)), `data/inventory-coverage-report.json`,
  `data/mapping-cache-*.json`, `data/mapping-report-*.json`, and `data/asset-version-lock.json`
  (editing it by hand silently disarms the freshness test). Nothing may reintroduce
  `public/denver-west-routes.js`.
- **Changing any file in `public/` means bumping its `?v=` in both places**: the `<link>`/`<script>`
  in [public/index.html](public/index.html) and the matching `APP_SHELL` entry in
  [public/sw.js](public/sw.js), plus `CACHE_NAME` on line 1. The inventory's version is
  `inventoryUrl` on the Denver record in [public/cities.js](public/cities.js). `add:area` and
  `scripts/lib/asset-versions.js` do this; by hand, bump both files then run `npm run lock:assets`.
  `index.html` and `sw.js` carry no `?v=`, so `CACHE_NAME` is their version — change either and the
  cache name moves too. `test/static-cache-version.test.js` enforces all of it; fix the versions,
  never weaken the test. *Why:* HISTORY.md § Hard rules, "Agreement between those two files is not
  freshness" (an 18 MB payload shipped under a tag clients already had, 2026-08-26).
- `bumpAssetVersions` refuses if an asset it does not retag (`curb-geometry.js`,
  `denver-city-limits.js`, `icon.svg`, `manifest.webmanifest`) has changed.

### The map and the payload

- **The map draws the viewport and merges everything sharing a style**
  (`renderStreetBases`, `renderSegments` in [public/app.js](public/app.js)): cull by cached
  `renderBounds`, and one multi-polyline per colour. Clicks and hovers go through
  `findSegmentNearPoint` over `state.visibleSegments` (`CURB_HIT_TOLERANCE_PIXELS` 15) and
  `getSegmentHoverLabel` on demand — never a layer per curb. Below `CURB_OVERVIEW_MAX_ZOOM` (14),
  `isOverviewZoom()` drops the underlay and casing and draws curbs at `weight: 1`; do not "fix"
  overview appearance by raising opacity. Both `moveend` and `zoomend` go through
  `scheduleMapRender`. *Why:* HISTORY.md § "The map draws the viewport" (158,425 layers, 5 s pans).
- **The payload is fetched once**, and `app.js` publishes it to
  `window.DENVER_WEST_ROUTE_INVENTORY` itself. Coordinates round to **seven** decimals, not six (six
  reclassifies blocks); rounding is lossy, so changing `COORDINATE_PRECISION` means regenerating from
  an unrounded payload and a block-for-block comparison.
- **The server compresses and versioned URLs are immutable.** `serveStaticFile` memoizes brotli/gzip
  per file and encoding; a `?v=` request gets `max-age=31536000, immutable`; `index.html` and `sw.js`
  stay `no-store`. No bundler or CDN layer.
- **The service worker answers versioned assets cache-first**; navigations and unversioned requests
  stay network-first. This is only safe because a `?v=` URL never changes meaning — make one mutable
  and installed clients pin to old bytes forever. *Why:* HISTORY.md § "The service worker answers
  versioned assets" (phones on weak connections hung with a full copy in Cache Storage).
- **The inventory is not mirrored into `localStorage`, and must not be again.**
  `purgeLegacyInventoryCache` clears old copies. `saveJson` swallows a failed `JSON.stringify` — keep
  that; a best-effort persist must never sit on the path to the first paint.
- **`data/inventory-expected-blocks.json` is written minified**, through
  [scripts/lib/expected-blocks.js](scripts/lib/expected-blocks.js), to stay under GitHub's 50 MB
  warning. Do not reindent it. If it outgrows 50 MB, gzip it or split it per area; do not rewrite git
  history.

### Coverage and the city line

- **Record an area once, in `data/coverage-pilot-areas.json`** — bounds, `published`, and
  `coverage.expectedPublicBlocks` / `coverage.minimumScheduled`. Scripts and tests read it from there;
  never retype a rectangle.
- **Product invariant: no mapped public street block may render blank.** An unmatched public block
  resolves to a scheduled route or becomes a pink `dataUnavailable` overlay; anything else is an
  `unexplained-gap`, and `build:inventory` throws rather than publish it.
- **Nothing outside Denver is published, and pink is never drawn inside a city Denver does not
  sweep.** `isGlendaleBlock` ([scripts/lib/glendale-city-limits.js](scripts/lib/glendale-city-limits.js))
  runs first, then `isOutsideDenverBlock`; both carry a **20 m buffer** because the line runs down the
  middle of streets Denver sweeps. Do not tighten the ring or lower the buffer. Blocks straddling the
  line are kept, and `clipPathToDenver` trims their pink to the city. Enclaves are resolved after the
  crawl by `isInsideGlendaleUnbuffered` / `isInsideEnclaveUnbuffered` in
  [scripts/sync-city-limits.js](scripts/sync-city-limits.js), using Denver's own answer: a block with
  a schedule is Denver's. That rule is deliberately not applied past the outer city line. Never add
  per-area rectangles for a municipal boundary; fix the geometry. *Why:* HISTORY.md § "Glendale is
  not Denver", "Nothing outside Denver gets published", "Pink must never be drawn inside a city".
- **Pink's 2026-08-27 rewording retires none of those exclusions.** Older prose argues from pink
  meaning *you do not need to move your car*; read it as *pink is the wrong answer here*.
- **The map and the pipeline read the city line from one file,
  [public/denver-city-limits.js](public/denver-city-limits.js)** (UMD, like `curb-geometry.js`);
  [scripts/lib/denver-city-limits.js](scripts/lib/denver-city-limits.js) adds the pipeline half. Do
  not copy the rings or give the client its own boundary source. The red mask is the line pushed out
  by `BOUNDARY_BUFFER_METRES` (`getDenverMaskRings`); `test/denver-city-limits.test.js` budgets the
  residual stubs. *Why:* HISTORY.md § "The map and the pipeline read the city line from one file"
  (589 routes under red paint).
- **`check:city-limits` is the second opinion** against Denver's ArcGIS boundary. It reports, never
  writes, and is the one sanctioned direct call to a city service. A `[scheduled]` divergence needs
  no action; N Tennyson, Polo Club Road and Polo Field Lane are expected entries.
- **The auditor indexes routes by street name** ([scripts/lib/inventory-auditor.js](scripts/lib/inventory-auditor.js)),
  memoizes `normalizeStreetName`, and rejects by bounding box first. If you refactor the matching
  loop, verify the report is byte-identical to the previous implementation.

### Crawling and refreshing

- **Logic fix → `rebuild:offline`, never a crawl.** It reclassifies, and withdraws pink whose block
  now resolves. It never invents new pink and never replays coverage patches — change a patch, run
  the full crawl.
- **`build:inventory` covers 10 of 60 areas.** Its `REGIONS` grid was never extended by `add:area`,
  so running it deletes 50 areas' schedules and replaces them with pink, and the gap gate passes.
  `assertNoCoverageCollapse` refuses that (override only deliberately, with `ALLOW_COVERAGE_DROP=1`).
  Before using it for anything, extend `REGIONS` to all areas and re-derive coverage expectations.
  *Why:* HISTORY.md § "`build:inventory` is NOT a full-city rebuild".
- **Schedules are refreshed with `refresh:schedules`**, which never removes a route. A full run
  finishes in one go, about 80 minutes at the default (concurrency 1, 600 per round, 30 s pauses;
  `--concurrency=`, `--round-size=`, `--round-pause=`). Do not plan around throttling, wait between
  attempts, or probe first — there is no evidence of a rate limiter. ~104 routes (0.5%) crash Denver
  at their own coordinates and can never refresh; do not chase them. If a run aborts, read the
  per-round line: `gave up` and `retried` at zero while `crashed Denver` climbs is healthy.
- **Refresh when the season opens in April, and before its last sweeps in November — for route
  changes, not dates.** The client's rule-text projection (`getRuleBasedSweepDates`, held to
  `sweepSeason` on the Denver record) matched a full refresh's October dates 100%. Before spending a
  day on a refresh, run that comparison. *Why:* HISTORY.md § "But refresh for route changes".
- **Crawl guards** in [scripts/build-static-inventory.js](scripts/build-static-inventory.js)
  (`test/crawl-guards.test.js`): `CONCURRENCY` 3; jittered backoff on thrown/408/429/5xx; **no retry**
  on a 400 or on Denver's null-reference crash (`isUpstreamCrashBody`), which is a definitive answer;
  `fetchWithRetry` keeps an answer distinct from a failure; `MAX_FAILURE_RATE` aborts before writing;
  `assertNoCoverageCollapse` runs inside `writeInventoryArtifacts`. Treat an abort as a question.

### Client correctness

- **`hidden` loses to any class that sets `display`.** Any element the JS toggles with `hidden` needs
  a `[hidden]` rule for *every* class it carries that sets `display`. Verify with
  `getComputedStyle`, not `element.hidden`.
- **Some tests assert on source text, by design** (`test/not-maintained-ui.test.js`,
  `test/curb-geometry.test.js`, `test/address-search.test.js`, others). Renames and copy changes break
  them; update the test alongside the code.
- **Denver is a record in [public/cities.js](public/cities.js)** — bounds, `minZoom`, `inventoryUrl`,
  `cityLimitsGlobal`, `geocodeSuffix`, `addressGrid`, `westGridNorthLatitude`, `sweepSeason`,
  `webReminders`, `appStoreUrl`. `app.js` resolves `ACTIVE_CITY` once, so `cities.js` loads first. A
  second city is chosen from location with a header switcher, **not** a splash picker. The copy naming
  the sweeping authority deliberately stayed hardcoded (safety wording guarded by source-text tests).
- **Before building for a second city:** the 12 MB payload is bundled into the iOS app, so N cities
  forces per-city on-demand inventory; and every city needs its own acquisition pipeline. Confirm the
  candidate city's data exists in usable form first.
- **Don't add dependencies, a bundler, a framework, or a linter without asking.**
- **Don't call `denvergov.org` directly from a script** — go through `/api/denver/sweeping`.

## Minneapolis snow emergencies

In progress, planned 2026-09-30: Minneapolis is the second city, covering snow emergencies only.
The curb data is done; the city record, map, server alerts and paywall are not yet built.

- **`public/minneapolis-snow.json` is generated by `npm run build:mpls-snow`; never hand-edit it.**
  The rules live in [scripts/lib/minneapolis-snow.js](scripts/lib/minneapolis-snow.js). Each curb is
  `{ id, street, sideKey, days, parity?, cityDays?, conflicts?, geometry }`. `days` is
  `[day1, day2, day3]`, where **1 means you may park that day and 0 means you may not**. That meaning
  is confirmed against the city's own tickets, not documented by the city.
- **Where the city's datasets disagree, the stricter rule is published**, and `cityDays` /
  `conflicts` say what changed. Do not relax this to trust the snow polygons alone: about 2% of them
  would tell a driver to stay on a street where the city tickets. *Why:* HISTORY.md § Minneapolis
  snow emergencies.
- **Curb ids (`mpls:<hash>`) must survive a refresh**, because saved curbs and the phones watching
  them are keyed on them. The build carries each old id to the nearest new curb on the same street
  and side within 15 m, and reports any that are retired.
- **Two gates refuse a bad build.** A day's placed tickets may not contradict the published curbs
  more than 5% of the time (2025–26 measured 1.0–2.9%). The curb count may not fall more than 10%
  (override with `ALLOW_COVERAGE_DROP=1`). Add each season's `Snow_Emergency_<Name>_Tags_<year>`
  services to `TICKET_SERVICES` as the city publishes them.
- **Minneapolis is a record in `public/cities.js` with `kind: "snow"`**; `inventoryUrl` names this
  file and its `?v=` moves with it (and with `cities.js`'s own tag). It is deliberately not in
  `sw.js`'s `APP_SHELL`, so Denver installs do not precache 4.5 MB. The header switcher saves the
  choice under `curb-alerts-city` and reloads; `IS_SNOW_CITY` in `app.js` skips Denver's boot steps
  and loads through `loadSnowInventory`. Snow curbs carry `schedule.sweepType: "Snow"`, never a sweep
  date, so no local reminder jobs come from them. Phases 4–7 are built except the TestFlight upload, which waits for the user's go-ahead.
  The page banner (`#snow-banner`, `renderSnowBanner`) shows only in Minneapolis while
  `GET /api/snow-emergency` reports an active emergency; it reads each day's ban time from the
  server's `bans` rather than doing time-zone maths, keeps the last answer when a refresh fails, and
  hides itself 24 h after Day 3 begins in case a cancel was forgotten. A push's `/?snow=1` link
  switches a Denver page to Minneapolis first. Terms, Privacy and Disclaimer name the snow alerts.
- **A snow emergency starts only when a person declares it** (`POST /api/snow-emergency`, behind the
  admin token, or `npm run snow`). [lib/snow.js](lib/snow.js) is pure: it turns `day1Date` into a
  timeline in `America/Chicago` (declaration now; Day 1 at 7:30 pm; Days 2 and 3 at 8 pm the evening
  before and 7 am) and picks each message's audience from the curbs' `days` flags. A message is sent
  only to phones whose `watchedCurbIds` include a curb banned that day, never to a Denver-only phone,
  and is skipped, not sent late, once it is over 2 hours stale.
- **A poller watches the city's notice banner and only ever emails the author.** Every 5 minutes
  `pollSnowNotices` ([server.js](server.js), pure half in [lib/snow-notices.js](lib/snow-notices.js))
  reads `emergency-en.json`; a notice mentioning "snow emergency" that has not been seen is emailed
  to `support@curbalerts.co` with the `npm run snow` command to confirm, and it never declares. The
  banner's shape during an emergency is **unknown** (it was empty on 2026-09-30), so every string in
  the file is read and the raw JSON is logged and emailed the first time it carries anything: when a
  real one appears, record its format in HISTORY.md. A notice is remembered (`snow-notices`) only
  after the email is handed on, so a failed send retries; a failed fetch only logs. `SNOW_NOTICE_URL=off`
  disables it, and `test/lib/with-server.js` sets that for every test.
- **The dispatcher writes a message id into `sentMessageIds` before it sends** (at most once, across
  restarts and overlapping ticks). Cancelling messages only the phones in `notifiedEndpoints`.
  `GET /api/snow-emergency` is public and carries no phone data.

## Architecture and the data pipeline

```
OpenStreetMap (.osm XML or Overpass JSON)
  → scripts/import-osm-expected-blocks.js / scripts/build-coverage-review-queue.js
  → data/inventory-expected-blocks.json        (the manifest of every block that should exist)

Denver sweeping API  → server.js /api/denver/sweeping  → scripts/build-static-inventory.js
                                                       → scripts/map-area-approach-3.js

  → scripts/lib/inventory-auditor.js  auditInventory()
      samples each block's geometry every 8 m, classifies:
      scheduled | unavailable | excluded | unexplained-gap

  → scripts/lib/publish-payload.js  slimRoutesForPublication()
  → public/denver-west-routes.json              (published, consumed by the client)
  → data/inventory-coverage-report.json         (diagnostic)
```

Denver returns no coordinates; geometry is parsed from the Google `staticmap` URL it embeds
(`parseStaticMapGeometry` in [server.js](server.js)). Hand-curated coverage patches live in
[scripts/lib/](scripts/lib/) as `confirmed-*-coverage.js` and inside `build-static-inventory.js`; each
carries a comment explaining why — preserve those comments.

## Accounts

Accounts are **optional and always will be**: every screen works signed out, and
`state.account === null` makes every client account function a no-op.

- **The account is a view reached from `#account-chip`, not a tab.** Tabs are tasks; settings are
  not. The chip carries the unverified-email dot (`.has-notice`) and is pinned outside
  `.app-tabs-scroll`. The alerts page keeps its one-line `.saved-sets-account-note`, whose text flips
  when signed in.
- **Any flow returning from an outside origin calls `setActiveView("account")` before rendering**, as
  `handleEmailLinks` does — the query string alone does not move the view.
- **`node:crypto` only**: scrypt 16384/8/1 with self-describing hashes, `randomBytes`,
  `timingSafeEqual`. Do not lower the scrypt cost to speed tests.
- **Sessions are server-side records storing the sha256 of the token.** Sessions travel as a cookie or a
  bearer token (`Authorization: Bearer`), which names the **same** record — bearer first, then the jar. Never let
  the bearer become a second kind of credential. The raw token is returned only when a client sends
  `issueSessionToken: true` (the boolean). Sign-out revokes whichever credential was presented.
- **Sessions and the admin token share the header and neither works as the other**
  (`test/accounts.test.js` asserts both directions).
- **The session cookie is `SameSite=Lax`.** Do not tighten it to Strict.
- **Credentialed origins are built at boot** by `buildCredentialedOrigins` from
  `BUILT_IN_CREDENTIALED_ORIGINS`, `APP_ORIGIN` and `CREDENTIALED_ORIGINS`; `normalizeOrigin` rejects
  anything with a path, query, credentials or non-HTTP scheme, with a warning. A missing origin
  breaks sign-in silently on a new hostname. Only origins the app is served from belong there.
- **Sign-in hides whether an address exists** (one message, decoy scrypt); sign-up cannot. Email
  verification gates nothing, so that trade stands.
- **The client uploads the library from `localStorage`, never `state.savedSets`, and merges the
  server's library down at boot first.** A set both sides hold is unioned curb by curb (no
  tombstones — a curb turned off may come back; accepted). Guarded by source-text tests.
- **Bulk reads of other people's data sit behind the admin token** (`ISSUE_REPORT_ADMIN_TOKEN`).
- **Sign-in throttle counters are read from memory and written through to storage**; expired,
  future-dated or unparseable records are dropped at boot. It is single-instance by design — revisit
  before scaling beyond one Render instance.

## Payments and what is sold

- **There is no web payment path.** Stripe was removed 2026-09-03 (Apple requires in-app purchase
  inside an iOS app); `/api/billing/*` answers 404. If web sales return, `git show` the removal
  commit rather than starting over.
- **Entitlement scaffolding stays and gates nothing server-side**: `plan`, `status`,
  `providerCustomerId`, `providerSubscriptionId`, `currentPeriodEnd`, `cancelAtPeriodEnd`,
  `trialStartedAt`; `buildTrialBilling()` at sign-up; `getEntitlement()` in `lib/accounts.js` is the
  single decider and counts `past_due` as entitled. `buildDefaultBilling()` is the floor and must stay
  unentitled, and no key in it may name a processor (`test/entitlement.test.js`). `TRIAL_DAYS` is in
  `lib/accounts.js`. Never gate anything before there is a way to pay; no endpoint answers 402.
  **The one server-side gate is the snow-alert audience**: a phone reports `reminderAccess`
  (`entitled`, `endsAt` only where coverage really ends, and Apple's `originalTransactionId`) with its
  push registration, and a snow message goes only to phones it covers (`isCoveredAt` in
  [lib/snow.js](lib/snow.js); silence counts as uncovered). A declaration limited to `--token=` phones
  skips it so the end-to-end test works on an unsubscribed phone.
- **Apple tells the server when a subscription's payment fails or ends** at
  `POST /api/apple/notifications` (App Store Server Notifications v2; set the URL in App Store
  Connect for Production and Sandbox). [lib/app-store-notifications.js](lib/app-store-notifications.js)
  trusts nothing until the JWS chain ends at the **pinned Apple Root CA - G3 fingerprint** with
  Apple's two marker OIDs and the signature checks out. Verified events correct the matching phones'
  `reminderAccess` (matched by `originalTransactionId`, ordered by `signedDate`, deduped by
  `notificationUUID`) and push a warning for payment failure, lapse and refund — never for a recovery
  or a driver's own cancel. Never loosen the pin or accept an unverified body; tests sign with the
  throwaway chain in `test/fixtures/fake-apple-chain`, named through `APP_STORE_TEST_ROOT_SHA256`.
- **Every way alerts stop is announced.** On the phone, `AccessNoticePlanner` covers snow-only
  watchers as well as sweep reminders; at a declaration the server sends lapsed Minneapolis watchers
  one "your alerts are off" push (not added to `notifiedEndpoints`).
- **The reminders are what gets sold; the map stays free.** Decided 2026-09-23 by the app's author —
  do not re-argue it. **Reminders never stop silently**: before a lapse stops one, the driver gets
  blatant warnings in the app and on the device, and a billing retry still counts as entitled.
- **The website is map only** (`webReminders: false` on the Denver record): no web push, reminder
  POSTs and test sends answer 410, and the page shows the App Store listing instead. Nothing inside
  the app may point at the website as a free alternative. **Set `appStoreUrl` on launch day** (bump
  `cities.js`'s `?v=`, which must end in `-inv<N>`).
- **The Terms and Privacy copy must match what is sold, in the same commit.** Support address:
  `support@curbalerts.co`.
- Plan: StoreKit 2, yearly $14.99 with a 14-day trial, monthly $2.99 with none, 16-day Billing Grace
  Period. Prices are never written into the app or page — they come from `Product.displayPrice`.

## Reminders

- **Turning a reminder on is the save.** *Remind me about this curb* adds the curb to the default set
  (`DEFAULT_SET_ID` `set-my-curbs`, *My curbs*) and persists it; tapping again removes it from
  **every** set, and an emptied set is dropped. Opening a curb does not turn it on. One default set,
  not a set per curb (iOS keeps 64 pending notifications). `isCurbReminded` is memoized on the
  `state.savedSets` array identity — always replace that array, never mutate it. Tests:
  `test/remind-on-tap.test.js`.
- **Reminders keep going until the car is moved**: 6pm and 9pm the night before, 7:00, 7:30 and 8:00
  on the day; `nagUntilMoved` (default on) turns the extras off. Follow-ups hang off the first
  morning alert because **Denver publishes no sweep time — never invent one.** Confirmation (sweep key
  `<set id>|<YYYY-MM-DD>` in `MOVED_SWEEPS_KEY`) removes jobs; opening a reminder is not
  confirmation. The service worker must keep `postMessage`ing notification URLs to an open window.
- **The parking pin is a saved set with `kind: "parked"`**, stored under `PARKED_CAR_KEY`, added only
  through `getReminderSets()`, kept out of the account library, one at a time. The pin picks the
  street and the driver picks the side (`getOppositeCurb`) — do not tighten the search to fix a wrong
  side; it searches `state.curbSegments`. `releaseParkedCarIfMoved` ends it; a pin suppresses a saved
  set's reminders for the same curb (`isCurbCoveredByParkedCar`) and release writes a
  `moved-curb|<segment id>|<date>` key. **The pin's coordinates never leave the device.**
  *Why:* HISTORY.md § The parking pin.

## iOS

### Shipping on iOS: the bridge and the shell

- The page talks to the phone only through `window.DenverCurbAlertsNative`.
  `getNativeReminderBridge` returns it only with both required methods; `canUseNativeReminders` gates
  every branch, so a browser takes byte-identical paths. The page tests capabilities
  (`typeof bridge.showPaywall`), never which platform it is on. Contract: `permission`,
  `requestPermission()`, `scheduleReminders(jobs, { movedSweepKeys, watchedCurbIds })` (replaces all
  pending), optional `showTestNotification`, `movedSweepKeys` injected at start,
  `getCurrentPosition()` (the page's own geolocation never works in the app), `setSessionToken` /
  `clearSessionToken`, and `subscription`, `showPaywall()`, `manageSubscription(kind)`,
  `restorePurchases()`. Shell-to-page events: `curb-alerts-native` with `open-url`, `sweep-moved`,
  `permission-changed`, `subscription-changed`. A rejected `scheduleReminders` clears
  `lastSyncedNativeReminderHash`.
- **In the shell, accounts use the bearer token**: `credentials: "omit"`, token in the keychain
  (`SessionKeychain`, `AfterFirstUnlockThisDeviceOnly`) and page memory. **Never park the token in
  `localStorage`.** An unreachable server does not clear it.
- Non-`http(s)` origins fall back to `HOSTED_APP_ORIGIN` in `getApiBaseOrigin`.

### The iOS project

- `ios/CurbAlerts.xcodeproj`, SwiftUI, iOS 17+, `co.curbalerts.app`, **no Swift packages**.
  File-system-synchronized groups pick up new files. Build:
  `xcodebuild -project ios/CurbAlerts.xcodeproj -scheme CurbAlerts -destination "platform=iOS Simulator,name=iPhone 17 Pro" build`
- **The app serves `public/` from its own bundle** (the "Bundle web app" phase, `vendor/` included,
  `sw.js` not), so a web change reaches the app only in a new build.
- `ReminderScheduler` schedules the next 21 days, capped at 60, refilled on foreground and
  `BGAppRefreshTask`; reminders are `timeSensitive`. `ReminderScheduler.reschedule` is the one place
  that reloads the widget.
- **`ITSAppUsesNonExemptEncryption` is `false`.** Adding CryptoKit, CommonCrypto or our own crypto
  makes that untrue — revisit it in the same commit.
- **Each target's `PrivacyInfo.xcprivacy` must stay true to the Privacy page.** A new `UserDefaults`
  call, file-timestamp or uptime read needs its reason added in the same commit. If the server starts
  storing a lookup or a new payload leaves the phone, update the manifest and the App Store answers.
- **TestFlight uploads** (currently build 11): archive with the **CurbAlerts** scheme via
  `xcodebuild archive -allowProvisioningUpdates`, export with `method` `app-store-connect`,
  `destination` `upload`, team `XLGGMG362T`. **Raise `CURRENT_PROJECT_VERSION` in all four build
  configurations, equal for app and widget, and commit it.** `testFlightInternalTestingOnly` makes a
  build internal-only forever — leave it out for external groups. `MARKETING_VERSION` stays `1.0`.
  Do not upload until both subscription products exist in App Store Connect.

### Live Activity, widget, subscription, push

- **Live Activity**: starts at a sweep's first alert on the day, never the evening before; future
  start needs iOS 26. `MovedCarIntent` is a `LiveActivityIntent` running in the app — **the widget's
  empty `MovedCarIntentHandler` stub is correct; do not "fix" it or change the intent's protocol.** A
  sync ends a card only when its sweep is confirmed or has no reminders left. The test card runs in
  Debug and TestFlight, not App Store builds. **Do not dedupe** the card's alert and the notification.
- **Widget** (`NextSweepWidget`): reads only the jobs, via `ReminderStore` in the App Group
  `group.co.curbalerts.app` (both targets carry the entitlement). Follows the phone's appearance
  (`WidgetPalette`); the app is light-only. Taps open `curbalerts://widget/open?path=...`.
- **Subscription** (`SubscriptionManager`, StoreKit 2): keyed to the Apple ID, not an account. The
  gate is `ReminderAccess.coveredJobs` at the top of `reschedule`; the full job list is never
  trimmed; "Send test now" is not gated. Warnings are `AccessNoticePlanner` — plan nothing while
  `checkedAt` is `.distantPast`, compute day names at fire time, clear `sentAccessNotices` when
  active again. There is no Swift test target; check planner changes with `swiftc`. The paywall is
  Apple's `SubscriptionStoreView` with Apple's own close button; its promise settles on
  `.onDisappear`. Urgent banners are red and lead with 😱 (☠️ for a cancelled plan).
  `ios/StoreKit/CurbAlerts.storekit` must stay in the project's `StoreKit` group with no target
  membership, and its product ids must equal `SubscriptionManager.productIDs` and App Store Connect.
- **Apple push is for alerts the phone cannot schedule ahead (e.g. a snow emergency). Sweep reminders
  never use it.** Tokens live in `push-subscriptions` as `apns://<token>`. Alerts are targeted by
  `watchedCurbIds` (segment ids, never coordinates) and a broadcast must name `curbIds` or
  `everyone: true`. `lib/apns.js` uses `node:http2`/`node:crypto` only. The APNs key must be
  **Sandbox & Production, Team Scoped**. Whether a new kind of alert is part of what is sold is
  decided when that kind exists.

Not done yet: geofencing (noticing the car leave), and anything that sends Apple push on its own.

## Product analytics

Counts only: `app_open`, `curb_opened`, `remind_tapped`, `paywall_shown`, `trial_started`,
`subscription_started`, **each at most once per session** (page load, or return after 30 minutes).
An event is a name, platform and app version added to a daily total (`lib/events.js`); no IP,
account, device or install id is ever stored — that is what the privacy manifest and Privacy page
declare. Unknown names answer 400. Sending never delays or breaks what it counts. Per-person
sequences would be a separate, consented feature.

## Android, later

Not started; decided 2026-09-23 to launch on the App Store alone. An Android app would be a WebView
over the same `public/` implementing the same bridge — so put behaviour in the page wherever a
phone's own API is not required. *What it will take:* HISTORY.md § Android, later.

## Email

- `lib/email.js` is one Resend JSON POST over `node:https`; no SMTP, no nodemailer. Live since
  2026-09-21 from `alerts@curbalerts.co`.
- **Do not turn on Resend's "Enable Receiving"**, and keep its `send`/`rsend` CNAMEs DNS only.
  Cloudflare Email Routing owns the root MX and SPF; inbound `support@`, `alerts@` and `garrett@`
  forward to Gmail. Do not weaken DKIM — it is what carries DMARC across the forward. Test a
  forwarding rule from an address other than its destination.
- `EMAIL_TRANSPORT=outbox` delivers to `data/outbox.json`; tests run under it.
- **Verification gates nothing.** **The reset route answers before it sends — do not await the
  send.** A reset token is spent on the attempt; a reset revokes every session and confirms the
  address. Tokens are stored as sha256 and single use is enforced by deletion. Links land on
  `?verify=` / `?reset=` and are stripped from the address bar immediately. The link origin comes from
  `resolveReturnOrigin` (prefers `APP_ORIGIN`; never trust `Host`).

## Domain vocabulary

- **Route** — a Denver-returned street segment with left/right sweeping rules, directions,
  schedules, and geometry.
- **Expected block** — one public street block in `data/inventory-expected-blocks.json`; may be
  `excluded: true` with an `exclusionReason`.
- **Coverage audit** — `auditInventory({ routes, blocks, matchToleranceMeters: 12, minimumCoverage: 0.9 })`.
- **Pilot area** — a named bbox in `data/coverage-pilot-areas.json`; its id suffixes
  `mapping-cache-<area-id>.json` and block ids `<area-id>-osm-<way>-<node>-<node>-<n>`.
- **Mapping cache / report** — `data/mapping-cache-<area>.json` (memoized lookups, empty results
  cached too) and `data/mapping-report-<area>.json` (stats, `unresolved[]` for human review).
- **Colours** — `getCurbColor` in `public/app.js` is the one place that decides.
  **Pink** = *no schedule published by Denver for this curb; check with Denver and use caution* — a
  caution state, not an all-clear. **Gray `#7b8790`** = not maintained by Denver, reminders disabled.
  **Plum `#8e44ad`** = swept on a schedule you never have to move for (`relocationRequired`). Pick any
  new colour by CIELAB distance under simulated deuteranopia, not by eye.
- **`relocationRequired` keys on `isPosted`**, not sweep type. **`Nightly` is deliberately excluded
  — closed, leave it.** **Southeast Denver being almost all plum is correct** — do not make the
  predicate stricter. *Why:* HISTORY.md § Domain vocabulary.

## Code style

Match the surrounding code. There is no linter or formatter.

- CommonJS `require` / `module.exports`. UMD modules in `public/` (`curb-geometry.js`,
  `denver-city-limits.js`, `cities.js`) keep their hand-rolled wrapper.
- Double quotes, semicolons always, 2-space indent, no trailing commas.
- `const` and arrow functions by default; `async`/`await` with hand-rolled `runPool` helpers.
- Long descriptive function names (`ensureRinoOfficialRouteCoverage`).
- Comments explain *why*, especially for data patches. Prose style, full sentences.

## Working across Claude Code and Codex

1. **This file is the only instruction file.** Durable rules go here, never into one tool's private
   memory. Investigations and measurements go into `HISTORY.md`.
2. **One tool per working tree at a time.** Commit or stash before switching.
3. **Never run `build:inventory`, `map:area`, or `sync:coverage` from two tools at once.**
4. **Before handing off:** run `npm run audit:inventory`, then commit. Leave the tree clean.
5. **After picking up:** run `git status` and `git log --oneline -5` before editing anything.
6. **Work happens on `develop`; Render deploys `main`.** Release by fast-forwarding —
   `git branch -f main develop && git push origin main` — once `npm test` and
   `npm run audit:inventory` pass, and only when the user asks. Never commit to `main` directly. If
   the live site serves a `?v=` tag on `develop` but not `main`, the Render dashboard is deploying the
   wrong branch.

## Environment variables

Every variable is listed in [.env.example](.env.example) and declared in [render.yaml](render.yaml) as
`sync: false`; keep both complete — an unset variable silently answers 503 or does nothing.

- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` — all three or Apple push is off.
- `SNOW_NOTICE_URL` — optional; empty reads the city's banner file, `off` disables the poller.
- `APP_STORE_TEST_ROOT_SHA256` — set only by tests; the server pins Apple's root otherwise.
- `ISSUE_REPORT_ADMIN_TOKEN` — gates every bulk read of other people's data. Unset closes them.
- `DATA_DIR` — JSON collection location; set only by tests.
- `APP_ORIGIN` — **overloaded**: which server pipeline scripts query (localhost for
  `build-static-inventory.js`, **production** for `map-area-approach-3.js`) *and* the canonical origin
  for reset links and credentialed CORS.
- `CREDENTIALED_ORIGINS` — extra comma-separated trusted origins.
- `RESEND_API_KEY`, `EMAIL_FROM` — both or email is off. `EMAIL_TRANSPORT=outbox` for local.

Render must be `starter` (a free instance sleeps and stops the dispatcher) with the `render.yaml`
Postgres applied (a free filesystem is wiped each deploy). Do not use Render's free Postgres; it is
deleted after 30 days.

## Known issues

- **Denver's route lookup permanently crashes on ~0.5% of coordinates** (HTTP 500, " Object
  reference not set to an instance of an object."), including N Tennyson from W 46th to W 52nd. It is
  a defect, not an absence of sweeping; Tennyson's coverage is the hand-drawn pink in
  `ensureUnavailableTennysonCoverage`.
- **Denver's address lookup answers 400 for every address**; coordinate lookups carry all coverage.
  So **`findLocalSearchMatch` in `public/app.js` is the address search**, placing house numbers on
  Denver's grid (`addressGrid` in `cities.js`). Where it cannot place a number it reports
  `kind: "street"` — do not paper over that with a block-zoom pin. If you change the grid table,
  re-measure against real addresses. *Why:* HISTORY.md § Known issues.
- **Re-importing a published area against a fresh Overpass extract drifts.** Only re-import with its
  cached `data/osm-extract-<area-id>.osm`.
- **A clean coverage report is not a precondition**; `sync:coverage` does not enforce the gate.
- **A fresh crawl will fail `test/curb-geometry.test.js`'s LARIMER ST count** (6 → 11); change that
  count *with* the crawl, not before. **The four `routeMap.delete(...)` calls in `auditAndPublish`
  must stay** (paired with `suppressedFallbackRouteIds` in `app.js`). Reproduce audits offline with
  `applyCoveragePatches` plus `auditInventory`, never `auditAndPublish`.
- **The service worker cache match is exact** (no `ignoreSearch`).
- **Leaflet is vendored** in `public/vendor/leaflet/` (1.9.4). Upgrade as a unit with new `?v=`s.
- **Base map tiles come from `tile.openstreetmap.org`, one host, no `{s}` subdomains**, keeping the
  `© OpenStreetMap contributors` attribution. Its policy forbids bulk prefetching, so the basemap
  cannot be bundled into the app; move to a paid or self-hosted basemap before real customers.
- **Names are historical**: `denver-west-routes.*` and `sloans-lake-*` keys hold city-wide data.

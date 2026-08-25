# AGENTS.md

Instructions for any AI coding tool working in this repo (Claude Code, Codex, and anything else).
This is the single source of truth. `CLAUDE.md` is a pointer to this file and must stay a pointer.

## What this is

**Denver Curb Alerts** — a street-sweeping / parking-ticket-avoidance PWA for Denver. It proxies the
city's public sweeping API, draws curb segments on a Leaflet map, separates left-side from right-side
sweeping rules, and schedules web-push reminders.

Deliberately minimal stack:

- `server.js` — a zero-framework `node:http` server. Static files + `/api/*`. No Express.
- `public/app.js` — the entire client, ~6000 lines of vanilla JS loaded by a plain `<script>` tag.
- **No bundler, no transpiler, no build step for client code.** What is in `public/` is what ships.
- Two dependencies (`pg`, `web-push`), both lazily `require`d so the app boots without `npm install`.
- CommonJS everywhere, including tests and scripts. There is no `"type": "module"`.

Storage is Postgres when `DATABASE_URL` is set, JSON files under `data/` otherwise. Deployment is
Render only (`render.yaml`); the live origin is `https://denver-curb-alerts-2.onrender.com`.

See [README.md](README.md) for product behavior, the reminder cadence, and the reasoning behind the
Denver API integration. Don't duplicate that content here.

## Commands

| Command | Notes |
| --- | --- |
| `npm start` | Serves on `127.0.0.1:3000`. Must be running **before** `add:area`, `build:inventory`, or `build:review-queue`. |
| `npm test` | `node --test test/*.test.js`. Runs in about half a second. |
| `npm run add:area -- <area-id> [flags]` | **Adds a whole new pilot area in one command** — see below. Needs the local server up. |
| `npm run audit:inventory` | Offline coverage gate. Run this before every handoff. |
| `npm run build:inventory` | Full rebuild. Hits Denver's live API hundreds of times; needs the local server up. |
| `npm run rebuild:offline` | Reclassifies the published inventory with no network. Use for matching/classification fixes; see below. |
| `npm run map:area -- <area-id>` | Staged discovery for one pilot area. **Defaults `APP_ORIGIN` to production**, not localhost — set it deliberately. |
| `npm run build:review-queue -- <overpass.json> [area-id]` | Builds a human-review queue. Never touches the published inventory. |
| `npm run sync:coverage` | Offline reconciliation pass. No network. |
| `npm run sync:city-limits` | Applies the city-limits rule to blocks imported before it existed. No network; follow with `sync:coverage`. |
| `npm run check:city-limits` | Audits our city line against Denver's own published boundary. Reports only, never writes. Cached after the first run. |

Not wired to npm: `node scripts/import-osm-expected-blocks.js <map.osm> <area-id> <south> <west> <north> <east>`.

### Adding a pilot area

`add:area` is the one command to reach for. It fetches the OpenStreetMap extract, imports the
expected blocks, crawls Denver for that area, reconciles coverage, measures the result, records the
coverage expectations, extends the payload and README labels, and bumps the four versioned asset
constants — the whole sequence that used to be six hand-edits across as many files.

```
npm start   # in another shell
npm run add:area -- colfax-w7-osage-broadway \
  --label "W Colfax Avenue–W 7th Avenue, N Osage Street–N Broadway" \
  --summary "W 7th–W Colfax from Osage–Broadway" \
  --readme "W 7th–W Colfax from Osage to Broadway" \
  --south 39.7262 --west -105.0058 --north 39.7406 --east -104.987
```

It refuses to start if the id already exists or the rectangle overlaps a published area — areas tile,
they never stack, and abutting rectangles should share an edge value exactly so no sliver of a block
is left unmapped. If a step fails it restores `data/coverage-pilot-areas.json` and `README.md` before
exiting; everything else it touches is rewritten idempotently, so just run it again. The Overpass
extract is cached at `data/osm-extract-<area-id>.osm` and reused. Useful flags: `--osm <file>` to
skip the download, `--skip-map` to import without crawling Denver, `--no-version` to leave the asset
versions alone, `--origin` to point the crawl at a different server.

Pick the rectangle so it clears the far curb of each boundary street — about 0.0005° past the
centerline is the convention the existing areas follow. It is not worth agonizing over.

Overpass answers 406 to any request without a User-Agent header, which is what Node sends by
default. `add:area` sets one; anything else querying Overpass has to as well.

## Hard rules

**Never hand-edit generated artifacts.** Regenerate them with the script that owns them:

- `public/denver-west-routes.json` and `public/denver-west-routes.js` (~9 MB each, same payload — the
  `.js` assigns it to `window.DENVER_WEST_ROUTE_INVENTORY` for instant first paint). They are always
  written together and must stay in sync.
- `data/inventory-coverage-report.json`
- `data/mapping-cache-*.json`, `data/mapping-report-*.json`

**Bump the versioned constants together.** `add:area` and `scripts/lib/asset-versions.js` do this for
you; reach for the manual route only for a change no pipeline script drives. Changing any file in
`public/` means updating its `?v=` string in *both* places, or the change silently fails to reach
installed clients:

- [public/index.html](public/index.html) — the `?v=` query on each `<link>` / `<script>`
- [public/sw.js](public/sw.js) — the matching entry in `APP_SHELL`, plus `CACHE_NAME` on line 1

Two more versioned constants live in [public/app.js](public/app.js):
`STATIC_ROUTE_INVENTORY_URL` (line ~1549) and `SLOANS_LAKE_FULL_INVENTORY_CACHE_KEY` (line ~1548).
`test/static-cache-version.test.js` enforces all of this — if it fails, fix the versions, don't
weaken the test.

**Record an area once, in `data/coverage-pilot-areas.json`.** Its bounds, whether it publishes pink
fallbacks (`published`), and its coverage expectations (`coverage.expectedPublicBlocks`,
`coverage.minimumScheduled`) are read from there by
[scripts/sync-expected-coverage.js](scripts/sync-expected-coverage.js) and
[test/inventory-coverage.test.js](test/inventory-coverage.test.js). The payload's `areaLabel` is
composed from `payloadAreaLabel` in the same file — curated prose, deliberately not one phrase per
area, since several neighbouring areas are summarized as a single span. Do not retype any of this
into the script or the test; a hand-copied rectangle that drifts makes the test assert against the
wrong box while still passing. Two published areas were missing from this file entirely until
2026-08-21, which is exactly the failure this rule prevents.

**The product invariant: no mapped public street block may render blank.** An unmatched public block
either resolves to a scheduled route or becomes a pink `dataUnavailable` overlay. Anything left over
is an `unexplained-gap`, and `build:inventory` throws rather than publish it.

**Glendale is not Denver, and pink is the wrong answer there.** The City of Glendale is an
independent municipality wholly enclosed by Denver, straddling Cherry Creek between Colorado
Boulevard and South Cherry Street. Denver's API returns nothing for its streets, so without help they
all become pink — and pink tells the user *you do not need to move your car*, while Glendale sweeps
and tickets its own streets. [scripts/lib/glendale-city-limits.js](scripts/lib/glendale-city-limits.js)
holds the boundary (OSM relation 112942) and `isGlendaleBlock` drops those blocks at import time, so
they are excluded rather than published. The test is deliberately buffered 20 m inside the line:
Glendale's boundary runs down the middle of Colorado Boulevard, South Cherry Street and East
Mississippi Avenue, and a plain inside/outside test throws away Denver's real coverage on its own
half of all three. Any new area touching Cherry Creek east of Colorado needs no extra work; the rule
is geometric, not a list of ids.

**Nothing outside Denver gets published, and that test is general.** Glendale was only the enclave
that bit first. [scripts/lib/denver-city-limits.js](scripts/lib/denver-city-limits.js) carries the
whole city line — OSM relation 1411339, admin_level 6, stitched into one outer ring plus five holes,
simplified at one metre — and `isOutsideDenverBlock` drops anything beyond it at import time, for
the same reason Glendale is dropped. The importer applies Glendale first so those blocks keep their
more specific exclusion reason, then this. Holes matter as much as the outline: Glendale and the
Holly Hills pocket of unincorporated Arapahoe County are interior, not edge bites, so the ray casting
runs even-odd across every ring at once. The 20 m buffer is Glendale's, for Glendale's reason — the
line runs down the middle of South Yosemite, South Havana, East Hampden, East Yale and East
Belleview, and Denver sweeps its own curb on all of them. A block split evenly across the line is
kept, not dropped.

This is load bearing in the southeast, where Denver interleaves with Aurora, Greenwood Village and
Cherry Hills Village: the six areas from Colorado Boulevard to I-225 excluded 1,771 blocks between
them, every one of which would otherwise have shipped as pink. Validated against Denver's own API —
excluded blocks return zero routes, published ones return one to six — and spot-checked against
Nominatim. Do not add per-area rectangles to work around a municipal boundary; fix the geometry here
instead.

Dropping the block is only half of it. A block that is Denver's but whose geometry reaches across
the line — a street that runs out of the city mid-block, or an OSM way that carries on into
Englewood — stays in the manifest, and the pink drawn for it used to run the full length of the way.
`clipPathToDenver` trims the fallback to the part inside the city, at the same 20 m buffer and for
the same reason: cutting at the line itself would shred a curb drawn on the centreline of a shared
street into dashes. A path that leaves Denver and comes back yields one route per surviving piece,
the first keeping the block's id. `test/inventory-coverage.test.js` asserts that no published pink
route reaches past the buffer, so a fresh crawl cannot quietly reintroduce this.

`sync:city-limits` is the retroactive half. The rule runs at import time, which is the right moment
for it, but it landed after most of the map was published and re-importing a published area drifts
(see the Overpass note below). The script asks the same geometric question of the blocks already in
the manifest, excludes what fails, and restates the affected areas' `expectedPublicBlocks`; run
`sync:coverage` afterwards to regenerate the pink. It found 149 blocks in five areas on
2026-08-25 — Englewood, Sheridan and the Holly Hills pocket, confirmed against Nominatim — and of
the 1,920 blocks now carrying that exclusion reason, exactly one resolves to a Denver schedule.
Re-run it whenever the boundary geometry is refined; it is idempotent.

**The map and the pipeline read the city line from one file, and it lives in `public/`.**
[public/denver-city-limits.js](public/denver-city-limits.js) is a UMD module in the shape of
`public/curb-geometry.js`: the rings, `BOUNDARY_BUFFER_METRES`, the point-in-city and
distance-to-line predicates, and `getDenverMaskRings()`. A plain `<script>` tag loads it for the
map; [scripts/lib/denver-city-limits.js](scripts/lib/denver-city-limits.js) requires it and adds the
pipeline-only half (`isOutsideDenverBlock`, `clipPathToDenver`), re-exporting everything so callers
still see one module. Do not copy the rings anywhere, and do not give the client its own boundary
source.

It used to have one. `public/app.js` fetched Denver's own ArcGIS boundary layer at runtime and drew
the red "outside Denver" wash from it, on the raw city line, while the exclusion above used the OSM
rings with a 20 m buffer. Two independently digitised boundaries, and a buffer on one side only, put
**589 published routes under red paint — 261 of them with real sweeping schedules, 219 covered end
to end** — concentrated on the boundary streets Sheridan, Belleview, Yale, Mississippi and Yosemite.
Red means *the app has nothing here*, so that read as a coverage hole over curb the app covers.
Measured 2026-08-25; the shared module brings it to 95 routes, 19 scheduled, 15 covered end to end.

The authoritative-looking option was the wrong one. Denver's ArcGIS layer is the City Engineer's
Office's own "Denver Boundary" and it is better data, but the pipeline cannot use it — it is a
network fetch, the import and audit scripts are deliberately offline, and switching would reclassify
thousands of published blocks. Agreement is the property that matters here, not authority. Denver's
jurisdictional line is not its sweeping line in any case: the sweeping API returns real schedules
for N Sheridan Blvd, which that layer places outside the city.

The mask is the city line pushed **out** by `BOUNDARY_BUFFER_METRES`, not the line itself — drawn
raw it covers 625 published routes, 244 end to end, because the line runs down the middle of the
streets it shares. `getDenverMaskRings()` offsets each ring with round convex corners and mitered
concave ones, drops the enclaves narrower than twice the buffer (they invert), and is filled
even-odd. It is a vertex offset, not a clipper: features narrower than 40 m fold instead of closing,
which is where the residual 15 stubs come from — an 11 m finger at Glendale's southern tip on
Colorado Boulevard, and similar ones on Leetsdale, Belleview, Havana and Yale. Closing those means
untangling self-intersecting loops, which is a real polygon clipper; the budget in
`test/denver-city-limits.test.js` guards against the count growing rather than pretending it is zero.

**Pink must never be drawn inside a city Denver does not sweep, and geometry alone
cannot enforce that.** The enclave tests (`isGlendaleBlock`, `isOutsideDenverBlock`) carry a 20 m
buffer because an enclave's line runs down the middle of the streets that ring it — Colorado
Boulevard, South Cherry Street, East Mississippi Avenue around Glendale — and Denver sweeps its own
curb on every one. The buffer is not caution, it is necessary: measured 2026-08-25, **29 blocks that
Denver returns real sweeping schedules for sit inside the Glendale ring, at a median depth of 5.6 m,
against 5.8 m for Glendale's own side streets.** The two are geometrically indistinguishable, and no
threshold separates them. Do not try to fix this by tightening the ring or lowering the buffer; that
throws away Denver's boulevard coverage, which is what the buffer was added to protect.

What separates them is Denver's own answer. A block with a sweeping schedule is Denver's whatever
the boundary says; a block Denver returned nothing for, sitting inside an enclave by the plain
unbuffered test, is the enclave's. That evidence does not exist when the importer runs, which is why
`isInsideGlendaleUnbuffered` and `isInsideEnclaveUnbuffered` exist and why
[scripts/sync-city-limits.js](scripts/sync-city-limits.js) — running *after* the crawl — is their
only caller. It found **45 blocks of Glendale's grid** (Dahlia, Cherry, Kentucky, Tennessee,
Leetsdale) and **22 in the Holly Hills pocket** published as pink, which tells the user *you do not
need to move your car* on curb those cities sweep and ticket. Both invariants are asserted by
`test/inventory-coverage.test.js`: no pink inside an enclave, and Denver's scheduled curb on the
ring roads still published.

The rule is deliberately not applied past the **outer** city line. Out there the same ambiguity
exists with no enclave to bound it, and most of what it would catch is shared boundary streets where
pink is often Denver's own. `check:city-limits` reports those for a human instead.

**Keep a second opinion on the city line.** Collapsing the map and the pipeline onto one geometry was
right, but it removed an accidental cross-check — while the map fetched Denver's own boundary layer,
a divergence was at least visible. `npm run check:city-limits` is the deliberate replacement: it
fetches Denver's ArcGIS "Denver Boundary" layer (City Engineer's Office, cached at
`data/denver-official-boundary.json`), and reports published blocks that layer places outside the
city or inside an enclave, excluded blocks it places inside, and how far the two lines diverge.
The very first run found the Glendale and Holly Hills pink above. It reports; it never writes.

Read its output with the schedule column in mind — a `[scheduled]` divergence is Denver telling you
it sweeps there, and needs no action. As of 2026-08-25 the lines agree to a median of 2.1 m, and 18
blocks remain flagged with no schedule: 10 where our rings and Denver's disagree about an enclave
edge, and 8 on shared boundary streets. Both need a person, not a rule. The three standing entries
under "excluded blocks Denver's layer places inside the city" — N Tennyson, Polo Club Road, Polo
Field Lane — are deliberate exclusions documented elsewhere in this file, and are expected there.

This script is the one exception to *don't call city services directly*: that rule is about route
lookups, where parsing and geometry extraction belong in the `/api/denver/sweeping` proxy, and there
is no proxy for the boundary layer.

**The auditor indexes routes by street name — keep it that way.**
[scripts/lib/inventory-auditor.js](scripts/lib/inventory-auditor.js) groups routes into a
`Map` keyed by normalized street name once per run, memoizes `normalizeStreetName`, and rejects
candidate routes by bounding box before walking their geometry. It used to rescan all ~12,700 routes
for every one of the ~12,000 public blocks, calling a 15-regex normalizer on each — about 153 million
normalizations, and a full audit took 89 seconds. Indexed, the identical audit takes 0.1 seconds, and
`npm test` went from 155s to 0.5s. If you refactor the matching loop, verify the report is unchanged
byte for byte against the previous implementation before trusting it; the classification is load
bearing.

**Don't re-crawl Denver for a logic fix — use `rebuild:offline`.** `build:inventory` bundles two
unrelated jobs: crawling Denver's API for the whole city, and running the offline pipeline over what
came back. A change to the classifier (`scripts/lib/inventory-auditor.js`) needs no new data, because
the routes already in `public/denver-west-routes.json` are the same routes a fresh crawl returns.
`npm run rebuild:offline` reruns only the classification, in about a minute with zero API calls.
Denver's API rate-limits the full crawl hard: sustained bulk runs start returning HTTP 200 with empty
payloads, which silently produces a wrecked inventory (~859 scheduled instead of ~8,500) rather than
an error. Reach for the full crawl only when you actually want fresh data from Denver — schedule
changes, new or retired routes, seasonal updates, or a pilot area that has never been crawled.

`rebuild:offline` is deliberately narrow: it reclassifies, and withdraws a pink fallback when its
block now resolves to a real schedule. It never invents new pink coverage (reprocessing learns
nothing new about a block, and several uncovered blocks are unpublished by deliberate product
decision), and it does not replay the coverage patches — those are written against a fresh crawl and
replaying them mixes in unrelated accumulated drift. Change a patch, run the full crawl.

**Some tests assert on source text, by design.** `test/not-maintained-ui.test.js` matches
`/notMaintained: "#7b8790"/`; `test/curb-geometry.test.js` reads `public/app.js` as a string. Renaming
a variable or rewording UI copy will break them even when behavior is unchanged. That is expected —
update the test alongside the code, don't dismiss it as flaky.

**Don't add dependencies, a bundler, a framework, or a linter without asking.** The zero-build setup
is intentional.

**Don't call `denvergov.org` directly from a script.** Always go through the app's own
`/api/denver/sweeping` proxy so parsing, timeouts, and geometry extraction stay in one place.

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

  → public/denver-west-routes.json + .js        (published, consumed by the client)
  → data/inventory-coverage-report.json         (diagnostic)
```

Route geometry is not returned as coordinates by Denver — it is parsed out of the Google `staticmap`
URL the city embeds in each route (`parseStaticMapGeometry` in [server.js](server.js)).

Hand-curated coverage patches live in [scripts/lib/](scripts/lib/) as `confirmed-*-coverage.js`
modules and as patch functions inside `build-static-inventory.js`. Each carries a comment explaining
why a specific Denver route id is patched or suppressed. Preserve those comments.

## Domain vocabulary

- **Route** — a Denver-returned street segment with left/right sweeping rules, directions, schedules,
  and map geometry.
- **Expected block** — one atomic public street block in `data/inventory-expected-blocks.json`;
  may be `excluded: true` with an `exclusionReason` (alleys, private drives, out of bounds).
- **Coverage audit** — `auditInventory({ routes, blocks, matchToleranceMeters: 12, minimumCoverage: 0.9 })`.
- **Pilot area** — a named bbox in `data/coverage-pilot-areas.json`. Its id is the suffix used
  everywhere: `mapping-cache-<area-id>.json`, block ids `<area-id>-osm-<way>-<node>-<node>-<n>`.
  That file is the single source of truth for an area (see the hard rule below).
- **Mapping cache** — `data/mapping-cache-<area>.json`, memoized lookups keyed by coordinate or
  address so reruns are cheap. Empty successful results are cached too.
- **Mapping report** — `data/mapping-report-<area>.json`, per-stage stats plus `unresolved[]` blocks
  flagged `needs-human-review`.
- **Color semantics** — pink = schedule unavailable, *you do not need to move your car*;
  gray `#7b8790` = not maintained by Denver, reminders disabled.

## Code style

Match the surrounding code. There is no linter or formatter, so consistency is manual.

- CommonJS `require` / `module.exports`. `public/curb-geometry.js` uses a hand-rolled UMD wrapper so
  it works in both Node tests and the browser — keep that shape.
- Double quotes, semicolons always, 2-space indent, no trailing commas.
- `const` and arrow functions by default; `async`/`await` with hand-rolled `runPool(items, worker)`
  concurrency helpers.
- Long descriptive function names (`ensureRinoOfficialRouteCoverage`,
  `applySouthKnoxAlamedaInterchangeGeometry`).
- Comments explain *why*, especially for data patches. Prose style, full sentences.

## Working across Claude Code and Codex

The user alternates between tools on this repo. These rules keep that from corrupting anything:

1. **This file is the only instruction file.** If you learn a durable rule about this project, add it
   here — never to one tool's private memory, where the other tool cannot see it.
2. **One tool per working tree at a time.** Commit or stash before switching. Two agents editing the
   9 MB generated JSON concurrently produces a conflict that cannot be resolved by hand.
3. **Never run `build:inventory`, `map:area`, or `sync:coverage` from two tools at once.** They
   rewrite the same three published files and share the `data/mapping-cache-*.json` files.
4. **Before handing off:** run `npm run audit:inventory`, then commit. Leave the tree clean.
5. **After picking up:** run `git status` and `git log --oneline -5` before editing anything.
6. Work happens on `develop`. `main` is the release branch.

## Environment variables

`HOST`, `PORT`, `DATABASE_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — see
[.env.example](.env.example). Two more are undocumented there:

- `ISSUE_REPORT_ADMIN_TOKEN` — gates reads of `/api/issue-reports` via `Authorization: Bearer <token>`.
- `APP_ORIGIN` — which server the pipeline scripts query. Defaults to localhost for
  `build-static-inventory.js`, **production** for `map-area-approach-3.js`.

Push notifications do nothing without `https://`, VAPID keys, and `npm install`.

## Known issues and historical quirks

- **Denver's route lookup crashes on North Tennyson Street.** Coordinates anywhere along Tennyson
  between W 46th and W 52nd return HTTP 500 with " Object reference not set to an instance of an
  object." from Denver, while the service is otherwise healthy — one street east at -105.0400 returns
  four routes, all scheduled. This is an upstream null-reference defect, not an absence of sweeping,
  so no amount of re-crawling will resolve those blocks and the curated client-side pink in
  `ensureUnavailableTennysonCoverage` is the coverage. Confirmed 2026-08-24, and it is why the pink
  is hand-drawn there. Do not read an empty or failed Tennyson lookup as "Denver does not sweep it".
- **Denver's address lookup is returning HTTP 400.** `/api/denver/sweeping?address=...` fails for
  every address while the coordinate form (`?latitude=&longitude=`) works normally. This predates
  2026-08-22 — the `intersection-addresses` stage of `map:area` already scored 0 resolved out of 16
  attempts in the areas mapped before then, so it is a last-resort fallback and costs the pipeline
  almost nothing. It does degrade the in-app address search, which falls back to a fuzzy match and
  can land on the wrong quadrant (searching "Iowa and Bellaire" matches *N* Bellaire in Sloan's
  Lake). Coordinate lookups carry all of the coverage; don't re-plumb the pipeline over this.
- **Re-importing an already-published area against a fresh Overpass extract drifts.** Verified on
  2026-08-22: re-running the importer for `dakota-louisiana-broadway-colorado` returned the same 2728
  blocks but 930 public instead of 927, because Polo Club Road had lost its `access=private` tag in
  OSM since the original import — which silently un-excluded a block that
  `confirmed-polo-club-coverage.js` needs excluded, failing `test/inventory-coverage.test.js`. Only
  re-import a published area when you have its cached `data/osm-extract-<area-id>.osm`; the cached
  file reproduces exactly.

- **A clean coverage report is not a precondition.** `sync:coverage` writes the report with
  `generateUnavailable: false` and does not enforce the build gate, so
  `data/inventory-coverage-report.json` can show `unexplained-gap` counts while the app is fine. As
  of 2026-08-25 that is 4 blocks: 3 Larimer St and 1 N Yates St. It was 19 the day before — the
  Martin Luther King routes now match their blocks and the Tennyson blocks are excluded. Only
  `build:inventory` enforces the gate, and with `generateUnavailable` on those 4 become pink rather
  than gaps.
- **The published inventory is stale relative to the scripts, and a full rebuild will surface it.**
  Re-measured 2026-08-24, correcting an earlier version of this note that sent one agent down a
  wrong path. `build:inventory` would **publish cleanly** — `audit.unexplainedGaps` is 0, so the
  build gate does not throw. Two tests then fail against the regenerated payload:

  - `ensureRinoOfficialRouteCoverage` brings LARIMER ST unavailable routes from 6 to **11** (33rd–34th,
    34th–35th and three `rino-larimer-*`), while `test/curb-geometry.test.js` asserts exactly 6. The
    count can only be corrected *with* the crawl: that test reads the committed payload, so changing
    it to 11 beforehand fails immediately.
  - ~~The seven Tennyson blocks publish as pink.~~ **Resolved 2026-08-24** by marking them excluded
    in the manifest. They were never a coverage gap: `ensureUnavailableTennysonCoverage` in
    `public/app.js` already draws all seven as pink client-side, from hand-curated intersection
    coordinates rather than the OSM geometry, and it deliberately sets no `expectedBlockId` — which
    is exactly what the test keys on. The build must not emit a second, OSM-shaped pink for the same
    curb. Excluding the blocks stops the audit generating one while leaving the client's coverage
    untouched, so nothing changes on the map. The Yates block and the eight MLK blocks have no
    equivalent client-side function and are still open.

    Only the Larimer count above now stands between a fresh crawl and a green suite.

  **The four `routeMap.delete(...)` calls in `auditAndPublish` are not part of this and must stay.**
  An earlier version of this note claimed they blank out blocks whose real coverage is 0.18–0.36.
  That reads the audit's bookkeeping as if it were the rendered map. It is not: `public/app.js` holds
  a `suppressedFallbackRouteIds` set with the S Lowell and S Osceola fallback ids and filters them
  before drawing, and the confirmed official routes draw underneath. The deletes are the build-side
  half of that deliberate, screenshot-confirmed pairing, and `test/curb-geometry.test.js` enforces
  both halves with source-text assertions. Removing them turns two tests red for no gain. The S Pecos
  and E 26th Parkway deletes are inert against the current payload — both blocks audit as scheduled
  at coverage 1.000 — but they cost nothing and still guard a fresh crawl.

  Reproduce any of this offline in about two seconds, with no API calls: load
  `public/denver-west-routes.json`, run the exported `applyCoveragePatches(routeMap, manifest.blocks)`
  over it, then `auditInventory`. Do not call `auditAndPublish` for this — it writes `public/`.
- **The service worker cache match is exact.** [public/sw.js](public/sw.js) calls
  `caches.match(event.request)` without `ignoreSearch`, so a precached `styles.css?v=A` will never
  satisfy a page request for `styles.css?v=B` — a version mismatch quietly removes that asset from the
  offline fallback. This is why the version test exists.
- **First load is not truly offline.** Leaflet 1.9.4 comes from unpkg; `public/vendor/leaflet/` is an
  empty leftover directory.
- **Names are historical.** `denver-west-routes.*` and every `sloans-lake-*` localStorage key now hold
  city-wide and east-Denver data. Don't infer scope from the names.
- `data/` is ~90 MB. `data/inventory-expected-blocks.json` alone is 16 MB. Grep with care, and never
  read these files whole.

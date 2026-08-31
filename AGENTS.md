# AGENTS.md

Instructions for any AI coding tool working in this repo (Claude Code, Codex, and anything else).
This is the single source of truth. `CLAUDE.md` is a pointer to this file and must stay a pointer.

## What this is

**Denver Curb Alerts** — a street-sweeping / parking-ticket-avoidance PWA for Denver. It proxies the
city's public sweeping API, draws curb segments on a Leaflet map, separates left-side from right-side
sweeping rules, and schedules web-push reminders.

Deliberately minimal stack:

- `server.js` — a zero-framework `node:http` server. Static files + `/api/*`. No Express.
- `lib/accounts.js`, `lib/billing.js` and `lib/email.js` — the only things outside `server.js` that
  are server runtime rather than pipeline tooling, which is why they are not under `scripts/lib/`.
  `accounts.js` is pure, no I/O. `billing.js` is pure apart from `stripeRequest`, and `email.js`
  apart from `sendEmail`; in both, that is deliberately the one function touching the outside world,
  and everything above it in the file can be tested without a key or a network.
- `public/app.js` — the entire client, ~6000 lines of vanilla JS loaded by a plain `<script>` tag.
- **No bundler, no transpiler, no build step for client code.** What is in `public/` is what ships.
- Two dependencies (`pg`, `web-push`), both lazily `require`d so the app boots without `npm install`.
  Accounts added none: `node:crypto` has scrypt, and there is no bcrypt or session framework here.
  Payments added none either — Stripe is form-encoded HTTPS and an HMAC, so it is `node:https` and
  `node:crypto`. There is no `stripe` package. Email added none: Resend is one JSON POST, so there
  is no `resend` package and no nodemailer.
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
| `npm run lock:assets` | Re-records `data/asset-version-lock.json` after a hand-bumped `?v=` tag. No network. Refuses to record a change with no new version behind it. |
| `npm run check:city-limits` | Audits our city line against Denver's own published boundary. Reports only, never writes. Cached after the first run. |

Not wired to npm: `node scripts/import-osm-expected-blocks.js <map.osm> <area-id> <south> <west> <north> <east>`.

### Adding a pilot area

`add:area` is the one command to reach for. It fetches the OpenStreetMap extract, imports the
expected blocks, crawls Denver for that area, reconciles coverage, measures the result, records the
coverage expectations, extends the payload and README labels, and bumps the three versioned asset
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

**But do agonize over the edge values, because `add:area` only checks for overlap.** Two areas that
abut without sharing an exact edge value leave a sliver nothing ever imports, and the refusal that
catches stacking says nothing about it. `e26-e37-gilpin-york` and `e26-e37-josephine-colorado` ended
at 39.7685 while `e38-e45-blake-colorado` began at 39.7692, and the 78 m strip between them ran
2.3 km from Gilpin to Colorado. It was not empty: it held five blocks of E 38th Avenue plus one
crossing block of every named street in between, 32 public blocks in all, every one rendering blank.
Closed 2026-08-27 as `e37-e38-gilpin-colorado`.

To find these, grid the region at 0.0003° (~33 m by ~26 m), drop every cell that falls inside some
area's rectangle, drop every cell `isPointInsideDenver` rejects, and flood-fill what is left into
clusters. Genuine unmapped neighbourhoods come out as blobs; seams come out as lines one or two
cells thick, which is the signature to look for.

The step used to be 0.001° here, described as finer than any real sliver. It is not. The gap
between `e8-e17-york-colorado` (east -104.9404) and `e6-e17-colorado-monaco` (west -104.9398) is
51 m, and at 0.001° that is the single-cell column this paragraph used to tell you to dismiss as
grid resolution. Do not dismiss one — read the two edge values and see. Closed 2026-08-27 as
`e8-e17-colorado-infill`, along with the 267 × 769 m corner nothing covered between
`e6-colfax-monaco-yosemite`, `e6-e17-colorado-monaco` and `e17-e26-colorado-quebec`, closed as
`colfax-e17-monaco-quebec`.

Comparing edge values pairwise finds the mismatches faster than the grid, but it over-reports: two
areas can disagree about an edge and still have the space between them covered by a third. After
`e8-e17-colorado-infill` the pair above still reads as a 51 m mismatch, because it is one. The
flood-filled clusters are the ground truth for whether anything is actually uncovered.

`dakota-louisiana-broadway-colorado` and `dakota-louisiana-colorado-monaco` ended at 39.7098 while
`alameda-e7-lincoln-colorado` and `alameda-e5-colorado-monaco` began at 39.7107, leaving a 100 m
band that ran about 6.4 km from Broadway to Monaco. It did **not** hold E Alameda Avenue, despite
the area names either side of it — Alameda runs at 39.7110–39.7124 and was always inside the
`alameda-*` areas. What the band held was E Cherry Creek North and South Drive, E Mar Vista Place,
W Nevada Place, and a crossing stub of roughly fifty named north–south streets from Broadway to
Monaco: 110 public blocks, 104 of them scheduled. Closed 2026-08-27.

It took three areas rather than one, and the shape is worth understanding before adding a fourth
somewhere near it. `w6-alameda-lipan-broadway` reaches south to 39.7104, three hundredths of a
degree into the band, but only west of Lincoln (-104.987) — so the band is an L, not a rectangle:
`alameda-infill-broadway-colorado` takes 39.7098–39.7104 across the full width to Broadway,
`alameda-infill-lincoln-colorado` takes 39.7104–39.7107 from Lincoln east, and
`alameda-infill-colorado-monaco` takes the whole height east of Colorado. Cutting the first one off
at Lincoln instead would have dropped S Broadway's own stub.

**The band runs straight through Polo Club, and that needed a code change, not a data one.** Polo
Club is the gated community `scripts/lib/confirmed-polo-club-coverage.js` publishes gray
not-maintained routes for, and every block there is meant to be excluded. Exclusion keys on
`access=private` alone, and four of its thirty-two ways — `Polo Club Road` 16985371 and
`Polo Field Lane` 515376359, 515376361, 515376364 — have lost that tag upstream. This is the same
drift recorded further down this file, still unrepaired and now on more ways. Denver returns zero
sweeping routes for both roads, confirmed against the proxy, so a fresh extract imports the four as
public streets and publishes them as pink — *you do not need to move your car* — on gated private
road.

Patching the cached `.osm` was the obvious fix and it is the wrong one: `data/osm-extract-*.osm` is
gitignored, so the patch would live on one machine and the next person to import would republish the
pink without ever seeing why. The list lives in `privateWayIds` in
[scripts/import-osm-expected-blocks.js](scripts/import-osm-expected-blocks.js) instead, where it is
committed and applies to any extract. Verified by re-importing `alameda-infill-broadway-colorado`
from a deliberately unpatched extract: all 138 blocks identical, all 33 Polo Club and Hyde Park
blocks excluded. Drop a way id from that set only when OpenStreetMap has the tag back.

Overpass answers 406 to any request without a User-Agent header, which is what Node sends by
default. `add:area` sets one; anything else querying Overpass has to as well.

## Hard rules

**Never hand-edit generated artifacts.** Regenerate them with the script that owns them:

- `public/denver-west-routes.json` (~11 MB), the published inventory. What it contains is decided in
  one place, [scripts/lib/publish-payload.js](scripts/lib/publish-payload.js) — see the payload rule
  below. There used to be a `public/denver-west-routes.js` beside it holding the identical payload
  assigned to `window.DENVER_WEST_ROUTE_INVENTORY`; it is gone, and nothing should reintroduce it.
- `data/inventory-coverage-report.json`
- `data/mapping-cache-*.json`, `data/mapping-report-*.json`
- `data/asset-version-lock.json` — written by `scripts/lib/asset-versions.js`, refreshed by
  `npm run lock:assets`. Editing it by hand is how you silently disarm the freshness test below.

**Bump the versioned constants together.** `add:area` and `scripts/lib/asset-versions.js` do this for
you; reach for the manual route only for a change no pipeline script drives. Changing any file in
`public/` means updating its `?v=` string in *both* places, or the change silently fails to reach
installed clients:

- [public/index.html](public/index.html) — the `?v=` query on each `<link>` / `<script>`
- [public/sw.js](public/sw.js) — the matching entry in `APP_SHELL`, plus `CACHE_NAME` on line 1

One more versioned constant lives in [public/app.js](public/app.js):
`STATIC_ROUTE_INVENTORY_URL`. There used to be a second, `SLOANS_LAKE_FULL_INVENTORY_CACHE_KEY`,
versioning the localStorage key the inventory was mirrored under; that mirror is gone (see below) and
so is the constant. `test/static-cache-version.test.js` enforces all of this — if it fails, fix the
versions, don't weaken the test.

**Agreement between those two files is not freshness, and the difference has bitten once.** They can
agree perfectly on a version that is simply too old for the bytes now on disk, and then installed
clients never refetch — `caches.match` has no `ignoreSearch`, so a precached `?v=A` answers nothing
else and the asset quietly falls out of the update path. That happened on 2026-08-26: the bumper
retagged by string-matching the current app tag, the since-removed `denver-west-routes.js` had
drifted onto an older tag during four UI-only commits, and a rebuilt 18 MB payload shipped under the
tag clients already had. `data/asset-version-lock.json` closes it by recording each asset's sha256 *at the version it
ships as*, so the test can tell a file that changed with its tag from one that changed without it.
The shell files carry no `?v=` of their own, so `CACHE_NAME` is their version and the lock treats it
as one — change `index.html` or `sw.js` and the cache name has to move too.

The pipeline path needs nothing: `bumpAssetVersions` rewrites the lock itself, and refuses up front
if an asset it does *not* retag (`curb-geometry.js`, `denver-city-limits.js`, `icon.svg`,
`manifest.webmanifest`) is sitting there changed. The hand path is bump the tag in both files, then
`npm run lock:assets`.

**The map draws the viewport, not the city, and merges everything that shares a style.** Leaflet
redraws every layer it owns on each pan and zoom, and the map holds about 19,700 street ways and
39,000 curb segments. One polyline per way and three per segment — an invisible 30 px hit target, a
white casing, the colour — came to **158,425 Leaflet layers**, each with its own id, bounds, event
bucket and projection pass. Measured 2026-08-26 on a desktop: **482 ms** of blocked main thread for
one zoom step, **5,036 ms** for one pan. Two changes fix it, in `renderStreetBases` and
`renderSegments` in [public/app.js](public/app.js):

- **Cull.** A padded bounding-box test against bounds cached on the record itself (`renderBounds`,
  computed once — recomputing them per pan gives back exactly what the cull saved).
- **Merge.** Leaflet takes an array of line strings as one multi-polyline, so everything sharing a
  style collapses into one layer. Curbs carry six colours (`colors`) and the underlay two.

Together: **75 layers**, a pan at block zoom that registers **no long task at all**, and 284 ms at
the whole-city view. Both are needed — culling does nothing at city zoom, where everything is in
view, and merging is what makes that case cheap.

Merging is not free of consequences, and both of these are load bearing:

- **A merged path is stroked once, so overlapping strokes no longer accumulate alpha.** At block
  zoom curbs do not overlap and nothing changes. At the whole-city view thousands of them do, and
  drawing 39,000 curbs at `weight: 4` there produced a solid smear instead of the old speckled
  coverage picture. `isOverviewZoom()` (below `CURB_OVERVIEW_MAX_ZOOM`, 14) drops the street
  underlay and the white casing — both exist to tell one curb from the one beside it, which is
  meaningless at that scale — and draws curbs at `weight: 1`. That restores the original look and is
  most of why the city view got cheap. Do not "fix" an overview-zoom appearance change by raising
  opacity; that was tried and it made the smear worse.
- **There is no longer a layer per curb to bind a click or a tooltip to.** `findSegmentNearPoint`
  replaces 39,000 invisible hit targets with one hit test over `state.visibleSegments` — what the
  last render actually put on screen — rejecting each by its cached bounding box first.
  `CURB_HIT_TOLERANCE_PIXELS` is 15 because the old target was a 30 px-wide stroke, and it converts
  through the zoom's metres-per-pixel so the tap target stays the size it has always been. The hover
  label is built on demand in `getSegmentHoverLabel`; it used to be built for all 39,000 segments on
  every render, each with its own `getNextSweepDate` call, to answer a hover landing on one of them.

`moveend` matters as much as `zoomend` now. The old renderer listened only for `zoomend`, which was
correct when it drew the whole city every time and panning could not reveal anything undrawn; with
culling, a pan that reveals new ground has to redraw. Both go through `scheduleMapRender`, which
coalesces into one animation frame so a drag does not queue a redraw per move event.

**Everything in the published payload is downloaded before the map can draw, so decide what ships
in one place.** [scripts/lib/publish-payload.js](scripts/lib/publish-payload.js) is that place, and
all three writers of `public/denver-west-routes.json` go through it. Measured 2026-08-26, the page
was fetching the inventory **twice** — a blocking `<script>` for `denver-west-routes.js` plus
`app.js` fetching the `.json` with `{ cache: "reload" }`, which bypasses the HTTP cache outright — so
every visit pulled 36.7 MB uncompressed. The `.js` was only ever the `catch` fallback; `app.js` now
publishes the fetched payload to `window.DENVER_WEST_ROUTE_INVENTORY` itself, which is what
`preserveKnownWeeklyRoutes` and `ensureWest10FederalDecaturCoverage` read to backfill routes a
sampled live lookup can miss. With that copy gone, the dead fields dropped (`map.staticMapUrl`,
3.90 MB, parsed into `map.path` at crawl time and read by nothing; `subscriptions`, 1.85 MB, Denver's
own bookkeeping) and coordinates rounded, the wire cost is **786 KB against 36.7 MB**.

Coordinates round to **seven** decimals, not six. The auditor samples a block every 8 m and matches
anything within 12 m, and blocks sit within centimetres of that line — E Belleview at S Niagara is
11.9 m from the pink route across the divided avenue, and six decimals (11 cm) tipped it from
`unavailable` to `unexplained-gap`. Seven reclassifies nothing, verified block-for-block across all
20,979 public blocks. **Rounding is lossy and not reversible**: re-running `rebuild:offline` over an
already-rounded payload cannot restore precision, so if you change `COORDINATE_PRECISION`, regenerate
from a payload that has not been rounded at the new setting yet, and re-run that block-for-block
comparison.

**The server compresses and the versioned URLs are immutable.** `serveStaticFile` in
[server.js](server.js) negotiates brotli or gzip for text assets and memoizes the compressed bytes
per `(file, encoding)`, keyed on mtime — the payload is far too large to recompress per request.
A request carrying a `?v=` gets `max-age=31536000, immutable`, which is only safe because the asset
lock above makes it a test failure for an asset's bytes to move without its version moving too;
`index.html` and `sw.js` stay `no-store`. Do not add a bundler or a CDN layer to solve this again.

**The service worker answers versioned assets from Cache Storage, not from the network.** It used to
be network-first for every asset, with the cached copy consulted only if `fetch` *rejected*. That is
the wrong shape for a 12 MB inventory on a phone: a weak mobile connection does not reject, it
hangs, so the map sat empty for as long as the request took while a complete copy of the payload was
already in Cache Storage and untouched. Reported from a phone on 2026-08-30 as most streets never
filling in, and fixed the same day. The HTTP cache is not a substitute for this — Safari evicts a
resource that large long before it evicts a cache entry, so the device that most needs the local
copy is the one least likely to still have it, and a desktop with a warm disk cache will never
reproduce the bug. Cache-first is safe here only because of the immutability rule above: a `?v=` URL
never changes meaning, so a hit cannot be stale, and a changed asset always arrives under a URL that
misses the cache. Navigations and anything unversioned stay network-first, which is what keeps
`index.html` fresh and therefore what still delivers new versions at all. If you ever make a
versioned URL mutable, this strategy breaks silently and installed clients pin to the old bytes
forever.

**The inventory is not mirrored into `localStorage`, and must not be again.** It used to be, under a
versioned key, to get a first paint before the fetch resolved. Removed 2026-08-30 for four reasons,
none of which have expired: the service worker serves the payload from Cache Storage, which is
durable where localStorage is capped; `loadStaticRouteInventory` runs unconditionally at boot
regardless, so the mirror only bought a paint that the same data replaced moments later;
the blob had reached **40 MB**, sharing an origin quota with the user's saved curb sets and reminder
jobs, which are the data that actually matters and were being crowded out; and maintaining it cost a
40 MB serialize-and-write on **every load** — 104 ms of blocked main thread on a desktop, several
times that on a phone, and an outright rejection on iOS, where the write had in fact never once
succeeded. `purgeLegacyInventoryCache` clears the blob from installs that still carry one, matching
by key prefix because the version suffix moved over the years. Verified with the server stopped:
the map still loads complete from Cache Storage.

`saveJson` still swallows a failed `JSON.stringify` rather than throwing out of it. Keep that. Both
cache writes used to sit *between* `setMapDataset` and the `refreshMapViewport`/`renderAll` that
follow it, so a failed serialize threw past the render into the caller's own `catch`, whose
`if (!state.streetWays.length)` guard is already false by then — a fully loaded inventory in state,
never drawn. The writes are gone, but the shape of that bug is not specific to them: a best-effort
persist must never sit on the path to the first paint.

**The expected-block manifest is written minified, and that is deliberate.** GitHub warns above
50 MB and rejects a push outright at 100 MB. `data/inventory-expected-blocks.json` had reached
**61.87 MB** pretty-printed at two-space indent — 2.97 million lines, of which almost half the bytes
were whitespace. Written without the indent the same data is **36.00 MB**.
[scripts/lib/expected-blocks.js](scripts/lib/expected-blocks.js) owns that decision and both writers
go through it: `import-osm-expected-blocks.js` and `sync-city-limits.js`. The eight scripts and tests
that only *read* the manifest were deliberately left alone — `JSON.parse` does not care about
indentation — so nothing else had to change.

Do not reindent it to make it readable; at 97,827 blocks it is not readable either way. If it
outgrows 50 MB again, the next steps in order of cost are gzipping it (5.14 MB, but opaque to grep
and diff) or splitting it per area the way `data/mapping-cache-<area-id>.json` already is. Rewriting
git history to purge the old 62 MB blobs was considered and declined: it would force-push a shared
branch, and the per-file limit only applies to new pushes, so the working file is what matters.

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

**Pink was reworded on 2026-08-27 and that does not retire any of the rules above.** Every
argument in this section — Glendale, the outer city line, Polo Club, Tennyson — is written against
pink meaning *you do not need to move your car*, which it no longer says; it now says *we found no
Denver schedule here, check with Denver*. The new wording is less actively wrong on curb another
city sweeps, so the harm those exclusions prevent is smaller than the prose claims. It is still
harm. Pink over Glendale asserts something about Denver's data that is true and something about the
curb that is misleading — the block is swept on a published Glendale schedule, and pointing the user
at Denver's website sends them somewhere that will never answer. Keep excluding it. Read the older
paragraphs' *you do not need to move your car* as *pink is the wrong answer here*, which is what
they were reaching for.

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

**The `hidden` attribute loses to any class that sets `display`.** The UA stylesheet's
`[hidden] { display: none }` is the weakest rule in the cascade, so a `.account-card { display:
grid }` beats it and the element renders while `element.hidden` reads `true`. This was live on
2026-08-27: the signed-out sign-in form rendered underneath a signed-in account, and both account
subforms — including **Delete my account** — sat permanently on screen with their toggle buttons
appearing to do nothing. `.app-view[hidden]` had the fix from the start; the account card never got
it. If you add a class that sets `display` to an element the JS toggles with `hidden`, add the
matching `[hidden]` rule beside it, and verify with `getComputedStyle`, not with `element.hidden` —
the property is true either way, which is exactly why this went unnoticed.

**It bit a fifth element, and the pattern is that the guard list is easy to leave incomplete.**
`.account-action-row` sets `flex` and was not on the list, so `#account-forgot-row` — the one action
row the JS toggles — rendered on the **Create account** form, offering a password reset for an
address that does not have an account yet. Fixed 2026-08-29. When you write a new `[hidden]` guard,
grep the stylesheet for every class the toggled element carries rather than only the obvious one.

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

  → scripts/lib/publish-payload.js  slimRoutesForPublication()
  → public/denver-west-routes.json              (published, consumed by the client)
  → data/inventory-coverage-report.json         (diagnostic)
```

Route geometry is not returned as coordinates by Denver — it is parsed out of the Google `staticmap`
URL the city embeds in each route (`parseStaticMapGeometry` in [server.js](server.js)).

Hand-curated coverage patches live in [scripts/lib/](scripts/lib/) as `confirmed-*-coverage.js`
modules and as patch functions inside `build-static-inventory.js`. Each carries a comment explaining
why a specific Denver route id is patched or suppressed. Preserve those comments.

## Accounts and payments

Added 2026-08-27. Accounts are **optional and always will be**: every screen works signed out, saved
curb sets stay in `localStorage`, and `state.account === null` makes every account function on the
client a no-op. What signing in buys is that a saved set is no longer stranded in one browser, and
that a payment has something durable to attach to.

That last part is the reason accounts came first. Before this, the closest thing to an identity was
the **push subscription endpoint** — per-install, regenerated when the user reinstalls the PWA, and
the key that `data/push-subscriptions.json` and `data/reminder-plans.json` are still stored under.
You cannot bill an endpoint. Both records now carry an `accountId` as well, set when a signed-in
browser registers its device, which is the join the payment work will need.

**The account is its own view, reached from a header chip, not a fourth tab.** Moved out of the
alerts page on 2026-08-29. The three tabs are tasks — do it (Map), manage it (My alerts), learn it
(How it works) — and the account is settings for a feature the app deliberately works without; a
fourth tab beside Map advertises a sign-up wall on every visit, to people the free app is complete
for. `#account-chip` sits at the far end of the nav row, quiet, and reads `Sign in` until there is a
name to show. If you add another destination, ask first whether it is a task or a setting; only
tasks belong in `.app-tabs-scroll`.

**Moving it fixed a bug that had been live since the email work landed.** The emailed links are
built as `/?verify=` and `/?reset=` with no hash, and Stripe returns to `/?checkout=`, so boot
resolved the view to the map every time while `handleEmailLinks` and `handleCheckoutReturn` wrote
into a section inside the **hidden** alerts view. A password reset link was unreachable — the form
rendered at `display: none`, and `accountResetPasswordInput?.focus()` was a no-op on it. Both
handlers now call `setActiveView("account")` before they render anything. **Any new flow that
returns from an outside origin has to do the same**; the query string alone does not move the view.

**The chip carries the confirm-your-email dot, and that is not decoration.** The verify prompt used
to sit on the alerts page where someone on the way to their saved curbs could not miss it. Behind a
chip they can, so `renderAccount` toggles `.has-notice` for an unverified address. It is also why
`.app-tabs-scroll` exists as a separate element: on a phone the tab row scrolls sideways, and a
notice that scrolls off the end of a row is not a notice, so the chip is pinned outside the scroll.

**The alerts page keeps a one-line pointer at it** (`.saved-sets-account-note`, above the saved curb
sets), because that is the one place where what an account buys is concrete — those sets live in
this browser's `localStorage` until there is an account to hang them on. Its text and its link label
both flip when signed in; without that it keeps telling a synced user they are stranded.

**No new dependencies, and don't add one here.** `node:crypto` covers all of it: scrypt for password
hashing (16384/8/1, self-describing hash strings so the cost can be raised without invalidating old
ones), `randomBytes` for session tokens, `timingSafeEqual` for the comparison. bcrypt, jsonwebtoken
and every session middleware would each be a dependency and a build step this project does not have.

**The billing fields exist already, and Stripe is the assumed processor.** `buildDefaultBilling()`
puts `plan`, `status`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd` and
`cancelAtPeriodEnd` on every account from the first one, so payments are a matter of filling them in
rather than migrating every row. `status` deliberately uses Stripe's own vocabulary because a webhook
is what will write it. `getEntitlement()` is the single place that decides whether someone is paid up,
and it **counts `past_due` as entitled**: the card failed and Stripe is still retrying, and cutting a
paying customer's sweeping reminders off mid-dunning turns a failed payment into a parking ticket.

Stripe Checkout fits this stack without a dependency either — it is a hosted redirect and a webhook,
both plain HTTPS. Reach for `https.request` before `npm install stripe`.

**Sessions are server-side records, not signed tokens.** `data/sessions.json` (or the `sessions`
collection) stores the **sha256 of** each token, never the token, so a leaked dump does not hand the
reader a set of live logins. That is also what makes "changing your password signs out your other
devices" possible, which a stateless JWT could not do without a revocation list that is a session
table by another name.

**The session cookie is `SameSite=Lax`, and that is a payment decision.** Strict is dropped on a
top-level redirect back from a third-party origin, which is exactly the return trip from Stripe's
hosted checkout — the customer would land on a signed-out page immediately after paying.

**Trusting an origin with credentials grants it the ability to act as a signed-in user.** The API
answers `Access-Control-Allow-Origin: *` to everyone, which is right for the map data and
incompatible with cookies by design; a request from a trusted origin gets that origin echoed with
`Allow-Credentials` instead. Only origins this app is actually served from belong there.

The list is built at boot by `buildCredentialedOrigins` in `server.js` (2026-08-29), not typed into
the source. `BUILT_IN_CREDENTIALED_ORIGINS` holds the Render subdomain and the two localhost forms;
`APP_ORIGIN`, `STRIPE_RETURN_ORIGIN` and a comma-separated `CREDENTIALED_ORIGINS` add to them. It
reads all three because an origin trusted to receive a Stripe return or an emailed reset link is by
definition one the app is served from, and making someone set the same hostname three times is how
one of the three goes stale. Configured origins come first so `resolveReturnOrigin`'s last-resort
fallback lands on the real domain rather than the Render subdomain.

**This is the thing that breaks sign-in on a new hostname, and it breaks silently** — no endpoint
errors, nothing logs, the API keeps answering every request with a wildcard the browser refuses to
send the cookie on. That is why `normalizeOrigin` rejects anything carrying a path, a query, credentials
or a non-HTTP scheme *at boot*, with a warning, rather than letting a pasted URL sit in the set
looking like coverage while never matching an `Origin` header. Two cases in `test/accounts.test.js`
assert both halves against a real server; keep them if you touch this.

**Sign-in and sign-up say different things about whether an address exists, on purpose.** Sign-in
returns one message for a wrong password and for no such account, and spends a full scrypt
verification against a decoy hash when the account is missing so the timing does not leak either.
Sign-up cannot hide it — a duplicate-email error is the only honest answer to a taken address — and
that trade is worth revisiting if email verification ever gates account creation. **Verification
landed on 2026-08-29 and deliberately gates nothing**, so the trade stands as described; revisit it
only if that decision changes.

**The client uploads from `localStorage`, never from `state.savedSets`, and merges before it
uploads.** `hydrateSavedSet` prunes any set whose curb segments are not in the currently loaded
inventory, and the inventory loads asynchronously *after* boot — so `state.savedSets` is legitimately
empty for a moment while `localStorage` holds three sets. Uploading from the in-memory list would
delete the account's library on every cold start. For the same reason `loadCurrentAccount` merges the
server's library down at boot, not only on the sign-in that created the session: a session cookie
outlives the storage beside it, so a returning customer on a cleared browser arrives already signed
in with nothing local, and their next save would have uploaded a one-item list over everything.
Merging first keeps the invariant the upload relies on — the local list is always a superset of the
server's. Three source-text assertions in `test/accounts.test.js` guard all of this.

The remaining limitation is honest last-write-wins across simultaneously-open devices: two browsers
each holding different sets will not learn about each other until one of them reloads. Fixing that
means per-set timestamps and tombstones, which is not worth it before there are customers.

**`npm test` now spawns real servers.** `test/accounts.test.js` stands `server.js` up against a temp
`DATA_DIR` for six of its cases, because password handling is exactly the code where unit tests of
the pieces pass while the wiring leaks. It costs about a second — scrypt is slow on purpose. Do not
lower the scrypt cost to speed the suite up.

**Three bulk reads were open to anyone and are now behind the admin token.** `GET /api/subscriptions`,
`GET /api/push/subscriptions` and `GET /api/reminder-plans` with no `endpoint` returned every user's
records to any caller. The push listing included each device's `p256dh` and `auth` keys, which is a
working ability to send notifications to every user of the app. The per-device lookup the client
actually uses — `/api/reminder-plans?endpoint=` — is unchanged.

**The throttle counters are read from memory and written through to storage.** Deciding whether an
attempt is allowed costs nothing and never touches the database; only a recorded failure or a clear
writes, and a clean sign-in with nothing to clear does no I/O at all. The write-through half landed
2026-08-29 and is not optional: with the counters in memory alone, every deploy handed an attacker a
fresh budget of guesses, and this app redeploys far more often than the fifteen-minute window.
Failures are batched so a failure counted against both the address and the email is one write, and
the map is mutated before it is serialized, so two concurrent failures converge rather than losing
an update.

Records that come back expired, future-dated, or with an unparseable timestamp are dropped at boot
rather than trusted — a future-dated counter would otherwise sit inside the window forever and lock
a real user out of their own account. `data/sign-in-attempts.json` is gitignored for the same reason
the other collections are: it is keyed by email address and by client IP.

**What this does not do is span processes.** The in-memory read is what makes it single-instance —
a second Node process keeps its own view and the two overwrite each other's counters rather than
summing them. That is the right trade at one instance on Render, and it is the thing to revisit
before scaling out; a genuinely shared counter means a round trip per attempt, which this
deliberately avoids. `test/accounts.test.js` covers the restart, the expiry and the corrupt record,
and the restart case fails if the boot-time load is removed.

Payments landed on 2026-08-27; email verification and password reset on 2026-08-29. See those
sections below.

## Payments

Added 2026-08-27, on top of the account fields that were already there for it. Stripe is the
processor, reached over `https.request` from [lib/billing.js](lib/billing.js) — no `stripe` package,
for the same reason there is no bcrypt: it is a form-encoded API and an HMAC signature check, and
adding the SDK would be the first dependency this project cannot lazily require.

**The free tier is the app signed out, and the paid tier is the account.** That is the whole line,
and it was chosen deliberately over the alternatives. The map, address search, curb colours, saved
sets in `localStorage`, and reminders all work with no account and always will — the promise at the
top of the Accounts section is unchanged. What money buys is the account: a saved curb set that
survives a new phone or a cleared browser.

**Exactly one endpoint is gated: `/api/accounts/me/library`.** Not sign-in, not password changes,
not account deletion — you have to be able to reach the card form to pay, and you have to be able to
leave. And emphatically not reminders. Reminder plans and push subscriptions key on the push
endpoint rather than the account and fire for signed-out users, so a lapsed customer's alerts keep
running. **Do not gate them.** This app exists to stop people getting $50 sweeping tickets;
withholding the alert that prevents one in order to collect $15 would be indefensible, and it is
also why the free/paid line is drawn on *scope* (how many devices your library reaches) rather than
on *reliability* (whether you get warned). `test/billing.test.js` asserts both halves.

**That line is now a written promise, not only a code decision.** The Terms page in
`public/index.html` says in so many words that the map, search, colours, saved sets and reminders
are free and are not going behind a paywall, and that reminders are never withheld for a billing
reason. Rewritten 2026-08-29, when the legal copy still predated payments entirely — it described a
free beta, mentioned neither subscriptions nor refunds, and listed neither Stripe nor Resend as a
processor on the Privacy page. If the gating in `server.js` ever changes, that copy changes with it;
tightening the gate quietly would make the Terms false rather than merely out of date.

Two things there are placeholders and are marked with `TODO before launch` comments in the HTML: the
support address (`support@denvercurbalerts.com`) appears in both the Terms and the Privacy contact
sections and must become a real mailbox on the purchased domain before anyone is charged, since
Stripe expects a working customer service contact and the 30-day refund promise is only as good as
that address. Prices appear in the copy as prose (`$1.99 per month`, `$15 per year`) alongside the
display-only strings in `lib/billing.js`; the Stripe dashboard is still authoritative, so changing a
price means changing three places.

**Every account opens on a 14-day trial, and it is a real Stripe status rather than a flag.** The
account is the paid product, which leaves nothing to attach a card to before the account exists — a
card wall on the sign-up form is where a $15/year utility loses everyone. `trialing` was already in
`ENTITLED_BILLING_STATUSES`, so expressing it Stripe's way means the webhook takes the record over
with no translation. `TRIAL_DAYS` lives in `lib/billing.js` beside the prices, not in
`lib/accounts.js`: that module decides whether someone is entitled and should not also own what the
plan costs. Fourteen days outlasts two sweeping cycles on any Denver block, which is the point — a
trial shorter than one full sweep-and-reminder loop never shows the customer what they would pay for.

**`buildDefaultBilling()` is the floor, not the starting point, and must stay unentitled.**
`getEntitlement` falls back to it for an account whose billing is missing or corrupt, so a default
that granted anything would make a damaged record the most valuable one in the collection. New
accounts get `buildTrialBilling()` instead.

**Accounts created before payments existed are backfilled at boot** by `backfillAccountTrials()` in
`server.js`. They carry the unentitled default and never had a trial to use, so the library gate
would have locked them out of their own sync on the deploy. It is keyed on the absence of both a
trial and a Stripe customer, so a redeploy can never top someone up.

**The webhook verifies before it parses.** Stripe signs `${timestamp}.${rawBody}`, so the route
reads the body as text and only `JSON.parse`s it after the HMAC matches — a re-serialized object is
not the same bytes and would never verify. Unknown event types are acknowledged with 200 rather than
rejected, because a 4xx tells Stripe to retry forever; a genuine failure to write the account
returns 500 on purpose, because the customer has paid and is not yet entitled.

**Prices are display-only in the code.** `$1.99/month` and `$15/year` are strings for the button
label; the authoritative amounts live in the Stripe dashboard and the price ids come from
`STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL`. Nothing in the app charges from a number it holds.

**Cancelling and card updates go to Stripe's hosted billing portal.** Building those here would mean
handling proration and dunning in an app with no dependencies and no email provider, and getting any
of it subtly wrong bills someone incorrectly.

Billing degrades to invisible: with no `STRIPE_SECRET_KEY` the endpoints answer 503, the client
hides the upgrade controls, and the trial still runs — so an unconfigured deployment is a working
free app rather than one where nobody can sync. That is the normal state of a local checkout.

## Email

Added 2026-08-29. Address confirmation and password reset, which are the two things the account
system had been missing since it landed, and both are a link in an inbox and nothing else.

**No new dependency, and Resend is the assumed provider.** [lib/email.js](lib/email.js) is
`node:https` and one JSON POST, the same call the Stripe work makes to a different host. Swapping
providers is `deliverViaResend` and nothing else; it is deliberately not an adapter layer, because
the real cost of switching is the DNS records, not those thirty lines. SMTP is the option to avoid —
it would mean nodemailer, the first dependency this project cannot lazily require.

**There is still no sending domain, and that is what stands between this and shipping.** The live
origin is a Render subdomain, so SPF and DKIM cannot be published for it, and every provider
requires a verified domain before it will send to arbitrary addresses. The feature is therefore
built and off: with no `RESEND_API_KEY` the routes answer 503 and the client hides the controls, the
same way billing degrades. Do not treat a green test run as evidence that mail is deliverable.

**`EMAIL_TRANSPORT=outbox` is what makes the flow reachable without a provider, and the naive
version of this does not work.** Falling back to the outbox only when email is *disabled* is
useless, because the routes answer 503 in exactly that state and nothing ever reaches the file. The
transport switch says "email works, deliver it to disk" instead — messages land in `data/outbox.json`
and you click the link out of the file. It is how the whole flow is exercised locally and it is what
`test/email.test.js` runs under.

**Verification gates nothing, on purpose.** An unconfirmed address gets a banner and a resend
button; sign-in, reminders, the trial and the library all work exactly as before. This is the same
rule as the reminders in the Payments section — this app exists to stop people getting sweeping
tickets, and an unclicked link in an inbox is not a reason to withhold anything. The banner exists
so that a reset can reach the person later, which is the only thing confirmation actually buys.

**The reset route answers before it sends, and that is a security property rather than a
performance one.** An identical 200 body for a known and an unknown address is only half of not
being a membership oracle; a found account does hundreds of milliseconds of provider work that a
missing one does not, and that gap is as readable as a different status code. So the response goes
first and the send happens after it, unawaited. **Do not "fix" this by awaiting the send** — and
note that it is why `test/email.test.js` polls the outbox instead of assuming it.

**A reset token is spent on the attempt, not on success.** A link sitting in a mailbox someone else
can read must not survive a failed validation, so `handlePasswordResetConfirm` consumes it before
it looks at the new password. The client checks the ten-character minimum itself for exactly this
reason: without that, an obviously-too-short password would burn the link and send the user back to
their inbox for another one. The server still enforces every rule — the client check is a courtesy,
never the gate.

**A reset revokes every session with no survivor**, unlike a password change, which spares the one
making the request. A reset is what someone does when they believe the account is compromised, and
there is no session on that request we have any reason to trust. Completing one also **confirms the
address as a side effect** — reaching the link proves control of the mailbox, which is precisely
what the confirmation link asks for, so making the user click a second one would be theatre.

**Tokens are stored the way sessions are: the collection holds the sha256, never the token.** A
leaked dump must not be a bag of working reset links. Single use is enforced by deleting the record,
not by a flag on it — a spent token that is merely flagged sits in the collection looking almost
exactly like a live one, and telling them apart is the whole property. Issuing a new link retires
the account's outstanding ones for the same purpose, and deleting an account takes its tokens with
it, or a live link would outlive the account and be a way back in if the address is reused.

**The links land on `?verify=` and `?reset=` on the existing page, not on routes of their own.** A
second HTML file would mean a second entry in `APP_SHELL`, a second cache key, and a second thing to
keep versioned, for two tokens that are each read once and thrown away. `handleEmailLinks` in
`public/app.js` reads them at boot and **strips them from the address bar immediately** — a reset
token in a URL survives in history, in a screenshot, and in the referrer of whatever loads next.

**The link origin comes from `resolveReturnOrigin`, which is now load bearing in a way it was not
for Stripe.** It prefers the configured origin and falls back to the request's own only if that
origin is in `CREDENTIALED_ORIGINS`. `Host` is client-supplied, and where a poisoned one previously
meant an attacker redirecting their own checkout, it now means a reset link arriving in someone
else's inbox pointing at the attacker's server. Locally this means links on an autoPort dev server
point at production — swap the origin by hand, or run on port 3000.

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
- **Color semantics** — pink = *we found no sweeping schedule published by the City and County of
  Denver for this curb; check with Denver and use caution*. It is a caution state, not an all-clear:
  Denver may sweep and ticket a block it returned nothing for. Changed 2026-08-27 — pink used to be
  worded as *you do not need to move your car*, and the older prose in this file still argues from
  that reading (see the note under the enclave rules).
  Gray `#7b8790` = not maintained by Denver, reminders disabled.
  Plum `#8e44ad` = swept on a schedule you never have to move for — Denver's `relocationRequired`
  flag, added 2026-08-27. It used to be drawn in the plain side colour, so 28% of the map was
  claiming a move day it did not have; only tapping a curb revealed it. All three schedule states
  override the side colour, and `getCurbColor` in `public/app.js` is the one place that decides.
  Pick a seventh colour the same way this one was picked, not by eye: teal was the obvious choice
  and it sits at a CIELAB deltaE of **1.0** from the pink under simulated deuteranopia, which would
  have made *you are fine here* and *we have no data, be careful* the same colour for red-green
  colourblind users. Plum is the furthest from all six in both normal vision and deuteranopia.

**`relocationRequired` keys on `isPosted`, not on sweep type.** Denver posts signs where it
enforces, so an unposted route is one you cannot be ticketed on and a posted one is not, whatever
its `SweepType`. The predicate used to read `sweepType === "Weekly" || (sweepType === "Scheduled" &&
isPosted === false && !sourceNote)` — the `Weekly` branch never asked about posting at all, and
`Weekly` is 6,459 of the 6,523 routes the flag fires on. **395 of those are `IsPosted: true`**, and
every one was telling the driver they did not need to move on a street with sweeping signs up.
Corrected 2026-08-27, and it is why the colour had to wait for the flag: painting the old predicate
plum would have advertised safety on 790 curb sides Denver posts.

**`Nightly` is deliberately excluded from the flag. Investigated 2026-08-27 and closed: leave it.**
The posted/unposted rule above would, read mechanically, make the 1,455 unposted `Nightly` routes
(~2,900 curb sides) plum as well. Three things say not to, and they are recorded here so this does
not get re-opened from scratch.

*The corroborating signal that carries the Weekly case is missing.* Weekly earns its plum from three
independent agreeing sources: the `isPosted` field, the geography, and the rule text — posted Weekly
routes name a specific weekday ("The 1st Wednesday of the month"), unposted ones name only a week
("The 4th week"). For `Nightly` the rule text is **byte-identical** either way, "Night Sweeps" on
posted and unposted alike. Only the bare flag is left, with nothing behind it.

*Denver's own two sources contradict each other here.* The Open Data "Street Sweep Schedule" layer
(`ODC_ADMN_STREETSWEEPSCHEDULE_A/FeatureServer/17`, whose fields are documented as including
"whether or not the schedule is posted along the street") holds 51 schedule records, of which
**exactly one is a Night schedule — `5A1111N0`, `POSTED = N`**. By that table night sweeping is
unposted city-wide. The route API disagrees: 2,287 `Nightly` routes, 832 of them `isPosted: true`.
That is not stale payload — 7 of 8 were re-confirmed against the live proxy at their own centroids,
on N Broadway and N Speer. The split is geographically coherent (posted downtown; N Federal's 101
segments and N Sheridan's 55 unposted end to end; Colfax and Alameda flipping at Colorado
Boulevard), so both sources are internally sensible and simply disagree. Do not "resolve" this by
picking one.

*And on an arterial, sweeping is not the binding parking constraint.* These routes are Federal,
Sheridan, Colfax, Colorado, Evans. Plum says *you do not need to move your car*; a driver reads that
as *I can leave it here overnight*, which on those streets may be wrong for reasons that have
nothing to do with sweeping. The notice hedges — "Follow posted signs and any other parking
restrictions" — but the colour is what actually gets read.

**What the app shows there today is already honest, which is the fourth reason.** An earlier version
of this paragraph claimed unposted `Nightly` curbs were "telling drivers to check a move day they
may not have". They are not. `buildCurbSheetCopy` gives them the headline "Nightly sweep route" and
the rule "<side>: Night Sweeps", with **no notice at all** — accurate for a route that carries no
dates (only 8 of the 1,455 have any) and names no day. They sit in the side-colour bucket without
asserting a move day, so the gap being closed was smaller than it looked.

If this is ever revisited, the useful change is not plum. `Nightly` is genuinely a third thing —
no date, no named day, swept while you are asleep — and deserves its own treatment rather than
being folded into either existing bucket.

**Southeast Denver really is almost all plum, and that is not a bug.** It looks alarming — from
Hampden south the map is a solid purple field — and it was checked hard on 2026-08-27 before being
accepted. `isPosted` is present on 100% of crawled routes (5,539 of 5,539 in
`belleview-quincy-colorado-i225`), so this is not `Boolean(undefined)` quietly defaulting a missing
field to false. Denver sweeps residential streets only where signs are posted, and the citation
applies only in posted areas, so unposted streets carry no sweeping parking restriction at all.

The geography corroborates it: posted share climbs 0% → 84% from the far south to the northern
core, and **no posted route exists anywhere south of latitude 39.668**, across 1,612 routes. That is
Denver's historic dense core versus its post-war southeast, which is exactly where you would expect
signs and no signs. The route text corroborates it too, and this is the tell worth remembering:
**posted routes name a specific weekday** ("The 1st Wednesday of the month" — what a sign can state)
while **unposted routes name only a week** ("The 4th week of the month" — an internal sweeping plan).
Confirmed against the live proxy at Hampden and Belleview versus Capitol Hill and Highlands.

So do not "correct" the purple by making the predicate stricter. The mirror-image question — whether
unposted `Nightly` should be plum too — was investigated on the same day and closed; see the
`Nightly` note above rather than re-deriving it.

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

Every variable the server reads is listed in [.env.example](.env.example) and declared in
[render.yaml](render.yaml) as `sync: false`, both brought complete on 2026-08-29. Keep them that
way: an unset variable here is never an error, it is a feature that silently answers 503 (billing,
email) or does nothing at all (push), which is much harder to notice than a crash. Worth knowing
beyond the file:

- `ISSUE_REPORT_ADMIN_TOKEN` — gates every bulk read that returns other people's data, not just
  issue reports, via `Authorization: Bearer <token>`. Unset by default, which closes them.
- `DATA_DIR` — where the JSON collections live. Unset everywhere except `test/accounts.test.js`,
  which points it at a temp directory so a test run cannot write accounts into the working copy.
- `APP_ORIGIN` — **overloaded, deliberately.** It is which server the pipeline scripts query
  (defaulting to localhost for `build-static-inventory.js` and **production** for
  `map-area-approach-3.js`), *and* the server's own canonical origin: `getBillingConfig` reads it,
  `resolveReturnOrigin` prefers it, and `buildCredentialedOrigins` trusts it with a session cookie.
  In production those are the same string. Setting it locally to something that is not this app is
  how a reset link ends up pointing somewhere strange.
- `CREDENTIALED_ORIGINS` — comma-separated extra origins to trust with a session cookie, for a
  staging deploy or for holding both hostnames during a domain cutover. See the accounts section.
- `RESEND_API_KEY`, `EMAIL_FROM` — transactional email. Both must be set or email is off.
- `EMAIL_TRANSPORT` — set to `outbox` to run the email flow with no provider. See the Email section.

Push notifications do nothing without `https://`, VAPID keys, and `npm install`.

**Two properties of Render's free plan are launch blockers rather than preferences**, and neither is
visible in the code. A free instance sleeps after inactivity, and reminder dispatch is a
`setInterval` inside this process — a sleeping instance sends no reminders, which is the entire
product. A free instance also has an ephemeral filesystem, wiped on every deploy, so with no
`DATABASE_URL` the JSON collections under `data/` take accounts, sessions, push subscriptions,
reminder plans and Stripe customer ids with them. Both are called out at the top of `render.yaml`.
Do not take a payment before a paid instance and a provisioned Postgres are both in place.

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
  almost nothing. Re-confirmed 2026-08-26 against every address form — plain, with the city
  appended, with and without a street type — all 400. Coordinate lookups carry all of the coverage;
  don't re-plumb the pipeline over this.

  **This means `findLocalSearchMatch` in `public/app.js` *is* the address search, not a fallback.**
  It used to answer with the centroid of a street's whole geometry, which is not an address:
  "3235 Larimer St" resolved four RiNo blocks southwest of the building. It now places the house
  number by finding where Denver's numbered grid crosses the street — the 3200 and 3300 crossings —
  and interpolating between them, which puts the same address within ~20 m. Two related bugs went
  with it: street matching scored on substrings, so the "3235" of a house number matched 35TH ST and
  the "17" of "e 17th ave" matched E 7TH AVE; and a cross-street query took the latitude of the
  east-west match and the longitude of the north-south one, which is not an intersection at all —
  that is why "Iowa and Bellaire" landed on *N* Bellaire in Sloan's Lake, and why diagonal Larimer
  paired with itself as "LARIMER ST and LARIMER ST". Crossings are now the nearest actual approach
  between two streets' geometries, which picks the quadrant on its own.

  Denver numbers east-west avenues off the *named* north-south grid (1234 E 17th Ave sits at the
  1200-block street, not at 12th), and nothing in the inventory maps those names to numbers, so
  those addresses resolve to the street rather than the block. That is deliberate: the matcher
  reports `kind: "street"`, the map opens wider, and the status line says it only matched the
  street. Do not paper over it by dropping a block-zoom pin the data does not support.
  `test/address-search.test.js` covers all of this and, like `test/curb-geometry.test.js`, reads
  `public/app.js` as source text — renaming those functions breaks it by design.
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
- `data/` is ~360 MB, and `data/inventory-expected-blocks.json` alone is 36 MB across 97,827 blocks.
  Grep with care, and never read these files whole.

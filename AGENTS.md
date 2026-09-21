# AGENTS.md

Instructions for any AI coding tool working in this repo (Claude Code, Codex, and anything else).
This is the single source of truth. `CLAUDE.md` is a pointer to this file and must stay a pointer.

## What this is

**Denver Curb Alerts** — a street-sweeping / parking-ticket-avoidance PWA for Denver. It proxies the
city's public sweeping API, draws curb segments on a Leaflet map, separates left-side from right-side
sweeping rules, and schedules web-push reminders.

Deliberately minimal stack:

- `server.js` — a zero-framework `node:http` server. Static files + `/api/*`. No Express.
- `lib/accounts.js` and `lib/email.js` — the only things outside `server.js` that are server
  runtime rather than pipeline tooling, which is why they are not under `scripts/lib/`.
  `accounts.js` is pure, no I/O. `email.js` is pure apart from `sendEmail`, deliberately the one
  function touching the outside world, so everything above it can be tested without a key or a
  network. There was a `lib/billing.js` in the same shape until 2026-09-03; see **Payments —
  removed**.
- `public/app.js` — the entire client, ~6000 lines of vanilla JS loaded by a plain `<script>` tag.
- **No bundler, no transpiler, no build step for client code.** What is in `public/` is what ships.
- Two dependencies (`pg`, `web-push`), both lazily `require`d so the app boots without `npm install`.
  Accounts added none: `node:crypto` has scrypt, and there is no bcrypt or session framework here.
  Payments added none either while they existed — Stripe was form-encoded HTTPS and an HMAC, so
  `node:https` and `node:crypto` covered it, and there was never a `stripe` package. Email added
  none: Resend is one JSON POST, so there is no `resend` package and no nodemailer.
- CommonJS everywhere, including tests and scripts. There is no `"type": "module"`.

Storage is Postgres when `DATABASE_URL` is set, JSON files under `data/` otherwise. Deployment is
Render only (`render.yaml`), deploying the `main` branch — work happens on `develop` (see
**Working across Claude Code and Codex**); the live origin is `https://www.curbalerts.co`, since 2026-09-10.
Render 301s the bare `curbalerts.co` to `www`, so **`www` is the canonical origin** — it is what
browsers send as `Origin`, and it is what `APP_ORIGIN` and `HOSTED_APP_ORIGIN` in `public/app.js`
must say. DNS is on Cloudflare with both records set to DNS only; turning Cloudflare's proxy on can
break Render's certificate renewal. The old `https://denver-curb-alerts-2.onrender.com` still serves
and stays in `BUILT_IN_CREDENTIALED_ORIGINS` so installs pointed at it keep signing in.

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

One more versioned constant lives in [public/cities.js](public/cities.js): `inventoryUrl` on the
Denver record, which `public/app.js` reads as `STATIC_ROUTE_INVENTORY_URL`. It moved there on
2026-09-21 with the rest of the city-shaped constants; `scripts/lib/asset-versions.js` rewrites it
in that file now, and `test/static-cache-version.test.js` reads the same literal. There used to be
a second constant here, `SLOANS_LAKE_FULL_INVENTORY_CACHE_KEY`,
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
Reach for the full crawl only when you actually want fresh data from Denver — schedule
changes, new or retired routes, seasonal updates, or a pilot area that has never been crawled.

Denver's API rate-limits the full crawl hard, and **it throttles rather than refusing**, which is
what makes it dangerous: lookups come back without routes while a single well-behaved request from
the same machine keeps answering normally. You cannot detect it by probing — only the aggregate
shows it. Measured 2026-09-21 at the old `CONCURRENCY` of 8: the run finished in **four minutes
instead of twenty** and published **3,168 scheduled routes against the 10,451 already on disk**,
with `Unavailable` going from 2,039 to 20,919. The auditor had dutifully covered every orphaned
block with pink and the build gate passed reporting **zero unexplained gaps**, because pink *is*
its answer for a block with no schedule. About 84% of the map would have told drivers no Denver
schedule was found, on curb Denver sweeps. It was caught by comparing against the previous payload
and reverted; nothing shipped.

Four guards in [scripts/build-static-inventory.js](scripts/build-static-inventory.js) now stand in
the way, and `test/crawl-guards.test.js` covers all of them:

- **`CONCURRENCY` is 3**, not 8. Slower, and not seen to trip the limit.
- **Retries with jittered exponential backoff** on the answers that mean "not now" — a thrown
  request, 408, 429, 5xx. A 400 is *not* retried: it is Denver answering definitively, which is
  what its address endpoint has done for every address since before 2026-08-22.
- **`fetchWithRetry` distinguishes an answer from a failure.** The old `runPool` collapsed both
  into `null`, so a throttled lookup was indistinguishable from "the city sweeps nothing here" —
  that single line is why four fifths of the city could go missing without one error surfacing.
  A run that exceeds `MAX_FAILURE_RATE` after `FAILURE_SAMPLE_SIZE` lookups now **aborts before
  writing anything**.
- **`assertNoCoverageCollapse` is the last line**, and the one that would have caught this on its
  own. It runs inside `writeInventoryArtifacts`, so `rebuild:offline` gets it too, and refuses to
  publish when routes carrying a real schedule fall more than `MAX_COVERAGE_DROP` below what is
  already on disk. It compares against the published payload rather than any absolute number,
  because that number grows as the city is mapped. Denver does not retire a third of its routes
  between two crawls. Set `ALLOW_COVERAGE_DROP=1` for a drop that is genuinely correct.

`runPool` takes an options object overriding each limit, which is how the tests exercise the abort
in milliseconds instead of minutes, and how a crawl can be slowed further without editing the file.

**Being throttled once means waiting, not retrying.** Come back in hours, not minutes.

**The published payload has a shelf life of about two months, and nothing in the app says so.**
Denver returns a rolling window of upcoming dates rather than a rule you can evaluate forever, so
the crawl captures roughly two months and then stops. Measured 2026-09-21: the payload generated
2026-08-27 carries sweep dates from 2026-08 through **2026-09-25** and not one day further.

The client does not go blind when they run out. `getUpcomingSweepDates` in
[public/app.js](public/app.js) falls back to `getRuleBasedSweepDates`, which parses the rule text
("The 4th Tuesday of the month") and projects eight months ahead. Across the 23,260 **posted** curb
sides — the ones a driver actually has to move for — that covers **20,771, or 89.3%**. Of the rest,
1,663 are `Night Sweeps`, which assert no move day in the first place and so lose nothing, and 775
say "The 4th week of the month" with no weekday in it and cannot be projected at all. About **826
sides, 3.5%, genuinely go dark**.

So a stale payload degrades rather than breaking, which is exactly what makes it easy to miss: the
map still shows dates and they are still mostly right. **Do not read "the map still shows dates" as
"the data is fresh."** What you are looking at past the window is this app's own arithmetic, not
Denver's word, and it is wrong precisely where a holiday shift, a re-routed week or an end-of-season
change would move a sweep — the cases a driver most needs the warning for.

Denver sweeps April through November. **Re-crawl when the season opens in April, and again before
its last sweeps in November.** Neither is optional maintenance; each is the difference between
warning people from the published city dates and warning them from a projection. Budget for the
Larimer count under **Known issues** below, which a fresh crawl moves from 6 to 11 and which has to
be corrected together with the crawl rather than before it.

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

**Denver is a record in `public/cities.js`, not constants scattered through the client.** Added
2026-09-21 as the first step toward a second city. The record holds everything `public/app.js` used
to hardcode: `bounds` (the rectangle the map is clamped to and the "do we cover this point" test),
`minZoom`, `inventoryUrl`, `cityLimitsGlobal` (which boundary module draws the city line),
`geocodeSuffix`, and the address grid — `addressGrid` plus `westGridNorthLatitude`. `app.js`
resolves `ACTIVE_CITY` once at module scope and reads the rest off it, so **`cities.js` has to load
before `app.js`** in `index.html`. It is a UMD module in the shape of `curb-geometry.js`, so the
pipeline and the tests can require it.

It is a registry of one and `ACTIVE_CITY` never moves today. That is the point: the seam exists, so
the second city is an entry plus its own data rather than a search through 6,000 lines for the word
"Denver". `getCityForPoint` is there for choosing from the phone's position later — the intended
design is that the app picks the city from location and offers a switcher in the header, **not** a
city-picker splash screen in front of every user, who is in the same city every day.

**What deliberately did not move is the copy that names the sweeping authority.** Those strings are
asserted as source text by `test/not-maintained-ui.test.js`, which exists to protect the meaning of
the pink and gray curb states — "we found no schedule, use caution" and "not city-maintained" are
safety claims, not chrome. Templating them is its own pass with that test updated deliberately.
Also still Denver-named and still fine: the `/api/denver/sweeping` proxy route, the pipeline
scripts, `getDenverMaskRings`, and the `sourceNote` prose on the hand-curated coverage patches,
which describes specific Denver routes and is data rather than chrome.

**The two things that actually gate a second city are not in this file.** The payload is 12 MB and
the iOS "Bundle web app" phase copies all of `public/` into the app, so N cities is an N × 12 MB
binary — multi-city forces the inventory to become per-city and fetched on demand, reversing the
decision recorded under **The iOS project**. And every city is a fresh acquisition pipeline: route
geometry here is parsed out of the Google `staticmap` URL Denver embeds, which no other city does.
Confirm a candidate city's data exists in usable form before building anything multi-city-shaped
against Denver alone.

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

## Accounts

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
built as `/?verify=` and `/?reset=` with no hash (the removed Stripe checkout returned to
`/?checkout=` the same way), so boot resolved the view to the map every time while
`handleEmailLinks` wrote into a section inside the **hidden** alerts view. A password reset link was unreachable — the form
rendered at `display: none`, and `accountResetPasswordInput?.focus()` was a no-op on it. Both
`handleEmailLinks` now calls `setActiveView("account")` before it renders anything. **Any new flow
that returns from an outside origin has to do the same** — a store purchase callback included; the
query string alone does not move the view.

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

**The billing fields exist already, and nothing reads them as a gate.** `buildDefaultBilling()`
puts `plan`, `status`, `providerCustomerId`, `providerSubscriptionId`, `currentPeriodEnd` and
`cancelAtPeriodEnd` on every account from the first one, so a purchase path is a matter of filling
them in rather than migrating every row. `status` deliberately uses a processor's vocabulary because
a processor is what will write it. `getEntitlement()` is the single place that decides whether
someone is paid up, and it **counts `past_due` as entitled**: the payment failed and the processor
is still retrying, and cutting a paying customer's sweeping reminders off mid-dunning turns a failed
payment into a parking ticket. See **Payments — removed** for what happened to the rest.

**Sessions are server-side records, not signed tokens.** `data/sessions.json` (or the `sessions`
collection) stores the **sha256 of** each token, never the token, so a leaked dump does not hand the
reader a set of live logins. That is also what makes "changing your password signs out your other
devices" possible, which a stateless JWT could not do without a revocation list that is a session
table by another name.

**Sessions travel as a cookie or a bearer token, and both name the same record.** Added
2026-09-04 for the iOS shell (see **Shipping on iOS**), which cannot use the cookie at all.
`resolveSession` reads `Authorization: Bearer <token>` first and falls back to the jar — the header
is the explicit one, and a stale cookie riding along on the same request must not beat it. The token
is the *same* session token the cookie carries, looked up against the same sha256 records, so there
is one expiry, one revocation path, and one thing for a password change or an account deletion to
sweep up. Do not let it become a second kind of credential with rules of its own.

**The raw token is returned only to a client that asks** (`issueSessionToken: true` on sign-up or
sign-in, and it must be the boolean). The cookie is `HttpOnly` so that page scripts cannot read it;
handing the identical 30-day value to JS on every sign-in would undo that for every browser in order
to serve the one client that is not a browser. Signing out revokes whichever credential was
presented, or a shell would keep a working token after being told it had signed out.

**Sessions and the admin token now share the `Authorization` header, and neither can be presented as
the other.** `hasAdminAccess` compares the whole header against a value from the environment and
answers false when it is unset; a token that is not a live session hashes to nothing in
`resolveSession`. `test/accounts.test.js` asserts both directions — a session bearer token gets 403
from the bulk listings, and the admin token is not an account. That test is the one that fails if
someone tries to make one header do both jobs.

**The session cookie is `SameSite=Lax`, not Strict.** Strict is dropped on a top-level redirect
back in from a third-party origin. That was chosen for the return trip from Stripe's hosted
checkout, which is gone; it still holds for the emailed verify and reset links, and for any hosted
flow that comes back by redirect. Do not tighten it to Strict.

**Trusting an origin with credentials grants it the ability to act as a signed-in user.** The API
answers `Access-Control-Allow-Origin: *` to everyone, which is right for the map data and
incompatible with cookies by design; a request from a trusted origin gets that origin echoed with
`Allow-Credentials` instead. Only origins this app is actually served from belong there.

The list is built at boot by `buildCredentialedOrigins` in `server.js` (2026-08-29), not typed into
the source. `BUILT_IN_CREDENTIALED_ORIGINS` holds the Render subdomain and the two localhost forms;
`APP_ORIGIN` and a comma-separated `CREDENTIALED_ORIGINS` add to them. It reads both because an
origin trusted to receive an emailed reset link is by definition one the app is served from, and
making someone set the same hostname twice is how one of the two goes stale. `STRIPE_RETURN_ORIGIN`
was a third source until 2026-09-03. Configured origins come first so `resolveReturnOrigin`'s last-resort
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

**A set both sides hold is unioned curb by curb** (2026-09-16), because every device now creates
the default set under the same id — see **Turning a reminder on is the save**. The cost is the
missing tombstone: a curb turned off on one device comes back from another that still holds it.
Losing a curb someone turned on is the worse failure for this app, so the union stands.

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

Payments landed on 2026-08-27 and were removed on 2026-09-03; email verification and password reset
landed on 2026-08-29. See those sections below.

## Payments — removed

There are none. Stripe Checkout sold an account subscription from 2026-08-27 until **2026-09-03**,
when it was removed along with `lib/billing.js`, the four `/api/billing/*` routes, the client's
upgrade controls, and every Stripe variable in `.env.example` and `render.yaml`. Nothing in the app
charges anyone, and `/api/billing/*` answers 404 rather than 503 — a 503 would read as "configured
elsewhere" to anyone probing, and would keep a stale client rendering an upgrade button.

**The reason is the App Store, not a change of heart about charging.** Apple requires in-app
purchase for a digital subscription sold inside an iOS app and prohibits a third-party processor for
it, so a Stripe checkout inside the app was never going to be allowed. Stripe would still be the
right answer for selling in a browser — a browser cannot run StoreKit any more than an iOS app can
run Stripe Checkout — so if web sales ever come back, this comes back with them. Read `git show` on
the removal commit rather than rewriting it from scratch.

**What deliberately stayed is the entitlement scaffolding.** Every account still carries `plan`,
`status`, `providerCustomerId`, `providerSubscriptionId`, `currentPeriodEnd`, `cancelAtPeriodEnd`
and `trialStartedAt`; `buildTrialBilling()` still opens a 14-day trial at sign-up; the trial still
expires; `backfillAccountTrials()` still runs at boot; and `getEntitlement()` in `lib/accounts.js`
is still the single place that decides whether someone is paid up. All of it is computed and none
of it is read as a gate. Keep it that way until there is something to buy — a live trial clock over
a real population is what makes the next purchase path a matter of filling fields in rather than
migrating every row.

**The field names are processor-neutral now, and that was the point of touching them.**
`stripeCustomerId` and `stripeSubscriptionId` became `providerCustomerId` and
`providerSubscriptionId` on removal, so StoreKit can fill the same record without a migration.
`test/entitlement.test.js` asserts no key in `buildDefaultBilling()` names a processor. The status
vocabulary is still a processor's — `active`, `trialing`, `past_due`, `canceled` — because that is
the shape every processor hands back, and translating it into house terms on the way in only means
translating it back later.

**The library gate is off, and this is the one line to change when a purchase path exists.**
`handleAccountLibrary` in `server.js` used to answer 402 to a lapsed trial. With no checkout to send
that customer to, the same 402 locked every account out of its own sync fourteen days after signing
up with no way at all to unlock it. **An unsellable paywall is just a bug.** Put the 402 back there
and nowhere else. `test/entitlement.test.js` asserts an expired entitlement changes nothing today,
and that no endpoint an account can reach answers 402; that test is the one to flip back.

**Whatever gets sold, it is never the reminders.** Reminder plans and push subscriptions key on the
push endpoint rather than the account and fire for signed-out users. This app exists to stop people
getting $50 sweeping tickets; withholding the alert that prevents one to collect a subscription
would be indefensible. It is also why the free/paid line, when there was one, was drawn on *scope*
(how many devices your library reaches) rather than on *reliability* (whether you get warned). Draw
it the same way next time. `test/entitlement.test.js` asserts a cancelled account can still register
a device and schedule a plan.

**`buildDefaultBilling()` is the floor, not the starting point, and must stay unentitled.**
`getEntitlement` falls back to it for an account whose billing is missing or corrupt, so a default
that granted anything would make a damaged record the most valuable one in the collection. New
accounts get `buildTrialBilling()` instead.

**`TRIAL_DAYS` moved to `lib/accounts.js`.** It lived in `lib/billing.js` beside the prices, on the
reasoning that the module deciding entitlement should not also own what a plan costs. With no prices
anywhere that separation had nothing left to protect. Fourteen days outlasts two sweeping cycles on
any Denver block, which is the point of the number — a trial shorter than one full sweep-and-reminder
loop never shows someone what they would be paying for.

**The Terms and Privacy copy was rewritten to match, and must not drift back.** The Terms now say
the app costs nothing and there is no way to pay; the Privacy page lists no payment processor and no
card data, because there is none. If a purchase path ships, that copy changes in the same commit —
selling something the Terms say is free is worse than either state on its own. The support address
in both pages is `support@curbalerts.co`, on the domain bought 2026-09-10. It replaced a
`support@denvercurbalerts.com` placeholder on a domain nobody owned. Printing it is not the same as
it receiving mail, so it was tested from outside: a message sent by someone else reached the Gmail
behind it, confirmed 2026-09-21. It forwards through Cloudflare Email Routing like the rest of the
domain's inbound mail — see the Email section for why that coexists with Resend's sending records.

**Selling on iOS is gated on the shell, not on the payment plumbing.** Apple requires in-app
purchase for a digital subscription sold inside an iOS app, so a purchase path there is StoreKit
filling the same `provider*` fields. But there is no iOS app yet, and what stands in front of one is
reminders and native capability rather than billing. See **Shipping on iOS** below.

## Turning a reminder on is the save

Changed 2026-09-16. There is no "Save these curbs" step any more. **Remind me about this curb** on
the curb sheet adds the curb to one default set (`DEFAULT_SET_ID`, `set-my-curbs`, named *My
curbs*) and persists it then and there; tapping it again takes the curb out of **every** set.

**The old flow was a trap, not just a slow path.** The button only added a curb to
`currentSelectionIds`, and nothing reminded until the selection was named and saved on the other
half of the panel — but the button already read *Reminder on — tap to remove*. A driver could turn
a reminder on, close the app, and get the ticket. `migrateLegacyCurrentSelection` moves any unsaved
selection into the default set, because those drivers believe those curbs are covered. It lets an
id go only once it resolves: boot draws a small built-in dataset before the full inventory, and the
first version of the migration cleared the key against that and lost every curb outside it.

**Opening a curb does not turn it on; the button does.** People tap curbs to read the schedule, and
subscribing on a look would pile up reminders they never asked for.

**One default set, not a set per curb.** Jobs are built per set, so two curbs swept the same day in
one set send one reminder rather than two, and iOS keeps only 64 pending notifications — at 40 jobs
per set with the defaults, a set per curb reaches the cap at the second curb.

**Off means off everywhere.** A curb left in some older named set would keep reminding while the
button said it had stopped. A set that loses its last curb is dropped. Undo on the sheet restores
the sets array exactly as it was, and is cleared when the sheet closes or another curb opens.

**The map highlights what reminds.** `isCurbReminded` is the union of every saved set's curbs,
memoized on the `state.savedSets` array identity — every change replaces that array rather than
mutating it, and that is what keeps the per-curb lookup cheap across 40,000 curbs. Keep it that way.
The list under the map is those curbs, each with **Turn off**; **Show on map** on a saved set just
takes the driver there. Existing named sets still work, and nothing creates new ones.
`test/remind-on-tap.test.js` covers all of this.

## Reminders keep going until the car is moved

Added 2026-09-15, after the app's own author got a sweeping ticket with two reminders set. One alert
swiped away at 7am is forgotten by 7:05, so a sweep now keeps reminding until the driver says the
car is moved. With the defaults that is 6pm and a **9pm check-in** the night before, then **7:00,
7:30 and 8:00** on the day, each firmer than the last. `nagUntilMoved` on a saved set's reminders
turns the extras off and restores the old two. It defaults on.

**The follow-ups hang off the driver's first morning alert, not off the sweep time, because Denver
publishes no sweep time.** The payload carries dates only. Do not invent a start time to schedule
"an hour before the sweep" from; if one is ever sourced, that is the change to make.

**Confirmation removes jobs rather than flagging them, and that is why the server needed no
change.** A sweep is keyed `<set id>|<local YYYY-MM-DD>`, kept in `MOVED_SWEEPS_KEY`, and
`buildNotificationJobs` skips a confirmed sweep entirely. The next plan sync replaces the device's
job list wholesale (`mergeReminderJobs` keeps only ids it is handed), so the server's copy of those
follow-ups stops existing. A failed sync means the nagging continues, which is the right way to fail.

**Opening a reminder is not confirmation.** Each job's URL is `/?moved=<sweep key>`, and
`handleSweepCheckLink` only puts that sweep at the front of the `#sweep-check` banner; the driver
still has to tap **I moved my car**. People tap a lock-screen alert to read it. The banner lives
outside every view, so unlike the emailed links it needs no `setActiveView`. It also appears
unprompted on a sweep day, and the evening before once the heads-up time has passed. Undo exists
because a mistap would silence the one warning that mattered.

**The service worker used to throw notification URLs away when the app was already open.**
`notificationclick` focused the existing window, and focusing does not navigate. It now
`postMessage`s the URL to that window as well. Any future deep link from a notification depends on
this, so keep the message.

**This is not a Live Activity and cannot be one on the web.** iOS web push has no persistent
notification, no `requireInteraction` and no action buttons, so the stickiness comes from
repetition plus the in-app question. A true lock-screen Live Activity is ActivityKit and belongs
with the native shell below. The follow-ups also raise the local-notification arithmetic there.

## The parking pin

Added 2026-09-15. **Park here** on the map drops a pin at the phone's position, and **I parked here**
on the curb sheet drops one on a tapped curb. Reminders then follow that curb until the car is moved.
It works in a browser and in the iOS app alike; the app answers the location request through the
existing `getCurrentPosition` bridge, so no shell change was needed to park.

**The pin is a saved set with `kind: "parked"`, stored under its own key, and that split is
deliberate.** Being shaped like a saved set is what lets `buildNotificationJobs`, the sweep-day
banner, the plan sync, the native schedule and the lock-screen card handle it untouched —
`getReminderSets()` is the one place that adds it in. Being stored apart (`PARKED_CAR_KEY`, not
`SAVED_SETS_KEY`) keeps it out of the account library: a saved set is a curb someone parks on and
should follow them to a new phone, while a pin is one car's position on one phone. There is only
ever one pin, and parking again replaces it. Its id is `parked-<timestamp>`, and a side switch or a
dragged pin keeps that id rather than starting a new parking.

**The pin picks the street, and the driver picks the side.** A phone's fix is good to 5–15 m between
buildings, which is wider than the ~8 m between the two curbs this app draws for a residential
street. `findParkingCurbCandidates` takes the nearest curb within `PARKING_SEARCH_RADIUS_METRES` as
the guess, and the park sheet offers the curb across the street as one tap (`getOppositeCurb`, which
pairs `<way>:north` with `<way>:south`). Do not "fix" a wrong side by tightening the search; the
guess is not the product, the one-tap correction is. It searches `state.curbSegments`, not
`state.visibleSegments`, because a GPS pin lands wherever the car is rather than wherever the map is
looking.

**Moving the car ends the pin**, in `releaseParkedCarIfMoved`. Once any sweep of the pin is
confirmed, the car is somewhere else, and a pin left behind would remind about next month's sweep on
a curb nobody is parked on. It runs on every render because a confirmation can arrive from the iOS
lock screen while the page is not running. Undo on the banner puts the pin back.
`ReminderScheduler.effectiveMovedSweepKeys` is the device half: a confirmed `parked-` sweep silences
every other sweep of that pin on the phone until the page next opens and drops it.

**A pin on a curb a saved set already covers suppresses the saved set's reminders for that curb**
(`isCurbCoveredByParkedCar`), or the driver gets every alert twice and the banner asks twice. That
created a trap: releasing the pin would bring the saved set's alerts straight back for the sweep the
driver just moved for, naming the curb they had just left. So release writes a
`moved-curb|<segment id>|<date>` key into the confirmed-sweep list (`buildMovedCurbKey`), which
silences that one curb on that one day and nothing else. A saved set with another curb swept that
day keeps warning about that curb alone, and the pinned curb's next sweep belongs to the saved set
again.

It is per curb rather than per set on purpose: a set-level sweep key would either silence the set's
other curbs or, withheld, leave the alerts naming a curb the car is no longer on. The key keeps its
date last, so it prunes by date on the page and on the phone like any sweep key, and the iOS
scheduler never matches it to a job. It deliberately does not silence a new pin on the same curb
that day — parking there again is a new parking, and it reminds.

**The pin's coordinates never leave the device.** `buildReminderPlanPayload` sends the pin like any
set — id, name, segment ids — and the jobs carry street and side labels, which saved sets already
did. The Privacy page says exactly this; keep it true if the payload changes.

**What it is not, yet:** it does not notice the car leaving. That is geofencing, which needs
background location and belongs to the native shell (step 4 below); a region exit cannot tell
driving away from walking away, so it wants Core Motion's activity type before it can confirm
anything on its own.

## Shipping on iOS

Nothing is started. Scoped 2026-09-04 by reading the push path end to end, which corrected two
claims an earlier two-sentence version of this note made — see the last item. Everything below
about *this* codebase was read out of the source; the platform facts (what `WKWebView` exposes, the
local-notification cap, ITP's treatment of cross-scheme cookies) are not measured here and should be
confirmed on a device before anyone budgets against them.

**The reminder pipeline is already split the way the move needs, which is why this is cheaper than
it looks.** `buildNotificationJobs` in [public/app.js](public/app.js) computes every job **on the
client**, with an absolute `scheduledAt` — saved sets to segments to `getUpcomingSweepDates` (capped
at 8 sweeps per segment) to the day-before and day-of slots. The server is a dumb dispatcher:
`dispatchDueReminderPlans` in [server.js](server.js) wakes every 60 seconds, finds jobs past due,
and calls `sendNotification`. That call is the **only** place the app touches Web Push. Storage, the
plan join, `attachSessionToDevices`, the account-deletion cascade and `/api/reminder-plans?endpoint=`
are all transport-agnostic already; what is not is that a device record is keyed by the Web Push
endpoint URL and carries `keys.p256dh` and `keys.auth`.

**A `WKWebView` shell fails closed in four places.** An earlier version of this note called that
failure silent. It is not, and the truth is worse: `renderNotificationStatus` reaches its
`canUseBrowserNotifications` branch and says *this browser does not support notifications for this
prototype*, then disables all three buttons. Inside an app that names no browser the user can go and
change, that is a wrong message and a dead end rather than an absent one.

- `canUseWebPush` tests `"PushManager" in window`, so `initializePushFeatures` returns early.
- `canUseBrowserNotifications` tests `"Notification" in window`, so the in-page timer fallback that
  would otherwise cover for it is dead too.
- `getApiBaseOrigin` special-cased only `file:`. **Fixed 2026-09-04**: anything that is not `http:`
  or `https:` now falls back to `HOSTED_APP_ORIGIN`. This was a real defect rather than shell
  scaffolding — an opaque origin serializes to the string `"null"`, and `new URL(path, "null/")`
  throws, so `buildApiUrl` took its whole caller down instead of failing one request.
- `buildCredentialedOrigins` cannot accept a custom scheme at all: `normalizeOrigin` rejects
  non-HTTP schemes at boot, deliberately (see the accounts section).

**Accounts break in the shell, and the fix was a server change rather than a shell one.**
**Done 2026-09-04.** The session cookie is `SameSite=Lax` over what is, from the API's point of
view, a cross-scheme third-party origin. Loosening the cookie or adding the shell's scheme to
`CREDENTIALED_ORIGINS` were both dead ends — the first weakens every browser client for the sake of
the one that is not a browser, and the second cannot work because of the `normalizeOrigin` rule
above. `resolveSession` accepts a bearer token instead; see **Sessions travel as a cookie or a
bearer token** in the accounts section for what it does and does not change.

**The client half landed on 2026-09-15.** Inside the shell, `accountRequest` sends
`credentials: "omit"` and an `Authorization: Bearer` header; a browser still sends
`credentials: "include"` and never sees a token. Sign-in and sign-up ask for `issueSessionToken`
only when the shell's bridge is present, the returned token goes to the iOS keychain through
`setSessionToken` (`SessionKeychain`, `AfterFirstUnlockThisDeviceOnly`, so a backup restored onto
another phone does not carry a live session across), and it is held in page memory for the life of
the page. Signing out sends the token *then* forgets it, deleting the account forgets it, and a
`/api/accounts/me` that answers with no account clears a stored token — but an unreachable server
does not, because offline is not signed out. **Do not park the token in `localStorage`** — that is
precisely the exposure the `HttpOnly` cookie exists to avoid, and it would apply to every browser
rather than only to the shell that needs it. `test/native-session.test.js` guards both halves,
including that the API answers the shell's origin with a wildcard and no credentials.

The shell does not tie its device to the account. `pushEndpoint` is empty in the shell, because it
schedules on the device and has no push subscription, so `attachSessionToDevices` has nothing to
attach. That changes when APNs arrives (step 5).

**The shell talks to the client through `window.DenverCurbAlertsNative`, and the seam for it is
already in `public/app.js`** (added 2026-09-04 as step 1 below). `getNativeReminderBridge` returns
it only when it carries both required methods, and `canUseNativeReminders` gates every branch off
that, so a browser with no bridge takes byte-identical paths to before. The contract:

- `permission` — `"granted"`, `"denied"` or `"default"`. Anything else reads as `"default"`.
- `requestPermission()` — async. The enable button calls it, then forces a reschedule.
- `scheduleReminders(jobs)` — async, and **replaces** every pending reminder with what it is handed.
  `jobs` is the array `buildNotificationJobs` already produces, which is why nothing upstream had to
  learn a shell exists.
- `showTestNotification({ title, body })` — optional. Without it the test button stays disabled
  rather than appearing to work.

A rejected `scheduleReminders` clears `lastSyncedNativeReminderHash` as well as setting the error.
That is deliberate and worth keeping: leaving the hash set would make the next render skip the retry
as a no-op and leave the UI reporting reminders the device never accepted, which is the same class
of lie as pink over curb another city sweeps.

**Local notifications come before APNs, and the existing job builder is the whole input.** The jobs
are already absolute timestamps computed on the client, so `UNUserNotificationCenter` can schedule
them directly: no APNs key, no dispatcher, no round trip, and it works with no connection. Two
honest limits. It stops if the app is not opened for weeks, because rescheduling happens on open.
And iOS keeps only the soonest **64** pending local notifications per app, which the defaults reach
sooner than you would guess. Since the follow-ups landed (see **Reminders keep going until the car
is moved**) the defaults are 5 jobs per sweep, and over 8 sweeps that is 40 per saved set, so **two
sets hit the cap**, and with all three day-of slots enabled a single set nearly does. That wants a
horizon trim, not a redesign, and it is more pressing than it was when this note said 16.

**APNs is the durability layer under that, not an alternative to it, and it needs no new
dependency.** `node:http2` connects to `api.push.apple.com` and `node:crypto` signs the ES256 JWT
from the `.p8` key; the only fiddly part is converting the DER signature to the 64-byte `r||s` JOSE
form. Generalize the device record to carry a transport (`webpush` or `apns`) and store an APNs
token as a synthetic `apns://<token>` endpoint — keeping the endpoint as the primary key is what
lets the plan join, the session attach and the deletion cascade stay untouched. Reach for this when
there is a reason not to depend on app opens, not before.

**Guideline 4.2 wants capability, and the one worth building is park-here geofencing.** Drop a pin
where you parked, register a region around it, and the reminder becomes *you are parked on the north
side of W 32nd, and it sweeps Tuesday at 7am*. Background location is native-only and it is the
actual product rather than a wrapper fig leaf. A home-screen widget showing the next sweep for a
saved set is the cheap second one. Whatever gets built, it stays off the reminders themselves — the
rule in the payments section holds here too.

**The sequence.** Steps 1 and 2 are worth doing whether or not the shell ever ships, because they
are defects in the web app's assumptions rather than shell scaffolding.

1. ~~Make the client shell-safe: teach `getApiBaseOrigin` about the custom scheme, and add a
   native capability branch beside `canUseWebPush`.~~ **Done 2026-09-04.** Verified in a browser by
   injecting a stub bridge: permission flow, job handoff, the no-op on an unchanged schedule, the
   refusal path, and the retry after one. With no bridge present every reading is unchanged.
2. ~~Bearer-token sessions on the server, alongside the cookie.~~ **Done 2026-09-04.**
3. **Started 2026-09-15; see "The iOS project" below for what is and is not done.** The shell plus
   local notifications, so reminders work on a device. This is also where the
   bridge gains keychain storage for the session token and starts sending the header. Bundle
   `public/denver-west-routes.json` as an app resource while doing this and the 12 MB cold fetch
   disappears entirely.
4. Geofencing and the widget — the 4.2 answer. The pin geofencing would watch landed on
   2026-09-15 (see **The parking pin**); what is left is noticing the car leave it. The widget
   landed on 2026-09-19 (see **The home-screen widget**).
5. The APNs dispatcher.

### The iOS project

`ios/CurbAlerts.xcodeproj`, begun 2026-09-15. SwiftUI app, iOS 17+, bundle id `co.curbalerts.app`,
no Swift packages — the same no-dependency rule as the server. The project uses Xcode's
file-system-synchronized groups, so a new `.swift` file in `ios/CurbAlerts/` is picked up without
touching `project.pbxproj`. Build from the command line with:

```
xcodebuild -project ios/CurbAlerts.xcodeproj -scheme CurbAlerts -destination "platform=iOS Simulator,name=iPhone 17 Pro" build
```

**The app serves `public/` out of its own bundle, copied in by the "Bundle web app" build phase on
every build.** `BundledWebSchemeHandler` answers `curbalerts://app/...` from that copy, ignoring the
`?v=` query because the bundle holds one version of everything. So the 12 MB inventory is on the
phone from first launch, and there is no second copy of the client to drift: whatever is in
`public/` at build time ships. That also means **a web change reaches the app only in a new app
build** — the asset-version rules still matter for the website and are irrelevant inside the app.
`sw.js` is not copied; a custom scheme cannot run a service worker.

**What the shell adds to the bridge contract above**, all backwards compatible with a page that
ignores them:

- `scheduleReminders(jobs, { movedSweepKeys })`. Each job now carries `url` and `sweepKeys`, and the
  second argument is the page's whole confirmed-sweep list. The shell stores both, so its lock-screen
  button and background refresh work while the page is not running. The page's list **replaces**
  the shell's, which is what lets the page's Undo restore a sweep on the device.
- `movedSweepKeys` on the bridge object, injected at document start: sweeps confirmed from the lock
  screen while the page was not running. `loadMovedSweepKeys` merges it at boot.
- A `curb-alerts-native` DOM event from shell to page, with `detail.type` one of `open-url` (a
  reminder was tapped; the page focuses that sweep but does not confirm it), `sweep-moved` (the lock
  screen's **I moved my car** was pressed) or `permission-changed` (changed in Settings).
- `getCurrentPosition()`, resolving `{ latitude, longitude, accuracy }` from Core Location. **The
  page's own `navigator.geolocation` never works in the app**: `curbalerts://` is not a secure
  context, and `isSecureHost` refused before even asking. Found on a device 2026-09-15, where "Use
  my location" was a dead end. `requestUserLocation` prefers the bridge whenever it has this method,
  and a rejection's message is shown to the driver as written, so keep the native messages plain.

Verified on an iPhone 15 Pro on 2026-09-15: install, notification permission, a test alert on the
lock screen, and its **I moved my car** button on long-press.

**The 64-notification limit is handled on the device, not in the job builder.** `ReminderScheduler`
keeps the full list but schedules only the next 21 days, capped at 60, and refills that window on
every foreground and on a `BGAppRefreshTask`. Background refresh is best effort — iOS decides when,
and never on the simulator — so opening the app remains the guaranteed refill. Reminders are
`timeSensitive` (entitlement in `CurbAlerts.entitlements`) so a Focus mode does not hold a sweep
warning back until after the ticket.

**`ITSAppUsesNonExemptEncryption` is `false` in `ios/CurbAlerts/Info.plist`**, added 2026-09-15 so
App Store Connect stops asking the export-compliance question on every TestFlight upload. It is true
only because the app's sole cryptography is what iOS provides: HTTPS through the system networking
stack, and the session token in the keychain (`SessionKeychain`, the `SecItem` APIs). Both are exempt.
**Adding CryptoKit, CommonCrypto or any encryption of our own makes this key false, and it must be
revisited in the same commit.** The widget extension does not need the key; App Store Connect reads
the main app's.

The account signing the app (team `XLGGMG362T`) is a paid Apple Developer Program membership,
confirmed 2026-09-15 from its one-year provisioning profiles and access to Certificates, Identifiers
& Profiles. TestFlight is therefore available. The first archive creates the Apple Distribution
certificate, so its absence before then means nothing.

### The lock-screen card (Live Activity)

Added 2026-09-15 and verified on an iPhone 15 Pro: the card shows on the lock screen and in the
Dynamic Island, survives the phone being woken and unlocked, and its **I moved my car** button works
without opening the app. `ios/CurbAlertsWidgets` draws it; `ios/Shared` holds the two types both
targets compile, `SweepActivityAttributes` and `MovedCarIntent`.

**A card starts at a sweep's first alert on the sweep day itself, never the evening before.** A
Live Activity lives about eight hours, so one started at 6pm would be gone by the morning it is
about. `LiveActivityScheduler` plans from the jobs the page already hands over, keyed on the same
sweep key, up to three sweeps within three days.

**Starting one in the future needs iOS 26** — `Activity.request(...alertConfiguration:start:)`,
read out of the SDK rather than assumed. Below iOS 26 a card can only start when it is already due,
so it appears when the app is opened on the sweep day. A scheduled card reports `.pending` in
`Activity.activities`, which is what stops each foreground scheduling it again. That last part is
reasoned from the SDK, not yet watched happen across a real sweep; check it the first time a saved
sweep comes within three days.

**The button's intent runs in the app, and the widget compiles a stub of its handler.** A
LiveActivityIntent is performed in the app's process, which is how it reaches `ReminderScheduler`
with the app backgrounded. The widget target has to compile `MovedCarIntent` because its button
names it, so each target has its own `MovedCarIntentHandler`: the app's does the work, the widget's
is empty. Do not "fix" the empty one.

**A sync ends a card only when its sweep is confirmed or has no reminders left.** The first version
ended every card missing from that pass's plan, which killed cards the plan had merely capped out,
and on a device ended the preview card the instant Face ID brought the app to the foreground.
Keep the narrower rule.

**"Send test now" starts a test card in Debug and TestFlight builds, and not in App Store builds.**
Keyed `test-card|<date>` so it names no saved set, and labelled as a test on the card itself while
keeping the real card's wording, so a tester sees what a sweep morning will look like. Until
2026-09-16 it was Debug only, which left TestFlight testers no way to see the card short of waiting
for a sweep. It stays out of the App Store because a card that sits on the lock screen until
tomorrow is too much for a test button. TestFlight is detected by its sandbox receipt
(`canStartTestCard`); `AppTransaction` was avoided because it can raise an App Store sign-in sheet.
Verified from a TestFlight install of build 3 on 2026-09-16: the test card appeared and its button worked.

**At the first morning alert the driver gets both the card's alert and the ordinary notification,
on purpose.** Decided 2026-09-15 by the app's author, for the reason the follow-ups exist at all: a
reminder that is easy to ignore is how the ticket happened. Do not dedupe them. The notification is
also the fallback when the card was never started - Live Activities switched off, or iOS below 26.

**TestFlight is live.** The app record for `co.curbalerts.app` exists (Apple ID 6812789158) with an
internal group, *Friends*, and an external group, *Friend Test 1*. Build 1 was uploaded 2026-09-16
and went to Beta App Review for the external group; build 2 followed the same day to carry the new
app icon, and was never added to the external group. Build 3, the same day, carries the test card and
went out in its place. Build 4, uploaded 2026-09-16, carries the one-tap curb reminders; it was
archived and uploaded entirely from the command line — `xcodebuild archive` with
`-allowProvisioningUpdates`, then `xcodebuild -exportArchive` with an options plist of `method`
`app-store-connect`, `destination` `upload` and team `XLGGMG362T` — so Xcode's Organizer is not
required. Archive with the **CurbAlerts** scheme selected; build 3 was archived from
`CurbAlertsWidgets` by mistake and happened to produce the whole app anyway, but do not rely on that.
Build 5, uploaded 2026-09-18, carries the named-street address search and went to internal testers
only, at the author's request. It was exported with `testFlightInternalTestingOnly` set in the
options plist, which App Store Connect enforces: such a build can never be added to an external
group. Leave the key out for a build that should reach *Friend Test 1*. Build 6, uploaded
2026-09-19, carries the widget and the bundled Leaflet and is meant as the App Store submission. It
was exported **without** that key, so it can go to either group and to review. Its archive was the
first to sign with the App Group, and `-allowProvisioningUpdates` registered
`group.co.curbalerts.app` on both App IDs. Build 7, uploaded 2026-09-19, is build 6 plus the
widget's dark appearance, and replaces it as the submission candidate. **Every upload needs a higher `CURRENT_PROJECT_VERSION`, and the app and the widget
extension must carry the same one** or the upload is refused. Raise it in all four build
configurations and commit it, or the next archive from a clean checkout reuses a spent number.
`MARKETING_VERSION` stays `1.0` until a real release. A build expires 90 days after upload, and a web
change reaches testers only in a new build, because the app ships its own copy of `public/`.

**`ios/CurbAlerts/PrivacyInfo.xcprivacy` has to stay true to the Privacy page**, added 2026-09-16.
It declares one required-reason API, `UserDefaults`, with two reasons: `CA92.1` for the app's own
defaults, which the one-time migration below still reads, and `1C8F.1` for the App Group that
`ReminderStore` now keeps the job list and confirmed sweeps in. The widget reads that group, so since
2026-09-19 it has a manifest of its own, `ios/CurbAlertsWidgets/PrivacyInfo.xcprivacy`, declaring
`1C8F.1` and nothing collected. A new `UserDefaults` call, a file timestamp read, or an uptime read
anywhere in either target needs its reason added to that target's manifest in the same commit.
The data it declares as collected, none of it for tracking, is what leaves the phone and is kept:
the account's email and its synced curb library (linked), and issue reports with their device context
(not linked). Coordinates sent to `/api/denver/sweeping` are not declared, because the proxy answers
and keeps nothing, and the parking pin never leaves the device. If the server ever starts storing a
lookup, or a new payload leaves the phone, this file and the App Store privacy answers change with it.

**Not done yet, in the order they matter:**

- Geofencing and APNs (steps 4 and 5).

### The home-screen widget

Added 2026-09-19. `NextSweepWidget` in `ios/CurbAlertsWidgets` shows the soonest sweep the driver
still has to move for — small and medium on the home screen, and rectangular, inline and circular
on the lock screen. On a sweep's day and the day before, the home-screen sizes carry the same **I
moved my car** button as the lock-screen card, and once it is pressed they say *Car moved* until the
next sweep. Verified in the simulator on 2026-09-19: the button recorded the sweep through the app
and the widget redrew. Not yet watched on a device or across a real midnight.

**The home-screen sizes follow the phone's appearance; the app does not.** `WidgetPalette` in
`NextSweepWidget.swift` pairs each of `Palette`'s colours with a dark one, so the tile is dark on a
dark home screen — the app itself is `UIUserInterfaceStyle = Light`, but a cream card sitting among
the system's own widgets reads as a stuck notification rather than part of the phone. Dark mode
needs a lighter orange to carry on a dark card, and white on that orange is too faint to read at a
glance, so the button's label is dark there (`onAccent`). The lock-screen sizes take no colour from
this: the system tints them. Both appearances checked in the simulator on 2026-09-19.

**It reads the reminder jobs, and nothing else.** `ReminderStore` and `ReminderJob` moved to
`ios/Shared` and into the App Group `group.co.curbalerts.app`, because a widget is its own process
and cannot read the app's defaults. The app is the only writer. `migrateFromStandardDefaultsIfNeeded`
copies build 5's data across at launch, so a tester keeps their reminders across the update without
waiting for the page to hand the list over again. Sweep dates come from the sweep keys, which end in
the date, so the widget needs no page, no network and no second copy of the inventory — and it is
only as current as the app's last open, which is the same limit the notifications have.

**Both targets carry the App Group entitlement, and the first archive has to register it.**
Automatic signing with `-allowProvisioningUpdates` adds the group to both App IDs in the developer
portal. Without it `ReminderStore` quietly falls back to the app's own defaults: the app keeps
reminding, and the widget shows *No sweeps coming up* forever.

**The button is the card's `MovedCarIntent`, and it only works because that is a
`LiveActivityIntent`.** iOS runs it in the app's process even from a home-screen widget, which is how
it reaches `ReminderScheduler`; an ordinary `AppIntent` would run in the widget extension and hit the
empty stub `MovedCarIntentHandler` there. Do not change the intent's protocol. There is no Undo on
the widget; the page's banner has one, as for the lock-screen button.

**`ReminderScheduler.reschedule` is the one place that reloads the widget.** Every path that
changes the schedule or confirms a sweep goes through it — the page's sync, both lock-screen
buttons, the widget's own button, foreground and background refresh. Between those, the timeline
carries an entry at each of the next seven midnights so *tomorrow* turns into *today* with the app
closed. A sweep stays listed for its whole day, because Denver publishes no sweep time.

**A tap on the widget opens `curbalerts://widget/open?path=...`**, which `onOpenURL` hands the page
as an `open-url` event — the same thing a tapped reminder does, so it focuses that sweep without
confirming it. The host is `widget`, not `app`, to keep it apart from the web view's own files, and
`SweepWidgetLink.pagePath` passes on only a same-page path. The scheme is not registered in
`CFBundleURLTypes`, and does not need to be: iOS delivers a widget's URL to its own app.

**Two corrections to what this file used to say here.** It said the APNs rebuild was "the real cost
of the move". It is not the largest piece: the client's browser assumptions and the session change
are comparable, and both are invisible from the payment side. And it implied server push was the
only way to get reminders inside a shell, which is wrong for the specific reason that this app
computes its jobs client-side with absolute times — that is what makes step 3 sufficient on its own.


## Email

Added 2026-08-29. Address confirmation and password reset, which are the two things the account
system had been missing since it landed, and both are a link in an inbox and nothing else.

**No new dependency, and Resend is the assumed provider.** [lib/email.js](lib/email.js) is
`node:https` and one JSON POST, the shape the removed Stripe client used against a different host.
Swapping
providers is `deliverViaResend` and nothing else; it is deliberately not an adapter layer, because
the real cost of switching is the DNS records, not those thirty lines. SMTP is the option to avoid —
it would mean nodemailer, the first dependency this project cannot lazily require.

**Email went live on 2026-09-21.** `curbalerts.co` is verified at Resend, and `RESEND_API_KEY`,
`EMAIL_FROM` (`Denver Curb Alerts <alerts@curbalerts.co>`) and `APP_ORIGIN` are set on Render.
Verified end to end that day: a reset link reached Gmail's **inbox** rather than spam on the first
ever send from the new domain, which is SPF, DKIM and DMARC all aligning on the first try.

**Resend's records coexist with Cloudflare Email Routing only because none of them touch the root,
and that is worth understanding before anyone adds to them.** Inbound mail for the domain —
`support@curbalerts.co`, printed on the Terms and Privacy pages — is Cloudflare Email Routing, which
owns the root `MX` (`route1/2/3.mx.cloudflare.net`) and the root SPF
(`v=spf1 include:_spf.mx.cloudflare.net ~all`). A domain has one of each. Resend publishes its SPF as
two CNAMEs instead — `send` and `rsend`, pointing at `send.forge.rmta.net` and `rsend.forge.rmta.net`,
whose own targets carry the `MX` records that handle bounces — so the domain inherits Resend's
envelope handling without a single record being added at the apex. DKIM is `resend._domainkey`, which
does not collide with Email Routing's `cf2024-1._domainkey`.

**So do not turn on Resend's "Enable Receiving" toggle.** It asks for `MX` records at the root, which
is the one thing that cannot be shared, and taking them would break inbound mail to `support@`. This
app sends; Cloudflare receives. Keep that split. Both CNAMEs are **DNS only** in Cloudflare for the
reason recorded elsewhere in this file: a proxied CNAME resolves to Cloudflare's own addresses, and
the mail path then breaks with nothing anywhere to explain why.

**`APP_ORIGIN` was unset on Render until the same day, and that would have been the visible failure.**
With nothing configured, `buildCredentialedOrigins` falls back to `BUILT_IN_CREDENTIALED_ORIGINS`,
`www.curbalerts.co` is not among them, and `resolveReturnOrigin`'s last resort returns that set's
first entry — the Render subdomain. Every reset link would have arrived pointing at
`denver-curb-alerts-2.onrender.com`: working, and reading like phishing for a service called Curb
Alerts. Sign-in was never affected, because the page and the API share an origin and CORS never comes
into it, which is exactly why this would have shipped unnoticed.

`_dmarc` is `v=DMARC1; p=none;` with no `rua=`, which satisfies Gmail's and Yahoo's requirement that a
record exist while sending reports nowhere. Put an address there if visibility into who is sending as
the domain is ever wanted.

**The send and receive halves were confirmed against each other in one round trip**, also on
2026-09-21: the reset went out from Resend as `alerts@curbalerts.co` and arrived at
`garrett@curbalerts.co`, forwarded by Cloudflare Email Routing into Gmail's inbox. Same domain, out
and in, neither path disturbing the other. It survived the forward because DKIM does — SPF does not,
since the forwarding host is not in the sending domain's SPF record, so DKIM alignment is what
carries DMARC across a forward. That is worth remembering before anyone weakens the DKIM record.

**Replies are routed too, as of 2026-09-21.** `alerts@curbalerts.co` is a sending identity rather
than a mailbox, so a reply to a reset email would have bounced until Email Routing got a rule for it;
it has one now, alongside `garrett@` and `support@`. All three forward to the same Gmail.

**Test a forwarding rule from an address that is not the destination.** Gmail deduplicates a message
it sent, so mail from the destination account to a rule that forwards back to it is accepted,
forwarded, and then silently dropped on arrival — which looks exactly like a broken rule. Cloudflare
detects that case and emails a notice explaining it, which is the only reason a same-account test
tells you anything at all. Both addresses were then confirmed the right way, by someone else sending
to them: `support@` the week before, `alerts@` on 2026-09-21.

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

**The link origin comes from `resolveReturnOrigin`, and it is load bearing.** It prefers
`APP_ORIGIN` and falls back to the request's own only if that origin is in `CREDENTIALED_ORIGINS`.
`Host` is client-supplied, and a poisoned one means a reset link arriving in someone else's inbox
pointing at the attacker's server. It was shared with the Stripe checkout return until 2026-09-03,
where the same weakness only let an attacker redirect their own checkout; email raised the stakes. Locally this means links on an autoPort dev server
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
6. Work happens on `develop`. **Render deploys from `main`**, so nothing reaches the live site
   until `main` moves. Releasing is fast-forwarding `main` to `develop` and pushing it —
   `git branch -f main develop && git push origin main` — once `npm test` and
   `npm run audit:inventory` pass on `develop`. Never commit to `main` directly: keeping it a strict
   ancestor of `develop` is what makes every release a fast-forward rather than a merge.

   Decided 2026-09-15. Before that Render had in fact been deploying `develop`, so every push there
   went live — found when the site was serving a `?v=` tag that existed only on `develop` while
   `main` sat ten commits behind. `render.yaml` now says `branch: main`, but the branch is also a
   setting on the service in the Render dashboard, and the file only governs it when the service is
   managed by the blueprint. **If the live site ever serves a `?v=` tag that is on `develop` but not
   on `main`, the dashboard is still deploying the old branch.**

## Environment variables

Every variable the server reads is listed in [.env.example](.env.example) and declared in
[render.yaml](render.yaml) as `sync: false`, both brought complete on 2026-08-29. Keep them that
way: an unset variable here is never an error, it is a feature that silently answers 503 (email) or
does nothing at all (push), which is much harder to notice than a crash. Worth knowing
beyond the file:

- `ISSUE_REPORT_ADMIN_TOKEN` — gates every bulk read that returns other people's data, not just
  issue reports, via `Authorization: Bearer <token>`. Unset by default, which closes them.
- `DATA_DIR` — where the JSON collections live. Unset everywhere except `test/accounts.test.js`,
  which points it at a temp directory so a test run cannot write accounts into the working copy.
- `APP_ORIGIN` — **overloaded, deliberately.** It is which server the pipeline scripts query
  (defaulting to localhost for `build-static-inventory.js` and **production** for
  `map-area-approach-3.js`), *and* the server's own canonical origin: `resolveReturnOrigin` prefers
  it, and `buildCredentialedOrigins` trusts it with a session cookie.
  In production those are the same string. Setting it locally to something that is not this app is
  how a reset link ends up pointing somewhere strange.
- `CREDENTIALED_ORIGINS` — comma-separated extra origins to trust with a session cookie, for a
  staging deploy or for holding both hostnames during a domain cutover. See the accounts section.
- `RESEND_API_KEY`, `EMAIL_FROM` — transactional email. Both must be set or email is off.
- `EMAIL_TRANSPORT` — set to `outbox` to run the email flow with no provider. See the Email section.

Push notifications do nothing without `https://`, VAPID keys, and `npm install`.

**Two properties of Render's free plan were launch blockers rather than preferences**, and neither is
visible in the code. A free instance sleeps after inactivity, and reminder dispatch is a
`setInterval` inside this process — a sleeping instance sends no reminders, which is the entire
product. A free instance also has an ephemeral filesystem, wiped on every deploy, so with no
`DATABASE_URL` the JSON collections under `data/` take accounts, sessions, push subscriptions and
reminder plans with them.

`render.yaml` now closes both: the web service is `starter` rather than `free`, and a `databases:`
block provisions Postgres with `DATABASE_URL` wired to it through `fromDatabase`, so the connection
string is injected rather than typed. **Declaring it is not the same as having it** — the blueprint
has to be applied in the Render dashboard before either takes effect, and until it is, the app is
still sleeping and still storing accounts on a disk that does not survive a deploy. Render's own
free Postgres tier is deliberately not used: it is deleted after 30 days, and the server falls back
to JSON files rather than refusing to start, so losing it would look like customers quietly signed
out with their saved sets gone. No migration step is needed on a fresh database —
`ensureDatabaseSchema` creates `app_collections` and seeds every collection on first connect.
Do not take a payment before the blueprint is actually applied.

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
  1200-block street, Downing, not at 12th), and south streets off the named avenues below
  Ellsworth. **Since 2026-09-18 the named-street grid maps those
  names to numbers** — `addressGrid` on the Denver record in `public/cities.js` since
  2026-09-21, aliased in `public/app.js` as `SEARCH_NAMED_STREET_HUNDREDS` — derived from about 210,000 OpenStreetMap addresses and kept only where it
  placed them back accurately: over 5,600 addresses inside the city line, a search lands a
  median 40 m from the door, against 1.1 km before. Three things about it are load bearing.
  West of Broadway the grid changes across the Platte (Kalamath is 1000 W south of the river,
  1200 W north of it), which is what `wNorth` overrides. Only a street counting north from
  Ellsworth may use a numbered crossing — offered to an avenue, "37" found W 37th Ave itself and
  E 11th Ave, 130 m away, passed as a corner of E 12th. And a typed quadrant the map lacks
  (N Florence Way) gets the street answer, not a number placed on the other half of the city.
  Where the table cannot place an address — no quadrant typed on an avenue that has both, or a
  street it does not list — the matcher still reports `kind: "street"`, the map opens wider,
  and the status line says it only matched the street. Do not paper over that with a
  block-zoom pin the data does not support. If you change the table, re-measure placement
  against real addresses rather than trusting vote counts; tuning on thin margins once put
  Utica east of Tennyson.
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
- **Leaflet is vendored**, since 2026-09-19, in `public/vendor/leaflet/` — 1.9.4 from the npm
  tarball, byte-identical to the unpkg files the page used to load, which is how it was checked: both
  match the SRI hashes the old tags carried. It ships in the iOS bundle too (the "Bundle web app"
  phase used to exclude `vendor/`), so the app draws its map controls with no connection. The base
  map tiles still come from `tile.openstreetmap.org` and still need one. Upgrade it as a unit — new
  files and a new `?v=` in both `index.html` and `sw.js` — and do not leave it to a CDN again. The
  asset lock and the version test read `?v=` paths with subdirectories for this; they used to see
  only the basename, which would have let a changed `vendor/` file slip past the freshness check.
- **The base map tiles come from `tile.openstreetmap.org`, one host, and must stay that way.** The
  `{s}` a/b/c subdomains the tile layer used until 2026-09-21 existed to dodge HTTP/1.1 per-host
  connection limits; they buy nothing over HTTP/2, cost OpenStreetMap cache efficiency, and the
  tile usage policy no longer sanctions them — it warns the extra hostnames may be withdrawn
  without notice. Do not reintroduce them, and keep the `© OpenStreetMap contributors`
  attribution: that one is a licence condition of the underlying data, not of whoever serves the
  tiles.

  These are donated servers. The policy permits an app to use them, but reserves the right to
  block without notice, and it **forbids bulk prefetching and "download for offline use"** — so a
  basemap bundled into the iOS app cannot come from here, however much the rest of `public/`
  already ships in the bundle. That is the reason to move to a self-hosted or paid basemap before
  this app has customers, not a vague compliance worry. Assessed 2026-09-21: the cheap swap is a
  paid raster provider, which is a URL and a key with Leaflet untouched; the self-hosted answer is
  a PMTiles extract, which Leaflet cannot render on its own and which `server.js` cannot serve
  yet — PMTiles needs HTTP Range support, `serveStaticFile` has none, and the service worker
  cannot `cache.put` a 206 response.
- **Names are historical.** `denver-west-routes.*` and every `sloans-lake-*` localStorage key now hold
  city-wide and east-Denver data. Don't infer scope from the names.
- `data/` is ~360 MB, and `data/inventory-expected-blocks.json` alone is 36 MB across 97,827 blocks.
  Grep with care, and never read these files whole.

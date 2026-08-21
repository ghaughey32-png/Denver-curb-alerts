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
| `npm start` | Serves on `127.0.0.1:3000`. Must be running **before** `build:inventory` or `build:review-queue`. |
| `npm test` | `node --test test/*.test.js`. Runs in about half a second. |
| `npm run audit:inventory` | Offline coverage gate. Run this before every handoff. |
| `npm run build:inventory` | Full rebuild. Hits Denver's live API hundreds of times; needs the local server up. |
| `npm run rebuild:offline` | Reclassifies the published inventory with no network. Use for matching/classification fixes; see below. |
| `npm run map:area -- <area-id>` | Staged discovery for one pilot area. **Defaults `APP_ORIGIN` to production**, not localhost — set it deliberately. |
| `npm run build:review-queue -- <overpass.json> [area-id]` | Builds a human-review queue. Never touches the published inventory. |
| `npm run sync:coverage` | Offline reconciliation pass. No network. |

Not wired to npm: `node scripts/import-osm-expected-blocks.js <map.osm> <area-id> <south> <west> <north> <east>`.

## Hard rules

**Never hand-edit generated artifacts.** Regenerate them with the script that owns them:

- `public/denver-west-routes.json` and `public/denver-west-routes.js` (~9 MB each, same payload — the
  `.js` assigns it to `window.DENVER_WEST_ROUTE_INVENTORY` for instant first paint). They are always
  written together and must stay in sync.
- `data/inventory-coverage-report.json`
- `data/mapping-cache-*.json`, `data/mapping-report-*.json`

**Bump the versioned constants together.** Changing any file in `public/` means updating its `?v=`
string in *both* places, or the change silently fails to reach installed clients:

- [public/index.html](public/index.html) — the `?v=` query on each `<link>` / `<script>`
- [public/sw.js](public/sw.js) — the matching entry in `APP_SHELL`, plus `CACHE_NAME` on line 1

Two more versioned constants live in [public/app.js](public/app.js):
`STATIC_ROUTE_INVENTORY_URL` (line ~1549) and `SLOANS_LAKE_FULL_INVENTORY_CACHE_KEY` (line ~1548).
`test/static-cache-version.test.js` enforces all of this — if it fails, fix the versions, don't
weaken the test.

**The product invariant: no mapped public street block may render blank.** An unmatched public block
either resolves to a scheduled route or becomes a pink `dataUnavailable` overlay. Anything left over
is an `unexplained-gap`, and `build:inventory` throws rather than publish it.

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

- **A clean coverage report is not a precondition.** `sync:coverage` writes the report with
  `generateUnavailable: false` and does not enforce the build gate, so
  `data/inventory-coverage-report.json` can show `unexplained-gap` counts (currently ~19 Tennyson
  blocks) while the app is fine. Only `build:inventory` enforces the gate.
- **The published inventory is stale relative to the scripts, and a full rebuild will surface it.**
  As of 2026-08-19, running `build:inventory` (or replaying the coverage patches over the published
  payload) fails five tests that pass against the committed file. Verified unrelated to any current
  work by reproducing it with an unmodified `inventory-auditor.js`. Three causes, all pre-existing:
  the four `routeMap.delete(...)` calls in `auditAndPublish` remove fallbacks for blocks whose real
  coverage is only 0.18–0.36, leaving them blank (`florida-evans`/`evans-yale` S Lowell and S Osceola,
  plus their cross-area twins); `ensureRinoOfficialRouteCoverage` adds two Larimer blocks that
  `test/curb-geometry.test.js` does not expect (it asserts exactly 6); and the Tennyson, Yates and
  MLK expected blocks have no suppression in the build script, so a rebuild publishes pink routes
  that `test/inventory-coverage.test.js` forbids. Whoever next runs a full crawl has to resolve these
  — probably by excluding the bogus blocks in the manifest and updating the Larimer count — rather
  than assuming the rebuild broke something.
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

# San Francisco expansion plan (draft, 2026-10-09)

Status: **proposal, not instructions.** Nothing here is built. Research behind it is in
[HISTORY.md](HISTORY.md) § Chicago research / San Francisco and Los Angeles research. Per
AGENTS.md, nothing in `public/` or `ios/` changes until Build 12 clears App Review; Phases 0–2 live in
`scripts/` and `data/` only.

## What the data gives us (verified 2026-10-09)

`yhqp-riqs` on data.sf.gov, Public Works, updated as schedules change. Pulled in full: **37,878 rows,
12,253 centerlines, 16 MB raw, about 5 MB slimmed** before coordinate rounding and dedupe (Denver ships
12 MB). One `LineString` per block side, with:

- `cnn` (centerline id) + `cnnrightleft` (L 18,695 / R 19,183) + `blockside` (compass), `corridor`, `limits`
- `weekday` (Mon–Fri, **Sat 1,340, Sun 1,271**, and `Holiday` 824) and `fromhour`/`tohour` (**posted hours**)
- `week1`…`week5` flags. Patterns: every week 23,908; 2nd/4th 6,880; 1st/3rd 4,367; 1st/3rd/5th 2,287; a
  few others. `holidays` = 1 on 2,733 rows (swept on holidays); 0 on the rest, so **holidays skip them**.
- 22 rows have no line (drop and report).

Differences from Denver that shape the plan: SF publishes **times** (Denver never does), sweeping is
**all posted** (no "never move" plum state), it runs **year-round**, and the data is **one clean
dataset**, so there is no crawl, no coverage audit, and no pink state to invent.

## Decisions to make before Phase 1

1. **Scope of v1: sweeping only.** SF also has meters, residential permit zones (RPP), tow-away and
   street-cleaning-adjacent rules. Competitors that cover only sweeping already exist; resist widening v1.
   Copy must say clearly that the app covers sweeping only and signs always win.
2. **Pricing.** Same StoreKit products as Denver, or per-city? Recommend one subscription across cities
   (Apple ID-keyed, as today) so a Denver subscriber is covered in SF. Needs a decision, not code.
3. **Notification cadence (decided 2026-10-09).** SF works like Denver: local, on-device reminders the
   user configures, not server push.
   - **Overnight blocks** (posted start before 5 am): **evening-before reminders only**, no sweep-day
     morning reminders, because the sweep is over by morning. The user sets the times (up to three per
     sweep); defaults **6 pm and 8 pm**.
   - **Daytime blocks:** Denver's full model: an evening heads-up plus the sweep-day reminders, all with
     user-set times. SF's posted start hour could later allow "N minutes before sweeping"; not decided.
   - The "I moved my car" confirmation removes the pending reminders. Keep the iOS 64-pending cap in view
     when choosing how many times per sweep a user may set.
4. **Where do we take the city line and the address search from?** See Phase 3.

## Phase 0: confirm the gaps (no code, ~1 day)

- Validate the sweeping rows against real tickets: `ab4h-6ztd` (`STR CLEAN` ~6.8 M, `ST CLEANIN` ~2.5 M).
  For a sample of ticketed street cleaning citations, check the issue day/time falls inside the schedule of
  the block that holds the ticket's location. Report a mismatch rate; Minneapolis's gate was 5%, and its
  measured rate was 1.0–2.9%. If SF's rate is much worse, stop and learn why before building.
- Confirm `blocksweepid`/`cnn` are stable across refreshes (curb ids must survive, like Minneapolis).
- Spot-check 10 blocks against posted signs or the city's own lookup, including a Saturday, a Sunday, a
  `Holiday`-weekday row, and a 5-week-pattern row.
- Find the SF city boundary (DataSF "Bay Area Counties/City" or the city's own boundary) and the address
  source (DataSF "Addresses with Units – Enterprise Addressing System").
- Decide whether `Holiday` rows (824) need their own treatment; they mean sweeping only on a holiday.

## Phase 1: the build script (`scripts/`, offline, ~2–3 days)

`scripts/build-sf-sweeping.js` → writes a generated `public/sf-sweeping.json` (path and name to confirm; the
file is never hand-edited, like `minneapolis-snow.json`). Modeled on `build-mpls-snow` and
[scripts/lib/minneapolis-snow.js](scripts/lib/minneapolis-snow.js), not on `build-static-inventory.js`.

- Fetch with paging and cache under `data/sf-sweeping-cache/` (`--refresh`, `--dry-run`, as Minneapolis).
- Each curb: `{ id, street, sideKey, days, startHour, endHour, weeks, holidays, geometry }` with
  `id: "sf:<hash of cnn+side>"`. **Ids must survive a refresh**; carry old ids to the nearest new curb on
  the same street and side within 15 m, and report any that are retired.
- Coordinates rounded to seven decimals (the repo's rule: six reclassifies blocks).
- Gates: the Phase 0 ticket check, and curb count may not fall more than 10% (`ALLOW_COVERAGE_DROP=1`).
- Tests: a pure `lib` for the rules (`week` flags to dates, holiday handling, year-round projection), run
  with `npm test`, no network. The date projection must be tested at month boundaries and 5-week months.

## Phase 2: per-city inventory loading (design, then `public/` after Build 12 clears)

Denver's 12 MB is bundled into the iOS app and fetched once by the page. A third inventory forces the
deferred per-city on-demand design (AGENTS.md "Before building for a second city").

- Minneapolis already loads through `loadSnowInventory` and stays out of `sw.js`'s `APP_SHELL`. SF follows
  that pattern: `inventoryUrl` on its `cities.js` record, `?v=` moves with it, not precached.
- Decide: bundle SF in the app, or download on first use? About 5 MB is small enough to bundle; Denver
  plus Minneapolis plus SF is roughly 22 MB. Recommend bundling for v1 and revisiting at city number 4.
- A header city switcher already exists; choosing by location needs SF added.

## Phase 3: SF as a city record (after Build 12)

- `public/cities.js`: bounds, `minZoom`, `inventoryUrl`, `kind: "sweeping"`, `webReminders: false`,
  `appStoreUrl`. Reuse the existing `kind` split (`"snow"` for Minneapolis).
- **Address search.** `findLocalSearchMatch` uses Denver's `addressGrid`, which does not apply. SF needs
  a geocode path. Options: bundle the EAS address points (compressed, only street + number + lat/lng) or
  call a geocoder through the server. Recommend a bundled, trimmed table so the app stays free of third
  parties and the privacy manifest does not change. Measure its size before choosing.
- **City limits.** Reuse the pattern of one shared file read by map and pipeline (see
  `denver-city-limits.js`); SF's line is simple (one polygon) but must not be hardcoded per area.
- **Colors.** SF has no pink/plum/gray states in v1: a block is either swept on a schedule or not in the
  data. The gray "not maintained" state needs a decision (bike lanes are excluded from this dataset).
- **Reminders.** Reuse the local reminder jobs, keyed off `startHour`. The existing "keep going until moved"
  nag, the moved confirmation and the parking pin all apply. The 64-notification iOS cap and
  `ReminderScheduler` rules stay.
- **Copy.** Terms, Privacy and Disclaimer must name SF and the sweeping authority (SF Public Works / SFMTA),
  in the same commit as the behavior. Source-text tests will need updating.
- **Subscription.** If one subscription covers all cities, no StoreKit change; the paywall copy changes.

## Phase 4: ship (needs the user's go-ahead)

- Bump `CURRENT_PROJECT_VERSION` in all four configurations, archive, upload to TestFlight.
- App Store listing: new screenshots and description for a third city; check Guideline 4.3 (spam / minimum
  functionality) risk for multi-city apps and note it in the review notes.
- Launch-day `appStoreUrl`, and refresh the generated inventory on a schedule (SF edits as needed, so
  refresh before each season boundary is not enough; plan a monthly `--refresh` after launch).

## Overnight blocks and alert copy (decided 2026-10-09)

Day-level alerts are enough; the app does not promise an exact sweep time. Phase 0 found daytime blocks
(posted start 6 am or later) 97.5% consistent with tickets and overnight blocks 81.2%, and every time
miss had the right weekday and week. See HISTORY.md § SF missing blocks and time windows.

- **An overnight block** is a row whose posted window starts before 5 am (about 30% of rows). "Tuesday
  0–2" means 12–2 am Tuesday, so the car must move **Monday night**. Store it as a `nightBefore` flag; the
  reminder date is the evening before the posted weekday, not the weekday itself.
- **Overnight notification (default 6 pm and 8 pm, user-configurable, evening before only):** "Overnight street sweeping tonight. Move your car."
- **List / detail view:** "Overnight sweeping, Monday night (posted 12–2 am Tuesday)." The posted hours
  appear only here, labelled as the posted sign, never as our promise ("check the sign").
- Do not say "before midnight": some overnight windows start at 3 or 4 am.
- The 5th-week flag stays unconfirmed (HISTORY.md § SF miss clusters); overnight rows are not yet checked
  against real signs.
- Keep this wording in SF-specific code or the city record, not in Denver's copy (Denver publishes no time).

## Risks

- **Competition:** Sweep Alarm (4.5 stars, ~89 ratings), a subscription competitor, a new CURB app and
  SpotAngels. Our edge is per-block-side accuracy plus time-based alerts, not features. Test willingness to
  pay before spending on marketing.
- **Free incumbents** can undercut a paid app. The Denver decision (reminders are what is sold, the map
  stays free) is unchanged; SF's price test is whether people pay for it there.
- **Accuracy trust.** The incumbent with the best reviews gets complaints about stale dates. Show the data's
  refresh date in the app.
- **Sweeping is all signs.** A rare mistake in the data costs a driver $95-ish; the Disclaimer must say the
  posted sign wins.
- **Build 12 timing.** Phases 0–1 are safe now; Phases 2–3 wait on Apple.

## Not in v1

Meters, residential permit zones, tow-away rules, bike-lane sweeping, geofencing, Android, Apple push
(SF sweeping is fixed-schedule, so push is not needed).

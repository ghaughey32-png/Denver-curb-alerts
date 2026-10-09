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

## Phase 1: the build script (`scripts/`, offline, ~2–3 days) — built 2026-10-09

`scripts/build-sf-sweeping.js` → writes a generated `public/sf-sweeping.json` (path and name to confirm; the
file is never hand-edited, like `minneapolis-snow.json`). Modeled on `build-mpls-snow` and
[scripts/lib/minneapolis-snow.js](scripts/lib/minneapolis-snow.js), not on `build-static-inventory.js`.

- Fetch with paging and cache under `data/sf-sweeping-cache/` (`--refresh`, `--dry-run`, as Minneapolis).
- Each curb (as built: `{ id, street, sideKey, schedules, geometry }`, the hours and weeks sit in
  `schedules`; see the header of `scripts/lib/sf-sweeping.js` and HISTORY.md § SF build; the file is 6.75 MB, not 5) with
  `id: "sf:<hash of cnn+side>"`. **Ids must survive a refresh**; carry old ids to the nearest new curb on
  the same street and side within 15 m, and report any that are retired.
- Coordinates rounded to seven decimals (the repo's rule: six reclassifies blocks).
- Gates: the Phase 0 ticket check, and curb count may not fall more than 10% (`ALLOW_COVERAGE_DROP=1`).
- Tests: a pure `lib` for the rules (`week` flags to dates, holiday handling, year-round projection), run
  with `npm test`, no network. The date projection must be tested at month boundaries and 5-week months.

## Phase 2: per-city inventory loading (design written 2026-10-09; code waits for Build 12)

This is a design. It changes nothing in `public/` or `ios/`. The earlier draft of this phase assumed a
new loading mechanism was needed; reading `public/app.js`, `public/cities.js` and the Xcode bundle phase
shows most of it already exists, and the real work is elsewhere.

### What is already true

- **The page fetches exactly one city's inventory per load.** The header switcher saves the choice and
  reloads (`saveCityChoice`), `ACTIVE_CITY` is resolved once, and `loadStaticRouteInventory` /
  `loadSnowInventory` fetch only `ACTIVE_CITY.inventoryUrl`. Minneapolis stays out of `sw.js`'s
  `APP_SHELL`. SF follows exactly that: a `?v=` URL, cached on first use, never precached. No download
  manager, no new cache layer.
- **iOS bundles all of `public/`** (the "Bundle web app" phase `rsync`s it). With SF that is roughly
  12 + 4.5 + 6.75 = 23 MB of raw JSON, 983 KB of it gzipped for SF. **Decision: bundle all three.** First
  launch works offline, there is no new failure path, and nothing changes in the privacy manifest. If the
  bundle becomes a problem (a fourth city, or raw JSON passing roughly 40 MB), the page already fetches
  by URL through `BundledWebSchemeHandler`, so moving a city to on-demand resources changes the shell,
  not the page.
- **Saved sets are city-agnostic and carry their curbs.** `serializeSegment` stores each saved curb with its
  geometry and `schedule`, and `getSegmentsForSavedSet` prefers those over the loaded inventory, so
  `buildNotificationJobs` makes jobs for another city's curbs while a different city is loaded, and
  `scheduleReminders` (which replaces all pending) receives every city's jobs together. That is the
  property to protect.

### What has to change

1. **Make curb ids and city rules registry-driven.** `getCurbIdCity` is `startsWith("mpls:") ? ... :
   "denver"`. An `sf:` id would read as Denver, and on a Denver page `hydrateSavedSet` would prune it from
   every set (and the account upload would carry the loss to the server). Give each city record an
   `idPrefix` (Denver's is the empty default), a `kind` (`"sweeping"` | `"snow"`) and an
   `inventoryFormat`, and look the city up from the id. The other `mpls:` assumptions are `lib/snow.js`
   (`MINNEAPOLIS_CURB_PREFIX`) and `PushRegistrar.swift` (its snow-watching test must
   keep ignoring `sf:`).
2. **Fix a bug that exists today, before SF depends on it.** `getRuleBasedSweepDates` reads
   `CITY_SWEEP_SEASON` from the **active** city. On a Minneapolis page the season is null (every month),
   so a Denver curb with a monthly rule is projected through December–March and those jobs are handed
   to the device; on an SF page the same would happen. The season must come from the segment's own city
   (`schedule.cityId`, or its id prefix). Add a test that a Denver curb projects no winter dates while
   another city is active.
3. **A third loader.** Beside `buildInventoryFromRouteMap` (Denver) and `buildSnowDataset` (Minneapolis)
   add `buildSfDataset(payload)` returning the same `{ streetWays, curbSegments }`. Dispatch on
   `inventoryFormat` instead of `IS_SNOW_CITY`, and turn the places that test `IS_SNOW_CITY` for "skip
   Denver's boot" into a property of the city record. SF skips Denver's built-in dataset and its coverage
   patches.
4. **How an SF rule becomes dates, and where it lives.** Move the pure date code
   (`getWeekOfMonth`, `getScheduleStatus`, `getReminderDate`, holidays) from `scripts/lib/sf-sweeping.js`
   into a UMD `public/sf-schedule.js` in the style of `curb-geometry.js`, and have the script `require` it,
   so the page and the build share one implementation (the tests already cover it). Then **store the
   curb's `schedules` on the segment (`schedule.sf`) and project at job time** through a per-city hook
   that `getUpcomingSweepDates` calls, rather than baking `allDates` into the saved set. Rules do not
   expire, so nothing goes stale in a saved set and reminders do not depend on reopening the SF page.
   The serialized curb is a few hundred bytes larger.
5. **Reminder planning for SF.** Per curb, by schedule type: `nightBefore` gets evening-before jobs only
   (three user-set slots, 6 pm and 8 pm on by default), a daytime schedule keeps Denver's model. Sets are per-set, so a set
   mixing both kinds produces jobs per curb from the same set times; the 6/8 pm defaults apply to
   overnight curbs. The iOS cap is the constraint: a weekly curb with two evening jobs is 16 jobs over the
   8-sweep horizon, and `ReminderScheduler` keeps 21 days and 60 jobs, soonest first, so a driver with
   many weekly curbs will hit it. Decide how many times per sweep a user may set before building the UI.
6. **Display.** Posted hours labelled as the sign's, overnight wording, `unconfirmed` and `holiday-skip`
   statuses, and the data's `generatedAt` date in the app. Colours are a Phase 3 question.
7. **Housekeeping the existing tests enforce.** `cities.js` gets the SF record with `inventoryUrl`
   `./sf-sweeping.json?v=1` and its own `?v=` moves with it; `index.html`/`sw.js` bump `CACHE_NAME`;
   `test/static-cache-version.test.js` must pass unmodified. City-by-location (`getCityForPoint`) has no
   overlap between the three bounding boxes. Memory is not a concern: one city is in memory at a time and
   SF has 22,556 curbs against Denver's 158,000 layers' worth, drawn viewport-culled.

### Order of work after Build 12 clears

1. Registry fields, id-to-city lookup, and the season fix (items 1–2). Benefits Minneapolis today and
   needs nothing from SF.
2. `public/sf-schedule.js` and the `buildSfDataset` loader behind a city record that is not yet in the
   switcher (items 3–4).
3. The reminder planner for overnight and daytime curbs (item 5), with tests for sets that span cities.
4. SF in the switcher with copy and display (item 6, Phase 3).

### Decisions (answered 2026-10-09)

- **Unconfirmed 5th-week days: remind, with hedged wording.** The reminder says the sweeping is not
  confirmed for that date, e.g. "Street sweeping may happen tomorrow (a 5th-week day). Check the sign, and
  move your car to be safe." The curb sheet and list say "May be swept (5th week; not confirmed)". Never
  "clear".
- **Holiday-skip days: remind with a double-check message, do not go silent.** Tickets fall about 95% on
  holidays, so sweeping is probably off, but the city's holiday list is read from tickets, not published
  data, and a quiet reminder that turns out wrong costs a ticket. The message: "Tomorrow is a holiday.
  Street sweeping is usually skipped, but double-check the posted sign before you leave your car." Streets
  with `holidays = 1` get the normal reminder. The curb sheet shows "Holiday: probably not swept; check
  the sign". (This reverses the earlier recommendation to suppress.)
- **Bundling, revised 2026-10-09 for "many more cities soon": bundle only the launch cities as a
  starting copy, and make every city downloadable and updatable without an app release.** Size is not the
  problem (ten cities is roughly 70 MB raw and well under the App Store's cellular limit once compressed).
  *Staleness* is: a bundled city only updates with an app release and Apple's review, SF's schedule changes
  "as needed" and Denver's routes change each season. Design: each city's file is hosted at a versioned
  URL with a small manifest listing the current version; the shell serves a downloaded copy from app
  storage when it has one, else the bundled copy (Denver, Minneapolis, SF), else downloads on first use.
  New cities are never bundled. Reminders are unaffected: they are saved on the device and scheduled
  locally, so only browsing the map of a city never opened needs a connection. The page already fetches
  inventories by URL and knows `HOSTED_APP_ORIGIN`, so the work is in the shell
  (`BundledWebSchemeHandler`) and a manifest, plus a first-use loading and failure state. This replaces the
  earlier "bundle all three" recommendation; Phase 2 item 7 and the Phase 4 refresh plan follow it.
- **Highlighting the uncertainty.** In the app, the word "May" in "May be swept" is set in an amber that is
  clearly distinct from the pink (no schedule) and plum (no move needed) curb states, and picked by
  CIELAB distance under simulated deuteranopia like the others; the same amber tints the 5th-week and
  holiday notices on the curb sheet and list, with the wording carrying the meaning so colour is never the
  only signal. A local notification cannot colour a word (iOS shows plain text), so the notification
  carries the hedge in its text and a leading marker instead (e.g. "⚠️ Sweeping may happen tomorrow ..."),
  which Denver's urgent alerts already do with 😱. The holiday alert gets its own marker (e.g. "🗓️
  Holiday tomorrow ...") so the two hedges are told apart on the lock screen. The Live Activity and in-app
  banners can use the amber.
- **Layout of the uncertain-day alerts (mockup agreed 2026-10-09; amber hex values are the mockup's
  placeholders, the real one is chosen by CIELAB distance when built).**
  - *One amber family for both states*, so uncertainty reads as one idea. The single hedge word is
    highlighted: **May** in the 5th-week alert, **probably** in the holiday alert. They are told apart by
    icon (warning triangle vs calendar) and wording, never by colour alone.
  - *Live Activity (lock screen):* title "Sweeping **may** happen tomorrow" with body "A 5th-week day. The
    schedule doesn't confirm it. Check the sign, and move your car to be safe." The holiday card reads
    "Holiday tomorrow: **probably** no sweeping" / "Sweeping is usually skipped on holidays. Double-check
    the posted sign before you leave your car." The 5th-week card's "I moved my car" button is the strong
    dark one; the holiday card's is the quiet gray one, since most drivers need not act.
  - *Notification text* is plain: a leading marker (warning / calendar emoji) and the same hedge wording.
  - *In-app banner:* amber tint and border, icon, the highlighted word in the title, one or two sentences,
    and a "Mark as moved" link. The 5th-week body is open to cutting the "tickets show it's sometimes
    swept" clause; the shorter version is equally safe.
  - *Curb list chips:* "**May** be swept" for 5th week and "Holiday: **probably** not" for holidays, with
    the posted hours and the overnight line ("Tue 2-6 am, move Mon night") beneath the street.
- **Reminder times per sweep: the same model as Denver.** Denver's settings are one evening-before time
  plus three sweep-day slots, with "keep reminding until I move" adding a later evening check-in and
  follow-ups. SF **daytime** blocks use exactly that, unchanged. SF **overnight** blocks have no sweep-day
  half, so the same three-slot control becomes three **evening-before** slots: 6 pm and 8 pm on by
  default, a third (10 pm) off by default, all user-set. That is the three reminders per sweep you asked
  for. Cost against the 60-job cap: 3 jobs per sweep, a weekly curb is about 9 jobs in the 21-day window,
  so a driver can hold roughly six weekly overnight curbs before the soonest-first cut-off starts
  dropping later jobs, which is no worse than Denver's.

## Phase 3: SF as a city record (design written 2026-10-09; code waits for Build 12 and Phase 2)

Design only; nothing in `public/` or `ios/` changes. Measured from the generated `public/sf-sweeping.json`
and the code in `public/cities.js` / `public/app.js`.

### Three gaps in the Phase 1 data that this phase needs closed first

These are changes to `scripts/` and the generated file, which are allowed now. **Gaps 1 and 2 were closed on
2026-10-09** (see HISTORY.md § SF build, "Sides and opposites"); the file is now 7.74 MB.

1. **Sides.** `sideKey` is the city's compass word: eight values (`north` ... `southwest`, 2,600 curbs on
   diagonal streets) and, for 424 curbs whose `blockside` is empty, just `l` or `r`. Denver's colours, side
   labels ("North curb") and `PARKING_SIDE_OPPOSITES` know four sides. Derive a four-way `sideKey` from the
   line and the L/R flag, as `getCompassSide` does for Minneapolis, and keep the city's word as
   `blockside` for the sheet.
2. **The opposite curb.** `getOppositeCurb` builds `"<way>:<opposite side>"` from a Denver id, and SF ids
   are hashes. The parked-car pin picks the street and the driver picks the side, so SF needs an explicit
   `opposite` id on each curb (the other L/R of the same `cnn`, when it exists), written by the build.
3. **House-number ranges (verify before relying on it).** The city's street centreline dataset ("Streets -
   Active and Retired") should carry the first and last house number on each side of each `cnn`
   (`lf_fadd`/`lf_toadd`/`rt_fadd`/`rt_toadd`). I have not queried it: Phase 1's network allowance named two
   datasets. If it holds, the build can write `addresses: [from, to]` per curb, which is both the address
   search (below) and the missing side check on tickets (ticket addresses have house numbers).

### The city record

`public/cities.js` gains an SF record shaped like Minneapolis's:

- `id: "san-francisco"`, `name`, `kind: "sweeping"`, `idPrefix: "sf:"`, `inventoryFormat` (Phase 2 item 1),
  `geocodeSuffix: "San Francisco, CA"`.
- `bounds` from the published curbs, padded a little: south 37.707, north 37.825, west -122.514, east
  -122.370. That includes Treasure Island and Yerba Buena; it excludes the Farallon Islands, which are in
  the county and not in the data. It overlaps neither Denver nor Minneapolis, so `getCityForPoint` works.
- `minZoom: 11` as the others; `sweepSeason: null` (year-round); `webReminders: false` and the shared
  `appStoreUrl`, as Denver (the map is free on the web; reminders are the app).
- `inventoryUrl: "./sf-sweeping.json?v=N"`, not in `APP_SHELL`; `cities.js`'s own `?v=` moves with it and
  keeps the `-inv<N>` ending the existing test requires.
- `cityLimitsGlobal: "SanFranciscoCityLimits"`, below.

### City limits

A UMD `public/sf-city-limits.js` in the shape of `minneapolis-city-limits.js` (OSM boundary relation,
simplified, `[lat, lon]`, 20 m `getMaskRings`). There is no pipeline half: the curbs are the city's own, so
nothing is clipped. The red wash tells a driver in Daly City the app has nothing there. Take the
land-and-Treasure-Island rings only, not the county's water or the Farallones.

### Address search

`findLocalSearchMatch` is Denver's grid and does not apply. Options:
- *Per-curb house-number ranges (preferred, if gap 3 holds):* a few hundred KB inside the inventory the
  page already loads. A typed "1234 Fulton St" places the pin on the right curb and side by parity and
  range, with no third-party geocoder and no privacy-manifest change. San Francisco's streets are named, so
  street search and crossings already work from curb names.
- *A bundled table of address points:* heavier, and I have not measured it; only if ranges prove unusable.
- *A server or third-party geocoder:* rejected; it changes the privacy story.
Where a number cannot be placed the search reports the street, as Denver's does.

### Colours and states

- Scheduled curbs take Denver's four side colours from the derived side, so the map reads the same in every
  city. **SF has no pink, plum or gray in v1:** a curb is in the city's schedule or it is not drawn.
- The "no mapped public street block may render blank" invariant cannot be enforced for SF: there is no
  expected-block manifest. A street with no curb is blank, and a tap near nothing says "No sweeping
  schedule found in the city's data for this street. Check the sign." (ticket tests found about 0.7% of
  tickets with no nearby curb).
- Uncertainty (5th week, holiday) is shown on the curb sheet, list and alerts as agreed above, **not on
  the map**; the map stays cheap and uncluttered.
- Idea, not v1: because SF publishes times, the map could highlight curbs swept in the next 24 hours.

### Reminders and copy

- Reminders follow the Phase 2 design (per-curb jobs, overnight evening-only, three slots).
- Denver's authority wording is source-text-tested; **do not template it.** SF-specific strings (the
  authority, the unavailable-curb message, the sheet lines) live on the SF record or in SF-only functions,
  and Denver's strings stay untouched. Lines like "That spot looks outside the Denver map" need an
  active-city form for SF.
- **Terms, Privacy and Disclaimer name San Francisco, say the app covers street sweeping only, and say the
  posted sign wins, in the same commit as the behaviour.** Support address unchanged.
- The Disclaimer must also say the schedule can differ from the sign on a given block.

### Subscription, analytics, store

- One subscription across cities (decided), so no StoreKit change; the paywall and App Store copy stop
  saying "Denver". Audit `Paywall.swift`, onboarding and the listing for city names.
- *Analytics:* events are a name, platform and version only. Adding a city field is a Privacy and
  privacy-manifest change. **Recommend not adding it for SF**; infer city mix from `app_open` once the
  switcher exists, or decide deliberately.
- App Store listing: new screenshots and description, and the multi-city note for Guideline 4.3 (Phase 4).

### Tests to write with it

City-by-location for the three bounds; `getCurbIdCity` for `sf:`; the SF record passes
`static-cache-version`; the four-way side and `opposite` pairing in the build; address-range placement
against known addresses; source-text tests that Denver's strings are unchanged.

### Decisions needed

- **Pair curbs and derive sides in the build** (recommended; needed before anything else here).
- **Confirm the street-centreline dataset's address ranges** (a network read of one dataset, which needs
  your go-ahead since Phase 1 named two).
- **City choice at first launch by location** (recommended, as AGENTS.md already says) with the header
  switcher as the manual override; at many cities the switcher becomes a searchable list, designed when
  the fourth city is real.
- **Whether to count cities in analytics** (recommend no).

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

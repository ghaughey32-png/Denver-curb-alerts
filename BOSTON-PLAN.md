# Boston expansion plan (draft, 2026-10-13)

Status: **proposal, not instructions.** Phase 0's join and Phase 1's build script exist as of 2026-10-26 (`npm run build:boston-sweeping -- --dry-run`, 90.4% of Odd/Even rows confident; see HISTORY.md § Boston Phase 0 and 1); nothing is in `public/`, `cities.js` or `ios/`. The research behind it is in
[HISTORY.md](HISTORY.md) § Boston research (2026-10-13); the spike scripts were scratchpad-only and
are not committed. Per AGENTS.md, nothing in `public/` or `ios/` changes while a TestFlight build is
waiting on App Review; Phases 0–1 live in `scripts/` and `data/` only. Boston follows San Francisco
in the queue ([SF-PLAN.md](SF-PLAN.md)) and shares its per-city loading work (SF Phases 2–3).

## What the data gives us (verified 2026-10-13)

Two public-domain (PDDL) files on data.boston.gov, both updated daily:

- **Street Sweeping Schedules** — `9fdbdcad-67c8-4b23-b6ec-861e77d56227`, a CSV (and CKAN datastore),
  **3,758 rows**. Per row: `main_id`, `st_name`, `from`/`to` (cross streets), `side`, `dist_name`,
  `start_time`/`end_time`, `week_1`…`week_5`, one flag per weekday, `every_day`, `year_round`,
  `miles`, `parent` (street code), `losta`/`hista`. **No geometry.** `side` is `Odd`/`Even` on 3,484
  rows, null on 198 (one-way, night and arterial rows), and one of ~20 other labels on the rest
  (`Even Side Median` 26, `Odd Side Median` 14, `Median`, `Both`, `Inbound`, `Ramp`, …).
- **Boston Street Segments (SAM)** — `boston-street-segments-sam-system`, **19,440 segments**, as
  GeoJSON (22 MB), CSV with `shape_wkt`, shapefile, and a live ArcGIS layer. Per segment:
  `SEGMENT_ID`, `ST_NAME`/`ST_TYPE`/`PRE_DIR`/`SUF_DIR`, and left/right house-number ranges
  (even-left, odd-right in the samples). **No key shared with the schedule.**

Differences from Denver that shape the plan: Boston publishes **times** (Denver never does), has
**sides and weeks** (like SF), a season that varies **by district**, and one clean download, so there
is no crawl and no coverage audit. The geometry has to be **joined**, which is the hard part.

The city's lookup, **notify.boston.gov/street-alerts**, is a front end over the same CSV: its variant
ids equal our `main_id`, it links to the dataset for download, and **all 31 rows we predicted matched
it exactly**, including its typos (`Cheslea St`) and odd times (`12:00-04:00`, `05:00-07:00`). It is
therefore **not an independent check on the data**, and its own address search is unreliable (see
Findings). It is free, email-only and reminds the day before.

## What we measured (spike, 2026-10-13)

Joining the 3,486 Odd/Even rows to the segments:

| Method | Result |
|---|---|
| Street name found among segments | 99.2% (28 rows miss: Edison Green, Harborview St, Joe L Smith Way) |
| Name + parity + address range | 69% of checkable rows at the right length |
| **+ shortest path between the two cross streets** | **86.1% of all Odd/Even rows within 0.8–1.25× the row's own `miles`** (96.3% when both cross streets resolve; 78% with "Dead End"/"Town Line"; 56% when `from` is unresolved) |
| No usable path | 7.0% |

Failure modes, all fixable: a cross street that names the street itself (`Summer St → Summer St`,
`Park Dr → Park Dr`) collapses to one segment; open-ended rows guess their end; streets split into
pieces that never connect (Commonwealth Ave, Blue Hill Ave, Columbus Ave: medians, service roads).
`losta`/`hista` is a **street-wide** span on 2,804 rows, so it cannot place a block by itself. The
length check (matched curb length against the row's own `miles`) is the only validation the data gives
us for free.

## Findings that shape the build

1. **A curb can carry several rules, and the city's own search hides some.** For 199 Commonwealth Ave
   the lookup returned only the two Thursday overnight "Median" rows and none of the Monday daytime
   rows for Arlington St–Massachusetts Ave. **Signs confirmed the Monday rows on both outer curbs**
   (Street View, Jun 2026: odd side *1st & 3rd Monday 8am–12noon Tow Zone* = row 560; even side *2nd &
   4th Monday 8am–12noon* = row 558). A block can also carry a sided row **and** a side-less night row
   (Columbus Ave, Stuart St–Clarendon St: Odd Friday 08:00–12:00 plus every day 00:01–07:00, year-round).
   **The app shows every row that covers a curb**, never the city page's single pick, and keeps the
   *follow the posted sign* line. Same stricter-wins posture as Minneapolis.
2. **"Median" rows are unexplained.** The city does not define `Odd/Even Side Median`. On Commonwealth
   Ave the median side is a bike lane or bus lane at four places we looked (Back Bay to Kenmore), with
   no parked cars; parking is on the outer curbs and on service lanes further west. Treat a `Median`
   row as its own labelled rule, never as the outer curb's. Open question, not a blocker.
3. **Commonwealth Ave has three curb kinds on one street** (outer curb, service lane, median) that
   segment data does not distinguish. It is the test street for Phase 1, with Blue Hill Ave (3-mile
   blocks) and Columbus Ave.
4. **Every-day rows are standing restrictions, not sweeps.** Rows with `every_day` and `year_round`
   (e.g. 00:01–07:00 on Back Bay arterials) are a nightly overnight rule. Show them on the curb sheet;
   **do not schedule a reminder for every night.** Reminders come from weekly and every-other-week rows.
5. **Fifth week is in the data.** The city's rule: weekly streets also clean in week 5; every-other-week
   streets usually do not, unless the sign lists it. `week_5` carries the exceptions (Appleton St:
   weeks 1,3,5). Use the flag as given and never infer a 5th week; no `week5Unconfirmed` needed.
6. **Season is per district.** Daytime sweeping runs Apr 1–Nov 30, except the North End, South End and
   Beacon Hill (Mar 1–Dec 31); night sweeping is year-round; a row with `year_round` ignores the season.
   Denver's `sweepSeason` is one per city, so this is new.
7. **Holidays cancel daytime sweeping; weather can cancel any.** Deferred; see [IDEAS.md](IDEAS.md).
8. **The data has errors.** `Cheslea St` is the city's own typo, and `12:00-04:00` ends before it
   starts. Normalise nothing silently; report such rows in the build output.

## Decisions to make before Phase 1

1. **Scope of v1: street sweeping only.** Boston snow emergencies are a later phase and need their own
   data: the mayor declares, and tow rules attach to **posted emergency arteries** (signs read *Tow Zone,
   Emergency Artery, No Parking During Snow Emergency*; seen on Commonwealth Ave). Unlike Minneapolis
   there is no Day 1/2/3 per curb. We have **not** found a dataset of those arteries; finding one is a
   Phase 0 task for that phase. Temporary no-parking permits, holidays and weather cancellations are in
   IDEAS.md.
2. **A source for the join's weak rows.** Either accept "check the sign" for the ~14% that miss, or ask
   the city whether a block-to-geometry key exists. The Street Work map is only permit points
   (`sam_id` is an address id), and `hasGeometry` in the lookup's API means a drawn line for the
   permit feature, not a sweeping layer. Recommend building without it and emailing
   `streetcleaning@boston.gov` in parallel (the address the city's page lists for errors). Needs the
   user's go-ahead before anything is sent.
3. **Pricing.** One subscription across cities (Apple ID-keyed), as in SF Plan decision 2.
4. **What the app is against Notify Boston.** The city's service is free and email-only, day-before.
   The app's case is push, user-set times, the moved-car nags and the map. Copy must not disparage it.
5. **The unmatched state.** Rows that fail the length check are not published as confident. Either reuse
   *First example of a second kind of case (2026-10-26):* Madeline St, Harriet St to Faneuil St, is placed correctly and
   has a schedule row (Tue 12–4), yet the author found **no street-cleaning sign on the block**, only a moving-permit
   Tow Zone notice. That is not "we could not place it", it is "the schedule says yes and the curb says nothing", and a
   driver should not be told either "sweeping Tuesday" or "all clear". It needs its own curb colour, separate from
   pink (no rule published) and gray (not maintained). Pick it by CIELAB distance under simulated deuteranopia, as the
   AGENTS.md colour rule says. Decide with the unmatched state, not separately.
   pink (*no rule published for this curb; check the sign* is close to its meaning) or add a state.
   `getCurbColor` is the one place that decides; pick by CIELAB distance, not by eye.

## Phase 0: finish the gaps (no code, ~1 day)

- **Diagnose the 620 zero-match rows** (real `losta`/`hista` outside every segment of that parity:
  Boylston St 2084–3940, Chelsea St 1323–3917, A St 3763–4307…). Segment ranges and schedule ranges
  may disagree, or numbering may change along the street.
- **Re-run the join after the three fixes** (self-referencing endpoints, plausibility check on open
  ends, joining same-name pieces within a few metres) and report the new in-band share. Target:
  **≥ 90%** before anything is published as confident.
- **Test against real tickets:** the 2018–Aug 2020 release (3.2M tickets) via WokeWindows is the only
  ticket data found. It is not current and may not carry a street-cleaning code or a location good
  enough to place; check before counting on it. Boston publishes no current open ticket dataset.
- **Look at the city's own address points** (the SAM address layer) for the address search pin, so the
  app does not depend on the lookup's search.
- **Hard-street list:** Commonwealth Ave, Blue Hill Ave, Columbus Ave, Washington St, Beacon St,
  Charles St, Summer St, and the `Park Dr` loops. Sign-check each from Street View (date the imagery).

## Phase 1: the build script (`scripts/`, offline, ~3–4 days)

Mirrors the SF build: `scripts/lib/boston-sweeping.js` (rules, pure) and `scripts/build-boston-sweeping.js`
(fetch, cache, write), `npm run build:boston-sweeping` with `--refresh` and `--dry-run`. Output
**`public/boston-sweeping.json`** (generated, never hand-edited); cache in
`data/boston-sweeping-cache/` (both source files, raw). The header of the lib documents the curb shape.

- **One curb per block side**, `{ id, street, sideKey, schedules[], addresses?, opposite?, geometry }`.
  `schedules` holds one entry per row that covers the curb: days, weeks, `start`/`end` (posted),
  season (`apr-nov`, `mar-dec` or `year-round`), `overnight`, `standing` (every-day rows), `median`,
  and the source `mainId`. A curb's rules are the **union** of every row that matches it.
- **Matching** (the spike's method, hardened): normalise names (suffix, direction, ordinals, `Saint`),
  resolve `from`/`to` to the street's own endpoints, shortest path between them, keep segments whose
  side has the row's parity; fall back to address range only where `losta`/`hista` is a real block range.
  Null-side and `Both` rows go on both sides; `Median`/`Ramp`/`Inbound` rows stay labelled and unmerged.
- **Sides and offset:** derive `sideKey` from the line direction and the left/right ranges, and offset
  each curb `CURB_OFFSET_METRES` toward its side, as SF does, so the two sides can be tapped apart.
- **Ids `bos:<hash>` must survive a refresh**, since saved curbs and phones are keyed on them; report
  retired ids.
- **Gates that refuse a bad build:** a row is published as confident only if its matched length is
  within **0.8–1.25×** its `miles`; the confident share may not fall below the recorded baseline
  (first target ≥ 90% of Odd/Even rows); curb count down more than 10% needs `ALLOW_COVERAGE_DROP=1`.
  The report lists every unpublished row with its reason, the city's typos, and times that end before
  they start.
- **Tests:** the join against a fixture of small streets, the union rule, the standing-row exclusion,
  the fifth-week flag, id stability, and the hard-street list as snapshot cases.

## Phase 2–3: loading and the city record (waits for the per-city work in SF Phases 2–3)

Boston reuses the on-demand per-city inventory loading and the header city switcher designed for SF; it
does not add its own. What is Boston-specific:

- A record in `public/cities.js` with `kind: "sweep"` and **per-district seasons** (new), bounds,
  `minZoom`, `inventoryUrl` (the `?v=` moves with the file) and `appStoreUrl` after launch.
- **Address search:** the map pin from the city's address points; the tap on a curb is what shows rules.
  A house number is never used to pick a block.
- **Curb sheet:** every rule that covers the curb, in the sign's own wording where possible
  (*Street Cleaning · 1st & 3rd Monday · 8am–12noon · Tow Zone*), standing night rules marked as
  standing, `Median` rows labelled, and the *follow the posted sign* line always present.
- **Reminders:** only from sweep rows. Posted times exist, so "N minutes before" becomes possible (not
  decided). Overnight sweeps follow SF's rule: evening-before reminders only. Skipping holidays is
  out of v1.
- **Copy and policy:** Terms, Privacy and Disclaimer name Boston sweeping and say signs win, in the
  same commit as the page. The privacy manifest does not change unless a new payload leaves the phone.

## Phase 4: ship (needs the user's go-ahead)

Same as SF: a TestFlight build with both products live, the paywall in place, the `appStoreUrl` and
copy committed together. Nothing here is started without the go-ahead.

## Risks

- **Match quality.** ~14% of rows may fall to "check the sign". Mitigation: the gates above and an
  honest unmatched state; never publish a guess as a rule.
- **Overlap hides rules.** The Commonwealth Ave case shows the city's page omitting a real tow rule.
  Mitigation: the union rule and the hard-street sign checks.
- **Stale schedule rows.** The Commonwealth rows are from 2012 and held through a Jun 2026 sign check,
  but any block may have changed. Mitigation: refresh on the open-data timestamp and the disclaimer.
- **Free competitor.** Notify Boston is free and official. Mitigation: differentiate on push, user-set
  times and the map; do not claim to replace the signs.
- **Median curbs.** Unexplained; may attract false taps on curbs nobody can park at. Mitigation: label,
  and ask the city.

## Not in v1

Holidays, weather cancellations and temporary no-parking permits ([IDEAS.md](IDEAS.md)); snow
emergencies (own phase, needs the artery data); anything that sends Apple push for sweeping.

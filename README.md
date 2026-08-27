# Denver Curb Alerts

This is a working Denver pilot for a parking-protection app that helps people avoid tickets by checking live street sweeping data, showing the relevant curb segments on a map, and saving side-of-street reminder plans.

## What this version does

- Proxies the live Denver street sweeping lookup from `https://www.denvergov.org/api/Streets/Sweeping?address=...`
- Parses the street geometry embedded in Denver's static map URL and draws each returned segment on an interactive map
- Shows left-side and right-side sweeping rules separately
- Includes a web app manifest and service worker so the app can be installed like an app once it is hosted on `https://`
- Includes device push subscription plumbing for a hosted web-push setup
- Supports scheduled-route reminder planning with a default cadence:
  - Day before at 6:00 PM
  - Day of at 7:00 AM
  - Day of at 9:00 AM
  - Day of at 11:00 AM
- Uses a real database automatically when `DATABASE_URL` is set, and falls back to local JSON files only for local development

## What this version does not do yet

- It does not send real iPhone push notifications until you host it on `https://`, add VAPID keys, and install dependencies
- It does not authenticate users
- It does not ingest every Denver street segment ahead of time for map-first browsing across the whole city
- It does not include snow removal yet

## Why the app is built this way

Denver's public street sweeping experience appears to be backed by these public endpoints and conventions:

- `https://www.denvergov.org/api/Streets/Sweeping?address=...`
- `https://www.denvergov.org/api/Streets/Sweeping/<routeId>`
- `https://www.denvergov.org/api/Streets/Sweeping/Notifications/...`

The pilot uses the city lookup directly instead of scraping page markup, which is more stable and gives us:

- `LeftSweepingRule`
- `RightSweepingRule`
- `LeftSweepDirection`
- `RightSweepDirection`
- `Schedules`
- route geometry hidden inside `StaticMapUrl`

## Run it

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Refresh the saved map inventory

The app opens with `public/denver-west-routes.json`, a saved copy of the official Denver routes for the mapped area, including East Alameda–East 7th Avenue Parkway from Lincoln to Colorado; East 8th–East 16th from Lincoln to Gaylord; East 8th–East 17th from York to Colorado; East 17th–East 26th from Downing to York; East 26th–East 37th from Gilpin to York; East 26th–East 37th from Josephine to Colorado; East 38th–East 45th from Blake to Colorado; I-70–East 54th from York to Colorado; East Dakota–East Yale from Broadway to Colorado; East Amherst–East Floyd from Franklin to Colorado; W Dartmouth–W Yale from Wadsworth to Federal; W Yale–W Florida from Sheridan to I-25; W Florida–W Ohio from Sheridan to I-25; W Florida–W Virginia from Jason to Bannock; W Exposition–W 5th from Sheridan to Federal; W Exposition–W Nevada from Federal to I-25; W Alameda (CO 26)–W 5th from Federal to I-25; W Alameda–W 6th from Lipan to Broadway; W 7th–W Colfax from Osage to Broadway; East 17th Avenue Parkway–I-70 from Colorado to Quebec; East 6th Avenue Parkway–East 17th Avenue Parkway from Colorado to Monaco; East Alameda–East 5th from Colorado to Monaco; East Dakota–East Evans from Colorado to Monaco; East Yale through East Evans from Colorado to Quebec; East Hampden through East Yale from Colorado to Quebec; East Hampden through East Yale from Quebec to I-225; East Yale through East Evans from Quebec to I-225; East Quincy through East Hampden from Colorado to I-225; East Belleview through East Quincy from Colorado to I-225; W Yale–W Florida from Jason to Broadway; East Alameda to East 6th from Monaco to Yosemite; East 6th to East Colfax from Monaco to Yosemite; East Evans–East Alameda from Monaco to I-225; East Alameda–East Colfax from Yosemite to I-225; East 17th–East 25th from Broadway to Ogden; W Colfax to East 25th from I-25 to Broadway; East 25th to East 37th from I-25 to Broadway; East 37th to East 45th from I-25 to Broadway; East 25th to East 37th from Broadway to Ogden; East 37th to East 45th from Broadway to Blake; East 26th to East 38th from Ogden to Gilpin; East 17th to East 26th from York to Colorado; East 37th to East 38th from Gilpin to Colorado; East Colfax to East Smith Road from Quebec to Boston; East Colfax to East 17th from Monaco to Quebec; East 8th to East 17th along Colorado Boulevard; the East Alameda infill from Colorado to Monaco; the East Alameda infill from Broadway to Colorado; the East Alameda infill from Lincoln to Colorado; and the existing West Denver and RiNo inventories. This avoids running hundreds of Denver lookups in each visitor's browser.

With the local server running, rebuild that snapshot using:

```bash
npm run build:inventory
```

Set `APP_ORIGIN` if the source server is not `http://127.0.0.1:3000`. The app keeps the saved inventory available offline and only runs a live full-area scan when explicitly requested.

### Coverage gate for every mapped area

Before adding or expanding an area, add each atomic public street block to `data/inventory-expected-blocks.json` using its road geometry. Mark alleys, private drives, pedestrian-only paths, and out-of-boundary roads with `"excluded": true` and an `exclusionReason`.

The inventory build now compares every declared block with Denver's returned route geometry. A block becomes either scheduled coverage or a conspicuous pink `dataUnavailable` route for manual verification; an invalid or otherwise unexplained public-road gap fails the build. The build writes the detailed result to `data/inventory-coverage-report.json`. Run the regression gate without contacting Denver using:

```bash
npm run audit:inventory
```

The durable publishing rule is: no mapped public street block may render blank. When starting a new neighborhood, obtain its road/block geometry first (for example from OpenStreetMap), add those blocks to the manifest, then run the builder.

### Mapping Approach #3 — Change 2

Map a newly imported area with the exhaustive staged discovery workflow:

```bash
npm run map:area -- area-id
```

Change 2 queries each unresolved public block progressively: midpoint, near both endpoints, interior points, nearby perpendicular offsets, and finally named intersection addresses. Each stage reruns the geometry audit and stops spending requests on blocks that have resolved. Successful Denver responses—including empty results—are cached in `data/mapping-cache-<area-id>.json`, so the first run is the slowest and later runs reuse prior work. The corresponding mapping report records per-stage query and resolution counts plus every automated check for blocks that still require human review.

### Staged gap review pilot

Candidate road gaps must not be published directly. Generate a private review queue from an OpenStreetMap Overpass JSON export with:

```bash
npm run build:review-queue -- path/to/overpass.json sloans-core-pilot
```

The pilot boundary is configured in `data/coverage-pilot-areas.json`. The command checks the saved inventory, retries each candidate at five block locations with throttling and backoff, and writes unresolved successful checks to `data/coverage-review-queue.json`. Failed Denver requests are kept separately as `retryPending`. The command never changes the public route inventory and never creates pink map sections.

## Turn it into an installable iPhone web app

The easiest beginner-friendly path is:

1. Put this project in GitHub.
2. Host it as a small Node web service on Render so it gets an `https://` URL.
3. Generate VAPID keys for web push.
4. Add those keys as environment variables in the hosting dashboard.
5. Open the hosted site on your iPhone in Safari.
6. Add it to the Home Screen.
7. Open it from the Home Screen and tap `Turn on push for this device`.

### 1. Generate web-push keys

Run this once in the project folder:

```bash
npx web-push generate-vapid-keys
```

Copy the three values into your hosting environment:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

You can use the `.env.example` file in this repo as a template.

### 2. Deploy it to Render

These are the simplest settings to use in Render:

- Service type: `Web Service`
- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`

Add these environment variables in Render:

- `HOST=0.0.0.0`
- `PORT=10000`
- `DATABASE_URL=...`
- `VAPID_PUBLIC_KEY=...`
- `VAPID_PRIVATE_KEY=...`
- `VAPID_SUBJECT=mailto:you@example.com`

Once deployed, Render will give you a public `https://` address.

### 2a. Add a small database

For a dependable hosted reminder system, create a Postgres database and copy its connection string into:

- `DATABASE_URL`

The app will then:

- keep push subscriptions in the database
- keep reminder plans in the database
- keep scheduled reminder jobs in the database
- automatically copy over any existing local JSON data the first time it starts with `DATABASE_URL`

### 3. Test on iPhone

On your iPhone:

1. Open the `https://` site in Safari.
2. Tap `Share`.
3. Tap `Add to Home Screen`.
4. Open the app from the Home Screen icon.
5. Tap `Turn on push for this device`.
6. Tap `Send test now`.

If the server keys are configured correctly, the app will save the device subscription and send the test push through the service worker path instead of the local preview path.

## Recommended next step for production

If we keep pushing this toward a real consumer app, the best next architecture is:

1. Keep the Denver lookup behind our own backend so we control caching, retries, and future city integrations.
2. Add user accounts so one person can manage multiple saved curb-side sets across devices.
3. Add service-worker web push for the PWA or move to a mobile app shell for more reliable notifications.
4. Add a background job that expands each saved schedule into concrete reminders and sends them through push, SMS, or email.
5. Add a city data ingestion job so users can browse the map first instead of starting from address lookup.

## Map choice note

This prototype uses Leaflet plus OpenStreetMap tiles to stay close to zero cost for the pilot. If you want branded styling, better geospatial tooling, or higher traffic capacity later, Mapbox is still a good swap-in option.

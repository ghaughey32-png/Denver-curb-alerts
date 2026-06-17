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

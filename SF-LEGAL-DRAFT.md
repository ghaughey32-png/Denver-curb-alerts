# San Francisco legal and page copy: draft for approval

Status: **approved by the author and applied 2026-10-26** (as drafted, including "Curb Alerts" without "Denver" in the headings and Minneapolis in the footer). Per AGENTS.md the Terms,
Privacy and Disclaimer must match what the app does in the same commit that turns San Francisco on, so
once you approve (or edit) this, I apply it and set `enabled: true` in one commit.

Every edit is before → after. Where the "before" is Denver-only wording that is wrong for a multi-city
app, the change is just making it city-neutral. Nothing changes the operator, the support address or the
subscription terms.

## Terms of use (`data-view="terms"`)

1. **Heading.** "Terms for Denver Curb Alerts" → "Terms for Curb Alerts".
2. **Cities paragraph** (today: "Curb Alerts also covers snow emergencies in Minneapolis: …"). →
   > Curb Alerts covers street sweeping in Denver and San Francisco, and snow emergencies in Minneapolis.
   > For Minneapolis, the map shows which side of each street the city bans parking on, on each day of a
   > declared snow emergency, and the iPhone app can alert you when one is declared. Everything below
   > applies to each city as it does to the others.
3. **Opening paragraph.** "Denver Curb Alerts is a reminder tool built to help drivers remember posted
   Denver street sweeping restrictions." →
   > Curb Alerts is a reminder tool built to help drivers remember posted street sweeping restrictions in
   > Denver and San Francisco.
   (the rest of the paragraph is unchanged)
4. **Your responsibility.** "…and official Denver rules always control…" → "…and official city rules
   always control…".
5. **New paragraph in "Your responsibility"** (San Francisco):
   > In San Francisco, street sweeping is enforced from the signs posted on each block, and the sign always
   > wins. Our San Francisco map follows the City and County of San Francisco's published schedule, which
   > can differ from the sign on a given block. The hours we show are the posted hours, not a promise of
   > when a sweeper will come, and a 5th-week day or a holiday may be swept or skipped contrary to what the
   > schedule says. Read the sign before you leave your car.
6. **What it costs.** "street sweeping reminders and Minneapolis snow emergency alerts need a
   subscription" → "street sweeping reminders and Minneapolis snow emergency alerts need a subscription,
   and one subscription covers every city".
7. **Coverage paragraph.** "Denver's published sweeping data is incomplete in places, the city changes
   schedules" → "Each city's published sweeping data is incomplete in places, cities change schedules".
8. **Date.** "Last updated October 1, 2026" → the day it ships.

## Privacy (`data-view="privacy"`)

1. **Heading.** "Privacy for Denver Curb Alerts" → "Privacy for Curb Alerts"; "Denver Curb Alerts is
   operated by Curb Alerts LLC" → "Curb Alerts is operated by Curb Alerts LLC".
2. **Location bullet:** unchanged. A first-launch city choice by location was drafted and then dropped (see
   HISTORY.md), so Privacy and the iOS permission text keep saying location is used only for Use my location
   and the parking pin.
3. **Services involved.** "street sweeping data published by the City and County of Denver, and snow
   emergency parking data published by the City of Minneapolis" → "street sweeping data published by the
   City and County of Denver and the City and County of San Francisco, and snow emergency parking data
   published by the City of Minneapolis". (Nothing new is contacted while you use the app: the San Francisco
   data is built into the app's own files, like Denver's.)

## Disclaimer (`data-view="disclaimer"`)

1. **Opening.** "Denver Curb Alerts is an informational reminder app. It is not legal advice, not an
   official City and County of Denver service, …" →
   > Curb Alerts is an informational reminder app. It is not legal advice, not an official service of the
   > City and County of Denver or the City and County of San Francisco, and not a guarantee that you will
   > avoid a parking ticket.
2. **New San Francisco paragraph** (after the Minneapolis one):
   > San Francisco street sweeping is enforced from the posted signs. Our San Francisco map is built from
   > the city's published schedule, which can differ from the sign on a given block, and it shows the
   > hours the schedule posts, not a promise about when a sweeper will come. A 5th-week day or a holiday
   > may be swept or skipped contrary to the schedule. The sign always controls.
3. **Date.** As above.

## Page chrome that names the city

- `<title>`: "Denver Curb Alerts | Street Sweeping Reminders" → "Curb Alerts | Street Sweeping Reminders".
- Meta description: "Avoid surprise Denver street sweeping tickets. …" → "Avoid surprise street sweeping
  tickets in Denver and San Francisco. Tap the curb where you park, see its next sweep date, and get a
  reminder before it happens."
- "Why Denver Curb Alerts helps" (aria-label) → "Why Curb Alerts helps".
- Footer: "Denver Curb Alerts is a reminder tool for Denver drivers, operated by Curb Alerts LLC." →
  "Curb Alerts is a reminder tool for drivers in Denver, San Francisco and Minneapolis, operated by Curb
  Alerts LLC." (the operator's name stays exactly as D&B holds it).
- The landing hero, loading text, map label and legend already switch to San Francisco's own wording from
  the city record when San Francisco is the active city; Denver's stays as written.

## Things to decide while you read

- **"Curb Alerts" without "Denver"** in the headings and title. The iPhone app is already named Curb Alerts;
  the website title is the only place still saying Denver Curb Alerts. Say if you want it kept.
- Whether to list **Minneapolis in the footer** (I included it, since the app covers it).
- The App Store listing, screenshots and review notes (Guideline 4.3 multi-city note) are Phase 4 and not
  drafted here.

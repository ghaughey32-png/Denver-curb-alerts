# Boston legal and page copy: draft for approval

Status: **approved as written and applied 2026-11-10; holiday sentences revised the same day (see the last section).** Per AGENTS.md the Terms, Privacy and Disclaimer must name a city in the same
commit that switches it on (`enabled: true` on its record in `public/cities.js`). Once you approve or edit
this, I apply it and flip `enabled` in one commit, as was done for San Francisco ([SF-LEGAL-DRAFT.md](SF-LEGAL-DRAFT.md)).
Boston stays off until then.

Every edit is before → after. Nothing changes the operator, the support address or the subscription terms.
The current wording is in `public/index.html` (`data-view="terms"`, `"privacy"`, `"disclaimer"`, the footer).

## What is true about Boston, so the copy matches it

- Rules come from the City of Boston's Public Works street sweeping schedule and the city's street segment
  layer, both on data.boston.gov. The schedule has **no geometry**; we place each row on the street blocks
  ourselves. A row we cannot place with confidence (about 8% of odd and even rows) **is not drawn**, so a
  block that looks quiet may simply be one we could not place.
- Sweeping runs April to November in most of the city and March to December in the North End, South End and
  Beacon Hill; overnight sweeping runs all year. Each rule carries its own season.
- Boston **skips daytime sweeping on city holidays and can cancel sweeping for weather**. The app does not
  know either, so it may remind you for a sweep that is not happening. That is deliberate (an extra reminder
  costs less than a ticket).
- A curb can carry several rules (a sweep and a nightly standing restriction, for example). The app shows
  every rule that covers a curb. Median rows are shown as their own rule, and a block where the schedule lists
  a rule but no sign was found when checked is drawn gold and dashed, with no reminder.
- The ticket is $40 for daytime street cleaning and $90 for overnight (and in Charlestown), per the city's
  own fine page. The app shows that only on the paywall; it never promises a ticket will or will not be issued.

## Terms of use (`data-view="terms"`)

1. **Cities paragraph.** "Curb Alerts covers street sweeping in Denver and San Francisco, and snow emergencies
   in Minneapolis." →
   > Curb Alerts covers street sweeping in Denver, San Francisco and Boston, and snow emergencies in
   > Minneapolis.
   (the Minneapolis sentences after it are unchanged)
2. **Opening paragraph.** "…posted street sweeping restrictions in Denver and San Francisco." → "…posted street
   sweeping restrictions in Denver, San Francisco and Boston."
3. **New paragraph in "Your responsibility"**, after the San Francisco one:
   > In Boston, street sweeping is enforced from the signs posted on each block, and the sign always wins. Our
   > Boston map follows the City of Boston's published schedule, which can differ from the sign on a given
   > block, and the city's schedule does not say where on the map each rule applies, so we place it ourselves
   > and may place it wrongly or leave a block out. The hours we show are the posted hours, not a promise of
   > when a sweeper will come. Boston skips daytime sweeping on city holidays and may cancel sweeping for
   > weather, and the app does not know when, so a reminder may arrive for a sweep that does not happen.
   > Read the sign before you leave your car.
4. **What it costs** and **Coverage** paragraphs: no change (they already say "each city" and "every city").
5. **Date.** "Last updated October 26, 2026" → the day it ships.

## Privacy (`data-view="privacy"`)

1. **Services involved.** "street sweeping data published by the City and County of Denver and the City and
   County of San Francisco, and snow emergency parking data published by the City of Minneapolis" → "street
   sweeping data published by the City and County of Denver, the City and County of San Francisco and the City
   of Boston, and snow emergency parking data published by the City of Minneapolis". (Nothing new is contacted
   while you use the app: the Boston data is built into the app's own files, like the others.)
2. **Date.** As above. No change to what is collected, stored or shared, and the privacy manifest is
   unchanged.

## Disclaimer (`data-view="disclaimer"`)

1. **Opening.** "…not an official service of the City and County of Denver or the City and County of San
   Francisco, and not a guarantee…" → "…not an official service of the City and County of Denver, the City and
   County of San Francisco or the City of Boston, and not a guarantee…".
2. **New Boston paragraph**, after the San Francisco one:
   > Boston street sweeping is enforced from the posted signs. Our Boston map is built from the city's
   > published schedule, which has no map of its own, so we place each rule on the street ourselves; a rule
   > may be placed on the wrong block or side, or left off the map. It shows the hours the schedule posts, not
   > a promise about when a sweeper will come, and Boston skips daytime sweeping on city holidays and may
   > cancel it for weather, which the app does not know. The sign always controls.
3. **Date.** As above.

## Page chrome that names the city

- Meta description: "Avoid surprise street sweeping tickets in Denver and San Francisco. …" → "Avoid surprise
  street sweeping tickets in Denver, San Francisco and Boston. Tap the curb where you park, see its next
  sweep date, and get a reminder before it happens."
- Footer: "Curb Alerts is a reminder tool for drivers in Denver, San Francisco and Minneapolis, operated by Curb
  Alerts LLC." → "…drivers in Denver, San Francisco, Boston and Minneapolis, operated by Curb Alerts LLC." (the
  operator's name stays exactly as D&B holds it).
- The landing hero, loading text, map label and legend already switch to Boston's own wording from the city
  record when Boston is the active city.

## Things to decide while you read

- **How much to say about the placing.** The Boston paragraphs tell the driver we place the rules ourselves.
  That is true and it is the honest reason a rule can be on the wrong block, but it is longer than SF's.
  Say if you want it shortened to "can differ from the sign".
- **Holidays and weather.** The copy says the app does not know about them. If you would rather model
  holidays before launch, that changes the third bullet above and the wording in 3.
- Still to do before switching Boston on (not legal copy): a city boundary line for the map, the App Store
  listing and review notes (Guideline 4.3 already covers multiple cities), and a TestFlight build.

## Revision, 2026-11-10: holidays are now modelled

After approval the app learned Boston's holidays from the city's own list (boston.gov/holidays). The two sentences
that said the app does not know about holidays were changed to match what it now does, in the same commit:

- **Terms**, Boston paragraph: "Boston skips daytime sweeping on city holidays and may cancel sweeping for weather,
  and the app does not know when, so a reminder may arrive for a sweep that does not happen." → "Boston cancels
  daytime sweeping on most city holidays, and the app follows the city's published holiday list, but the list can
  change and the city may also cancel sweeping for weather, which the app cannot know ahead of time, so a reminder
  may arrive for a sweep that does not happen."
- **Disclaimer**, Boston paragraph: "…and Boston skips daytime sweeping on city holidays and may cancel it for
  weather, which the app does not know." → "Boston cancels daytime sweeping on most city holidays, which the app follows
  from the city's published list, and may cancel it for weather, which the app cannot know ahead of time."

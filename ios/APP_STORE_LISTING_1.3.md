# App Store listing: version 1.3 (adds Boston)

DRAFT, written 2026-11-11 while 1.2 (build 15) is in review. Nothing here has been pasted into App Store
Connect. I could not see the current listing text, so each field below is a proposal to compare against what
is live; keep whatever the live text does better. Check every claim against the 1.3 build before pasting.
Character limits: subtitle 30, promotional text 170, keywords 100, What's New 4000, description 4000.

## App name

The store name is "Curb Alerts", matching the site title, the app's display name and the LLC. No change needed. (An earlier draft of this file wrongly assumed "Denver Curb Alerts" from AGENTS.md.)

## Subtitle (30)

    Street sweeping & snow alerts

(29 characters. Names the product, not a list of cities, so it stays true as cities are added.)

## Promotional text (170, editable without a new build)

    Never get a street sweeping ticket. Now in Boston, with Denver and San Francisco, plus snow-emergency alerts in Minneapolis. The map is free; reminders are a subscription.

(168 characters.)

## What's New in this version (1.3)

    Boston is here.

    • Boston street sweeping: tap the curb where you park and see the posted rules for that side of the street, including overnight sweeping and each neighborhood's season.
    • Reminders for Boston curbs, the same way as everywhere else: the evening before and the morning of, and they keep coming until you move your car.
    • Curbs where the city's schedule lists sweeping but no sign has been seen are marked, so you know to check the sign. Pink curbs are streets with no schedule found in the city's data.
    • The map now opens on the city you are in, centered on its own curbs.
    • Wording and legal pages updated to name Boston.

    Boston's sweeping is canceled on most city holidays and sometimes because of weather. We follow the city's holiday list but cannot know a weather cancellation ahead of time, so the sign and the city's announcement have the final word.

Notes: the last paragraph mirrors the Disclaimer; keep the two in step. "Most city holidays" is the rule in
AGENTS.md (daytime canceled on every holiday except Evacuation Day and Bunker Hill Day).

## Description (additions)

I could not read the live description. Add this paragraph where the cities are listed, and keep the existing
free-map / subscription wording unchanged:

    BOSTON
    Boston's street sweeping rules, drawn on each side of the street. Tap a curb for its posted days, weeks of the month and hours, including overnight sweeping. Seasons differ by neighborhood (the North End, South End and Beacon Hill run March to December; the rest of the city April to November), and each curb carries its own. Streets with no schedule in the city's data show in pink: check the sign.

Keep the existing sentence that the street sign always has the final word.

## Keywords (100)

Add `boston` and drop whatever the weakest current keyword is. Candidate set, 95 characters; swap in the
live words you want to keep:

    street sweeping,parking ticket,snow emergency,alternate side,boston,denver,san francisco,curb

Do not repeat the app name or the word "app"; Apple already indexes both.

## Screenshots

New ones are needed for Boston (the live set shows Denver). `marketing/screenshots` is untracked and may
already hold some; I have not looked. A Boston curb sheet and the gold dashed "no sign seen" curb are the
two that explain the product best.

## Privacy and "App privacy" answers

No change expected: Boston adds no new data collection, and location stays the driver's own tap. Confirm
that against the build before submitting (AGENTS.md: update the privacy manifest and answers if a new
payload leaves the phone).

## Review notes

Updated in [APP_REVIEW_NOTES.md](APP_REVIEW_NOTES.md): four cities for Guideline 4.3, a Boston section, and a
new "what is new" list. Unlike San Francisco and Minneapolis, **Boston is genuinely new in this version**
(they were already in 1.0), so the notes say so plainly.

# IDEAS.md

Parked product ideas — things worth doing that nothing is currently blocked on. This is a backlog,
not instructions: durable *rules* about the project still go in `AGENTS.md`, and this file must
never become a second source of truth for how to work on the repo.

It lives in the repo rather than in one tool's private memory for the same reason `AGENTS.md` does
(see **Working across Claude Code and Codex**) — an idea only Claude Code can see is an idea Codex
will re-derive from scratch.

---

## Guided first-run walkthrough

Noted 2026-09-21, from Resend's own onboarding: a short "how to add DNS records" video appeared in
the corner of the setup screen at exactly the moment it was needed, without being asked for.

**The case for it here is that this app has more explaining to do than it looks like it does.** The
map is six colours, and the difference between pink (*we found no Denver schedule, check with
Denver*) and plum (*swept on a schedule you never have to move for*) is the difference between
checking a city website and doing nothing at all. That distinction is currently learnable only by
tapping a curb and reading the sheet, or by finding the **How it works** tab — which is a tab
someone has to choose to visit, on a screen full of a map they came to look at.

The steps that most need it, in rough order of how often they go wrong:

- **Granting notification permission.** Everything the app exists for is downstream of this, and it
  is one system dialog that people dismiss reflexively. A refusal is close to unrecoverable in a
  browser and needs a trip to Settings in the iOS app.
- **The colour legend**, per the above.
- **The parking pin's side guess.** `findParkingCurbCandidates` picks the nearest curb and the sheet
  offers the opposite side as one tap, because a phone's fix (5–15 m) is wider than the ~8 m between
  the two curbs of a residential street. That one-tap correction *is* the product, and a driver who
  does not notice it is offered will trust a wrong side.

**The shape worth building is contextual, not a video.** A tooltip or coach-mark anchored to the
control in question, fired the first time someone reaches that state, is cheaper than a video and
does not need to be re-shot when the UI moves. It also avoids the thing that makes this awkward on
iOS: the app already ships a 12 MB inventory in its bundle, and a video asset is megabytes more for
something most people watch once. If a video is ever wanted, stream it rather than bundle it.

**What not to do:** a modal carousel on first launch, shown before the map has drawn. People open
this app because they are standing next to a parked car, and the answer they want is on the map
behind the modal.

Not started, and deliberately not scheduled — reminders and the remaining native work (geofencing,
APNs) are ahead of it.

---

## Boston extras: holidays, weather cancellations, temporary no-parking alerts

Noted 2026-10-13, from reading Boston's own Notify Boston page while feasibility-checking Boston as
the next city. **Look at these only after Boston street sweeping and Minneapolis snow emergency
alerts are done.** Boston's launch scope is the sweep schedule, per-district seasons and the
fifth-week flag; none of this is in it.

- **City holidays.** Boston cancels daytime sweeping on City-recognized holidays (nighttime
  continues). Reminders are scheduled ahead on the phone, so this is a dated list in the app, kept
  yearly from the city's own list. When unsure, remind: a missed reminder costs a ticket, one on a
  cancelled day only annoys. Probably cheap enough to pull into the launch if the list is easy.
- **Weather cancellations.** Announced day-of, so a phone cannot schedule around them. No
  machine-readable feed was found. If one exists, poll it like the Minneapolis notice poller and only
  email the author; if not, it is a person declaring it by hand each time. A cancellation push is a
  new kind of Apple push, so it needs the "is this part of what is sold" decision AGENTS.md reserves
  for when that kind exists.
- **Temporary no-parking alerts** (moving trucks, dumpsters, construction, events). The city
  publishes Active and Future street-occupancy permits as ArcGIS point layers, refreshed nightly
  (`Analytics_Street_Access_Awareness_*_Permits`, fields include `permit_start_date`,
  `permit_end_date`, `sam_id`, `sam_full_address`). That is a push the phone cannot schedule ahead,
  so it fits the one kind of Apple push we allow. New work: match points to saved curbs, a server
  poller, and Terms/Privacy copy. Signs go up about 48 hours before, so the lead time is short.

Notify Boston, the city's free service, is email-only and sends a day before; push, the moved-car
nags and the snow alerts are what the app adds.

---

## Paywall ticket-cost line

Noted 2026-10-26. `Paywall.swift` said "A Denver street sweeping ticket costs $50." Now a city-neutral
placeholder, "A street sweeping ticket can cost $50 to $200.", written so it stays true in Denver, SF and
Minneapolis. **Look at it again soon:** confirm each city's current sweeping fine from its own source
(SF's is not yet checked), and decide whether the paywall should name the city the driver is in. The
line beneath it (the daily cost) is unchanged. The paywall subtitle ("the evening before and the morning
of every sweep") is also Denver-shaped: an SF overnight curb has no morning reminder.

## Show where parking is not allowed at all

Noted 2026-10-26 from the Boston sign check ([BOSTON-SIGN-CHECK.md](BOSTON-SIGN-CHECK.md)). The sweeping
schedules (Boston's, and likely every city's) list a rule for both sides of a street and for every block,
including curbs where nobody may park: one side of Lyon St was all no-parking signs, the Roys St school
gate is *Tow Zone, No Stopping Any Time*, and East Lenox St turns no-parking further up. The map draws a
sweeping rule there anyway. It is not wrong advice, but it clutters the map and a driver may wonder why a
curb they cannot use has a rule. No city dataset says which curbs are no-parking (these are signs, not
schedule rows), so this would need either the city's regulatory data (Boston has a separate
no-parking / tow-zone sign inventory worth looking for) or crowd correction in the app. Look at it after
the sweeping data itself is trusted.

**Resident permit parking is the same family.** The Blackwood St pole (Back Bay) also carries *Back Bay, Permit
Parking Only* and a handicap-plate Tow Zone sign, rules the sweeping schedule knows nothing about; a driver
without a permit cannot park there at all. Boston's permit zones are a city dataset worth checking for. Time limits belong here too: the Gay Head St corner pole
(Centre St end) also carries *Parking 2 Hour Limit, Mon–Fri 8am–6pm*.

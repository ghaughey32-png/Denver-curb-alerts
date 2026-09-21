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

// Anonymous product analytics: how many people take each step from opening the app to paying.
//
// App Store Connect already reports the store half (impressions, page views, downloads) and the
// subscription half (trials, conversions, renewals, cancellations). What it cannot see is the path
// inside the app, and that is where people are lost: opened it, tapped a curb, tapped "Remind me",
// saw the plans, closed them. This counts those steps and nothing else.
//
// Counts only, deliberately. An event carries a name, a platform and an app version, and the server
// adds one to a daily total. No IP, no account, no device or install id is stored, so nothing here
// can be joined back to a person - which is what lets the App Store privacy answer say "not linked to
// you" and keeps this out of App Tracking Transparency altogether. If a funnel ever needs per-person
// sequences, that is a different, declared, consented thing, not an extension of this one.
//
// Pure, no I/O, like lib/accounts.js; server.js owns the storage and the flush.

const DENVER_TIME_ZONE = "America/Denver";

// The funnel, in order, then the purchases that end it. The page sends each at most once per session,
// so every count is a count of sessions. A name on neither list is refused, so a typo or a curious
// caller cannot grow the collection without bound. "Saw the plans and left" is not sent; it is the
// sessions that saw them less the ones that bought, which always adds up.
const FUNNEL_EVENTS = ["app_open", "curb_opened", "remind_tapped", "paywall_shown"];
const PAYWALL_OUTCOMES = ["trial_started", "subscription_started"];

const EVENT_NAMES = new Set([...FUNNEL_EVENTS, ...PAYWALL_OUTCOMES]);
const PLATFORMS = new Set(["ios", "web"]);

// "1.0 (9)" from the app, "web" from a browser. Anything else is folded to "unknown" rather than
// stored as sent: the version is a label for grouping, not free text.
function normalizeAppVersion(value) {
  const text = String(value || "").trim();
  if (text === "web") {
    return "web";
  }

  return /^\d+(\.\d+){0,2}( \(\d+\))?$/.test(text) ? text : "unknown";
}

// { event, platform, appVersion } ready to count, or null for anything that is not a known step.
function normalizeEvent(body) {
  const event = String(body?.event || "");
  if (!EVENT_NAMES.has(event)) {
    return null;
  }

  const platform = PLATFORMS.has(body?.platform) ? body.platform : "web";
  return { event, platform, appVersion: normalizeAppVersion(body?.appVersion) };
}

// The Denver calendar day, YYYY-MM-DD. The server runs in UTC, and a 9pm check-in belongs to the day
// the driver lived it, not to tomorrow.
function denverDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DENVER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function countKey(day, { event, platform, appVersion }) {
  return `${day}|${event}|${platform}|${appVersion}`;
}

// Stored rows plus a Map of pending increments, as rows. Rows are { day, event, platform,
// appVersion, count }; the pending map is keyed by countKey.
function mergeCounts(rows, pending) {
  const byKey = new Map(rows.map((row) => [countKey(row.day, row), { ...row }]));

  for (const [key, increment] of pending) {
    const existing = byKey.get(key);
    if (existing) {
      existing.count += increment;
    } else {
      const [day, event, platform, appVersion] = key.split("|");
      byKey.set(key, { day, event, platform, appVersion, count: increment });
    }
  }

  return [...byKey.values()].sort((a, b) => (a.day === b.day ? a.event.localeCompare(b.event) : a.day.localeCompare(b.day)));
}

// Totals over the rows given. Each funnel step carries its share of the step before it, and each
// outcome its share of the sessions that saw the plans. Those shares are where people are lost.
function summarizeFunnel(rows) {
  const totals = new Map([...EVENT_NAMES].map((event) => [event, 0]));
  for (const row of rows) {
    if (totals.has(row.event)) {
      totals.set(row.event, totals.get(row.event) + row.count);
    }
  }

  const share = (count, of) => (of > 0 ? count / of : null);
  const steps = FUNNEL_EVENTS.map((event, index) => ({
    event,
    count: totals.get(event),
    ofPrevious: index === 0 ? null : share(totals.get(event), totals.get(FUNNEL_EVENTS[index - 1]))
  }));
  const shown = totals.get("paywall_shown");
  const outcomes = PAYWALL_OUTCOMES.map((event) => ({ event, count: totals.get(event), ofShown: share(totals.get(event), shown) }));
  const bought = PAYWALL_OUTCOMES.reduce((sum, event) => sum + totals.get(event), 0);
  const left = Math.max(shown - bought, 0);
  outcomes.push({ event: "left_without_buying", count: left, ofShown: share(left, shown) });

  return { steps, outcomes };
}

module.exports = {
  FUNNEL_EVENTS,
  PAYWALL_OUTCOMES,
  normalizeEvent,
  normalizeAppVersion,
  denverDay,
  countKey,
  mergeCounts,
  summarizeFunnel
};

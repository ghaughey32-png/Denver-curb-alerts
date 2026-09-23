// Retiring the website's sweep reminders in favour of the iPhone app.
//
// Decided 2026-09-23: the website becomes map only when the iOS app goes live, so that the free
// website is not a way around the subscription. The switch is one value, `webRemindersEndAt` on the
// city's record in public/cities.js, read by both the page and this server so the two can never
// disagree about when reminders end. Null means reminders work exactly as they always have, which
// is what keeps develop releasable before launch day.
//
// Reminders never stop silently, and that holds for the website too: every device with reminders
// is told once when the end date is set, and once more when it arrives. Pure, no I/O, like
// lib/accounts.js, so the dispatcher's decisions can be tested without a push service.

const DENVER_TIME_ZONE = "America/Denver";

// { endsAt, ended } for a configured end, or null when the website's reminders are not retiring.
// An unparseable value is treated as not configured rather than as already ended: a typo in the
// city record must not switch off every web user's reminders.
function getWebReminderRetirement(endAtValue, now = new Date()) {
  if (!endAtValue) {
    return null;
  }

  const endsAt = new Date(endAtValue);
  if (Number.isNaN(endsAt.getTime())) {
    return null;
  }

  return { endsAt, ended: now.getTime() >= endsAt.getTime() };
}

function formatEndDay(endsAt) {
  return endsAt.toLocaleDateString("en-US", {
    timeZone: DENVER_TIME_ZONE,
    weekday: "long",
    month: "short",
    day: "numeric"
  });
}

function hasUpcomingJob(plan, now) {
  return (plan.jobs || []).some((job) => {
    const scheduledTime = new Date(job.scheduledAt).getTime();
    return !job.sentAt && Number.isFinite(scheduledTime) && scheduledTime > now.getTime();
  });
}

// The one notice this device is owed right now, if any: "reminders end on <day>" once the end date
// is set, and "reminders have stopped" once it arrives. `field` is what the dispatcher stamps on
// the plan after sending, so each is sent once. A device with no reminders coming is not written
// to about losing them, unless it was already warned - then it hears that they stopped.
function planRetirementNotice(plan, retirement, now = new Date()) {
  if (!retirement || !plan) {
    return null;
  }

  const upcoming = hasUpcomingJob(plan, now);

  if (!retirement.ended) {
    if (plan.webRetirementWarnedAt || !upcoming) {
      return null;
    }

    return {
      field: "webRetirementWarnedAt",
      payload: {
        title: "Sweep reminders are moving to the iPhone app",
        body: `Reminders from the Curb Alerts website end ${formatEndDay(retirement.endsAt)}. Get the Curb Alerts iPhone app to keep them.`,
        url: "/",
        tag: "web-reminders-ending"
      }
    };
  }

  if (plan.webRetirementEndedAt || (!plan.webRetirementWarnedAt && !upcoming)) {
    return null;
  }

  return {
    field: "webRetirementEndedAt",
    payload: {
      title: "Website sweep reminders have stopped",
      body: "Sweep reminders are in the Curb Alerts iPhone app now. The map and every curb's schedule stay free on the website.",
      url: "/",
      tag: "web-reminders-ended"
    }
  };
}

const WEB_REMINDERS_ENDED_MESSAGE = "Sweep reminders have moved to the Curb Alerts iPhone app. The map on this website is still free.";

module.exports = {
  getWebReminderRetirement,
  planRetirementNotice,
  formatEndDay,
  WEB_REMINDERS_ENDED_MESSAGE
};

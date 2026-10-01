// Snow emergencies: what to tell whom, and when, once a person has declared one.
//
// A snow emergency has no feed and no schedule: the city declares it a few hours before Day 1 and
// the parking rules then walk forward three days. A phone cannot schedule that ahead of time, which
// is what Apple push (lib/apns.js) is for. This module only decides; it never sends and never reads
// the clock itself. server.js owns the storage and the sending, in the shape of lib/events.js.
//
// Nothing here declares an emergency. A person confirms one (the admin route, or `npm run snow`)
// and this turns that declaration into a timeline of messages, each with an audience rule.
//
// A curb is `{ id, street, days: [day1, day2, day3] }` as public/minneapolis-snow.json publishes
// it, where 0 means you may not park that day.

const SNOW_TIME_ZONE = "America/Chicago";

// A message more than this long past its time is skipped rather than sent late. Telling a driver at
// 10 pm to move by 9 pm is worse than silence: they would have been ticketed already and would
// trust the next alert less. Two hours covers a server that was down across a tick or a deploy.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// When each message goes out, local time. The rules themselves (Day 1 bans at 9 pm, Days 2 and 3 at
// 8 am) are the city's and live on the city record as `snowRules`; test/snow-emergency.test.js holds
// these to it. Each warning leaves the driver time to walk to the car.
const DAY1_BAN_HOUR = 21;
const DAY2_3_BAN_HOUR = 8;
const SCHEDULE = {
  day1Evening: { dayOffset: 0, hour: 19, minute: 30 },
  day2Evening: { dayOffset: 0, hour: 20, minute: 0 },
  day2Morning: { dayOffset: 1, hour: 7, minute: 0 },
  day3Evening: { dayOffset: 1, hour: 20, minute: 0 },
  day3Morning: { dayOffset: 2, hour: 7, minute: 0 }
};

const SNOW_URL = "/?snow=1";
const MINNEAPOLIS_CURB_PREFIX = "mpls:";

function isDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// How far the zone's wall clock is ahead of UTC at an instant, in milliseconds.
function zoneOffsetMs(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  }).formatToParts(new Date(timestamp));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(timestamp / 1000) * 1000;
}

// The instant a wall-clock time falls on in the zone. The offset is taken at the guess and then
// again at the answer, so a time either side of a clock change lands on the right side of it.
function zonedInstant(dateText, hour, minute, timeZone = SNOW_TIME_ZONE) {
  const [year, month, day] = dateText.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

function localDateText(instant, timeZone = SNOW_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

// { "<curb id>": { street, days } }, as a Map, from the published inventory.
function buildCurbIndex(inventory) {
  const index = new Map();
  for (const curb of inventory?.curbs || []) {
    if (curb?.id && Array.isArray(curb.days)) {
      index.set(curb.id, { street: String(curb.street || ""), days: curb.days });
    }
  }
  return index;
}

// The messages a declaration produces, in time order. `declaredAt` is when the person confirmed it:
// the first message goes out then, whatever time of day that is, and the rest at their own times.
// Ones already well past when the declaration is made are not dropped here; dueMessages skips them
// as stale, so the timeline reads the same whenever it is asked for.
function buildTimeline({ day1Date, declaredAt }) {
  const at = (slot) => zonedInstant(addDays(day1Date, slot.dayOffset), slot.hour, slot.minute).toISOString();
  return [
    { id: "declared", day: 0, at: new Date(declaredAt).toISOString(), audience: "any" },
    { id: "day1-evening", day: 1, at: at(SCHEDULE.day1Evening), audience: "day1" },
    { id: "day2-evening", day: 2, at: at(SCHEDULE.day2Evening), audience: "day2" },
    { id: "day2-morning", day: 2, at: at(SCHEDULE.day2Morning), audience: "day2" },
    { id: "day3-evening", day: 3, at: at(SCHEDULE.day3Evening), audience: "day3" },
    { id: "day3-morning", day: 3, at: at(SCHEDULE.day3Morning), audience: "day3" }
  ].sort((left, right) => left.at.localeCompare(right.at));
}

// The messages of an active emergency that are due now: their time has come, they have not been
// sent, and they are not stale. Idempotent by construction, since `sentMessageIds` is what a send
// writes down before it goes.
function dueMessages(emergency, now = Date.now()) {
  if (!emergency || emergency.status !== "active") {
    return [];
  }

  const sent = new Set(emergency.sentMessageIds || []);
  return buildTimeline(emergency).filter((message) => {
    const age = now - new Date(message.at).getTime();
    return !sent.has(message.id) && age >= 0 && age <= STALE_AFTER_MS;
  });
}

// Which of a phone's watched curbs a message is about. "any" is every Minneapolis curb the phone
// watches, so a driver who only ever saved Denver streets hears nothing. The others are the curbs
// banned on that message's day. An id the inventory does not know is never matched to a day: a
// refresh that retired a curb must not turn into a false alarm.
function matchedCurbIds(message, watchedCurbIds, curbIndex) {
  const watched = (watchedCurbIds || []).filter((id) => String(id).startsWith(MINNEAPOLIS_CURB_PREFIX));
  if (message.audience === "any") {
    return watched;
  }

  const dayIndex = Number(message.audience.slice("day".length)) - 1;
  return watched.filter((id) => curbIndex.get(id)?.days?.[dayIndex] === 0);
}

function titleCaseStreet(street) {
  return String(street || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
    .replace(/\b(Ne|Nw|Se|Sw)\b/g, (direction) => direction.toUpperCase());
}

// The one street the matched curbs share, or "" when they span several (or none is known): a
// phone watching one matching curb is told its street, and a phone watching many is not sent a
// list that would not fit on a lock screen.
function singleStreet(matchedIds, curbIndex) {
  const streets = new Set(matchedIds.map((id) => titleCaseStreet(curbIndex.get(id)?.street)).filter(Boolean));
  return streets.size === 1 ? [...streets][0] : "";
}

// When each day's ban takes effect, as an instant: Day 1 at 9 pm on the day itself, Days 2 and 3 at
// 8 am on the following days.
function banInstant(day1Date, day) {
  return day === 1 ? zonedInstant(day1Date, DAY1_BAN_HOUR, 0) : zonedInstant(addDays(day1Date, day - 1), DAY2_3_BAN_HOUR, 0);
}

// "tonight", "tomorrow", or a weekday: how a driver says it, rather than a date or "Day 2".
function describeDeadline(instant, declaredAt) {
  const gap = (Date.parse(localDateText(instant)) - Date.parse(localDateText(declaredAt))) / (24 * 60 * 60 * 1000);
  const clock = zonedHourLabel(instant);
  if (gap <= 0) {
    return `${clock} ${clock.endsWith("pm") ? "tonight" : "this morning"}`;
  }
  if (gap === 1) {
    return `${clock} tomorrow`;
  }
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: SNOW_TIME_ZONE, weekday: "long" }).format(instant);
  return `${clock} ${weekday}`;
}

function zonedHourLabel(instant) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: SNOW_TIME_ZONE, hourCycle: "h23", hour: "numeric" }).format(instant));
  return `${hour % 12 || 12} ${hour >= 12 ? "pm" : "am"}`;
}

// The declaration, worded for one phone. Each curb it watches is banned from the first day its flags
// say 0; the message leads with the earliest deadline and the street(s) it is for, and says how many
// other curbs there are rather than listing them. A phone whose curbs carry no ban at all (or no
// curb data) gets the general notice: it was told because it watches a Minneapolis curb, so it should
// still hear that an emergency exists.
function composeDeclaration({ curbs, declaredAt, day1Date }) {
  const declared = declaredAt ? new Date(declaredAt) : new Date();
  const banned = (curbs || [])
    .map((curb) => {
      const dayIndex = (curb.days || []).indexOf(0);
      return dayIndex === -1 ? null : { street: titleCaseStreet(curb.street), day: dayIndex + 1 };
    })
    .filter(Boolean);

  if (!day1Date || banned.length === 0) {
    return {
      title: "Snow emergency declared in Minneapolis",
      body: "Parking rules are changing. Open Curb Alerts to see when your saved curbs need to be cleared."
    };
  }

  const earliest = Math.min(...banned.map((entry) => entry.day));
  const lead = banned.filter((entry) => entry.day === earliest);
  const streets = new Set(lead.map((entry) => entry.street).filter(Boolean));
  const where = streets.size === 1 ? [...streets][0] : "your saved curbs";
  const more = banned.length - lead.length;
  const tail = more > 0 ? ` ${more} more of your curbs ${more === 1 ? "is" : "are"} affected later; open the app.` : "";
  const ban = banInstant(day1Date, earliest);

  const body =
    declared >= ban
      ? `The parking ban is in effect now on ${where}. Move your car.${tail}`
      : `Move your car off ${where} by ${describeDeadline(ban, declared)}.${tail}`;
  return { title: "Snow emergency declared", body };
}

// Title and body for one phone. `message.at` against the ban hour is how the declaration copy knows
// whether Day 1 is still ahead. Wording is deliberately about the driver's curb and never claims a
// side of the street: the curb ids carry the side and the copy stays short and true.
function composeMessage(message, { street = "", declaredAt = null, day1Date = null, curbs = [] } = {}) {
  const where = street ? ` on ${street}` : "";
  const here = street || "your saved curb";

  switch (message.id) {
    case "declared":
      return composeDeclaration({ curbs, declaredAt, day1Date });
    case "day1-evening":
      return {
        title: "Move your car by 9 pm",
        body: `Snow emergency Day 1: no parking${where} from 9 pm until the street is fully plowed.`
      };
    case "day2-evening":
      return {
        title: "Move your car before 8 am",
        body: `Snow emergency Day 2 starts at 8 am tomorrow. Move your car off ${here} tonight.`
      };
    case "day2-morning":
      return {
        title: "Day 2: move your car by 8 am",
        body: `Snow emergency Day 2 starts at 8 am. ${street ? `${street} is` : "Your saved curb is"} banned until plowed.`
      };
    case "day3-evening":
      return {
        title: "Move your car before 8 am",
        body: `Snow emergency Day 3 starts at 8 am tomorrow. Move your car off ${here} tonight.`
      };
    case "day3-morning":
      return {
        title: "Day 3: move your car by 8 am",
        body: `Snow emergency Day 3 starts at 8 am. ${street ? `${street} is` : "Your saved curb is"} banned until plowed.`
      };
    case "cancelled":
      return {
        title: "Snow emergency cancelled",
        body: "The snow emergency in Minneapolis has been cancelled. You do not need to move your car."
      };
    default:
      throw new Error(`Unknown snow message ${JSON.stringify(message.id)}`);
  }
}

module.exports = {
  SNOW_TIME_ZONE,
  STALE_AFTER_MS,
  DAY1_BAN_HOUR,
  DAY2_3_BAN_HOUR,
  SNOW_URL,
  MINNEAPOLIS_CURB_PREFIX,
  isDateText,
  addDays,
  zonedInstant,
  localDateText,
  buildCurbIndex,
  buildTimeline,
  dueMessages,
  matchedCurbIds,
  singleStreet,
  composeMessage
};

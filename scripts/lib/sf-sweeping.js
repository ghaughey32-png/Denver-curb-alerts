// Turns San Francisco's published street sweeping schedule (Public Works, data.sf.gov dataset
// yhqp-riqs) into the curbs the app will draw. Pure: no network and no files, so every rule here can be
// tested against small made-up rows. The fetching, caching and writing live in
// scripts/build-sf-sweeping.js. See SF-PLAN.md and HISTORY.md, "San Francisco and Los Angeles
// research" and "SF Phase 0 ticket check".
//
// The city publishes one row per block side per weekday window, each with a LineString. Unlike
// Denver the rows carry posted hours, and unlike Minneapolis there is nothing to match to a
// centreline, so the work here is grouping and reading rules, not geometry.
//
// SHAPE OF A CURB (what public/sf-sweeping.json holds):
//
//   { id, street, sideKey, schedules, geometry }
//
// A block side (cnn + L/R) is one curb, because a driver parks on a side, not on a row. A side often
// has several windows (Monday 0-2 and Thursday 8-10), so the rules sit in `schedules`, one per
// distinct window, with every weekday that shares it:
//
//   { days, startHour, endHour, weeks, holidays, nightBefore, week5Unconfirmed, holidayOnly? }
//
//   days              weekday numbers, 0 = Sunday ... 6 = Saturday; empty only for holidayOnly
//   startHour/endHour the POSTED window, 0-24. Posted hours are the sign's, never our promise
//   weeks             which occurrence of the weekday in the month (the 1st Tuesday, the 2nd ...),
//                     not calendar weeks: ceil(day / 7) scored 95.2% against tickets, calendar
//                     weeks 77.6%
//   holidays          true when the street is swept on holidays too; false means holidays skip it
//   holidayOnly       true for the city's "Holiday" weekday rows: swept on holidays and not otherwise
//   nightBefore       the window starts before 5 am, so the car has to move the evening before the
//                     posted weekday ("Tuesday 0-2" is 12-2 am Tuesday, i.e. Monday night)
//   week5Unconfirmed  the data does not list a 5th occurrence (the 29th-31st), and the 5th-week flag
//                     is known to under-report. The app must never call such a day clear on the data
//                     alone. Where the flag is set, a 5th-week day is sweeping.
//
// Geometry is [lat, lng] pairs like Minneapolis's, seven decimals (six reclassifies Denver blocks).

const crypto = require("node:crypto");

const COORDINATE_DECIMALS = 7;
// A refreshed curb keeps its old id when a curb on the same street and side sits this close.
const ID_CONTINUITY_METRES = 15;
// A posted window that starts before this hour is swept in the small hours: move the car the night before.
const NIGHT_BEFORE_START_HOUR = 5;
// Tickets are written up to an hour outside the posted window; Phase 0 allowed this much slack.
const TICKET_HOUR_SLACK = 1;
// Tickets carry the address, which sits behind the curb: 100 m recovers all but 0.6% (HISTORY.md).
const NAMED_MATCH_METRES = 100;
const ANY_NAME_MATCH_METRES = 40;
const METRES_PER_DEGREE = 111320;
const ORIGIN_LATITUDE = 37.77;
const METRES_PER_DEGREE_LON = METRES_PER_DEGREE * Math.cos((ORIGIN_LATITUDE * Math.PI) / 180);
const GRID_DEGREES = 0.001;

const WEEKDAY_NUMBERS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

const STREET_SUFFIXES = {
  STREET: "ST",
  AVENUE: "AVE",
  BOULEVARD: "BLVD",
  DRIVE: "DR",
  ROAD: "RD",
  COURT: "CT",
  PLACE: "PL",
  LANE: "LN",
  TERRACE: "TER",
  HIGHWAY: "HWY",
  ALLEY: "ALY",
  CIRCLE: "CIR",
  PARKWAY: "PKWY",
  SQUARE: "SQ",
  PLAZA: "PLZ"
};

// Case, punctuation, ordinal zero-padding ("08th" is "8TH"), spelled-out suffixes and a leading house
// number are all differences between the city's corridor names and the addresses on tickets. "Lower
// Great Hwy" is the same street as tickets' "GREAT HWY".
function normalizeStreetKey(name) {
  const words = String(name || "")
    .toUpperCase()
    .replace(/[.,#']/g, "")
    .split(/\s+/)
    .filter(Boolean);
  // A house number is digits with at most one letter or a range; an ordinal ("8TH") is a street.
  if (words.length > 1 && /^\d+[A-Z]?(-\d+)?$/.test(words[0])) words.shift();
  while (words.length > 1 && (words[0] === "LOWER" || words[0] === "UPPER")) words.shift();
  return words.map((word) => word.replace(/^0+(?=\d+(ST|ND|RD|TH)$)/, "")).map((word) => STREET_SUFFIXES[word] || word).join(" ");
}

// A corridor as the app shows it: the city zero-pads ordinals ("08th Ave").
function formatStreetName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b0+(?=\d+(st|nd|rd|th)\b)/gi, "");
}

function readWeekday(text) {
  return WEEKDAY_NUMBERS[String(text || "").trim().toLowerCase()];
}

function readWeeks(row) {
  return [1, 2, 3, 4, 5].filter((week) => String(row[`week${week}`]) === "1");
}

// Parses one row of the city's table into a schedule, or null when it cannot be read. Hours are
// strings in the city's JSON; a window that ends before it starts would cross midnight, which the
// data does not use, so it is treated as unreadable rather than guessed at.
function readSchedule(row) {
  const startHour = Number(row.fromhour);
  const endHour = Number(row.tohour);
  const holidayOnly = String(row.weekday || "").trim().toLowerCase() === "holiday";
  const day = holidayOnly ? null : readWeekday(row.weekday);
  if (!holidayOnly && day === undefined) return null;
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour) || startHour < 0 || endHour > 24 || endHour <= startHour) return null;
  const weeks = readWeeks(row);
  if (!weeks.length) return null;
  const schedule = {
    days: holidayOnly ? [] : [day],
    startHour,
    endHour,
    weeks,
    holidays: String(row.holidays) === "1",
    nightBefore: startHour < NIGHT_BEFORE_START_HOUR,
    week5Unconfirmed: !weeks.includes(5)
  };
  if (holidayOnly) schedule.holidayOnly = true;
  return schedule;
}

function scheduleKey(schedule) {
  return [schedule.startHour, schedule.endHour, schedule.weeks.join(""), schedule.holidays ? 1 : 0, schedule.holidayOnly ? 1 : 0].join("|");
}

// Merges one block side's rows: rows with an identical window become one schedule listing all of
// their weekdays, so "Mon, Wed, Fri 8-10" is one entry rather than three.
function mergeSchedules(schedules) {
  const byKey = new Map();
  schedules.forEach((schedule) => {
    const key = scheduleKey(schedule);
    const existing = byKey.get(key);
    if (existing) {
      schedule.days.forEach((day) => {
        if (!existing.days.includes(day)) existing.days.push(day);
      });
    } else {
      byKey.set(key, { ...schedule, days: [...schedule.days] });
    }
  });
  const merged = [...byKey.values()];
  merged.forEach((schedule) => schedule.days.sort((a, b) => a - b));
  merged.sort((a, b) => (a.days[0] ?? 7) - (b.days[0] ?? 7) || a.startHour - b.startHour || a.endHour - b.endHour);
  return merged;
}

function readGeometry(line) {
  const coordinates = line?.type === "LineString" ? line.coordinates : null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const path = coordinates.map(([lon, lat]) => [Number(lat.toFixed(COORDINATE_DECIMALS)), Number(lon.toFixed(COORDINATE_DECIMALS))]);
  return path.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)) ? path : null;
}

function toXY([lat, lon]) {
  return [lon * METRES_PER_DEGREE_LON, lat * METRES_PER_DEGREE];
}

// The point half way along the line, which survives small edits to its vertices better than the
// middle vertex of a two-point line would.
function getMidpoint(geometry) {
  const points = geometry.map(toXY);
  const lengths = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    lengths.push(length);
    total += length;
  }
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const fraction = lengths[index] ? Math.min(1, remaining / lengths[index]) : 0;
      return [
        geometry[index][0] + (geometry[index + 1][0] - geometry[index][0]) * fraction,
        geometry[index][1] + (geometry[index + 1][1] - geometry[index][1]) * fraction
      ];
    }
    remaining -= lengths[index];
  }
  return geometry[0];
}

function buildCurbKey(cnn, side) {
  return `sf:${crypto.createHash("sha1").update(`${cnn}|${side}`).digest("hex").slice(0, 10)}`;
}

// Keeps a curb's id across a refresh, so saved curbs and the reminders built on them survive the city
// renumbering a centreline. A curb whose cnn and side are unchanged keeps its id outright; any other
// inherits the id of a previous curb on the same street and side within ID_CONTINUITY_METRES.
// Anything else gets a fresh id. Returns the retired ids so the build can report them.
function carryForwardIds(curbs, previousCurbs) {
  const previous = previousCurbs || [];
  const previousIds = new Set(previous.map((curb) => curb.id));
  const claimed = new Set();
  const assigned = new Array(curbs.length).fill(null);
  let carried = 0;

  curbs.forEach((curb, index) => {
    if (previousIds.has(curb.id) && !claimed.has(curb.id)) {
      claimed.add(curb.id);
      assigned[index] = curb.id;
      carried += 1;
    }
  });

  const previousByStreetSide = new Map();
  previous.forEach((curb) => {
    if (claimed.has(curb.id)) return;
    const key = `${curb.street}|${curb.sideKey}`;
    if (!previousByStreetSide.has(key)) previousByStreetSide.set(key, []);
    previousByStreetSide.get(key).push(curb);
  });
  curbs.forEach((curb, index) => {
    if (assigned[index]) return;
    const mid = toXY(getMidpoint(curb.geometry));
    let best = null;
    (previousByStreetSide.get(`${curb.street}|${curb.sideKey}`) || []).forEach((candidate) => {
      if (claimed.has(candidate.id)) return;
      const other = toXY(getMidpoint(candidate.geometry));
      const distance = Math.hypot(mid[0] - other[0], mid[1] - other[1]);
      if (distance <= ID_CONTINUITY_METRES && (!best || distance < best.distance)) best = { candidate, distance };
    });
    if (best) {
      claimed.add(best.candidate.id);
      assigned[index] = best.candidate.id;
      carried += 1;
    }
  });

  const used = new Set(assigned.filter(Boolean));
  const out = curbs.map((curb, index) => {
    let id = assigned[index];
    if (!id) {
      id = curb.id;
      let suffix = 2;
      while (used.has(id)) {
        id = `${curb.id}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
    }
    return { ...curb, id };
  });
  const retired = previous.filter((curb) => !claimed.has(curb.id)).map((curb) => curb.id);
  return { curbs: out, carried, retired };
}

// Groups the city's rows into curbs. `rows` are the dataset's JSON rows as published.
function buildSfCurbs({ rows, previousCurbs = [] }) {
  const report = { rows: rows.length, rowsWithoutLine: 0, rowsUnreadable: 0, rowsHolidayOnly: 0, curbs: 0 };
  const bySide = new Map();
  rows.forEach((row) => {
    const geometry = readGeometry(row.line);
    if (!geometry) {
      report.rowsWithoutLine += 1;
      return;
    }
    const schedule = readSchedule(row);
    if (!schedule || !row.cnn || !row.cnnrightleft) {
      report.rowsUnreadable += 1;
      return;
    }
    if (schedule.holidayOnly) report.rowsHolidayOnly += 1;
    const key = `${row.cnn}|${row.cnnrightleft}`;
    let curb = bySide.get(key);
    if (!curb) {
      curb = {
        id: buildCurbKey(row.cnn, row.cnnrightleft),
        street: formatStreetName(row.corridor),
        sideKey: String(row.blockside || row.cnnrightleft).trim().toLowerCase(),
        schedules: [],
        geometry
      };
      bySide.set(key, curb);
    }
    curb.schedules.push(schedule);
  });

  const built = [...bySide.values()].map((curb) => ({ ...curb, schedules: mergeSchedules(curb.schedules) }));
  built.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const continuity = carryForwardIds(built, previousCurbs);
  report.curbs = continuity.curbs.length;
  report.idsCarriedForward = continuity.carried;
  report.idsRetired = continuity.retired.length;
  report.retiredIds = continuity.retired;
  report.overnightCurbs = continuity.curbs.filter((curb) => curb.schedules.some((schedule) => schedule.nightBefore)).length;
  report.week5UnconfirmedCurbs = continuity.curbs.filter((curb) => curb.schedules.some((schedule) => schedule.week5Unconfirmed)).length;
  return { curbs: continuity.curbs, report };
}

// ---- Dates -------------------------------------------------------------------------------------
// Dates travel as "YYYY-MM-DD" strings: sweeping is a local-calendar fact, and Date's time zones
// would move the day under a phone that is not in San Francisco.

function parseDate(text) {
  const [year, month, day] = String(text).split("-").map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function formatDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

function addDays(text, count) {
  const { year, month, day } = parseDate(text);
  return formatDate(year, month, day + count);
}

// Which occurrence of its weekday a date is within its month: the 1st-7th are the 1st, the 8th-14th
// the 2nd, ... the 29th-31st the 5th. This is the city's rule, not the calendar week.
function getWeekOfMonth(text) {
  return Math.ceil(parseDate(text).day / 7);
}

function getNthWeekdayOfMonth(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return formatDate(year, month, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7);
}

function getLastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  return formatDate(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}

// The days the city's holiday rules apply to. The city's own list is not in the dataset, so this was
// read off tickets: street cleaning tickets in 2025 fall from about 2,000 a day to under 130 on each of
// the eleven federal holidays and on the day after Thanksgiving, and carry on as normal on Christmas
// Eve and the 26th. A holiday on a weekend moves to the nearest weekday (July 3, 2026 was quiet, 80
// tickets). The residue on holidays is the streets with holidays = 1. See HISTORY.md, "SF build".
function getSweepingHolidays(year) {
  const fixed = (month, day) => {
    const weekday = parseDate(formatDate(year, month, day)).weekday;
    return weekday === 6 ? formatDate(year, month, day - 1) : weekday === 0 ? formatDate(year, month, day + 1) : formatDate(year, month, day);
  };
  return [
    fixed(1, 1),
    getNthWeekdayOfMonth(year, 1, 1, 3),
    getNthWeekdayOfMonth(year, 2, 1, 3),
    getLastWeekdayOfMonth(year, 5, 1),
    fixed(6, 19),
    fixed(7, 4),
    getNthWeekdayOfMonth(year, 9, 1, 1),
    getNthWeekdayOfMonth(year, 10, 1, 2),
    fixed(11, 11),
    getNthWeekdayOfMonth(year, 11, 4, 4),
    addDays(getNthWeekdayOfMonth(year, 11, 4, 4), 1),
    fixed(12, 25)
  ];
}

// What a schedule says about a date:
//   "sweeps"       the data says the street is swept that day
//   "unconfirmed"  a 5th-week day the data does not list; never say it is clear
//   "holiday-skip" a holiday the street is not swept on; probable, not a promise
//   "none"         the data says no sweeping that day
function getScheduleStatus(schedule, text, holidays = []) {
  const { weekday } = parseDate(text);
  const isHoliday = holidays.includes(text);
  if (schedule.holidayOnly) return isHoliday ? "sweeps" : "none";
  if (!schedule.days.includes(weekday)) return "none";
  const week = getWeekOfMonth(text);
  if (week === 5 && schedule.week5Unconfirmed) return "unconfirmed";
  if (!schedule.weeks.includes(week)) return "none";
  if (isHoliday && !schedule.holidays) return "holiday-skip";
  return "sweeps";
}

// The date to remind the driver on. An overnight window is swept in the small hours of the posted
// day, so the car moves the evening before; a daytime window is reminded the evening before too, but
// its sweep-day reminders belong to the posted day (the app keeps Denver's model for those).
function getReminderDate(schedule, sweepDate) {
  return schedule.nightBefore ? addDays(sweepDate, -1) : sweepDate;
}

// Every date in a month a curb's schedules mention, with the status and the reminder date, for the
// page and the reminder planner to share one reading of the rules.
function getSweepDatesInMonth(curb, year, month, holidays = getSweepingHolidays(year)) {
  const results = [];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = formatDate(year, month, day);
    curb.schedules.forEach((schedule) => {
      const status = getScheduleStatus(schedule, date, holidays);
      if (status === "none") return;
      results.push({
        date,
        status,
        startHour: schedule.startHour,
        endHour: schedule.endHour,
        nightBefore: schedule.nightBefore,
        remindOn: getReminderDate(schedule, date)
      });
    });
  }
  return results;
}

// ---- Tickets -----------------------------------------------------------------------------------

function distanceToPath(point, geometry) {
  const [px, py] = toXY(point);
  const points = geometry.map(toXY);
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + dx * fraction), py - (ay + dy * fraction)));
  }
  return best;
}

function buildCurbGrid(curbs) {
  const cells = new Map();
  const margin = NAMED_MATCH_METRES / METRES_PER_DEGREE;
  curbs.forEach((curb, index) => {
    const lats = curb.geometry.map((point) => point[0]);
    const lons = curb.geometry.map((point) => point[1]);
    const rowFrom = Math.floor((Math.min(...lats) - margin) / GRID_DEGREES);
    const rowTo = Math.floor((Math.max(...lats) + margin) / GRID_DEGREES);
    const columnFrom = Math.floor((Math.min(...lons) - margin * 1.3) / GRID_DEGREES);
    const columnTo = Math.floor((Math.max(...lons) + margin * 1.3) / GRID_DEGREES);
    for (let row = rowFrom; row <= rowTo; row += 1) {
      for (let column = columnFrom; column <= columnTo; column += 1) {
        const key = `${row},${column}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(index);
      }
    }
  });
  return cells;
}

// "2026-07-04T13:15:00.000" is local San Francisco time as published; nothing is converted.
function readTicketMoment(ticket) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(ticket.citation_issued_datetime || ""));
  if (!match) return null;
  return { date: match[1], hour: Number(match[2]) + Number(match[3]) / 60 };
}

function scheduleExplainsTicket(schedule, moment) {
  if (schedule.holidayOnly) return false;
  const { weekday } = parseDate(moment.date);
  if (!schedule.days.includes(weekday)) return false;
  if (!schedule.weeks.includes(getWeekOfMonth(moment.date))) return false;
  return moment.hour >= schedule.startHour - TICKET_HOUR_SLACK && moment.hour <= schedule.endHour + TICKET_HOUR_SLACK;
}

// Checks the curbs against tickets the city actually wrote. A ticket is consistent when a curb near
// it runs on the ticket's weekday and week of the month with the time inside the posted window plus an
// hour. "Near" is the same street name within 100 m, else any name within 40 m (tickets carry the
// address, which sits behind the curb, and some names differ by suffix). Fifth-week tickets are
// judged by the data as published, so the known under-reporting of that flag shows up in the
// numbers, reported apart. `contradicted` is the share of tickets with a candidate that none explains.
function checkAgainstTickets(curbs, tickets) {
  const grid = buildCurbGrid(curbs);
  const keys = curbs.map((curb) => normalizeStreetKey(curb.street));
  const empty = () => ({ tickets: 0, consistent: 0, contradicted: 0 });
  const result = {
    tickets: 0,
    unreadable: 0,
    noCandidate: 0,
    consistent: 0,
    contradicted: 0,
    daytime: empty(),
    overnight: empty(),
    fifthWeek: empty()
  };
  tickets.forEach((ticket) => {
    const moment = readTicketMoment(ticket);
    const lat = Number(ticket.latitude);
    const lon = Number(ticket.longitude);
    if (!moment || !Number.isFinite(lat) || !Number.isFinite(lon) || !ticket.latitude) {
      result.unreadable += 1;
      return;
    }
    result.tickets += 1;
    const ticketKey = normalizeStreetKey(ticket.citation_location);
    const point = [lat, lon];
    const named = [];
    const other = [];
    (grid.get(`${Math.floor(lat / GRID_DEGREES)},${Math.floor(lon / GRID_DEGREES)}`) || []).forEach((index) => {
      const distance = distanceToPath(point, curbs[index].geometry);
      if (distance <= NAMED_MATCH_METRES && keys[index] === ticketKey) named.push({ index, distance });
      else if (distance <= ANY_NAME_MATCH_METRES) other.push({ index, distance });
    });
    const candidates = named.length ? named : other;
    if (!candidates.length) {
      result.noCandidate += 1;
      return;
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const consistent = candidates.some(({ index }) => curbs[index].schedules.some((schedule) => scheduleExplainsTicket(schedule, moment)));
    // The nearest curb that is posted on the ticket's weekday names the kind of block; failing that,
    // the nearest curb of any kind.
    const { weekday } = parseDate(moment.date);
    const onWeekday = candidates.find(({ index }) => curbs[index].schedules.some((schedule) => schedule.days.includes(weekday)));
    const typed = curbs[(onWeekday || candidates[0]).index];
    const relevant = typed.schedules.filter((schedule) => schedule.days.includes(weekday));
    const overnight = (relevant.length ? relevant : typed.schedules).some((schedule) => schedule.nightBefore);

    const buckets = [overnight ? result.overnight : result.daytime];
    if (getWeekOfMonth(moment.date) === 5) buckets.push(result.fifthWeek);
    buckets.push(result);
    buckets.forEach((bucket) => {
      if (bucket !== result) bucket.tickets += 1;
      if (consistent) bucket.consistent += 1;
      else bucket.contradicted += 1;
    });
  });
  result.matched = result.consistent + result.contradicted;
  return result;
}

module.exports = {
  NIGHT_BEFORE_START_HOUR,
  ID_CONTINUITY_METRES,
  normalizeStreetKey,
  formatStreetName,
  readSchedule,
  mergeSchedules,
  readGeometry,
  getMidpoint,
  carryForwardIds,
  buildSfCurbs,
  getWeekOfMonth,
  getSweepingHolidays,
  getScheduleStatus,
  getReminderDate,
  getSweepDatesInMonth,
  addDays,
  checkAgainstTickets
};

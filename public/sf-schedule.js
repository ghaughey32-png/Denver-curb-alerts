(function attachSfSchedule(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.SfSchedule = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSfSchedule() {
  // How San Francisco's sweeping rules become dates. It lives in public/ so the page and the build
  // script (scripts/lib/sf-sweeping.js, which requires this file) share one reading of a schedule:
  // the curb file carries rules, not dates, and rules never expire, so a saved curb projects its own
  // reminders at job time instead of freezing a list of dates that goes stale.
  //
  // Dates travel as "YYYY-MM-DD" strings: sweeping is a local-calendar fact, and Date's time zones
  // would move the day under a phone that is not in San Francisco. A schedule is the shape documented
  // at the top of scripts/lib/sf-sweeping.js.
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

  // The next sweeps a curb's schedules produce on or after a date, soonest first, at most `count`.
  // "none" days are dropped; "unconfirmed" (a 5th-week day the data does not list) and "holiday-skip"
  // stay, because a reminder for a street that turns out clear only annoys, while a missing one
  // costs a ticket. Each entry keeps its status so the page can say which it is. Months are walked
  // until enough turn up, up to a year, so a curb that is swept once a month still fills the list.
  function getUpcomingSweeps(curb, fromDate, count = 8) {
    const schedules = Array.isArray(curb?.schedules) ? curb.schedules : [];
    if (!schedules.length) return [];

    const start = parseDate(fromDate);
    const found = [];
    for (let offset = 0; offset < 13 && found.length < count; offset += 1) {
      const monthIndex = start.month - 1 + offset;
      const year = start.year + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      getSweepDatesInMonth({ schedules }, year, month)
        .filter((entry) => entry.date >= fromDate)
        .forEach((entry) => found.push(entry));
    }

    found.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startHour - b.startHour));
    return found.slice(0, count);
  }

  return {
    getUpcomingSweeps,
    parseDate,
    formatDate,
    addDays,
    getWeekOfMonth,
    getSweepingHolidays,
    getScheduleStatus,
    getReminderDate,
    getSweepDatesInMonth
  };
});

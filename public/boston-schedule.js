(function attachBostonSchedule(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.BostonSchedule = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function buildBostonSchedule() {
  // How Boston's sweeping rules become dates, the way public/sf-schedule.js does for San Francisco: the
  // curb file carries rules, not dates, so a saved curb projects its own reminders when they are planned.
  // A rule is the shape documented at the top of scripts/lib/boston-sweeping.js:
  //   { days, weeks, start, end, season, nightBefore, standing }
  //
  // Differences from San Francisco, all from the city's data:
  //   - The city lists the weeks of the month it sweeps, 5th week included, so a week is used as given
  //     and a 5th week is never inferred or hedged.
  //   - Daytime sweeping has a season: "apr-nov", or "mar-dec" for the North End, South End and Beacon
  //     Hill. "year-round" (night sweeping) ignores it. Outside the season the next sweep is next
  //     spring's.
  //   - A `standing` rule is a nightly restriction, not a sweep, and never produces a date.
  //   - Holidays. The city's holiday page (boston.gov/holidays) says "Daytime street cleaning is canceled,
  //     but overnight street cleaning is on a normal schedule" on every city holiday except Evacuation Day
  //     (March 17) and Bunker Hill Day (June 17), which run normally. A daytime rule on such a day is
  //     "holiday-skip": still listed, so the planner can remind with the double-check wording, because the
  //     list can change and a missed reminder costs more than an extra one. Overnight rules are unaffected.
  //     Weather cancellations are announced on the day and cannot be known ahead.
  //
  // Dates travel as "YYYY-MM-DD" strings: sweeping is a local-calendar fact, and Date's time zones would
  // move the day under a phone that is not in Boston.
  const SEASON_MONTHS = {
    "apr-nov": [4, 11],
    "mar-dec": [3, 12]
  };

  function parseDate(text) {
    const [year, month, day] = String(text).split("-").map(Number);
    return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
  }

  function formatDate(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  }

  function addDays(text, count) {
    const { year, month, day } = parseDate(text);
    return formatDate(year, month, day + count);
  }

  // Which occurrence of its weekday a date is within its month: the 1st-7th are the 1st, ... the
  // 29th-31st the 5th. That is how a sign's "1st & 3rd Monday" counts.
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

  // The days daytime sweeping is canceled for a city holiday. Dates and ordinals were checked against the
  // city's own 2026 and 2027 holiday listing (every one matched). A holiday that falls on a weekend is
  // observed on the nearest weekday, the Saturday ones on the Friday and the Sunday ones on the Monday,
  // as the city's 2027 listing shows (Juneteenth Fri June 18, Independence Day Mon July 5, Christmas Fri
  // December 24). Evacuation Day and Bunker Hill Day are not here: the city runs them normally.
  function getDaytimeCancelledHolidays(year) {
    const fixed = (month, day) => {
      const weekday = parseDate(formatDate(year, month, day)).weekday;
      return weekday === 6 ? formatDate(year, month, day - 1) : weekday === 0 ? formatDate(year, month, day + 1) : formatDate(year, month, day);
    };
    return [
      fixed(1, 1),
      getNthWeekdayOfMonth(year, 1, 1, 3),
      getNthWeekdayOfMonth(year, 2, 1, 3),
      getNthWeekdayOfMonth(year, 4, 1, 3),
      getLastWeekdayOfMonth(year, 5, 1),
      fixed(6, 19),
      fixed(7, 4),
      getNthWeekdayOfMonth(year, 9, 1, 1),
      getNthWeekdayOfMonth(year, 10, 1, 2),
      fixed(11, 11),
      getNthWeekdayOfMonth(year, 11, 4, 4),
      fixed(12, 25)
    ];
  }

  // What a rule says about a date: "sweeps", "holiday-skip" (a daytime rule on a day the city cancels
  // daytime sweeping), or "none".
  function getScheduleStatus(schedule, text, holidays = getDaytimeCancelledHolidays(parseDate(text).year)) {
    if (!sweepsOn(schedule, text)) return "none";
    return !schedule.nightBefore && holidays.includes(text) ? "holiday-skip" : "sweeps";
  }

  function readHour(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    return match ? Number(match[1]) + Number(match[2]) / 60 : 0;
  }

  function isInSeason(schedule, month) {
    const range = SEASON_MONTHS[schedule.season];
    return !range || (month >= range[0] && month <= range[1]);
  }

  // Whether a rule sweeps on a date.
  function sweepsOn(schedule, text) {
    if (schedule.standing) return false;
    const { month, weekday } = parseDate(text);
    return schedule.days.includes(weekday) && schedule.weeks.includes(getWeekOfMonth(text)) && isInSeason(schedule, month);
  }

  // An overnight window is swept in the small hours of the posted day, so the car moves the evening before.
  function getReminderDate(schedule, sweepDate) {
    return schedule.nightBefore ? addDays(sweepDate, -1) : sweepDate;
  }

  function getSweepDatesInMonth(curb, year, month, holidays = getDaytimeCancelledHolidays(year)) {
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
          startHour: readHour(schedule.start),
          endHour: readHour(schedule.end),
          nightBefore: Boolean(schedule.nightBefore),
          remindOn: getReminderDate(schedule, date)
        });
      });
    }
    return results;
  }

  // The next sweeps on or after a date, soonest first, at most `count`. Months are walked until enough
  // turn up, up to a year, so a curb swept once a month, or one waiting out the winter, still answers.
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
    isInSeason,
    sweepsOn,
    getDaytimeCancelledHolidays,
    getScheduleStatus,
    getReminderDate,
    getSweepDatesInMonth
  };
});

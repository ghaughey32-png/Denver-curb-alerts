const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeStreetKey,
  formatStreetName,
  readSchedule,
  buildSfCurbs,
  carryForwardIds,
  getWeekOfMonth,
  getSideKey,
  offsetPath,
  CURB_OFFSET_METRES,
  getSweepingHolidays,
  getScheduleStatus,
  getReminderDate,
  getSweepDatesInMonth,
  checkAgainstTickets
} = require("../scripts/lib/sf-sweeping.js");

function row(overrides = {}) {
  return {
    cnn: "1001",
    corridor: "Market St",
    limits: "Larkin St - Polk St",
    cnnrightleft: "L",
    blockside: "SouthEast",
    weekday: "Tues",
    fromhour: "8",
    tohour: "10",
    week1: "1",
    week2: "1",
    week3: "1",
    week4: "1",
    week5: "1",
    holidays: "0",
    line: { type: "LineString", coordinates: [[-122.4163, 37.7775], [-122.4174, 37.7766]] },
    ...overrides
  };
}

const SECOND_AND_FOURTH = { week1: "0", week2: "1", week3: "0", week4: "1", week5: "0" };

test("street names normalize across the city's corridors and ticket addresses", () => {
  assert.equal(normalizeStreetKey("08th Ave"), "8TH AVE");
  assert.equal(normalizeStreetKey("1110 VAN NESS AVE"), "VAN NESS AVE");
  assert.equal(normalizeStreetKey("123A Market Street"), "MARKET ST");
  assert.equal(normalizeStreetKey("1500-1520 Mission St."), "MISSION ST");
  assert.equal(normalizeStreetKey("Lower Great Hwy"), "GREAT HWY");
  // An ordinal is a street, not a house number.
  assert.equal(normalizeStreetKey("1st St"), "1ST ST");
  assert.equal(formatStreetName("08th  Ave"), "8th Ave");
});

test("the week of the month is the nth occurrence of the weekday, not the calendar week", () => {
  assert.equal(getWeekOfMonth("2026-10-01"), 1);
  assert.equal(getWeekOfMonth("2026-10-07"), 1);
  assert.equal(getWeekOfMonth("2026-10-08"), 2);
  assert.equal(getWeekOfMonth("2026-10-28"), 4);
  assert.equal(getWeekOfMonth("2026-10-29"), 5);
  assert.equal(getWeekOfMonth("2026-10-31"), 5);
  // February of a common year ends on the 28th, the 4th occurrence.
  assert.equal(getWeekOfMonth("2027-02-28"), 4);
});

test("a schedule projects onto the right dates at month boundaries and in five-week months", () => {
  const second = readSchedule(row({ ...SECOND_AND_FOURTH }));
  // October 2026 has five Thursdays and five Fridays; the 2nd and 4th Tuesdays are the 13th and 27th.
  const october = getSweepDatesInMonth({ schedules: [second] }, 2026, 10, []);
  assert.deepEqual(october.map((entry) => entry.date), ["2026-10-13", "2026-10-27"]);
  // The 1st of a month that begins on a Tuesday is the 1st occurrence, not swept on a 2nd/4th pattern.
  assert.equal(getScheduleStatus(second, "2026-09-01", []), "none");
  assert.equal(getScheduleStatus(second, "2026-09-08", []), "sweeps");
  assert.equal(getScheduleStatus(second, "2026-09-29", []), "unconfirmed");
  // Every week, including the 5th, is swept without a marker.
  const weekly = readSchedule(row());
  assert.equal(getScheduleStatus(weekly, "2026-09-29", []), "sweeps");
  assert.equal(weekly.week5Unconfirmed, false);
  // A weekday the schedule does not name is never swept.
  assert.equal(getScheduleStatus(weekly, "2026-09-30", []), "none");
  // Leap day.
  assert.equal(getScheduleStatus(readSchedule(row({ weekday: "Thu" })), "2028-02-29", []), "none");
  assert.equal(getScheduleStatus(readSchedule(row({ weekday: "Tues" })), "2028-02-29", []), "sweeps");
});

test("a 5th-week day the data does not list is unconfirmed, never clear", () => {
  const schedule = readSchedule(row({ ...SECOND_AND_FOURTH }));
  assert.equal(schedule.week5Unconfirmed, true);
  assert.equal(getScheduleStatus(schedule, "2026-09-29", []), "unconfirmed");
  const listed = readSchedule(row({ week1: "1", week2: "0", week3: "1", week4: "0", week5: "1" }));
  assert.equal(listed.week5Unconfirmed, false);
  assert.equal(getScheduleStatus(listed, "2026-09-29", []), "sweeps");
  // Unconfirmed days are reported in the month listing so the page can warn about them.
  const dates = getSweepDatesInMonth({ schedules: [schedule] }, 2026, 9, []);
  assert.ok(dates.some((entry) => entry.date === "2026-09-29" && entry.status === "unconfirmed"));
});

test("an overnight window moves the reminder to the evening before the posted weekday", () => {
  const overnight = readSchedule(row({ fromhour: "0", tohour: "2" }));
  assert.equal(overnight.nightBefore, true);
  // Tuesday 0-2 is 12-2 am Tuesday; the car moves Monday night.
  assert.equal(getReminderDate(overnight, "2026-10-13"), "2026-10-12");
  // Across a month and year boundary.
  assert.equal(getReminderDate(overnight, "2027-01-01"), "2026-12-31");
  assert.equal(getReminderDate(overnight, "2026-03-01"), "2026-02-28");
  const nearly = readSchedule(row({ fromhour: "4", tohour: "6" }));
  assert.equal(nearly.nightBefore, true);
  const morning = readSchedule(row({ fromhour: "5", tohour: "7" }));
  assert.equal(morning.nightBefore, false);
  assert.equal(getReminderDate(morning, "2026-10-13"), "2026-10-13");
  const dates = getSweepDatesInMonth({ schedules: [overnight] }, 2026, 10, []);
  assert.ok(dates.every((entry) => entry.nightBefore && entry.remindOn < entry.date));
});

test("holidays skip a street unless it is swept on holidays; holiday-only rows sweep only then", () => {
  const holidays = getSweepingHolidays(2026);
  assert.ok(holidays.includes("2026-11-26"), "Thanksgiving");
  assert.ok(holidays.includes("2026-11-27"), "the day after Thanksgiving");
  assert.ok(holidays.includes("2026-07-03"), "July 4 on a Saturday is observed on Friday");
  assert.ok(holidays.includes("2026-05-25"), "Memorial Day is the last Monday");
  assert.ok(holidays.includes("2026-10-12"), "the second Monday of October");
  assert.ok(!holidays.includes("2026-12-24"));
  const skipped = readSchedule(row({ weekday: "Thu", holidays: "0" }));
  const swept = readSchedule(row({ weekday: "Thu", holidays: "1" }));
  assert.equal(getScheduleStatus(skipped, "2026-11-26", holidays), "holiday-skip");
  assert.equal(getScheduleStatus(swept, "2026-11-26", holidays), "sweeps");
  assert.equal(getScheduleStatus(skipped, "2026-11-19", holidays), "sweeps");
  const only = readSchedule(row({ weekday: "Holiday", holidays: "1" }));
  assert.equal(only.holidayOnly, true);
  assert.deepEqual(only.days, []);
  assert.equal(getScheduleStatus(only, "2026-11-26", holidays), "sweeps");
  assert.equal(getScheduleStatus(only, "2026-11-19", holidays), "none");
});

test("rows are grouped into one curb per block side, merging identical windows", () => {
  const { curbs, report } = buildSfCurbs({
    rows: [
      row({ weekday: "Mon" }),
      row({ weekday: "Wed" }),
      row({ weekday: "Thu", fromhour: "0", tohour: "2" }),
      row({ weekday: "Holiday", holidays: "1" }),
      row({ cnnrightleft: "R", blockside: "NorthWest" }),
      row({ cnn: "2002", line: null }),
      row({ cnn: "3003", weekday: "Funday" })
    ]
  });
  assert.equal(report.rows, 7);
  assert.equal(report.rowsWithoutLine, 1);
  assert.equal(report.rowsUnreadable, 1);
  assert.equal(curbs.length, 2);
  const left = curbs.find((curb) => curb.blockside === "southeast");
  assert.equal(left.street, "Market St");
  assert.match(left.id, /^sf:[0-9a-f]{10}$/);
  // Mon+Wed 8-10 merge, Thu 0-2 stands apart, and the holiday row is its own schedule.
  assert.equal(left.schedules.length, 3);
  assert.deepEqual(left.schedules.find((schedule) => schedule.startHour === 8 && !schedule.holidayOnly).days, [1, 3]);
  assert.equal(left.schedules.find((schedule) => schedule.nightBefore).days[0], 4);
  // The row's line runs south-west, so its left side faces east-south-east, which snaps to east.
  assert.equal(left.sideKey, "east");
});

test("coordinates round to seven decimals as [lat, lng]", () => {
  const { curbs } = buildSfCurbs({
    rows: [row({ line: { type: "LineString", coordinates: [[-122.416291701103, 37.777493843394], [-122.417392074888, 37.776560951931]] } })]
  });
  curbs[0].geometry.forEach(([lat, lon]) => {
    assert.ok(lat > 37.77 && lat < 37.78 && lon < -122.41 && lon > -122.42, "[lat, lng] order");
    assert.equal(lat, Number(lat.toFixed(7)));
    assert.equal(lon, Number(lon.toFixed(7)));
  });
});

// A straight street running due east for about 150 m.
const EAST_STREET = { type: "LineString", coordinates: [[-122.42, 37.78], [-122.4183, 37.78]] };
const metresBetween = (a, b) => Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos((37.78 * Math.PI) / 180));

test("each side's curb faces its own way and sits about 4 m off the shared centreline", () => {
  const { curbs, report } = buildSfCurbs({
    rows: [
      row({ cnn: "7", cnnrightleft: "L", blockside: "North", line: EAST_STREET }),
      row({ cnn: "7", cnnrightleft: "R", blockside: "South", line: EAST_STREET })
    ]
  });
  const north = curbs.find((curb) => curb.sideKey === "north");
  const south = curbs.find((curb) => curb.sideKey === "south");
  assert.ok(north && south, "the two sides get opposite keys");
  // Travelling east, left is north: the north curb is above the line and the south curb below it.
  assert.ok(north.geometry[0][0] > 37.78 && south.geometry[0][0] < 37.78);
  assert.ok(Math.abs(metresBetween(north.geometry[0], [37.78, -122.42]) - CURB_OFFSET_METRES) < 0.1);
  assert.ok(Math.abs(metresBetween(north.geometry[0], south.geometry[0]) - 2 * CURB_OFFSET_METRES) < 0.1);
  assert.equal(report.sideDisagreesWithCity, 0);
  // The same line reversed puts the same L/R flags on the opposite compass sides.
  const reversed = { type: "LineString", coordinates: [...EAST_STREET.coordinates].reverse() };
  assert.equal(getSideKey(reversed.coordinates.map(([lon, lat]) => [lat, lon]), 1), "south");
  assert.equal(getSideKey(EAST_STREET.coordinates.map(([lon, lat]) => [lat, lon]), 1), "north");
});

test("the two sides of a centreline name each other as opposite", () => {
  const { curbs, report } = buildSfCurbs({
    rows: [
      row({ cnn: "7", cnnrightleft: "L", blockside: "North", line: EAST_STREET }),
      row({ cnn: "7", cnnrightleft: "R", blockside: "South", line: EAST_STREET }),
      row({ cnn: "8", cnnrightleft: "L", blockside: "North", line: EAST_STREET })
    ]
  });
  const north = curbs.filter((curb) => curb.sideKey === "north");
  const south = curbs.find((curb) => curb.sideKey === "south");
  assert.equal(south.opposite, north.find((curb) => curb.opposite === south.id).id);
  assert.equal(north.find((curb) => curb.opposite === south.id).opposite, south.id);
  // A side whose partner the city does not publish has no opposite, and cnn is never published.
  assert.equal(curbs.filter((curb) => !curb.opposite).length, 1);
  assert.ok(curbs.every((curb) => !("cnn" in curb)));
  assert.equal(report.curbsWithOpposite, 2);
});

test("a curb without the city's own side word still gets a side and keeps no blockside", () => {
  const { curbs } = buildSfCurbs({ rows: [row({ blockside: undefined, line: EAST_STREET })] });
  assert.equal(curbs[0].sideKey, "north");
  assert.ok(!("blockside" in curbs[0]));
});

test("an offset follows a bend without tearing", () => {
  const bend = [[37.78, -122.42], [37.78, -122.419], [37.7809, -122.419]];
  const out = offsetPath(bend, 4);
  assert.equal(out.length, 3);
  out.forEach((point, index) => assert.ok(metresBetween(point, bend[index]) >= 3.9 && metresBetween(point, bend[index]) < 7));
});

test("a refreshed curb keeps its id when the same street and side sits within 15 m", () => {
  const first = buildSfCurbs({ rows: [row(), row({ cnn: "1002", line: { type: "LineString", coordinates: [[-122.42, 37.78], [-122.4211, 37.7791]] } })] });
  const [kept, other] = first.curbs;
  assert.equal(first.curbs.length, 2);

  // The city renumbers the centreline: a different cnn, the same street and side, a few metres off.
  const renumbered = buildSfCurbs({
    rows: [
      row({ cnn: "9999", line: { type: "LineString", coordinates: [[-122.41629, 37.77749], [-122.41739, 37.77656]] } }),
      row({ cnn: "1002", line: { type: "LineString", coordinates: [[-122.42, 37.78], [-122.4211, 37.7791]] } })
    ],
    previousCurbs: first.curbs
  });
  const carried = renumbered.curbs.find((curb) => curb.id === kept.id);
  assert.ok(carried, "the renumbered curb inherits the old id");
  assert.ok(renumbered.curbs.some((curb) => curb.id === other.id), "an unchanged curb keeps its id");
  assert.equal(renumbered.report.idsCarriedForward, 2);
  assert.equal(renumbered.report.idsRetired, 0);

  // A curb that moved more than 15 m, or changed street or side, is a new curb and the old id retires.
  const moved = buildSfCurbs({
    rows: [row({ cnn: "9999", line: { type: "LineString", coordinates: [[-122.4163, 37.7785], [-122.4174, 37.7776]] } })],
    previousCurbs: [kept]
  });
  assert.notEqual(moved.curbs[0].id, kept.id);
  assert.deepEqual(moved.report.retiredIds, [kept.id]);

  const otherSide = carryForwardIds(
    [{ ...kept, id: "sf:fresh", sideKey: "northwest" }],
    [kept]
  );
  assert.equal(otherSide.curbs[0].id, "sf:fresh");
  assert.deepEqual(otherSide.retired, [kept.id]);
});

test("two new curbs never claim one old id", () => {
  const [old] = buildSfCurbs({ rows: [row()] }).curbs;
  const twin = (id) => ({ ...old, id, schedules: old.schedules });
  const result = carryForwardIds([twin("sf:a"), twin("sf:b")], [old]);
  assert.equal(new Set(result.curbs.map((curb) => curb.id)).size, 2);
  assert.equal(result.carried, 1);
});

test("tickets are checked by street, location, weekday, week and posted hours plus an hour", () => {
  const { curbs } = buildSfCurbs({
    rows: [
      row({ ...SECOND_AND_FOURTH, weekday: "Tues", fromhour: "8", tohour: "10" }),
      row({ cnn: "5005", corridor: "Fulton St", cnnrightleft: "R", weekday: "Mon", fromhour: "0", tohour: "2", line: { type: "LineString", coordinates: [[-122.45, 37.77], [-122.451, 37.77]] } })
    ]
  });
  const at = (location, datetime, lat = 37.7770, lon = -122.4168) => ({
    citation_issued_datetime: datetime,
    citation_location: location,
    latitude: String(lat),
    longitude: String(lon)
  });
  const result = checkAgainstTickets(curbs, [
    at("100 MARKET ST", "2026-10-13T09:00:00.000"), // 2nd Tuesday, in the window
    at("100 MARKET ST", "2026-10-13T11:30:00.000"), // an hour and a half after: contradicted
    at("100 MARKET ST", "2026-10-06T09:00:00.000"), // 1st Tuesday: wrong week, contradicted
    at("100 MARKET ST", "2026-10-27T10:50:00.000"), // inside the hour of slack
    at("100 MARKET ST", "2026-10-29T09:00:00.000", 37.7770, -122.4168), // a Thursday: contradicted
    at("77 FULTON ST", "2026-10-12T01:00:00.000", 37.7701, -122.4505), // overnight block, consistent
    at("77 FULTON ST", "2026-10-12T05:00:00.000", 37.7701, -122.4505), // overnight block, contradicted
    at("9 NOWHERE ST", "2026-10-13T09:00:00.000", 37.9, -122.1), // nothing near
    { citation_location: "5 MARKET ST", latitude: null, longitude: null, citation_issued_datetime: "2026-10-13T09:00:00.000" }
  ]);
  assert.equal(result.unreadable, 1);
  assert.equal(result.noCandidate, 1);
  assert.equal(result.matched, 7);
  assert.equal(result.consistent, 3);
  assert.equal(result.contradicted, 4);
  assert.equal(result.overnight.tickets, 2);
  assert.equal(result.overnight.consistent, 1);
  assert.equal(result.daytime.tickets, 5);
});

test("a ticket address on a different street name still matches a curb within 40 m", () => {
  const { curbs } = buildSfCurbs({ rows: [row()] });
  const result = checkAgainstTickets(curbs, [
    { citation_issued_datetime: "2026-10-13T09:00:00.000", citation_location: "500 GEARY BLVD", latitude: "37.7770", longitude: "-122.4168" }
  ]);
  assert.equal(result.consistent, 1);
  assert.equal(result.noCandidate, 0);
});

test("5th-week tickets are judged by the published flags and counted apart", () => {
  const { curbs } = buildSfCurbs({ rows: [row({ ...SECOND_AND_FOURTH })] });
  const result = checkAgainstTickets(curbs, [
    { citation_issued_datetime: "2026-09-29T09:00:00.000", citation_location: "1 MARKET ST", latitude: "37.7770", longitude: "-122.4168" }
  ]);
  assert.equal(result.fifthWeek.tickets, 1);
  assert.equal(result.fifthWeek.contradicted, 1);
});

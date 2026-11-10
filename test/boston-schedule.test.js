const test = require("node:test");
const assert = require("node:assert/strict");
const Boston = require("../public/boston-schedule.js");

const monday = { days: [1], weeks: [1, 3], start: "08:00", end: "12:00", season: "apr-nov", nightBefore: false, standing: false };

test("a rule sweeps on the weeks the city lists and no others", () => {
  assert.equal(Boston.sweepsOn(monday, "2026-11-02"), true, "1st Monday of November");
  assert.equal(Boston.sweepsOn(monday, "2026-11-09"), false, "2nd Monday");
  assert.equal(Boston.sweepsOn(monday, "2026-11-16"), true, "3rd Monday");
  assert.equal(Boston.sweepsOn(monday, "2026-11-17"), false, "a Tuesday");
});

test("a 5th week is used as the city lists it, never inferred", () => {
  const fifth = { ...monday, weeks: [1, 3, 5] };
  assert.equal(Boston.sweepsOn(fifth, "2026-08-31"), true, "5th Monday of August, listed");
  assert.equal(Boston.sweepsOn(monday, "2026-08-31"), false, "5th Monday of August, not listed");
});

test("daytime sweeping has a season, and the early districts start in March and end in December", () => {
  assert.equal(Boston.sweepsOn(monday, "2027-03-01"), false, "March is outside April to November");
  assert.equal(Boston.sweepsOn({ ...monday, season: "mar-dec" }, "2027-03-01"), true);
  assert.equal(Boston.sweepsOn({ ...monday, season: "mar-dec" }, "2026-12-14"), false, "2nd Monday");
  assert.equal(Boston.sweepsOn({ ...monday, weeks: [1, 2, 3, 4, 5], season: "mar-dec" }, "2026-12-14"), true);
  assert.equal(Boston.sweepsOn({ ...monday, weeks: [1, 2, 3, 4, 5], season: "year-round" }, "2027-01-04"), true);
});

test("the next sweep after the season ends is next spring's", () => {
  const next = Boston.getUpcomingSweeps({ schedules: [monday] }, "2026-12-01", 2).map((entry) => entry.date);
  assert.deepEqual(next, ["2027-04-05", "2027-04-19"]);
});

test("an overnight window is reminded the evening before, and a standing rule never produces a date", () => {
  const overnight = { days: [4], weeks: [1, 2, 3, 4, 5], start: "00:01", end: "07:00", season: "year-round", nightBefore: true, standing: false };
  const [first] = Boston.getUpcomingSweeps({ schedules: [overnight] }, "2026-11-10", 1);
  assert.equal(first.date, "2026-11-12");
  assert.equal(first.remindOn, "2026-11-11");
  assert.equal(first.nightBefore, true);
  assert.deepEqual(Boston.getUpcomingSweeps({ schedules: [{ ...overnight, days: [0, 1, 2, 3, 4, 5, 6], standing: true }] }, "2026-11-10", 3), []);
});

test("the holiday list matches the city's own 2026 and 2027 listing, and leaves out the two normal days", () => {
  // boston.gov/holidays, read 2026-11-10: daytime street cleaning is canceled on these; Evacuation Day (March 17)
  // and Bunker Hill Day (June 17) run normally.
  assert.deepEqual(Boston.getDaytimeCancelledHolidays(2026).filter((date) => date >= "2026-11-01"), ["2026-11-11", "2026-11-26", "2026-12-25"]);
  assert.deepEqual(Boston.getDaytimeCancelledHolidays(2027), [
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-19", "2027-05-31", "2027-06-18",
    "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"
  ]);
  assert.ok(!Boston.getDaytimeCancelledHolidays(2027).includes("2027-03-17"));
  assert.ok(!Boston.getDaytimeCancelledHolidays(2027).includes("2027-06-17"));
});

test("a daytime rule on a holiday is held back as a holiday-skip, and an overnight rule is not", () => {
  const everyDay = { days: [0, 1, 2, 3, 4, 5, 6], weeks: [1, 2, 3, 4, 5], season: "year-round", standing: false };
  const day = { ...everyDay, start: "08:00", end: "12:00", nightBefore: false };
  const night = { ...everyDay, start: "00:01", end: "07:00", nightBefore: true };
  assert.equal(Boston.getScheduleStatus(day, "2026-11-26"), "holiday-skip", "Thanksgiving");
  assert.equal(Boston.getScheduleStatus(night, "2026-11-26"), "sweeps", "overnight sweeping is normal");
  assert.equal(Boston.getScheduleStatus(day, "2026-11-27"), "sweeps", "the day after is a normal day");
  assert.equal(Boston.getScheduleStatus(day, "2027-03-17"), "sweeps", "Evacuation Day runs normally");
  const entries = Boston.getUpcomingSweeps({ schedules: [{ ...day, days: [4], weeks: [4] }] }, "2026-11-20", 2);
  assert.deepEqual(entries.map((entry) => [entry.date, entry.status]), [["2026-11-26", "holiday-skip"], ["2026-12-24", "sweeps"]]);
});

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

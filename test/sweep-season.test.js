"use strict";

// Denver sweeps April through November. When the published dates run out the client projects a
// monthly rule forward, and that projection used to run straight through the winter, so every saved
// curb reminded about a December-to-March sweep that never happens.
//
// Like test/sweep-follow-ups.test.js, this reads public/app.js as source text and lifts the date
// functions into a sandbox, because the client has no module boundary. Renaming these functions
// will break this test even when behavior is unchanged; update the names alongside the code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { getCity } = require("../public/cities.js");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");

function extractFunctionBlock(lines, name) {
  const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);

  let end = start;
  while (end < lines.length && lines[end] !== "}") {
    end += 1;
  }
  assert.ok(end < lines.length, `could not find the end of function ${name}`);

  return lines.slice(start, end + 1).join("\n");
}

function loadDateFunctions(today, season) {
  const lines = fs.readFileSync(APP_PATH, "utf8").split("\n");
  const functions = [
    "getUpcomingSweepDates",
    "getRuleBasedSweepDates",
    "isInSweepSeason",
    "parseMonthlySweepRule",
    "getMonthlyOrdinalWeekdayDate",
    "parseSweepDate"
  ];

  const sandbox = {
    CITY_SWEEP_SEASON: season,
    getStartOfToday: () => new Date(today.getTime())
  };
  vm.createContext(sandbox);
  vm.runInContext(functions.map((name) => extractFunctionBlock(lines, name)).join("\n"), sandbox);
  return sandbox;
}

const DENVER_SEASON = getCity("denver").sweepSeason;
const RULE_SEGMENT = { schedule: { rule: "The 4th Tuesday of the month" } };

function toMonthKeys(dates) {
  return Array.from(dates, (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
}

test("Denver's record says it sweeps April through November", () => {
  assert.deepEqual(DENVER_SEASON, { firstMonth: 4, lastMonth: 11 });
});

test("a monthly rule is not projected into the winter", () => {
  const { getRuleBasedSweepDates } = loadDateFunctions(new Date(2026, 8, 1), DENVER_SEASON);

  assert.deepEqual(toMonthKeys(getRuleBasedSweepDates(RULE_SEGMENT, 12)), [
    "2026-09",
    "2026-10",
    "2026-11",
    "2027-04",
    "2027-05",
    "2027-06",
    "2027-07",
    "2027-08"
  ]);
});

test("in the middle of winter the next projected sweep is April", () => {
  const { getUpcomingSweepDates } = loadDateFunctions(new Date(2027, 0, 10), DENVER_SEASON);

  const dates = getUpcomingSweepDates(RULE_SEGMENT);
  assert.equal(toMonthKeys(dates)[0], "2027-04");
  assert.ok(dates.every((date) => date.getMonth() + 1 >= 4 && date.getMonth() + 1 <= 11));
});

test("a date Denver publishes is kept whatever month it falls in", () => {
  const { getUpcomingSweepDates } = loadDateFunctions(new Date(2026, 10, 20), DENVER_SEASON);

  const dates = getUpcomingSweepDates({
    schedule: { rule: "The 4th Tuesday of the month", allDates: [{ Date: "12/08/2026" }] }
  });
  assert.ok(toMonthKeys(dates).includes("2026-12"));
});

test("a city with no season on its record projects every month", () => {
  const { getRuleBasedSweepDates } = loadDateFunctions(new Date(2026, 8, 1), null);

  assert.equal(getRuleBasedSweepDates(RULE_SEGMENT, 8).length, 8);
});

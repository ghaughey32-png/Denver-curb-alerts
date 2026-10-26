"use strict";

// San Francisco as a city record that is built but not yet switchable: the registry hides it, the
// schedule code projects its posted windows into dates, and the client turns the published curbs into
// segments. Like test/snow-city.test.js this lifts functions out of public/app.js as source text, so a
// rename breaks it even when behaviour is unchanged.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const registry = require("../public/cities.js");
const SfSchedule = require("../public/sf-schedule.js");

const APP_LINES = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").split("\n");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

function loadSfClient(today = new Date(2026, 9, 26)) {
  const sandbox = {
    window: { SfSchedule },
    capitalize: (value) => value.charAt(0).toUpperCase() + value.slice(1),
    getStreetOrientation: () => "north-south",
    getStartOfToday: () => today
  };
  const names = ["buildSfSchedule", "buildSfDataset", "getSfSweepDates"];
  vm.createContext(sandbox);
  vm.runInContext([...names.map(extractFunctionBlock), `this.__exports = { ${names.join(", ")} };`].join("\n"), sandbox);
  return sandbox.__exports;
}

// Values built inside the vm context have another realm's Array.prototype, which deepEqual rejects.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Valencia St's east curb as the build publishes it: Tuesday 6-8 am, even weeks and odd weeks as two rows.
const VALENCIA = {
  id: "sf:000cf6f28f",
  street: "Valencia St",
  sideKey: "east",
  schedules: [
    { days: [2], startHour: 6, endHour: 8, weeks: [2, 4], holidays: false, nightBefore: false, week5Unconfirmed: true },
    { days: [2], startHour: 6, endHour: 8, weeks: [1, 3, 5], holidays: false, nightBefore: false, week5Unconfirmed: false }
  ],
  geometry: [[37.7537057, -122.4207668], [37.7521063, -122.4206195]],
  addresses: [1201, 1299],
  opposite: "sf:afe94ebd96"
};

test("the SF record is built but never offered, stored or matched by location", () => {
  const sf = registry.getCity("san-francisco");
  assert.equal(sf.enabled, false);
  assert.equal(sf.idPrefix, "sf:");
  assert.ok(!registry.listCities().some((city) => city.id === "san-francisco"));
  assert.equal(registry.getCityForPoint(37.7749, -122.4194), null);
  assert.throws(() => registry.saveCityChoice("san-francisco"));
  assert.equal(registry.getCityForCurbId("sf:abc123").id, "san-francisco");
});

test("a stored choice of SF falls back to Denver while it is disabled", () => {
  const registryPath = require.resolve("../public/cities.js");
  delete require.cache[registryPath];
  globalThis.localStorage = { getItem: () => "san-francisco", setItem() {} };
  try {
    assert.equal(require(registryPath).getActiveCity().id, "denver");
  } finally {
    delete globalThis.localStorage;
    delete require.cache[registryPath];
  }
});

test("the SF bounds hold every published curb", () => {
  const sf = registry.getCity("san-francisco");
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "sf-sweeping.json"), "utf8"));
  for (const curb of inventory.curbs) {
    for (const [lat, lon] of curb.geometry) {
      assert.ok(registry.isWithinCityBounds(sf, lat, lon), `${curb.id} lies outside the city's bounds`);
    }
  }
});

test("upcoming sweeps follow the weeks the schedule lists and skip other days", () => {
  const sweeps = SfSchedule.getUpcomingSweeps(VALENCIA, "2026-10-26", 4);
  // Tuesdays after the 26th: Oct 27 is the 4th (even), Nov 3 the 1st, Nov 10 the 2nd, Nov 17 the 3rd.
  assert.deepEqual(sweeps.map((entry) => entry.date), ["2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17"]);
  assert.ok(sweeps.every((entry) => entry.status === "sweeps"));
});

test("a 5th-week day the data does not list stays in the list as unconfirmed", () => {
  const unconfirmed = SfSchedule.getUpcomingSweeps({ schedules: [VALENCIA.schedules[0]] }, "2026-09-28", 3);
  // Sep 29 is a 5th Tuesday: the even-week row cannot confirm it, and must not call it clear.
  assert.equal(unconfirmed[0].date, "2026-09-29");
  assert.equal(unconfirmed[0].status, "unconfirmed");
});

test("a curb swept only once a month still fills the list across months", () => {
  const monthly = { schedules: [{ days: [1], startHour: 8, endHour: 10, weeks: [1], holidays: true, nightBefore: false, week5Unconfirmed: false }] };
  const sweeps = SfSchedule.getUpcomingSweeps(monthly, "2026-10-26", 8);
  assert.equal(sweeps.length, 8);
  assert.ok(sweeps.every((entry, index) => index === 0 || sweeps[index - 1].date < entry.date));
});

test("an overnight window reminds the evening before its posted day", () => {
  const overnight = { schedules: [{ days: [2], startHour: 0, endHour: 2, weeks: [1, 2, 3, 4, 5], holidays: true, nightBefore: true, week5Unconfirmed: false }] };
  const [first] = SfSchedule.getUpcomingSweeps(overnight, "2026-10-26", 1);
  assert.equal(first.date, "2026-10-27");
  assert.equal(first.remindOn, "2026-10-26");
});

test("buildSfDataset keeps the posted windows, the opposite side and the addresses on the segment", () => {
  const { buildSfDataset } = loadSfClient();
  const { streetWays, curbSegments } = buildSfDataset({ curbs: [VALENCIA, { id: "sf:short", geometry: [[37.7, -122.4]] }, { geometry: VALENCIA.geometry }] });
  assert.equal(streetWays.length, 1);
  assert.equal(curbSegments.length, 1);
  const [segment] = curbSegments;
  assert.equal(segment.id, "sf:000cf6f28f");
  assert.equal(segment.sideLabel, "East curb");
  assert.equal(segment.oppositeId, "sf:afe94ebd96");
  assert.deepEqual(plain(segment.addresses), [1201, 1299]);
  assert.equal(segment.schedule.sf.length, 2);
  assert.equal(segment.schedule.cityId, "san-francisco");
  assert.equal(segment.schedule.remindersAllowed, true);
  // Rules are projected at job time; nothing is baked into the saved curb.
  assert.deepEqual(plain(segment.schedule.allDates), []);
});

test("an SF segment projects its own sweep dates as local dates at job time", () => {
  const { buildSfDataset, getSfSweepDates } = loadSfClient(new Date(2026, 9, 26));
  const [segment] = buildSfDataset({ curbs: [VALENCIA] }).curbSegments;
  const dates = getSfSweepDates(segment, 3);
  assert.deepEqual(
    plain(dates.map((date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()])),
    [[2026, 10, 27], [2026, 11, 3], [2026, 11, 10]]
  );
  // Another city's curb has no windows, so the hook adds nothing to it.
  assert.deepEqual(plain(getSfSweepDates({ schedule: { sweepType: "Scheduled", allDates: [] } })), []);
});

test("every published SF curb loads and the whole file converts", () => {
  const { buildSfDataset } = loadSfClient();
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "sf-sweeping.json"), "utf8"));
  const { curbSegments } = buildSfDataset(inventory);
  assert.equal(curbSegments.length, inventory.curbs.length);
  assert.ok(curbSegments.every((segment) => registry.getCityForCurbId(segment.id).id === "san-francisco"));
});

test("getOppositeCurb follows an explicit opposite id", () => {
  const other = { id: "sf:b", sideKey: "west" };
  const sandbox = {
    PARKING_SIDE_OPPOSITES: { east: "west", west: "east" },
    getSegmentById: (id) => (id === "sf:b" ? other : null)
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunctionBlock("getOppositeCurb")}; this.__fn = getOppositeCurb;`, sandbox);
  assert.equal(sandbox.__fn({ id: "sf:a", sideKey: "east", oppositeId: "sf:b" }), other);
  assert.equal(sandbox.__fn({ id: "sf:a", sideKey: "east" }), null);
});

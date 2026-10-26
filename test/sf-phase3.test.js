"use strict";

// San Francisco's visible half: the city line, side colours' sheet copy, house-number address search,
// overnight settings and choosing the city from the phone's position. Like test/sf-city.test.js this lifts
// functions out of public/app.js as source text, so a rename breaks it even when behaviour is unchanged.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const registry = require("../public/cities.js");
const SfSchedule = require("../public/sf-schedule.js");
const SfLimits = require("../public/sf-city-limits.js");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const APP_LINES = APP.split("\n");
const INVENTORY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "sf-sweeping.json"), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

function load(names, sandbox, prelude = "") {
  vm.createContext(sandbox);
  vm.runInContext([prelude, ...names.map(extractFunctionBlock), `this.__exports = { ${names.join(", ")} };`].join("\n"), sandbox);
  return sandbox.__exports;
}

function pointInside(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > point[0] !== yj > point[0] && point[1] < ((xj - xi) * (point[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

test("the city line holds San Francisco and not Daly City, and the wash leaves the curbs alone", () => {
  const [ring] = SfLimits.CITY_LIMITS;
  assert.ok(pointInside([37.7749, -122.4194], ring), "downtown is inside");
  assert.ok(pointInside([37.8267, -122.3711], ring), "Treasure Island is inside");
  assert.ok(!pointInside([37.6879, -122.4702], ring), "Daly City is outside");
  assert.equal(SfLimits.BOUNDARY_BUFFER_METRES, 20);

  // A few streets run on past OpenStreetMap's county line at the Daly City edge; Denver budgets its
  // stubs the same way. 47 of 59,020 curb points at the 2026-10-26 build.
  const [mask] = SfLimits.getMaskRings();
  let under = 0;
  INVENTORY.curbs.forEach((curb) => curb.geometry.forEach((point) => {
    if (!pointInside(point, mask)) under += 1;
  }));
  assert.ok(under <= 60, `${under} curb points sit under the red wash`);
});

test("SF is found by location, and the three cities' bounds never overlap", () => {
  const sf = registry.getCity("san-francisco");
  try {
    assert.equal(registry.getCityForPoint(37.7749, -122.4194).id, "san-francisco");
    assert.equal(registry.getCityForPoint(44.9778, -93.265).id, "minneapolis");
    assert.equal(registry.getCityForPoint(39.74, -104.99).id, "denver");
    assert.equal(registry.getCityForPoint(37.4, -122.0), null);
    const cities = registry.listCities();
    assert.equal(cities.length, 3);
    cities.forEach((a) => cities.forEach((b) => {
      if (a === b) return;
      const apart = a.bounds.north < b.bounds.south || a.bounds.south > b.bounds.north || a.bounds.east < b.bounds.west || a.bounds.west > b.bounds.east;
      assert.ok(apart, `${a.id} and ${b.id} overlap`);
    }));
  } finally {
    assert.notEqual(sf.enabled, false);
  }
});

test("only SF has page copy; Denver's wording stays the markup's default", () => {
  assert.ok(registry.getCity("san-francisco").pageCopy.outsideMap.includes("San Francisco"));
  assert.equal(registry.getCity("denver").pageCopy, undefined);
  assert.match(APP, /CITY_PAGE_COPY\?\.outsideMap \|\| "That spot looks outside the Denver map, so there is no Denver sweeping schedule for us to follow there\."/);
  assert.match(APP, /CITY_PAGE_COPY\?\.locating \|\| "Finding your location in Denver now\.\.\."/);
});

const MONDAY_NIGHT = { days: [2], startHour: 0, endHour: 2, weeks: [1, 2, 3, 4, 5], holidays: true, nightBefore: true, week5Unconfirmed: false };
const TUESDAY_DAY = { days: [2], startHour: 8, endHour: 10, weeks: [2, 4], holidays: false, nightBefore: false, week5Unconfirmed: true };

function loadSheet(today = new Date(2099, 2, 25)) {
  return load(
    ["formatSfHour", "joinWithAnd", "describeSfWindow", "describeSfWindows", "formatSfDataDate", "buildSfCurbSheetCopy", "getSfReminderEntries", "formatLocalDateKey", "formatDateObject"],
    { window: { SfSchedule }, getStartOfToday: () => today },
    'const SF_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];\nconst SF_ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];\nlet sfDataGeneratedAt = "2026-10-26T14:51:12.508Z";'
  );
}

test("an overnight window reads as the night before, never 'before midnight'", () => {
  const { describeSfWindow } = loadSheet();
  assert.equal(describeSfWindow(MONDAY_NIGHT), "Overnight sweeping, Monday night (posted 12 am–2 am Tuesdays), every week");
  assert.equal(describeSfWindow(TUESDAY_DAY), "Tuesdays, 8 am–10 am (posted), 2nd and 4th of the month");
  assert.equal(describeSfWindow({ ...MONDAY_NIGHT, startHour: 3, endHour: 6, weeks: [1, 3, 5] }), "Overnight sweeping, Monday night (posted 3 am–6 am Tuesdays), 1st, 3rd and 5th of the month");
  assert.doesNotMatch(describeSfWindow(MONDAY_NIGHT), /before midnight/i);
});

test("the sheet says what is certain, hedges what is not, and shows the data's date", () => {
  const { buildSfCurbSheetCopy } = loadSheet(new Date(2099, 2, 25));
  const curb = (...sf) => ({ id: "sf:a", street: "Valencia St", schedule: { sf } });

  const confirmed = buildSfCurbSheetCopy(curb({ ...TUESDAY_DAY, weeks: [1, 2, 3, 4, 5], week5Unconfirmed: false }));
  assert.match(confirmed.headline, /^Next sweep: Tue, Mar 31, 2099$/);
  assert.match(confirmed.notice, /Posted hours are the sign's, not our promise\. Check the sign/);
  assert.match(confirmed.notice, /Schedule data from Oct 26, 2026\./);
  assert.equal(confirmed.hedgeWord, undefined);

  const fifth = buildSfCurbSheetCopy(curb(TUESDAY_DAY));
  assert.match(fifth.headline, /^May be swept Tue, Mar 31, 2099 \(5th week; not confirmed\)$/);
  assert.equal(fifth.hedgeWord, "May");
  assert.match(fifth.notice, /doesn't confirm it\. Check the sign, and move your car to be safe/);

  const overnight = buildSfCurbSheetCopy(curb(MONDAY_NIGHT));
  assert.match(overnight.headline, /move the night before$/);

  const holiday = SfSchedule.getSweepingHolidays(2099)[1];
  const { year, month, day } = SfSchedule.parseDate(holiday);
  const spared = loadSheet(new Date(year, month - 1, day - 6)).buildSfCurbSheetCopy(curb({ ...TUESDAY_DAY, days: [1], weeks: [1, 2, 3, 4, 5], holidays: false, week5Unconfirmed: false }));
  assert.match(spared.headline, /^Holiday .*: probably not swept$/);
  assert.equal(spared.hedgeWord, "probably");

  const none = buildSfCurbSheetCopy({ id: "sf:b", street: "Nowhere St", schedule: { sf: [] } });
  assert.equal(none.canRemind, false);
  assert.match(none.notice, /City and County of San Francisco's data/);
});

function loadSearch(curbSegments, query = "") {
  return load(
    ["canonicalizeSfStreet", "splitSfStreetSuffix", "getSfCurbsByStreet", "findSfStreetCurbs", "getPointAlongPath", "findSfAddressMatch", "parseSearchHouseNumber", "getSearchStreetText"],
    { state: { curbSegments }, CITY_NAME_PATTERN: /\bSan Francisco\b/i },
    `let sfCurbsByStreetCache = null;\n${APP_LINES.slice(
      APP_LINES.findIndex((line) => line.startsWith("const SF_STREET_WORDS = {")),
      APP_LINES.findIndex((line) => line.startsWith("const SF_STREET_SUFFIXES = ")) + 1
    ).join("\n")}`
  );
}

test("a typed address lands on the curb whose range holds the number, by parity, at its place on the block", () => {
  const curbs = INVENTORY.curbs.map((curb) => ({ id: curb.id, street: curb.street, geometry: curb.geometry, addresses: curb.addresses }));
  const { findSfAddressMatch } = loadSearch(curbs);
  const withRange = curbs.filter((curb) => curb.addresses && curb.addresses[1] - curb.addresses[0] >= 20);
  assert.ok(withRange.length > 1000);

  let placed = 0;
  withRange.slice(0, 400).forEach((curb) => {
    const [first, last] = curb.addresses;
    const number = first + 2 * Math.floor((last - first) / 4);
    const match = plain(findSfAddressMatch(`${number} ${curb.street}, San Francisco, CA`));
    assert.ok(match, `${number} ${curb.street} was not placed`);
    const target = curbs.find((candidate) => candidate.id === match.segmentId);
    assert.equal(target.street, curb.street);
    assert.ok(number >= Math.min(...target.addresses) && number <= Math.max(...target.addresses));
    assert.equal(number % 2, target.addresses[0] % 2, "the side's parity matches the number");
    assert.equal(match.kind, "address");
    placed += 1;
  });
  assert.equal(placed, 400);
});

test("the two sides of a street answer to odd and even numbers, and an unplaceable number returns null", () => {
  const curb = (id, street, addresses, lat) => ({ id, street, addresses, geometry: [[lat, -122.42], [lat + 0.001, -122.42]] });
  const { findSfAddressMatch } = loadSearch([curb("sf:odd", "Fulton St", [1201, 1299], 37.77), curb("sf:even", "Fulton St", [1200, 1298], 37.77), curb("sf:other", "Hayes St", [1201, 1299], 37.78)]);

  assert.equal(findSfAddressMatch("1234 Fulton St").segmentId, "sf:even");
  assert.equal(findSfAddressMatch("1235 Fulton Street").segmentId, "sf:odd");
  const first = findSfAddressMatch("1201 Fulton St");
  const last = findSfAddressMatch("1299 Fulton St");
  assert.ok(first.lat < last.lat, "the number runs along the block");
  assert.equal(findSfAddressMatch("5000 Fulton St"), null);
  // No suffix typed: the one Fulton is meant. Typed with the wrong one, it is not guessed.
  assert.equal(findSfAddressMatch("1234 Fulton").segmentId, "sf:even");
  assert.equal(findSfAddressMatch("1234 Fulton Ave"), null);
  assert.equal(findSfAddressMatch("Fulton St"), null);
});

test("5th St and 5th Ave are different streets, and a name shared by two is not guessed", () => {
  const curb = (id, street) => ({ id, street, addresses: [101, 199], geometry: [[37.77, -122.42], [37.771, -122.42]] });
  const { findSfAddressMatch } = loadSearch([curb("sf:st", "5th St"), curb("sf:ave", "5th Ave"), curb("sf:n", "N Point St")]);

  assert.equal(findSfAddressMatch("151 5th St").segmentId, "sf:st");
  assert.equal(findSfAddressMatch("151 5th Avenue").segmentId, "sf:ave");
  assert.equal(findSfAddressMatch("151 Fifth Street"), null, "spelled-out ordinals are not guessed");
  assert.equal(findSfAddressMatch("151 5th"), null, "5th alone could be either");
  assert.equal(findSfAddressMatch("151 North Point Street").segmentId, "sf:n");
});

test("reminder models follow the curbs: overnight only, daytime only, or both", () => {
  const { getReminderModels } = load(["getReminderModels"], {});
  const sf = (...sf) => ({ schedule: { sf } });
  assert.deepEqual(plain(getReminderModels([sf(MONDAY_NIGHT)])), { day: false, overnight: true });
  assert.deepEqual(plain(getReminderModels([sf(TUESDAY_DAY)])), { day: true, overnight: false });
  assert.deepEqual(plain(getReminderModels([sf(MONDAY_NIGHT), { schedule: { sweepType: "Scheduled" } }])), { day: true, overnight: true });
  assert.deepEqual(plain(getReminderModels([])), { day: true, overnight: false });
});

test("the summary names the evening times for overnight curbs and leaves Denver's wording alone", () => {
  const { summarizeReminders } = load(["summarizeReminders", "formatTime", "isValidTimeValue"], {});
  const reminders = {
    dayBeforeEnabled: true,
    dayBeforeTime: "18:00",
    dayOfReminders: [{ enabled: true, time: "07:00" }, { enabled: false, time: "09:00" }, { enabled: false, time: "11:00" }],
    overnightReminders: [{ enabled: true, time: "18:00" }, { enabled: true, time: "20:00" }, { enabled: false, time: "22:00" }],
    nagUntilMoved: true
  };
  assert.match(summarizeReminders(reminders), /^Scheduled day before at 6:00 PM and day of at 7:00 AM\./);
  assert.match(summarizeReminders(reminders, { day: false, overnight: true }), /^Scheduled the evening before overnight sweeps at 6:00 PM, 8:00 PM\./);
  assert.match(summarizeReminders(reminders, { day: true, overnight: true }), /day of at 7:00 AM and the evening before overnight sweeps at 6:00 PM, 8:00 PM/);
});

function loadLocator({ stored = false, tried = false, bridgePosition = null, permission = null, position = { latitude: 37.7749, longitude: -122.4194 } }) {
  const calls = { saved: [], reloaded: 0, marked: 0 };
  const sf = { id: "san-francisco" };
  const sandbox = {
    ACTIVE_CITY: { id: "denver" },
    window: {
      CityRegistry: {
        hasStoredCityChoice: () => stored,
        hasTriedLocatingCity: () => tried,
        markTriedLocatingCity: () => { calls.marked += 1; },
        listCities: () => [{ id: "denver" }, sf],
        getCityForPoint: () => sf,
        saveCityChoice: (id) => { calls.saved.push(id); return true; }
      },
      location: { reload: () => { calls.reloaded += 1; } }
    },
    navigator: { permissions: permission ? { query: async () => ({ state: permission }) } : undefined },
    getNativeReminderBridge: () => (bridgePosition ? { getCurrentPosition: async () => bridgePosition } : null),
    getDevicePosition: async () => position
  };
  const { chooseCityFromLocationOnce } = load(["chooseCityFromLocationOnce"], sandbox);
  return { run: chooseCityFromLocationOnce, calls };
}

test("a first visit in San Francisco opens San Francisco, once, and a refusal is not asked again", async () => {
  const native = loadLocator({ bridgePosition: { latitude: 37.77, longitude: -122.42 } });
  await native.run();
  assert.deepEqual(native.calls.saved, ["san-francisco"]);
  assert.equal(native.calls.reloaded, 1);
  assert.equal(native.calls.marked, 1);

  const granted = loadLocator({ permission: "granted" });
  await granted.run();
  assert.equal(granted.calls.reloaded, 1);

  const prompt = loadLocator({ permission: "prompt" });
  await prompt.run();
  assert.deepEqual(prompt.calls.saved, []);
  assert.equal(prompt.calls.marked, 1, "the attempt is recorded so it is not retried every load");

  for (const state of [{ stored: true }, { tried: true }]) {
    const skipped = loadLocator({ ...state, bridgePosition: { latitude: 1, longitude: 1 } });
    await skipped.run();
    assert.equal(skipped.calls.saved.length, 0);
    assert.equal(skipped.calls.marked, 0);
  }
});

function loadSweepChecks(now, segments, movedSweepKeys = []) {
  const constantsStart = APP_LINES.findIndex((line) => line.startsWith("const DEFAULT_DAY_OF_REMINDERS = ["));
  const constantsEnd = APP_LINES.findIndex((line) => line.startsWith("const JOB_KIND_URGENCY = "));
  const set = { id: "set-my-curbs", name: "My curbs", reminders: {}, segments };
  const names = [
    "getPendingSweepChecks", "getSweepCheckCandidates", "getFirstOvernightTime", "getSfReminderEntries", "buildDefaultReminders",
    "isValidTimeValue", "buildDayOfReminderSlots", "buildOvernightReminderSlots", "applyTimeToDate", "addDays",
    "formatLocalDateKey", "buildSweepKey", "buildMovedCurbKey"
  ];
  const sandbox = {
    window: { SfSchedule },
    state: { movedSweepKeys },
    getReminderSets: () => [set],
    getSegmentsForSavedSet: (candidate) => candidate.segments,
    isCurbCoveredByParkedCar: () => false,
    getStartOfToday: () => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    getNextSweepDate: () => null
  };
  vm.createContext(sandbox);
  vm.runInContext([APP_LINES.slice(constantsStart, constantsEnd + 1).join("\n"), ...names.map(extractFunctionBlock), "this.__fn = getPendingSweepChecks;"].join("\n"), sandbox);
  return plain(sandbox.__fn(now));
}

test("the sweep-day banner knows SF's hours: overnight asks from the first evening reminder, and a finished sweep is dropped", () => {
  const overnight = { id: "sf:n", street: "Illinois St", sideLabel: "West curb", schedule: { sf: [{ days: [2], startHour: 0, endHour: 2, weeks: [1, 2, 3, 4, 5], holidays: true, nightBefore: true, week5Unconfirmed: false }] } };
  const checks = (...time) => loadSweepChecks(new Date(...time), [overnight]);

  assert.equal(checks(2099, 2, 2, 17, 0).length, 0, "before the first evening reminder (6 pm)");
  const evening = checks(2099, 2, 2, 18, 30);
  assert.equal(evening.length, 1);
  assert.equal(evening[0].isToday, false);
  assert.equal(evening[0].overnight, true);
  assert.equal(checks(2099, 2, 3, 1, 0)[0].isToday, true, "during the window it is today");
  assert.equal(checks(2099, 2, 3, 3, 0).length, 0, "after the window ended at 2 am it is not asked about");
  assert.equal(checks(2099, 2, 3, 15, 0).length, 0);
});

test("a daytime SF curb is asked about until its window ends, and Denver's banner is unchanged", () => {
  const day = { id: "sf:d", street: "Valencia St", sideLabel: "West curb", schedule: { sf: [{ days: [2], startHour: 8, endHour: 10, weeks: [1, 2, 3, 4, 5], holidays: true, nightBefore: false, week5Unconfirmed: false }] } };
  assert.equal(loadSweepChecks(new Date(2099, 2, 3, 9, 0), [day]).length, 1);
  assert.equal(loadSweepChecks(new Date(2099, 2, 3, 11, 0), [day]).length, 0);

  // A Denver curb has no hours: its sweep day stays a question all day, as it always did.
  const sandboxNext = new Date(2099, 2, 3);
  const denver = { id: "way:north", street: "W 32ND AVE", sideLabel: "North curb", schedule: { sweepType: "Scheduled" } };
  const constantsStart = APP_LINES.findIndex((line) => line.startsWith("const DEFAULT_DAY_OF_REMINDERS = ["));
  const constantsEnd = APP_LINES.findIndex((line) => line.startsWith("const JOB_KIND_URGENCY = "));
  const names = ["getPendingSweepChecks", "getSweepCheckCandidates", "getFirstOvernightTime", "buildDefaultReminders", "isValidTimeValue", "buildDayOfReminderSlots", "buildOvernightReminderSlots", "applyTimeToDate", "addDays", "formatLocalDateKey", "buildSweepKey", "buildMovedCurbKey"];
  const sandbox = {
    state: { movedSweepKeys: [] },
    getReminderSets: () => [{ id: "s", name: "S", reminders: {}, segments: [denver] }],
    getSegmentsForSavedSet: (set) => set.segments,
    isCurbCoveredByParkedCar: () => false,
    getNextSweepDate: () => sandboxNext
  };
  vm.createContext(sandbox);
  vm.runInContext([APP_LINES.slice(constantsStart, constantsEnd + 1).join("\n"), ...names.map(extractFunctionBlock), "this.__fn = getPendingSweepChecks;"].join("\n"), sandbox);
  assert.equal(plain(sandbox.__fn(new Date(2099, 2, 3, 15, 0))).length, 1);
});

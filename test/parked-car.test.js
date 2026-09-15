"use strict";

// The parking pin: "Park here" drops a pin, and reminders follow that curb until the car is moved.
//
// Like test/sweep-follow-ups.test.js, this reads public/app.js as source text and lifts functions out
// into a sandbox, because the client has no module boundary. Renaming these functions will break this
// test even when behavior is unchanged; update the names alongside the code. See "The parking pin"
// in AGENTS.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");
const SCHEDULER_PATH = path.join(__dirname, "..", "ios", "CurbAlerts", "ReminderScheduler.swift");
const APP_LINES = fs.readFileSync(APP_PATH, "utf8").split("\n");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);

  let end = start;
  while (end < APP_LINES.length && APP_LINES[end] !== "}") {
    end += 1;
  }
  assert.ok(end < APP_LINES.length, `could not find the end of function ${name}`);

  return APP_LINES.slice(start, end + 1).join("\n");
}

function extractConstantLine(name) {
  const line = APP_LINES.find((candidate) => candidate.startsWith(`const ${name} = `));
  assert.ok(line, `could not find const ${name} in public/app.js`);
  return line;
}

function runInSandbox(sandbox, { constants = [], functions = [], blocks = [] }) {
  const source = [
    ...blocks,
    ...constants.map(extractConstantLine),
    ...functions.map(extractFunctionBlock),
    // Top-level const bindings do not become sandbox properties, so the ones a test reads are
    // copied onto it explicitly.
    "this.__exports = { " + functions.join(", ") + " };"
  ].join("\n");
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.__exports;
}

// Far enough out that nothing is filtered as already past due.
const SWEEP = new Date(2099, 2, 10, 0, 0, 0, 0);
const NEXT_SWEEP = new Date(2099, 3, 14, 0, 0, 0, 0);

test("a pin picks the nearest curb, and the curb across the street is the one-tap correction", () => {
  const centreLat = 39.762;
  const curbs = [
    { id: "way-1:north", sideKey: "north", sideLabel: "North curb", geometry: [[centreLat + 0.000035, -105.03], [centreLat + 0.000035, -105.028]] },
    { id: "way-1:south", sideKey: "south", sideLabel: "South curb", geometry: [[centreLat - 0.000035, -105.03], [centreLat - 0.000035, -105.028]] },
    // Lowell, a few hundred metres west, is well outside the search radius.
    { id: "way-2:east", sideKey: "east", sideLabel: "East curb", geometry: [[39.761, -105.0339], [39.763, -105.0339]] }
  ];

  const sandbox = { state: { curbSegments: curbs } };
  const { findParkingCurbCandidates, getOppositeCurb } = runInSandbox(sandbox, {
    constants: [
      "PARKING_SEARCH_RADIUS_METRES",
      "PARKING_SIDE_OPPOSITES",
      "SEARCH_METRES_PER_DEGREE_LATITUDE",
      "SEARCH_METRES_PER_DEGREE_LONGITUDE"
    ],
    functions: [
      "findParkingCurbCandidates",
      "getOppositeCurb",
      "getSegmentById",
      "getCachedRenderBounds",
      "getRenderBounds",
      "getDistanceToGeometryEdgeMetres"
    ]
  });

  // Two metres north of the centreline: the north curb is nearer, the south curb is still in range.
  // Spread into this realm's Array; deepStrictEqual will not equate the sandbox's with ours.
  const candidates = [...findParkingCurbCandidates([centreLat + 0.00002, -105.029])];
  assert.deepEqual(
    candidates.map((candidate) => candidate.segment.id),
    ["way-1:north", "way-1:south"]
  );
  assert.equal(getOppositeCurb(candidates[0].segment).id, "way-1:south");
  assert.equal(getOppositeCurb(curbs[2]), null, "a curb whose other side is not loaded has nothing to offer");

  assert.equal(findParkingCurbCandidates([39.78, -105.0]).length, 0, "a pin nowhere near a curb resolves to nothing");
});

function loadJobs({ parkedCar, savedSets, movedSweepKeys = [] }) {
  const sandbox = {
    state: { parkedCar, savedSets, movedSweepKeys, notificationJobs: [] },
    getSegmentsForSavedSet: (set) => set.segments,
    getUpcomingSweepDates: (segment) => segment.dates,
    saveJson: () => {},
    NOTIFICATION_JOBS_KEY: "test-notification-jobs"
  };

  const constantsStart = APP_LINES.findIndex((line) => line.startsWith("const DEFAULT_DAY_OF_REMINDERS = ["));
  const constantsEnd = APP_LINES.findIndex((line) => line.startsWith("const JOB_KIND_URGENCY = "));
  const { buildNotificationJobs } = runInSandbox(sandbox, {
    blocks: [APP_LINES.slice(constantsStart, constantsEnd + 1).join("\n")],
    functions: [
      "buildNotificationJobs",
      "getReminderSets",
      "isCurbCoveredByParkedCar",
      "buildDefaultReminders",
      "isValidTimeValue",
      "buildDayOfReminderSlots",
      "applyTimeToDate",
      "addDays",
      "formatLocalDateKey",
      "buildSweepKey",
      "buildMovedCurbKey",
      "buildSweepCheckUrl",
      "getJobKind",
      "buildJobTitle",
      "buildJobBody",
      "formatSegmentPreview",
      "isDayBeforeJob"
    ]
  });

  buildNotificationJobs();
  return JSON.parse(JSON.stringify(sandbox.state.notificationJobs));
}

test("a pin reminds like a saved set, and a saved set on the same curb does not remind twice", () => {
  const curb = { id: "seg-1", street: "BLAKE ST", sideLabel: "North curb", dates: [SWEEP] };
  const parkedCar = { id: "parked-1", kind: "parked", name: "Where you parked", reminders: {}, segments: [curb] };
  const home = { id: "set-home", name: "Home block", reminders: {}, segments: [curb] };

  const jobs = loadJobs({ parkedCar, savedSets: [home] });

  assert.equal(jobs.length, 5, "the default five reminders, once");
  assert.ok(jobs.every((job) => job.setId === "parked-1"));
  assert.ok(jobs.every((job) => job.sweepKeys.join() === "parked-1|2099-03-10"));
  assert.ok(jobs.every((job) => job.url === `/?moved=${encodeURIComponent("parked-1|2099-03-10")}`));
  assert.match(jobs[0].body, /where you parked/);

  const withoutPin = loadJobs({ parkedCar: null, savedSets: [home] });
  assert.ok(withoutPin.length === 5 && withoutPin.every((job) => job.setId === "set-home"), "the saved set's reminders are only lent to the pin");
});

function loadRelease({ parkedCar, savedSets, movedSweepKeys }) {
  const writes = new Map();
  const sandbox = {
    state: { parkedCar, savedSets, movedSweepKeys, parkSheetOpen: true },
    getSegmentsForSavedSet: (set) => set.segments,
    getUpcomingSweepDates: (segment) => segment.dates,
    saveJson: (key, value) => writes.set(key, value)
  };

  const { releaseParkedCarIfMoved } = runInSandbox(sandbox, {
    constants: ["MOVED_SWEEPS_KEY", "PARKED_CAR_KEY"],
    functions: ["releaseParkedCarIfMoved", "buildMovedCurbKey"]
  });

  const released = releaseParkedCarIfMoved();
  return { released, state: sandbox.state, writes };
}

test("moving the car ends the pin, and the curb it held stays quiet for that sweep only", () => {
  const pinned = { id: "seg-1", street: "BLAKE ST", sideLabel: "North curb", dates: [SWEEP, NEXT_SWEEP] };
  const parkedCar = { id: "parked-1", kind: "parked", name: "Where you parked", reminders: {}, segments: [pinned] };
  const home = { id: "set-home", name: "Home block", reminders: {}, segments: [pinned] };
  // Work also covers a second curb swept the same day, which still needs its warning.
  const work = {
    id: "set-work",
    name: "Work",
    reminders: {},
    segments: [pinned, { id: "seg-9", street: "34TH ST", sideLabel: "East curb", dates: [SWEEP] }]
  };

  const { released, state, writes } = loadRelease({
    parkedCar,
    savedSets: [home, work],
    movedSweepKeys: ["parked-1|2099-03-10"]
  });

  assert.equal(state.parkedCar, null);
  assert.equal(state.parkSheetOpen, false);
  assert.equal(writes.get("denver-curb-alerts-parked-car"), null);
  assert.equal(released.parkedCar.id, "parked-1", "what was released comes back so Undo can restore it");
  assert.deepEqual([...released.carriedKeys], ["moved-curb|seg-1|2099-03-10"]);
  assert.deepEqual([...state.movedSweepKeys], ["parked-1|2099-03-10", "moved-curb|seg-1|2099-03-10"]);

  // What the saved sets do once the pin is gone.
  const movedSweepKeys = [...state.movedSweepKeys];
  const jobs = loadJobs({ parkedCar: null, savedSets: [home, work], movedSweepKeys });
  const jobsFor = (setId, dateKey) => jobs.filter((job) => job.sweepKeys.includes(`${setId}|${dateKey}`));

  assert.equal(jobsFor("set-home", "2099-03-10").length, 0, "Home has nothing left to warn about for the sweep the car moved for");
  assert.equal(jobsFor("set-work", "2099-03-10").length, 5, "Work still warns about its other curb");
  assert.ok(
    jobsFor("set-work", "2099-03-10").every((job) => job.segmentIds.join() === "seg-9"),
    "and no longer names the curb the car just left"
  );
  assert.equal(jobsFor("set-home", "2099-04-14").length, 5, "the next sweep is the saved set's again");

  // Parking on the same curb again that day is a new parking, and it reminds.
  const repinned = loadJobs({
    parkedCar: { id: "parked-2", kind: "parked", name: "Where you parked", reminders: {}, segments: [pinned] },
    savedSets: [home],
    movedSweepKeys
  });
  assert.equal(repinned.filter((job) => job.sweepKeys.includes("parked-2|2099-03-10")).length, 5);
});

test("a pin stays down until one of its own sweeps is confirmed", () => {
  const parkedCar = { id: "parked-1", kind: "parked", segments: [{ id: "seg-1", dates: [SWEEP] }] };

  const untouched = loadRelease({ parkedCar, savedSets: [], movedSweepKeys: ["set-home|2099-03-10"] });
  assert.equal(untouched.released, null);
  assert.equal(untouched.state.parkedCar, parkedCar);

  // An older pin's confirmation, still in the list, must not end the new one.
  const newer = loadRelease({ parkedCar, savedSets: [], movedSweepKeys: ["parked-0|2099-03-10"] });
  assert.equal(newer.released, null);
});

test("the pin stays on the device, and every way a confirmation arrives ends it", () => {
  const app = APP_LINES.join("\n");

  // The plan the server holds names curbs, never coordinates: nothing in it reads a set's pin.
  assert.doesNotMatch(extractFunctionBlock("buildReminderPlanPayload"), /\.pin\b/);
  assert.match(extractFunctionBlock("buildReminderPlanPayload"), /savedSets: getReminderSets\(\)/);
  // And the account library is built from saved sets alone.
  assert.doesNotMatch(extractFunctionBlock("getLocalSavedSetsForAccount"), /PARKED_CAR_KEY/);

  // A confirmation from the lock screen arrives while the page is not running, so the page has to
  // release the pin on render rather than only from its own button.
  assert.match(extractFunctionBlock("renderAll"), /releaseParkedCarIfMoved\(\)/);
  assert.match(app, /typeof nativeBridge\?\.getCurrentPosition === "function"/);

  // And the device stops reminding about a pin the car has left before the page ever opens.
  const scheduler = fs.readFileSync(SCHEDULER_PATH, "utf8");
  assert.ok(scheduler.includes('key.hasPrefix("parked-")'), "the scheduler no longer releases a moved pin");
  assert.ok(scheduler.includes("let moved = effectiveMovedSweepKeys()"), "the scheduler no longer uses the released pins");
});

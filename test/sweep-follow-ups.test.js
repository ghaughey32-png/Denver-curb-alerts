"use strict";

// The follow-up reminders that keep going until the driver taps "I moved my car".
//
// Like test/address-search.test.js, this reads public/app.js as source text and lifts the job
// builder out into a sandbox, because the client has no module boundary. Renaming these functions
// or the constants block will break this test even when behavior is unchanged; update the markers
// alongside the code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");
const SW_PATH = path.join(__dirname, "..", "public", "sw.js");

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

function loadJobBuilder(savedSets, movedSweepKeys = []) {
  const lines = fs.readFileSync(APP_PATH, "utf8").split("\n");
  const constantsStart = lines.findIndex((line) => line.startsWith("const DEFAULT_DAY_OF_REMINDERS = ["));
  const constantsEnd = lines.findIndex((line) => line.startsWith("const JOB_KIND_URGENCY = "));
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, "could not find the reminder constants in public/app.js");

  const functions = [
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
  ];

  const source = [
    lines.slice(constantsStart, constantsEnd + 1).join("\n"),
    ...functions.map((name) => extractFunctionBlock(lines, name)),
    "buildNotificationJobs();"
  ].join("\n");

  const sandbox = {
    state: { savedSets, movedSweepKeys, notificationJobs: [], parkedCar: null },
    getSegmentsForSavedSet: (set) => set.segments,
    getUpcomingSweepDates: (segment) => segment.dates,
    saveJson: () => {},
    NOTIFICATION_JOBS_KEY: "test-notification-jobs"
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  // Arrays built inside the sandbox carry that realm's Array prototype, which deepStrictEqual
  // refuses to equate with ours. A JSON round trip is also exactly what the plan sync sends.
  return JSON.parse(JSON.stringify(sandbox.state.notificationJobs));
}

// Far enough out that nothing is filtered as already past due.
const SWEEP = new Date(2099, 2, 10, 0, 0, 0, 0);
const NEXT_SWEEP = new Date(2099, 3, 14, 0, 0, 0, 0);

function buildSet(overrides = {}) {
  return {
    id: "set-home",
    name: "Home block",
    reminders: {},
    segments: [{ id: "seg-1", street: "BLAKE ST", sideLabel: "Left side", dates: [SWEEP, NEXT_SWEEP] }],
    ...overrides
  };
}

function localStamp(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("by default a sweep reminds five times, getting firmer, and every alert links to its sweep", () => {
  const jobs = loadJobBuilder([buildSet()]).filter((job) => job.sweepKeys.includes("set-home|2099-03-10"));

  assert.deepEqual(
    jobs.map((job) => [localStamp(job.scheduledAt), job.title]),
    [
      ["03-09 18:00", "Move your car tomorrow"],
      ["03-09 21:00", "Did you move your car yet?"],
      ["03-10 07:00", "Move your car today"],
      ["03-10 07:30", "Your car still needs to move"],
      ["03-10 08:00", "Last reminder: move your car now"]
    ]
  );

  for (const job of jobs) {
    assert.equal(job.url, `/?moved=${encodeURIComponent("set-home|2099-03-10")}`);
  }
  assert.match(jobs[0].body, /Open this and tap I moved my car/);
});

test("confirming a sweep drops every reminder left for it, and only for it", () => {
  const jobs = loadJobBuilder([buildSet()], ["set-home|2099-03-10"]);

  assert.equal(jobs.filter((job) => job.sweepKeys.includes("set-home|2099-03-10")).length, 0);
  assert.equal(jobs.filter((job) => job.sweepKeys.includes("set-home|2099-04-14")).length, 5);
});

test("turning Keep reminding me off restores the original two reminders", () => {
  const jobs = loadJobBuilder([buildSet({ reminders: { nagUntilMoved: false } })]).filter((job) =>
    job.sweepKeys.includes("set-home|2099-03-10")
  );

  assert.deepEqual(
    jobs.map((job) => localStamp(job.scheduledAt)),
    ["03-09 18:00", "03-10 07:00"]
  );
  assert.doesNotMatch(jobs[0].body, /I moved my car/);
});

test("the follow-ups hang off the earliest enabled morning slot, and a late evening skips the check-in", () => {
  const jobs = loadJobBuilder([
    buildSet({
      reminders: {
        dayBeforeTime: "22:00",
        dayOfReminders: [
          { enabled: false, time: "07:00" },
          { enabled: true, time: "09:00" },
          { enabled: false, time: "11:00" }
        ]
      }
    })
  ]).filter((job) => job.sweepKeys.includes("set-home|2099-03-10"));

  assert.deepEqual(
    jobs.map((job) => localStamp(job.scheduledAt)),
    ["03-09 22:00", "03-10 09:00", "03-10 09:30", "03-10 10:00"]
  );
});

test("two curb sides swept the same day share one alert per time rather than doubling the nagging", () => {
  const set = buildSet();
  set.segments.push({ id: "seg-2", street: "34TH ST", sideLabel: "Right side", dates: [SWEEP] });

  const jobs = loadJobBuilder([set]).filter((job) => job.sweepKeys.includes("set-home|2099-03-10"));
  assert.equal(jobs.length, 5);
  assert.deepEqual(jobs[2].segmentLabels, ["BLAKE ST - Left side", "34TH ST - Right side"]);
});

test("the native shell gets what its lock-screen button needs, and the page hears back from it", () => {
  // The iOS shell schedules reminders on the device and silences a sweep from the lock screen while
  // this page may not be running. Both halves break silently if these drift, because a page with no
  // shell never exercises them. See "The iOS project" in AGENTS.md.
  const app = fs.readFileSync(APP_PATH, "utf8");
  assert.match(app, /sweepKeys: Array\.isArray\(job\.sweepKeys\) \? \[\.\.\.job\.sweepKeys\] : \[\]/);
  assert.match(app, /await bridge\.scheduleReminders\(jobs, \{ movedSweepKeys \}\)/);
  assert.match(app, /window\.DenverCurbAlertsNative\?\.movedSweepKeys/);
  assert.match(app, /window\.addEventListener\("curb-alerts-native"/);
  for (const type of ["open-url", "sweep-moved", "permission-changed"]) {
    assert.ok(app.includes(`detail.type === "${type}"`), `the page no longer handles the shell's ${type} event`);
  }

  const shell = fs.readFileSync(path.join(__dirname, "..", "ios", "CurbAlerts", "WebShell.swift"), "utf8");
  assert.ok(shell.includes("curb-alerts-native"), "the shell no longer dispatches the event the page listens for");
  assert.ok(shell.includes("movedSweepKeys: (options && options.movedSweepKeys)"), "the shell's bridge dropped movedSweepKeys");

  // "Use my location" inside the app. The page's own geolocation is refused on the shell's custom
  // scheme, so the button only works if both halves of this route survive.
  assert.match(app, /typeof nativeBridge\?\.getCurrentPosition === "function"/);
  assert.ok(shell.includes('case "getCurrentPosition":'), "the shell no longer answers location requests");
});

test("a notification tap reaches an app that is already open", () => {
  // Focusing an existing window does not navigate it, so without the message the /?moved= link on
  // the reminder was silently thrown away whenever the app was already running.
  const serviceWorker = fs.readFileSync(SW_PATH, "utf8");
  assert.match(serviceWorker, /postMessage\(\{ type: "curb-alert-notification-click", url: targetUrl \}\)/);

  const app = fs.readFileSync(APP_PATH, "utf8");
  assert.match(app, /event\.data\?\.type === "curb-alert-notification-click"/);
  assert.match(app, /url: job\.url \|\| "\/"/);
});

"use strict";

// The reminder planner for San Francisco curbs: overnight windows remind the evening before, daytime
// windows keep Denver's model, uncertain days carry hedged wording, and a set can hold curbs from both
// cities. Like test/sweep-follow-ups.test.js this lifts the job builder out of public/app.js as source
// text, so renaming these functions breaks it even when behaviour is unchanged.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SfSchedule = require("../public/sf-schedule.js");

const APP_LINES = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").split("\n");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

const FUNCTIONS = [
  "buildNotificationJobs",
  "getReminderSets",
  "isCurbCoveredByParkedCar",
  "buildDefaultReminders",
  "isValidTimeValue",
  "buildDayOfReminderSlots",
  "buildOvernightReminderSlots",
  "applyTimeToDate",
  "addDays",
  "formatLocalDateKey",
  "buildSweepKey",
  "buildMovedCurbKey",
  "buildSweepCheckUrl",
  "getJobKind",
  "buildJobTitle",
  "buildJobBody",
  "getHedgedJobCopy",
  "formatSegmentPreview",
  "isDayBeforeJob",
  "getReminderEntriesForSegment",
  "getSfReminderEntries",
  "buildSweepCandidates",
  "buildOvernightCandidates"
];

function loadPlanner({ savedSets, today, movedSweepKeys = [] }) {
  const constantsStart = APP_LINES.findIndex((line) => line.startsWith("const DEFAULT_DAY_OF_REMINDERS = ["));
  const constantsEnd = APP_LINES.findIndex((line) => line.startsWith("const JOB_KIND_URGENCY = "));
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, "could not find the reminder constants in public/app.js");

  const sandbox = {
    window: { SfSchedule },
    state: { savedSets, movedSweepKeys, notificationJobs: [], parkedCar: null },
    getSegmentsForSavedSet: (set) => set.segments,
    // Denver's dates are baked into the saved curb; an SF curb's are never read through here for jobs.
    getUpcomingSweepDates: (segment) => segment.dates || [],
    getStartOfToday: () => today,
    saveJson: () => {},
    NOTIFICATION_JOBS_KEY: "test-notification-jobs"
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [APP_LINES.slice(constantsStart, constantsEnd + 1).join("\n"), ...FUNCTIONS.map(extractFunctionBlock), "buildNotificationJobs();"].join("\n"),
    sandbox
  );
  return JSON.parse(JSON.stringify(sandbox.state.notificationJobs));
}

// March 2099 starts on a Sunday, so its Tuesdays are the 3rd, 10th, 17th, 24th and 31st (the 5th). Far
// enough out that nothing is filtered as already past.
const TODAY = new Date(2099, 2, 1);
const everyTuesday = (extra) => ({ days: [2], weeks: [1, 2, 3, 4, 5], holidays: true, nightBefore: false, week5Unconfirmed: false, startHour: 8, endHour: 10, ...extra });
const overnight = () => everyTuesday({ startHour: 0, endHour: 2, nightBefore: true });

const sfCurb = (id, schedules, street = "Valencia St") => ({
  id,
  street,
  sideLabel: "East curb",
  schedule: { sweepType: "Scheduled", cityId: "san-francisco", sf: schedules, allDates: [], rule: "" }
});
const denverCurb = (id, dates) => ({ id, street: "W 32ND AVE", sideLabel: "North curb", dates, schedule: { sweepType: "Scheduled", allDates: [] } });
const savedSet = (segments, reminders = {}) => ({ id: "set-my-curbs", name: "My curbs", reminders, segments });
const times = (jobs) => jobs.map((job) => [job.scheduledAt, job.kinds.join("+")]);
const local = (year, month, day, hour, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();

test("an overnight curb reminds the evening before at 6 and 8 pm, and never on the sweep day", () => {
  const jobs = loadPlanner({ savedSets: [savedSet([sfCurb("sf:a", [overnight()])])], today: TODAY });
  const march3 = jobs.filter((job) => job.sweepKeys.includes("set-my-curbs|2099-03-03"));

  assert.deepEqual(times(march3), [
    [local(2099, 3, 2, 18), "night-before"],
    [local(2099, 3, 2, 20), "night-before"]
  ]);
  assert.equal(march3[0].title, "Move your car tonight");
  assert.match(march3[0].body, /Overnight street sweeping is scheduled for Valencia St - East curb/);
  assert.ok(jobs.every((job) => !job.kinds.some((kind) => ["day-of", "follow-up", "last-call", "day-before", "evening-check"].includes(kind))));
});

test("the third overnight slot is the user's to turn on, and keep-reminding off leaves only the first", () => {
  const curb = sfCurb("sf:a", [overnight()]);
  const three = loadPlanner({
    savedSets: [savedSet([curb], { overnightReminders: [{}, {}, { enabled: true }] })],
    today: TODAY
  }).filter((job) => job.sweepKeys.includes("set-my-curbs|2099-03-03"));
  assert.deepEqual(three.map((job) => job.scheduledAt), [local(2099, 3, 2, 18), local(2099, 3, 2, 20), local(2099, 3, 2, 22)]);

  const quiet = loadPlanner({ savedSets: [savedSet([curb], { nagUntilMoved: false })], today: TODAY }).filter((job) =>
    job.sweepKeys.includes("set-my-curbs|2099-03-03")
  );
  assert.deepEqual(quiet.map((job) => job.scheduledAt), [local(2099, 3, 2, 18)]);
});

test("a daytime SF curb gets exactly the plan a Denver curb gets for the same day", () => {
  const sf = loadPlanner({ savedSets: [savedSet([sfCurb("sf:a", [everyTuesday()])])], today: TODAY });
  const denver = loadPlanner({ savedSets: [savedSet([denverCurb("way:north", [new Date(2099, 2, 3), new Date(2099, 2, 10)])])], today: TODAY });
  const forDay = (jobs) => times(jobs.filter((job) => job.sweepKeys.includes("set-my-curbs|2099-03-03")));

  assert.deepEqual(forDay(sf), forDay(denver));
  assert.deepEqual(
    forDay(sf).map(([, kind]) => kind),
    ["day-before", "evening-check", "day-of", "follow-up", "last-call"]
  );
});

test("a set holding a Denver curb and an overnight SF curb groups jobs that fall at the same minute", () => {
  const jobs = loadPlanner({
    savedSets: [savedSet([denverCurb("way:north", [new Date(2099, 2, 3)]), sfCurb("sf:a", [overnight()])])],
    today: TODAY
  });
  const sixPm = jobs.find((job) => job.scheduledAt === local(2099, 3, 2, 18));

  assert.deepEqual(sixPm.segmentIds.sort(), ["sf:a", "way:north"]);
  assert.deepEqual(sixPm.kinds.sort(), ["day-before", "night-before"]);
  // The later stage's copy wins, and it is the one that is true for the overnight curb.
  assert.equal(sixPm.title, "Move your car tonight");
  // 9 pm check-in and the 7 am follow-ups belong to Denver's curb only.
  assert.equal(jobs.find((job) => job.scheduledAt === local(2099, 3, 2, 21)).segmentIds.join(), "way:north");
  assert.equal(jobs.find((job) => job.scheduledAt === local(2099, 3, 3, 7)).segmentIds.join(), "way:north");
});

test("confirming the sweep silences both cities' jobs for that day, and only that day", () => {
  const jobs = loadPlanner({
    savedSets: [savedSet([denverCurb("way:north", [new Date(2099, 2, 3)]), sfCurb("sf:a", [overnight()])])],
    today: TODAY,
    movedSweepKeys: ["set-my-curbs|2099-03-03"]
  });

  assert.ok(jobs.every((job) => !job.sweepKeys.includes("set-my-curbs|2099-03-03")));
  assert.ok(jobs.some((job) => job.sweepKeys.includes("set-my-curbs|2099-03-10")), "the next week's reminders carry on");
});

test("a 5th Tuesday the data cannot confirm gets hedged wording, never a plain all-clear or silence", () => {
  const unconfirmed = everyTuesday({ weeks: [2, 4], week5Unconfirmed: true });
  const jobs = loadPlanner({ savedSets: [savedSet([sfCurb("sf:a", [unconfirmed])])], today: new Date(2099, 2, 25) });
  const march31 = jobs.filter((job) => job.sweepKeys.includes("set-my-curbs|2099-03-31"));

  assert.ok(march31.length > 0);
  assert.ok(march31.every((job) => job.hedge === "fifth-week"));
  const dayBefore = march31.find((job) => job.kinds.includes("day-before"));
  assert.equal(dayBefore.title, "⚠️ Sweeping may happen tomorrow");
  assert.match(dayBefore.body, /may happen tomorrow \(a 5th-week day\) on Valencia St - East curb\. .*Check the sign, and move your car to be safe/);
});

test("a window that lists the 5th week confirms the day another window only hedges", () => {
  const evenWeeks = everyTuesday({ weeks: [2, 4], week5Unconfirmed: true });
  const oddWeeks = everyTuesday({ weeks: [1, 3, 5] });
  const jobs = loadPlanner({ savedSets: [savedSet([sfCurb("sf:a", [evenWeeks, oddWeeks])])], today: new Date(2099, 2, 25) });
  const march31 = jobs.filter((job) => job.sweepKeys.includes("set-my-curbs|2099-03-31"));

  assert.ok(march31.length > 0);
  assert.ok(march31.every((job) => job.hedge === null && job.title !== "⚠️ Sweeping may happen tomorrow"));
});

test("a hedged curb sharing a job with a confirmed one gets the plain wording", () => {
  const unconfirmed = everyTuesday({ weeks: [2, 4], week5Unconfirmed: true });
  const jobs = loadPlanner({
    savedSets: [savedSet([sfCurb("sf:a", [unconfirmed]), sfCurb("sf:b", [everyTuesday()], "Mission St")])],
    today: new Date(2099, 2, 25)
  });
  const dayBefore = jobs.find((job) => job.scheduledAt === local(2099, 3, 30, 18));

  assert.deepEqual(dayBefore.segmentIds.sort(), ["sf:a", "sf:b"]);
  assert.equal(dayBefore.hedge, null);
  assert.equal(dayBefore.title, "Move your car tomorrow");
});

test("a holiday the street is usually spared reminds with the double-check message", () => {
  const [, mlk] = SfSchedule.getSweepingHolidays(2099);
  const { year, month, day } = SfSchedule.parseDate(mlk);
  const monday = everyTuesday({ days: [1], holidays: false });
  const jobs = loadPlanner({ savedSets: [savedSet([sfCurb("sf:a", [monday])])], today: new Date(year, month - 1, day - 6) });
  const holidayJobs = jobs.filter((job) => job.sweepKeys.includes(`set-my-curbs|${mlk}`));

  assert.ok(holidayJobs.length > 0);
  const dayBefore = holidayJobs.find((job) => job.kinds.includes("day-before"));
  assert.equal(dayBefore.hedge, "holiday");
  assert.equal(dayBefore.title, "🗓️ Holiday tomorrow: probably no sweeping");
  assert.match(dayBefore.body, /Tomorrow is a holiday\. Street sweeping is usually skipped on .*double-check the posted sign/);
});

test("the overnight times are normalised like the day-of slots", () => {
  const sandbox = {};
  const constantsStart = APP_LINES.findIndex((line) => line.startsWith("const DEFAULT_DAY_OF_REMINDERS = ["));
  const constantsEnd = APP_LINES.findIndex((line) => line.startsWith("const JOB_KIND_URGENCY = "));
  vm.createContext(sandbox);
  vm.runInContext(
    [
      APP_LINES.slice(constantsStart, constantsEnd + 1).join("\n"),
      ...["buildDefaultReminders", "isValidTimeValue", "buildDayOfReminderSlots", "buildOvernightReminderSlots"].map(extractFunctionBlock),
      "this.__fn = buildDefaultReminders;"
    ].join("\n"),
    sandbox
  );
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(sandbox.__fn({}).overnightReminders), [
    { enabled: true, time: "18:00" },
    { enabled: true, time: "20:00" },
    { enabled: false, time: "22:00" }
  ]);
  assert.deepEqual(plain(sandbox.__fn({ overnightReminders: [{ time: "nope" }, { enabled: false }, { enabled: true, time: "23:30" }] }).overnightReminders), [
    { enabled: true, time: "18:00" },
    { enabled: false, time: "20:00" },
    { enabled: true, time: "23:30" }
  ]);
});

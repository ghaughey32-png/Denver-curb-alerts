"use strict";

// Retiring the website's sweep reminders once the iPhone app is live. The rule this protects is the
// same one the app's warnings do: reminders never stop silently. Every device with reminders hears
// once that they are ending and once that they have stopped, and nobody is written to about losing
// reminders they never had.

const test = require("node:test");
const assert = require("node:assert/strict");

const { getWebReminderRetirement, planRetirementNotice } = require("../lib/web-reminders.js");
const { getCity } = require("../public/cities.js");

const END = "2026-10-15T00:00:00-06:00";
const BEFORE = new Date("2026-10-01T12:00:00-06:00");
const AFTER = new Date("2026-10-16T12:00:00-06:00");

function plan(fields = {}) {
  return { endpoint: "https://push.example/1", jobs: [{ id: "j", scheduledAt: "2026-10-20T13:00:00Z" }], ...fields };
}

test("the website's reminders are not retiring until the city record says when", () => {
  assert.equal(getCity("denver").webRemindersEndAt, null);
  assert.equal(getWebReminderRetirement(null, BEFORE), null);
  assert.equal(planRetirementNotice(plan(), null, BEFORE), null);
});

test("a typo in the end date switches nothing off", () => {
  assert.equal(getWebReminderRetirement("mid October", BEFORE), null);
});

test("before the end, a device with reminders is warned once, naming the day", () => {
  const retirement = getWebReminderRetirement(END, BEFORE);
  assert.equal(retirement.ended, false);

  const notice = planRetirementNotice(plan(), retirement, BEFORE);
  assert.equal(notice.field, "webRetirementWarnedAt");
  assert.match(notice.payload.body, /end Thursday, Oct 15\./);

  assert.equal(planRetirementNotice(plan({ webRetirementWarnedAt: BEFORE.toISOString() }), retirement, BEFORE), null);
});

test("nobody is told they are losing reminders they do not have", () => {
  const retirement = getWebReminderRetirement(END, BEFORE);
  assert.equal(planRetirementNotice(plan({ jobs: [] }), retirement, BEFORE), null);
  assert.equal(planRetirementNotice(plan({ jobs: [] }), getWebReminderRetirement(END, AFTER), AFTER), null);
});

test("at the end, a warned device hears once that its reminders stopped", () => {
  const retirement = getWebReminderRetirement(END, AFTER);
  assert.equal(retirement.ended, true);

  const warned = plan({ jobs: [], webRetirementWarnedAt: BEFORE.toISOString() });
  const notice = planRetirementNotice(warned, retirement, AFTER);
  assert.equal(notice.field, "webRetirementEndedAt");
  assert.match(notice.payload.title, /stopped/);

  assert.equal(planRetirementNotice({ ...warned, webRetirementEndedAt: AFTER.toISOString() }, retirement, AFTER), null);
});

test("a device that missed the warning still hears that reminders stopped", () => {
  const notice = planRetirementNotice(plan(), getWebReminderRetirement(END, AFTER), AFTER);
  assert.equal(notice.field, "webRetirementEndedAt");
});

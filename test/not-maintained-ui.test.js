const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

test("not-maintained Denver routes have a distinct gray informational state", () => {
  assert.match(app, /notMaintained: "#7b8790"/);
  assert.match(app, /sweepType: notMaintained \? "NotMaintained"/);
  assert.match(app, /No Denver street sweeping — street not maintained by Denver/);
  assert.match(index, /Gray: no Denver sweeping — street not maintained by Denver/);
});

test("not-maintained curbs cannot create sweeping reminders", () => {
  assert.match(app, /remindersAllowed: !notMaintained/);
  assert.match(app, /Streets not maintained by Denver have no Denver sweeping schedule and cannot be saved for sweeping reminders/);
});

test("pink curbs remain reserved for unavailable information", () => {
  assert.match(app, /schedule && schedule\.sweepType !== "Unavailable"/);
  assert.match(app, /No car relocation required — tap for schedule details/);
  assert.match(index, /Pink: schedule information unavailable — tap for details/);
  assert.match(index, /We do not have reliable schedule information for this curb/);
  assert.match(index, /you do not need to move your car/);
});

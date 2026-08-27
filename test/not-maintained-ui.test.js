const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

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

// Pink is a caution state, not an all-clear. It means only that we found no sweeping
// information published by the City and County of Denver for that curb -- Denver may
// still sweep and ticket there, so every place pink is explained has to send the user
// to Denver rather than tell them to relax. "You do not need to move your car" is a
// different thing entirely: it is Denver's own relocationRequired flag on a route that
// does have a schedule, and it keeps its own notice.
test("pink curbs tell the user to check with Denver rather than that they are safe", () => {
  assert.match(app, /if \(!schedule \|\| schedule\.sweepType === "Unavailable"\) \{\s*return colors\.unavailable;/);
  assert.match(index, /Pink: no Denver sweeping schedule found — check with Denver, and use caution/);
  assert.match(index, /We did not find street sweeping information for this curb published by the City and County of Denver/);
  assert.match(app, /No Denver sweeping schedule found/);
  assert.doesNotMatch(
    app.replace(/Street sweeping is scheduled, but you do not need to move your car[^"]*/g, ""),
    /do not need to move your car/
  );
});

test("Denver's own no-relocation flag keeps its distinct all-clear notice", () => {
  assert.match(app, /No car relocation required — tap for schedule details/);
  assert.match(app, /schedule\.relocationRequired === false/);
  assert.match(index, /Street sweeping is scheduled, but you do not need to move your car/);
});

// The all-clear used to be invisible on the map -- a curb you never have to move for was drawn in
// the same side colour as one you do, and only tapping it told you apart. Plum is that state.
test("no-relocation curbs get their own colour, distinct from every other state", () => {
  assert.match(app, /noRelocation: "#8e44ad"/);
  assert.match(index, /Plum: swept on a schedule, but you do not need to move your car/);
  assert.match(styles, /\.plum \{\s*background: #8e44ad;/);
  // One colour decision, shared by the live and embedded datasets, so they cannot drift.
  assert.match(app, /function getCurbColor\(schedule, sideColor\)/);
  assert.equal(app.match(/getCurbColor\(/g).length, 3);
  assert.doesNotMatch(app, /color: scheduleInfo \? sideDef\.color : colors\.unavailable/);
});

// Denver posts signs where it enforces, so posting -- not sweep type -- is what decides whether a
// driver can be ticketed. The Weekly branch used to skip the check entirely and told drivers on
// 395 routes Denver marks IsPosted:true that they never had to move.
test("a posted route is never presented as no-relocation, whatever its sweep type", () => {
  // isPosted gates the whole predicate, not just one branch of it.
  assert.match(app, /route\.isPosted === false &&\s*\(route\.sweepType === "Weekly" \|\|/);
  // The old form, where a Weekly route reached `false` without isPosted ever being consulted.
  assert.doesNotMatch(app, /sweepType === "Scheduled" && route\.isPosted === false && !route\.sourceNote/);
});

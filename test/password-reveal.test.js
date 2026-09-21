const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function revealButtonRule() {
  const match = styles.match(/\.password-reveal-button \{([^}]*)\}/);
  assert.ok(match, "public/styles.css no longer has a .password-reveal-button rule");
  return match[1];
}

// Reported 2026-09-21 from a real password reset. The button was 60x35 floating in the middle of a
// 52px field, which left a ~9px strip above and below it that is still inside the input's own box.
// A tap landing there hit the input: the field took focus and nothing was revealed, so the button
// read as broken -- and then worked on the second try, now that the field was focused, which is
// exactly how it was described. Confirmed by restoring the old geometry in a browser and clicking
// the same point: the click focused the input and the button did not toggle.
//
// Centring it again brings that back, and `top: 50%` with a translate is the obvious way anybody
// would write this, so it is worth a test rather than a comment. Insetting top and bottom keeps the
// target the height of whatever field it is in, which clears the 44px minimum on all of them.
test("the reveal button fills its field rather than floating in the middle of it", () => {
  const rule = revealButtonRule();

  assert.match(rule, /top:\s*2px/);
  assert.match(rule, /bottom:\s*2px/);
  assert.doesNotMatch(rule, /transform:\s*translateY/);
});

// setPasswordRevealed looks its input up with getElementById and returns early when there is none,
// so a button naming an id that does not exist is a silent no-op rather than an error.
test("every reveal button points at a password input that exists", () => {
  const targets = [...index.matchAll(/data-password-reveal="([^"]+)"/g)].map((match) => match[1]);

  assert.ok(targets.length >= 5, `expected the account forms' reveal buttons, found ${targets.length}`);

  for (const id of targets) {
    assert.ok(index.includes(`id="${id}"`), `no input with id="${id}" for its reveal button`);
  }
});

// The same bug arriving by a different route: revealing has to be driven by the button's own
// pressed state, never by which element happens to have focus.
test("revealing is driven by the button's own state, not by focus", () => {
  assert.match(
    app,
    /button\.addEventListener\("click", \(\) => \{\s*setPasswordRevealed\(button, button\.getAttribute\("aria-pressed"\) !== "true"\);/
  );
});

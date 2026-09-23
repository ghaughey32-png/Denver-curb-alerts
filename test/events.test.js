"use strict";

// The anonymous in-app funnel (lib/events.js). What it must never do is as important as what it
// does: it counts steps and stores nothing that could lead back to a person, and it refuses anything
// that is not one of its known steps.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const events = require("../lib/events.js");
const { withServer } = require("./lib/with-server.js");

test("only the known steps are counted, and a version is a label, not free text", () => {
  assert.deepEqual(events.normalizeEvent({ event: "paywall_shown", platform: "ios", appVersion: "1.0 (9)" }), {
    event: "paywall_shown",
    platform: "ios",
    appVersion: "1.0 (9)"
  });
  assert.equal(events.normalizeEvent({ event: "drop table" }), null);
  assert.equal(events.normalizeEvent({}), null);
  assert.equal(events.normalizeEvent({ event: "app_open", platform: "android" }).platform, "web");
  assert.equal(events.normalizeAppVersion("<script>"), "unknown");
  assert.equal(events.normalizeAppVersion("web"), "web");
});

test("a count lands on the Denver day it happened, not the server's UTC one", () => {
  // 9pm on the 23rd in Denver is already the 24th in UTC.
  assert.equal(events.denverDay(new Date("2026-09-24T03:00:00Z")), "2026-09-23");
});

test("the funnel shows each step's share of the one before, and each paywall outcome's share of views", () => {
  const rows = [
    { day: "2026-10-01", event: "app_open", platform: "ios", appVersion: "1.0 (9)", count: 200 },
    { day: "2026-10-01", event: "curb_opened", platform: "ios", appVersion: "1.0 (9)", count: 120 },
    { day: "2026-10-01", event: "remind_tapped", platform: "ios", appVersion: "1.0 (9)", count: 60 },
    { day: "2026-10-01", event: "paywall_shown", platform: "ios", appVersion: "1.0 (9)", count: 50 },
    { day: "2026-10-01", event: "trial_started", platform: "ios", appVersion: "1.0 (9)", count: 10 },
    { day: "2026-10-01", event: "paywall_closed", platform: "ios", appVersion: "1.0 (9)", count: 40 }
  ];
  const { steps, outcomes } = events.summarizeFunnel(rows);

  assert.deepEqual(steps.map((step) => [step.event, step.count, step.ofPrevious]), [
    ["app_open", 200, null],
    ["curb_opened", 120, 0.6],
    ["remind_tapped", 60, 0.5],
    ["paywall_shown", 50, 50 / 60]
  ]);
  assert.equal(outcomes.find((outcome) => outcome.event === "trial_started").ofShown, 0.2);
  assert.equal(outcomes.find((outcome) => outcome.event === "paywall_closed").ofShown, 0.8);
});

test("pending counts merge into stored ones by day, step, platform and version", () => {
  const stored = [{ day: "2026-10-01", event: "app_open", platform: "ios", appVersion: "1.0 (9)", count: 3 }];
  const pending = new Map([
    ["2026-10-01|app_open|ios|1.0 (9)", 2],
    ["2026-10-01|app_open|web|web", 1]
  ]);
  const merged = events.mergeCounts(stored, pending);

  assert.equal(merged.find((row) => row.platform === "ios").count, 5);
  assert.equal(merged.find((row) => row.platform === "web").count, 1);
  assert.equal(stored[0].count, 3, "the stored rows are not mutated");
});

test("the server counts known steps, refuses the rest, and shows counts only to the admin", async () => {
  await withServer(
    async ({ call, dataDir }) => {
      for (let index = 0; index < 3; index += 1) {
        assert.equal((await call("/api/events", { method: "POST", json: { event: "app_open", platform: "ios", appVersion: "1.0 (9)" } })).status, 202);
      }
      assert.equal((await call("/api/events", { method: "POST", json: { event: "paywall_shown", platform: "ios", appVersion: "1.0 (9)" } })).status, 202);
      assert.equal((await call("/api/events", { method: "POST", json: { event: "anything_else" } })).status, 400);

      assert.equal((await call("/api/events")).status, 403);

      // Visible before the once-a-minute write, because the read includes what is pending.
      const read = await call("/api/events", { headers: { Authorization: "Bearer test-admin-token" } });
      assert.equal(read.status, 200);
      assert.equal(read.payload.funnel.steps.find((step) => step.event === "app_open").count, 3);
      assert.equal(read.payload.funnel.steps.find((step) => step.event === "paywall_shown").count, 1);

      // Nothing that identifies anyone is kept: every row is exactly a day, a step, a platform, a
      // version and a count.
      for (const row of read.payload.rows) {
        assert.deepEqual(Object.keys(row).sort(), ["appVersion", "count", "day", "event", "platform"]);
      }
      const stored = path.join(dataDir, "event-counts.json");
      assert.ok(!fs.existsSync(stored) || !/127\.0\.0\.1|::1/.test(fs.readFileSync(stored, "utf8")));
    },
    { ISSUE_REPORT_ADMIN_TOKEN: "test-admin-token" }
  );
});

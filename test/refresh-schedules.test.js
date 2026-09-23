"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectRefreshableRoutes,
  getLookupPoint,
  buildLookupPoints,
  applyRefresh,
  describeDateRange
} = require("../scripts/refresh-route-schedules.js");

// The seasonal refresh exists because build:inventory cannot do this job: its grid covers 10 of the
// 60 published areas, so a full rebuild deletes the other 50 and republishes them as pink. This
// script's one guarantee is that it can never lose coverage, so that is mostly what is tested here.

const route = (id, over = {}) => ({
  id,
  streetName: `ST ${id}`,
  sweepType: "Scheduled",
  schedules: [{ Date: "08/12/2026", Description: "Left" }],
  map: { path: [[39.74, -105.02], [39.741, -105.02], [39.742, -105.02]] },
  ...over
});

test("only routes with a real schedule and geometry are refreshed", () => {
  const routes = [
    route(1),
    route(2, { sweepType: "Unavailable" }),
    route(3, { map: { path: [] } }),
    route(4, { map: {} }),
    route(5, { sweepType: "Weekly" })
  ];

  assert.deepEqual(selectRefreshableRoutes(routes).map((r) => r.id), [1, 5]);
});

test("a route is looked up at its midpoint, not an endpoint", () => {
  // Endpoints sit on intersections, where Denver may answer about the cross street instead.
  assert.deepEqual(getLookupPoint(route(1)), [39.741, -105.02]);
});

test("lookup points skip refreshed routes, dedupe, and honour the round size", () => {
  const shared = { map: { path: [[39.74, -105.02], [39.7410004, -105.02], [39.742, -105.02]] } };
  const routes = [route(1), route(2, shared), route(3, { map: { path: [[39.8, -105.0], [39.81, -105.0], [39.82, -105.0]] } })];

  // Routes 1 and 2 share a midpoint to five decimals, so one request answers both.
  assert.equal(buildLookupPoints(routes, new Set()).length, 2);
  assert.deepEqual(buildLookupPoints(routes, new Set(["1", "2"])), [[39.81, -105.0]].map(([lat, lon]) => ({ lat, lon })));
  assert.equal(buildLookupPoints(routes, new Set(), 1).length, 1);
  assert.equal(buildLookupPoints(routes, new Set(["1", "2", "3"])).length, 0);
});

test("dates are replaced, and one lookup can refresh several routes", () => {
  const a = route(1);
  const b = route(2);
  const byId = new Map([["1", a], ["2", b]]);
  const state = { refreshedIds: new Set(), changed: 0, sweepTypeDivergences: [] };

  applyRefresh(byId, [{
    routes: [
      { id: 1, schedules: [{ Date: "10/20/2026", Description: "Left" }], leftSweepingRule: "Left side: The 3rd Tuesday of the month." },
      { id: 2, schedules: [{ Date: "10/21/2026", Description: "Right" }] }
    ]
  }], state);

  assert.deepEqual(a.schedules, [{ Date: "10/20/2026", Description: "Left" }]);
  assert.equal(a.leftSweepingRule, "Left side: The 3rd Tuesday of the month.");
  assert.deepEqual(b.schedules, [{ Date: "10/21/2026", Description: "Right" }]);
  assert.equal(state.refreshedIds.size, 2);
  assert.equal(state.changed, 2);
});

test("a failed lookup leaves the old dates alone rather than blanking them", () => {
  const a = route(1);
  const byId = new Map([["1", a]]);
  const state = { refreshedIds: new Set(), changed: 0, sweepTypeDivergences: [] };

  // null is what runPool yields for a lookup that gave up after every retry.
  applyRefresh(byId, [null, undefined, {}, { routes: null }], state);

  assert.deepEqual(a.schedules, [{ Date: "08/12/2026", Description: "Left" }]);
  assert.equal(state.refreshedIds.size, 0);
  assert.equal(state.changed, 0);
});

test("geometry, id and sweepType are never touched, and a sweepType change is reported instead", () => {
  const a = route(1);
  const originalPath = a.map.path;
  const byId = new Map([["1", a]]);
  const state = { refreshedIds: new Set(), changed: 0, sweepTypeDivergences: [] };

  applyRefresh(byId, [{
    routes: [{ id: 1, sweepType: "Nightly", schedules: [], map: { path: [[0, 0], [1, 1]] } }]
  }], state);

  assert.equal(a.sweepType, "Scheduled", "sweepType decides curb colour and must not change silently");
  assert.equal(a.map.path, originalPath, "geometry must survive a refresh untouched");
  assert.equal(a.id, 1);
  assert.equal(state.sweepTypeDivergences.length, 1);
  assert.match(state.sweepTypeDivergences[0], /Scheduled -> Nightly/);
});

test("a route Denver no longer mentions keeps its dates and is counted as stale", () => {
  const a = route(1);
  const b = route(2);
  const byId = new Map([["1", a], ["2", b]]);
  const state = { refreshedIds: new Set(), changed: 0, sweepTypeDivergences: [] };

  applyRefresh(byId, [{ routes: [{ id: 1, schedules: [{ Date: "10/20/2026" }] }] }], state);

  assert.equal(state.refreshedIds.has("2"), false);
  assert.deepEqual(b.schedules, [{ Date: "08/12/2026", Description: "Left" }]);
});

test("the date range is read off the payload the way the client reads it", () => {
  const range = describeDateRange([
    { schedules: [{ Date: "10/20/2026" }, { Date: "09/22/2026" }] },
    { schedules: [{ Date: "10/28/2026" }] },
    { schedules: [{ Date: "not a date" }] },
    { schedules: [] },
    {}
  ]);

  assert.deepEqual(range, { first: "2026-09-22", last: "2026-10-28", count: 3 });
});

test("the checkpoint round-trips, and a stale one is ignored", () => {
  const { readCheckpoint, writeCheckpoint, clearCheckpoint, CHECKPOINT_PATH } = require("../scripts/refresh-route-schedules.js");
  const fsx = require("node:fs");
  const had = fsx.existsSync(CHECKPOINT_PATH) ? fsx.readFileSync(CHECKPOINT_PATH) : null;

  try {
    writeCheckpoint({ refreshedIds: new Set(["1", "2", "3"]) });
    const fresh = readCheckpoint();
    assert.equal(fresh.ids.size, 3);
    assert.ok(fresh.ids.has("2"));

    // A full refresh takes several runs, but picking up a week-old list would skip routes whose
    // dates have since expired -- exactly the staleness this script exists to remove.
    fsx.writeFileSync(
      CHECKPOINT_PATH,
      JSON.stringify({ updatedAt: new Date(Date.now() - 80 * 3600000).toISOString(), refreshedIds: ["9"] })
    );
    assert.equal(readCheckpoint(), null, "a checkpoint older than the window must be ignored");
    assert.equal(readCheckpoint(100).ids.size, 1, "and honoured when the caller widens the window");

    fsx.writeFileSync(CHECKPOINT_PATH, "{ not json");
    assert.equal(readCheckpoint(), null, "a corrupt checkpoint must not take the run down");

    clearCheckpoint();
    assert.equal(readCheckpoint(), null);
    clearCheckpoint(); // clearing twice must not throw
  } finally {
    if (had) fsx.writeFileSync(CHECKPOINT_PATH, had);
  }
});

test("a mistyped pace flag falls back to the gentle default instead of the profile that failed", () => {
  const { readNumericFlag } = require("../scripts/refresh-route-schedules.js");

  assert.equal(readNumericFlag(["--concurrency=2"], "concurrency", 1), 2);
  assert.equal(readNumericFlag(["--round-pause=45"], "round-pause", 30), 45);

  // Denver answered 3,816 502s and zero 429s, so this is an overloaded backend rather than a rate
  // limiter and concurrency is the lever that matters. A typo quietly restoring a heavier setting
  // is the one way this flag could do harm.
  for (const junk of [[], ["--concurrency="], ["--concurrency=abc"], ["--concurrency=0"], ["--concurrency=-4"], ["--concurrencyx=9"]]) {
    assert.equal(readNumericFlag(junk, "concurrency", 1), 1, JSON.stringify(junk));
  }
});

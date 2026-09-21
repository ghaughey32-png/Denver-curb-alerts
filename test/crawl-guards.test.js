"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertNoCoverageCollapse,
  isRetryableStatus,
  runPool
} = require("../scripts/build-static-inventory.js");

// These guard the failure this project had already documented but never defended against: Denver
// throttles a sustained bulk crawl instead of refusing it, so lookups come back empty, the auditor
// covers every orphaned block with pink, and the build gate passes because pink is its answer for
// a block with no schedule. On 2026-09-21 that published 3,932 routes with a real schedule against
// the 19,268 on disk and turned 84% of the map pink, reporting zero unexplained gaps.

function writePublishedPayload(realRouteCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-guards-"));
  const file = path.join(dir, "denver-west-routes.json");
  const routes = [];
  for (let i = 0; i < realRouteCount; i += 1) routes.push({ id: i, sweepType: "Scheduled" });
  // Pink already in the published payload must not count as coverage on either side of the
  // comparison, or a crawl could replace real routes with pink and still look level.
  for (let i = 0; i < 500; i += 1) routes.push({ id: `pink-${i}`, sweepType: "Unavailable" });
  fs.writeFileSync(file, JSON.stringify({ routes }), "utf8");
  return file;
}

// The production limits mean real seconds of backoff per failure. The behaviour under test is the
// decision logic, not the length of the pause, so the tests drive it with tiny ones.
const FAST = { concurrency: 8, retryBaseDelayMs: 1, failureSampleSize: 40 };

const scheduledRoutes = (n) => Array.from({ length: n }, (_, i) => ({ id: i, sweepType: "Scheduled" }));

test("publishing is refused when a crawl loses most of the real routes", async () => {
  const published = writePublishedPayload(19268);
  // What the throttled run actually came back with.
  const collapsed = [
    ...scheduledRoutes(3932),
    ...Array.from({ length: 20919 }, (_, i) => ({ id: `pink-${i}`, sweepType: "Unavailable" }))
  ];

  await assert.rejects(
    () => assertNoCoverageCollapse(collapsed, published),
    (error) => {
      assert.match(error.message, /refused to publish/i);
      assert.match(error.message, /3932/);
      assert.match(error.message, /19268/);
      return true;
    }
  );
});

test("a normal crawl publishes, and so does one that loses a little", async () => {
  const published = writePublishedPayload(19268);

  await assertNoCoverageCollapse(scheduledRoutes(19268), published);
  await assertNoCoverageCollapse(scheduledRoutes(19500), published);
  // A tenth is well inside real churn between two crawls.
  await assertNoCoverageCollapse(scheduledRoutes(17341), published);
});

test("the gate can be overridden deliberately, and says so", async () => {
  const published = writePublishedPayload(19268);
  process.env.ALLOW_COVERAGE_DROP = "1";
  try {
    await assertNoCoverageCollapse(scheduledRoutes(10), published);
  } finally {
    delete process.env.ALLOW_COVERAGE_DROP;
  }
});

test("the first ever publish has nothing to compare against and is allowed", async () => {
  await assertNoCoverageCollapse(scheduledRoutes(10), path.join(os.tmpdir(), "does-not-exist-crawl-guards.json"));
});

test("only 'not now' answers are retried", () => {
  for (const status of [408, 429, 500, 502, 503]) assert.equal(isRetryableStatus(status), true, `${status}`);
  // 400 is Denver's definitive answer from its address endpoint, not a rate limit.
  for (const status of [200, 400, 401, 404]) assert.equal(isRetryableStatus(status), false, `${status}`);
});

test("a throttled crawl aborts instead of finishing with a hollow payload", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 429 });
  try {
    const urls = Array.from({ length: 4000 }, (_, i) => `http://127.0.0.1:0/x?i=${i}`);
    await assert.rejects(
      () => runPool(urls, FAST),
      (error) => {
        assert.match(error.message, /aborted before writing anything/i);
        assert.match(error.message, /throttling/i);
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a lookup that is rate-limited once still succeeds on retry", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ routes: [{ id: 1 }] }), { status: 200 });
  };
  try {
    const results = await runPool(["http://127.0.0.1:0/one"], FAST);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], { routes: [{ id: 1 }] });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 400 is an answer, not a failure, so the dead address endpoint cannot trip the abort", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 400 });
  try {
    const urls = Array.from({ length: 400 }, (_, i) => `http://127.0.0.1:0/a?i=${i}`);
    const results = await runPool(urls, FAST);
    assert.equal(results.length, 400);
    assert.ok(results.every((entry) => entry === null));
  } finally {
    globalThis.fetch = realFetch;
  }
});

"use strict";

// Snow emergencies, server side (lib/snow.js and the /api/snow-emergency route). The pure half
// checks the timeline against clock changes and the audience rule; the integration half stands up a
// fake APNs, as test/apns.test.js does, and reads what actually went over the wire.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http2 = require("node:http2");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const snow = require("../lib/snow.js");
const cityRegistry = require("../public/cities.js");
const { withServer } = require("./lib/with-server.js");

const ADMIN = { Authorization: "Bearer test-admin-token" };
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);

const inventory = {
  curbs: [
    { id: "mpls:route1", street: "LYNDALE AVE S", days: [0, 1, 1] },
    { id: "mpls:even1", street: "EMERSON AVE S", days: [1, 0, 1] },
    { id: "mpls:odd1", street: "EMERSON AVE S", days: [1, 1, 0] },
    { id: "mpls:odd2", street: "10TH AVE SE", days: [1, 1, 0] }
  ]
};
const index = snow.buildCurbIndex(inventory);

test("the ban hours match the city record the page shows", () => {
  const rules = cityRegistry.getCity("minneapolis").snowRules;
  assert.equal(rules.day1Starts, `${snow.DAY1_BAN_HOUR - 12} pm`);
  assert.equal(rules.day2Starts, `${snow.DAY2_3_BAN_HOUR} am`);
  assert.equal(rules.day3Starts, `${snow.DAY2_3_BAN_HOUR} am`);
});

test("wall-clock times land on the right instant either side of a clock change", () => {
  // Central time: daylight saving ends Sunday 2026-11-01 at 2 am.
  assert.equal(snow.zonedInstant("2026-10-31", 20, 0).toISOString(), "2026-11-01T01:00:00.000Z");
  assert.equal(snow.zonedInstant("2026-11-01", 7, 0).toISOString(), "2026-11-01T13:00:00.000Z");
  // And it springs forward on 2027-03-14.
  assert.equal(snow.zonedInstant("2027-03-13", 20, 0).toISOString(), "2027-03-14T02:00:00.000Z");
  assert.equal(snow.zonedInstant("2027-03-14", 7, 0).toISOString(), "2027-03-14T12:00:00.000Z");
});

test("the timeline walks Day 1 to Day 3 in order, across the fall clock change", () => {
  const timeline = snow.buildTimeline({ day1Date: "2026-10-31", declaredAt: "2026-10-31T15:00:00Z" });
  assert.deepEqual(
    timeline.map((message) => [message.id, message.at]),
    [
      ["declared", "2026-10-31T15:00:00.000Z"],
      ["day1-evening", "2026-11-01T00:30:00.000Z"],
      ["day2-evening", "2026-11-01T01:00:00.000Z"],
      ["day2-morning", "2026-11-01T13:00:00.000Z"],
      ["day3-evening", "2026-11-02T02:00:00.000Z"],
      ["day3-morning", "2026-11-02T13:00:00.000Z"]
    ]
  );
});

test("each message reaches only the phones watching a curb banned that day", () => {
  const watched = ["mpls:route1", "mpls:even1", "mpls:odd1", "den:123:north", "mpls:gone"];
  const messages = Object.fromEntries(snow.buildTimeline({ day1Date: "2026-12-10", declaredAt: "2026-12-10T12:00:00Z" }).map((m) => [m.id, m]));

  assert.deepEqual(snow.matchedCurbIds(messages.declared, watched, index), ["mpls:route1", "mpls:even1", "mpls:odd1", "mpls:gone"]);
  assert.deepEqual(snow.matchedCurbIds(messages["day1-evening"], watched, index), ["mpls:route1"]);
  assert.deepEqual(snow.matchedCurbIds(messages["day2-morning"], watched, index), ["mpls:even1"]);
  assert.deepEqual(snow.matchedCurbIds(messages["day3-evening"], watched, index), ["mpls:odd1"]);
  assert.deepEqual(snow.matchedCurbIds(messages.declared, ["den:123:north"], index), [], "a Denver-only phone hears nothing");
});

test("a street is named only when the matching curbs share one", () => {
  assert.equal(snow.singleStreet(["mpls:even1", "mpls:odd1"], index), "Emerson Ave S");
  assert.equal(snow.singleStreet(["mpls:odd1", "mpls:odd2"], index), "");
  assert.equal(snow.singleStreet([], index), "");
  assert.match(snow.composeMessage({ id: "day1-evening" }, { street: "Lyndale Ave S" }).body, /parking on Lyndale Ave S from 9 pm/);
  assert.doesNotMatch(snow.composeMessage({ id: "day1-evening" }).body, /undefined|\s{2}/);
});

test("the declaration copy knows whether Day 1 has already started", () => {
  const before = snow.composeMessage({ id: "declared" }, { declaredAt: "2026-12-10T18:00:00Z", day1Date: "2026-12-10" });
  const after = snow.composeMessage({ id: "declared" }, { declaredAt: "2026-12-11T04:00:00Z", day1Date: "2026-12-10" });
  assert.match(before.body, /start at 9 pm/);
  assert.match(after.body, /in effect now/);
});

test("a message is due once, on time, and never sent late or after a cancellation", () => {
  const record = { day1Date: "2026-12-10", declaredAt: "2026-12-10T20:00:00Z", status: "active", sentMessageIds: [] };
  const at = (iso) => snow.dueMessages(record, new Date(iso).getTime()).map((message) => message.id);

  assert.deepEqual(at("2026-12-10T20:00:30Z"), ["declared"]);
  assert.deepEqual(at("2026-12-11T01:31:00Z"), ["day1-evening"]);
  assert.deepEqual(at("2026-12-11T05:00:00Z"), [], "more than two hours past, nothing is sent late");
  assert.deepEqual(
    snow.dueMessages({ ...record, sentMessageIds: ["declared"] }, new Date("2026-12-10T20:00:30Z").getTime()),
    [],
    "already sent"
  );
  assert.deepEqual(snow.dueMessages({ ...record, status: "cancelled" }, new Date("2026-12-10T20:00:30Z").getTime()), []);
});

test("a declaration made after 9 pm skips the warnings whose time has gone", () => {
  // Declared at 10:30 pm Day 1. The 7:30 pm and 8 pm warnings are long past; only the declaration is due.
  const declaredAt = "2026-12-11T04:30:00Z";
  const record = { day1Date: "2026-12-10", declaredAt, status: "active", sentMessageIds: [] };
  assert.deepEqual(snow.dueMessages(record, new Date(declaredAt).getTime() + 1000).map((message) => message.id), ["declared"]);
});

function startFakeApns() {
  const received = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      received.push({ token: headers[":path"].split("/").pop(), body: JSON.parse(body) });
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, received, close: () => server.close() });
    });
  });
}

function serverEnv(fake, dataDir) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    DATA_DIR: dataDir,
    ISSUE_REPORT_ADMIN_TOKEN: "test-admin-token",
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM456",
    APNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    APNS_ORIGIN: fake.origin
  };
}

// Three days out, the furthest the route accepts, so the clock cannot make a later warning due
// while the test runs: only the declaration itself is ever due.
function farDay1() {
  return snow.addDays(snow.localDateText(new Date()), 3);
}

test("declaring sends the first alert to Minneapolis watchers, dry runs send nothing, and a restart repeats nothing", async () => {
  const fake = await startFakeApns();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-snow-"));
  const day1Date = farDay1();
  const snowCurbs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "minneapolis-snow.json"), "utf8")).curbs;
  const routeCurb = snowCurbs.find((curb) => curb.days[0] === 0);

  try {
    await withServer(
      async ({ call, readCollection }) => {
        const register = (json) => call("/api/push/apns", { method: "POST", json });
        const declare = (json, headers = ADMIN) => call("/api/snow-emergency", { method: "POST", json: { action: "declare", ...json }, headers });

        await register({ token: TOKEN_A, watchedCurbIds: [routeCurb.id, "den:1:north"] });
        await register({ token: TOKEN_B, watchedCurbIds: ["den:1:north"] });
        await register({ token: TOKEN_C });

        assert.equal((await declare({ day1Date }, {})).status, 403, "never without the admin token");
        assert.equal((await declare({ day1Date: "soon" })).status, 400);
        assert.equal((await declare({ day1Date: "2020-01-01" })).status, 400, "a stale date is a typo");
        assert.equal((await declare({ day1Date, city: "denver" })).status, 400, "Denver has no snow emergencies");

        const dry = await declare({ day1Date, dryRun: true });
        assert.equal(dry.status, 200);
        assert.equal(dry.payload.timeline.find((step) => step.id === "declared").audienceCount, 1);
        assert.equal(dry.payload.timeline.find((step) => step.id === "day1-evening").audienceCount, 1);
        assert.equal(fake.received.length, 0, "a dry run sends nothing");
        assert.equal(readCollection("snow-emergencies").length, 0, "and records nothing");
        assert.equal((await call("/api/snow-emergency?city=minneapolis")).payload.active, false);

        const declared = await declare({ day1Date });
        assert.equal(declared.status, 201);
        assert.deepEqual(declared.payload.sent.map((step) => [step.id, step.sent]), [["declared", 1]]);
        assert.equal(fake.received.length, 1);
        assert.equal(fake.received[0].token, TOKEN_A, "only the phone watching a Minneapolis curb");
        assert.equal(fake.received[0].body.aps["interruption-level"], "time-sensitive");
        assert.equal(fake.received[0].body.url, "/?snow=1");

        const again = await declare({ day1Date });
        assert.equal(again.payload.alreadyActive, true, "declaring twice does not alert twice");
        assert.equal((await declare({ day1Date: snow.addDays(day1Date, -1) })).status, 409);
        assert.equal(fake.received.length, 1);

        const publicView = (await call("/api/snow-emergency?city=minneapolis")).payload;
        assert.equal(publicView.active, true);
        assert.equal(publicView.emergency.day1Date, day1Date);
        assert.equal(JSON.stringify(publicView).includes(TOKEN_A), false, "the public view carries no phone");

        assert.deepEqual(readCollection("snow-emergencies")[0].sentMessageIds, ["declared"]);
      },
      serverEnv(fake, dataDir)
    );

    // A new server over the same data starts its dispatcher at boot and must find nothing due.
    await withServer(
      async ({ call }) => {
        assert.equal((await call("/api/snow-emergency?city=minneapolis")).payload.active, true);
        assert.equal(fake.received.length, 1, "a restart does not send the declaration again");
      },
      serverEnv(fake, dataDir)
    );
  } finally {
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cancelling tells only the phones that were told, once, and ends the timeline", async () => {
  const fake = await startFakeApns();
  const day1Date = farDay1();
  const snowCurbs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "minneapolis-snow.json"), "utf8")).curbs;

  try {
    await withServer(
      async ({ call, readCollection }) => {
        const post = (json) => call("/api/snow-emergency", { method: "POST", json, headers: ADMIN });
        await call("/api/push/apns", { method: "POST", json: { token: TOKEN_A, watchedCurbIds: [snowCurbs[0].id] } });
        await call("/api/push/apns", { method: "POST", json: { token: TOKEN_B, watchedCurbIds: ["den:1:north"] } });

        assert.equal((await post({ action: "cancel" })).status, 404, "nothing to cancel yet");
        await post({ action: "declare", day1Date });
        assert.equal(fake.received.length, 1);

        const dry = await post({ action: "cancel", dryRun: true });
        assert.equal(dry.payload.deviceCount, 1);
        assert.equal(fake.received.length, 1);

        const cancelled = await post({ action: "cancel" });
        assert.equal(cancelled.payload.sent, 1);
        assert.equal(fake.received.length, 2);
        assert.equal(fake.received[1].token, TOKEN_A);
        assert.match(fake.received[1].body.aps.alert.title, /cancelled/i);
        assert.equal(readCollection("snow-emergencies")[0].status, "cancelled");
        assert.equal((await call("/api/snow-emergency?city=minneapolis")).payload.active, false);
        assert.equal((await post({ action: "cancel" })).status, 404, "it cannot be cancelled twice");
      },
      serverEnv(fake, fs.mkdtempSync(path.join(os.tmpdir(), "curb-snow-")))
    );
  } finally {
    fake.close();
  }
});

test("with no Apple credentials a declaration is refused instead of recorded and never sent", async () => {
  await withServer(
    async ({ call, readCollection }) => {
      const result = await call("/api/snow-emergency", {
        method: "POST",
        json: { action: "declare", day1Date: farDay1() },
        headers: ADMIN
      });
      assert.equal(result.status, 503);
      assert.equal(readCollection("snow-emergencies").length, 0);
    },
    { ISSUE_REPORT_ADMIN_TOKEN: "test-admin-token", APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_PRIVATE_KEY: "" }
  );
});

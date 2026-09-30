"use strict";

// Apple push (lib/apns.js and the two routes in server.js). The integration half stands up a fake
// APNs over plain HTTP/2 and points the server at it with APNS_ORIGIN, so what is checked is what
// actually went over the wire: the path, the topic, a provider token that verifies against the key,
// and a dead token removed from the collection after Apple refuses it.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http2 = require("node:http2");

const apns = require("../lib/apns.js");
const { withServer } = require("./lib/with-server.js");

const ADMIN_TOKEN = "test-admin-token";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey };
}

function verifyProviderToken(jwt, publicKey) {
  const [header, claims, signature] = jwt.split(".");
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header, "base64url")),
    claims: JSON.parse(Buffer.from(claims, "base64url"))
  };
}

test("the provider token is ES256 over the key id and team, and verifies against the key", () => {
  const { pem, publicKey } = makeKey();
  const config = apns.getApnsConfig({ APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM456", APNS_PRIVATE_KEY: pem });
  assert.equal(config.enabled, true);
  assert.equal(config.topic, "co.curbalerts.app");

  const { valid, header, claims } = verifyProviderToken(apns.buildProviderToken(config, 1_700_000_000_000), publicKey);
  assert.equal(valid, true);
  assert.deepEqual(header, { alg: "ES256", kid: "KEY123" });
  assert.deepEqual(claims, { iss: "TEAM456", iat: 1_700_000_000 });
});

test("a key pasted with literal \\n is accepted, and a broken one says why instead of enabling", () => {
  const { pem } = makeKey();
  const escaped = pem.trim().replace(/\n/g, "\\n");
  assert.equal(apns.getApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_PRIVATE_KEY: escaped }).enabled, true);

  const broken = apns.getApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_PRIVATE_KEY: "not a key" });
  assert.equal(broken.enabled, false);
  assert.match(broken.reason, /not a readable \.p8 key/);
  assert.equal(apns.getApnsConfig({}).enabled, false);
});

test("device tokens are hex, lowercased, and never assumed to be exactly 32 bytes", () => {
  assert.equal(apns.normalizeDeviceToken("AB".repeat(32)), "ab".repeat(32));
  assert.equal(apns.normalizeDeviceToken("ab".repeat(50)), "ab".repeat(50));
  assert.equal(apns.normalizeDeviceToken("ab".repeat(10)), "");
  assert.equal(apns.normalizeDeviceToken("zz".repeat(32)), "");
  assert.equal(apns.normalizeDeviceToken(undefined), "");
});

test("Apple's refusals sort into remove the token, fix the credentials, or just failed", () => {
  assert.equal(apns.classifyApnsResponse(200, ""), "sent");
  assert.equal(apns.classifyApnsResponse(410, "Unregistered"), "dead-token");
  assert.equal(apns.classifyApnsResponse(400, "BadDeviceToken"), "dead-token");
  assert.equal(apns.classifyApnsResponse(400, "DeviceTokenNotForTopic"), "dead-token");
  assert.equal(apns.classifyApnsResponse(403, "ExpiredProviderToken"), "bad-credentials");
  assert.equal(apns.classifyApnsResponse(429, "TooManyRequests"), "failed");
  assert.equal(apns.classifyApnsResponse(500, "InternalServerError"), "failed");
});

test("the payload carries the page URL beside aps, where a tapped reminder already carries it", () => {
  assert.deepEqual(apns.buildAlertPayload({ title: "T", body: "B", url: "/?x=1" }), {
    aps: { alert: { title: "T", body: "B" }, sound: "default" },
    url: "/?x=1"
  });
  assert.equal(
    apns.buildAlertPayload({ title: "T", body: "B", timeSensitive: true }).aps["interruption-level"],
    "time-sensitive"
  );
});

function startFakeApns(answerFor) {
  const received = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      received.push({ headers, body: JSON.parse(body) });
      const token = headers[":path"].split("/").pop();
      const { status, reason } = answerFor(token);
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(reason ? JSON.stringify({ reason }) : "");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, received, close: () => server.close() });
    });
  });
}

test("registering, replacing a rotated token, and a broadcast that removes the token Apple refuses", async () => {
  const { pem, publicKey } = makeKey();
  const fake = await startFakeApns((token) => (token === TOKEN_B ? { status: 410, reason: "Unregistered" } : { status: 200 }));

  try {
    await withServer(
      async ({ call, readCollection }) => {
        const register = (json) => call("/api/push/apns", { method: "POST", json });

        assert.equal((await register({ token: "nope" })).status, 400);
        assert.equal((await register({ token: TOKEN_A, environment: "sandbox", appVersion: "1.0 (9)" })).status, 201);
        assert.equal((await register({ token: TOKEN_B })).status, 201);
        // Same phone, new token: the record moves rather than a second one appearing.
        assert.equal((await register({ token: TOKEN_C, previousToken: TOKEN_A, environment: "sandbox" })).status, 201);

        let devices = readCollection("push-subscriptions");
        assert.deepEqual(devices.map((device) => device.endpoint).sort(), [`apns://${TOKEN_B}`, `apns://${TOKEN_C}`]);
        assert.equal(devices.find((device) => device.endpoint.endsWith(TOKEN_C)).apnsEnvironment, "sandbox");
        assert.equal(devices.find((device) => device.endpoint.endsWith(TOKEN_B)).apnsEnvironment, "production");

        const broadcast = (json, headers = { Authorization: `Bearer ${ADMIN_TOKEN}` }) =>
          call("/api/push/broadcast", { method: "POST", json, headers });

        assert.equal((await broadcast({ title: "T", body: "B" }, {})).status, 403, "never without the admin token");
        assert.equal((await broadcast({ title: "T" })).status, 400);

        const dry = await broadcast({ title: "T", body: "B", dryRun: true });
        assert.deepEqual(dry.payload, { dryRun: true, deviceCount: 2 });
        assert.equal(fake.received.length, 0, "a dry run sends nothing");

        const sent = await broadcast({ title: "Snow emergency", body: "Move your car", url: "/?snow=1" });
        assert.equal(sent.status, 200);
        assert.equal(sent.payload.sent, 1);
        assert.equal(sent.payload.removed, 1);

        const delivered = fake.received.find((item) => item.headers[":path"] === `/3/device/${TOKEN_C}`);
        assert.equal(delivered.headers["apns-topic"], "co.curbalerts.app");
        assert.equal(delivered.headers["apns-push-type"], "alert");
        assert.deepEqual(delivered.body, {
          aps: { alert: { title: "Snow emergency", body: "Move your car" }, sound: "default" },
          url: "/?snow=1"
        });
        const jwt = delivered.headers.authorization.replace(/^bearer /, "");
        assert.equal(verifyProviderToken(jwt, publicKey).valid, true);

        devices = readCollection("push-subscriptions");
        assert.deepEqual(devices.map((device) => device.endpoint), [`apns://${TOKEN_C}`], "the refused token is gone");

        // Naming tokens narrows the send to them.
        const narrowed = await broadcast({ title: "T", body: "B", tokens: [TOKEN_B], dryRun: true });
        assert.equal(narrowed.payload.deviceCount, 0);
      },
      {
        ISSUE_REPORT_ADMIN_TOKEN: ADMIN_TOKEN,
        APNS_KEY_ID: "KEY123",
        APNS_TEAM_ID: "TEAM456",
        APNS_PRIVATE_KEY: pem,
        APNS_ORIGIN: fake.origin
      }
    );
  } finally {
    fake.close();
  }
});

test("with no credentials a broadcast says what is missing rather than pretending to send", async () => {
  await withServer(
    async ({ call }) => {
      await call("/api/push/apns", { method: "POST", json: { token: TOKEN_A } });
      const result = await call("/api/push/broadcast", {
        method: "POST",
        json: { title: "T", body: "B" },
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      assert.equal(result.status, 503);
      assert.match(result.payload.details, /APNS_KEY_ID/);
    },
    { ISSUE_REPORT_ADMIN_TOKEN: ADMIN_TOKEN, APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_PRIVATE_KEY: "" }
  );
});

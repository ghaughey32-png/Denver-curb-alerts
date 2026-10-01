"use strict";

// The verifier and the decisions made from Apple's notifications (lib/app-store-notifications.js),
// run against a throwaway chain that has the same shape as Apple's, so a forged or mis-chained
// message is refused by the code that will refuse it in production.

const test = require("node:test");
const assert = require("node:assert/strict");

const appStore = require("../lib/app-store-notifications.js");
const { ROOT_FINGERPRINT, signJws, buildNotification } = require("./lib/fake-apple.js");

const options = { rootFingerprints: [ROOT_FINGERPRINT] };

test("a notification signed through the chain is accepted and flattened", () => {
  const parsed = appStore.parseNotification(
    buildNotification({ type: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", gracePeriodExpiresDate: Date.parse("2026-11-17T00:00:00Z") }),
    options
  );
  assert.equal(parsed.type, "DID_FAIL_TO_RENEW");
  assert.equal(parsed.subtype, "GRACE_PERIOD");
  assert.equal(parsed.originalTransactionId, "2000000111222333");
  assert.equal(parsed.gracePeriodEndsAt, "2026-11-17T00:00:00.000Z");
  assert.equal(parsed.expiresAt, "2026-12-01T00:00:00.000Z");
  assert.equal(parsed.signedAt, "2026-11-01T12:00:00.000Z");
});

test("the real Apple root is the default, so a test chain is refused without being named", () => {
  assert.throws(() => appStore.parseNotification(buildNotification({ type: "DID_RENEW" })), /Apple's root/);
  assert.equal(appStore.APPLE_ROOT_CA_G3_SHA256.length, 64);
});

test("forgeries are refused", () => {
  const good = buildNotification({ type: "EXPIRED" });
  const [header, body, signature] = good.split(".");
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), notificationType: "DID_RENEW" })).toString("base64url");

  assert.throws(() => appStore.parseNotification(`${header}.${altered}.${signature}`, options), /signature/, "a changed body");
  assert.throws(() => appStore.parseNotification("not a jws", options), /JWS/);
  assert.throws(() => appStore.parseNotification(`${header}.${body}.`, options));
  assert.throws(() => appStore.parseNotification(buildNotification({ type: "EXPIRED", signing: { alg: "HS256" } }), options), /algorithm/);
  assert.throws(() => appStore.parseNotification(buildNotification({ type: "EXPIRED", signing: { chain: ["leaf", "root"] } }), options), /chain/, "a missing intermediate");
  assert.throws(() => appStore.parseNotification(buildNotification({ type: "EXPIRED", signing: { chain: ["leaf", "leaf", "root"] } }), options), /not signed by the next/, "a chain out of order");
  assert.throws(
    () => appStore.parseNotification(buildNotification({ type: "EXPIRED", signing: { leaf: "plain" } }), options),
    /notification-signing certificates/,
    "a leaf Apple did not mark for this purpose"
  );
});

test("a certificate outside its validity window is refused", () => {
  const stamp = buildNotification({ type: "EXPIRED" });
  assert.throws(() => appStore.verifyAppleJws(stamp, { ...options, now: Date.parse("2300-01-01") }), /validity/);
  assert.throws(() => appStore.verifyAppleJws(stamp, { ...options, now: Date.parse("1999-01-01") }), /validity/);
});

test("a notification for another app is refused", () => {
  assert.throws(() => appStore.parseNotification(buildNotification({ type: "DID_RENEW", bundleId: "com.example.other" }), options), /another app/);
});

const interpret = (fields) => appStore.interpretNotification(appStore.parseNotification(buildNotification(fields), options));

test("a failed payment in its grace period warns now and keeps coverage until the grace ends", () => {
  const result = interpret({ type: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", gracePeriodExpiresDate: Date.parse("2026-11-17T00:00:00Z") });
  assert.deepEqual(result.access, { entitled: true, endsAt: "2026-11-17T00:00:00.000Z" });
  assert.match(result.notice.title, /Payment failed/);
  assert.match(result.notice.title, /^😱/);
});

test("a failed payment with no grace period stops coverage and says so", () => {
  const result = interpret({ type: "DID_FAIL_TO_RENEW" });
  assert.deepEqual(result.access, { entitled: false, endsAt: null });
  assert.match(result.notice.title, /have stopped/);
});

test("every way coverage ends is announced, and a recovery announces nothing", () => {
  for (const type of ["GRACE_PERIOD_EXPIRED", "EXPIRED", "REFUND", "REVOKE"]) {
    const result = interpret({ type });
    assert.deepEqual(result.access, { entitled: false, endsAt: null }, type);
    assert.ok(result.notice, `${type} must notify`);
  }

  assert.match(interpret({ type: "EXPIRED", subtype: "VOLUNTARY" }).notice.title, /^☠️/, "ended by the driver");
  for (const type of ["DID_RENEW", "SUBSCRIBED", "OFFER_REDEEMED"]) {
    assert.deepEqual(interpret({ type }), { access: { entitled: true, endsAt: null }, notice: null }, type);
  }
});

test("turning auto-renew off or on moves the end date and never pushes", () => {
  assert.deepEqual(interpret({ type: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_DISABLED", autoRenewStatus: 0 }), {
    access: { entitled: true, endsAt: "2026-12-01T00:00:00.000Z" },
    notice: null
  });
  assert.deepEqual(interpret({ type: "DID_CHANGE_RENEWAL_STATUS", subtype: "AUTO_RENEW_ENABLED", autoRenewStatus: 1 }), {
    access: { entitled: true, endsAt: null },
    notice: null
  });
});

test("events that change nothing are ignored", () => {
  assert.deepEqual(interpret({ type: "PRICE_INCREASE" }), { access: null, notice: null });
  assert.deepEqual(appStore.interpretNotification({ type: "TEST", subtype: "" }), { access: null, notice: null });
});

test("signJws helper round-trips", () => {
  assert.deepEqual(appStore.verifyAppleJws(signJws({ a: 1 }), options), { a: 1 });
});

// --- the route, end to end: a real server, a fake APNs, and notifications signed by the test chain ---

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withServer } = require("./lib/with-server.js");
const { startFakeApns, apnsEnv } = require("./lib/fake-apns.js");

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);
const SUBSCRIPTION = "2000000111222333";

test("a payment failure reaches the phone holding that subscription, corrects its access, and is applied once and in order", async () => {
  const fake = await startFakeApns();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-apple-"));

  try {
    await withServer(
      async ({ call, readCollection }) => {
        const register = (json) => call("/api/push/apns", { method: "POST", json });
        const send = (fields) => call("/api/apple/notifications", { method: "POST", json: { signedPayload: buildNotification(fields) } });
        const device = (token) => readCollection("push-subscriptions").find((item) => item.endpoint.endsWith(token));

        const paid = { entitled: true, endsAt: null, originalTransactionId: SUBSCRIPTION };
        await register({ token: TOKEN_A, reminderAccess: paid });
        await register({ token: TOKEN_B, reminderAccess: paid }); // the same Apple ID on a second phone
        await register({ token: TOKEN_C, reminderAccess: { ...paid, originalTransactionId: "999" } }); // someone else
        assert.equal(device(TOKEN_A).appleOriginalTransactionId, SUBSCRIPTION);

        // Unverifiable messages are refused and change nothing.
        assert.equal((await call("/api/apple/notifications", { method: "POST", json: { signedPayload: "x.y.z" } })).status, 400);
        assert.equal((await call("/api/apple/notifications", { method: "POST", json: {} })).status, 400);
        assert.equal((await call("/api/apple/notifications")).status, 405);
        assert.equal((await send({ type: "EXPIRED", signing: { leaf: "plain" } })).status, 400);
        assert.equal(fake.received.length, 0);

        const failed = await send({
          type: "DID_FAIL_TO_RENEW",
          subtype: "GRACE_PERIOD",
          gracePeriodExpiresDate: Date.parse("2099-01-01T00:00:00Z"),
          signedDate: Date.parse("2026-11-01T12:00:00Z"),
          uuid: "event-1"
        });
        assert.equal(failed.status, 200);
        assert.deepEqual([failed.payload.matched, failed.payload.notified], [2, 2]);
        assert.deepEqual(fake.received.map((message) => message.token).sort(), [TOKEN_A, TOKEN_B]);
        assert.match(fake.received[0].body.aps.alert.title, /Payment failed/);
        assert.equal(fake.received[0].body.aps["interruption-level"], "time-sensitive");
        assert.deepEqual(device(TOKEN_A).reminderAccess, { entitled: true, endsAt: "2099-01-01T00:00:00.000Z" });
        assert.deepEqual(device(TOKEN_C).reminderAccess, { entitled: true, endsAt: null }, "another subscription is untouched");

        // A redelivery, and an older event arriving late, change nothing and send nothing.
        assert.equal((await send({ type: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD", gracePeriodExpiresDate: Date.parse("2099-01-01T00:00:00Z"), uuid: "event-1" })).payload.matched, 0);
        assert.equal((await send({ type: "DID_RENEW", signedDate: Date.parse("2026-10-01T00:00:00Z"), uuid: "event-0" })).payload.matched, 0);
        assert.equal(fake.received.length, 2);
        assert.equal(device(TOKEN_A).reminderAccess.endsAt, "2099-01-01T00:00:00.000Z");

        // The grace period runs out: coverage ends and the phones are told.
        const stopped = await send({ type: "GRACE_PERIOD_EXPIRED", signedDate: Date.parse("2026-11-17T12:00:00Z"), uuid: "event-2" });
        assert.equal(stopped.payload.notified, 2);
        assert.deepEqual(device(TOKEN_A).reminderAccess, { entitled: false, endsAt: null });
        assert.match(fake.received[2].body.aps.alert.title, /alerts have stopped/);

        // Recovery fixes the access, and says nothing: the driver paid, they know.
        const recovered = await send({ type: "DID_RENEW", signedDate: Date.parse("2026-11-20T12:00:00Z"), uuid: "event-3" });
        assert.deepEqual([recovered.payload.matched, recovered.payload.notified], [2, 0]);
        assert.deepEqual(device(TOKEN_A).reminderAccess, { entitled: true, endsAt: null });
        assert.equal(fake.received.length, 4);

        // An event for a subscription no phone has reported is accepted and ignored.
        assert.deepEqual((await send({ type: "EXPIRED", originalTransactionId: "123456", uuid: "event-4" })).payload, { ok: true, matched: 0, notified: 0 });
      },
      { DATA_DIR: dataDir, APP_STORE_TEST_ROOT_SHA256: ROOT_FINGERPRINT, ...apnsEnv(fake) }
    );
  } finally {
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("without the test root the server pins Apple's, so a forged chain never gets in", async () => {
  await withServer(async ({ call }) => {
    const refused = await call("/api/apple/notifications", { method: "POST", json: { signedPayload: buildNotification({ type: "EXPIRED" }) } });
    assert.equal(refused.status, 400);
  }, {});
});

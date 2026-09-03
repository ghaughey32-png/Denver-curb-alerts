// What survived the payment path.
//
// This file was test/billing.test.js until 2026-09-03, when Stripe came out. The Stripe-specific
// half — form encoding, webhook signature verification, mapping a subscription onto our record —
// went with the code it covered. What is left is the part that was never really about Stripe: the
// account carries an entitlement, a trial opens it, a damaged record must not grant it, and no
// amount of it being expired is allowed to withhold a sweeping reminder or lock someone out of
// their own saved curb sets.
//
// The gating test reads the opposite way round from the one it replaces. There used to be a case
// asserting that an expired trial answered 402 on the library; it now asserts that it does not,
// because with nothing to buy that 402 was an unopenable door. When a purchase path arrives, this
// is the test to flip back.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const accounts = require("../lib/accounts.js");
const { withServer } = require("./lib/with-server.js");

// Boots a second server against the same DATA_DIR and kills it as soon as it reports itself up.
// The trial backfill runs at boot, so this is the only way to exercise it.
function bootOnce(dataDir, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: {
        ...process.env,
        PORT: String(38000 + Math.floor(Math.random() * 900)),
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        DATABASE_URL: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The ${label} server did not start in time.`));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running at")) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve();
      }
    });
    child.on("error", reject);
  });
}

test("the trial entitles, expires on time, and the default billing shape entitles nothing", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const trial = accounts.buildTrialBilling(now, 14);

  assert.equal(trial.status, "trialing");
  assert.equal(trial.currentPeriodEnd, "2026-09-10T12:00:00.000Z");
  assert.ok(accounts.getEntitlement({ billing: trial }, now).active);
  assert.ok(!accounts.getEntitlement({ billing: trial }, new Date("2026-09-11T12:00:00.000Z")).active);

  // getEntitlement falls back to buildDefaultBilling for an account with no billing at all, so a
  // damaged or half-written record must be the least valuable one in the collection, not the most.
  assert.ok(!accounts.getEntitlement({ billing: accounts.buildDefaultBilling() }, now).active);
  assert.ok(!accounts.getEntitlement({}, now).active);
  assert.ok(!accounts.getEntitlement(null, now).active);
});

test("the trial length has one home, and buildTrialBilling defaults to it", () => {
  // It used to live in lib/billing.js beside the prices. With that file gone it belongs here, and
  // a caller that passes nothing must still get the real length rather than a stray literal.
  assert.equal(accounts.TRIAL_DAYS, 14);

  const now = new Date("2026-08-27T12:00:00.000Z");
  assert.equal(
    accounts.buildTrialBilling(now).currentPeriodEnd,
    accounts.buildTrialBilling(now, accounts.TRIAL_DAYS).currentPeriodEnd
  );
});

test("the billing record carries no processor in its field names", () => {
  // The shape is meant to be filled by whatever processor comes next. A field called
  // stripeCustomerId would have to be migrated before StoreKit could write to it.
  const shape = accounts.buildDefaultBilling();

  assert.ok("providerCustomerId" in shape);
  assert.ok("providerSubscriptionId" in shape);
  assert.ok(!Object.keys(shape).some((key) => /stripe/i.test(key)), Object.keys(shape).join(", "));
});

test("an expired entitlement does not lock anyone out of their own library", async () => {
  await withServer(async ({ call, readCollection, writeCollection }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "lapsed@example.com", password: "sweeping-tuesday-8am" }
    });
    const cookie = created.sessionCookie;

    const saved = await call("/api/accounts/me/library", {
      method: "POST",
      cookie,
      json: { savedSets: [{ id: "set-1", name: "Home block", segmentIds: ["a", "b"] }] }
    });
    assert.equal(saved.status, 200);

    // Run the trial out. The API cannot express this, so the collection is edited underneath the
    // server, which re-reads it on the next request.
    const stored = readCollection("accounts");
    stored[0].billing = {
      ...stored[0].billing,
      currentPeriodEnd: new Date(Date.now() - 60 * 1000).toISOString()
    };
    writeCollection("accounts", stored);

    // The entitlement really is expired — this is not a test that forgot to expire anything.
    const me = await call("/api/accounts/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.payload.account.entitlement.active, false);

    // And it changes nothing about the library, because there is no way to pay to unlock it.
    const read = await call("/api/accounts/me/library", { cookie });
    assert.equal(read.status, 200, "an unsellable paywall is just a bug");
    assert.equal(read.payload.library.savedSets.length, 1);

    const upload = await call("/api/accounts/me/library", {
      method: "POST",
      cookie,
      json: { savedSets: [{ id: "set-1", name: "Home block", segmentIds: ["a", "b"] }, { id: "set-2", name: "Work" }] }
    });
    assert.equal(upload.status, 200);
    assert.equal(readCollection("accounts")[0].library.savedSets.length, 2);

    // Everything else a lapsed account needs still works.
    const signedOut = await call("/api/sessions", { method: "DELETE", cookie });
    assert.equal(signedOut.status, 200);

    const signedBackIn = await call("/api/sessions", {
      method: "POST",
      json: { email: "lapsed@example.com", password: "sweeping-tuesday-8am" }
    });
    assert.equal(signedBackIn.status, 200);

    const deleted = await call("/api/accounts/me", {
      method: "DELETE",
      cookie: signedBackIn.sessionCookie,
      json: { password: "sweeping-tuesday-8am" }
    });
    assert.equal(deleted.status, 200);
  });
});

test("reminders are never gated, because withholding one is how someone gets a ticket", async () => {
  await withServer(async ({ call, readCollection, writeCollection }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "reminders@example.com", password: "sweeping-tuesday-8am" }
    });

    const stored = readCollection("accounts");
    stored[0].billing = { ...stored[0].billing, status: "canceled", currentPeriodEnd: null };
    writeCollection("accounts", stored);

    const endpoint = "https://push.example.com/lapsed-device";
    const registered = await call("/api/push/subscriptions", {
      method: "POST",
      cookie: created.sessionCookie,
      json: { subscription: { endpoint, keys: { p256dh: "key", auth: "auth" } } }
    });
    assert.ok(registered.status < 400, `registering a device must not be gated, got ${registered.status}`);

    const plan = await call("/api/reminder-plans", {
      method: "POST",
      cookie: created.sessionCookie,
      json: {
        endpoint,
        savedSets: [{ id: "set-1", name: "Home block" }],
        jobs: [{ id: "job-1", title: "Move your car", body: "Sweeping tomorrow", scheduledAt: new Date(Date.now() + 3600000).toISOString() }]
      }
    });
    assert.ok(plan.status < 400, `scheduling a reminder must not be gated, got ${plan.status}`);

    const readBack = await call(`/api/reminder-plans?endpoint=${encodeURIComponent(endpoint)}`, {
      cookie: created.sessionCookie
    });
    assert.equal(readBack.status, 200);
  });
});

test("nothing answers a payment-required status any more", async () => {
  await withServer(async ({ call, readCollection, writeCollection }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "nopay@example.com", password: "sweeping-tuesday-8am" }
    });

    const stored = readCollection("accounts");
    stored[0].billing = accounts.buildDefaultBilling();
    writeCollection("accounts", stored);

    // The unentitled floor, which is the least valuable record the collection can hold. Every
    // endpoint an account can reach still has to answer it normally.
    for (const [pathname, options] of [
      ["/api/accounts/me", {}],
      ["/api/accounts/me/library", {}],
      ["/api/accounts/me/library", { method: "POST", json: { savedSets: [] } }]
    ]) {
      const answer = await call(pathname, { ...options, cookie: created.sessionCookie });
      assert.notEqual(answer.status, 402, `${options.method || "GET"} ${pathname} answered 402`);
      assert.ok(answer.status < 400, `${options.method || "GET"} ${pathname} answered ${answer.status}`);
    }
  });
});

test("the old billing endpoints are gone rather than answering something misleading", async () => {
  await withServer(async ({ call }) => {
    // A 503 would read as "payments are configured elsewhere" to anyone probing, and a 200 with an
    // empty config would keep a stale client rendering an upgrade button. 404 is the honest answer.
    for (const pathname of ["/api/billing/config", "/api/billing/checkout", "/api/billing/portal", "/api/billing/webhook"]) {
      const answer = await call(pathname, { method: "POST", body: "{}" });
      assert.equal(answer.status, 404, `${pathname} answered ${answer.status}`);
    }
  });
});

test("accounts created before the billing fields existed are given a trial", async () => {
  await withServer(async ({ call, dataDir, readCollection, writeCollection }) => {
    await call("/api/accounts", {
      method: "POST",
      json: { email: "legacy@example.com", password: "sweeping-tuesday-8am" }
    });

    const stored = readCollection("accounts");
    stored[0].billing = accounts.buildDefaultBilling();
    writeCollection("accounts", stored);

    await bootOnce(dataDir, "migrating");

    const billed = readCollection("accounts")[0].billing;
    assert.equal(billed.status, "trialing");
    assert.ok(billed.trialStartedAt);
    assert.ok(accounts.getEntitlement({ billing: billed }).active);

    // Idempotent: someone who has already been through the trial is never topped up by a redeploy.
    // Expire it, boot again, and it must stay expired.
    const expired = readCollection("accounts");
    expired[0].billing = { ...expired[0].billing, currentPeriodEnd: new Date(Date.now() - 60 * 1000).toISOString() };
    writeCollection("accounts", expired);

    await bootOnce(dataDir, "second migrating");

    assert.ok(!accounts.getEntitlement({ billing: readCollection("accounts")[0].billing }).active);
  });
});

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");

const accounts = require("../lib/accounts.js");
const billing = require("../lib/billing.js");
const { withServer } = require("./lib/with-server.js");

const STRIPE_TEST_ENV = {
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  STRIPE_PRICE_MONTHLY: "price_monthly_test",
  STRIPE_PRICE_ANNUAL: "price_annual_test",
  STRIPE_RETURN_ORIGIN: "http://127.0.0.1:3000"
};

test("Stripe form encoding produces the bracketed paths Stripe expects", () => {
  const encoded = billing.encodeStripeForm({
    mode: "subscription",
    line_items: [{ price: "price_x", quantity: 1 }],
    subscription_data: { metadata: { accountId: "acct_1" } },
    skipped: null
  });

  const parts = encoded.split("&");
  assert.ok(parts.includes("mode=subscription"));
  assert.ok(parts.includes(`${encodeURIComponent("line_items[0][price]")}=price_x`));
  assert.ok(parts.includes(`${encodeURIComponent("line_items[0][quantity]")}=1`));
  assert.ok(parts.includes(`${encodeURIComponent("subscription_data[metadata][accountId]")}=acct_1`));

  // A null is an omitted field, not the string "null". Sending "null" to Stripe sets the value.
  assert.ok(!encoded.includes("skipped"));
});

test("the checkout success placeholder survives encoding", () => {
  // Stripe substitutes {CHECKOUT_SESSION_ID} itself after decoding the form value. If it were
  // mangled here the return trip would land on a literal placeholder in the query string.
  const encoded = billing.encodeStripeForm({ success_url: "https://example.com/?session_id={CHECKOUT_SESSION_ID}" });
  assert.equal(decodeURIComponent(encoded.split("=").slice(1).join("=")), "https://example.com/?session_id={CHECKOUT_SESSION_ID}");
});

function signWebhook(body, secret, timestampSeconds) {
  const signature = crypto.createHmac("sha256", secret).update(`${timestampSeconds}.${body}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

test("webhook signatures verify, and every way of getting one wrong is rejected", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);

  assert.ok(billing.verifyWebhookSignature(body, signWebhook(body, secret, timestamp), secret, { now }).ok);

  // A signature made with a different secret.
  assert.ok(!billing.verifyWebhookSignature(body, signWebhook(body, "whsec_other", timestamp), secret, { now }).ok);

  // The right signature over a body that has since been altered. This is the attack the scheme
  // exists to stop: an event that says "active" when Stripe said "canceled".
  assert.ok(!billing.verifyWebhookSignature(`${body} `, signWebhook(body, secret, timestamp), secret, { now }).ok);

  // A correctly signed request from too long ago.
  const stale = timestamp - billing.WEBHOOK_TOLERANCE_SECONDS - 60;
  assert.ok(!billing.verifyWebhookSignature(body, signWebhook(body, secret, stale), secret, { now }).ok);

  // Shapes that must not throw on the way to being rejected. A wrong-length hex digest is the
  // interesting one, because timingSafeEqual throws rather than returning false on a size mismatch.
  assert.ok(!billing.verifyWebhookSignature(body, "", secret, { now }).ok);
  assert.ok(!billing.verifyWebhookSignature(body, "nonsense", secret, { now }).ok);
  assert.ok(!billing.verifyWebhookSignature(body, `t=${timestamp},v1=abcd`, secret, { now }).ok);
  assert.ok(!billing.verifyWebhookSignature(body, `t=notanumber,v1=abcd`, secret, { now }).ok);

  // No configured secret must never verify, whatever is presented.
  assert.ok(!billing.verifyWebhookSignature(body, signWebhook(body, secret, timestamp), "", { now }).ok);
});

test("a Stripe subscription maps onto the billing record, from either period-end location", () => {
  const periodEnd = Math.floor(new Date("2026-09-27T12:00:00.000Z").getTime() / 1000);

  const topLevel = billing.billingFromSubscription({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    current_period_end: periodEnd,
    cancel_at_period_end: false,
    items: { data: [{ price: { recurring: { interval: "year" } } }] }
  });

  assert.equal(topLevel.plan, "reminders");
  assert.equal(topLevel.status, "active");
  assert.equal(topLevel.stripeCustomerId, "cus_1");
  assert.equal(topLevel.stripeSubscriptionId, "sub_1");
  assert.equal(topLevel.currentPeriodEnd, "2026-09-27T12:00:00.000Z");
  assert.equal(topLevel.interval, "year");
  assert.ok(accounts.getEntitlement({ billing: topLevel }, new Date("2026-08-27T12:00:00.000Z")).active);

  // Newer API versions carry the period on the item instead. Reading only the top level would hand
  // getEntitlement a null period end, which it treats as "no expiry" — entitled forever.
  const onItem = billing.billingFromSubscription({
    id: "sub_2",
    status: "active",
    customer: { id: "cus_2" },
    items: { data: [{ current_period_end: periodEnd, price: { recurring: { interval: "month" } } }] }
  });

  assert.equal(onItem.currentPeriodEnd, "2026-09-27T12:00:00.000Z");
  assert.equal(onItem.stripeCustomerId, "cus_2");
  assert.equal(onItem.interval, "month");

  // A cancelled subscription drops back to the free plan and stops entitling.
  const cancelled = billing.billingFromSubscription({ id: "sub_3", status: "canceled", customer: "cus_3" });
  assert.equal(cancelled.plan, "free");
  assert.ok(!accounts.getEntitlement({ billing: cancelled }).active);
});

test("the trial is a real Stripe status, and the default billing shape entitles nothing", () => {
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

test("billing config is public, and says nothing secret", async () => {
  await withServer(async ({ call }) => {
    const configured = await call("/api/billing/config");

    assert.equal(configured.status, 200);
    assert.equal(configured.payload.enabled, true);
    assert.equal(configured.payload.trialDays, billing.TRIAL_DAYS);
    assert.equal(configured.payload.prices.year.label, "$15 / year");
    assert.equal(configured.payload.prices.month.label, "$1.99 / month");
    assert.ok(!configured.raw.includes("sk_test"));
    assert.ok(!configured.raw.includes("whsec"));
  }, STRIPE_TEST_ENV);
});

test("with no Stripe keys, billing is off rather than broken", async () => {
  await withServer(async ({ call }) => {
    const config = await call("/api/billing/config");
    assert.equal(config.status, 200);
    assert.equal(config.payload.enabled, false);

    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "unconfigured@example.com", password: "sweeping-tuesday-8am" }
    });

    const checkout = await call("/api/billing/checkout", {
      method: "POST",
      cookie: created.sessionCookie,
      json: { interval: "year" }
    });
    assert.equal(checkout.status, 503);

    const webhook = await call("/api/billing/webhook", { method: "POST", body: "{}" });
    assert.equal(webhook.status, 503);

    // And the trial still runs, so an unconfigured deployment is a working free app rather than
    // one where nobody can sync.
    const library = await call("/api/accounts/me/library", { cookie: created.sessionCookie });
    assert.equal(library.status, 200);
  });
});

test("checkout and the portal need a session, and the portal needs a customer", async () => {
  await withServer(async ({ call }) => {
    const anonymous = await call("/api/billing/checkout", { method: "POST", json: { interval: "year" } });
    assert.equal(anonymous.status, 401);

    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "checkout@example.com", password: "sweeping-tuesday-8am" }
    });

    const badInterval = await call("/api/billing/checkout", {
      method: "POST",
      cookie: created.sessionCookie,
      json: { interval: "fortnight" }
    });
    assert.equal(badInterval.status, 400);

    // Nothing to manage until Stripe knows this person, and the answer says so rather than
    // handing Stripe an empty customer id.
    const portal = await call("/api/billing/portal", { method: "POST", cookie: created.sessionCookie });
    assert.equal(portal.status, 409);
  }, STRIPE_TEST_ENV);
});

test("an expired trial pauses library sync and nothing else", async () => {
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

    const locked = await call("/api/accounts/me/library", { cookie });
    assert.equal(locked.status, 402);
    assert.equal(locked.payload.entitlement.active, false);
    // The sets are dormant, not deleted, and the client's message depends on this count.
    assert.equal(locked.payload.retained, 1);

    const upload = await call("/api/accounts/me/library", {
      method: "POST",
      cookie,
      json: { savedSets: [] }
    });
    assert.equal(upload.status, 402);

    // The library is untouched on disk: a lapsed subscription must never be a data loss event.
    assert.equal(readCollection("accounts")[0].library.savedSets.length, 1);

    // Everything a lapsed customer needs in order to pay, or to leave, still works. Locking
    // someone out of their own sign-in or their own delete button to collect $15 is indefensible.
    const me = await call("/api/accounts/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.payload.account.entitlement.active, false);

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
  }, STRIPE_TEST_ENV);
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
  }, STRIPE_TEST_ENV);
});

test("the webhook rejects unsigned and mis-signed events before parsing them", async () => {
  await withServer(async ({ call }) => {
    const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });

    const unsigned = await call("/api/billing/webhook", { method: "POST", body });
    assert.equal(unsigned.status, 400);

    const wrongSecret = await call("/api/billing/webhook", {
      method: "POST",
      body,
      headers: { "Stripe-Signature": signWebhook(body, "whsec_wrong", Math.floor(Date.now() / 1000)) }
    });
    assert.equal(wrongSecret.status, 400);
  }, STRIPE_TEST_ENV);
});

test("a signed subscription event entitles the right account", async () => {
  await withServer(async ({ call, readCollection, writeCollection }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "subscriber@example.com", password: "sweeping-tuesday-8am" }
    });
    const accountId = created.payload.account.id;

    // Stand in for the customer Stripe would have created at checkout, and expire the trial so the
    // account is only entitled if the webhook actually lands.
    const stored = readCollection("accounts");
    stored[0].billing = {
      ...stored[0].billing,
      stripeCustomerId: "cus_webhook_test",
      currentPeriodEnd: new Date(Date.now() - 60 * 1000).toISOString()
    };
    writeCollection("accounts", stored);
    assert.equal((await call("/api/accounts/me/library", { cookie: created.sessionCookie })).status, 402);

    const periodEnd = Math.floor((Date.now() + 365 * 24 * 60 * 60 * 1000) / 1000);
    const body = JSON.stringify({
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_webhook_test",
          status: "active",
          customer: "cus_webhook_test",
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          metadata: { accountId },
          items: { data: [{ price: { recurring: { interval: "year" } } }] }
        }
      }
    });

    const delivered = await call("/api/billing/webhook", {
      method: "POST",
      body,
      headers: { "Stripe-Signature": signWebhook(body, STRIPE_TEST_ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000)) }
    });
    assert.equal(delivered.status, 200);

    const library = await call("/api/accounts/me/library", { cookie: created.sessionCookie });
    assert.equal(library.status, 200);

    const me = await call("/api/accounts/me", { cookie: created.sessionCookie });
    assert.equal(me.payload.account.entitlement.active, true);
    assert.equal(me.payload.account.entitlement.status, "active");
    assert.equal(me.payload.account.entitlement.trialing, false);
    assert.equal(me.payload.account.entitlement.manageable, true);

    // An event for a customer nobody owns is acknowledged, not retried forever.
    const orphanBody = JSON.stringify({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_orphan", status: "active", customer: "cus_nobody" } }
    });
    const orphan = await call("/api/billing/webhook", {
      method: "POST",
      body: orphanBody,
      headers: { "Stripe-Signature": signWebhook(orphanBody, STRIPE_TEST_ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000)) }
    });
    assert.equal(orphan.status, 200);
  }, STRIPE_TEST_ENV);
});

test("accounts created before billing existed are given the trial they never had", async () => {
  await withServer(async ({ call, dataDir, readCollection, writeCollection }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "legacy@example.com", password: "sweeping-tuesday-8am" }
    });

    // The pre-billing shape: the unentitled default, with no trial ever opened. Without the
    // backfill this account loses its own sync the moment payments deploy.
    const stored = readCollection("accounts");
    stored[0].billing = accounts.buildDefaultBilling();
    writeCollection("accounts", stored);

    assert.equal((await call("/api/accounts/me/library", { cookie: created.sessionCookie })).status, 402);

    // The backfill runs at boot, so booting a second server against the same DATA_DIR is what
    // exercises it. It is killed as soon as it reports itself up.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        env: { ...process.env, PORT: String(38000 + Math.floor(Math.random() * 900)), HOST: "127.0.0.1", DATA_DIR: dataDir, DATABASE_URL: "" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("The migrating server did not start in time."));
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

    const billed = readCollection("accounts")[0].billing;
    assert.equal(billed.status, "trialing");
    assert.ok(billed.trialStartedAt);
    assert.ok(accounts.getEntitlement({ billing: billed }).active);

    // Idempotent: a customer who has already been through the trial is never topped up by a
    // redeploy. Expire it, boot again, and it must stay expired.
    const expired = readCollection("accounts");
    expired[0].billing = { ...expired[0].billing, currentPeriodEnd: new Date(Date.now() - 60 * 1000).toISOString() };
    writeCollection("accounts", expired);

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        env: { ...process.env, PORT: String(38000 + Math.floor(Math.random() * 900)), HOST: "127.0.0.1", DATA_DIR: dataDir, DATABASE_URL: "" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("The second migrating server did not start in time."));
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

    assert.ok(!accounts.getEntitlement({ billing: readCollection("accounts")[0].billing }).active);
  }, STRIPE_TEST_ENV);
});

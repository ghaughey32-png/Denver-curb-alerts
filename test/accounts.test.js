const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const accounts = require("../lib/accounts.js");
const { withServer } = require("./lib/with-server.js");

test("email normalization trims and lowercases", () => {
  assert.equal(accounts.normalizeEmail("  Driver@Example.COM "), "driver@example.com");
  assert.equal(accounts.normalizeEmail(null), "");
});

test("email validation rejects the shapes that are obviously not addresses", () => {
  assert.ok(accounts.isValidEmail("driver@example.com"));
  assert.ok(accounts.isValidEmail("first.last+curb@mail.example.co.uk"));

  assert.ok(!accounts.isValidEmail(""));
  assert.ok(!accounts.isValidEmail("driver"));
  assert.ok(!accounts.isValidEmail("driver@localhost"));
  assert.ok(!accounts.isValidEmail("driver@example."));
  assert.ok(!accounts.isValidEmail("two@at@example.com"));
  assert.ok(!accounts.isValidEmail("has space@example.com"));
  assert.ok(!accounts.isValidEmail(`${"a".repeat(250)}@example.com`));
});

test("password rules reject short, repetitive, common, and self-describing passwords", () => {
  assert.ok(accounts.validatePassword("a-perfectly-fine-one", "driver@example.com").ok);

  assert.ok(!accounts.validatePassword("short1", "driver@example.com").ok);
  assert.ok(!accounts.validatePassword("aaaaaaaaaaaa", "driver@example.com").ok);
  assert.ok(!accounts.validatePassword("password123", "driver@example.com").ok);
  assert.ok(!accounts.validatePassword("x".repeat(201), "driver@example.com").ok);

  // The local part of the address is the first password a stranger would try.
  assert.ok(!accounts.validatePassword("ghaughey-2026", "ghaughey@example.com").ok);
});

test("password hashes verify, reject wrong passwords, and are salted per account", async () => {
  const hash = await accounts.hashPassword("correct-horse-battery");

  assert.match(hash, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.ok(await accounts.verifyPassword("correct-horse-battery", hash));
  assert.ok(!(await accounts.verifyPassword("correct-horse-batteryy", hash)));
  assert.ok(!(await accounts.verifyPassword("", hash)));

  const second = await accounts.hashPassword("correct-horse-battery");
  assert.notEqual(hash, second, "identical passwords must not produce identical hashes");
});

test("verifying against a malformed hash fails instead of throwing", async () => {
  assert.ok(!(await accounts.verifyPassword("anything", "")));
  assert.ok(!(await accounts.verifyPassword("anything", "bcrypt$nope")));
  assert.ok(!(await accounts.verifyPassword("anything", "scrypt$16384$8$1$$")));
});

test("session tokens are random and stored only as a hash", () => {
  const first = accounts.createSessionToken();
  const second = accounts.createSessionToken();

  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
  assert.equal(first.tokenHash, accounts.hashSessionToken(first.token));
  assert.ok(!first.tokenHash.includes(first.token));
});

test("session cookies are HttpOnly and Lax, and Secure only where TLS reaches", () => {
  const secure = accounts.buildSessionCookie("token-value", { secure: true });
  assert.ok(secure.includes("HttpOnly"));
  assert.ok(secure.includes("SameSite=Lax"), "Strict drops the cookie on the return from Stripe");
  assert.ok(secure.includes("Secure"));

  const local = accounts.buildSessionCookie("token-value", { secure: false });
  assert.ok(!local.includes("Secure"));

  assert.ok(accounts.buildExpiredSessionCookie({ secure: true }).includes("Max-Age=0"));
});

test("cookie parsing survives the shapes a browser actually sends", () => {
  const jar = accounts.parseCookies("curb_session=abc123; other=1; malformed; padded = spaced ");

  assert.equal(jar.curb_session, "abc123");
  assert.equal(jar.other, "1");
  assert.equal(jar.padded, "spaced");
  assert.equal(accounts.parseCookies(undefined).curb_session, undefined);
});

test("expired sessions are pruned", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const live = { id: "a", expiresAt: "2026-09-27T12:00:00.000Z" };
  const dead = { id: "b", expiresAt: "2026-08-01T12:00:00.000Z" };
  const broken = { id: "c", expiresAt: "not a date" };

  assert.ok(!accounts.isSessionExpired(live, now));
  assert.ok(accounts.isSessionExpired(dead, now));
  assert.ok(accounts.isSessionExpired(broken, now));
  assert.deepEqual(accounts.pruneExpiredSessions([live, dead, broken], now).map((item) => item.id), ["a"]);
});

test("entitlement keeps a customer in dunning, and drops one whose period has ended", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  const withBilling = (billing) => ({ billing: { ...accounts.buildDefaultBilling(), ...billing } });

  assert.ok(!accounts.getEntitlement(withBilling({}), now).active);
  assert.ok(accounts.getEntitlement(withBilling({ status: "active", currentPeriodEnd: "2026-09-27T12:00:00.000Z" }), now).active);
  assert.ok(accounts.getEntitlement(withBilling({ status: "trialing" }), now).active);

  // A failed card is not a reason to stop warning someone about a sweeping ticket while Stripe is
  // still retrying the charge.
  assert.ok(accounts.getEntitlement(withBilling({ status: "past_due" }), now).active);

  assert.ok(!accounts.getEntitlement(withBilling({ status: "canceled" }), now).active);
  assert.ok(!accounts.getEntitlement(withBilling({ status: "active", currentPeriodEnd: "2026-08-01T00:00:00.000Z" }), now).active);
});

test("the public account view never carries the password hash", () => {
  const record = accounts.buildAccountRecord({ email: "driver@example.com", passwordHash: "scrypt$secret" });
  const view = accounts.toPublicAccount(record);

  assert.equal(view.email, "driver@example.com");
  // A new account opens on a trial, not the free plan: the account itself is the paid product,
  // so there has to be something between signing up and entering a card.
  assert.equal(view.entitlement.plan, "trial");
  assert.ok(view.entitlement.active);
  assert.ok(!JSON.stringify(view).includes("scrypt$secret"));
  assert.equal(accounts.toPublicAccount(null), null);
});

// The rest of this file stands a real server up; the harness lives in test/lib/with-server.js
// because the billing tests need the same one.
test("sign up, sign in, and sign out carry a session end to end", async () => {
  await withServer(async ({ call }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "Driver@Example.com", password: "sweeping-tuesday-8am" }
    });

    assert.equal(created.status, 201);
    assert.equal(created.payload.account.email, "driver@example.com");
    assert.ok(created.sessionCookie, "sign-up must set a session cookie");
    assert.ok(!created.raw.includes("passwordHash"));
    assert.ok(!created.raw.includes("scrypt$"));

    const me = await call("/api/accounts/me", { cookie: created.sessionCookie });
    assert.equal(me.status, 200);
    assert.equal(me.payload.account.email, "driver@example.com");
    // Signing up opens the trial, so a brand new account is entitled and has no Stripe
    // subscription behind it yet. That pair is what the client reads to offer checkout.
    assert.equal(me.payload.account.entitlement.active, true);
    assert.equal(me.payload.account.entitlement.plan, "trial");
    assert.equal(me.payload.account.entitlement.trialing, true);
    assert.equal(me.payload.account.entitlement.manageable, false);

    // A signed-out visitor is a normal answer, not an error: the map works without an account.
    const anonymous = await call("/api/accounts/me");
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.payload.account, null);

    const duplicate = await call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "a-different-password" }
    });
    assert.equal(duplicate.status, 409);

    const weak = await call("/api/accounts", {
      method: "POST",
      json: { email: "second@example.com", password: "short" }
    });
    assert.equal(weak.status, 400);

    const badEmail = await call("/api/accounts", {
      method: "POST",
      json: { email: "nope", password: "sweeping-tuesday-8am" }
    });
    assert.equal(badEmail.status, 400);

    const wrongPassword = await call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "sweeping-tuesday-9am" }
    });
    assert.equal(wrongPassword.status, 401);
    assert.ok(!wrongPassword.sessionCookie);

    const unknownAccount = await call("/api/sessions", {
      method: "POST",
      json: { email: "nobody@example.com", password: "sweeping-tuesday-8am" }
    });
    assert.equal(unknownAccount.status, 401);
    // Identical wording for both failures, so the response cannot be used to test whether an
    // address has an account.
    assert.equal(unknownAccount.payload.error, wrongPassword.payload.error);

    const signedIn = await call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "sweeping-tuesday-8am" }
    });
    assert.equal(signedIn.status, 200);
    assert.ok(signedIn.sessionCookie);

    const signedOut = await call("/api/sessions", { method: "DELETE", cookie: signedIn.sessionCookie });
    assert.equal(signedOut.status, 200);

    const afterSignOut = await call("/api/accounts/me", { cookie: signedIn.sessionCookie });
    assert.equal(afterSignOut.payload.account, null);

    // The first session is untouched by the second one signing out.
    const stillValid = await call("/api/accounts/me", { cookie: created.sessionCookie });
    assert.equal(stillValid.payload.account.email, "driver@example.com");
  });
});

test("a forged or stale session cookie is simply not signed in", async () => {
  await withServer(async ({ call }) => {
    const forged = await call("/api/accounts/me", { cookie: "curb_session=not-a-real-token" });
    assert.equal(forged.status, 200);
    assert.equal(forged.payload.account, null);

    const library = await call("/api/accounts/me/library", { cookie: "curb_session=not-a-real-token" });
    assert.equal(library.status, 401);
  });
});

test("saved curb sets survive on the account, and only for their owner", async () => {
  await withServer(async ({ call }) => {
    const owner = await call("/api/accounts", {
      method: "POST",
      json: { email: "owner@example.com", password: "sweeping-tuesday-8am" }
    });
    const other = await call("/api/accounts", {
      method: "POST",
      json: { email: "other@example.com", password: "sweeping-tuesday-8am" }
    });

    const saved = await call("/api/accounts/me/library", {
      method: "POST",
      cookie: owner.sessionCookie,
      json: {
        savedSets: [
          { id: "set_1", name: "Home", segmentIds: ["seg-a", "seg-b"], createdAt: "2026-08-27T12:00:00.000Z" }
        ]
      }
    });
    assert.equal(saved.status, 200);

    const readBack = await call("/api/accounts/me/library", { cookie: owner.sessionCookie });
    assert.equal(readBack.payload.library.savedSets.length, 1);
    assert.equal(readBack.payload.library.savedSets[0].name, "Home");
    assert.deepEqual(readBack.payload.library.savedSets[0].segmentIds, ["seg-a", "seg-b"]);

    const otherAccount = await call("/api/accounts/me/library", { cookie: other.sessionCookie });
    assert.deepEqual(otherAccount.payload.library.savedSets, []);

    const anonymous = await call("/api/accounts/me/library");
    assert.equal(anonymous.status, 401);
  });
});

test("changing a password signs the other devices out but not this one", async () => {
  await withServer(async ({ call }) => {
    const first = await call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "sweeping-tuesday-8am" }
    });
    const second = await call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "sweeping-tuesday-8am" }
    });

    const wrongCurrent = await call("/api/accounts/me/password", {
      method: "POST",
      cookie: second.sessionCookie,
      json: { currentPassword: "not-it-at-all", newPassword: "swept-on-thursdays" }
    });
    assert.equal(wrongCurrent.status, 403);

    const weakNext = await call("/api/accounts/me/password", {
      method: "POST",
      cookie: second.sessionCookie,
      json: { currentPassword: "sweeping-tuesday-8am", newPassword: "short" }
    });
    assert.equal(weakNext.status, 400);

    const changed = await call("/api/accounts/me/password", {
      method: "POST",
      cookie: second.sessionCookie,
      json: { currentPassword: "sweeping-tuesday-8am", newPassword: "swept-on-thursdays" }
    });
    assert.equal(changed.status, 200);

    const stillHere = await call("/api/accounts/me", { cookie: second.sessionCookie });
    assert.equal(stillHere.payload.account.email, "driver@example.com");

    // The whole point of changing a password is to evict whoever else was signed in.
    const evicted = await call("/api/accounts/me", { cookie: first.sessionCookie });
    assert.equal(evicted.payload.account, null);

    const oldPassword = await call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "sweeping-tuesday-8am" }
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "swept-on-thursdays" }
    });
    assert.equal(newPassword.status, 200);
  });
});

test("deleting an account needs the password and takes the session with it", async () => {
  await withServer(async ({ call }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "leaving@example.com", password: "sweeping-tuesday-8am" }
    });

    const unconfirmed = await call("/api/accounts/me", {
      method: "DELETE",
      cookie: created.sessionCookie,
      json: { password: "wrong" }
    });
    assert.equal(unconfirmed.status, 403);

    const deleted = await call("/api/accounts/me", {
      method: "DELETE",
      cookie: created.sessionCookie,
      json: { password: "sweeping-tuesday-8am" }
    });
    assert.equal(deleted.status, 200);

    const gone = await call("/api/accounts/me", { cookie: created.sessionCookie });
    assert.equal(gone.payload.account, null);

    const cannotSignIn = await call("/api/sessions", {
      method: "POST",
      json: { email: "leaving@example.com", password: "sweeping-tuesday-8am" }
    });
    assert.equal(cannotSignIn.status, 401);
  });
});

test("the bulk listings do not hand out other people's devices", async () => {
  await withServer(async ({ call }) => {
    // These endpoints predate accounts and used to answer anyone. A push subscription list is a
    // working ability to notify every user of the app, so it is not a listing to leave open.
    assert.equal((await call("/api/push/subscriptions")).status, 403);
    assert.equal((await call("/api/reminder-plans")).status, 403);
    assert.equal((await call("/api/subscriptions")).status, 403);

    // The per-device reminder lookup the client actually uses is unaffected.
    const plan = await call("/api/reminder-plans?endpoint=https://example.com/push/abc");
    assert.equal(plan.status, 200);
    assert.equal(plan.payload.plan, null);
  });
});

// The three client-side invariants that would lose a customer's saved curbs silently if they broke.
// Like test/curb-geometry.test.js, these read public/app.js as source text, because there is no
// bundler or DOM here to load it into — renaming these functions is meant to break this test.
const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("account requests send the session cookie", () => {
  const request = appSource.match(/async function accountRequest\([\s\S]*?\n}/)[0];

  // Omitting this is the failure that looks like everything works: the sign-in succeeds, the cookie
  // is dropped, and every request after it is anonymous.
  assert.match(request, /credentials: "include"/);
});

test("the upload reads localStorage, not the hydrated in-memory list", () => {
  const reader = appSource.match(/function getLocalSavedSetsForAccount\(\)[\s\S]*?\n}/)[0];

  // state.savedSets is pruned to whatever curb segments the loaded inventory can resolve, and the
  // inventory loads after boot. Uploading from it would delete the account's library on a cold start.
  assert.match(reader, /loadJson\(SAVED_SETS_KEY/);
  assert.ok(!/state\.savedSets/.test(reader), "getLocalSavedSetsForAccount must not read state.savedSets");
});

test("a restored session merges the account library before anything is uploaded", () => {
  const loader = appSource.match(/async function loadCurrentAccount\(\)[\s\S]*?\n}\n/)[0];

  // A session cookie outlives the localStorage beside it. Without this merge, a returning user on a
  // cleared browser uploads an empty library over their real one the moment they save a curb.
  assert.match(loader, /await mergeAccountLibrary\(\)/);
});


// The throttle counters used to live only in a Map, so every deploy handed an attacker a fresh
// budget of guesses — and this app redeploys far more often than the fifteen-minute window. These
// three cover the write, the read back, and the two ways a bad record could lock a real user out.
//
// The reset endpoint is the cheap way in: it records on every request rather than on failures, and
// unlike sign-in it does no scrypt work, so eight of them cost milliseconds instead of a second.
const OUTBOX_EMAIL_ENV = {
  EMAIL_TRANSPORT: "outbox",
  EMAIL_FROM: "Denver Curb Alerts <alerts@example.com>",
  RESEND_API_KEY: ""
};

test("throttle counters survive a restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-throttle-"));
  const env = { ...OUTBOX_EMAIL_ENV, DATA_DIR: dataDir };
  const address = "throttled@example.com";

  try {
    await withServer(async ({ call }) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await call("/api/password-resets", { method: "POST", json: { email: address } });
        assert.equal(response.status, 200, `attempt ${attempt + 1} should still be allowed`);
      }

      const blocked = await call("/api/password-resets", { method: "POST", json: { email: address } });
      assert.equal(blocked.status, 429, "the ninth request in the window must be throttled");
    }, env);

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "sign-in-attempts.json"), "utf8"));
    const emailCounter = persisted.find((item) => item.key === `reset:${address}`);
    assert.ok(emailCounter, "the counter must reach the collection, not just the Map");
    assert.equal(emailCounter.count, 8);
    assert.match(emailCounter.firstAttemptAt, /^\d{4}-\d{2}-\d{2}T/, "timestamps store as ISO strings");

    // A second server over the same collections. Before this change it started with an empty Map
    // and answered 200 here, which is the whole bug.
    await withServer(async ({ call }) => {
      const stillBlocked = await call("/api/password-resets", { method: "POST", json: { email: address } });
      assert.equal(stillBlocked.status, 429, "a restart must not hand out a fresh budget of guesses");
    }, env);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("counters older than the window are dropped rather than restored", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-throttle-stale-"));
  const address = "stale@example.com";
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  fs.writeFileSync(
    path.join(dataDir, "sign-in-attempts.json"),
    `${JSON.stringify([{ key: `reset:${address}`, count: 99, firstAttemptAt: anHourAgo }], null, 2)}\n`,
    "utf8"
  );

  try {
    await withServer(async ({ call }) => {
      const response = await call("/api/password-resets", { method: "POST", json: { email: address } });
      assert.equal(response.status, 200, "an expired counter must not outlive its window");
    }, { ...OUTBOX_EMAIL_ENV, DATA_DIR: dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a corrupt or future-dated counter cannot lock a real user out", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-throttle-corrupt-"));
  const address = "corrupt@example.com";

  // A timestamp in the future would otherwise sit in the window forever, and a record with no
  // usable timestamp would be counted as if it had just happened. Both must be ignored.
  fs.writeFileSync(
    path.join(dataDir, "sign-in-attempts.json"),
    `${JSON.stringify(
      [
        { key: `reset:${address}`, count: 99, firstAttemptAt: new Date(Date.now() + 86400000).toISOString() },
        { key: "reset:nonsense@example.com", count: 99, firstAttemptAt: "not-a-date" },
        { key: "", count: 99, firstAttemptAt: new Date().toISOString() }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );

  try {
    await withServer(async ({ call }) => {
      const response = await call("/api/password-resets", { method: "POST", json: { email: address } });
      assert.equal(response.status, 200, "a future-dated counter must not throttle a real request");

      const other = await call("/api/password-resets", { method: "POST", json: { email: "nonsense@example.com" } });
      assert.equal(other.status, 200, "an unparseable timestamp must not throttle a real request");
    }, { ...OUTBOX_EMAIL_ENV, DATA_DIR: dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

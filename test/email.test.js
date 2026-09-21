const test = require("node:test");
const assert = require("node:assert/strict");

const accounts = require("../lib/accounts.js");
const email = require("../lib/email.js");
const { withServer } = require("./lib/with-server.js");

// Every server case here runs with the outbox transport, which is the only way to exercise the
// flow without a provider: it keeps the routes enabled and writes the message to a file instead of
// sending it. Reaching into that file is how a test learns the link that a real user would click.
const OUTBOX_ENV = { EMAIL_TRANSPORT: "outbox" };

// Sign-up and reset requests both send after answering the request, so there is nothing to await.
// That is deliberate on the reset route — see the comment on handlePasswordResets — and it means a
// test has to wait for the file rather than assume it.
async function waitForOutbox(server, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let messages = [];
    try {
      messages = server.readCollection("outbox");
    } catch {
      messages = [];
    }

    const match = messages.find(predicate);
    if (match) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return null;
}

function extractToken(message, param) {
  const match = String(message?.text || "").match(new RegExp(`[?&]${param}=([^\\s]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

test("email is disabled until a provider or the outbox transport is configured", () => {
  assert.equal(email.getEmailConfig({}).enabled, false);
  assert.equal(email.getEmailConfig({ RESEND_API_KEY: "re_test" }).enabled, false, "a key alone cannot address a message");
  assert.equal(email.getEmailConfig({ EMAIL_FROM: "a@b.com" }).enabled, false);

  assert.equal(email.getEmailConfig({ RESEND_API_KEY: "re_test", EMAIL_FROM: "a@b.com" }).enabled, true);

  // The local path: enabled, but delivering to disk. Without this the outbox would be unreachable,
  // because the routes answer 503 in exactly the state that would otherwise fall back to it.
  const outbox = email.getEmailConfig({ EMAIL_TRANSPORT: "outbox" });
  assert.equal(outbox.enabled, true);
  assert.equal(outbox.outbox, true);
});

test("the client is told whether email works and nothing else", () => {
  const config = email.getEmailConfig({ RESEND_API_KEY: "re_secret", EMAIL_FROM: "alerts@example.com" });
  const shared = email.getPublicEmailConfig(config);

  assert.deepEqual(Object.keys(shared), ["enabled"]);
  assert.ok(!JSON.stringify(shared).includes("re_secret"));
});

test("action links carry the token through URL encoding", () => {
  const link = email.buildActionLink("https://example.com/", "reset", "a/b+c==");

  assert.equal(link, "https://example.com/?reset=a%2Fb%2Bc%3D%3D");
  assert.equal(new URL(link).searchParams.get("reset"), "a/b+c==");
});

test("both messages lead with plain text and state their own expiry", () => {
  const verify = email.buildVerificationEmail({ to: "driver@example.com", link: "https://example.com/?verify=t" });
  assert.ok(verify.text.includes("https://example.com/?verify=t"));
  assert.match(verify.text, /24 hours/);
  assert.match(verify.subject, /Confirm/i);

  const reset = email.buildPasswordResetEmail({ to: "driver@example.com", link: "https://example.com/?reset=t" });
  assert.ok(reset.text.includes("https://example.com/?reset=t"));
  assert.match(reset.text, /one hour/);
  // Someone who did not ask for this needs to be told that ignoring it is safe, or they panic.
  assert.match(reset.text, /wasn't you/i);
});

test("email tokens are random and stored only as a hash", () => {
  const first = accounts.createEmailToken();
  const second = accounts.createEmailToken();

  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, accounts.hashEmailToken(first.token));
  assert.ok(!first.tokenHash.includes(first.token));
});

test("email token records expire and prune", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  const record = accounts.buildEmailTokenRecord({
    accountId: "acct_1",
    purpose: "reset",
    tokenHash: "hash",
    ttlMs: 60 * 60 * 1000,
    now
  });

  assert.equal(record.purpose, "reset");
  assert.ok(!accounts.isEmailTokenExpired(record, now));
  assert.ok(accounts.isEmailTokenExpired(record, new Date("2026-08-29T13:00:01.000Z")));

  // A record with no expiry, or a corrupt one, counts as expired rather than as eternal.
  assert.ok(accounts.isEmailTokenExpired({ expiresAt: "" }, now));
  assert.ok(accounts.isEmailTokenExpired({ expiresAt: "not-a-date" }, now));

  const kept = accounts.pruneExpiredEmailTokens([record], now);
  assert.equal(kept.length, 1);
  assert.equal(accounts.pruneExpiredEmailTokens([record], new Date("2026-08-30T00:00:00.000Z")).length, 0);
});

test("signing up sends a confirmation link that verifies the address once", async () => {
  await withServer(async (server) => {
    const created = await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });

    assert.equal(created.status, 201);
    assert.equal(created.payload.account.emailVerified, false);

    const message = await waitForOutbox(server, (item) => item.to === "driver@example.com");
    assert.ok(message, "sign-up should send a confirmation email");

    const token = extractToken(message, "verify");
    assert.ok(token, "the message should carry a verify token");

    const verified = await server.call("/api/accounts/verify", { method: "POST", json: { token } });
    assert.equal(verified.status, 200);

    const me = await server.call("/api/accounts/me", { cookie: created.sessionCookie });
    assert.equal(me.payload.account.emailVerified, true);

    // Single use. The same link arriving twice — a forwarded mail, a scanner — must not stay live.
    const replay = await server.call("/api/accounts/verify", { method: "POST", json: { token } });
    assert.equal(replay.status, 400);
  }, OUTBOX_ENV);
});

test("a reset request answers the same way whether or not the address has an account", async () => {
  await withServer(async (server) => {
    await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });

    const known = await server.call("/api/password-resets", { method: "POST", json: { email: "driver@example.com" } });
    const unknown = await server.call("/api/password-resets", { method: "POST", json: { email: "nobody@example.com" } });

    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    // Byte-for-byte identical, because any difference at all is a membership oracle for an address.
    assert.equal(known.raw, unknown.raw);

    const stray = await waitForOutbox(server, (item) => item.to === "nobody@example.com", 1200);
    assert.equal(stray, null, "an address with no account must not receive mail");
  }, OUTBOX_ENV);
});

test("a reset link sets a new password, spends itself, and signs every device out", async () => {
  await withServer(async (server) => {
    const created = await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });
    const oldCookie = created.sessionCookie;

    assert.equal((await server.call("/api/accounts/me", { cookie: oldCookie })).payload.account?.email, "driver@example.com");

    await server.call("/api/password-resets", { method: "POST", json: { email: "driver@example.com" } });
    const message = await waitForOutbox(server, (item) => item.subject === "Reset your password");
    assert.ok(message, "a known address should receive a reset email");

    const token = extractToken(message, "reset");

    const confirmed = await server.call("/api/password-resets/confirm", {
      method: "POST",
      json: { token, password: "brand-new-parking-key" }
    });
    assert.equal(confirmed.status, 200);

    // The session that existed before the reset is gone. A reset is what someone does when they
    // think the account is compromised, so there is no session left worth trusting.
    const stale = await server.call("/api/accounts/me", { cookie: oldCookie });
    assert.equal(stale.payload.account, null);

    const oldPassword = await server.call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await server.call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "brand-new-parking-key" }
    });
    assert.equal(newPassword.status, 200);

    const replay = await server.call("/api/password-resets/confirm", {
      method: "POST",
      json: { token, password: "another-different-one" }
    });
    assert.equal(replay.status, 400, "a spent reset link must not work a second time");
  }, OUTBOX_ENV);
});

test("completing a reset also confirms the address it was sent to", async () => {
  await withServer(async (server) => {
    await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });

    await server.call("/api/password-resets", { method: "POST", json: { email: "driver@example.com" } });
    const message = await waitForOutbox(server, (item) => item.subject === "Reset your password");

    await server.call("/api/password-resets/confirm", {
      method: "POST",
      json: { token: extractToken(message, "reset"), password: "brand-new-parking-key" }
    });

    const signedIn = await server.call("/api/sessions", {
      method: "POST",
      json: { email: "driver@example.com", password: "brand-new-parking-key" }
    });

    // Reaching the link proves control of the mailbox, which is exactly what confirming asks for.
    assert.equal(signedIn.payload.account.emailVerified, true);
  }, OUTBOX_ENV);
});

test("a rejected new password still spends the reset link", async () => {
  await withServer(async (server) => {
    await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });

    await server.call("/api/password-resets", { method: "POST", json: { email: "driver@example.com" } });
    const message = await waitForOutbox(server, (item) => item.subject === "Reset your password");
    const token = extractToken(message, "reset");

    const weak = await server.call("/api/password-resets/confirm", { method: "POST", json: { token, password: "short" } });
    assert.equal(weak.status, 400);

    // The token is the credential, so it burns on the attempt. Leaving it live through a failed
    // validation would keep a link in a readable mailbox usable for as many tries as someone wants.
    const retry = await server.call("/api/password-resets/confirm", {
      method: "POST",
      json: { token, password: "a-perfectly-good-one" }
    });
    assert.equal(retry.status, 400);
  }, OUTBOX_ENV);
});

test("an expired reset link is refused", async () => {
  await withServer(async (server) => {
    await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });

    await server.call("/api/password-resets", { method: "POST", json: { email: "driver@example.com" } });
    const message = await waitForOutbox(server, (item) => item.subject === "Reset your password");
    const token = extractToken(message, "reset");

    const tokens = server.readCollection("email-tokens");
    server.writeCollection(
      "email-tokens",
      tokens.map((item) => (item.purpose === "reset" ? { ...item, expiresAt: "2020-01-01T00:00:00.000Z" } : item))
    );

    const expired = await server.call("/api/password-resets/confirm", {
      method: "POST",
      json: { token, password: "brand-new-parking-key" }
    });
    assert.equal(expired.status, 400);
  }, OUTBOX_ENV);
});

test("deleting an account takes its outstanding links with it", async () => {
  await withServer(async (server) => {
    const created = await server.call("/api/accounts", {
      method: "POST",
      json: { email: "driver@example.com", password: "curb-sweeper-2026" }
    });

    await waitForOutbox(server, (item) => item.to === "driver@example.com");
    assert.ok(server.readCollection("email-tokens").length > 0);

    const deleted = await server.call("/api/accounts/me", {
      method: "DELETE",
      cookie: created.sessionCookie,
      json: { password: "curb-sweeper-2026" }
    });
    assert.equal(deleted.status, 200);

    // A live link outliving its account is a way back in if the address is ever reused.
    assert.equal(server.readCollection("email-tokens").length, 0);
  }, OUTBOX_ENV);
});

test("with no provider configured the routes say so instead of pretending", async () => {
  await withServer(async (server) => {
    const config = await server.call("/api/email/config");
    assert.equal(config.payload.enabled, false);

    const reset = await server.call("/api/password-resets", { method: "POST", json: { email: "driver@example.com" } });
    assert.equal(reset.status, 503, "offering a reset the server cannot send is worse than not offering one");
  }, { EMAIL_TRANSPORT: "" });
});

// The branded HTML has to keep the one property that separates a reset mail from the phishing it
// resembles: the destination is visible. A styled "Click here" button hides where the link goes,
// which on a phone means nowhere the reader can check -- so the URL is shown in full, and the
// thing shown is the thing tapped. Reworded and restyled 2026-09-21.
test("the reset link is shown in full rather than hidden behind a button", () => {
  const link = email.buildActionLink("https://www.curbalerts.co", "reset", "token-abc");
  const { html } = email.buildPasswordResetEmail({ to: "driver@example.com", link });

  assert.ok(html.includes(`href="${link}"`), "the link is not the anchor's destination");
  assert.ok(html.includes(`>${link}</a>`), "the link text is not the link itself");
  assert.doesNotMatch(html, /Click here|Reset your password<\/a>|>\s*Reset password\s*</i);
});

// Remote images are blocked by default in most clients, so a logo that does not load leaves a
// broken box exactly where the identity was meant to be. The wordmark is text for that reason.
test("the branding survives a client that blocks images", () => {
  const link = email.buildActionLink("https://www.curbalerts.co", "verify", "token-abc");
  const { html } = email.buildVerificationEmail({ to: "driver@example.com", link });

  assert.doesNotMatch(html, /<img/i);
  assert.ok(html.includes("Denver Curb Alerts"), "no wordmark to fall back to");
  assert.ok(html.includes("Curb Alerts LLC"), "no operating entity in the footer");
});

// Outlook on Windows renders through Word, which ignores max-width on a div. A table with an
// explicit width attribute is the one layout that survives it, and <style> blocks are stripped by
// Gmail in several contexts, so everything that matters is inline.
test("the layout is table-based with inline styles, for Outlook and Gmail", () => {
  const link = email.buildActionLink("https://www.curbalerts.co", "reset", "token-abc");
  const { html } = email.buildPasswordResetEmail({ to: "driver@example.com", link });

  assert.match(html, /<table role="presentation"[^>]*width="520"/);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /class="/);
});

// The plain text part is the payload, and it carries the bare URL. A client that shows only text
// still has to be able to complete a reset.
test("the plain text part still carries the bare link", () => {
  const link = email.buildActionLink("https://www.curbalerts.co", "reset", "token-abc");
  const { text } = email.buildPasswordResetEmail({ to: "driver@example.com", link });

  assert.ok(text.includes(link));
  assert.doesNotMatch(text, /[<>]/, "the text part has picked up markup");
});

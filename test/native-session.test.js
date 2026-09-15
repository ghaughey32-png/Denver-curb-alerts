"use strict";

// Signing in from inside the iOS app.
//
// The shell serves the page off curbalerts://, so to the API it is a cross-site origin that can never
// carry the session cookie. It signs in with the same session as a bearer token instead, kept in the
// device keychain. The server's handling of the token has its own cases in test/accounts.test.js;
// this file covers what sits between the two halves: that the API lets such a request through CORS at
// all, and that the client sends the token without ever storing it where a page can read it. Like the
// other source-text tests, renaming the functions below breaks it by design.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { withServer } = require("./lib/with-server.js");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");
const SHELL_PATH = path.join(__dirname, "..", "ios", "CurbAlerts", "WebShell.swift");
const KEYCHAIN_PATH = path.join(__dirname, "..", "ios", "CurbAlerts", "SessionKeychain.swift");

test("the API lets the shell's origin present a bearer token, and never offers it credentials", async () => {
  await withServer(async ({ origin, call }) => {
    const created = await call("/api/accounts", {
      method: "POST",
      json: { email: "keychain@example.com", password: "sweeping-tuesday-8am", issueSessionToken: true }
    });
    const token = created.payload.sessionToken;
    assert.ok(token, "sign-up did not issue a token to a client that asked for one");

    // WebKit reports a custom scheme's origin either as the scheme itself or, opaquely, as "null".
    for (const shellOrigin of ["curbalerts://app", "null"]) {
      const preflight = await fetch(`${origin}/api/accounts/me`, {
        method: "OPTIONS",
        headers: {
          Origin: shellOrigin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization"
        }
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.match(preflight.headers.get("access-control-allow-headers") || "", /authorization/i);
      // Credentials are for origins the app is actually served from. The shell is not one, and it
      // must not become one to make sign-in work - that is what the bearer token is for.
      assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

      const me = await fetch(`${origin}/api/accounts/me`, {
        headers: { Origin: shellOrigin, Authorization: `Bearer ${token}` }
      });
      assert.equal(me.headers.get("access-control-allow-origin"), "*");
      assert.equal((await me.json()).account.email, "keychain@example.com");
    }
  });
});

test("the client sends the shell's token as a header and keeps it out of page storage", () => {
  const app = fs.readFileSync(APP_PATH, "utf8");

  // Asking for credentials against the API's wildcard answer makes the browser refuse the whole
  // request, which is exactly how sign-in used to fail inside the app.
  assert.match(app, /credentials: sessionBridge \? "omit" : "include"/);
  assert.match(app, /headers\.Authorization = `Bearer \$\{token\}`/);
  assert.match(app, /\.\.\.\(getNativeSessionBridge\(\) \? \{ issueSessionToken: true \} : \{\}\)/);

  // A 30-day credential in localStorage is precisely the exposure the HttpOnly cookie exists to avoid.
  assert.doesNotMatch(app, /(saveJson|localStorage\.setItem)\([^)]*[Ss]ession[Tt]oken/);

  // Signing out must send the token before forgetting it, or the server never revokes the session.
  const signOutStart = app.indexOf("async function signOutAccount(");
  const signOut = app.slice(signOutStart, app.indexOf("function hideAccountSubforms(", signOutStart));
  const revoke = signOut.indexOf('accountRequest("/api/sessions", { method: "DELETE" })');
  const forget = signOut.indexOf("forgetNativeSessionToken()");
  assert.ok(revoke >= 0 && forget > revoke, "sign-out forgets the token before the server has revoked it");

  const shell = fs.readFileSync(SHELL_PATH, "utf8");
  for (const action of ["getSessionToken", "setSessionToken", "clearSessionToken"]) {
    assert.ok(shell.includes(`case "${action}":`), `the shell no longer answers ${action}`);
  }

  // A session belongs to one phone; a backup restored onto another should not carry it across.
  const keychain = fs.readFileSync(KEYCHAIN_PATH, "utf8");
  assert.ok(keychain.includes("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"));
});

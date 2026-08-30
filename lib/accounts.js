// Account identity for Denver Curb Alerts.
//
// Everything the app knows about a person used to hang off their push subscription endpoint, which
// is a per-browser, per-install string: reinstall the PWA and the "account" is gone. That is fine
// for a free anonymous tool and impossible to bill, so this module introduces a durable identity.
//
// It is deliberately dependency-free. Node's own crypto has everything password storage needs
// (scrypt is memory-hard and is what the Node docs point at for this), so adding bcrypt or a session
// framework would buy nothing but a build step this project does not have. Keep it that way.
//
// This file is pure: no filesystem, no database, no HTTP. server.js owns the storage and the routes,
// and test/accounts.test.js can exercise the interesting parts without standing a server up.

const crypto = require("node:crypto");

// scrypt cost. 16384/8/1 is the Node documentation's own reference point and takes roughly 60-80ms
// per hash on Render's smallest instance, which is the right order of magnitude: slow enough that
// offline guessing is expensive, fast enough that a sign-in does not feel broken. maxmem has to be
// raised past Node's 32MB default because 128 * N * r is 16MB and Node wants headroom.
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SALT_BYTES = 16;

const SESSION_TOKEN_BYTES = 32;
const EMAIL_TOKEN_BYTES = 32;
const EMAIL_TOKEN_PURPOSES = new Set(["verify", "reset"]);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "curb_session";

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

// Not a serious dictionary — a serious one belongs in a breach-corpus check we are not doing yet.
// This only catches the handful of passwords that would otherwise be the most common in a small
// user base, where one guess per account would actually work.
const BANNED_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd123",
  "1234567890",
  "12345678901",
  "123456789012",
  "qwertyuiop",
  "letmein123",
  "denver1234",
  "iloveyou12",
  "adminadmin",
  "curbalerts",
  "streetsweep"
]);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Deliberately permissive. The only email syntax that matters is whatever the delivery provider
// will accept, and no regex agrees with that; this rejects the obviously-not-an-address cases and
// lets verification catch the rest.
function isValidEmail(email) {
  const normalized = normalizeEmail(email);

  if (!normalized || normalized.length > MAX_EMAIL_LENGTH) {
    return false;
  }

  if (/\s/.test(normalized)) {
    return false;
  }

  const parts = normalized.split("@");
  if (parts.length !== 2) {
    return false;
  }

  const [local, domain] = parts;
  if (!local || !domain) {
    return false;
  }

  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

function validatePassword(password, email) {
  const value = String(password || "");

  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at most ${MAX_PASSWORD_LENGTH} characters.` };
  }

  const lowered = value.toLowerCase();

  if (BANNED_PASSWORDS.has(lowered)) {
    return { ok: false, error: "That password is too common. Pick something else." };
  }

  if (new Set(value).size < 4) {
    return { ok: false, error: "That password repeats too few characters." };
  }

  const localPart = normalizeEmail(email).split("@")[0];
  if (localPart && localPart.length >= 4 && lowered.includes(localPart)) {
    return { ok: false, error: "Don't use your email address in your password." };
  }

  return { ok: true, error: "" };
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      }
    );
  });
}

// Stored as a single self-describing string so the cost parameters travel with the hash. Raising
// SCRYPT_COST later leaves old hashes verifiable, which is the whole point of the format.
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptHash(password, salt);

  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("hex"),
    derived.toString("hex")
  ].join("$");
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");

  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return false;
  }

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password || ""),
      salt,
      expected.length,
      { N: cost, r: blockSize, p: parallelization, maxmem: SCRYPT_MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });

  return crypto.timingSafeEqual(derived, expected);
}

function createSessionToken() {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

// The database stores the hash, never the token. A leaked accounts dump then does not hand the
// reader a set of live sessions, and sha256 is the right primitive here rather than scrypt: the
// token is 256 bits of randomness, so there is no guessing to slow down.
function hashSessionToken(token) {
  return sha256Hex(token);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

// Verification and reset links carry a token of the same shape as a session token, and are stored
// the same way: the collection holds the sha256, never the token itself. A reset token is a live
// credential — anyone holding one can take the account — so a leaked database dump must not be a
// bag of working reset links. sha256 rather than scrypt for the same reason as sessions: 256 bits
// of randomness has no guessing to slow down.
function createEmailToken() {
  const token = crypto.randomBytes(EMAIL_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

function hashEmailToken(token) {
  return sha256Hex(token);
}

// Single-use is enforced by deleting the record on consumption, not by a flag on it. A flag leaves
// a spent token in the collection looking almost exactly like a live one, and the difference
// between the two is the whole security property.
function buildEmailTokenRecord({ accountId, purpose, tokenHash, ttlMs, now = new Date() }) {
  return {
    id: `tok_${crypto.randomBytes(8).toString("hex")}`,
    accountId,
    purpose: EMAIL_TOKEN_PURPOSES.has(purpose) ? purpose : "verify",
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
  };
}

function isEmailTokenExpired(record, now = new Date()) {
  if (!record?.expiresAt) {
    return true;
  }

  const expiresAt = new Date(record.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return true;
  }

  return expiresAt.getTime() <= now.getTime();
}

function pruneExpiredEmailTokens(records, now = new Date()) {
  return records.filter((record) => !isEmailTokenExpired(record, now));
}

function buildAccountRecord({ email, passwordHash, now = new Date() }) {
  const timestamp = now.toISOString();

  return {
    id: `acct_${crypto.randomBytes(12).toString("hex")}`,
    email: normalizeEmail(email),
    passwordHash,
    createdAt: timestamp,
    updatedAt: timestamp,
    emailVerifiedAt: null,
    billing: buildTrialBilling(now)
  };
}

// Present from the first account so the payment work was a matter of filling these in rather than
// migrating every existing row. The shape follows Stripe's subscription object because that is what
// the webhook hands us: status is Stripe's own vocabulary, not ours.
//
// This is the unentitled shape, and it stays that way because getEntitlement falls back to it for
// an account whose billing is missing or corrupt. A default that granted anything would make a
// damaged record the most valuable one in the collection. New accounts get buildTrialBilling
// instead; this is the floor, not the starting point.
function buildDefaultBilling() {
  return {
    plan: "free",
    status: "none",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    interval: null,
    trialStartedAt: null
  };
}

// The paid product here is the account itself, which leaves no honest way to charge at the door:
// there is nothing to attach a card to until the account exists, and a card wall on the sign-up
// form is where a $15/year utility loses everyone. So every account opens on a trial, and it is a
// real Stripe status rather than a flag of our own — "trialing" was already in the entitled set
// below, and expressing it Stripe's way means the webhook can take the same record over without a
// translation step when the customer converts.
//
// TRIAL_DAYS lives in lib/billing.js beside the price configuration, not here. This module is the
// one that decides whether someone is entitled; it should not also own how long they get for free.
function buildTrialBilling(now = new Date(), trialDays = 14) {
  const timestamp = now.toISOString();

  return {
    plan: "trial",
    status: "trialing",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString(),
    cancelAtPeriodEnd: false,
    interval: null,
    trialStartedAt: timestamp
  };
}

// Which Stripe statuses still entitle someone to the paid features. "past_due" is included on
// purpose: the card failed but Stripe is still retrying, and cutting a paying customer's sweeping
// reminders off mid-dunning is how you turn a failed payment into a ticket.
const ENTITLED_BILLING_STATUSES = new Set(["active", "trialing", "past_due"]);

function getEntitlement(account, now = new Date()) {
  const billing = account?.billing || buildDefaultBilling();
  const periodEnd = billing.currentPeriodEnd ? new Date(billing.currentPeriodEnd) : null;
  const withinPeriod = !periodEnd || Number.isNaN(periodEnd.getTime()) || periodEnd.getTime() > now.getTime();

  return {
    plan: billing.plan || "free",
    status: billing.status || "none",
    active: ENTITLED_BILLING_STATUSES.has(billing.status) && withinPeriod,
    currentPeriodEnd: billing.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(billing.cancelAtPeriodEnd),
    interval: billing.interval || null,
    // A trial that has not been converted has no Stripe subscription behind it, which is what the
    // client needs to tell "start a checkout" apart from "manage the subscription you have".
    trialing: billing.status === "trialing" && !billing.stripeSubscriptionId,
    manageable: Boolean(billing.stripeCustomerId)
  };
}

// The only account shape that ever crosses the wire. Password hashes leaving the server, even to
// their owner, is how they end up in a log or a cache.
function toPublicAccount(account, now = new Date()) {
  if (!account) {
    return null;
  }

  return {
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    emailVerified: Boolean(account.emailVerifiedAt),
    entitlement: getEntitlement(account, now)
  };
}

function buildSessionRecord({ accountId, tokenHash, userAgent = "", now = new Date() }) {
  return {
    id: `sess_${crypto.randomBytes(8).toString("hex")}`,
    accountId,
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    userAgent: String(userAgent || "").slice(0, 200)
  };
}

function isSessionExpired(session, now = new Date()) {
  if (!session?.expiresAt) {
    return true;
  }

  const expiresAt = new Date(session.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return true;
  }

  return expiresAt.getTime() <= now.getTime();
}

function pruneExpiredSessions(sessions, now = new Date()) {
  return sessions.filter((session) => !isSessionExpired(session, now));
}

function parseCookies(cookieHeader) {
  const jar = {};

  String(cookieHeader || "")
    .split(";")
    .forEach((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) {
        return;
      }

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) {
        jar[name] = decodeURIComponent(value);
      }
    });

  return jar;
}

// SameSite=Lax rather than Strict: the payment flow will bounce through Stripe's hosted checkout
// and come back by top-level redirect, and Strict drops the cookie on that return trip, landing the
// customer on a signed-out page immediately after paying.
function buildSessionCookie(token, { secure = true, maxAgeSeconds = SESSION_TTL_MS / 1000 } = {}) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function buildExpiredSessionCookie({ secure = true } = {}) {
  return buildSessionCookie("", { secure, maxAgeSeconds: 0 });
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  isValidEmail,
  validatePassword,
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  createEmailToken,
  hashEmailToken,
  buildEmailTokenRecord,
  isEmailTokenExpired,
  pruneExpiredEmailTokens,
  buildAccountRecord,
  buildDefaultBilling,
  buildTrialBilling,
  getEntitlement,
  toPublicAccount,
  buildSessionRecord,
  isSessionExpired,
  pruneExpiredSessions,
  parseCookies,
  buildSessionCookie,
  buildExpiredSessionCookie
};

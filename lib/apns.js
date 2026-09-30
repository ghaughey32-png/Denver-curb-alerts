// Apple Push Notification service: the server's way to reach an iPhone that has not opened the app.
//
// Sweep reminders do not need this and do not use it. Their dates are known weeks ahead, so the app
// schedules them on the phone itself (ios/CurbAlerts/ReminderScheduler.swift) and they fire with no
// connection at all. What that cannot do is react: a snow emergency is declared a few hours before
// it bites, and a phone that has not opened the app that day has no way to learn about it. This is
// the path for news the phone could not have scheduled in advance.
//
// No dependency. `node:http2` speaks to Apple and `node:crypto` signs the ES256 token; asking for
// the signature in `ieee-p1363` form hands back the 64-byte r||s that JOSE wants, so there is no DER
// to unpick. Pure apart from `sendApnsNotification`, the one function touching the network, in the
// shape of lib/email.js.

const crypto = require("node:crypto");
const http2 = require("node:http2");

const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com"
};

const DEFAULT_TOPIC = "co.curbalerts.app";

// Apple refuses a provider token older than an hour and throttles one refreshed more often than
// every twenty minutes, so it is reused for fifty.
const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60 * 1000;

// A Render env var cannot hold a newline comfortably, so a .p8 pasted with literal "\n" in it is
// accepted as well as the file as written.
function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

// Everything the sender needs, read from the environment. `enabled` is false unless all three
// credentials are present and the key actually parses, so a pasted key with a missing line fails at
// config time with a reason rather than on the first storm.
//
// APNS_ORIGIN replaces both of Apple's hosts. It exists so test/apns.test.js can stand up a fake
// APNs over plain HTTP/2 and read what was sent; nothing in production sets it.
function getApnsConfig(env = process.env) {
  const keyId = String(env.APNS_KEY_ID || "").trim();
  const teamId = String(env.APNS_TEAM_ID || "").trim();
  const privateKeyText = normalizePrivateKey(env.APNS_PRIVATE_KEY);
  const topic = String(env.APNS_TOPIC || DEFAULT_TOPIC).trim();
  const originOverride = String(env.APNS_ORIGIN || "").trim();

  if (!keyId || !teamId || !privateKeyText) {
    return { enabled: false, reason: "Set APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY." };
  }

  let privateKey = null;
  try {
    privateKey = crypto.createPrivateKey(privateKeyText);
  } catch (error) {
    return { enabled: false, reason: `APNS_PRIVATE_KEY is not a readable .p8 key: ${error.message}` };
  }

  return { enabled: true, keyId, teamId, privateKey, topic, originOverride };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function buildProviderToken(config, now = Date.now()) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

// One cached token per key. Cleared by `forgetProviderToken` when Apple calls it expired or invalid,
// so the next send signs a fresh one instead of repeating the refusal for fifty minutes.
const providerTokenCache = new Map();

function getProviderToken(config, now = Date.now()) {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  const cached = providerTokenCache.get(cacheKey);
  if (cached && now - cached.issuedAt < PROVIDER_TOKEN_LIFETIME_MS) {
    return cached.token;
  }

  const token = buildProviderToken(config, now);
  providerTokenCache.set(cacheKey, { token, issuedAt: now });
  return token;
}

function forgetProviderToken(config) {
  providerTokenCache.delete(`${config.teamId}:${config.keyId}`);
}

// A device token is hex. Apple says not to assume its length, so anything from 32 bytes up to a
// generous ceiling is accepted, lowercased so the same phone never registers twice.
function normalizeDeviceToken(value) {
  const token = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{64,256}$/.test(token) ? token : "";
}

// Debug builds from Xcode get sandbox tokens; TestFlight and App Store builds get production ones.
// A token sent to the wrong host is refused as BadDeviceToken, so the device says which it is.
function normalizeEnvironment(value) {
  return value === "sandbox" ? "sandbox" : "production";
}

// The stored identity of an APNs device. Keeping the push-subscriptions collection keyed on an
// endpoint string is what lets the account join and the deletion cascade in server.js handle these
// records without learning a second shape.
function buildApnsEndpoint(token) {
  return `apns://${token}`;
}

// `url` rides alongside `aps` rather than inside it, which is where NotificationCoordinator already
// looks for it: a tapped push opens the page exactly as a tapped local reminder does.
//
// `timeSensitive` lets it through a Focus mode, which is the point for an emergency and too much for
// anything else, so it is opt-in per send.
function buildAlertPayload({ title, body, url, timeSensitive }) {
  const aps = {
    alert: { title: String(title || "Curb Alerts"), body: String(body || "") },
    sound: "default"
  };
  if (timeSensitive) {
    aps["interruption-level"] = "time-sensitive";
  }

  return { aps, url: String(url || "/") };
}

// Apple's answer, sorted into what the caller has to do about it. A token Apple no longer
// recognises is removed, since it will never work again; a refusal of our own credentials is a
// configuration problem that no amount of retrying one device fixes.
function classifyApnsResponse(status, reason) {
  if (status === 200) {
    return "sent";
  }

  if (status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered") {
    return "dead-token";
  }

  if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") {
    return "bad-credentials";
  }

  return "failed";
}

// Sessions are reused across a broadcast, one per host, since HTTP/2 multiplexes every send over a
// single connection. They are unref'd so a pending idle connection never holds the process open.
const sessions = new Map();

function getSession(origin) {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }

  const session = http2.connect(origin);
  session.on("error", () => sessions.delete(origin));
  session.on("close", () => sessions.delete(origin));
  session.setTimeout(5 * 60 * 1000, () => session.close());
  session.unref();
  sessions.set(origin, session);
  return session;
}

function closeApnsSessions() {
  for (const session of sessions.values()) {
    session.close();
  }
  sessions.clear();
}

// Resolves { status, reason, outcome } and never rejects: a broadcast to a hundred phones must not
// stop at the first one that is offline or has deleted the app.
function sendApnsNotification({ config, token, environment, payload, expiresInSeconds = 6 * 60 * 60 }) {
  const origin = config.originOverride || APNS_HOSTS[normalizeEnvironment(environment)];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        if (result.outcome === "bad-credentials") {
          forgetProviderToken(config);
        }
        resolve(result);
      }
    };

    let request = null;
    try {
      const session = getSession(origin);
      request = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${getProviderToken(config)}`,
        "apns-topic": config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        // A warning that arrives after the tow truck is worse than none, so Apple is told to give up
        // rather than deliver it late to a phone that was off.
        "apns-expiration": String(Math.floor(Date.now() / 1000) + expiresInSeconds),
        "content-type": "application/json"
      });
    } catch (error) {
      finish({ status: 0, reason: error.message, outcome: "failed" });
      return;
    }

    let status = 0;
    let body = "";
    request.setTimeout(15000, () => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      finish({ status: 0, reason: "Timed out", outcome: "failed" });
    });
    request.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let reason = "";
      try {
        reason = body ? String(JSON.parse(body).reason || "") : "";
      } catch {
        reason = body.slice(0, 200);
      }
      finish({ status, reason, outcome: classifyApnsResponse(status, reason) });
    });
    request.on("error", (error) => {
      finish({ status: 0, reason: error.message, outcome: "failed" });
    });
    request.end(JSON.stringify(payload));
  });
}

module.exports = {
  DEFAULT_TOPIC,
  buildAlertPayload,
  buildApnsEndpoint,
  buildProviderToken,
  classifyApnsResponse,
  closeApnsSessions,
  getApnsConfig,
  getProviderToken,
  normalizeDeviceToken,
  normalizeEnvironment,
  normalizePrivateKey,
  sendApnsNotification
};

// Stripe billing for Denver Curb Alerts.
//
// Every account already carried the plan and subscription fields a payment would fill in; this is
// what fills them. It is deliberately dependency-free, the same way lib/accounts.js is. Stripe's
// npm package is a convenience wrapper over a form-encoded HTTPS API and an HMAC signature check,
// and both of those are a few dozen lines of node:https and node:crypto. Adding the package would
// buy retries and typings in exchange for the first dependency this project cannot lazily require,
// so `https.request` it is. Reach for the package only if webhook volume ever justifies it.
//
// The pure half of this file — signature verification, form encoding, mapping a Stripe subscription
// onto our billing shape — is separated from stripeRequest on purpose, so test/billing.test.js can
// exercise the parts that decide whether someone is paid up without a network or a Stripe key.

const crypto = require("node:crypto");
const https = require("node:https");

const STRIPE_API_HOST = "api.stripe.com";
const STRIPE_API_VERSION = "2024-06-20";

// How long a new account can sync before it has to pay. The account itself is the paid product
// here, so without a trial there is nothing between "create an account" and "enter a card" — and
// a card wall on a signup form for a $15/year utility is where the funnel ends. Fourteen days is
// long enough to cover at least two sweeping cycles on any Denver block, which is the point: the
// trial has to outlast a full sweep-and-reminder loop or the customer never sees what they'd pay
// for.
const TRIAL_DAYS = 14;

// Stripe's own tolerance for webhook replay. The timestamp is inside the signed payload, so an
// attacker cannot move it, but a captured-and-replayed request is still worth bounding.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// The subscription statuses that still entitle someone. Kept beside getEntitlement's copy in
// lib/accounts.js rather than imported, because that module is the one place the app asks the
// question and it should not need this file to answer it.
const PRICE_INTERVALS = new Set(["month", "year"]);

function getBillingConfig(env = process.env) {
  const secretKey = String(env.STRIPE_SECRET_KEY || "");
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || "");
  const monthlyPriceId = String(env.STRIPE_PRICE_MONTHLY || "");
  const annualPriceId = String(env.STRIPE_PRICE_ANNUAL || "");
  const appOrigin = String(env.APP_ORIGIN || "").replace(/\/+$/, "");

  const hasPrices = Boolean(monthlyPriceId || annualPriceId);

  return {
    // Billing degrades the way push does: with nothing configured the endpoints answer 503 and the
    // client hides the upgrade UI, rather than the app failing to boot. A local checkout needs
    // real test keys, so this is the normal state during development.
    enabled: Boolean(secretKey && hasPrices),
    webhookReady: Boolean(secretKey && webhookSecret),
    secretKey,
    webhookSecret,
    monthlyPriceId,
    annualPriceId,
    appOrigin,
    trialDays: TRIAL_DAYS,
    // Display only. The authoritative amounts live in the Stripe dashboard, and nothing in the app
    // charges from these numbers — they exist so the upgrade button can say what it costs without
    // a round trip to Stripe on every page load.
    prices: {
      month: { id: monthlyPriceId, amount: 199, currency: "usd", label: "$1.99 / month" },
      year: { id: annualPriceId, amount: 1500, currency: "usd", label: "$15 / year" }
    }
  };
}

// What the client is allowed to know. The secret key and the webhook secret never leave the server,
// and the price ids are safe to publish but pointless to, since checkout is created server-side.
function getPublicBillingConfig(config = getBillingConfig()) {
  return {
    enabled: config.enabled,
    trialDays: config.trialDays,
    prices: {
      month: { amount: config.prices.month.amount, label: config.prices.month.label, available: Boolean(config.monthlyPriceId) },
      year: { amount: config.prices.year.amount, label: config.prices.year.label, available: Boolean(config.annualPriceId) }
    }
  };
}

function resolvePriceId(interval, config = getBillingConfig()) {
  if (!PRICE_INTERVALS.has(interval)) {
    return "";
  }

  return interval === "year" ? config.annualPriceId : config.monthlyPriceId;
}

// Stripe takes form-encoded bodies with bracketed paths for nested data — metadata[accountId],
// line_items[0][price]. Nothing else in this app speaks that shape, so it is spelled out here
// rather than reached for from a query-string helper that would flatten it wrong.
function encodeStripeForm(payload, prefix = "") {
  const parts = [];

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) {
      continue;
    }

    const path = prefix ? `${prefix}[${key}]` : key;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") {
          parts.push(encodeStripeForm(item, `${path}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${path}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (value && typeof value === "object") {
      parts.push(encodeStripeForm(value, path));
    } else {
      parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts.filter(Boolean).join("&");
}

async function stripeRequest(method, endpoint, payload, config = getBillingConfig()) {
  if (!config.secretKey) {
    throw new Error("Stripe is not configured on this server.");
  }

  const body = payload ? encodeStripeForm(payload) : "";

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: STRIPE_API_HOST,
        path: `/v1/${endpoint}`,
        method,
        headers: {
          // Basic auth with the secret key as the username and an empty password is Stripe's
          // documented scheme; the Bearer form works too but this is what their own libraries send.
          Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "Stripe-Version": STRIPE_API_VERSION
        },
        timeout: 20000
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new Error(`Stripe returned a response that is not JSON (HTTP ${response.statusCode}).`));
            return;
          }

          if (response.statusCode >= 400) {
            // Stripe's own message is the useful one here ("No such price", "Invalid API Key"),
            // and it is safe to surface: it describes our configuration, not the customer.
            reject(new Error(parsed?.error?.message || `Stripe request failed with HTTP ${response.statusCode}.`));
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.on("timeout", () => request.destroy(new Error("Stripe request timed out.")));
    request.on("error", reject);
    request.end(body);
  });
}

// Stripe signs `${timestamp}.${rawBody}`, which is why the webhook route has to read the body as
// text and must not be handed a re-serialized JSON object: JSON.stringify(JSON.parse(x)) is not x,
// and every key reordering or whitespace difference breaks the signature.
function verifyWebhookSignature(rawBody, signatureHeader, secret, { now = Date.now(), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS } = {}) {
  if (!secret) {
    return { ok: false, error: "No webhook signing secret is configured." };
  }

  const parts = String(signatureHeader || "")
    .split(",")
    .map((piece) => piece.trim().split("="))
    .filter((pair) => pair.length === 2);

  const timestamp = parts.find(([key]) => key === "t")?.[1] || "";
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);

  if (!timestamp || !signatures.length) {
    return { ok: false, error: "Malformed Stripe signature header." };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: "Malformed Stripe signature timestamp." };
  }

  if (Math.abs(now / 1000 - timestampSeconds) > toleranceSeconds) {
    return { ok: false, error: "Stripe signature timestamp is outside the tolerance window." };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const matched = signatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, "hex");
    // timingSafeEqual throws on a length mismatch rather than returning false, and a wrong-length
    // signature is a mismatch, not an error worth propagating.
    return candidateBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
  });

  return matched ? { ok: true, error: "" } : { ok: false, error: "Stripe signature does not match." };
}

function unixSecondsToIso(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

// Stripe moved the period boundaries onto the subscription item in newer API versions while
// leaving the top-level field in place for older ones. Read both so pinning or unpinning
// Stripe-Version above does not silently start handing every customer a null period end, which
// getEntitlement would read as "no expiry" and treat as permanently entitled.
function readCurrentPeriodEnd(subscription) {
  return (
    unixSecondsToIso(subscription?.current_period_end) ||
    unixSecondsToIso(subscription?.items?.data?.[0]?.current_period_end) ||
    null
  );
}

function readSubscriptionInterval(subscription) {
  const interval = subscription?.items?.data?.[0]?.price?.recurring?.interval || "";
  return PRICE_INTERVALS.has(interval) ? interval : null;
}

function readStripeId(value) {
  if (!value) {
    return null;
  }

  // Stripe sends either a bare id or an expanded object depending on the event and the request.
  return typeof value === "string" ? value : value.id || null;
}

// The one place a Stripe subscription becomes our billing record. Everything the webhook does is
// this plus a lookup, which keeps the event handling in server.js down to routing.
function billingFromSubscription(subscription, existing = {}) {
  const status = String(subscription?.status || "none");

  return {
    plan: status === "canceled" || status === "incomplete_expired" ? "free" : "reminders",
    status,
    stripeCustomerId: readStripeId(subscription?.customer) || existing.stripeCustomerId || null,
    stripeSubscriptionId: readStripeId(subscription?.id) || existing.stripeSubscriptionId || null,
    currentPeriodEnd: readCurrentPeriodEnd(subscription),
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    interval: readSubscriptionInterval(subscription) || existing.interval || null,
    // Preserved so "when did this person start" survives the first payment. Nothing reads it yet;
    // the first support question about a refund window will.
    trialStartedAt: existing.trialStartedAt || null
  };
}

module.exports = {
  TRIAL_DAYS,
  WEBHOOK_TOLERANCE_SECONDS,
  getBillingConfig,
  getPublicBillingConfig,
  resolvePriceId,
  encodeStripeForm,
  stripeRequest,
  verifyWebhookSignature,
  billingFromSubscription,
  readCurrentPeriodEnd,
  readSubscriptionInterval,
  unixSecondsToIso
};

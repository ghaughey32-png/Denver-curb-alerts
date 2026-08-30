// Transactional email for Denver Curb Alerts.
//
// The app has never had an email provider, which is why it has never had email verification or a
// password reset: both are a link in an inbox and nothing else. This is the missing half.
//
// It follows lib/billing.js exactly. Stripe taught us that a provider's npm package is a wrapper
// over an HTTPS call, and Resend's is thinner than most — one JSON POST to one endpoint. So this is
// node:https, no dependency, and the impure parts are quarantined at the bottom of the file so
// test/email.test.js can exercise the templates and the config without a network or an API key.
//
// Swapping providers later is the `deliverViaResend` function and nothing else. It is deliberately
// not an adapter layer: an abstraction over one provider you have never changed is indirection you
// pay for on every read, and the real cost of switching is the DNS records, not these thirty lines.

const https = require("node:https");
const fs = require("node:fs/promises");

const RESEND_API_HOST = "api.resend.com";
const RESEND_API_PATH = "/emails";

// How long a link stays good. A verification link is a convenience and can afford to be generous;
// a reset link is a live credential sitting in an inbox, and an hour is the industry convention
// because it is long enough to walk away from the computer and short enough that a mailbox someone
// else later reads is not a standing account takeover.
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function getEmailConfig(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || "");
  const fromAddress = String(env.EMAIL_FROM || "");

  // EMAIL_TRANSPORT=outbox is what makes the feature reachable without a provider. Falling back to
  // the outbox only when email is *disabled* would have been useless: the routes answer 503 in
  // exactly that state, so nothing would ever reach the file. This says "email works, deliver it
  // to disk" instead, which is the whole flow end to end — request a reset, open data/outbox.json,
  // click the link — with no API key and no verified domain. It is also what the tests run under.
  const useOutbox = String(env.EMAIL_TRANSPORT || "").toLowerCase() === "outbox";

  return {
    // Otherwise this degrades the way billing does: with nothing configured the routes answer 503
    // and the client hides the controls, rather than the app failing to boot. Real sending needs a
    // verified domain at the provider, so disabled is the normal state until there is a domain.
    enabled: useOutbox || Boolean(apiKey && fromAddress),
    outbox: useOutbox,
    apiKey,
    fromAddress,
    verificationTokenTtlMs: VERIFICATION_TOKEN_TTL_MS,
    resetTokenTtlMs: RESET_TOKEN_TTL_MS
  };
}

// What the client is allowed to know: whether to offer "Forgot password?" at all. Offering a reset
// link the server cannot send is worse than not offering one, because the user then waits for mail
// that is never coming instead of asking for help.
function getPublicEmailConfig(config = getEmailConfig()) {
  return { enabled: config.enabled };
}

function buildActionLink(origin, param, token) {
  const base = String(origin || "").replace(/\/+$/, "");
  return `${base}/?${param}=${encodeURIComponent(token)}`;
}

// Plain text is the payload and the HTML is the courtesy, not the other way round. A reset mail
// that is all markup and a single styled button is indistinguishable from the phishing it is
// training people to click, and it is the message most likely to be read on a locked phone.
function wrapHtml(lines) {
  const body = lines
    .map((line) => (line.startsWith("http") ? `<p><a href="${line}">${line}</a></p>` : `<p>${line}</p>`))
    .join("\n");

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c2530;max-width:520px">',
    body,
    "</div>"
  ].join("\n");
}

function buildVerificationEmail({ to, link }) {
  const lines = [
    "Confirm your email address so we can reach you about your Denver Curb Alerts account.",
    link,
    "This link works for 24 hours. Your reminders keep running either way — confirming just means we can send you a password reset if you ever need one.",
    "If you didn't create an account, you can ignore this message."
  ];

  return {
    to,
    subject: "Confirm your email address",
    text: lines.join("\n\n"),
    html: wrapHtml(lines)
  };
}

function buildPasswordResetEmail({ to, link }) {
  const lines = [
    "Someone asked to reset the password for your Denver Curb Alerts account.",
    link,
    "This link works for one hour and can only be used once. Resetting your password signs you out everywhere else.",
    "If this wasn't you, ignore this message — your password has not changed."
  ];

  return {
    to,
    subject: "Reset your password",
    text: lines.join("\n\n"),
    html: wrapHtml(lines)
  };
}

// ---------------------------------------------------------------------------
// Everything above this line is pure. Everything below talks to the network or
// the filesystem, and is the only part that cannot be tested without one.
// ---------------------------------------------------------------------------

function deliverViaResend(message, config) {
  const payload = JSON.stringify({
    from: config.fromAddress,
    to: [message.to],
    subject: message.subject,
    text: message.text,
    html: message.html
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: RESEND_API_HOST,
        path: RESEND_API_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ delivered: true, id: parsed?.id || "", via: "resend" });
            return;
          }

          reject(new Error(parsed?.message || `Resend refused the message (HTTP ${response.statusCode}).`));
        });
      }
    );

    // Node sets no socket timeout by default, so a provider that accepts the connection and then
    // stalls would hang whatever is awaiting this — including, at one point, account creation.
    request.setTimeout(10000, () => {
      request.destroy(new Error("Resend did not respond in time."));
    });

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

// With no provider configured the message goes to a file instead of an inbox. This is not a stub
// for its own sake: it is how the whole flow is exercised locally — you click the link out of
// data/outbox.json — and it is what test/accounts.test.js reads to assert that a reset actually
// sent something, without stubbing the network or holding a real API key in CI.
async function appendToOutbox(message, outboxPath) {
  let existing = [];

  try {
    existing = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  } catch {
    existing = [];
  }

  const record = { ...message, sentAt: new Date().toISOString() };
  const next = Array.isArray(existing) ? [record, ...existing].slice(0, 50) : [record];

  await fs.writeFile(outboxPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { delivered: false, id: "", via: "outbox" };
}

async function sendEmail(message, { config = getEmailConfig(), outboxPath = "" } = {}) {
  if (config.outbox && outboxPath) {
    return appendToOutbox(message, outboxPath);
  }

  if (!config.enabled) {
    return { delivered: false, id: "", via: "discarded" };
  }

  return deliverViaResend(message, config);
}

module.exports = {
  VERIFICATION_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS,
  getEmailConfig,
  getPublicEmailConfig,
  buildActionLink,
  buildVerificationEmail,
  buildPasswordResetEmail,
  sendEmail
};

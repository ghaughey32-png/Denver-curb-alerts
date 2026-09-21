// Transactional email for Denver Curb Alerts.
//
// The app has never had an email provider, which is why it has never had email verification or a
// password reset: both are a link in an inbox and nothing else. This is the missing half.
//
// It follows the shape lib/billing.js had before payments came out on 2026-09-03: a provider's npm
// package is a wrapper over an HTTPS call, and Resend's is thinner than most — one JSON POST to one
// endpoint, which is what a Stripe integration turned out to be as well. So this is
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

// Plain text is the payload and the HTML is the courtesy, not the other way round.
//
// That principle used to be read as "send almost no markup", and the result was a wall of
// unstyled text that looked like it came from nobody -- which is its own kind of untrustworthy.
// The part of the argument that actually holds is narrower: what makes a reset mail look like
// phishing is *hiding where the link goes*. "Click here" on a styled button, with the real
// destination visible only in a status bar nobody reads on a phone, is precisely the pattern
// attackers rely on. So the link below is shown in full, as itself, and is the thing you tap.
// Branding sits around it rather than in place of it.
//
// Three constraints shape the rest, all of them email-specific rather than taste:
//
//   - The wordmark is text, and the icon beside it is the only image. Most clients block remote
//     images by default, so the identity cannot depend on one: the icon carries alt="" and an
//     explicit width and height, which makes a blocked one collapse to empty space rather than a
//     broken-image box, and the wordmark beside it still says who sent this. Loading it is also
//     the one thing in these mails that tells our server the message was opened -- see the note
//     on getIconUrl.
//   - Tables, not divs. Outlook on Windows renders through Word, which ignores max-width on a
//     div; a table with an explicit width is the one layout that survives it.
//   - Inline styles only. Gmail strips <style> blocks in several contexts, so anything that
//     matters has to be on the element.
const BRAND_PAPER = "#fbf8f2";
const BRAND_BACKDROP = "#f1ece3";
const BRAND_INK = "#1f2f37";
const BRAND_MUTED = "#62727b";
const BRAND_ACCENT = "#b45d2a";
const BRAND_RULE = "#e5ddd0";
const BRAND_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

// The copy and the links are ours, and the token is base64url out of randomBytes, so nothing here
// can currently carry a quote or an angle bracket. This is cheap insurance against that stopping
// being true -- an unescaped href in a mail we send to an address someone else chose is not a
// mistake worth being one refactor away from.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The icon comes from whichever origin sent the mail, so a staging deploy shows its own and a
// local outbox run does not hotlink production. It is the PNG rather than icon.svg because Gmail
// strips SVG entirely, and it is requested without a "?v=" because serveStaticFile ignores the
// query anyway and a version baked into an old mail would outlive the asset it names.
//
// Worth knowing what adding it costs: a remote image in an email is how open tracking works. We do
// not track opens and nothing reads for it, but the request does reach our access log, which is
// more than the text-only version revealed. The Privacy page says so, under "Services involved" --
// if this image is ever dropped or moved to another host, that paragraph changes with it.
function getIconUrl(link) {
  let origin = "https://www.curbalerts.co";

  try {
    origin = new URL(link).origin;
  } catch {
    // An unparseable link should not cost the mail its icon; the default above is the real site.
  }

  return `${origin}/apple-touch-icon.png`;
}

function wrapHtml(lines, iconUrl) {
  const body = lines
    .map((line) => {
      if (line.startsWith("http")) {
        const safe = escapeHtml(line);
        // Shown in full and styled as the target, so the destination and the tappable thing are
        // the same object. word-break is what stops a 70-character URL from forcing a phone
        // client into horizontal scrolling.
        return [
          `<a href="${safe}" style="display:block;margin:0 0 18px 0;padding:14px 16px;`,
          `border:1px solid ${BRAND_RULE};border-radius:12px;background-color:#ffffff;`,
          `color:${BRAND_ACCENT};font-weight:600;text-decoration:none;word-break:break-all;`,
          `font-size:14px;line-height:1.45">${safe}</a>`
        ].join("");
      }

      return `<p style="margin:0 0 14px 0">${escapeHtml(line)}</p>`;
    })
    .join("\n");

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND_BACKDROP};margin:0;padding:24px 12px">`,
    '<tr><td align="center">',
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="width:100%;max-width:520px;background-color:${BRAND_PAPER};border:1px solid ${BRAND_RULE};border-radius:16px">`,

    // Icon and wordmark on one row, then a short accent rule, so the mail has a face and a colour
    // at a glance. The row is a nested table because Outlook does not do inline-block, and the
    // width/height live on the img as attributes as well as in the style for the same reason.
    `<tr><td style="padding:24px 24px 0 24px;font-family:${BRAND_FONT}">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    '<td style="padding:0 12px 0 0;vertical-align:middle">',
    `<img src="${escapeHtml(iconUrl)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;border-radius:9px;background-color:${BRAND_PAPER}" />`,
    "</td>",
    `<td style="vertical-align:middle;font-family:${BRAND_FONT};font-size:17px;font-weight:700;color:${BRAND_INK};letter-spacing:-0.01em">Denver Curb Alerts</td>`,
    "</tr></table>",
    `<div style="margin-top:14px;width:44px;height:3px;background-color:${BRAND_ACCENT};font-size:0;line-height:0">&nbsp;</div>`,
    "</td></tr>",

    `<tr><td style="padding:20px 24px 0 24px;font-family:${BRAND_FONT};font-size:15px;line-height:1.55;color:${BRAND_INK}">`,
    body,
    "</td></tr>",

    // Who we are and where to reply. The operating entity is what the app's own footer says, and
    // the support address is the one printed on the Terms and Privacy pages.
    `<tr><td style="padding:4px 24px 22px 24px;font-family:${BRAND_FONT}">`,
    `<div style="border-top:1px solid ${BRAND_RULE};padding-top:16px;font-size:12px;line-height:1.5;color:${BRAND_MUTED}">`,
    "Denver Curb Alerts is a street sweeping reminder tool for Denver drivers, operated by Curb Alerts LLC.",
    "<br />Questions? Reply to this message or write to support@curbalerts.co.",
    "</div>",
    "</td></tr>",

    "</table>",
    "</td></tr>",
    "</table>"
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
    html: wrapHtml(lines, getIconUrl(link))
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
    html: wrapHtml(lines, getIconUrl(link))
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

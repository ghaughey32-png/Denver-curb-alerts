"use strict";

// App Store Server Notifications (version 2): Apple's own account of what happened to a
// subscription, posted to us the moment it happens. This is how a phone whose app is closed still
// hears that its payment failed - StoreKit only reports to a running app.
//
// A notification is a JWS signed with a key whose certificate chain ends at Apple's root. Nothing
// here trusts the body until the chain and the signature check out, and the root is pinned by its
// SHA-256 fingerprint rather than taken from the message. `node:crypto` only, like the rest of the
// server. The module is pure: it turns bytes into a decision and leaves storage and sending to
// server.js.

const crypto = require("node:crypto");

const BUNDLE_ID = "co.curbalerts.app";

// Apple Root CA - G3, the root of the chain Apple signs notifications with (valid to 2039). Checked
// against the copy in macOS's system keychain on 2026-10-01. If Apple ever rotates it, every
// notification is refused, loudly (400), rather than trusted.
const APPLE_ROOT_CA_G3_SHA256 = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

// Apple marks the certificates it issues for this purpose with these extension OIDs: the leaf with
// "Mac App Store Receipt Signing" and the intermediate with the matching WWDR marker. Without them,
// any certificate Apple has ever issued under the same root would pass.
const LEAF_MARKER_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_MARKER_OID = "1.2.840.113635.100.6.2.1";

function base64UrlDecode(text) {
  return Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// The DER bytes of an OID's content, found by value in a certificate. A certificate that carries the
// marker carries these bytes in its extensions; a scan is enough because the OIDs are long and
// specific, and the chain is signature-verified before this is consulted.
function oidBytes(oid) {
  const parts = oid.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const group = [part & 0x7f];
    for (let rest = part >> 7; rest > 0; rest >>= 7) {
      group.unshift((rest & 0x7f) | 0x80);
    }
    bytes.push(...group);
  }
  return Buffer.from(bytes);
}

function carriesMarker(certificate, oid) {
  return certificate.raw.includes(oidBytes(oid));
}

function decodeJws(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) {
    throw new Error("Not a JWS.");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  } catch {
    throw new Error("Malformed JWS.");
  }

  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlDecode(parts[2]) };
}

// Leaf -> intermediate -> root, each signed by the next, every one inside its validity window, the
// root pinned and the two Apple markers present. Returns the leaf, whose key signed the message.
function verifyCertificateChain(x5c, { now = Date.now(), rootFingerprints = [APPLE_ROOT_CA_G3_SHA256] } = {}) {
  if (!Array.isArray(x5c) || x5c.length < 3 || x5c.length > 4) {
    throw new Error("Unexpected certificate chain.");
  }

  const chain = x5c.map((entry) => new crypto.X509Certificate(Buffer.from(String(entry), "base64")));
  const leaf = chain[0];
  const root = chain[chain.length - 1];

  if (!rootFingerprints.includes(root.fingerprint256.replace(/:/g, "").toLowerCase())) {
    throw new Error("The certificate chain does not end at Apple's root.");
  }

  for (const certificate of chain) {
    if (now < new Date(certificate.validFrom).getTime() || now > new Date(certificate.validTo).getTime()) {
      throw new Error("A certificate in the chain is outside its validity period.");
    }
  }

  for (let index = 0; index < chain.length; index += 1) {
    const issuer = chain[Math.min(index + 1, chain.length - 1)];
    if (!chain[index].verify(issuer.publicKey)) {
      throw new Error("A certificate in the chain is not signed by the next.");
    }
  }

  if (!carriesMarker(leaf, LEAF_MARKER_OID) || !carriesMarker(chain[1], INTERMEDIATE_MARKER_OID)) {
    throw new Error("The certificates are not Apple's notification-signing certificates.");
  }

  return leaf;
}

// The payload of a JWS signed by Apple, or a thrown Error. ES256 only: an `alg` of "none" or HS256
// is how forged tokens usually arrive.
function verifyAppleJws(jws, options = {}) {
  const decoded = decodeJws(jws);
  if (decoded.header.alg !== "ES256") {
    throw new Error("Unexpected signing algorithm.");
  }

  const leaf = verifyCertificateChain(decoded.header.x5c, options);
  const valid = crypto.verify(
    "sha256",
    Buffer.from(decoded.signingInput),
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    decoded.signature
  );
  if (!valid) {
    throw new Error("The signature does not match.");
  }

  return decoded.payload;
}

// What a verified notification says, flattened: the type, the Apple-side subscription id that ties it
// to a phone, and the dates that matter. A nested transaction or renewal record that fails
// verification fails the whole notification.
function parseNotification(signedPayload, options = {}) {
  const outer = verifyAppleJws(signedPayload, options);
  const data = outer.data || {};

  if (outer.notificationType !== "TEST" && data.bundleId !== BUNDLE_ID) {
    throw new Error("The notification is for another app.");
  }

  const transaction = data.signedTransactionInfo ? verifyAppleJws(data.signedTransactionInfo, options) : {};
  const renewal = data.signedRenewalInfo ? verifyAppleJws(data.signedRenewalInfo, options) : {};

  const asDate = (milliseconds) => (Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null);
  const originalTransactionId = transaction.originalTransactionId || renewal.originalTransactionId;
  return {
    uuid: String(outer.notificationUUID || ""),
    type: String(outer.notificationType || ""),
    subtype: String(outer.subtype || ""),
    environment: String(data.environment || ""),
    signedAt: asDate(outer.signedDate),
    originalTransactionId: originalTransactionId ? String(originalTransactionId) : "",
    productId: String(transaction.productId || renewal.productId || ""),
    expiresAt: asDate(transaction.expiresDate),
    gracePeriodEndsAt: asDate(renewal.gracePeriodExpiresDate),
    autoRenewStatus: renewal.autoRenewStatus === 0 ? "off" : renewal.autoRenewStatus === 1 ? "on" : ""
  };
}

// The id Apple gives a subscription for its whole life (it does not change on renewal), which is how
// a notification finds the phones it is about. Digits only: it is stored and compared as text.
function normalizeOriginalTransactionId(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,20}$/.test(text) ? text : "";
}

const ALARM = "😱 ";
const CANCELLED_ALARM = "☠️ ";

// What the phone should now believe about its own subscription, and whether it is worth waking the
// driver. `access` is { entitled, endsAt } in the form phones report it (lib/snow.js), or null when
// the event changes nothing; `notice` is a push, or null when the driver caused the change and the
// app has already said so. Payment trouble, a lapse and a refund are the ones that never stop
// silently.
function interpretNotification(notification) {
  const { type, subtype } = notification;

  switch (type) {
    case "DID_FAIL_TO_RENEW":
      if (subtype === "GRACE_PERIOD" && notification.gracePeriodEndsAt) {
        return {
          access: { entitled: true, endsAt: notification.gracePeriodEndsAt },
          notice: {
            title: `${ALARM}Payment failed: your alerts are about to stop`,
            body: "Apple couldn't renew your Curb Alerts subscription. Update your payment method to keep your alerts."
          }
        };
      }
      return {
        access: { entitled: false, endsAt: null },
        notice: {
          title: `${ALARM}Payment failed: your alerts have stopped`,
          body: "Apple couldn't renew your Curb Alerts subscription. Update your payment method to turn your alerts back on."
        }
      };

    case "GRACE_PERIOD_EXPIRED":
      return {
        access: { entitled: false, endsAt: null },
        notice: {
          title: `${ALARM}Your alerts have stopped`,
          body: "Apple still couldn't take payment for Curb Alerts. Update your payment method to turn your alerts back on."
        }
      };

    case "EXPIRED":
      return {
        access: { entitled: false, endsAt: null },
        notice: subtype === "VOLUNTARY"
          ? { title: `${CANCELLED_ALARM}Your alerts have ended`, body: "Your Curb Alerts subscription has ended. Open Curb Alerts to turn your alerts back on." }
          : { title: `${ALARM}Your alerts have stopped`, body: "Your Curb Alerts subscription has ended. Open Curb Alerts to turn your alerts back on." }
      };

    case "REFUND":
    case "REVOKE":
      return {
        access: { entitled: false, endsAt: null },
        notice: {
          title: `${ALARM}Your alerts have stopped`,
          body: "Your Curb Alerts subscription was refunded or revoked, so alerts are off. Open Curb Alerts to turn them back on."
        }
      };

    case "DID_CHANGE_RENEWAL_STATUS":
      if (notification.autoRenewStatus === "off") {
        return { access: { entitled: true, endsAt: notification.expiresAt }, notice: null };
      }
      if (notification.autoRenewStatus === "on") {
        return { access: { entitled: true, endsAt: null }, notice: null };
      }
      return { access: null, notice: null };

    case "SUBSCRIBED":
    case "DID_RENEW":
    case "OFFER_REDEEMED":
      return { access: { entitled: true, endsAt: null }, notice: null };

    default:
      return { access: null, notice: null };
  }
}

module.exports = {
  BUNDLE_ID,
  APPLE_ROOT_CA_G3_SHA256,
  decodeJws,
  verifyCertificateChain,
  verifyAppleJws,
  parseNotification,
  normalizeOriginalTransactionId,
  interpretNotification
};

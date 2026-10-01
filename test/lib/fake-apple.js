"use strict";

// Signs App Store Server Notifications the way Apple does, with a throwaway chain from
// test/fixtures/fake-apple-chain, so the real verifier runs end to end against them.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "fixtures", "fake-apple-chain");
const pem = (name) => fs.readFileSync(path.join(dir, name));
const der = (name) => new crypto.X509Certificate(pem(name)).raw.toString("base64");

const ROOT_FINGERPRINT = new crypto.X509Certificate(pem("root.pem")).fingerprint256.replace(/:/g, "").toLowerCase();
const b64url = (value) => Buffer.from(value).toString("base64url");

function signJws(payload, { leaf = "leaf", chain = [leaf, "int", "root"], alg = "ES256" } = {}) {
  const header = b64url(JSON.stringify({ alg, x5c: chain.map((name) => der(`${name}.pem`)) }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${body}`), {
    key: crypto.createPrivateKey(pem(`${leaf}.key`)),
    dsaEncoding: "ieee-p1363"
  });
  return `${header}.${body}.${b64url(signature)}`;
}

// A whole notification: the outer envelope, with the transaction and renewal records signed inside it.
function buildNotification({
  type,
  subtype,
  originalTransactionId = "2000000111222333",
  bundleId = "co.curbalerts.app",
  environment = "Production",
  expiresDate = Date.parse("2026-12-01T00:00:00Z"),
  gracePeriodExpiresDate,
  autoRenewStatus = 1,
  signedDate = Date.parse("2026-11-01T12:00:00Z"),
  uuid = crypto.randomUUID(),
  signing = {}
}) {
  return signJws(
    {
      notificationType: type,
      ...(subtype ? { subtype } : {}),
      notificationUUID: uuid,
      signedDate,
      data: {
        bundleId,
        environment,
        signedTransactionInfo: signJws({ originalTransactionId, productId: "co.curbalerts.app.reminders.yearly", expiresDate }, signing),
        signedRenewalInfo: signJws({ originalTransactionId, autoRenewStatus, ...(gracePeriodExpiresDate ? { gracePeriodExpiresDate } : {}) }, signing)
      }
    },
    signing
  );
}

module.exports = { ROOT_FINGERPRINT, signJws, buildNotification };

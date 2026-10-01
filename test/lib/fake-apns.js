"use strict";

// A stand-in for Apple's push service that records what the server sends, and the environment that
// points a server at it. The same shape as the copies in test/apns.test.js and
// test/snow-emergency.test.js; new tests share this one.

const crypto = require("node:crypto");
const http2 = require("node:http2");

function startFakeApns() {
  const received = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      received.push({ token: headers[":path"].split("/").pop(), body: JSON.parse(body) });
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, received, close: () => server.close() });
    });
  });
}

function apnsEnv(fake) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM456",
    APNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    APNS_ORIGIN: fake.origin
  };
}

module.exports = { startFakeApns, apnsEnv };

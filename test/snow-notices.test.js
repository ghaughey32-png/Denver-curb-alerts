"use strict";

// Noticing a snow emergency on the city's banner (lib/snow-notices.js and the poller in server.js).
// The pure half reads feeds of any shape; the integration half stands up a fake banner file and reads
// the author's outbox, since the one rule that matters is that nothing but an email can come of it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const snowNotices = require("../lib/snow-notices.js");
const email = require("../lib/email.js");
const { withServer } = require("./lib/with-server.js");

test("the banner is read whatever its shape, and only snow emergency text counts", () => {
  assert.deepEqual(snowNotices.findSnowEmergencyNotices({ notices: [{ "": "" }] }), [], "the file as it stands today");
  assert.deepEqual(snowNotices.findSnowEmergencyNotices({}), []);
  assert.deepEqual(snowNotices.findSnowEmergencyNotices(null), []);
  assert.deepEqual(snowNotices.findSnowEmergencyNotices("Snow emergency declared"), ["Snow emergency declared"]);

  const nested = {
    notices: [
      { title: "Water main work", body: "<p>Lane closed on <b>Hennepin</b></p>" },
      { title: "SNOW  EMERGENCY declared", body: "<p>Day&nbsp;1 begins at 9&nbsp;pm.<br/>Move your car.</p>", more: { link: "/snow-emergency" } }
    ]
  };
  assert.deepEqual(
    snowNotices.findSnowEmergencyNotices(nested),
    ["SNOW EMERGENCY declared", "/snow-emergency"],
    "markup and spacing are stripped, an unrelated notice is ignored, and a link counts as text"
  );
  assert.ok(snowNotices.extractNoticeTexts(nested).includes("Day 1 begins at 9 pm. Move your car."));
});

test("notices are keyed on their words, so a reworded one is news and a repeat is not", () => {
  assert.equal(snowNotices.noticeKey("Snow emergency declared"), snowNotices.noticeKey("snow EMERGENCY declared"));
  assert.notEqual(snowNotices.noticeKey("Snow emergency declared"), snowNotices.noticeKey("Snow emergency Day 2 has begun"));
});

test("the confirm command names Minneapolis's date and is a dry run until --send", () => {
  const command = snowNotices.buildDeclareCommand(new Date("2026-12-10T03:00:00Z"));
  assert.equal(command, "npm run snow -- declare --day1=2026-12-09", "3 am UTC is still the 9th in Minneapolis");
});

test("the email to the author carries the notice, both commands and what was read", () => {
  const message = email.buildSnowNoticeEmail({
    to: "support@curbalerts.co",
    notices: ["Snow emergency declared"],
    command: "npm run snow -- declare --day1=2026-12-10",
    rawSample: '{"notices":[{"t":"Snow emergency declared"}]}'
  });
  assert.equal(message.to, "support@curbalerts.co");
  assert.match(message.subject, /snow emergency/i);
  assert.match(message.text, /Nothing has been sent to drivers/);
  assert.match(message.text, /npm run snow -- declare --day1=2026-12-10 --send/);
  assert.match(message.text, /Snow emergency declared/);
  assert.ok(message.html.includes("Snow emergency declared"));
});

function startFakeBanner(initialBody, initialStatus = 200) {
  const state = { body: initialBody, status: initialStatus, requests: [] };
  const server = http.createServer((request, response) => {
    state.requests.push(request.headers["user-agent"] || "");
    response.writeHead(state.status, { "Content-Type": "application/json" });
    response.end(typeof state.body === "string" ? state.body : JSON.stringify(state.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.url = `http://127.0.0.1:${server.address().port}/emergency-en.json`;
      state.close = () => server.close();
      resolve(state);
    });
  });
}

async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
};

test("a snow emergency on the banner emails the author once, across restarts, and sends nothing to drivers", async () => {
  const banner = await startFakeBanner({ notices: [{ "": "" }] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-notice-"));
  const outbox = path.join(dataDir, "outbox.json");
  const env = { DATA_DIR: dataDir, EMAIL_TRANSPORT: "outbox", SNOW_NOTICE_URL: banner.url };

  try {
    // An empty banner: it is read (with our User-Agent) and nothing is sent.
    await withServer(async () => {
      await until(() => banner.requests.length > 0, "the first read");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.match(banner.requests[0], /CurbAlerts/);
      assert.equal(readJson(outbox).length, 0);
    }, env);

    // The city posts an emergency: one email, then nothing more.
    banner.body = { notices: [{ title: "Snow emergency declared", body: "<p>Day 1 begins at 9 pm.</p>" }] };
    await withServer(async ({ call, readCollection }) => {
      const sent = await until(() => readJson(outbox).length > 0 && readJson(outbox), "the email");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, "support@curbalerts.co");
      assert.match(sent[0].text, /Snow emergency declared/);
      assert.match(sent[0].text, /npm run snow -- declare --day1=\d{4}-\d{2}-\d{2} --send/);
      const remembered = await until(() => readCollection("snow-notices").length > 0 && readCollection("snow-notices"), "the record");
      assert.equal(remembered[0].text, "Snow emergency declared");

      // Detection is not declaration: nothing was declared and no one was notified.
      assert.equal((await call("/api/snow-emergency?city=minneapolis")).payload.active, false);
      assert.equal(readCollection("snow-emergencies").length, 0);
    }, env);

    // A restart over the same data reads the same notice and stays quiet.
    const before = banner.requests.length;
    await withServer(async () => {
      await until(() => banner.requests.length > before, "the read after restart");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(readJson(outbox).length, 1, "the same notice is not emailed twice");
    }, env);

    // A reworded notice is news.
    banner.body = { notices: [{ title: "Snow emergency Day 2 has begun" }] };
    await withServer(async () => {
      await until(() => readJson(outbox).length === 2, "the second email");
    }, env);
  } finally {
    banner.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an unreadable banner only logs: no email, no crash, and the server keeps answering", async () => {
  for (const [body, status] of [["<html>not json</html>", 200], ["{}", 500], ["", 200]]) {
    const banner = await startFakeBanner(body, status);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-notice-"));
    try {
      await withServer(async ({ call }) => {
        await until(() => banner.requests.length > 0, "a read");
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(readJson(path.join(dataDir, "outbox.json")).length, 0);
        assert.equal((await call("/api/snow-emergency?city=minneapolis")).status, 200);
      }, { DATA_DIR: dataDir, EMAIL_TRANSPORT: "outbox", SNOW_NOTICE_URL: banner.url });
    } finally {
      banner.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test("with no email configured a notice is not marked seen, so the author is still told once email works", async () => {
  const banner = await startFakeBanner({ notices: [{ title: "Snow emergency declared" }] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "curb-notice-"));
  try {
    await withServer(async ({ readCollection }) => {
      await until(() => banner.requests.length > 0, "a read");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(readCollection("snow-notices").length, 0);
    }, { DATA_DIR: dataDir, EMAIL_TRANSPORT: "", RESEND_API_KEY: "", EMAIL_FROM: "", SNOW_NOTICE_URL: banner.url });
  } finally {
    banner.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

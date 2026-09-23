"use strict";

// The page's half of selling reminders in the iOS app: the banner that says when reminders are
// paused, ending or at risk, the paywall in front of turning a curb's reminder on, and the promise
// that a browser - which has no subscription - sees none of it.
//
// Like test/sweep-follow-ups.test.js, this reads public/app.js as source text and lifts functions
// into a sandbox, because the client has no module boundary. Renaming these functions will break
// this test even when behavior is unchanged; update the names alongside the code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");
const APP_SOURCE = fs.readFileSync(APP_PATH, "utf8");

function extractFunctionBlock(lines, name) {
  const start = lines.findIndex((line) => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);

  let end = start;
  while (end < lines.length && lines[end] !== "}") {
    end += 1;
  }
  return lines.slice(start, end + 1).join("\n");
}

function fakeElement() {
  return { hidden: false, textContent: "", onclick: null, classList: { toggles: {}, toggle(name, on) { this.toggles[name] = on; } } };
}

function loadBanner({ bridge, remindedCount = 1, parkedCar = null, webReminders = false }) {
  const lines = APP_SOURCE.split("\n");
  const source = [
    "getNativeReminderBridge",
    "canUseNativeReminders",
    "areWebRemindersOff",
    "getNativeSubscription",
    "areRemindersPaywalled",
    "formatSubscriptionDate",
    "renderSubscriptionBanner"
  ].map((name) => extractFunctionBlock(lines, name)).join("\n");

  const sandbox = {
    window: { DenverCurbAlertsNative: bridge },
    state: { parkedCar },
    getRemindedSegmentIds: () => new Set(Array.from({ length: remindedCount }, (_, index) => `curb-${index}`)),
    openReminderPaywall: () => {},
    openAppStoreListing: () => {},
    ACTIVE_CITY: { webReminders, appStoreUrl: null },
    subscriptionBanner: fakeElement(),
    subscriptionBannerKicker: fakeElement(),
    subscriptionBannerTitle: fakeElement(),
    subscriptionBannerBody: fakeElement(),
    subscriptionBannerAction: fakeElement()
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.renderSubscriptionBanner();
  return sandbox;
}

function shellBridge(subscription) {
  return {
    scheduleReminders: async () => {},
    requestPermission: async () => "granted",
    showPaywall: async () => subscription,
    manageSubscription: async () => true,
    subscription
  };
}

const LATER = "2026-10-17T18:00:00Z";

test("a browser has no subscription, so nothing is ever paywalled or bannered", () => {
  const sandbox = loadBanner({ bridge: undefined });
  assert.equal(sandbox.areRemindersPaywalled(), false);
  assert.equal(sandbox.subscriptionBanner.hidden, true);
});

test("an app build from before the paywall is treated like a browser", () => {
  const bridge = shellBridge({ known: true, status: "none", entitled: false });
  delete bridge.showPaywall;
  const sandbox = loadBanner({ bridge });
  assert.equal(sandbox.areRemindersPaywalled(), false);
  assert.equal(sandbox.subscriptionBanner.hidden, true);
});

test("before StoreKit has answered, a driver is not told their reminders are off", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: false, status: "none", entitled: false }) });
  assert.equal(sandbox.areRemindersPaywalled(), false);
  assert.equal(sandbox.subscriptionBanner.hidden, true);
});

test("saved curbs with no subscription say reminders are paused and offer the plans", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: true, status: "none", entitled: false }) });
  assert.equal(sandbox.areRemindersPaywalled(), true);
  assert.equal(sandbox.subscriptionBanner.hidden, false);
  assert.equal(sandbox.subscriptionBannerTitle.textContent, "😱 Your sweep reminders are off");
  assert.equal(sandbox.subscriptionBanner.classList.toggles["is-urgent"], true);
  assert.equal(sandbox.subscriptionBannerAction.textContent, "See plans");
});

test("nobody is nagged to subscribe before they have set up a reminder", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: true, status: "none", entitled: false }), remindedCount: 0 });
  assert.equal(sandbox.subscriptionBanner.hidden, true);
});

test("a failed payment inside its grace period says when reminders stop, urgently", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: true, status: "billingIssue", entitled: true, endsAt: LATER }) });
  assert.equal(sandbox.subscriptionBanner.hidden, false);
  assert.equal(sandbox.subscriptionBanner.classList.toggles["is-urgent"], true);
  assert.match(sandbox.subscriptionBannerTitle.textContent, /^😱 Your sweep reminders stop \w+day, Oct 1[67]$/);
  assert.equal(sandbox.subscriptionBannerAction.textContent, "Update payment");
});

test("a cancelled plan says when reminders end and offers to keep them", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: true, status: "cancelling", entitled: true, endsAt: LATER }) });
  assert.match(sandbox.subscriptionBannerTitle.textContent, /^Your sweep reminders end /);
  assert.equal(sandbox.subscriptionBanner.classList.toggles["is-urgent"], false);
  assert.equal(sandbox.subscriptionBannerAction.textContent, "Keep my reminders");
});

test("an active plan shows no banner", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: true, status: "active", entitled: true, willRenew: true, endsAt: LATER }) });
  assert.equal(sandbox.subscriptionBanner.hidden, true);
});

test("turning a reminder on without a subscription opens the plans instead of saving the curb", () => {
  const toggle = extractFunctionBlock(APP_SOURCE.split("\n"), "toggleCurbReminder");
  const paywallAt = toggle.indexOf("areRemindersPaywalled()");
  const saveAt = toggle.indexOf("addSegmentsToDefaultSet([segment])");
  assert.ok(paywallAt > 0 && saveAt > 0 && paywallAt < saveAt, "the paywall check must come before the curb is saved");
  assert.match(toggle, /openReminderPaywall\(\)\.then/);
});

test("the subscription row's [hidden] guard exists, because its class sets display", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(css, /\.subscription-row\[hidden\]\s*\{\s*display:\s*none;/);
});

test("the website sends no reminders, and says nothing about subscriptions either", () => {
  const sandbox = loadBanner({ bridge: undefined });
  assert.equal(sandbox.areWebRemindersOff(), true);
  assert.equal(sandbox.subscriptionBanner.hidden, true);
});

test("the iPhone app ignores the website's setting: its reminders are the product", () => {
  const sandbox = loadBanner({ bridge: shellBridge({ known: true, status: "active", entitled: true, willRenew: true, endsAt: LATER }) });
  assert.equal(sandbox.areWebRemindersOff(), false);
});

test("Denver's record keeps the website map only", () => {
  const { getCity } = require("../public/cities.js");
  assert.equal(getCity("denver").webReminders, false);
});

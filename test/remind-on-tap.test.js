"use strict";

// Turning a curb's reminder on from its sheet is the whole commitment; there is no save step.
//
// Like test/parked-car.test.js, this reads public/app.js as source text and lifts functions out into
// a sandbox, because the client has no module boundary. Renaming these functions will break this
// test even when behavior is unchanged; update the names alongside the code.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");
const APP_SOURCE = fs.readFileSync(APP_PATH, "utf8");
const APP_LINES = APP_SOURCE.split("\n");
const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);

  let end = start;
  while (end < APP_LINES.length && APP_LINES[end] !== "}") {
    end += 1;
  }
  assert.ok(end < APP_LINES.length, `could not find the end of function ${name}`);

  return APP_LINES.slice(start, end + 1).join("\n");
}

function extractConstantLine(name) {
  const line = APP_LINES.find((candidate) => candidate.startsWith(`const ${name} = `));
  assert.ok(line, `could not find const ${name} in public/app.js`);
  return line;
}

const CURB_FUNCTIONS = [
  "toggleCurbReminder",
  "undoCurbReminderChange",
  "addSegmentsToDefaultSet",
  "removeSegmentFromSavedSets",
  "migrateLegacyCurrentSelection",
  "getRemindedSegmentIds",
  "isCurbReminded",
  "getSegmentsForSavedSet",
  "serializeSegment",
  "getSegmentById",
  "hydrateSavedSet"
];

function loadCurbReminders({ curbs, savedSets = [], storage = {} }) {
  const store = new Map(Object.entries(storage).map(([key, value]) => [key, JSON.stringify(value)]));
  const sandbox = {
    state: { curbSegments: curbs, savedSets, activeSourceLabel: "Test", activeLookupAddress: "" },
    lookupStatus: { textContent: "" },
    persistCount: 0,
    loadJson: (key, fallback) => (store.has(key) ? JSON.parse(store.get(key)) : fallback),
    saveJson: (key, value) => store.set(key, JSON.stringify(value)),
    removeJson: (key) => store.delete(key),
    buildDefaultReminders: (reminders) => ({ ...reminders }),
    renderAll: () => {},
    renderCurbSheet: () => {}
  };
  sandbox.persistSavedSets = () => {
    sandbox.persistCount += 1;
    store.set("sloans-lake-notification-sets", JSON.stringify(sandbox.state.savedSets));
  };

  const source = [
    extractConstantLine("CURRENT_SELECTION_KEY"),
    extractConstantLine("SAVED_SETS_KEY"),
    extractConstantLine("PUSH_PRIMER_DISMISSED_KEY"),
    extractConstantLine("DEFAULT_SET_ID"),
    extractConstantLine("DEFAULT_SET_NAME"),
    "let remindedSegmentIdsSource = null;",
    "let remindedSegmentIds = new Set();",
    "let lastCurbReminderChange = null;",
    ...CURB_FUNCTIONS.map(extractFunctionBlock),
    `this.__exports = { ${CURB_FUNCTIONS.join(", ")}, getLastChange: () => lastCurbReminderChange };`
  ].join("\n");
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { ...sandbox.__exports, sandbox, store };
}

const schedule = { sweepType: "Scheduled", remindersAllowed: true, allDates: [] };
const curb = (id, street = "W 32ND AVE") => ({ id, street, sideLabel: "North curb", sideKey: "north", geometry: [[39.76, -105.03]], schedule });

test("the sheet's button turns a reminder on then and there, into one default set", () => {
  const curbs = [curb("way-1:north"), curb("way-2:north", "N LOWELL BLVD")];
  const api = loadCurbReminders({ curbs });

  api.toggleCurbReminder("way-1:north");
  assert.equal(api.sandbox.state.savedSets.length, 1);
  assert.equal(api.sandbox.state.savedSets[0].id, "set-my-curbs");
  assert.equal(api.sandbox.state.savedSets[0].name, "My curbs");
  assert.equal(api.sandbox.persistCount, 1, "turning a reminder on persists immediately, with no save step");
  assert.ok(api.isCurbReminded("way-1:north"));

  // A second curb joins the same set rather than minting another: jobs are built per set, and iOS
  // holds 64 pending notifications, so a set per curb would reach the cap at the second curb.
  api.toggleCurbReminder("way-2:north");
  assert.equal(api.sandbox.state.savedSets.length, 1);
  assert.deepEqual([...api.sandbox.state.savedSets[0].segmentIds], ["way-1:north", "way-2:north"]);
  assert.equal(api.sandbox.state.savedSets[0].segments.length, 2);
});

test("off takes a curb out of every set, drops a set it empties, and undo restores it exactly", () => {
  const curbs = [curb("way-1:north"), curb("way-2:north")];
  const home = { id: "set-home", name: "Home", segmentIds: ["way-1:north"], segments: [curbs[0]] };
  const work = { id: "set-work", name: "Work", segmentIds: ["way-1:north", "way-2:north"], segments: [curbs[0], curbs[1]] };
  const api = loadCurbReminders({ curbs, savedSets: [home, work] });

  api.toggleCurbReminder("way-1:north");
  const sets = api.sandbox.state.savedSets;
  assert.equal(api.isCurbReminded("way-1:north"), false, "a curb left in any set would keep reminding");
  assert.deepEqual(sets.map((set) => set.id), ["set-work"], "a set with no curbs left is dropped");
  assert.deepEqual([...sets[0].segmentIds], ["way-2:north"]);

  api.undoCurbReminderChange();
  assert.deepEqual(api.sandbox.state.savedSets.map((set) => set.id), ["set-home", "set-work"]);
  assert.equal(api.sandbox.state.savedSets[1].segments.length, 2);
  assert.ok(api.isCurbReminded("way-1:north"));
});

test("a street Denver does not maintain cannot be turned on", () => {
  const notMaintained = { ...curb("way-9:north"), schedule: { sweepType: "NotMaintained", remindersAllowed: false } };
  const api = loadCurbReminders({ curbs: [notMaintained] });

  api.toggleCurbReminder("way-9:north");
  assert.equal(api.sandbox.state.savedSets.length, 0);
  assert.equal(api.getLastChange(), null, "a refused tap leaves nothing to undo");
});

test("an unsaved selection from the old flow becomes reminders, and waits for curbs not loaded yet", () => {
  const curbs = [curb("way-1:north"), curb("way-2:north")];
  const home = { id: "set-home", name: "Home", segmentIds: ["way-2:north"], segments: [curbs[1]] };
  const api = loadCurbReminders({
    curbs,
    savedSets: [home],
    storage: { "sloans-lake-current-selection": ["way-1:north", "way-2:north", "way-elsewhere:south"] }
  });

  api.migrateLegacyCurrentSelection();
  const defaultSet = api.sandbox.state.savedSets.find((set) => set.id === "set-my-curbs");
  assert.deepEqual([...defaultSet.segmentIds], ["way-1:north"], "a curb already in a set is not added twice");
  // Boot draws a small dataset before the full inventory; a curb outside it must not be thrown away.
  assert.deepEqual(JSON.parse(api.store.get("sloans-lake-current-selection")), ["way-elsewhere:south"]);

  api.sandbox.state.curbSegments = [...curbs, curb("way-elsewhere:south")];
  api.migrateLegacyCurrentSelection();
  assert.ok(api.isCurbReminded("way-elsewhere:south"));
  assert.equal(api.store.has("sloans-lake-current-selection"), false, "the key goes once every id has resolved");
});

test("an account merge unions the curbs of a set both devices hold", async () => {
  const curbs = [curb("way-1:north"), curb("way-2:north")];
  const local = [{ id: "set-my-curbs", name: "My curbs", segmentIds: ["way-1:north"], segments: [curbs[0]] }];
  const api = loadCurbReminders({ curbs, storage: { "sloans-lake-notification-sets": local } });
  const uploads = [];

  Object.assign(api.sandbox, {
    accountRequest: async (url, options) => {
      if (options?.method === "POST") {
        uploads.push(options.body.savedSets);
        return {};
      }
      return { library: { savedSets: [{ id: "set-my-curbs", name: "My curbs", segmentIds: ["way-2:north"] }] } };
    },
    renderAccount: () => {},
    loadParkedCar: () => null,
    queueAccountLibrarySync: () => {}
  });
  api.sandbox.state.account = { id: "acct" };
  vm.runInContext(
    [
      "loadSavedState",
      "mergeAccountLibrary",
      "syncAccountLibrary",
      "getLocalSavedSetsForAccount"
    ].map(extractFunctionBlock).join("\n") + "\nthis.__merge = mergeAccountLibrary;",
    api.sandbox
  );

  await api.sandbox.__merge();
  assert.ok(api.isCurbReminded("way-1:north") && api.isCurbReminded("way-2:north"), "neither device's curb is lost");
  assert.deepEqual([...uploads.at(-1)[0].segmentIds], ["way-1:north", "way-2:north"]);
});

test("the map page has no save step left to reach", () => {
  assert.doesNotMatch(INDEX_SOURCE, /id="save-set-button"|id="set-name-input"|id="readiness-set"|id="clear-map-selection"/);
  assert.doesNotMatch(APP_SOURCE, /currentSelectionIds|function saveCurrentAsSet/);
});

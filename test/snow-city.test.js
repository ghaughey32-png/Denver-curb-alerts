"use strict";

// Minneapolis as the second city: the registry's stored choice, and how the client turns the snow
// inventory into curbs. Like test/remind-on-tap.test.js this lifts functions out of public/app.js
// as source text, so renaming them will break it even when behaviour is unchanged.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_LINES = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").split("\n");
const CITIES_PATH = path.join(__dirname, "..", "public", "cities.js");

function loadRegistry(storage) {
  delete require.cache[require.resolve(CITIES_PATH)];
  const previous = globalThis.localStorage;
  if (storage === undefined) {
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = storage;
  }
  try {
    return require(CITIES_PATH);
  } finally {
    if (previous === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previous;
    }
  }
}

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
};

test("Denver is the default city, and a stored choice only counts if it names a real city", () => {
  assert.equal(loadRegistry(undefined).getActiveCity().id, "denver");
  assert.equal(loadRegistry(memoryStorage()).getActiveCity().id, "denver");
  assert.equal(loadRegistry(memoryStorage({ "curb-alerts-city": "atlantis" })).getActiveCity().id, "denver");
  assert.equal(loadRegistry(memoryStorage({ "curb-alerts-city": "minneapolis" })).getActiveCity().id, "minneapolis");
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const registry = loadRegistry(throwing);
  assert.equal(registry.getActiveCity().id, "denver", "blocked storage falls back to Denver");
});

test("saving a city choice persists it, and reports a blocked save instead of throwing", () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    const registry = loadRegistry(storage);
    assert.equal(registry.saveCityChoice("minneapolis"), true);
    assert.equal(storage.map.get("curb-alerts-city"), "minneapolis");
    assert.throws(() => registry.saveCityChoice("atlantis"));
    globalThis.localStorage = { setItem() { throw new Error("blocked"); } };
    assert.equal(registry.saveCityChoice("denver"), false);
  } finally {
    delete globalThis.localStorage;
  }
});

test("Minneapolis is a snow city with no sweep season, and its bounds hold every published curb", () => {
  const minneapolis = loadRegistry(undefined).getCity("minneapolis");
  assert.equal(minneapolis.kind, "snow");
  assert.equal(minneapolis.sweepSeason, null);
  assert.equal(minneapolis.webReminders, false);
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "minneapolis-snow.json"), "utf8"));
  const registry = loadRegistry(undefined);
  for (const curb of inventory.curbs) {
    for (const [lat, lon] of curb.geometry) {
      assert.ok(registry.isWithinCityBounds(minneapolis, lat, lon), `${curb.id} lies outside the city's bounds`);
    }
  }
  assert.equal(registry.getCityForPoint(44.9778, -93.265).id, "minneapolis");
  assert.equal(registry.getCityForPoint(39.74, -104.99).id, "denver");
});

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

function loadSnowClient() {
  const sandbox = {
    ACTIVE_CITY: loadRegistry(undefined).getCity("minneapolis"),
    colors: { snowRoute: "#c2255c", snowEven: "#2f6fed", snowOdd: "#f2c200" },
    capitalize: (value) => value.charAt(0).toUpperCase() + value.slice(1),
    getStreetOrientation: () => "north-south"
  };
  const names = ["getSnowCurbColor", "getSnowClass", "describeSnowBans", "buildSnowSchedule", "buildSnowDataset", "buildSnowCurbSheetCopy"];
  const source = [...names.map(extractFunctionBlock), `this.__exports = { ${names.join(", ")} };`].join("\n");
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.__exports;
}

test("a curb's rule class comes from the days it is banned on", () => {
  const client = loadSnowClient();
  assert.equal(client.getSnowClass([0, 1, 1]), "route");
  assert.equal(client.getSnowClass([0, 0, 0]), "route", "banned on Day 1 is a route whatever else it is");
  assert.equal(client.getSnowClass([1, 0, 1]), "even");
  assert.equal(client.getSnowClass([1, 1, 0]), "odd");
  assert.deepEqual([...client.describeSnowBans([0, 1, 1])], ["Day 1 from 9 pm"]);
  assert.deepEqual([...client.describeSnowBans([1, 0, 1])], ["Day 2 from 8 am"]);
  assert.deepEqual([...client.describeSnowBans([0, 0, 0])], ["Day 1 from 9 pm", "Day 2 from 8 am", "Day 3 from 8 am"]);
});

test("every snow curb becomes a segment with a schedule that can never project a sweep", () => {
  const client = loadSnowClient();
  const { curbSegments, streetWays } = client.buildSnowDataset({
    curbs: [
      { id: "mpls:aaa", street: "LYNDALE AVE S", sideKey: "west", days: [0, 1, 1], geometry: [[44.95, -93.29], [44.96, -93.29]] },
      { id: "mpls:bbb", street: "42ND AVE N", sideKey: "south", days: [0, 0, 0], conflicts: ["route-not-in-centreline"], geometry: [[45.03, -93.31], [45.03, -93.32]] },
      { id: "mpls:ccc", street: "NO LINE", sideKey: "east", days: [1, 0, 1], geometry: [[45, -93]] }
    ]
  });
  assert.equal(curbSegments.length, 2, "a curb with no line is dropped");
  assert.equal(streetWays.length, 2);
  const [route, conflicted] = curbSegments;
  assert.equal(route.color, "#c2255c");
  assert.equal(route.sideLabel, "West curb");
  assert.equal(route.schedule.sweepType, "Snow");
  assert.equal(route.schedule.rule, "");
  assert.equal(route.schedule.allDates.length, 0);
  assert.equal(route.schedule.remindersAllowed, true);
  assert.equal(conflicted.schedule.snowConflict, true);
  assert.match(client.buildSnowCurbSheetCopy(conflicted).notice, /stricter reading/);
  assert.doesNotMatch(client.buildSnowCurbSheetCopy(route).notice, /stricter reading/);
});

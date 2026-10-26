"use strict";

// The city chips and the one-time hint that tell a visitor there is more than one city. Like the other
// client tests this lifts functions out of public/app.js as source text and drives them with the shared
// fake DOM, so a rename breaks it even when behaviour is the same.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeElement } = require("./lib/fake-dom.js");

const APP_LINES = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").split("\n");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const STYLES = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
const registry = require("../public/cities.js");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

const NAMES = ["Denver", "San Francisco", "Minneapolis", "Boston", "Seattle", "Oakland", "Portland"];
const cityList = (count) =>
  NAMES.slice(0, count).map((name) => ({ id: name.toLowerCase().replace(" ", "-"), name, kind: name === "Minneapolis" ? "snow" : "sweeping" }));

function setup({ cities, active = "denver", stored = false, seen = false, containers = 1, saveResult = true, narrow = false }) {
  const document = {};
  makeElement.onFocus = () => {};
  const elements = {
    "#city-hint": makeElement("city-hint", "city-hint"),
    "#city-hint-text": makeElement("city-hint-text"),
    "#city-hint-dismiss": makeElement("city-hint-dismiss"),
    "#city-switcher": makeElement("city-switcher", "city-switcher"),
    "#city-switcher-button": makeElement("city-switcher-button")
  };
  elements["#city-hint"].hidden = true;
  const chipContainers = Array.from({ length: containers }, () => makeElement("", "city-chips"));
  document.querySelector = (selector) => elements[selector] || null;
  document.querySelectorAll = (selector) => (selector === "[data-city-chips]" ? chipContainers : []);
  document.createElement = () => makeElement();

  const calls = { saved: [], reloaded: 0, switcherClicks: 0, store: new Map() };
  if (seen) calls.store.set("curb-alerts-city-hint-seen", true);
  elements["#city-switcher-button"].click = () => { calls.switcherClicks += 1; };

  const timers = [];
  let nextTimer = 1;
  const sandbox = {
    document,
    ACTIVE_CITY: { id: active },
    window: {
      CityRegistry: {
        listCities: () => cities,
        hasStoredCityChoice: () => stored,
        saveCityChoice: (id) => { calls.saved.push(id); return saveResult; }
      },
      location: { reload: () => { calls.reloaded += 1; } },
      matchMedia: () => ({ matches: narrow })
    },
    loadJson: (key, fallback) => (calls.store.has(key) ? calls.store.get(key) : fallback),
    saveJson: (key, value) => calls.store.set(key, value),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const at = timers.findIndex((timer) => timer.id === id); if (at >= 0) timers.splice(at, 1); },
    requestAnimationFrame: (fn) => fn()
  };
  vm.createContext(sandbox);
  const constants = APP_LINES.filter((line) => /^const CITY_(CHIP_LIMIT|HINT_[A-Z_]+) = /.test(line)).join("\n");
  const names = ["switchCity", "renderCityChips", "dismissCityHint", "initializeCityHint", "joinWithAnd"];
  vm.runInContext(`${constants}\nlet cityHintTimers = [];\n${names.map(extractFunctionBlock).join("\n")}`, sandbox);
  const run = (name) => vm.runInContext(`${name}()`, sandbox);
  // Fires every pending timer whose delay is at most `ms`, soonest first, including ones they schedule.
  const advance = (ms) => {
    for (let guard = 0; guard < 20; guard += 1) {
      const due = timers.filter((timer) => timer.ms <= ms).sort((a, b) => a.ms - b.ms)[0];
      if (!due) return;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  return { elements, chipContainers, calls, run, advance, timers, hint: elements["#city-hint"] };
}

const chipsOf = (container) => container.children.filter((child) => child.className.includes("city-chip") && !child.className.includes("city-chips-label"));

test("three cities show as three chips, the open one first, filled and pressed, with snow named", () => {
  const { chipContainers, run } = setup({ cities: cityList(3), active: "san-francisco" });
  run("renderCityChips");
  const [container] = chipContainers;
  assert.equal(container.hidden, false);
  assert.equal(container.children[0].textContent, "City");
  const chips = chipsOf(container);
  assert.deepEqual(chips.map((chip) => chip.dataset.city), ["san-francisco", "denver", "minneapolis"]);
  assert.deepEqual(chips.map((chip) => chip.getAttribute("aria-pressed")), ["true", "false", "false"]);
  assert.ok(chips[0].classList.contains("is-active"));
  const snow = chips[2].children[0];
  assert.equal(snow.textContent, "snow");
  assert.ok(chips.every((chip) => chip.type === "button"));
});

test("every chip row on the page is filled, and a single city hides them all", () => {
  const two = setup({ cities: cityList(3), containers: 2 });
  two.run("renderCityChips");
  assert.deepEqual(two.chipContainers.map((container) => chipsOf(container).length), [3, 3]);

  const alone = setup({ cities: cityList(1), containers: 2 });
  alone.run("renderCityChips");
  assert.ok(alone.chipContainers.every((container) => container.hidden && container.children.length === 0));
});

test("rendering twice does not duplicate chips", () => {
  const { chipContainers, run } = setup({ cities: cityList(3) });
  run("renderCityChips");
  run("renderCityChips");
  assert.equal(chipsOf(chipContainers[0]).length, 3);
});

test("with seven cities, four chips then one 'More cities' chip that opens the dropdown", () => {
  const { chipContainers, run, calls } = setup({ cities: cityList(7), active: "boston" });
  run("renderCityChips");
  const chips = chipsOf(chipContainers[0]);
  assert.deepEqual(chips.map((chip) => chip.textContent), ["Boston", "Denver", "San Francisco", "Minneapolis", "More cities (3)"]);
  assert.ok(chips[0].classList.contains("is-active"), "the open city is always shown, first");
  assert.ok(chips[4].classList.contains("is-more"));
  chips[4].click();
  assert.equal(calls.switcherClicks, 1);
});

test("with exactly four cities there is no 'More cities' chip", () => {
  const { chipContainers, run } = setup({ cities: cityList(4) });
  run("renderCityChips");
  assert.equal(chipsOf(chipContainers[0]).length, 4);
  assert.ok(!chipsOf(chipContainers[0]).some((chip) => chip.classList.contains("is-more")));
});

test("tapping another city's chip saves it and reloads; tapping the open one does nothing", () => {
  const { chipContainers, run, calls } = setup({ cities: cityList(3) });
  run("renderCityChips");
  const chips = chipsOf(chipContainers[0]);
  chips[0].click();
  assert.deepEqual(calls.saved, [], "the open city is not saved again");
  assert.equal(calls.reloaded, 0);
  chips[1].click();
  assert.deepEqual(calls.saved, ["san-francisco"]);
  assert.equal(calls.reloaded, 1);
  assert.equal(calls.store.get("curb-alerts-city-hint-seen"), true, "using a chip answers the hint");
});

test("a first-time visitor sees the hint once, after a short pause, naming the other cities", () => {
  const { hint, elements, run, advance, calls } = setup({ cities: cityList(3) });
  run("initializeCityHint");
  assert.equal(hint.hidden, true, "not at once");
  assert.equal(elements["#city-hint-text"].textContent, "Also covering San Francisco and Minneapolis. Change city here.");
  advance(1200);
  assert.equal(hint.hidden, false);
  assert.ok(hint.classList.contains("is-shown"));
  assert.equal(calls.store.has("curb-alerts-city-hint-seen"), false, "remembered on dismissal, not on showing");
});

test("the hint hangs from the left where the right edge would leave the screen", () => {
  const near = setup({ cities: cityList(3) });
  near.run("initializeCityHint");
  near.advance(1200);
  assert.ok(!near.hint.classList.contains("is-left"));

  const edge = setup({ cities: cityList(3) });
  edge.elements["#city-switcher"].rect = { left: 16, right: 150 };
  edge.run("initializeCityHint");
  edge.advance(1200);
  assert.ok(edge.hint.classList.contains("is-left"));
});

test("dismissing the hint hides it after the fade and remembers it", () => {
  const { hint, elements, run, advance, calls } = setup({ cities: cityList(3) });
  run("initializeCityHint");
  advance(1200);
  elements["#city-hint-dismiss"].click();
  assert.ok(!hint.classList.contains("is-shown"));
  assert.equal(calls.store.get("curb-alerts-city-hint-seen"), true);
  assert.equal(hint.hidden, false, "still there while it fades");
  advance(300);
  assert.equal(hint.hidden, true);
});

test("the hint puts itself away after fourteen seconds", () => {
  const { hint, run, advance, calls } = setup({ cities: cityList(3) });
  run("initializeCityHint");
  advance(1200);
  advance(14000);
  advance(300);
  assert.equal(hint.hidden, true);
  assert.equal(calls.store.get("curb-alerts-city-hint-seen"), true);
});

test("answering the hint before it appears cancels it and remembers", () => {
  const { hint, run, advance, calls } = setup({ cities: cityList(3) });
  run("initializeCityHint");
  run("dismissCityHint");
  advance(20000);
  assert.equal(hint.hidden, true);
  assert.equal(calls.store.get("curb-alerts-city-hint-seen"), true);
});

test("the hint is not shown to someone who has chosen a city, has seen it, or has nowhere else to go", () => {
  for (const options of [{ stored: true }, { seen: true }, { cities: cityList(1) }]) {
    const { hint, run, advance, timers } = setup({ cities: cityList(3), ...options });
    run("initializeCityHint");
    advance(20000);
    assert.equal(hint.hidden, true);
    assert.equal(timers.length, 0);
  }
});

test("on a phone the hint is skipped, because the chips sit right under the header", () => {
  const { hint, run, advance, timers } = setup({ cities: cityList(3), narrow: true });
  run("initializeCityHint");
  advance(20000);
  assert.equal(hint.hidden, true);
  assert.equal(timers.length, 0);
});

test("the markup holds a chip row on the map screen and on the landing page, and the hint beside the dropdown", () => {
  assert.equal((INDEX.match(/data-city-chips/g) || []).length, 2);
  assert.match(INDEX, /<div id="city-hint" class="city-hint" role="note" hidden>/);
  assert.match(INDEX, /id="hero-eyebrow">Street sweeping alerts</);
  assert.match(INDEX, /when your city sweeps it/);
  assert.match(STYLES, /\.city-chips\[hidden\] \{\s*display: none;/);
  assert.match(STYLES, /\.city-hint\[hidden\] \{\s*display: none;/);
  assert.match(STYLES, /\.city-chip\.is-active \{/);
});

test("Minneapolis and San Francisco carry their own page wording; Denver uses the page's default", () => {
  assert.match(registry.getCity("minneapolis").pageCopy.eyebrow, /snow emergency/);
  assert.match(registry.getCity("minneapolis").pageCopy.heroText, /snow emergency/);
  assert.match(registry.getCity("minneapolis").pageCopy.heroTitle, /snow emergency/);
  assert.match(registry.getCity("san-francisco").pageCopy.eyebrow, /San Francisco/);
  assert.equal(registry.getCity("denver").pageCopy, undefined);
});

"use strict";

// The colour legend under the map. Denver's stays in the markup; a city whose curbs use other colours
// (Minneapolis's snow classes) swaps in its own from its city record. Like the other client tests this
// lifts functions out of public/app.js as source text and drives them with the shared fake DOM.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeElement } = require("./lib/fake-dom.js");

const registry = require("../public/cities.js");
const APP_LINES = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").split("\n");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

function extractColors() {
  const start = APP_LINES.findIndex((line) => line.startsWith("const colors = {"));
  let end = start;
  while (APP_LINES[end] !== "};") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

function setup(pageCopy) {
  makeElement.onFocus = () => {};
  const legend = makeElement("", "legend");
  legend.appendChild(makeElement("", "legend-item"));
  const swatches = makeElement("", "map-details-swatches");
  swatches.appendChild(makeElement("", "legend-dot"));
  const document = {
    querySelector: (selector) => (selector === ".map-details .legend" ? legend : selector === ".map-details-swatches" ? swatches : null),
    createElement: () => makeElement()
  };
  const sandbox = { document, CITY_PAGE_COPY: pageCopy };
  vm.createContext(sandbox);
  vm.runInContext(`${extractColors()}\n${extractFunctionBlock("applyCityLegend")}\nthis.__colors = colors;`, sandbox);
  vm.runInContext("applyCityLegend()", sandbox);
  return { legend, swatches, colors: sandbox.__colors };
}

test("Minneapolis's legend explains its three snow classes, in the colours the curbs are drawn in", () => {
  const { legend, swatches, colors } = setup(registry.getCity("minneapolis").pageCopy);
  assert.equal(legend.children.length, 3, "Denver's seven entries are replaced");
  assert.equal(swatches.children.length, 3);

  const [route, even, odd] = legend.children;
  assert.equal(route.children[0].style.background, colors.snowRoute);
  assert.equal(even.children[0].style.background, colors.snowEven);
  assert.equal(odd.children[0].style.background, colors.snowOdd);
  assert.match(route.children[1].textContent, /Snow emergency route.*Day 1.*plowed/);
  assert.match(even.children[1].textContent, /Even-numbered side.*Day 2/);
  assert.match(odd.children[1].textContent, /Odd-numbered side.*Day 3/);
  assert.deepEqual(swatches.children.map((dot) => dot.style.background), [colors.snowRoute, colors.snowEven, colors.snowOdd]);
});

test("every colour a Minneapolis curb is drawn in has a legend entry, and nothing else does", () => {
  const snow = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "minneapolis-snow.json"), "utf8"));
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunctionBlock("getSnowClass")}\nthis.__fn = getSnowClass;`, sandbox);
  const classToKey = { route: "snowRoute", even: "snowEven", odd: "snowOdd" };
  const used = new Set(snow.curbs.map((curb) => classToKey[sandbox.__fn(curb.days)]));
  const listed = new Set(registry.getCity("minneapolis").pageCopy.legend.map((entry) => entry.colorKey));
  assert.deepEqual([...listed].sort(), [...used].sort());
});

test("a city with no legend of its own leaves Denver's legend alone", () => {
  for (const pageCopy of [null, {}, { legend: [] }, registry.getCity("san-francisco").pageCopy]) {
    const { legend, swatches } = setup(pageCopy);
    assert.equal(legend.children.length, 1, "untouched");
    assert.equal(swatches.children.length, 1, "untouched");
  }
  assert.equal(registry.getCity("denver").pageCopy, undefined);
  assert.match(INDEX, /<span class="legend-dot orange"><\/span> South curb of east-west streets/);
  assert.match(INDEX, /Pink: no Denver sweeping schedule found/);
});

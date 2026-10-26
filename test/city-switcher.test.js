"use strict";

// The city dropdown in the header: a button and a listbox that drops from it. Like the other client
// tests this lifts initializeCitySwitcher out of public/app.js as source text and drives it with a
// small fake DOM (the repo has no browser or jsdom), so a rename breaks it even when behaviour is the same.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_LINES = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").split("\n");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const STYLES = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

function extractFunctionBlock(name) {
  const start = APP_LINES.findIndex((line) => line.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `could not find function ${name} in public/app.js`);
  let end = start;
  while (APP_LINES[end] !== "}") end += 1;
  return APP_LINES.slice(start, end + 1).join("\n");
}

function makeElement(id = "", className = "") {
  const element = {
    id,
    className,
    hidden: false,
    textContent: "",
    tabIndex: 0,
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    offsetWidth: 180,
    rect: { left: 700, right: 850 },
    classList: {
      contains: (name) => element.className.split(/\s+/).includes(name),
      add: (name) => { if (!element.classList.contains(name)) element.className = `${element.className} ${name}`.trim(); },
      remove: (name) => { element.className = element.className.split(/\s+/).filter((item) => item && item !== name).join(" "); },
      toggle: (name, force) => (force ? element.classList.add(name) : element.classList.remove(name))
    },
    setAttribute: (name, value) => { element.attributes[name] = String(value); },
    getAttribute: (name) => element.attributes[name],
    removeAttribute: (name) => { delete element.attributes[name]; },
    appendChild: (child) => { child.parent = element; element.children.push(child); },
    addEventListener: (type, handler) => { (element.listeners[type] = element.listeners[type] || []).push(handler); },
    getBoundingClientRect: () => element.rect,
    contains: (target) => target === element || element.children.some((child) => child.contains(target)),
    closest: (selector) => (element.className.split(/\s+/).includes(selector.replace(".", "")) ? element : null),
    focus: () => { document.activeElement = element; }
  };
  return element;
}

const document = {};

function setup({ cities, active = "denver", saveResult = true }) {
  const switcher = makeElement("city-switcher", "city-switcher");
  const button = makeElement("city-switcher-button", "city-switcher-button");
  const label = makeElement("city-switcher-label");
  const list = makeElement("city-switcher-list", "city-switcher-list");
  list.appendChild = (child) => { list.children.push(child); };
  switcher.appendChild(button);
  switcher.appendChild(list);
  const byId = { "#city-switcher": switcher, "#city-switcher-button": button, "#city-switcher-label": label, "#city-switcher-list": list };
  document.querySelector = (selector) => byId[selector] || null;
  document.createElement = () => makeElement();
  document.addEventListener = (type, handler) => { (document.listeners[type] = document.listeners[type] || []).push(handler); };
  document.listeners = {};
  document.activeElement = null;

  const calls = { saved: [], reloaded: 0 };
  const sandbox = {
    document,
    ACTIVE_CITY: { id: active, name: cities.find((city) => city.id === active).name },
    window: {
      CityRegistry: { listCities: () => cities, saveCityChoice: (id) => { calls.saved.push(id); return saveResult; } },
      location: { reload: () => { calls.reloaded += 1; } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunctionBlock("initializeCitySwitcher")}\ninitializeCitySwitcher();`, sandbox);
  const fire = (target, type, extra = {}) => (target.listeners[type] || []).forEach((handler) => handler({ preventDefault() {}, target, ...extra }));
  return { switcher, button, label, list, calls, fire, options: list.children };
}

const CITIES = [{ id: "denver", name: "Denver" }, { id: "minneapolis", name: "Minneapolis" }, { id: "san-francisco", name: "San Francisco" }];

test("it lists the available cities, labels the button with the open one and marks it selected", () => {
  const { label, options } = setup({ cities: CITIES });
  assert.equal(label.textContent, "Denver");
  assert.deepEqual(options.map((option) => option.textContent), ["Denver", "Minneapolis", "San Francisco"]);
  assert.deepEqual(options.map((option) => option.getAttribute("aria-selected")), ["true", "false", "false"]);
  assert.ok(options.every((option) => option.getAttribute("role") === "option"));
});

test("it is hidden when there is only one city to choose", () => {
  const { switcher, options } = setup({ cities: [CITIES[0]] });
  assert.equal(switcher.hidden, true);
  assert.equal(options.length, 0);
});

test("the button opens the list, which drops down, and a second press closes it", () => {
  const { switcher, button, list, fire } = setup({ cities: CITIES });
  fire(button, "click");
  assert.ok(switcher.classList.contains("is-open"));
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(list.getAttribute("aria-hidden"), undefined);
  assert.equal(document.activeElement.dataset.city, "denver", "focus lands on the open city");
  fire(button, "click");
  assert.ok(!switcher.classList.contains("is-open"));
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(list.getAttribute("aria-hidden"), "true");
});

test("choosing another city saves it and reloads; choosing the open one only closes", () => {
  const first = setup({ cities: CITIES });
  first.fire(first.button, "click");
  first.fire(first.list, "click", { target: first.options[2] });
  assert.deepEqual(first.calls.saved, ["san-francisco"]);
  assert.equal(first.calls.reloaded, 1);

  const same = setup({ cities: CITIES });
  same.fire(same.button, "click");
  same.fire(same.list, "click", { target: same.options[0] });
  assert.deepEqual(same.calls.saved, []);
  assert.equal(same.calls.reloaded, 0);
  assert.ok(!same.switcher.classList.contains("is-open"));

  const blocked = setup({ cities: CITIES, saveResult: false });
  blocked.fire(blocked.button, "click");
  blocked.fire(blocked.list, "click", { target: blocked.options[1] });
  assert.equal(blocked.calls.reloaded, 0, "a failed save leaves the page as it is");
  assert.ok(!blocked.switcher.classList.contains("is-open"));
});

test("the keyboard moves through the list, wraps, selects with Enter and closes with Escape", () => {
  const { switcher, button, list, options, calls, fire } = setup({ cities: CITIES });
  fire(button, "keydown", { key: "ArrowDown" });
  assert.ok(switcher.classList.contains("is-open"));
  fire(list, "keydown", { key: "ArrowDown" });
  assert.equal(document.activeElement, options[1]);
  fire(list, "keydown", { key: "End" });
  assert.equal(document.activeElement, options[2]);
  fire(list, "keydown", { key: "ArrowDown" });
  assert.equal(document.activeElement, options[0], "wraps to the top");
  fire(list, "keydown", { key: "ArrowUp" });
  assert.equal(document.activeElement, options[2], "and to the bottom");
  fire(list, "keydown", { key: "Escape" });
  assert.ok(!switcher.classList.contains("is-open"));
  assert.equal(document.activeElement, button, "focus returns to the button");

  fire(button, "keydown", { key: "ArrowDown" });
  fire(list, "keydown", { key: "ArrowDown" });
  fire(list, "keydown", { key: "Enter" });
  assert.deepEqual(calls.saved, ["minneapolis"]);
});

test("a tap elsewhere closes the list, a tap inside it does not", () => {
  const { switcher, button, fire } = setup({ cities: CITIES });
  fire(button, "click");
  document.listeners.pointerdown.forEach((handler) => handler({ target: button }));
  assert.ok(switcher.classList.contains("is-open"));
  document.listeners.pointerdown.forEach((handler) => handler({ target: makeElement("elsewhere") }));
  assert.ok(!switcher.classList.contains("is-open"));
});

test("the list hangs from the left edge when hanging from the right would leave the screen", () => {
  const wide = setup({ cities: CITIES });
  wide.fire(wide.button, "click");
  assert.ok(!wide.switcher.classList.contains("align-left"));

  const narrow = setup({ cities: CITIES });
  narrow.switcher.rect = { left: 16, right: 150 };
  narrow.fire(narrow.button, "click");
  assert.ok(narrow.switcher.classList.contains("align-left"));
});

test("the markup is a button and a listbox, and the styles animate the list without the hidden attribute", () => {
  assert.match(INDEX, /<button id="city-switcher-button"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"/);
  assert.match(INDEX, /<ul id="city-switcher-list"[^>]*role="listbox"/);
  assert.doesNotMatch(INDEX, /<select id="city-switcher"/);
  const list = STYLES.match(/\.city-switcher-list \{[^}]*\}/)[0];
  assert.match(list, /visibility: hidden/);
  assert.match(list, /transition:/);
  assert.match(STYLES, /\.city-switcher\.is-open \.city-switcher-list \{[^}]*visibility: visible/);
  assert.match(STYLES, /prefers-reduced-motion: reduce\) \{\s*\.city-switcher-list/);
});

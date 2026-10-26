"use strict";

// A very small stand-in for the parts of the DOM the client's city controls touch, so those can be tested
// without a browser (the repo has no jsdom). Elements keep children, attributes, listeners and a class list.

function makeElement(id = "", className = "") {
  let text = "";
  const element = {
    id,
    className,
    hidden: false,
    tabIndex: 0,
    dataset: {},
    style: {},
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
    focus: () => { if (makeElement.onFocus) makeElement.onFocus(element); },
    click: () => (element.listeners.click || []).forEach((handler) => handler({ preventDefault() {}, target: element }))
  };
  Object.defineProperty(element, "textContent", {
    get: () => text,
    set: (value) => {
      text = String(value);
      if (text === "") element.children.length = 0;
    }
  });
  return element;
}

// Whoever owns a fake document sets this to learn which element took focus.
makeElement.onFocus = null;

module.exports = { makeElement };

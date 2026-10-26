const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../public/cities.js");

test("every city names its kind and the loader that reads its inventory", () => {
  for (const city of registry.CITIES) {
    assert.ok(["sweeping", "snow"].includes(city.kind), `${city.id} has an unknown kind`);
    assert.ok(city.inventoryFormat, `${city.id} names no inventory format`);
  }
});

test("a curb id belongs to the city whose prefix it carries, and unprefixed ids are Denver's", () => {
  assert.equal(registry.getCityForCurbId("mpls:3fa9c1").id, "minneapolis");
  assert.equal(registry.getCityForCurbId("12345:north").id, "denver");
  assert.equal(registry.getCityForCurbId(undefined).id, "denver");
});

test("id prefixes never overlap, so an id can only ever belong to one city", () => {
  const prefixes = registry.CITIES.map((city) => city.idPrefix).filter(Boolean);
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a !== b) assert.ok(!a.startsWith(b), `"${a}" starts with "${b}"`);
    }
  }
  assert.equal(new Set(prefixes).size, prefixes.length);
  assert.equal(registry.getCity(registry.DEFAULT_CITY_ID).idPrefix, "");
});

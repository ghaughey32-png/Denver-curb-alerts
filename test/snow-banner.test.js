"use strict";

// The page's snow emergency banner and the push link that opens it. app.js is a plain script that
// cannot be required, so this reads its source, as test/not-maintained-ui.test.js does.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

test("the banner is outside every view and has a [hidden] rule beside its display", () => {
  const banner = indexSource.indexOf('id="snow-banner"');
  assert.ok(banner > 0);
  assert.ok(banner < indexSource.indexOf('data-view="landing"'), "before the first view, so every tab shows it");
  assert.match(stylesSource, /\.sweep-check\[hidden\]\s*\{\s*display: none;/);
});

test("the banner only exists in a snow city and refreshes on boot, focus and a timer", () => {
  assert.match(appSource, /const copy = IS_SNOW_CITY && snowEmergency \?/);
  assert.match(appSource, /setInterval\(refreshSnowEmergency, SNOW_EMERGENCY_REFRESH_MS\)/);
  assert.match(appSource, /if \(!document\.hidden\) \{\s*refreshSnowEmergency\(\);/);
});

test("a failed refresh keeps the banner the driver already has", () => {
  const body = appSource.slice(appSource.indexOf("async function refreshSnowEmergency"), appSource.indexOf("function formatSnowInstant"));
  assert.match(body, /catch \{/);
  assert.equal(/snowEmergency = null[^?]*\n\s*(renderSnowBanner|\})/.test(body.split("catch")[1] || ""), false);
});

test("a snow push link switches an other-city page to Minneapolis", () => {
  assert.match(appSource, /snowLink && !IS_SNOW_CITY && window\.CityRegistry\.saveCityChoice\("minneapolis"\)/);
});

test("the legal pages name the snow alerts they sell and the data they use", () => {
  assert.match(indexSource, /Minneapolis snow emergency alerts need a subscription/);
  assert.match(indexSource, /snow emergency parking data published\s+by the City of Minneapolis/);
});

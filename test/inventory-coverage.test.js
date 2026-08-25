const test = require("node:test");
const assert = require("node:assert/strict");
const inventory = require("../public/denver-west-routes.json");
const manifest = require("../data/inventory-expected-blocks.json");
const { auditInventory } = require("../scripts/lib/inventory-auditor.js");
const { areas } = require("../data/coverage-pilot-areas.json");
const { metresOutsideDenver } = require("../scripts/lib/denver-city-limits.js");

test("every declared public street block is valid and auditable", () => {
  const result = auditInventory({ routes: inventory.routes, blocks: manifest.blocks, generateUnavailable: false });
  assert.equal(result.unexplainedGaps.some((gap) => gap.reason === "invalid expected-block definition"), false);
  assert.equal(result.report.counts.expected, manifest.blocks.filter((block) => !block.excluded).length);
});

// Pink means "Denver has no schedule for this block, so you do not need to move
// your car", which is only ever true of curb Denver sweeps. Aurora, Englewood,
// Sheridan, Glendale and the rest sweep and ticket their own streets, so pink
// past the city line is worse than no coverage at all. The importer drops blocks
// that belong to another city outright; this catches the other half, a block
// that is Denver's but whose geometry reaches across the line.
test("no pink route is drawn outside the city line", () => {
  const strayed = inventory.routes.filter((route) =>
    route.dataUnavailable &&
    Array.isArray(route.map?.path) &&
    // The cut sits on the same 20 m buffer the exclusion rule uses, because the
    // line runs down the middle of the streets it shares; the half metre of
    // slack is the rounding of the trimmed endpoint to six decimals.
    route.map.path.some((point) => metresOutsideDenver(point) > 20.5)
  );

  assert.deepEqual(strayed.map((route) => route.id), []);
});

test("E 8th through E 16th has clickable coverage from Lincoln to Gaylord", () => {
  const prefix = "e8-e16-lincoln-gaylord-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(areaBlocks.length, 3779);
  assert.equal(publicBlocks.length, 588);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.7285 && lat <= 39.7426, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -104.9868 && lon <= -104.961, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 574);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("unresolved Tennyson blocks are not published as generated pink routes", () => {
  const expectedIds = [
    "tennyson-46-47",
    "tennyson-47-48-south",
    "tennyson-48-south-48",
    "tennyson-48-49",
    "tennyson-49-50",
    "tennyson-50-51",
    "tennyson-51-52"
  ];
  const routesByExpectedBlock = new Map(
    inventory.routes
      .filter((route) => route.streetName === "N TENNYSON ST" && route.expectedBlockId)
      .map((route) => [route.expectedBlockId, route])
  );

  assert.deepEqual(expectedIds.filter((id) => routesByExpectedBlock.has(id)), []);
});

test("W Regis University frontage remains published as a pink unavailable route", () => {
  const route = inventory.routes.find(
    (candidate) => candidate.expectedBlockId === "west-regis-university-frontage"
  );

  assert.ok(route);
  assert.equal(route.streetName, "W REGIS BLVD");
  assert.equal(route.sweepType, "Unavailable");
  assert.equal(route.dataUnavailable, true);
  assert.deepEqual(route.map.path, [
    [39.7875309105346, -105.033082387858],
    [39.787528, -105.03125],
    [39.787526, -105.0294],
    [39.7875246979453, -105.027566078125]
  ]);
});

test("Regis-area ownership classifications remain visible", () => {
  const parkside = inventory.routes.find((route) => route.expectedBlockId === "west-parkside-decatur-eliot");
  assert.ok(parkside);
  assert.equal(parkside.dataUnavailable, true);

  const privateIds = [
    "not-maintained-parkside-east",
    "not-maintained-decatur-52-parkside",
    "not-maintained-clay-place",
    "not-maintained-decatur-parkside-53",
    "not-maintained-west-53-inner",
    "not-maintained-eliot-parkside-53",
    "not-maintained-primrose-lane",
    "not-maintained-columbine-road"
  ];
  privateIds.forEach((id) => {
    const route = inventory.routes.find((candidate) => candidate.id === id);
    assert.ok(route, `${id} should be published`);
    assert.equal(route.sweepType, "Private");
    assert.match(route.leftSweepingRule, /not maintained by the City and County of Denver/i);
  });
});

test("Polo Club private streets render gray instead of blank", () => {
  const { applyConfirmedPoloClubCoverage } = require("../scripts/lib/confirmed-polo-club-coverage.js");
  const probeMap = new Map();
  applyConfirmedPoloClubCoverage(probeMap);
  const poloClubIds = [...probeMap.keys()];

  assert.ok(poloClubIds.length >= 30, "expected the full set of Polo Club blocks to be patched");
  poloClubIds.forEach((id) => {
    const route = inventory.routes.find((candidate) => candidate.id === id);
    assert.ok(route, `${id} should be published`);
    assert.equal(route.sweepType, "Private");
    assert.match(route.leftSweepingRule, /not maintained by the City and County of Denver/i);
    const block = manifest.blocks.find((candidate) => candidate.id === id);
    assert.ok(block?.excluded, `${id} should be excluded from public-block auditing`);
  });
});

test("W 1st through W 5th has declared map coverage from Sheridan to Federal", () => {
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith("w1-w5-osm-"));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(areaBlocks.length, 464);
  assert.equal(publicBlocks.length, 153);
  assert.ok(result.report.counts.scheduled > 0);
});

test("unverified Yates fallback is not published as a pink route", () => {
  const route = inventory.routes.find((candidate) => candidate.expectedBlockId === "yates-hurst-6th-south-drive");

  assert.equal(route, undefined);
});

test("W Alameda through W 5th has declared map coverage from Federal to I-25", () => {
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith("w5-alameda-federal-i25-osm-"));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.ok(areaBlocks.length > 0);
  assert.ok(publicBlocks.length > 0);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.7104 && lat <= 39.7244, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -105.0254 && lon <= -105.0002, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 260);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith("w5-alameda-federal-i25-osm-")));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Bayaud through W 5th has clickable coverage from Sheridan to Federal", () => {
  const prefix = "w5-bayaud-sheridan-federal-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.ok(areaBlocks.length > 0);
  assert.ok(publicBlocks.length > 0);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.7142 && lat <= 39.7244, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -105.0534 && lon <= -105.025, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled > 0);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Exposition through W Bayaud has clickable coverage from Sheridan to Federal", () => {
  const prefix = "bayaud-exposition-sheridan-federal-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.ok(areaBlocks.length > 0);
  assert.ok(publicBlocks.length > 0);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.703 && lat <= 39.7142, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -105.0534 && lon <= -105.025, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled > 0);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Exposition through W Nevada has clickable coverage from Federal to I-25", () => {
  const prefix = "nevada-exposition-federal-i25-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(areaBlocks.length, 449);
  assert.equal(publicBlocks.length, 224);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.7028 && lat <= 39.7107, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -105.0254 && lon <= -105.0002, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 222);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Florida through W Ohio has clickable coverage from Sheridan to Federal", () => {
  const prefix = "ohio-florida-sheridan-federal-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(areaBlocks.length, 1060);
  assert.equal(publicBlocks.length, 489);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.6893 && lat <= 39.7032, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -105.0534 && lon <= -105.025, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 482);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Florida through W Ohio has clickable coverage from Federal to I-25", () => {
  const prefix = "ohio-florida-federal-i25-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(areaBlocks.length, 881);
  assert.equal(publicBlocks.length, 420);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.6893 && lat <= 39.7032, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -105.0254 && lon <= -105.0002, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 414);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Florida through W Virginia has clickable coverage from Jason to Bannock", () => {
  const prefix = "virginia-florida-jason-bannock-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(areaBlocks.length, 552);
  assert.equal(publicBlocks.length, 115);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.6893 && lat <= 39.708, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -104.9995 && lon <= -104.9897, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 80);
  assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
  assert.equal(result.report.counts["unexplained-gap"], 0);
});

test("W Wesley has confirmed coverage from S Platte River Dr to S Jason St", () => {
  const route = inventory.routes.find((candidate) => candidate.id === "confirmed-w-wesley-platte-jason");

  assert.ok(route);
  assert.equal(route.streetName, "W WESLEY AVE");
  assert.equal(route.from, "S PLATTE RIVER DR");
  assert.equal(route.to, "S JASON ST");
  assert.equal(route.leftSweepingRule, "South side: The 1st week of the month.");
  assert.equal(route.rightSweepingRule, "North side: The 1st week of the month.");
  assert.deepEqual(route.map.path[0], [39.6730269895347, -104.998225795144]);
  assert.deepEqual(route.map.path.at(-1), [39.6730363707072, -104.999451214552]);
});

test("S Platte River Dr has confirmed coverage from W Iliff Ave to W Wesley Ave", () => {
  const route = inventory.routes.find((candidate) => candidate.id === "confirmed-s-platte-iliff-wesley");

  assert.ok(route);
  assert.equal(route.streetName, "S PLATTE RIVER DR");
  assert.equal(route.from, "W ILIFF AVE");
  assert.equal(route.to, "W WESLEY AVE");
  assert.equal(route.leftSweepingRule, "East side: The 1st week of the month.");
  assert.equal(route.rightSweepingRule, "West side: The 1st week of the month.");
  assert.deepEqual(route.map.path.at(-1), [39.6730269895347, -104.998225795144]);
});

test("E 26th through E 37th reaches York Street continuously", () => {
  const yorkRoutes = inventory.routes.filter((route) =>
    route.streetName === "N YORK ST" &&
    Array.isArray(route.map?.path) &&
    route.map.path.some(([lat]) => lat >= 39.7544 && lat <= 39.7685)
  );
  const yorkEndpoints = yorkRoutes.flatMap((route) => [route.map.path[0][0], route.map.path.at(-1)[0]]);
  const eastWestRoutesAtYork = inventory.routes.filter((route) =>
    Array.isArray(route.map?.path) &&
    route.map.path.some(([lat, lon]) =>
      lat >= 39.7544 && lat <= 39.7685 && lon >= -104.9598 && lon <= -104.9597
    )
  );

  assert.ok(Math.min(...yorkEndpoints) <= 39.75447, "York coverage should reach E 26th Avenue");
  assert.ok(Math.max(...yorkEndpoints) >= 39.76815, "York coverage should reach E 37th Avenue");
  assert.ok(eastWestRoutesAtYork.some((route) => route.streetName === "E 26TH AVE"));
  assert.ok(eastWestRoutesAtYork.some((route) => route.streetName === "E 37TH AVE"));
});

test("E 26th Avenue Parkway uses the confirmed York-to-Josephine schedule", () => {
  const route = inventory.routes.find((candidate) => candidate.id === 24360);
  const overlappingPinkRoute = inventory.routes.find(
    (candidate) => candidate.expectedBlockId === "e17-e26-downing-york-osm-239249844-176088017-2823784462-0"
  );

  assert.ok(route);
  assert.equal(route.streetName, "E 26TH AVENUE PKWY");
  assert.equal(route.from, "N YORK ST/E 26TH AVE/TRAFFIC SIGNAL");
  assert.equal(route.to, "N JOSEPHINE ST");
  assert.equal(route.leftSweepingRule, "North side: The 2nd Thursday of the month.");
  assert.equal(route.rightSweepingRule, "South side: The 2nd Friday of the month.");
  assert.equal(route.isPosted, true);
  assert.equal(overlappingPinkRoute, undefined);
});

test("E 38th through E 45th includes official coverage from Blake to Colorado", () => {
  const prefix = "e38-e45-blake-colorado-osm-";
  const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
  const publicBlocks = areaBlocks.filter((block) => !block.excluded);
  const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

  assert.equal(publicBlocks.length, 396);
  publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
    assert.ok(lat >= 39.7692 && lat <= 39.779, `latitude ${lat} is outside the mapping area`);
    assert.ok(lon >= -104.9734 && lon <= -104.9404, `longitude ${lon} is outside the mapping area`);
  });
  assert.ok(result.report.counts.scheduled >= 356);
  assert.ok(inventory.routes.some((route) =>
    route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)
  ));
  assert.equal(result.report.counts["unexplained-gap"], 0);
  assert.ok(inventory.routes.some((route) =>
    route.streetName === "E 45TH AVE" &&
    route.map?.path?.some(([lat, lon]) => lat >= 39.7788 && lat <= 39.779 && lon >= -104.9734 && lon <= -104.9404)
  ));
});

// The rectangle and the block counts for each area are recorded once in
// data/coverage-pilot-areas.json. Deriving the table from that file keeps this
// test asserting against the same bounds the pipeline actually imported, which a
// hand-copied table here could silently drift away from.
areas
  .filter((area) => area.coverage)
  .map((area) => ({
    name: area.coverage.testName,
    prefix: `${area.id}-osm-`,
    bounds: { south: area.south, north: area.north, west: area.west, east: area.east },
    expectedPublicBlocks: area.coverage.expectedPublicBlocks,
    minimumScheduled: area.coverage.minimumScheduled
  }))
  .forEach(({ name, prefix, bounds, expectedPublicBlocks, minimumScheduled }) => {
  test(`${name} has clickable coverage`, () => {
    const areaBlocks = manifest.blocks.filter((block) => String(block.id).startsWith(prefix));
    const publicBlocks = areaBlocks.filter((block) => !block.excluded);
    const result = auditInventory({ routes: inventory.routes, blocks: publicBlocks, generateUnavailable: false });

    assert.equal(publicBlocks.length, expectedPublicBlocks);
    publicBlocks.flatMap((block) => block.geometry).forEach(([lat, lon]) => {
      assert.ok(lat >= bounds.south && lat <= bounds.north, `latitude ${lat} is outside the mapping area`);
      assert.ok(lon >= bounds.west && lon <= bounds.east, `longitude ${lon} is outside the mapping area`);
    });
    assert.ok(result.report.counts.scheduled >= minimumScheduled);
    // Every block that failed to resolve has to be clickable rather than blank,
    // so an area carrying unresolved blocks must publish a pink route tagged
    // with the block it stands in for. An area where everything resolves needs
    // no pink at all, and asserting one unconditionally would fail the better
    // outcome: e26-e37-colorado-quebec reached 609 of 609 scheduled once the
    // auditor stopped treating "Martin Luther King Jr" as a different street
    // from "Martin Luther King", and its pink went to zero as a result.
    if (result.report.counts.unavailable > 0) {
      assert.ok(inventory.routes.some((route) => route.dataUnavailable && String(route.expectedBlockId || "").startsWith(prefix)));
    }
    assert.equal(result.report.counts["unexplained-gap"], 0);
  });
});

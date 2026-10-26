const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCsv,
  normalizeStreetName,
  readSchedule,
  mergeSchedules,
  readSideLabel,
  getSideKey,
  buildBostonCurbs,
  METRES_PER_MILE
} = require("../scripts/lib/boston-sweeping.js");

// A small grid. Main St runs west to east along latitude 42.35 in three blocks, 0.002 degrees of
// longitude each (about 165 m), crossed by Oak, Elm and Pine; it ends at a dead end past Pine. Main's
// even numbers are on its left (north), odd on its right, as the SAM layer lists them.
const LAT = 42.35;
const LONS = [-71.006, -71.004, -71.002, -71.0];
const MILES_PER_BLOCK = 0.002 * 82000 / METRES_PER_MILE;

function segment(id, name, type, coordinates, extra = {}) {
  return {
    type: "Feature",
    properties: { SEGMENT_ID: id, ST_NAME: name, ST_TYPE: type, L_F_ADD: "2", L_T_ADD: "20", R_F_ADD: "1", R_T_ADD: "19", ...extra },
    geometry: { type: "LineString", coordinates }
  };
}

function grid() {
  return [
    segment(1, "Main", "ST", [[LONS[0], LAT], [LONS[1], LAT]]),
    segment(2, "Main", "ST", [[LONS[1], LAT], [LONS[2], LAT]]),
    segment(3, "Main", "ST", [[LONS[2], LAT], [LONS[3], LAT]]),
    segment(10, "Oak", "ST", [[LONS[0], LAT], [LONS[0], LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" }),
    segment(11, "Elm", "ST", [[LONS[1], LAT], [LONS[1], LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" }),
    segment(12, "Pine", "ST", [[LONS[2], LAT], [LONS[2], LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" })
  ];
}

function scheduleRow(overrides = {}) {
  return {
    main_id: "100",
    st_name: "Main St",
    dist_name: "Roxbury",
    start_time: "08:00",
    end_time: "12:00",
    side: "Even",
    from: "Oak St",
    to: "Pine St",
    miles: String(MILES_PER_BLOCK * 2),
    week_1: "t",
    week_2: "f",
    week_3: "t",
    week_4: "f",
    week_5: "f",
    sunday: "f",
    monday: "t",
    tuesday: "f",
    wednesday: "f",
    thursday: "f",
    friday: "f",
    saturday: "f",
    every_day: "f",
    year_round: "f",
    ...overrides
  };
}

const build = (rows, features = grid()) => buildBostonCurbs({ rows, features });

test("parseCsv reads CRLF endings and quoted commas, so the last header is not 'hista\\r'", () => {
  const rows = parseCsv('a,b,hista\r\n1,"x, y",9\r\n2,z,8\r\n');
  assert.deepEqual(rows, [{ a: "1", b: "x, y", hista: "9" }, { a: "2", b: "z", hista: "8" }]);
});

test("street names meet across the schedule's abbreviations and the street layer's spelling", () => {
  assert.deepEqual(normalizeStreetName("Brighton Av"), normalizeStreetName("BRIGHTON AVE"));
  assert.deepEqual(normalizeStreetName("Mt Pleasant Ave"), normalizeStreetName("Mount Pleasant AVE"));
  assert.deepEqual(normalizeStreetName("Saint Marks Rd"), normalizeStreetName("St Marks RD"));
  assert.deepEqual(normalizeStreetName("Martin Luther King Jr Blvd"), normalizeStreetName("Martin Luther King Blvd"));
  assert.equal(normalizeStreetName("First St").core, "1st");
  assert.notDeepEqual(normalizeStreetName("5th St"), normalizeStreetName("5th Ave"));
});

test("a row reads as days, weeks, posted window and season", () => {
  const { schedule } = readSchedule(scheduleRow({ dist_name: "North End" }));
  assert.deepEqual(schedule.days, [1]);
  assert.deepEqual(schedule.weeks, [1, 3]);
  assert.equal(schedule.start, "08:00");
  assert.equal(schedule.season, "mar-dec");
  assert.equal(schedule.nightBefore, false);
  assert.equal(readSchedule(scheduleRow()).schedule.season, "apr-nov");
  assert.equal(readSchedule(scheduleRow({ year_round: "t" })).schedule.season, "year-round");
});

test("a night row is nightBefore and an every-day year-round row is standing, not a sweep", () => {
  const night = readSchedule(scheduleRow({ start_time: "00:01", end_time: "07:00" })).schedule;
  assert.equal(night.nightBefore, true);
  const standing = readSchedule(
    scheduleRow({ start_time: "00:01", end_time: "07:00", every_day: "t", year_round: "t", sunday: "t", tuesday: "t", wednesday: "t", thursday: "t", friday: "t", saturday: "t" })
  ).schedule;
  assert.equal(standing.standing, true);
  assert.equal(standing.days.length, 7);
  assert.equal(readSchedule(scheduleRow({ monday: "f" })).schedule, null);
});

test("a window that ends before it starts is kept as given and flagged", () => {
  const result = readSchedule(scheduleRow({ start_time: "12:00", end_time: "04:00" }));
  assert.equal(result.schedule.start, "12:00");
  assert.equal(result.endsBeforeStart, true);
  assert.equal(readSchedule(scheduleRow({ start_time: "00:01", end_time: "07:00" })).endsBeforeStart, false);
});

test("two rows with the same window are one rule that remembers both ids", () => {
  const a = readSchedule(scheduleRow({ main_id: "7" })).schedule;
  const b = readSchedule(scheduleRow({ main_id: "9" })).schedule;
  const merged = mergeSchedules([a, b]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].mainIds, [7, 9]);
});

test("side labels: odd and even, both, medians, and the labels that are not supported", () => {
  assert.deepEqual(readSideLabel("Odd"), { parity: "odd" });
  assert.deepEqual(readSideLabel(""), { both: true });
  assert.deepEqual(readSideLabel("Even Side Median"), { parity: "even", median: true });
  assert.equal(readSideLabel("Ramp").unsupported, true);
});

test("a row between two cross streets lands on the even (left) side of the blocks between them", () => {
  const { curbs, report } = build([scheduleRow()]);
  assert.equal(report.confidentRows, 1);
  assert.equal(curbs.length, 2);
  curbs.forEach((curb) => {
    assert.equal(curb.street, "Main St");
    assert.equal(curb.sideKey, "north");
    assert.deepEqual(curb.addresses, [2, 20]);
  });
});

test("odd rows go to the right (south) side, and a no-side row goes to both", () => {
  const odd = build([scheduleRow({ side: "Odd" })]).curbs;
  assert.deepEqual([...new Set(odd.map((curb) => curb.sideKey))], ["south"]);
  const both = build([scheduleRow({ side: "" })]).curbs;
  assert.equal(both.length, 4);
  assert.deepEqual([...new Set(both.map((curb) => curb.sideKey))].sort(), ["north", "south"]);
  both.forEach((curb) => assert.ok(curb.opposite));
});

test("each side is pushed away from the centreline toward its own side", () => {
  const { curbs } = build([scheduleRow({ side: "" })]);
  const north = curbs.find((curb) => curb.sideKey === "north");
  const south = curbs.find((curb) => curb.sideKey === "south");
  assert.ok(north.geometry[0][0] > LAT);
  assert.ok(south.geometry[0][0] < LAT);
});

test("a row whose path is the wrong length is not published", () => {
  const short = build([scheduleRow({ miles: String(MILES_PER_BLOCK * 4) })]);
  assert.equal(short.curbs.length, 0);
  assert.equal(short.report.statuses["out-of-band"], 1);
  assert.equal(short.report.unpublished[0].status, "out-of-band");
});

test("a row with no length cannot be checked and is not published", () => {
  const { curbs, report } = build([scheduleRow({ miles: "0" })]);
  assert.equal(curbs.length, 0);
  assert.equal(report.statuses["no-length"], 1);
});

test("a dead end is placed as the leaf of the street, and the length band still has to hold", () => {
  const placed = build([scheduleRow({ from: "Pine St", to: "Dead End", miles: String(MILES_PER_BLOCK) })]);
  assert.equal(placed.report.confidentRows, 1);
  assert.equal(placed.report.confidentLeafEndRows, 1);
  assert.equal(placed.curbs.length, 1);
  const tooLong = build([scheduleRow({ from: "Pine St", to: "Dead End", miles: String(MILES_PER_BLOCK * 3) })]);
  assert.equal(tooLong.curbs.length, 0);
});

test("a street the layer does not have is reported, not guessed", () => {
  const { curbs, report } = build([scheduleRow({ st_name: "Nowhere St" })]);
  assert.equal(curbs.length, 0);
  assert.equal(report.statuses["street-not-found"], 1);
});

test("every row that covers a curb is on it, never one pick", () => {
  const monday = scheduleRow({ main_id: "1" });
  const thursday = scheduleRow({ main_id: "2", monday: "f", thursday: "t", start_time: "00:01", end_time: "07:00", year_round: "t" });
  const { curbs } = build([monday, thursday]);
  assert.equal(curbs.length, 2);
  curbs.forEach((curb) => assert.deepEqual(curb.schedules.map((schedule) => schedule.mainId), [1, 2]));
});

test("a median row is its own curb, drawn on the centreline and never merged into the outer curb", () => {
  const { curbs } = build([scheduleRow({ main_id: "1" }), scheduleRow({ main_id: "2", side: "Even Side Median" })]);
  const median = curbs.filter((curb) => curb.median);
  const outer = curbs.filter((curb) => !curb.median);
  assert.equal(median.length, 2);
  assert.equal(outer.length, 2);
  outer.forEach((curb) => assert.deepEqual(curb.schedules.map((schedule) => schedule.mainId), [1]));
  median.forEach((curb) => assert.deepEqual(curb.schedules.map((schedule) => schedule.mainId), [2]));
  assert.equal(median[0].geometry[0][0], LAT);
});

test("curb ids are stable across builds and differ by side", () => {
  const first = build([scheduleRow({ side: "" })]).curbs.map((curb) => curb.id);
  const second = build([scheduleRow({ side: "" })]).curbs.map((curb) => curb.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
  first.forEach((id) => assert.match(id, /^bos:[0-9a-f]{10}$/));
});

test("sideKey follows the direction of the line and the side", () => {
  const eastward = [[LAT, -71.006], [LAT, -71.004]];
  assert.equal(getSideKey(eastward, 1), "north");
  assert.equal(getSideKey(eastward, -1), "south");
});

test("the report counts the odd/even rows and the share placed confidently", () => {
  const { report } = build([scheduleRow(), scheduleRow({ main_id: "2", side: "Odd", miles: "0" })]);
  assert.equal(report.oddEvenRows, 2);
  assert.equal(report.confidentOddEvenRows, 1);
  assert.equal(report.confidentShare, 0.5);
});

// ---- The station check ---------------------------------------------------------------------------
// losta/hista are feet along the street (hista - losta = miles x 5280). Two blocks of Main St, Oak to
// Elm and Elm to Pine, each BLOCK_FEET long, starting at station 100 (the street's first 100 ft has no row).
const BLOCK_FEET = MILES_PER_BLOCK * 5280;

function stationRow(mainId, from, to, low, overrides = {}) {
  return scheduleRow({
    main_id: String(mainId),
    from,
    to,
    miles: String(MILES_PER_BLOCK),
    parent: "MAIN1",
    losta: String(Math.round(low)),
    hista: String(Math.round(low + BLOCK_FEET)),
    ...overrides
  });
}

test("rows whose stations chain along the street agree, even when the street's first feet have no row", () => {
  const rows = [stationRow(1, "Oak St", "Elm St", 100), stationRow(2, "Elm St", "Pine St", 100 + BLOCK_FEET)];
  const { report, curbs } = build(rows);
  assert.deepEqual(report.stations, { agree: 2, mismatch: 0, unchecked: 0 });
  assert.equal(report.confidentRows, 2);
  assert.equal(curbs.length, 2);
});

test("a row whose stations put it somewhere else on the street is withdrawn, not published", () => {
  const rows = [stationRow(1, "Oak St", "Elm St", 100), stationRow(2, "Elm St", "Pine St", 100 + BLOCK_FEET), stationRow(3, "Pine St", "Dead End", 9000, { side: "Odd" })];
  const { report, curbs } = build(rows);
  assert.equal(report.stations.mismatch, 1);
  assert.equal(report.statuses["station-mismatch"], 1);
  assert.equal(report.confidentRows, 2);
  assert.ok(curbs.every((curb) => curb.schedules.every((schedule) => schedule.mainId !== 3)));
});

test("a row alone on its street cannot be checked and stays confident, counted as unchecked", () => {
  const { report } = build([stationRow(1, "Oak St", "Elm St", 4000)]);
  assert.deepEqual(report.stations, { agree: 0, mismatch: 0, unchecked: 1 });
  assert.equal(report.confidentRows, 1);
  assert.equal(report.confidentCheckedOddEvenRows, 0);
});

// ---- Name corrections, short blocks and gaps ------------------------------------------------------

test("the city's misspellings and renamed streets find the layer's spelling", () => {
  assert.deepEqual(normalizeStreetName("Westminister Ave"), normalizeStreetName("WESTMINSTER AVE"));
  assert.deepEqual(normalizeStreetName("Thonrdike St"), normalizeStreetName("Thorndike ST"));
  assert.deepEqual(normalizeStreetName("Joe L Smith Way"), normalizeStreetName("Bishop Joe L Smith WAY"));
  assert.deepEqual(normalizeStreetName("Morrissey William T Blvd"), normalizeStreetName("William T Morrissey BLVD"));
  assert.deepEqual(normalizeStreetName("Newcroft Cr"), normalizeStreetName("Newcroft CIR"));
});

test("a misspelled cross street still places the row when the corrected street meets it", () => {
  const features = grid();
  features[5] = segment(12, "Hartford", "ST", [[LONS[2], LAT], [LONS[2], LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" });
  const { report } = build([scheduleRow({ to: "Hartfold St" })], features);
  assert.equal(report.confidentRows, 1);
});

test("a name that is not on the corrections list is not guessed at", () => {
  assert.equal(build([scheduleRow({ st_name: "Mian St" })]).report.statuses["street-not-found"], 1);
});

test("a short block passes the length gate on metres when the ratio alone would fail it", () => {
  // 0.0005 degrees of longitude is about 41 m; the row says 66 m (ratio 0.62), 25 m longer.
  const features = [
    segment(21, "Tiny", "ST", [[LONS[0], LAT], [LONS[0] + 0.0005, LAT]]),
    segment(22, "Ax", "ST", [[LONS[0], LAT], [LONS[0], LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" }),
    segment(23, "Bx", "ST", [[LONS[0] + 0.0005, LAT], [LONS[0] + 0.0005, LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" })
  ];
  const near = build([scheduleRow({ st_name: "Tiny St", from: "Ax St", to: "Bx St", miles: String(66 / METRES_PER_MILE) })], features);
  assert.equal(near.report.confidentRows, 1);
  const far = build([scheduleRow({ st_name: "Tiny St", from: "Ax St", to: "Bx St", miles: String(120 / METRES_PER_MILE) })], features);
  assert.equal(far.report.confidentRows, 0);
});

test("two pieces of one street the map leaves 30 m apart are joined, and the gap counts toward the length", () => {
  const gap = 0.00036;
  const features = [
    segment(31, "Main", "ST", [[LONS[0], LAT], [LONS[1], LAT]]),
    segment(32, "Main", "ST", [[LONS[1] + gap, LAT], [LONS[2], LAT]]),
    grid()[3],
    grid()[5]
  ];
  const total = (LONS[2] - LONS[0]) * 82000;
  const { report, curbs } = build([scheduleRow({ from: "Oak St", to: "Pine St", miles: String(total / METRES_PER_MILE) })], features);
  assert.equal(report.confidentRows, 1);
  assert.equal(curbs.length, 2);
});

test("a gap wider than the bridge limit is not joined", () => {
  const features = [
    segment(31, "Main", "ST", [[LONS[0], LAT], [LONS[1], LAT]]),
    segment(32, "Main", "ST", [[LONS[1] + 0.002, LAT], [LONS[1] + 0.004, LAT]]),
    grid()[3],
    segment(12, "Pine", "ST", [[LONS[1] + 0.004, LAT], [LONS[1] + 0.004, LAT + 0.002]], { L_F_ADD: "0", L_T_ADD: "0", R_F_ADD: "0", R_T_ADD: "0" })
  ];
  const { report } = build([scheduleRow({ from: "Oak St", to: "Pine St", miles: String(0.006 * 82000 / METRES_PER_MILE) })], features);
  assert.equal(report.confidentRows, 0);
});

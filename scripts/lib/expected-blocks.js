// The expected-block manifest is the largest file in the repo and the one that grows with every
// area mapped: 97,827 blocks as of 2026-08-26. It was written pretty-printed at two-space indent,
// which came to 61.87 MB across 2.97 million lines -- past GitHub's 50 MB warning threshold, and on
// a path toward the 100 MB hard limit that rejects a push outright. Written without the indent it
// is 36.00 MB and byte-for-byte the same data; almost half that file was whitespace.
//
// So this module owns the format, and both writers go through it. Nothing else about the manifest
// changes: it is still plain JSON, still `require`-able, still parses identically. Readers do not
// need to know -- JSON.parse does not care about indentation -- which is why the eight scripts and
// tests that read this file were left alone.
//
// Do not reintroduce an indent here to make the file readable. At 97,827 blocks it is not readable
// either way; reach for `node -e` or jq. If it outgrows 50 MB again the next steps, in order of how
// much they cost, are gzipping it (5.14 MB, but opaque to grep) or splitting it per area the way
// data/mapping-cache-<area-id>.json already is.

const fs = require("fs");
const path = require("path");

const EXPECTED_BLOCKS_PATH = path.join(__dirname, "..", "..", "data", "inventory-expected-blocks.json");

function writeExpectedBlocks(manifest, file = EXPECTED_BLOCKS_PATH) {
  fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`, "utf8");
}

module.exports = { EXPECTED_BLOCKS_PATH, writeExpectedBlocks };

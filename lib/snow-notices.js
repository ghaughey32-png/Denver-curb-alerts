"use strict";

// Noticing that Minneapolis may have declared a snow emergency. The city publishes no declaration
// feed; the one machine-readable signal is the JSON behind the banner shown on every page of
// minneapolismn.gov. It was empty when we checked (2026-09-30), so its shape during an emergency is
// unknown. Nothing here depends on that shape: every string anywhere in the file is read, and a
// notice counts when it says "snow emergency". Pure, like lib/snow.js; server.js does the fetching,
// the remembering and the email.
//
// Detection never declares anything. It tells the author, who confirms with `npm run snow`.

const crypto = require("node:crypto");
const snow = require("./snow.js");

const NOTICE_FEED_URL =
  "https://www.minneapolismn.gov/media/minneapolismngov/site-assets/javascript/site-wide-notices/emergency-en.json";

const SNOW_EMERGENCY_PATTERN = /snow[\s-]+emergenc/i;
const MAX_NOTICES = 20;
const MAX_NOTICE_LENGTH = 1000;

function collectStrings(value, found, depth) {
  if (depth > 8 || found.length > 500) {
    return;
  }

  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, found, depth + 1));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, found, depth + 1));
  }
}

// Every distinct, non-empty piece of text in the feed, markup stripped and whitespace collapsed.
function extractNoticeTexts(feed) {
  const strings = [];
  collectStrings(feed, strings, 0);

  const cleaned = strings
    .map((text) =>
      text
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NOTICE_LENGTH)
    )
    .filter(Boolean);

  return [...new Set(cleaned)].slice(0, MAX_NOTICES);
}

function findSnowEmergencyNotices(feed) {
  return extractNoticeTexts(feed).filter((text) => SNOW_EMERGENCY_PATTERN.test(text));
}

// What "already told you" is keyed on: the notice's own words, so a reworded notice (Day 2 has
// begun) is news and an unchanged one is not.
function noticeKey(text) {
  return crypto.createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 16);
}

// The command the author runs to confirm. The date is a guess (today, Minneapolis time) because the
// banner's wording is unknown: the email says to check it against the city's announcement.
function buildDeclareCommand(now = new Date()) {
  return `npm run snow -- declare --day1=${snow.localDateText(now)}`;
}

module.exports = {
  NOTICE_FEED_URL,
  extractNoticeTexts,
  findSnowEmergencyNotices,
  noticeKey,
  buildDeclareCommand
};

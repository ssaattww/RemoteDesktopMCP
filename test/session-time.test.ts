import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionTime } from "../src/session-time.js";

test("sub-minute timestamps show whole seconds on either side of a JST date rollover", () => {
  const now = Date.parse("2026-10-02T15:00:30.000Z");
  assert.equal(formatSessionTime("2026-10-02T14:59:31.000Z", now)?.relative, "59\u79d2\u524d");
  assert.equal(formatSessionTime("2026-10-02T14:59:30.001Z", now)?.relative, "59\u79d2\u524d");
  assert.equal(formatSessionTime("2026-10-02T14:59:30.000Z", now)?.relative, "\u6628\u65e5");
  assert.equal(formatSessionTime("2026-10-02T14:59:29.000Z", now)?.relative, "\u6628\u65e5");

  const beforeMidnight = Date.parse("2026-10-02T14:59:30.000Z");
  assert.equal(formatSessionTime("2026-10-02T15:00:29.999Z", beforeMidnight)?.relative, "59\u79d2\u5f8c");
  assert.equal(formatSessionTime("2026-10-02T15:00:30.000Z", beforeMidnight)?.relative, "明日");
  assert.equal(formatSessionTime("2026-10-02T15:00:31.000Z", beforeMidnight)?.relative, "明日");
});

test("second display truncates fractions and labels the present as zero seconds ago", () => {
  const now = Date.parse("2026-10-02T02:00:00.000Z");
  assert.equal(formatSessionTime("2026-10-02T01:59:59.000Z", now)?.relative, "1\u79d2\u524d");
  assert.equal(formatSessionTime("2026-10-02T01:59:59.500Z", now)?.relative, "0\u79d2\u524d");
  assert.equal(formatSessionTime("2026-10-02T02:00:00.000Z", now)?.relative, "0\u79d2\u524d");
  assert.equal(formatSessionTime("2026-10-02T02:00:01.500Z", now)?.relative, "1\u79d2\u5f8c");
});

test("same-day minute and hour boundaries truncate elapsed units", () => {
  const now = Date.parse("2026-10-02T02:00:00.000Z");
  assert.equal(formatSessionTime("2026-10-02T01:00:01.000Z", now)?.relative, "59分前");
  assert.equal(formatSessionTime("2026-10-02T01:00:00.000Z", now)?.relative, "1時間前");
  assert.equal(formatSessionTime("2026-10-02T00:59:59.000Z", now)?.relative, "1時間前");
  assert.equal(formatSessionTime("2026-10-02T03:00:00.000Z", now)?.relative, "1時間後");
});

test("calendar-day labels use JST and work in both directions", () => {
  const now = Date.parse("2026-10-02T15:00:30.000Z");
  assert.equal(formatSessionTime("2026-09-30T15:00:30.000Z", now)?.relative, "2日前");
  assert.equal(formatSessionTime("2026-10-04T15:00:30.000Z", now)?.relative, "2日後");
  assert.equal(formatSessionTime("2026-10-02T15:00:30.000Z", now)?.relative, "\u0030\u79d2\u524d");
});

test("invalid values do not produce relative or exact display data", () => {
  for (const value of [undefined, null, "", "—", "not-a-date", "2026-10-02T15:00:00", "2026-02-30T12:00:00Z"]) {
    assert.equal(formatSessionTime(value, Date.now()), undefined, String(value));
  }
});

test("valid offset timestamps return normalized ISO and exact JST text", () => {
  const display = formatSessionTime("2026-10-03T00:00:00+09:00", Date.parse("2026-10-03T00:00:30+09:00"));
  assert.ok(display);
  assert.equal(display.iso, "2026-10-02T15:00:00.000Z");
  const expected = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23",
  }).format(new Date(display.iso)) + " JST";
  assert.equal(display.exact, expected);
});

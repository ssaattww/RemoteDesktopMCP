import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionTime } from "../src/session-time.js";

test("the 60-second rule wins before a JST date rollover", () => {
  const now = Date.parse("2026-10-02T15:00:30.000Z");
  assert.equal(formatSessionTime("2026-10-02T14:59:31.000Z", now)?.relative, "たった今");
  assert.equal(formatSessionTime("2026-10-02T14:59:30.000Z", now)?.relative, "昨日");
  assert.equal(formatSessionTime("2026-10-02T14:59:29.000Z", now)?.relative, "昨日");

  const beforeMidnight = Date.parse("2026-10-02T14:59:30.000Z");
  assert.equal(formatSessionTime("2026-10-02T15:00:29.000Z", beforeMidnight)?.relative, "たった今");
  assert.equal(formatSessionTime("2026-10-02T15:00:30.000Z", beforeMidnight)?.relative, "明日");
  assert.equal(formatSessionTime("2026-10-02T15:00:31.000Z", beforeMidnight)?.relative, "明日");
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
  assert.equal(formatSessionTime("2026-10-02T15:00:30.000Z", now)?.relative, "たった今");
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

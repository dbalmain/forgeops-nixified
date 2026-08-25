// Drives the REAL timestamp parser from the task, not a copy of the rule.
//
// The discriminating case is the nanosecond timestamp: a plausible-but-wrong
// implementation (`new Date(value)`) agrees with the correct one on every
// millisecond input and differs only here — which is exactly the input PingIDM
// actually produces.
//
// Installed by `fo add example-stale-accounts`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseIdmTimestamp } from "../src/tasks/flag-stale-accounts.ts";

test("parses the nanosecond precision PingIDM actually writes", () => {
  const nanos = parseIdmTimestamp("2026-08-25T06:05:25.436265458Z");
  assert.ok(!isNaN(nanos), "nanosecond timestamps must not parse to NaN");
  assert.equal(nanos, Date.parse("2026-08-25T06:05:25.436Z"));
});

test("millisecond and second precision still parse", () => {
  assert.equal(
    parseIdmTimestamp("2026-08-25T06:05:25.436Z"),
    Date.parse("2026-08-25T06:05:25.436Z"),
  );
  assert.equal(
    parseIdmTimestamp("2026-08-25T06:05:25Z"),
    Date.parse("2026-08-25T06:05:25Z"),
  );
});

test("genuine rubbish is NaN, so the caller can fail safe", () => {
  assert.ok(isNaN(parseIdmTimestamp("not a date")));
});

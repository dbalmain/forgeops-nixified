import { strict as assert } from "node:assert";
import { test } from "node:test";
import { syncOutcome } from "../commands/sync.ts";

// The regression this file exists for: `syncIdm` used to return a boolean that
// meant BOTH "no running idm pod" and "nothing to copy". When the caller
// started acting on that return value, `fo sync data` began exiting 1 against
// a perfectly healthy stack — this checkout has no `platform/idm/data`, so
// that is the ordinary path, not an edge case. A command that fails on its own
// successful no-op is worse than the false success it replaced.
//
// "No pod" throws now; the no-op is a success; and retirement counts as work.

test("nothing to copy and nothing to retire is a no-op, not a failure", () => {
  assert.equal(syncOutcome(0, 0), undefined);
});

test("retiring files is work, even with nothing to copy", () => {
  // Deleting an endpoint's TypeScript and syncing pushes no files and removes
  // one. Reporting "nothing to sync" for that read as though the deletion had
  // not happened.
  assert.equal(syncOutcome(0, 1), "retired 1 file");
  assert.equal(syncOutcome(0, 3), "retired 3 files");
});

test("copying is reported, with and without retirement", () => {
  assert.equal(syncOutcome(1, 0), "synced 1 file");
  assert.equal(syncOutcome(4, 0), "synced 4 files");
  assert.equal(syncOutcome(2, 1), "synced 2 files, retired 1 file");
});

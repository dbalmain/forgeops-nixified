// A scheduled PingIDM job: find accounts nobody has touched lately and flag
// them, so a reviewer has a list instead of a hunch.
//
// Installed by `fo add example-stale-accounts`. `fo build` compiles it to ES5
// into platform/idm/script/, and schedule-flag-stale-accounts.json tells IDM
// to run it.
//
// It only ever WRITES A DESCRIPTION. Deactivating or deleting accounts from a
// scheduled job is how a bad query becomes an incident, so the destructive
// half is left for a human to do knowingly.
//
// Yours to change: `fo list` reports it as edited and never overwrites it.

import { defineTask } from "../../framework/task.ts";

/** How long an account may sit unmodified before it is flagged. */
const STALE_AFTER_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Stable prefix, so an already-flagged account is recognisable next run. */
const STALE_MARKER = "stale: unchanged since ";

/**
 * Parse a PingIDM timestamp, or return NaN.
 *
 * IDM writes NANOSECOND precision -- `2026-08-25T06:05:25.436265458Z` -- and
 * IDM's own script engine returns NaN for more than three fractional digits
 * (verified against a running IDM; the millisecond form parses fine). NaN then
 * fails every comparison, so `changed < cutoff` was FALSE and the account fell
 * through to being flagged. A job meant to flag nothing flagged everything,
 * and it looked like it was working.
 *
 * Exported so the test drives this function rather than a copy of the rule.
 */
export function parseIdmTimestamp(value: string): number {
  return new Date(value.replace(/(\.\d{3})\d+/, "$1")).getTime();
}

/**
 * `description` is `string | null`, not `string | undefined`. PingIDM returns
 * JSON null for a property that has been cleared, and an optional-property
 * type does not model that -- `description?: string` type-checks a
 * `!== undefined` guard that then throws
 * `Cannot call method "indexOf" of null` at runtime. Model the null.
 */
type ManagedUser = {
  _id: string;
  userName?: string;
  description?: string | null;
  _meta?: { lastChanged?: { date?: string } } | null;
};

export default defineTask({
  name: "flag-stale-accounts",
  description: "Flags managed users unchanged for " + STALE_AFTER_DAYS + " days",
  main: function () {
    const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * MS_PER_DAY);

    // Page rather than fetching every user: a scheduled job that loads the
    // whole directory into memory works fine in a demo and falls over in
    // production, which is the wrong place to find out.
    // `_fields` as a parameter rather than the three-argument form: that
    // overload types the field list against GENERATED managed-object types,
    // which this workspace does not have yet (they arrive with
    // `fo config export idm`). Until then the string form is the honest one.
    const found = openidm.query("managed/user", {
      _queryFilter: "true",
      _pageSize: 200,
      _fields: "_id,userName,description,_meta/lastChanged/date",
    }) as { result: ManagedUser[] };

    const flagged: Array<string> = [];
    for (let i = 0; i < found.result.length; i++) {
      const user = found.result[i] as ManagedUser;
      const changed = user._meta?.lastChanged?.date;
      if (changed === undefined) {
        continue;
      }
      const changedAt = parseIdmTimestamp(changed);
      // Fail SAFE on an unparseable date: not stale. The opposite default is
      // what made this job flag every account it could not read.
      if (isNaN(changedAt) || changedAt >= cutoff.getTime()) {
        continue;
      }

      // Match on the PREFIX, not the whole note. The note embeds the
      // timestamp, and writing it bumps lastChanged -- so comparing the whole
      // string never matches on a later run and the job re-flags the same
      // accounts forever. Only a SECOND run shows that.
      const existing =
        typeof user.description === "string" ? user.description : "";
      if (existing.indexOf(STALE_MARKER) === 0) {
        continue;
      }
      const note = STALE_MARKER + changed;

      openidm.patch("managed/user/" + user._id, null, [
        { operation: "replace", field: "/description", value: note },
      ]);
      flagged.push(user.userName ?? user._id);
    }

    logger.info(
      "flag-stale-accounts: checked " + found.result.length +
        ", flagged " + flagged.length,
    );
    return { checked: found.result.length, flagged: flagged };
  },
});

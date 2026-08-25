# example-stale-accounts

A scheduled PingIDM job, written in **TypeScript**, that flags accounts nobody
has touched in 90 days.

```text
src/tasks/flag-stale-accounts.ts  →  idm/script/flag-stale-accounts.js
                                     run nightly at 02:00 by IDM's scheduler
```

## Install

```sh
fo add example-stale-accounts
fo build && fo sync
```

Run it now rather than waiting for 02:00:

```sh
curl -k -X POST -H "Authorization: Bearer $(fo token)" \
  -H 'Content-Type: application/json' \
  -d '{"type":"text/javascript","file":"flag-stale-accounts.js"}' \
  'https://dev.localhost/openidm/script?_action=eval'
```

It returns `{"checked": N, "flagged": M}`, and each flagged user's
`description` says when it went quiet.

## What it demonstrates

- A **task**, as distinct from an endpoint: IDM invokes it by file, there is no
  routing and no `conf/endpoint-*.json`. Same TypeScript, same ES5 downlevel,
  same runtime bans.
- Paging (`_pageSize`) instead of loading every user — a job that fits in
  memory on a demo and does not in production is a bad example.

## Two deliberate restraints

- **It only writes a description.** Deactivating or deleting accounts from a
  scheduled job is how a slightly-wrong query becomes an incident. The
  destructive half is left for a human to do knowingly.
- **It skips accounts already flagged.** Re-writing the same note would bump
  `lastChanged` and make the account look fresh — the job would erase its own
  evidence and never flag anything twice running.

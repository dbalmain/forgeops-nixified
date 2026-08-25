# example-risk-login

A PingAM login journey whose routing decision is **TypeScript**, not a rule
typed into a console field.

```text
Sign in (username + password)  →  Data Store Decision  →  Risk check (TypeScript)
                                          │ false                │ low   → success
                                          ↓                      │ high  → failure
                                       failure
```

The Risk check node runs `risk-login-check.ts`, compiled to ES5 and deployed as
an amster `Scripts` entity. The rule is deliberately trivial — a username
starting `svc-` or `admin` takes the `high` outcome — so you can drive it by
hand and see the decision change.

## Install

```sh
fo add example-risk-login
fo build && fo amster
```

Then sign in at `https://<env>.localhost/am/XUI/?service=risk-login`, or drive
it over REST:

```sh
curl -k -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept-API-Version: resource=2.0, protocol=1.0' \
  'https://dev.localhost/am/json/realms/root/authenticate?authIndexType=service&authIndexValue=risk-login'
```

A user whose name starts with `svc-` is refused; anyone else gets a session.

## What it demonstrates

- A scripted decision node authored in TypeScript, with types for AM's
  bindings (`nodeState`, `action`, `logger`) rather than none at all.
- The script's AM id is **derived from its file name**, so re-importing is
  idempotent instead of creating a second copy each time.
- A shipped test (`tests/risk-login.test.mjs`) guarding the one coupling the
  build cannot see: the node references the script by that derived UUID, so
  renaming the script would silently dead-end the journey.

## Making it yours

Edit `risk-login-check.ts` — replace the prefix rule with whatever your risk
signal actually is. `fo list` will then report the file as **yours**, and no
`fo add`, `fo remove` or upgrade will touch it again.

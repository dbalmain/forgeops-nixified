# forgeops-nixified

A one-command local **Ping Identity Platform** stack — PingAM, PingIDM, PingDS
and the platform UIs — built on [ForgeOps](https://github.com/ForgeRock/forgeops)
2026.3, k3d and a nix flake.

```sh
cd forgeops-nixified
direnv allow      # or: nix develop
fo up             # stack running at https://dev.localhost
fo down
```

> **Development and evaluation only.** ForgeOps deployments are a sample, not a
> production deployment, and Ping's subscription terms govern use of the
> platform images regardless of the fact that they pull anonymously.

## What you need

**nix, and a Docker daemon.** That is the whole list. k3d needs a container
runtime, which is irreducible; everything else — kubectl, helm, k3d, stern,
Node — comes from the flake at pinned versions. `fo doctor` checks and tells
you exactly what is missing.

`fo` itself is TypeScript run directly by Node 24's type stripping: no build
step, no bundler, and **no npm dependencies at all**.

## Commands

| Command | Does |
| ------- | ---- |
| `fo up` | Bring the stack up. Idempotent — safe to re-run after a sleep or a failed pull. Exits non-zero if the stack is not ready when it returns; `--timeout 0` waits with no deadline. |
| `fo down` | Remove the environment. `--destroy` also deletes the cluster. |
| `fo status` | Pod readiness, plus workloads that produced no pod at all. Exits non-zero if anything is unready or missing, so it works as a gate. |
| `fo info` | URLs **and passwords**. `--json` for scripting. |
| `fo logs [COMPONENT]` | Live multi-pod tail. Extra args pass through to `stern`. |
| `fo logs search 'LOGSQL'` | Indexed search over history. Needs the log console. |
| `fo trace TRANSACTION_ID` | One login, time-ordered, across PingAM, PingIDM and PingDS. |
| `fo shell COMPONENT [-- CMD]` | Exec into a component's pod. |
| `fo doctor` | Preflight: docker, DNS, ports, memory, disk. |
| `fo doctor --engines` | Re-probe both script engines against `engine-surface.json`. Needs a running stack. |
| `fo token` | An OAuth2 access token for calling IDM's REST API. |

### The inner loop

| Command | Does |
| ------- | ---- |
| `fo dev` | Live session: watch `platform/` and apply each change. Uses Tilt's web UI when Tilt is present. |
| `fo watch` | The same loop with no Tilt. |
| `fo sync [conf\|script]` | Tier 1 by hand: push IDM config into the running pod. |
| `fo amster` | Tier 2 by hand: re-import amster config. |
| `fo restart COMPONENT` | Tier 3 by hand: roll a component. |

### TypeScript

| Command | Does |
| ------- | ---- |
| `fo build` | Compile `platform/typescript` into `platform/idm/` and `platform/amster/`. |
| `fo check` | Types, lint, tests, build. |
| `fo deps` | Re-lock `platform/typescript`'s dependencies after editing its package.json. |

### Round-trip and upgrade

| Command | Does |
| ------- | ---- |
| `fo config export idm` | Live IDM config -> `platform/idm/conf/`, minus everything identical to the stock image. |
| `fo config export am` | Live PingAM FBC -> `platform/am/config/`, through the config upgrader. |
| `fo config diff [am\|idm]` | Unified diff of live against the repo. Exits non-zero on drift, so CI can use it. |
| `fo upgrade [--check]` | Bump the pinned ForgeOps tree; report chart changes; verify every pinned image exists. |

### Packages

Examples are **installable**, not seeded — a fresh checkout is not full of
someone else's demo.

| Command | Does |
| ------- | ---- |
| `fo list` | What's installed, what's available, and what you've edited. |
| `fo add NAME [--force]` | Install an example into `platform/`. |
| `fo remove NAME` | Uninstall it, keeping anything you edited. |

```sh
fo add example-risk-login       # a login journey decided by TypeScript
fo add example-stale-accounts   # a scheduled TypeScript job
```

`fo` records the hash of every file it writes. A file that still matches is
`fo`'s to update or delete; a file you've changed is **yours**, and `fo add`
refuses to clobber it while `fo remove` leaves it behind and says so. `--force`
is the way back if you want the package's version again — it names every edit
it discards.


`COMPONENT` is one of `am idm ds-idrepo ds-cts amster admin-ui end-user-ui
login-ui`.

## Timings

Measured on a 22-core / 30 GB Linux box:

| | |
| --- | --- |
| First `fo up` (cold, pulls ~2.8 GB) | ~10 min |
| `fo up` warm | **~2 min** |
| `fo up` when already running | **~17 s** |
| Whole stack, actual memory | **~4.4 GiB** |
| …with the log console on (the default) | **~4.8 GiB** |

Inner loop, measured save-to-live:

| You edit | Mechanism | Measured |
| --- | --- | --- |
| `platform/idm/conf/**` | synced into the pod, file watcher reloads | **18 ms – 1.1 s** |
| `platform/idm/script/**` | same, plus a script recompile | **~1.1 s** |
| `platform/amster/config/**` | packed into a configMap, amster job re-runs | **~22 s** |
| `platform/am/config/**` | roll the PingAM pod | **~51 s** |

No pod restarts in the first two. The ~1 s floor is
`javascript.recompile.minimumInterval`, which `fo`'s dev profile already lowers
from ForgeOps' 60 s.

## Environments

`--env NAME` (default `dev`) is one flag that derives everything: the namespace,
the FQDN `NAME.localhost`, and the state directory `.fo/NAME/`. One k3d cluster,
many namespaces. If you never type it, you never see it.

The name must be a DNS-1123 label — lowercase letters, digits and hyphens,
starting and ending alphanumeric. That is what the namespace and the hostname
each require anyway, and it is enforced before anything is derived from it,
because the name also becomes a path that `fo down --destroy` deletes.

```sh
fo up --env feature-x     # https://feature-x.localhost
```

## Editing the platform

Everything you author lives in `platform/` and is version controlled:

```text
platform/typescript/src/endpoints/**  IDM custom endpoints, in TypeScript
platform/typescript/src/scripts/**    PingAM scripted nodes, in TypeScript
platform/idm/conf/**                  IDM config JSON      tier 1  — no restart
platform/amster/config/**             journeys, clients    tier 2  — job re-runs
platform/am/config/**                 AM file-based config tier 3  — image + roll
```

`platform/idm/script/` and `platform/idm/conf/endpoint-*.json` are **generated**
from the TypeScript and are gitignored — edit the `.ts`, never the output.

Run `fo dev`, save a file, and the right tier fires on its own.

**[`platform/AUTHORING.md`](platform/AUTHORING.md)** is the reference: the
framework API, the validators, the PingAM script surface, the managed-object
types, and the traps each product sets.

**An amster import replaces an entity, it does not merge into it.** Anything
you leave out of a JSON file reverts to the schema default, which is often
`null` — so a sparse OAuth2 client will work on first import and break on the
second, once your file has overwritten the defaults AM filled in. Spell out
every field you depend on, or let `fo config export am` write a complete one.

One demo is seeded so the loop is provable on a fresh clone —
`src/endpoints/hello.ts`, a typed IDM endpoint. Everything else is a package;
see `fo list`.

```sh
curl -k -H "Authorization: Bearer $(fo token)" \
  https://dev.localhost/openidm/endpoint/hello
```

### Calling IDM's REST API

IDM delegates authentication to AM, so the `openidm-admin` password is **not**
usable against `/openidm/**` — you get `authenticationId: anonymous` and a 403
that reads like an access-control problem. `fo token` gets you a real token.

## Writing TypeScript

Endpoints and AM scripts are TypeScript, compiled to ES5 and emitted where each
product expects them. `fo build` runs the whole pipeline:

```text
tsgo --noEmit  →  esbuild bundle (ES2020 IIFE)  →  Babel to ES5  →  runtime-ban lint
```

Two tools because neither does both: esbuild cannot target ES5, and Babel is not
a bundler. Nothing is emitted unless **every** step succeeds for **every**
entry point, so a broken build never leaves half-updated output for `fo sync`
to push.

What the types buy you: handler parameters are inferred from the validators, so
changing `v.integer({ max: 100 })` breaks the handler that relied on it at
compile time. The `lib` is pinned to what the script engine actually provides —
no `Proxy`, no `Reflect`, no `Array#flat` — so runtime-impossible code fails to
type-check. And you never subclass a native — `Error`, `Map`, `Array`, any of
them. That is measured rather than reasoned: Babel's `_wrapNativeSuper` was
probed on both live engines, and an `Error` subclass constructs but loses its
own `instanceof`, while a `Map` subclass does not construct at all. (The
tempting explanation — "`Reflect` is absent" — does not hold: the lowering
falls back to `Function#bind` and `Object.setPrototypeOf`, both present.) Two
natives failing two different ways is a policy boundary rather than proof about
every constructor, and it is treated as one. Use the tagged faults
(`badRequest`, `notFound`, …) instead, and compose rather than extend. `async`, `await` and generators are banned
too: an endpoint's response body is the script's completion value and an
AM node's outcome is read when `main` returns, so an unawaited Promise is all
the host would ever see — and Rhino has no event loop here to settle it. `fo build` rejects a native superclass by resolving it through the
compiler (so an alias or `globalThis.Error` does not slip past, and your own
class called `Map` is not caught by mistake); lint rejects the rest. The
generator ban is a support boundary rather than a measured failure — the
helpers are simply not in the probed corpus.

That `lib` is not guesswork, and the proof is exhaustive rather than
representative. `tools/engine-coverage.mjs` reads the lib files the tsconfigs
name and enumerates **every** declaration that carries a runtime value — 728 of
them — and `fo doctor --engines` probes all 728 on both engines, plus 15
behavioural cases and 24 deliberate out-of-pin checks (`Proxy`, `Object.hasOwn`,
Rhino's `java`/`Packages`): **767 probes each**. A test fails if the pin
promises something the probe never checked, which is what stops the measurement
quietly describing a subset of the lib. Both compilers in this package are
covered — `fo build` type-checks with `tsgo`, this analysis uses the
`typescript` package's compiler API, and they ship different copies of the same
lib files, so the manifest digests both and a test fails if their derived
surfaces stop agreeing.

**234 of those 728 are not there** on PingAM, 232 on PingIDM. Almost all of the
typed arrays (`Float32Array#map` and its siblings — Rhino ships only `get`,
`set` and `subarray`), plus `RegExp#flags`, `RegExp#sticky`,
`Date#[Symbol.toPrimitive]` and a dozen more. None of it can be removed from
the type system: `lib.es5` is monolithic, and declaration merging can add a
member but never subtract one. So the line is held at the **use site** instead
— `fo build` resolves the builtin references it can, in both programs, through
the compiler, before it emits anything, and fails if one is absent.
`new Float32Array(8).map(f)` is a build failure, not a `TypeError` in the
middle of somebody's login. Nothing is polyfilled (`useBuiltIns: false`), so
there is no third option.

What that check proves, exactly: property access, element access with a literal
or finite-union key, binding patterns (nested, renamed, parameters, computed
literal keys) and object destructuring assignment, plus well-known symbol
members. What it does not: `obj[key]` where `key` is a plain `string`, a
structural generic that has erased the concrete type, a non-shorthand key in an
array-pattern or `for...of` assignment position, and code inside a bundled
dependency (there are none today). The boundary is stated in
`tools/engine-usage.mjs` rather than papered over.

The behavioural half is generated, not written: `tools/emit-corpus.ts` goes
through the same esbuild-and-Babel pipeline an endpoint does, and the committed
result (`framework/engine-emit-probe.js`) is what the engines actually run. A
test fails if it drifts from the pipeline. The point is to exercise Babel's
real helpers — `_toConsumableArray`, `_objectSpread`, `_createForOfIteratorHelper`
— rather than a hand-written impression of them.

The data is in `framework/engine-surface.json`, what it covers is frozen in
`framework/engine-coverage.json` (a digest per lib file, for both compilers, so
a bump to either fails `fo build` until the engines are re-probed), and the original spike that started it
is in [spike/ENGINE-SURFACE.md](spike/ENGINE-SURFACE.md). `fo doctor --engines`
re-takes the measurement and exits non-zero if the engine has moved — worth
running after a ForgeOps upgrade, which is the one thing that can invalidate
the pin without touching a line of this repo. `--record` writes what it found
back.

PingAM scripts are a **separate TypeScript program** (`tsconfig.am.json`),
because AM and IDM declare colliding globals — both have a `logger`, and they
are not the same shape. They share a `lib`, and at 97 probes they looked
identical; at 767 they differ in two places (`Math` and `JSON` carry
`Symbol.toStringTag` on IDM and not on AM). Neither is used by anything here —
PingIDM code *could* legitimately use them, and PingAM code that tried would be
rejected — and the shared lib stays sound because each program is checked
against its own engine, not because the engines are the same object.

### Dependencies come from nix

`platform/typescript/node_modules` is a symlink into the nix store, built from
the committed `package-lock.json`. **`npm install` never runs on a developer
machine**, and `fo build` refuses to run if that symlink has been replaced by a
real directory.

To add a dependency, edit `package.json` and run `fo deps`. Doing it by hand
walks into three traps in a row, which is why the command exists: npm cannot
write into the read-only store, the flake stops evaluating the moment
package.json names something the lock lacks (so `nix develop` no longer works),
and npm exits non-zero on its allow-scripts warning even when the lock was
written correctly.

## Round-tripping config

Everything above pushes the repo at the stack. `fo config` is the other
direction: it pulls what a running stack actually has back into `platform/`,
which is how a change made in the admin UI or over REST becomes something you
can commit.

```sh
fo config diff            # what the live stack has that the repo does not
fo config export idm      # adopt it
fo config export am
```

**Only the delta is written.** PingIDM ships 52 config files; exporting all of
them would hand you 52 files to review on every upgrade, 50 of which you never
touched. So `fo` extracts the stock image's `conf/` once (cached under
`.fo/baseline/`), and writes only what differs. PingAM needs no baseline — its
`export.sh` already tars only the config the instance has written.

Two files are never exported: `system.properties` and `script.json`. `fo` owns
those in the dev config profile (file-install on, 1s script recompile), and an
exported copy would win over the generated one and silently pin the inner
loop's settings.

`managed.json` is the exception in the other direction: it is exported even
when it matches the stock image, because it is the input to
[managed-object types](#managed-object-types).

**The PingAM export runs the config upgrader**, in a container, twice — once
for the release's version rules and once for ForgeOps' `placeholders.groovy`,
which puts `%BASE_DN%`-style placeholders back where the live config holds
concrete values. One invocation applies one rule set; skipping the second bakes
this environment's DNs into the repo. `--no-upgrade` skips both, and says so.

**PingAM writes FBC files on its own.** Fourteen social-identity-provider
entries appeared minutes after a boot nobody had touched. They hold `_id` and
`_type` and no settings, so `fo config diff am` reports them and does not count
them as drift — but they are still exported, because a `DataStoreDecision` node
has exactly the same shape and there its existence *is* the configuration.
Filtering them out of the export deletes nodes from journeys; that was tried
and reverted.

Once `platform/am/config/` exists, `fo up` builds it into an `am_custom` image
and PingAM boots from it. That is the round trip closing: **export, deploy,
export again gives byte-identical files** (verified 2026-08-25 — a journey and
a scripted node survived a full pod replacement onto empty volumes with
`platform/amster/config` empty, so nothing but the FBC could have carried
them).

`platform/am/config/` is **not committed in this repo**, deliberately: a fresh
clone should get stock PingAM, not a snapshot of somebody else's. In your own
project it is exactly the thing to commit.

### Managed-object types

`fo build` generates `platform/typescript/src/generated/managed.ts` from
`platform/idm/conf/managed.json` — one interface per managed object, keyed into
the `ManagedObjects` seam the framework declares empty. That is what makes

```ts
const user = openidm.read("managed/user/" + id, null, ["userName", "mail"]);
```

return a typed object with checked field names rather than an index-only
`CrestResource`.

Optional properties are typed `T | null`, not `T`. PingIDM returns JSON `null`
for a property that has been cleared, so `description?: string` type-checks a
guard that then throws — a real defect found against a live stack, and the
reason the generated types look pessimistic.

The generated file is committed, so a fresh clone type-checks without a
cluster, and a test fails if it drifts from `managed.json`.

## Upgrading

```sh
fo upgrade --check    # verify the current pin, change nothing
fo upgrade            # bump forgeops-src, then verify
```

`fo upgrade` answers the two questions that decide whether a new pin will
install at all:

- **Did the chart gain an image key `fo` has no decision about?** Such a key
  keeps the chart's `latest`, which is a different build from the rest of the
  stack. `fo` fails loudly instead.
- **Does every image `fo` pins actually exist?** Seventeen registry probes, run
  concurrently. The Phase 0 spike lost an afternoon to
  `dockette/ssh:2026.3.0-1849` not existing, a failure that surfaced four steps
  later as PingAM stuck in `FailedMount`. This is that check.

When the pin actually moves it also diffs the two charts and names what
changed. Pointed at 2026.2 for a test it reported, correctly, that
`keystore_create.image` and `ds_snapshot.image` use a different repository
there, that `ssh_keygen` does not exist, and that the `pingone` and
`ssh_keygen` top-level value keys are absent — which is the whole list of
things that would have made `fo`'s generated values silently wrong.

It does **not** update `RELEASE` in `tools/fo/config.ts` — the image tag is set
by hand because the chart and the docs disagree about it (see PLAN.md) — so it
says so and leaves it to you.

## The log console

On by default. `fo up` deploys VictoriaLogs and a Vector DaemonSet — about
250 Mi together — and `fo info` prints the console URL.

The whole stack measures ~4.4 GiB actual and ~4.8 GiB with the console, so
this is not what decides whether a 16 GB laptop copes. If yours is the exception, one line turns it off:

```ts
logs: "off",
```

| | |
| --- | --- |
| Web UI | `https://<env>.localhost/logs/` |
| Search | `fo logs search 'component:=am AND error'` |
| Trace | `fo trace <transactionId>` |

### `fo trace` is the point

PingAM, PingIDM and PingDS all write structured JSON audit events to stdout
already. The thing that is hard to get is one login as a single list:

```console
$ fo trace fo-trace-ds-4

fo-trace-ds-4  7 events across am, ds-idrepo, idm

13:02:37.182  am        AM-LOGIN-MODULE-COMPLETED /0  Authentication SUCCESSFUL ["idm-resource-server"]
13:02:37.182  am        AM-LOGIN-COMPLETED /0  Authentication SUCCESSFUL id=idm-resource-server,ou=agent,ou=am-config
13:02:37.187  ds-idrepo DJ-LDAP /0/1  SUCCESSFUL SEARCH ou=idm-provisioning,...,ou=am-config uid=am-config,ou=admins,ou=am-config
13:02:37.189  ds-idrepo DJ-LDAP /0/2  SUCCESSFUL SEARCH ou=idm-provisioning,...,ou=am-config uid=am-config,ou=admins,ou=am-config
13:02:37.190  am        AM-ACCESS-OUTCOME /0  OAuth SUCCESSFUL POST https://am/am/oauth2/introspect id=idm-resource-server,...
13:02:37.205  ds-idrepo DJ-LDAP /1  SUCCESSFUL SEARCH ou=people,ou=identities uid=admin
13:02:37.221  idm       access  SUCCESSFUL QUERY GET https://dev.localhost/openidm/managed/user idm-provisioning
```

That is one PingIDM query, and it reads left to right: IDM asked AM to
introspect its token, AM looked the client up in DS twice, then IDM searched DS
for the users.

Send your own id and every component will use it:

```sh
curl -k -H "X-ForgeRock-TransactionId: my-trace-1" \
     -H "Authorization: Bearer $(fo token)" \
     "https://dev.localhost/openidm/managed/user?_queryFilter=true"
fo trace my-trace-1
```

The `/0`, `/0/1`, `/1` suffixes are sub-transactions: a downstream call
**extends** the id rather than reusing it, so `fo trace` matches by prefix.
Searching for the exact id would return the entry point and drop every call it
made.

For this to work at all, the components have to believe the header. `fo` sets
`PLATFORM_TRUST_TRANSACTION_HEADER=true` on all of them; each one reads the
same placeholder (`org.forgerock.http.TrustTransactionHeader` in PingAM and
PingIDM, `ds-cfg-trust-transaction-ids` in PingDS). Without it each component
mints its own root id and nothing correlates.

### What gets shipped, and what does not

Two knobs, both set from measurement rather than intuition:

- **Kubelet health probes are dropped** (`includeHealthChecks: true` keeps
  them). On a 13-hour-old stack they were **99% of login-ui's log lines and
  96% of admin-ui's**. Keeping them means a console that mostly shows
  Kubernetes talking to itself.
- **PingDS logs everything**, which is *not* what ForgeOps ships
  (`dsAccessDetail: "filtered"` restores that). Upstream filters PingDS's
  console access logger to four criteria — administrative requests, auth
  failures, requests over 1000 ms, and misbehaving clients — so it wrote
  **18 KB where each UI pod wrote 1.4 MB**. Quiet, and the right default on a
  server nobody is watching. It is the wrong one here: a *healthy* login
  produces no DS output at all, so the DS leg of a trace is empty exactly when
  nothing is wrong. Unfiltered costs roughly **8 KB of DS output per PingIDM
  REST call**.

The collector reads from the **tail** of each log file, so the console covers
"from when you turned it on" rather than re-ingesting the node's backlog.
(It has to: reading from the beginning on a stack that had been up 13 hours
OOM-killed the collector inside one second.)

### Why VictoriaLogs

Measured against the Rust alternatives with 50,000 ForgeRock-shaped audit
events, one container each:

| | Language | Licence | Image | Idle RSS | Query |
| --- | --- | --- | --- | --- | --- |
| **VictoriaLogs 1.52** | Go | Apache-2.0 | **13 MB** | **3.4 MiB** | 11 ms |
| Quickwit 0.9 | Rust | Apache-2.0 | 103 MB | 26 MiB | 7 ms |
| Parseable 2.8 | Rust | AGPL-3.0 | 79 MB | 37 MiB | 22 ms |
| OpenObserve 0.92 | Rust | AGPL-3.0 | 143 MB | 254 MiB | 21 ms |

All four found the target events and ship a web UI. VictoriaLogs wins on the
axis that binds a laptop, needs no schema, and — unlike OpenObserve, which
lowercases every field name — leaves `transactionId` spelled the way PingAM
spells it. Quickwit wants an index and a doc mapping up front and wrote 284 MB
for 14.5 MB of input; it is built for object storage at a scale this is not.

## Passwords are stable

Every password is derived from a per-environment seed in `.fo/<env>/seed`
(gitignored), so `fo down && fo up` gives you the *same* credentials and your
bookmarks keep working. Copy that one file to reproduce an environment
elsewhere.

This is also a correctness fix, not just a convenience: the chart's own
generator produces random alphanumerics that PingDS's dictionary validator
rejects roughly half the time, and because the chart reads back any existing
Secret the bad password is sticky and the deployment never converges. `fo`
derives passwords that cannot contain a dictionary word by construction. See
`spike/RESULTS.md`.

## Configuration

One file, `fo.config.ts`. Every field is optional.

```ts
import { defineStack } from "./tools/fo/config.ts";

export default defineStack({
  components: ["am", "idm", "ds-idrepo", "ds-cts", "amster",
               "admin-ui", "end-user-ui", "login-ui"],
  fqdnTemplate: "{env}.localhost",
  dsDiskSize: "10Gi",

  // On by default. A bare string is shorthand for `{ backend: "..." }`,
  // so `logs: "off"` is the whole opt-out.
  logs: {
    backend: "victorialogs",
    includeHealthChecks: false,   // kubelet probe traffic
    dsAccessDetail: "full",       // "filtered" restores upstream's quiet PingDS
    retention: "7d",
    diskSize: "5Gi",
  },
});
```

If `*.localhost` does not resolve on your machine (notably macOS), set
`fqdnTemplate: "{env}.127.0.0.1.nip.io"`, which needs no local DNS config and
no `sudo`.

## Renaming `fo`

```sh
# .envrc
export FO_ALIAS=fops
```

A symlink, not a shell alias, so it works under direnv, `nix develop` and CI
alike.

## Where things are

```text
flake.nix            pins ForgeOps, the Helm chart, and every tool
fo.config.ts         the stack's shape
tools/fo/            the CLI (TypeScript, no build step)
tools/fo/tests/      its tests, run by `fo check`
platform/            what you author: IDM conf and scripts, AM config, amster
platform/AUTHORING.md  the authoring reference
.github/workflows/   check.yml on every push; e2e.yml stands the stack up nightly
spike/               Phase 0 evidence, the engine-surface findings, reference artefacts
PLAN.md              the design, decisions and roadmap
.fo/<env>/           gitignored per-env state: seed, kubeconfig, values.json
.fo/baseline/        gitignored: the stock image config `fo config` diffs against
```

## Status

All phases of [PLAN.md](PLAN.md) are done, plus a Phase 6 that closed the last
correctness gap — the pinned `lib` is now measured against both script engines
rather than assumed. A developer can **get** a stack,
**change** it, **write typed code against it**, **install examples**, **pull
live config back into the repo**, and **follow one login across all three
components** — with CI that runs the gates on every push and stands the whole
stack up nightly.

Caveats worth stating plainly:

- **This is a dev and evaluation stack.** Images pull anonymously, but Ping's
  subscription terms govern use. Nothing here is a production path.
- `fo upgrade` does not re-seed managed files (`framework/`, `tools/`,
  the tsconfigs). It cannot: `fo` and the workspace are the same tree here, so
  there is nothing to copy from. That becomes real with `fo init`, which would
  create a workspace separate from the tool; the content-hash machinery it
  needs already exists in `.fo/packages.lock`.
- `fo upgrade` does not WRITE `RELEASE` in `tools/fo/config.ts`, though it does
  now check it: the registry lists tags anonymously, so `fo upgrade` warns when
  a newer build of the pinned release exists and errors when the pinned tag
  belongs to a different release than the chart. `RELEASE.productVersion` is
  still by hand, because the chart (`2026.3.0-1849`) and the docs (`8.1.1`)
  name different builds and `am-config-upgrader` is published under the second
  scheme and not the first.
- There is no CSV-feed example. The PingIDM image ships only a **cloud** CSV
  connector (`storageType` accepts `Google`, `AWS` or `Azure` — there is no
  local-file mode), so an offline CSV example would need a cloud bucket or a
  Groovy scripted connector.
- `e2e.yml` has now run on GitHub, and the two risks this caveat used to name
  were both false alarms: the whole job takes **12 minutes** against its
  60-minute cap, `fo up` accounting for 9m35s, and disk peaks well inside the
  36 GB free after the reclaim step. What it did find is unexplained: the very
  first run failed with cert-manager's webhook not Available after 5 minutes,
  while the second took **25 seconds** for the same install — and a cold local
  cluster takes 31. So that step is intermittent on GitHub's infrastructure for
  reasons we have not established, and the nightly will eventually go red on it
  again. The diagnostics step now dumps the whole cluster rather than one
  namespace, which is what makes the next occurrence readable.
- `fo` sets `PLATFORM_TRUST_TRANSACTION_HEADER=true` on every component, which
  is what makes `fo trace` work at all. It means the stack believes a
  client-supplied `X-ForgeRock-TransactionId`. Fine here; in production you
  would only do that behind a gateway that strips the header at the edge.


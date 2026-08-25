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
| `fo up` | Bring the stack up. Idempotent — safe to re-run after a sleep or a failed pull. |
| `fo down` | Remove the environment. `--destroy` also deletes the cluster. |
| `fo status` | Pod readiness. |
| `fo info` | URLs **and passwords**. `--json` for scripting. |
| `fo logs [COMPONENT]` | Live multi-pod tail. Extra args pass through to `stern`. |
| `fo shell COMPONENT [-- CMD]` | Exec into a component's pod. |
| `fo doctor` | Preflight: docker, DNS, ports, memory, disk. |
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
tsc --noEmit  →  esbuild bundle (ES2020 IIFE)  →  Babel to ES5  →  runtime-ban lint
```

Two tools because neither does both: esbuild cannot target ES5, and Babel is not
a bundler. Nothing is emitted unless **every** step succeeds for **every**
entry point, so a broken build never leaves half-updated output for `fo sync`
to push.

What the types buy you: handler parameters are inferred from the validators, so
changing `v.integer({ max: 100 })` breaks the handler that relied on it at
compile time. The `lib` is pinned to what the script engine actually provides —
no `Proxy`, no `Reflect`, no generators — so runtime-impossible code fails to
type-check. And you never subclass `Error`: `Reflect` is absent, which makes
Babel's `_wrapNativeSuper` break `instanceof` silently. Use the tagged faults
(`badRequest`, `notFound`, …) instead; a lint rule rejects the alternative.

PingAM scripts are a **separate TypeScript program** (`tsconfig.am.json`),
because AM and IDM declare colliding globals — both have a `logger`, and they
are not the same shape.

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
platform/            what you author: IDM conf and scripts, AM config, amster
spike/               Phase 0 evidence and the working reference artefacts
PLAN.md              the design, decisions and roadmap
.fo/<env>/           gitignored per-env state: seed, kubeconfig, values.json
.fo/baseline/        gitignored: the stock image config `fo config` diffs against
```

## Status

Phases 1–4 of [PLAN.md](PLAN.md): a developer can **get** a stack, **change**
it, **write typed code against it**, **install examples**, and **pull live
config back into the repo**. Still to come: the log console (Phase 4.5), docs
and CI (Phase 5).

Caveats worth stating plainly:

- **This is a dev and evaluation stack.** Images pull anonymously, but Ping's
  subscription terms govern use. Nothing here is a production path.
- `fo upgrade` does not re-seed managed files (`framework/`, `tools/`,
  the tsconfigs). It cannot: `fo` and the workspace are the same tree here, so
  there is nothing to copy from. That becomes real with `fo init`, which would
  create a workspace separate from the tool; the content-hash machinery it
  needs already exists in `.fo/packages.lock`.
- `fo upgrade` does not set `RELEASE` in `tools/fo/config.ts`. The image tag is
  chosen by hand because the chart (`2026.3.0-1849`) and the docs (`8.1.1`)
  name different builds, and `am-config-upgrader` is published under the second
  scheme and not the first. It reports and leaves the choice to you.
- There is no CSV-feed example. The PingIDM image ships only a **cloud** CSV
  connector (`storageType` accepts `Google`, `AWS` or `Azure` — there is no
  local-file mode), so an offline CSV example would need a cloud bucket or a
  Groovy scripted connector.
- `tsconfig.am.json` inherits `lib` from the PingIDM program. That list has not
  been verified against PingAM's script engine, so it may permit a method AM
  does not have.

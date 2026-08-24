# forgeops-local — plan

A one-command, nix-only local Ping Identity Platform (on-prem / ForgeOps)
stack, with a TypeScript authoring workflow for everything a developer writes.

```sh
cd forgeops && fo up      # stack running
fo down                   # stack gone
```

Status: **plan for review**. Nothing is built yet. Decisions taken so far are
recorded in [Decisions](#decisions); open questions are flagged inline as
**[OPEN]**.

---

## 1. What we're targeting

Verified against the `identity-platform-2026.3.0` tag of
[ForgeRock/forgeops](https://github.com/ForgeRock/forgeops) and the
[2026.3 docs](https://docs.pingidentity.com/forgeops/2026.3/index.html), on
2026-08-25.

| Thing               | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| ForgeOps release    | 2026.3.0                                                                  |
| Platform version    | PingAM/PingDS/PingIDM **8.1.1**                                           |
| Images              | `us-docker.pkg.dev/forgeops-public/images/{am,idm,ds,amster,*-ui}`        |
| Image architectures | linux/amd64 **and** linux/arm64                                           |
| Image auth          | **none** — anonymous pull works                                           |
| Helm chart          | `identity-platform` 2026.3.0 from `https://ForgeRock.github.io/forgeops/` |

Four findings from reading the repo shape the whole design:

1. **2026.3 added native Helm-generated secrets.**
   `charts/identity-platform/values-helm-generate-secrets.yaml` drives
   `platform-secrets.yaml`, which does `lookup` on the existing Secret and only
   falls back to `randAlphaNum`. That means **no secret operator is needed**
   (secret-agent and secret-generator both drop out) and passwords are **stable
   across redeploys** — a `helm upgrade` re-reads what's already there. For a
   dev stack this is exactly right.

2. **`forgeops prereqs` now defaults to Traefik**, not nginx. k3s ships Traefik
   as its default ingress. The chart already carries Traefik sticky-cookie
   service annotations.

3. **`FORGEOPS_DATA`** (`lib/python/utils.py:554`, `bin/commands/common.sh:178`)
   splits the forgeops CLI from the tree it writes into. That is the seam that
   lets the CLI sit read-only in the nix store while `helm/`, `kustomize/` and
   `docker/` live in this repo.

4. **Config profiles are separate busybox images since 2026.1**, copied by an
   init container into an `emptyDir` that the app container mounts. For IDM that
   emptyDir lands on `/opt/openidm/conf`, `/script` and `/ui`
   (`charts/identity-platform/templates/idm-deployment.yaml`), and IDM runs with
   `OPENIDM_CONFIG_REPO_ENABLED: "false"` — pure file-based config. So a file
   synced into a running IDM pod should hot-reload. That is the fast inner loop.
   AM's equivalent (`/home/forgerock/openam`) is read at **startup only**.

Every tool ForgeOps validates is in nixpkgs at effectively the validated
version:

| Tool      | Ping validates | nixpkgs |
| --------- | -------------- | ------- |
| kustomize | 5.8.1          | 5.8.1   |
| kubectx   | 0.11.0         | 0.11.0  |
| minikube  | 1.38.1         | 1.38.1  |
| kubectl   | 1.36.1         | 1.36.3  |
| Helm      | 4.2.0          | 4.2.4   |
| jq        | 1.8.1          | 1.8.2   |

Plus `k3d` 5.9.0, `tilt` 0.37.6, `nodejs_24` 24.19.0.

---

## 2. Decisions

Taken 2026-08-25.

| #   | Decision                                                                        | Rationale                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **k3d** as the local Kubernetes runtime                                         | ~20s cluster create; bundles Traefik (2026.3's default ingress) and local-path storage; maps `:80`/`:443` to the host so there is **no `minikube tunnel` daemon** to babysit; single nix binary. Cost: not Ping-validated. |
| D2  | **Bypass the `forgeops` CLI**; keep it as an escape hatch                       | Drive the upstream Helm chart directly. `fo` generates values from a typed config; the thin bits (info, export, amster) are `kubectl exec` wrappers we own in TypeScript. Removes python and bash from the hot path.       |
| D3  | **TypeScript for scripts and endpoints now**; typed config later                | Port the `pingone-aic-manager` framework. IDM `conf/*.json` and AM FBC stay JSON, round-tripped by export.                                                                                                                 |
| D4  | Stack = **AM, IDM, DS (idrepo + cts), amster, admin-ui, end-user-ui, login-ui** | IG designed for but not built.                                                                                                                                                                                             |
| D5  | **Multiple named envs, at zero cost to people who don't use them**              | One flag, `--env NAME`, default `dev`. See §7.                                                                                                                                                                             |
| D6 | **Keep Tilt, but make it replaceable** | Tilt is actively maintained (v0.37.7, 2026-08-15; 8 releases in 2026, still fixing `live_update` edge cases). Rebuilding `live_update` alone is 6-12 months. Tilt's costs are coupling, not capability, and coupling is fixable - see section 10. |
| D7 | **Log console: tiered, default off** | Tier 0 (Tilt pane + `stern`) always on; VictoriaLogs opt-in via one line of `fo.config.ts`. RAM is the binding constraint. See section 9. |
| D8 | **A package repository of optional examples** | `platform/` ships empty; examples are installable packages (`fo add <pkg>`), not seed content. See section 8.1. |

---

## 3. Architecture

```
                          fo up
                            │
      ┌─────────────────────┼─────────────────────┐
      ▼                     ▼                     ▼
  ensure cluster       ensure prereqs         tilt up
  (k3d, 1 node)        cert-manager             │
  Traefik built in     selfsigned Issuer        │
  :80/:443 → host      `fast` StorageClass      │
                                                ▼
                              ┌─────────────────────────────────┐
                              │  helm upgrade --install         │
                              │    identity-platform 2026.3.0   │
                              │      values.yaml      (chart)   │
                              │    + values-helm-generate-      │
                              │        secrets.yaml   (chart)   │
                              │    + values.gen.yaml  (fo)      │
                              └─────────────────────────────────┘
                                                │
                     ┌──────────────┬───────────┼───────────┬──────────────┐
                     ▼              ▼           ▼           ▼              ▼
                 am (1)         idm (1)   ds-idrepo(1)  ds-cts(1)    3 × UI pods
                 1800Mi         1280Mi      1366Mi       1366Mi       100Mi ea
```

Pod memory requests total **≈6.5 GB**; add ~1 GB for k3s and cert-manager.
The chart's own `values.yaml` is already single-instance sized, so we need no
`--single-instance` equivalent — we layer on top of the defaults.

### The three-tier inner loop

This is the "update it easily" half of the brief, and it is the part that
justifies Tilt.

| You edit                                                         | Mechanism                                                                                                                                                              | Turnaround      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `platform/idm/conf/**.json`, `platform/typescript/src/**`        | Tilt `live_update` syncs the built artefact into `/opt/openidm/conf` and `/opt/openidm/script` in the running pod. IDM's file-install watcher reloads. **No restart.** | target **< 5s** |
| `platform/amster/config/**` (journeys, OAuth2 clients, services) | Re-run the amster Job                                                                                                                                                  | ~60s            |
| `platform/am/config/**` (AM file-based config)                   | Rebuild the `am-config` busybox image, roll the AM pod                                                                                                                 | ~2 min          |

AM being slow is acceptable because AM config is normally _exported from the
console_, not hand-edited — `fo config export am` pulls it back into the repo.

**[OPEN — the single biggest technical assumption in this plan.]** IDM
hot-reload of `conf/` and `script/` from a `live_update` sync is inferred from
`OPENIDM_CONFIG_REPO_ENABLED: "false"` plus IDM's Felix file-install defaults.
It is **not yet verified**. Phase 0 proves or disproves it. If it turns out
false, the IDM tier degrades to the amster tier (restart the pod, ~45s) and the
loop is worse but not broken.

### Startup seed vs fast path

The chart seeds config from a busybox `*_custom` image via an init container.
We keep that mechanism intact rather than fighting it:

- **Startup**: `fo`/Tilt builds `am-config` and `idm-config` busybox images
  (a `COPY` of the profile — sub-second builds) into the k3d registry, and
  points `am_custom.image` / `idm_custom.image` at them.
- **Steady state**: Tilt `live_update` bypasses the image entirely and syncs
  into the running container.

Both paths read the same files in `platform/`, so they cannot drift.

---

## 4. Repository layout

```text
forgeops/
  flake.nix flake.lock .envrc     # the only entry point; `use flake`
  fo.config.ts                    # THE file a developer edits to shape the stack
  Tiltfile                        # thin — delegates to `fo tilt:*` subcommands

  tools/fo/                       # the `fo` CLI, TypeScript, no build step
    main.ts
    commands/{up,down,status,logs,shell,config,export,doctor,upgrade,tilt}.ts
    cluster/k3d.ts                # cluster lifecycle (the D1 seam)
    prereqs/{cert-manager,storage}.ts
    values/                       # fo.config.ts -> values.gen.yaml
    k8s/                          # thin typed kubectl / helm wrappers
    secrets.ts                    # read back the Helm-generated secrets

  platform/                       # everything a developer authors — version controlled
    am/config/                    # AM FBC profile (EXPORTED, not hand-written)
    amster/config/                # amster JSON: journeys, OAuth2 clients, services
    idm/conf/                     # IDM file-based config JSON
    idm/script/                   # GENERATED from typescript/  (gitignored)
    typescript/                   # ported from pingone-aic-manager
      framework/                  # MANAGED  routing, validation, logging, errors, OpenAPI
      tools/build.mjs             # MANAGED  esbuild -> Babel ES5 -> runtime-ban lint
      src/endpoints/              # YOURS    one file per IDM custom endpoint
      src/scripts/                # YOURS    IDM + AM scripts
      src/shared/                 # YOURS    shared modules, bundled at build time
      tests/

  .fo/                            # gitignored per-developer state
    <env>/values.gen.yaml  <env>/kubeconfig  <env>/state.json

  docs/
```

`platform/` is the deliverable a team version-controls and reviews. Everything
else is machinery.

### Managed / seeded / yours

Straight from `pingone-aic-manager`'s `workspace update` model, because it
works: `framework/` and `tools/` are **managed** (rewritten by `fo upgrade`,
content-hashed so a file you edited is never clobbered silently), `src/` is
**seeded once**, `platform/*/config` is **yours**.

---

## 5. The nix flake

The whole "nix is all you need" claim rests on this.

```nix
inputs = {
  nixpkgs.url    = "github:NixOS/nixpkgs/nixos-unstable";
  forgeops-src   = { url = "github:ForgeRock/forgeops/identity-platform-2026.3.0";
                     flake = false; };
};
```

Outputs:

- **`devShells.default`** — k3d, kubectl, helm, kustomize, jq, nodejs_24, tilt,
  docker-client, `forgeops` (wrapped), and `fo` on `PATH`.
- **`packages.fo`** — the CLI. Node 24 runs the TypeScript **directly** via
  native type stripping — no tsc, no bundler, no build step, exactly as
  `pingone-aic-manager`'s endpoint tests do. Wrapped with the store paths of the
  pinned chart, the forgeops source, and `node_modules`.
- **`packages.node-modules`** — built by nix from a committed lockfile, so
  **`npm install` never runs on a developer machine**. This is what keeps the
  "nix and nothing else" promise honest.
- **`packages.forgeops`** — the upstream CLI, wrapped. `forgeops configure`'s
  pip/venv dance is replaced by a nix python env plus a generated
  `lib/dependencies/.configured_version` marker containing the sha1 of
  `requirements.txt` that `ensure_configuration_is_valid_or_exit.py` demands.
  **pip never runs.** Reachable as `fo forgeops …`.
- **`apps.default`** — so `nix run github:…/forgeops -- up` works with no
  checkout and no direnv.

`.envrc` is one line, `use flake`. direnv is a recommendation, not a
requirement: `nix develop -c fo up` is the fallback.

### The `fo` name

`fo` goes on `PATH` from the devShell **ahead of** anything already installed,
so inside this directory `fo` is unambiguously this tool. For anyone who wants a
different name, the devShell's `shellHook` reads `FO_ALIAS` and materialises
`.fo/bin/$FO_ALIAS` as a symlink to `fo`, with `.fo/bin` prepended to `PATH`:

```sh
# .envrc
use flake
export FO_ALIAS=fops   # optional; `fops` now works alongside `fo`
```

A symlink rather than a shell alias, because direnv exports environment, not
shell functions — so this works identically under `direnv`, `nix develop`, and
a non-interactive CI shell.

**Host prerequisites: nix, and a Docker daemon.** k3d needs a container
runtime; that is irreducible. `fo doctor` checks for it and says exactly what to
install if it's missing.

---

## 6. The `fo` CLI

TypeScript throughout. Node 24 from nix, type-stripping only.

| Command                                        | Does                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `fo up [--env NAME]`                           | doctor → ensure cluster → ensure prereqs → generate values → `tilt up`. Idempotent; safe to re-run. |
| `fo down [--env NAME]`                         | `tilt down` + delete the namespace. `--destroy` also deletes the k3d cluster.                       |
| `fo status`                                    | pods, readiness, URLs                                                                               |
| `fo info`                                      | URLs **and passwords**, read back from the Helm-generated secrets                                   |
| `fo logs <component>` / `fo shell <component>` | ergonomic `kubectl`                                                                                 |
| `fo config export am\|idm`                     | pull live config out of the pod back into `platform/`                                               |
| `fo config diff`                               | what's running vs what's committed                                                                  |
| `fo doctor`                                    | docker up, ports 80/443 free, RAM/disk headroom, FQDN resolution                                    |
| `fo upgrade`                                   | bump ForgeOps/platform version; re-seed managed files, report drift                                 |
| `fo forgeops …`                                | escape hatch to the wrapped upstream CLI                                                            |
| `fo add\|list\|remove <pkg>` | install / inspect / remove an example package (section 8.1) |
| `fo logs search '<query>'` | search indexed logs; requires tier 1 (section 9) |
| `fo trace <transactionId>` | merged, time-ordered events across AM, IDM and DS |
| `fo build\|deploy\|sync\|watch` | the primitives Tilt drives, each usable with Tilt not running (section 10) |

`fo up` is a **fully idempotent converge**, not a script — every step checks
before acting, so re-running after a laptop sleep or a failed pull is the normal
recovery, not a reinstall.

### Configuration

One typed file, `fo.config.ts`, is the entire surface:

```ts
import { defineStack } from "./tools/fo/config.ts";

export default defineStack({
  release: "2026.3.0", // ForgeOps release; pins chart + image tags
  components: [
    "am",
    "idm",
    "ds-idrepo",
    "ds-cts",
    "amster",
    "admin-ui",
    "end-user-ui",
    "login-ui",
  ],
  // everything below is optional and defaulted
});
```

Types are generated from the pinned chart's `values.yaml` at flake-build time,
so a values key that ForgeOps renames becomes a **compile error at `fo up`**,
not a silent no-op at `helm upgrade`. The chart ships no `values.schema.json`,
so we derive the shape from the YAML.

---

## 7. Multiple environments, at zero cost

D5's constraint was "nice, if it adds no complexity for people who don't need
it". The way to honour that is to make the env name a **single derived
variable** and never surface it anywhere else.

`--env NAME` (default `dev`) derives, and derives nothing else:

- namespace `NAME`
- FQDN `NAME.localhost`
- Tilt port `10350 + offset(NAME)`
- state dir `.fo/NAME/`

**One k3d cluster** (`fo`), many namespaces. A developer who never types
`--env` sees the word "dev" in a URL and nowhere else. `fo up`, `fo down`,
`fo info` are unchanged.

### FQDN and TLS

**[OPEN]** `*.localhost` resolves to 127.0.0.1 on systemd/glibc hosts (NixOS,
most Linux) but **not on macOS**. Plan: default to `<env>.localhost`, have
`fo doctor` actually resolve it, and fall back to `<env>.127.0.0.1.nip.io`
(needs public DNS, no `/etc/hosts`, no sudo) when it doesn't. `--fqdn`
overrides. Editing `/etc/hosts` needs sudo and is therefore ruled out as a
default.

cert-manager issues a self-signed cert, so browsers warn. `fo info` prints the
CA and `fo trust` will offer to install it; accepting the warning is the
documented default. No mkcert dependency.

---

## 8. TypeScript authoring (D3)

Port `pingone-aic-manager`'s `workspace/sandbox/typescript` framework. It
already solves this exact problem for a Rhino script engine with no module
system, and every constraint it encodes applies here — IDM on-prem 8.1.1 is the
same engine as AIC's.

Carried over intact:

- **Build**: `tsc --noEmit` → esbuild bundle (ES2020 IIFE) → Babel
  `preset-env targets: {ie:"11"}` to ES5 → lint the _generated_ file against
  IDM's runtime bans. All-or-nothing publication by atomic rename.
- **The runtime bans**: default parameters, `const` in a loop init, trailing
  comma in a parameter list, bare `Reflect`, bare `Proxy`.
- **Never subclass `Error`** — `Reflect` is absent, so Babel's
  `_wrapNativeSuper` silently breaks `instanceof`. Tagged fault objects plus an
  ESLint rule that rejects both the subclass and the check.
- **Typed routing / validation / OpenAPI 3.1** for IDM custom endpoints.
- **`lib` pinned to what the engine actually provides**, so runtime-impossible
  code fails to type-check.
- **Tree-shaking discipline** — no namespace re-exports from `framework/index.ts`.

Changed for on-prem:

- Output goes to `platform/idm/script/` and the endpoint `conf/` JSON, consumed
  by the config profile — **not** pushed over a tenant API. No sync engine, no
  conflict detection, no watcher racing a remote. As you noted, on-prem removes
  the whole class of "someone else overwrote my change" problems that shaped
  half of `aic`.
- Managed-object types come from `platform/idm/conf/managed.json` in the repo,
  generated at build time rather than fetched from a tenant.
- Adds **AM scripted-node authoring** — same pipeline, different globals
  (`nodeState`, `sharedState`, `callbacks`) and a different `.d.ts`.

`npm run check` (type-check, lint, test, build) is a Tilt resource, so a type
error shows up red in the Tilt UI the moment you save.

---

### 8.1 The package repository (D8)

`platform/` ships **empty**. Examples are not seed content that rots in every
checkout — they are **installable packages**, so a team takes only what it
wants and can publish its own.

```sh
fo add example-passwordless      # a journey + the scripts it needs
fo add example-hr-sync           # an IDM mapping + connector + schedule
fo list                          # what's installed, and whether it's drifted
fo remove example-hr-sync
```

A package is a directory with a manifest and a `platform/`-shaped payload:

```text
packages/example-passwordless/
  package.json        name, version, description, requires (component + platform range)
  platform/
    amster/config/... journey + OAuth2 client JSON
    typescript/src/scripts/...
    idm/conf/...
  README.md
```

`fo add` merges the payload into `platform/` and records file hashes in
`.fo/packages.lock`. `fo list` re-hashes: a file you edited is **yours** and is
never touched again by an upgrade, exactly as with managed/seeded files in
section 4. `fo remove` deletes only the files still matching their recorded
hash and names anything it is leaving behind.

Resolution order for `fo add <name>`: `./packages/` in this repo, then any
directory or git URL in `fo.config.ts`'s `packageSources`, then the built-in
registry. Third-party sources are opt-in and named explicitly — no implicit
network fetch.

**[OPEN]** The built-in registry starts as a directory inside this repo. Whether
it later becomes a separate published repo is a question for when there is more
than one consumer.

---

## 9. Observability - the log console (D7)

The valuable query in an identity stack is not `grep ERROR`. It is **follow one
login across AM, IDM and DS**. AM and IDM both propagate
`X-ForgeRock-TransactionId` and stamp it into their audit events, and ForgeOps
already sets `OPENIDM_AUDIT_HANDLER_STDOUT_ENABLED: "true"` - IDM's audit stream
is *already* structured JSON on stdout. So the requirement is a store that
**indexes JSON fields**, not one that greps lines.

### Three tiers, defaulting to off

| Tier | What | Footprint | Gets you |
| ---- | ---- | --------- | -------- |
| **0 - always on** | Tilt's log pane (D4: `fo up` blocks on it) plus `stern` from nix, wrapped as `fo logs [component]` | 0 | live multi-pod tail, per-resource filter |
| **1 - opt-in**, `logs: "victorialogs"` | VictoriaLogs plus a Vector DaemonSet; web UI on `logs.<env>.localhost`; CLI via `fo logs search '<LogsQL>'` | ~250 Mi | indexed JSON fields, history across pod restarts, real search |
| **escape hatch**, `logs: "loki"` | Loki + Grafana + Alloy | ~700 Mi - 1 Gi | Grafana Explore; only worth it if you also want metrics |

**Why VictoriaLogs is the default opt-in rather than Loki**: one container
instead of three, 3-4x lighter for the same job, `victorialogs` 1.52.0 is
already in nixpkgs, and it ships `vlogscli` - so "web **and** CLI" is one
component rather than Loki plus `logcli`. It ingests the Loki push API and OTLP,
so moving to Loki later does not change the collector.

**Why it defaults off**: RAM is the binding constraint. The stack already
requests ~6.5 Gi; on a 16 GB laptop another gigabyte is the difference between
working and swapping. One line in a typed config file is a low enough barrier.

### The part worth more than the console

Whichever backend is selected, `fo` must:

1. Enable **AM's JSON audit-to-stdout handler** in the seeded config profile
   (IDM's is already on in ForgeOps).
2. Have the collector **promote `transactionId`, `eventName`, `realm` and
   `principal` to indexed fields**.
3. Ship **`fo trace <transactionId>`** - one command returning the merged,
   time-ordered event list across AM, IDM and DS.

Item 3 is the thing a ForgeRock developer actually wants and cannot easily get
today. It is worth more than the console itself.

**[OPEN]** DS access logs are voluminous enough to drown everything else.
Proposal: exclude them from the collector by default, behind
`logs.includeDsAccess: true`.

---

## 10. The Tilt boundary (D6)

Tilt is kept, and bounded, so that it stays replaceable.

**The rule:**

> Tilt may only **invoke** `fo`. `fo` may never import Tilt. Everything Tilt
> does must be reachable from `fo` with Tilt not running - `fo build`,
> `fo deploy`, `fo sync`, `fo watch`. The Tiltfile is capped at **100 lines**
> and contains **no business logic**.

Two things fall out of the rule, both needed anyway:

- **CI runs the identical code paths headlessly** (Phase 5), rather than a
  second implementation that drifts.
- **`fo watch`** - a minimal Tilt-free watcher/syncer (~200 lines, given the
  sync is needed regardless). It is the fallback for CI and for "just sync IDM
  config, no UI", and it is what *proves* the rule is honoured rather than
  merely asserted.

### Why not build the whole thing

Parity means rebuilding: file watching with correct debounce and coalescing;
`live_update` (tar-over-exec into a running container, `fall_back_on` semantics,
post-sync `run` steps, correct behaviour when a pod is replaced mid-sync); a
build/deploy dependency graph with invalidation; log multiplexing with a web UI;
manual triggers; and port-forwards that survive pod restarts. That is 6-12
months, and `live_update` is exactly where the subtle bugs live - Tilt v0.37.7
(2026-08-15) fixes `initial_sync` being cancelled for `fall_back_on` files,
which is the class of bug we would be inheriting.

Tilt's real costs are **coupling**, not capability, and the rule above fixes
coupling for a fraction of the price:

| Concern | Answer |
| ------- | ------ |
| Starlark is a second language in a TypeScript project | The Tiltfile is a dumb adapter; every `local_resource` calls `fo tilt:<x>` |
| `fo up`'s UX becomes Tilt's UX | `fo` owns pre-flight and the summary; Tilt owns only the live phase |
| Users must be able to extend it | The strongest argument **for** Tilt: five lines of Starlark against a stable documented API beats learning our orchestrator |

Maintenance is not a live concern: Docker acquired Tilt in 2022 and kept it open
source; 8 releases shipped in 2026.

---

## 11. Phases

Each phase ends with something runnable.

### Phase 0 — spike (gate)

**Nothing else starts until this passes.** One question: does ForgeOps 2026.3
actually come up on k3d?

- k3d cluster, cert-manager, `helm install identity-platform` with
  `values-helm-generate-secrets.yaml`.
- Prove: all pods ready; amster job completes; AM console reachable through
  Traefik; IDM admin reachable; **a file synced into a running IDM pod's
  `conf/` hot-reloads** (the §3 assumption).
- Measure: cold `up` (image pull), warm `up`, peak RSS.
- Deliverable: a throwaway shell transcript and a go/no-go, plus the exact
  Traefik/storage overrides needed. **If k3d fails here, D1 flips to minikube**
  and only `cluster/k3d.ts` changes.

### Phase 1 — `fo up` / `fo down`

Flake, `fo` skeleton, cluster + prereqs + values generation + helm. No Tilt yet.
`fo doctor`, `fo info`, `fo status`. **A developer can get a stack.**

### Phase 2 — Tilt and the inner loop

Tiltfile, config-image builds, the three-tier loop, live_update.
**A developer can change the stack.**

### Phase 3 — TypeScript framework

Port the framework, tools, tests. Seed a demo endpoint and a demo AM script.
Wire `npm run check` into Tilt.

### Phase 3.5 — the package repository

`fo add|list|remove`, `.fo/packages.lock` hashing, and the first two packages
(`example-passwordless`, `example-hr-sync`) built out of what Phase 3 proved.

### Phase 4 — round-trip and upgrade

`fo config export am|idm`, `fo config diff`, `fo upgrade` (flake input bump +
managed-file re-seed + `am-config-upgrader` via the escape hatch).

### Phase 4.5 — the log console

`logs: "victorialogs"`, the Vector DaemonSet with JSON field promotion, AM's
audit-to-stdout handler, and `fo trace`.

### Phase 5 — docs and CI

README quick-start, a `platform/` authoring guide, GitHub Actions running
`fo up` headless plus the TS gates.

---

## 12. Risks

| Risk                                                                                                                            | Severity | Mitigation                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **k3d is not a Ping-validated environment**                                                                                     | High     | Phase 0 gates it. `cluster/k3d.ts` is a single seam, so falling back to minikube is a contained change. Expect to fight: the `fast` StorageClass name (alias local-path), Traefik vs the chart's nginx-flavoured ingress annotations, and DS pods' `readOnlyRootFilesystem`. |
| **IDM hot-reload assumption is unverified**                                                                                     | High     | Phase 0. Degrades to a pod restart, not a failure.                                                                                                                                                                                                                           |
| **We own values generation (D2)**                                                                                               | Medium   | Generate types from the pinned chart so a renamed key is a compile error. `fo upgrade` diffs the new chart's `values.yaml` against our generated types and reports removals.                                                                                                 |
| **~7.5 GB of RAM**                                                                                                              | Medium   | Fine on your 30 GB box. Tight on a 16 GB laptop and needs Docker Desktop's VM raised on macOS. `fo doctor` checks and warns. Trimming the 3 UIs saves only 300 Mi — the cost is AM/IDM/DS and it is not reducible.                                                           |
| **Licensing**                                                                                                                   | Medium   | Images pull anonymously, but Ping's subscription terms govern _use_. This is a dev/eval stack; the README must say so plainly and must not imply a production path.                                                                                                          |
| **ForgeOps churn** (2026.1 moved config profiles out of the app images; 2026.3 removed secret-generator and added Helm secrets) | Medium   | Pin hard via the flake input. `fo upgrade` is a first-class command, not an afterthought, precisely because of this rate of change.                                                                                                                                          |
| **Tilt is a second daemon**                                                                                                     | Low      | `fo up` owns its lifecycle; `fo down` guarantees it's gone. Tilt is never invoked directly by a developer.                                                                                                                                                                   |

---

## 13. Deliberately not doing

- **Production anything.** Ping says the ForgeOps deployment is a sample, not a
  production deployment; nothing here changes that.
- **Cloud targets** (GKE/EKS/AKS). If they're wanted later, `cluster/*.ts` is
  the seam.
- **A TUI.** `aic` needed one for interactive tenant work; this is a local
  stack, and the Tilt UI already covers the "what's happening" job.
- **Hand-authoring AM FBC in TypeScript.** Export round-trip only.
- **Editing `/etc/hosts`.** Requires sudo, breaks the one-command promise.

---

## 14. Answers, and what is still open

Answered 2026-08-25:

| Q | Answer | Where it landed |
| - | ------ | --------------- |
| Run the Phase 0 spike now? | Yes | In progress; images pulled (2.8 GB) |
| Ship seed examples? | No — a **package repository** of optional, installable examples | D8, section 8.1, Phase 3.5 |
| Keep the name `fo`? | Yes, and shadow any local `fo`; support an alias for those who want one | Section 5, "The `fo` name" |
| Should `fo up` block on the Tilt UI? | Block | Section 6 |
| Log console? | Tiered, VictoriaLogs as the opt-in default | D7, section 9, Phase 4.5 |
| Replace Tilt with our own tooling? | No — keep it, and bound it so it stays replaceable | D6, section 10 |

Still open, flagged **[OPEN]** in place:

1. **IDM hot-reload** from a `live_update` sync (section 3) — the biggest
   technical assumption here. Phase 0 settles it.
2. **FQDN strategy** (section 7) — `<env>.localhost` with an `nip.io` fallback,
   pending a real resolution test on macOS.
3. **DS access logs** in the collector (section 9) — proposal is off by default.
4. **Where the package registry lives** (section 8.1) — in-repo until there is
   a second consumer.

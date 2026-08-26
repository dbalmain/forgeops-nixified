# forgeops-local — plan

A one-command, nix-only local Ping Identity Platform (on-prem / ForgeOps)
stack, with a TypeScript authoring workflow for everything a developer writes.

```sh
cd forgeops && fo up      # stack running
fo down                   # stack gone
```

Status: **built**. Phases 0-6.3 are implemented, `fo check` and
`nix flake check` are green, and `e2e.yml` has stood the whole stack up on
GitHub. Decisions are recorded in [section 2](#2-decisions); anything still
genuinely open is flagged inline as **[OPEN]**.

**How to read this document.** It began as a plan and grew phase records as the
work landed, so it is part design intent and part history. Sections 1-9
describe the intended shape and were written BEFORE the code; where they
disagree with the code, the code is right and the divergence is a bug in this
document. The phase records, from Phase 0 onward, are contemporaneous
notes and are the reliable half. Two known places where the early sections
describe things that were never built are marked **[NOT BUILT]** inline.

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

D1-D8 taken 2026-08-25. Later decisions carry their own date in the rationale.

| #   | Decision                                                                        | Rationale                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **k3d** as the local Kubernetes runtime                                         | ~20s cluster create; bundles Traefik (2026.3's default ingress) and local-path storage; maps `:80`/`:443` to the host so there is **no `minikube tunnel` daemon** to babysit; single nix binary. Cost: not Ping-validated. |
| D2  | **Bypass the `forgeops` CLI**; keep it as an escape hatch                       | Drive the upstream Helm chart directly. `fo` generates values from a typed config; the thin bits (info, export, amster) are `kubectl exec` wrappers we own in TypeScript. Removes python and bash from the hot path.       |
| D3  | **TypeScript for scripts and endpoints now**; typed config later                | Port the `pingone-aic-manager` framework. IDM `conf/*.json` and AM FBC stay JSON, round-tripped by export.                                                                                                                 |
| D4  | Stack = **AM, IDM, DS (idrepo + cts), amster, admin-ui, end-user-ui, login-ui** | IG designed for but not built.                                                                                                                                                                                             |
| D5  | **Multiple named envs, at zero cost to people who don't use them**              | One flag, `--env NAME`, default `dev`. See §7.                                                                                                                                                                             |
| D6 | **Keep Tilt, but make it replaceable** | Tilt is actively maintained (v0.37.7, 2026-08-15; 8 releases in 2026, still fixing `live_update` edge cases). Rebuilding `live_update` alone is 6-12 months. Tilt's costs are coupling, not capability, and coupling is fixable - see section 10. |
| D7 | **Log console: tiered, on by default** | Tier 0 (Tilt pane + `stern`) always on; VictoriaLogs deployed by `fo up` unless `logs: "off"`. Originally specified default-off on a RAM argument; superseded 2026-08-25 once measured - see "no Loki, and the console is on by default" in section 9. |
| D8 | **A package repository of optional examples** | `platform/` ships empty; examples are installable packages (`fo add <pkg>`), not seed content. See section 8.1. |
| D9 | **`fo` stays TypeScript; not ported to Rust** | Taken 2026-08-26. `fo` is an orchestrator: its own cost is 80ms, and every command is dominated by what it shells out to (k3d create, Helm converge, PingAM cold start - minutes). Rust would buy ~77ms and cost a compile step in the edit-run loop, a heavier flake, and a language split from `platform/typescript`, which is the thing `fo` exists to compile. Rust's real win here is typed JSON boundaries, taken separately - see the backlog item below. Revisit only if `fo` grows a long-lived process (a watch daemon, a TUI, volume log parsing). |
| D10 | **Node, not bun** | Taken 2026-08-26. Bun runs the whole pipeline correctly - tsc, eslint, Babel with byte-identical output, 194/194 tests - and dropping Intel Mac support would clear the only platform objection. It is rejected on measurement: bun is 56% slower on tsc (320 -> 500ms), 17% slower on eslint, 6% slower on Babel, 15% slower on the test suite. Its 80ms -> 20ms startup win only shows up on commands that do no work. The slow stages are all third-party JS under JavaScriptCore, which is bun's weakest case and not what its own benchmarks measure. Supply-chain angle considered: bun's built-ins could displace esbuild (~27 of 269 transitive packages), but nix already builds `node_modules` from the committed lockfile with pinned hashes and never runs `npm install` on a developer machine, which is the stronger guarantee. Revisit if bun ships a downleveller that can target ES5, since Babel is 87 of the 269. |
| D11 | **TypeScript 7 (`tsgo`) for type-checking** | Taken 2026-08-26. 1420ms -> 251ms across the three platform projects, 558ms -> 76ms for `fo` itself. Verified rather than assumed: seven deliberate violations - `erasableSyntaxOnly`, both lib-pin cases (`Object.hasOwn`, `Array#flat`), `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax` - produce identical diagnostics under tsc 5.9 and tsgo 7, so the D3 engine-surface guarantee survives the swap. `typescript` stays a dependency because typescript-eslint's parser needs it; only the checking moved. It is a dev preview, which is an acceptable risk for a development tool and a one-line revert. |

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

**PROVEN in Phase 0, with a caveat that changes the design.** ForgeOps ships
`openidm.fileinstall.enabled=false` in `conf/system.properties`, so as
delivered a synced file is **ignored**. Rebuilding the config profile with the
watcher enabled makes it work: `conf/` reloads in **< 5 s** and `script/` in
**~15 s**, both with **zero pod restarts** (the 15 s is
`javascript.recompile.minimumInterval: 60000` in `conf/script.json`, which the
dev profile lowers).

So `fo` owns a **dev config profile** that differs from a production profile by
exactly two properties. That is a better shape than the original assumption: the
difference is explicit, tiny, reviewable, and self-evidently not for production.
See `spike/RESULTS.md`.

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
- **[NOT BUILT] `packages.forgeops`** — the upstream CLI, wrapped, reachable as
  `fo forgeops …`. The plan was to replace `forgeops configure`'s pip/venv
  dance with a nix python env plus a generated
  `lib/dependencies/.configured_version` marker holding the sha1 of
  `requirements.txt` that `ensure_configuration_is_valid_or_exit.py` demands.
  **This does not exist.** The flake exposes `fo` and `nodeModules` only, there
  is no `fo forgeops` subcommand, and nothing here shells out to the upstream
  CLI — `fo` talks to helm, kubectl and k3d directly, which turned out to be
  enough. Left recorded because the escape hatch may still be wanted.
- **`apps.default`** — `nix run github:…/forgeops` resolves and runs.
  **[NOT BUILT] the "with no checkout" half**: the wrapper sets `FO_ROOT` to
  the flake's own read-only store path, and `fo up` writes `.fo/<env>/`
  beneath `FO_ROOT`, so a checkout-free `nix run … -- up` cannot write its
  state and fails — after potentially creating the cluster. Read-only
  commands are fine. Making this true needs `FO_ROOT` and a separate writable
  state root to stop being the same thing.

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
| `fo doctor --engines`                          | re-probe both script engines against `engine-surface.json`; needs a running stack                   |
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

### 6.1 Secrets are seeded, not generated

The chart's Helm-native secret generation (`randAlphaNum <n> | b64enc`) is not
safe to rely on: PingDS's dictionary validator rejects a meaningful fraction of
the passwords it produces, and the chart's `lookup`-before-generate makes a
rejected password permanent. Observed in Phase 1 as `ds-set-passwords` failing
forever with `Constraint Violation ... contained a word from the server's
dictionary`.

`fo` therefore derives every password from a single per-env seed in
`.fo/<env>/seed` and applies the Secrets **before** Helm runs; the chart's
`lookup` adopts them and generates nothing. Passwords are shaped `LLd-LLd-...`
— two letters, one digit, hyphen — so the longest run of letters is two and no
dictionary word can match.

Three properties fall out, and the second is the one developers will notice:

- dictionary-safe by construction, so the deployment always converges
- **stable**: `fo down && fo up` yields the same credentials, so bookmarks and
  saved API clients keep working
- reproducible: one file reproduces an environment elsewhere

The rule for what to seed: **only keys the chart would otherwise generate**.
`ds-passwords.monitor.pw` is set literally by the chart, and seeding it makes
`fo` the field manager for a field Helm also writes, which Helm 4's server-side
apply rejects as a conflict.

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

- **Build**: `tsgo --noEmit` → esbuild bundle (ES2020 IIFE) → Babel
  `preset-env targets: {ie:"11"}` to ES5 → lint the _generated_ file against
  IDM's runtime bans. All-or-nothing publication by atomic rename.
- **The runtime bans**: default parameters, `const` in a loop init, trailing
  comma in a parameter list, bare `Reflect`, bare `Proxy`.
- **Never subclass `Error`** — Babel's `_wrapNativeSuper` silently breaks
  `instanceof`. Tagged fault objects plus an ESLint rule that rejects both the
  subclass and the check. *(Superseded by phase 6.4: the `Reflect` explanation
  given here is wrong, the ban covers every native rather than `Error`, it is
  enforced by the checker rather than by ESLint, and the `instanceof` rule is
  gone.)*
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

### Two tiers, defaulting to on

| Tier | What | Footprint | Gets you |
| ---- | ---- | --------- | -------- |
| **0** | `stern` from nix, wrapped as `fo logs [component]` | 0 | live multi-pod tail, per-resource filter |
| **1 - the default**, `logs: "victorialogs"` | VictoriaLogs plus a Vector DaemonSet; web console on `/logs`; `fo logs search '<LogsQL>'` and `fo trace` | ~250 Mi | indexed JSON fields, history across pod restarts, one login across three components |

**Revised 2026-08-26 on two counts.**

Tier 1 was going to be opt-in, because RAM is the binding constraint. It is
now the default: measured, the whole stack is 4.4 GiB actual and 4.8 GiB with
the console, so a 16 GB laptop is not where this decides anything - and
`fo trace` is the single most useful thing here. `logs: "off"` is one line for
anyone who disagrees.

There was also going to be a `logs: "loki"` escape hatch - Loki + Grafana +
Alloy, ~700 Mi - 1 Gi, for people who want Grafana Explore. **Dropped, not
deferred.** The measurements below made the comparison one-sided, and a second
backend means a second query dialect behind `fo trace` for no gain on a
laptop. VictoriaLogs ingests the Loki push API and OTLP, so if someone ever
does want Loki, the collector does not change - which is what made this safe
to decide rather than hedge.

### D7 revisited: measured against the Rust alternatives

Asked to compare lightweight alternatives, particularly Rust ones. 50,000
ForgeRock-audit-shaped JSON events (14.5 MB), one container each, on a 22-core
/ 30 GB Linux box. These are measurements, not vendor claims.

| | Lang | Licence | Image (amd64) | RSS idle | RSS after 50k | Query by `transactionId` | Schema |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **VictoriaLogs 1.52** | Go | Apache-2.0 | **13 MB** | **3.4 MiB** | 167 MiB | 11 ms | none |
| **Quickwit 0.9.0** | Rust | Apache-2.0 | 103 MB | 26 MiB | **156 MiB** | **7 ms** | index + doc mapping |
| **Parseable 2.8** | Rust | AGPL-3.0 | 79 MB | 37 MiB | 413 MiB | 22 ms | stream must exist |
| **OpenObserve 0.92.2** | Rust | AGPL-3.0 | 143 MB | 254 MiB | 300 MiB | 21 ms | none |

All four found all ten target events and ship a web UI.

- **Quickwit is not abandoned** - Datadog relicensed it Apache-2.0 and 0.9.0 is
  current. The objection is scale: it rejected a 14.5 MB request (413), rejected
  a 2-character index id, wrote **284 MB to disk for 14.5 MB of input**, and
  wants a doc mapping up front - which cuts against the premise that PingAM and
  PingIDM emit different field sets.
- **OpenObserve lowercases every field name** (`transactionId` ->
  `transactionid`). For a stack whose audit schema is camelCase that is a
  permanent papercut in every query. It also holds **254 MiB resident before a
  single log arrives**, 75x VictoriaLogs.
- **Parseable** is the closest Rust match, but it stamps its own `p_timestamp`
  as the time axis and keeps the event's `timestamp` as an ordinary column -
  precisely wrong for ordering a trace across three components.
- One of the original reasons was **wrong**: `vlogscli` was cited as making
  "web and CLI" one component. It barely matters - `fo trace` calls the HTTP
  API directly whichever backend is chosen. The real arguments are the 13 MB
  image, the 3.4 MiB floor, and needing no schema.

Caveats: single samples; Go GC and Rust allocators make "RSS after load" a soft
comparison, so the idle figures are the firmer ones; ingest timings are not
comparable (VictoriaLogs accepts asynchronously, Quickwit was forced to
`commit=wait_for`).

**On the RAM worry that made this opt-in in the first place**: the stack
*requests* ~6.5 Gi but measures 4.4 GiB actual, and 4.8 GiB with the console.
That is not the difference between working and swapping. `logs: "off"` is
there for a machine where it is.

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

~~**[OPEN]** DS access logs are voluminous enough to drown everything else.
Proposal: exclude them from the collector by default, behind
`logs.includeDsAccess: true`.~~

**Answered 2026-08-25, and the premise was wrong.** Measured on a
13-hour-old stack, by on-node log bytes per pod:

| Pod | Bytes | Health-probe share of lines |
| --- | --- | --- |
| admin-ui | 1.39 MB | 96% |
| end-user-ui | 1.37 MB | - |
| login-ui | 1.36 MB | 99% |
| am | 1.24 MB | 31% |
| idm | 378 KB | 6% |
| **ds-idrepo** | **17.9 KB** | - |
| ds-cts | 14.0 KB | - |

PingDS is the **quietest** component, not the loudest: ForgeOps ships its
console access logger with `ds-cfg-filtering-policy: inclusive` and only four
criteria - administrative requests, auth failures, requests over 1000 ms, and
misbehaving clients. Excluding it would have dropped the most useful DS signal
there is, to solve a volume problem upstream had already solved.

The noise is the **kubelet's health probes**, and that is what `fo` drops, via
`logs.includeHealthChecks`.

A second finding falls out of the same measurement, and it cuts the other way:
because PingDS logs so little, a *healthy* login produces no DS console output
at all - so the DS leg of a trace is empty exactly when nothing is wrong.
`logs.dsAccessDetail: "full"` sets `DS_LOG_FILTERING_POLICY=no-filtering`
through PingDS's own `&{ds.log.filtering.policy|inclusive}` placeholder, at a
measured ~8 KB of DS output per PingIDM REST call.

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

### Phase 0 — spike (gate) — **DONE, GO**

Ran 2026-08-25; full write-up in `spike/RESULTS.md`, working artefacts in
`spike/`. Cluster create 35 s, cert-manager 26 s, full stack ~7 min, 4.4 GiB
actual memory. Three findings folded back into this plan (sections 3 and 12).

### Phase 1 — `fo up` / `fo down` — **DONE**

Flake, `fo` CLI, cluster + prereqs + secret seeding + values generation + Helm,
plus `doctor`, `status`, `info`, `logs`, `shell`. **A developer can get a
stack.** Cold `fo up` ~10 min, warm ~2 min, already-running ~17 s, 4.4 GiB.

`fo` has **zero npm dependencies**: Node 24 strips the types and runs the `.ts`
directly, and Helm parses values files as YAML, so emitting JSON removes the
only reason a YAML library was needed.

Three things Phase 1 found that Phase 0 could not:

- **Helm 4 waits by default** (`--wait hookOnly`) and the amster Job is a
  post-install hook, so `helm upgrade` blocks until amster finishes — with a 5
  minute default timeout that is shorter than a cold start. `fo` raises the
  timeout and reports pod progress itself rather than sitting silent.
- **The chart's own password generator is a coin flip.** `randAlphaNum 32`
  regularly contains a dictionary word, PingDS rejects it outright, and because
  the chart `lookup`s the existing Secret the bad password is sticky, so
  `ds-set-passwords` fails identically forever. `fo` now seeds every secret
  from a per-env seed, with passwords that cannot contain a dictionary word by
  construction. Section 6.1.
- **`keystore_create.image` is kubectl, not PingAM** (the PingAM one is
  `initImage`), exactly like `ssh_keygen`. Blanket-setting `<key>.image.tag`
  asks for `kubectl:2026.3.0-1849`, which does not exist. `fo` now keys image
  overrides on (chart key, field) pairs and **verifies at every `fo up` that it
  has an explicit decision for every `repository:` in the pinned chart**, so a
  component added upstream fails loudly instead of silently sitting on `latest`.

### Phase 2 — Tilt and the inner loop — **DONE**

`fo dev`, `fo watch`, `fo sync`, `fo amster`, `fo restart`, `fo token`, and a
55-line Tiltfile. **A developer can change the stack.**

All three tiers are measured save-to-live, and every one beat its budget:

| Tier | Budgeted | Measured |
| ---- | -------- | -------- |
| IDM conf | < 5 s | **18 ms – 1.1 s** |
| IDM script | < 5 s | **~1.1 s** |
| amster | ~60 s | **~22 s** |
| PingAM roll | ~2 min | **~51 s** |

The ~1 s floor on scripts is `javascript.recompile.minimumInterval`, which the
dev profile sets. Sub-second was not the target and is a nice surprise: the
sync itself is ~110 ms, so the loop is dominated by IDM's own reload.

What Phase 2 found:

- **The `amster-config` configMap is an unused extension point.** The chart
  mounts it at `/opt/amster/config/amster-import.tar.gz` with
  `optional: true` and never creates it, so `fo` fills it from
  `platform/amster/config/`. Verified end to end: an OAuth2 client authored in
  the repo is importable and then issues real tokens.
- **The amster Job cannot be restarted, only cloned.** It is a Helm
  post-install hook, and a completed Job is immutable. `fo` clones it under a
  fresh name, stripping the API-server-generated fields and the Helm hook
  annotations so the copy is an ordinary Job that Helm ignores.
- **`openidm-admin` does not work against `/openidm/**`.** ForgeOps runs IDM in
  platform mode with authentication delegated to AM, so the password `fo info`
  prints yields `authenticationId: anonymous` and a 403 that reads like an
  authorisation bug. Hence `fo token`, and hence `fo info` now says so. The
  `idm-provisioning` client lives in the **root** realm — this deployment has no
  `alpha` realm, contrary to the usual ForgeOps assumption.
- **An amster import replaces, it does not merge.** A sparse OAuth2 client
  imported cleanly the first time and broke on the second, when the file's
  omitted fields overwrote the defaults AM had filled in
  (`Unknown Signing Algorithm`, because `idTokenSignedResponseAlg` had gone to
  null). Only a repeated inner loop shows this, which is a small argument that
  the loop is worth having. It also raises the value of `fo config export`
  (Phase 4): a hand-written amster file is a liability.
- **Tilt earned its place immediately** by catching a CLI defect: the Tiltfile
  naturally writes `fo --env dev sync conf`, and the parser only accepted flags
  *after* the subcommand. Flags are now parsed from the whole argv.

### Deviation from the plan: `fo up` does not block on Tilt

The plan (D4, section 6) had `fo up` end in `tilt up`. It does not.

Phase 1 established that `fo up` converging and then printing URLs and
credentials is the thing that makes the stack approachable, and a full-screen
Tilt UI would bury exactly that. So the split is `fo up` for a stack and
`fo dev` for the loop — two commands, each of which does one legible thing,
and `fo dev` is re-runnable without re-converging the cluster.

This also makes `fo down` simpler: there is no Tilt daemon whose lifetime
`fo up` owns, which removes the "Tilt is a second daemon" risk from section 12
rather than mitigating it.

### Phase 3 — TypeScript framework — **DONE**

The framework, tools and tests ported from `pingone-aic-manager`; a typed demo
endpoint and a demo PingAM script; `fo build`, `fo check`, `fo deps`; and both
`build` and `check` wired into Tilt and `fo watch`. **A developer can write
typed code against the stack.**

- **179 tests pass**, including full OpenAPI 3.1 meta-schema validation.
- A `.ts` save reaches the running pod in **2.2 s** (1.8 s build + 0.1 s sync),
  via tier chaining: the TypeScript tier only builds, and the existing
  `idm-conf` / `idm-script` tiers pick the emitted files up and sync them.
- Every route of the demo endpoint verified against the live IDM — typed
  routing, path params, query coercion, validation faults, CREST query results.

**`npm install` never runs.** `node_modules` is built by nix from the committed
lockfile and symlinked in by the devShell; `fo build` refuses to run if that
symlink has been replaced by a real directory. This is the piece that makes the
"nix and a Docker daemon" claim honest rather than aspirational, and it was the
first thing built for exactly that reason.

What Phase 3 found:

- **Adding a dependency is a three-trap sequence**, so it needed a command.
  npm cannot write its bookkeeping into the read-only store; the moment
  `package.json` names something the lock lacks the FLAKE stops evaluating, so
  `nix develop` no longer works and you cannot reach a shell with npm in it;
  and npm then exits non-zero on its allow-scripts warning even though the lock
  was written correctly. `fo deps` encapsulates all three.
- **PingAM and PingIDM globals collide.** Both declare a `logger`, and they are
  different shapes, so AM scripts had to become a separate TypeScript program
  (`tsconfig.am.json`) rather than another directory in the same one.
- **An AM script id must be derived, not random.** AM keys scripts by UUID
  while a developer names a file, so `fo` derives a stable UUIDv5 from the
  name. A fresh id per build would create a second copy of the script in AM
  every time, with journeys still pointing at the first.
- **The amster import is the AM deployment route.** An AM script is a `Scripts`
  entity with the body base64-encoded, so it deploys through tier 2 rather than
  by syncing a file — which is why tier 2 existing already mattered.

### Deviation: managed-object types are not generated

The plan had managed types generated at build time from
`platform/idm/conf/managed.json`. They are not, because that file is not in the
repo — it lives in the PingIDM image, and getting it into `platform/` is
`fo config export idm`, which is Phase 4. Building the generator now would mean
shipping a code path nothing exercises, so it moves to Phase 4 where its input
arrives.

### ~~Known gap: the AM program's `lib`~~ — closed 2026-08-26

`tsconfig.am.json` inherited `lib` from the endpoint program, where it was
pinned to **PingIDM's** script-bindings matrix, and it had never been checked
against PingAM's engine. Closed by probing both engines on a running stack
rather than by reading documentation — see
[spike/ENGINE-SURFACE.md](spike/ENGINE-SURFACE.md) and Phase 6 below.

### Phase 3.5 — the package repository — **DONE**

`fo add|list|remove`, `.fo/packages.lock` content hashing, and two packages.
**A team can take an example without inheriting it.**

The ownership rule is the whole design, and it is verified: a file still
matching its recorded hash is `fo`'s; a file you edited is yours. `fo add`
refuses to clobber it, `fo remove` leaves it and names it, and `--force` is the
explicit way back, printing every edit it discards.

**Deviation: the packages are not the two the plan named.**

- `example-passwordless` → **`example-risk-login`**. A WebAuthn journey cannot
  be verified without a browser and an authenticator, and an unverifiable
  example is worth less than a verified one. `example-risk-login` is a real
  journey whose Scripted Decision node is TypeScript, driven end to end over
  REST: `normaluser` gets a session, `svc-robot` is refused. That also closes
  Phase 3's open gap — the AM script had never actually executed in a journey.
- `example-hr-sync` → **`example-stale-accounts`**. Blocked by the platform,
  not by effort: the PingIDM 2026.3 image ships **only** the *cloud* CSV
  connector, whose `storageType` accepts `Google`, `AWS` or `Azure` and has no
  local-file mode. A local CSV feed would need a cloud bucket or a Groovy
  scripted connector. The replacement is a scheduled PingIDM job in TypeScript,
  which required adding `src/tasks/` to the framework — standalone IDM scripts
  had no home, since `src/scripts/` is PingAM's.

What Phase 3.5 found, all of it by running things rather than reading them:

- **`fo amster` reported success for failed jobs.** `{.status.succeeded}
  {.status.failed}` renders as `" 1"` for a failed job, and trimming that put
  `"1"` in the succeeded slot. Every failed import had been reporting success.
  Now parsed as JSON.
- **`fo amster` said nothing about what it imported.** Amster SKIPS a file
  whose entity type it does not recognise and still exits 0, so a journey
  imported while its nodes silently did not. It now reports the entity count
  and every error line.
- **amster entity types are not the AM node-type names.** They drop the `Node`
  suffix — `DataStoreDecision`, `ScriptedDecision`, `UsernameCollector` — but
  `PageNode` keeps it. There is no rule; read the jar.
- **Failed job pods were being deleted before anything could read them**, because
  the chart's template uses `restartPolicy: OnFailure`. The clone now uses
  `Never` and `backoffLimit: 0`.
- **Three PingAM/PingIDM bindings in `am-globals.d.ts` were fiction.**
  `nodeState.get` returns the raw value, not an `asString()` wrapper; the
  next-gen logger is SLF4J-shaped, so `logger.message` does not exist. Both
  compiled cleanly and failed at runtime. The file now carries the rule: do not
  declare a member you have not seen work.
- **PingIDM writes NANOSECOND timestamps**, and IDM's own script engine parses
  them to `NaN`. `NaN` fails every comparison, so a stale-account check read
  every account as stale. A job meant to flag nothing flagged everything, and
  looked like it was working.
- **PingIDM returns JSON `null` for a cleared property.** `description?: string`
  type-checks a `!== undefined` guard that then throws on null.

The last three are the same lesson in three costumes: a declaration that looks
right is not evidence, and only the second run — or the positive control —
finds it. Every example now ships a test for the coupling its build cannot see.

### Phase 4 — round-trip and upgrade — **DONE**

`fo config export am|idm`, `fo config diff`, `fo upgrade`, managed-object type
generation, and the PingAM config-profile image. **A change made in the running
stack can be pulled back into the repo, and the pin can move.**

- **The PingAM round trip is closed and proven.** Export 218 FBC files, build
  them into an `am_custom` image, roll PingAM onto fresh empty volumes, export
  again: byte-identical. The control that makes this mean something is that
  `platform/amster/config` was **empty**, so the `risk-login` journey, its
  scripted node and its five child nodes could only have come from the FBC —
  amster had nothing to re-import. This also closes the Phase 3 gap: tier 3 was
  only ever verified as "roll the pod".
- **The PingIDM round trip is proven the same way**: a config object created
  over REST appeared on disk, `fo config diff` reported it, `fo config export`
  adopted it, and a second diff was clean.
- **Only the delta is exported.** PingIDM's stock `conf/` is extracted from the
  image once and cached; a full export would mean adopting 52 files nobody
  edited and reviewing them on every upgrade. PingAM needs no baseline because
  `export.sh` already tars only what the instance wrote.
- **`fo upgrade` verifies rather than hopes.** Seventeen concurrent registry
  probes plus the chart diff. Pointed at 2026.2 as a test, it correctly named
  every difference that would have broken generated values: two changed image
  repositories, `ssh_keygen` absent, `pingone` and `ssh_keygen` top-level keys
  gone.
- **Managed-object types are generated** from the exported `managed.json` into
  the `ManagedObjects` seam `framework/idm-globals.d.ts` had been declaring
  empty since Phase 3, so `openidm.read("managed/user/…")` finally returns a
  typed object with checked field names.

What Phase 4 found:

- **`am-config-upgrader` is published under the PRODUCT version, not the
  release tag.** `am-config-upgrader:8.1.1` exists; `:2026.3.0-1849` does not.
  Every other image is the other way round. This is the same two-tag-schemes
  hazard as the Phase 0 spike, pointing the opposite way, and it is why
  `fo upgrade` now probes the registry for every ref it pins.
- **PingAM writes FBC files by itself.** Fourteen social-identity-provider
  entries materialised minutes after a boot nobody had touched, so
  `fo config diff am` reported drift that no person caused.
- **…and filtering them out is wrong.** Those entries hold `_id` and `_type`
  and no settings, which looks like a safe thing to drop — until you notice a
  `DataStoreDecision` node has exactly the same shape, because it has no
  settings either and its EXISTENCE is the configuration. The filter deleted
  five nodes from the risk-login journey. Reverted: the export keeps
  everything, and the classification is used only to decide what `diff` counts
  as drift. Found by reading the list of dropped files, not by any gate.
- **`fo` itself was never type-checked.** Node 24 strips types and runs the
  `.ts` directly, so nothing compiled `tools/fo` and an error surfaced only
  when the broken line ran. `fo check` now type-checks it, and the first run
  found a latent `exactOptionalPropertyTypes` violation in the argument parser
  that predates this phase. It needed a root `package.json` (`type: module`) —
  Node infers ESM from the syntax, tsc does not.
- **`system.properties` and `script.json` must never be exported.** The dev
  config profile generates both; an exported copy is copied over the generated
  one and silently freezes the inner loop's settings, ignoring `fo.config.ts`.
- **Tier-1 sync is additive, and a roll is the undo.** Three config files from
  packages uninstalled in Phase 3.5 were still in the pod; `fo config diff`
  found them. `fo sync` never deletes, so `fo restart` is what returns a pod to
  its declared state.

### Deviation: `fo upgrade` does not re-seed managed files

Section 4 promised `framework/` and `tools/` would be rewritten by
`fo upgrade`, content-hashed. They are not, because in this repo **`fo` and the
workspace are the same tree** — there is nothing to copy from, and building the
code path would mean shipping something nothing exercises, which is the same
reason Phase 3 deferred the type generator.

It becomes real with `fo init`, which would create a workspace separate from
the tool. The content-hash machinery it needs already exists and is proven:
`.fo/packages.lock` and `fo add|remove` (Phase 3.5).

What was done instead is the part that has a consumer today: every managed file
that still claimed to be "regenerated by `aic workspace update`" — a tool that
does not exist here — now names `fo upgrade`, and the chart-derived checks
`fo upgrade` runs are the mitigation section 12 promised for D2.

### Deviation: `platform/am/config` is not committed

A fresh clone should get stock PingAM, not a snapshot of the machine that ran
the export — the same reasoning that keeps `platform/` free of examples. The
directory is produced on demand by `fo config export am`; in a real project it
is exactly the thing to commit.

### Phase 4.5 — the log console — **DONE**

`logs: "victorialogs"` in `fo.config.ts` deploys VictoriaLogs plus a Vector
DaemonSet as plain Kubernetes objects (`tools/fo/logstack.ts`), rendered to
`.fo/<env>/logstack.json` so what was deployed is readable. `fo up` converges
it, and converges it **away** when the backend goes back to `off`;
`fo down` removes the cluster-scoped RBAC a namespace delete would leave
behind.

Verified against the live stack rather than by inspection:

- **`fo trace` returns one login across all three components.** One PingIDM
  query produced 7 events across `am`, `ds-idrepo` and `idm`, reading left to
  right: IDM asked AM to introspect its token, AM looked the client up in DS
  twice, IDM then searched DS for the users.
- **The prefix query earns its keep.** Sub-transactions arrived as
  `<root>/0`, `<root>/0/1`, `<root>/0/2`, `<root>/1` - a downstream call
  *extends* the id. An equality filter would have returned the entry point and
  dropped every DS event and every AM introspect event.
- **Before/after control on the trust flag.** With
  `PLATFORM_TRUST_TRANSACTION_HEADER` unset, a supplied
  `X-ForgeRock-TransactionId` produced **0** matching AM events; with it set,
  **22**. Verified independently on PingIDM, and on PingDS (whose
  `transactionId` matched the decoded LDAP `TransactionId` control exactly).
- 16 `fo`-level tests, including one that loads the generated pipeline in the
  **real Vector binary**.

### Item 1 was already done upstream

PLAN.md said `fo` must "enable PingAM's JSON audit-to-stdout handler in the
seeded config profile". It is already on: ForgeOps' stock PingAM ships
`realm/root/auditservice/1.0/globalconfig/default/stdout.json` with
`JsonStdoutAuditEventHandlerFactory` enabled for the access, activity, config
and authentication topics. PingIDM's and PingDS's are on too. Nothing to seed -
which is fortunate, because `platform/am/config` is deliberately not committed.

What was actually missing was the opposite of a handler: every component
defaults `&{platform.trust.transaction.header|false}` to **false**, so each
minted its own root transaction id and a login could not be followed across
them. All four read the same placeholder, and `platform.env` is the one chart
key that reaches all four, so `fo` sets it once.

### Decision: no Loki, and the console is on by default

Both settled 2026-08-26; section 9 carries the reasoning. Loki is dropped
rather than deferred, and `logs` defaults to `"victorialogs"` rather than
`"off"`.

`dsAccessDetail` defaults to `"full"` for the same reason - this is a
development stack, and upstream's quiet PingDS means the DS leg of a trace is
empty exactly when nothing is wrong.

### Two bugs found by deploying, not by reading

- **`fo restart am` broke the next `fo up`.** Helm 4 applies server-side;
  `kubectl set image` left `.spec.template.spec.initContainers[custom-vol-init]
  .image` owned by `kubectl-set`, and the next converge failed outright with a
  field-ownership conflict. A converge that refuses to converge. Fixed with
  `--force-conflicts`, which is right here because `fo` regenerates the same
  content-hash tag Helm is reasserting.
- **A chart key that is only rendered when non-empty cannot be switched off.**
  `ds_idrepo.env` is emitted with `{{- with }}`, so an empty list produces no
  field for server-side apply to own - and switching `dsAccessDetail` back from
  `full` left the old value in place while `fo up` reported success. `fo` now
  always states the value, including when it equals the default.

### Phase 5 — docs and CI — **DONE**

- **README quick-start** was already there from Phase 1; this phase added the
  log-console section, the measured backend comparison, and links out.
- **`platform/AUTHORING.md`** — the authoring reference: directory-to-tier
  map, the managed/seeded/yours rule, endpoints, tasks, PingAM scripts,
  validators, faults, managed-object types, testing, and the config formats.
  Every code example in it was compiled against the real framework before it
  was committed, not written from memory.
- **`.github/workflows/check.yml`** — on every push and PR: `nix flake check`,
  then `fo check` (the same command a developer runs, deliberately not
  reimplemented as separate steps so CI and the laptop cannot disagree about
  what green means), then a guard that fails if the build moved a tracked
  file.
- **`.github/workflows/e2e.yml`** — nightly and on demand: `fo doctor`,
  `fo up`, and a smoke test that drives a real PingAM authentication with a
  chosen transaction id and asks for it back through `fo trace`. That exercises
  the ingress, the generated TLS, PingAM, the collector and the log store in
  one command - unlike a readiness check, which passes for a stack that cannot
  serve. Teardown is `fo down --destroy`, so CI is also the only thing
  exercising that path.

Both workflows pass `actionlint`.

### `e2e.yml` has run on GitHub

**Updated 2026-08-26.** It has now run twice for real. The second run was green
end to end in 12 minutes - `fo up` 9m35s, the login trace and the engine probe
both passing - against a 60-minute cap, and disk was never close to the limit.
Both risks this section used to worry about were false alarms.

The FIRST run failed, at cert-manager: the webhook was not Available inside a
hardcoded 5m timeout. That timeout was not the cause. The same install took 25
seconds on the runner an hour later and 31 seconds into a cold local k3d
cluster with an empty containerd, so the failure was a ~12x anomaly on GitHub's
infrastructure and remains unexplained. Expect the nightly to go red on it
occasionally. What changed is that the diagnostics step now dumps the whole
cluster instead of the `dev` namespace alone - during that first failure it
printed "No resources found" three times, because the failure was in a
namespace it did not look at.

Its steps had also been run locally before any of that: on 2026-08-26 the whole
sequence - `fo down --destroy`, `fo doctor`, `fo up`, `fo status`, the
`fo trace` smoke test - was run from a destroyed cluster, twice, with the same
assertions.

The first run found a real ordering bug. `fo up` deployed the log stack
**after** `waitReady`, so it returned reporting success while the console was
still Pending on its PVC and image pull, printed a URL that 404s, and a
`fo trace` immediately afterwards failed with "no log store running". Nothing
short of building from nothing shows that. Fixed by deploying the log stack
before the wait, so the one wait covers all thirteen pods; the second run was
clean and the trace hit first time.

That run also vindicated `dsAccessDetail: "full"`: a plain healthy `amadmin`
login now traces across `am`, `ds-idrepo` and `ds-cts`, showing the identity
search and the CTS session-token write. Under upstream's filter those three
lines do not exist.

### Phase 6 — verify the script engines — **DONE**

The last correctness gap reachable from a laptop. `fo build` runs
`@babel/preset-env` with `useBuiltIns: false`, so nothing is polyfilled: `lib`
is a load-bearing claim about the engine, and declaring a builtin it lacks
produces code that type-checks, lints, builds, deploys and throws in the
middle of somebody's login.

Two probes — a PingAM scripted decision node and a PingIDM custom endpoint —
reported which builtins actually exist. Result at the time: **both looked like
the same Rhino build and agreed on all 95 shared probes**, which is what made
one shared `lib` look sound.

> Superseded by Phase 6.2. Ninety-five probes was a sample, not a census, and
> both halves of that sentence turned out to be weaker than they read: the pin
> promises 714 runtime-bearing declarations, 234 of them are absent, and the
> two engines are not identical. See below.

- **The pinned `lib` was correct.** Every entry already there is genuinely
  present. No change needed — the outcome worth having verified rather than
  assumed.
- **It was too narrow.** Added `ES2017.String`, `ES2018.Promise`,
  `ES2019.Object` and `ES2019.String`, each fully present.
- **`ES2017.Object` is a partial match** — `entries` and `values` exist,
  `getOwnPropertyDescriptors` does not — so those two are declared member by
  member in `framework/engine-lib.d.ts` instead.
- `tests/engine-lib.test.mjs` cross-checks both tsconfigs against the recorded
  probe data by reading TypeScript's own lib `.d.ts` files, so adding an entry
  that declares an absent builtin fails the build. Both of its failure modes
  were exercised before it was committed.

**A probe that could not observe the answer.** The first round tested array
iterability as `Array.prototype[String(Symbol.iterator)]`. `String(symbol)`
yields a key nothing has, so it reported arrays as non-iterable on an engine
where they are iterable — and the conclusion would have been to *narrow* the
lib on false evidence. Indexing with the symbol itself gives the true answer.

### Phase 6.1 — `fo doctor --engines` — **DONE**

Phase 6 closed the `lib` question but left the answer perishable: the surface
is a measurement, and a ForgeOps upgrade can change the engine underneath it
with every gate still green. `fo doctor --engines` re-takes the measurement.

**The probe list is generated from `engine-surface.json`.** The two spike
probes were hand-written per engine and had already drifted apart — 97 checks
against 95 — so the fix was to stop keeping a second copy of the list. Add a
key to the JSON and both engines probe it on the next run. Only the six
`emit:*` behavioural entries are still hand-written, because they assert that
downlevelled output *runs* rather than that a name exists. The spike probes
are deleted; git history has them.

> Both of those sentences were the weak point Phase 6.2 had to fix: generating
> the probes *from the JSON* means nothing outside the JSON can ever be
> discovered, and the hand-written `emit:*` checks tested an impression of
> Babel's output rather than Babel's output.

**Delivery, per engine:**

- **PingIDM** — `POST /openidm/script?_action=eval`. Inline, no deploy,
  nothing left behind.
- **PingAM** — no eval action exists (`_action=evaluate` answers **501**), so
  the probe is installed over REST as a script, a `ScriptedDecisionNode` and a
  one-node tree, driven by one authentication and read back from
  `logger.error`. Teardown runs in a `finally`, so a probe that throws
  half-way does not leave a journey behind. Six REST calls; no amster, no
  rebuild, no touching the repo's own journeys.

Two details that had to be measured rather than assumed:

- **The tree ends at Failure, not Success.** The probe authenticates nobody,
  and routing to Success asks AM to mint a session for a subject that does not
  exist — answering 500 and burying the real outcome.
- **AM reports through a JSON log line**, so the last token arrives welded to
  `","context":"default",...`. Splitting on whitespace alone invents a key and
  loses a real one.

**Verified against the running stack.** Both engines match the recorded
surface, exit 0, and AM has no leftovers. The negative control matters more:
three deliberate edits to `engine-surface.json` — a builtin claimed present
that is absent, on each engine, and one claimed absent that is present — were
each reported with the direction of the change, exit 1. Twelve unit tests
cover the pure logic, including the two bugs above and the
`String(Symbol.iterator)` trap from Phase 6; reverting either fix fails them.

### Phase 6.2 — the proof was circular — **DONE**

Codex read Phase 6 and found the hole: the probe list is generated *from*
`engine-surface.json`, and the test only rejected a lib entry declaring
something recorded **absent**. So a builtin nobody thought to probe could
never be discovered, never be reported, and was silently assumed present. The
`lib` pin therefore described an engine we had measured 13% of.

What replaced it:

- **The required set is derived from the other side.**
  `tools/engine-coverage.mjs` walks the TypeScript lib files the tsconfigs
  name and enumerates every declaration that carries a runtime value: **728**,
  against 97 recorded. A test fails on any that were never probed, so the
  measurement can no longer be a subset of the lib by omission.
- **234 of the 728 are absent** on PingAM, 232 on PingIDM. Nearly all of the typed arrays — Rhino's
  `Float32Array.prototype` has `get`, `set` and `subarray` and none of the
  `%TypedArray%` suite — plus `RegExp#flags`, `RegExp#sticky`, `RegExp#unicode`,
  `Date#[Symbol.toPrimitive]`, `Function#[Symbol.hasInstance]` and the
  well-known-symbol statics.
- **The old gate was unsatisfiable, not passing.** "No pinned lib entry may
  declare a builtin the engine lacks" cannot hold for any real lib list:
  `lib.es5` is monolithic, the typed arrays arrive with `Date` and `JSON`, and
  TypeScript cannot un-declare an interface member. It only ever passed
  because the measurement was too small to notice. It is replaced by a
  **use-site** check that resolves every property access in both programs
  through the compiler and fails the build on a use of an absent builtin.
- **The engines are not identical.** At 97 probes they agreed; at 767 they
  differ on `Math[Symbol.toStringTag]` and `JSON[Symbol.toStringTag]`, present
  on IDM and absent on AM. The shared `lib` survives because each program is
  now checked against **its own** engine.
- **The behavioural checks are generated.** `tools/emit-corpus.ts` goes through
  the real esbuild+Babel pipeline (extracted to `tools/pipeline.mjs` so the
  build and the probe provably share it), and the committed output is what the
  engines run. The old hand-written six mirrored an *assumption* about Babel —
  the spread case was a literal `[].concat(...)` — and would have stayed green
  through a preset-env change that started emitting `_toConsumableArray`.
- **The measurement is frozen to what it covered.**
  `framework/engine-coverage.json` records both compiler versions and a digest
  per lib file for each, and `fo build` checks it before emitting, so a bump
  fails the build with "re-probe" rather than silently widening the pin.

**Two measurement bugs found by expanding the coverage**, both of which would
have gone into the record as fact:

- `typeof Map.prototype.size` **throws** on this engine (`Method "get size"
  called on incompatible object`), and the probe caught the throw and recorded
  `Map#size` as absent. Every getter-backed member was measured the same way.
  Existence is now tested with `in`, which does not invoke accessors.
- `Error#stack` is an own property of an instance, not of the prototype, so a
  prototype-only probe called it absent on an engine where `new Error().stack`
  is a string. The probe now also tries one constructed sample per holder.
- And the use-site check itself was born blind: it matched lib files by path,
  but `node_modules` is a symlink into the nix store, so it compared
  `<project>/node_modules/...` against `/nix/store/...`, matched nothing, and
  passed a file using `Float32Array#map`. It asks the compiler which files are
  default-library files now, refuses to report a clean result if it loaded
  none, and a committed fixture proves it can still fail.

`fo doctor --engines --record` writes a fresh measurement back, and refuses to
write a partial one.

### Phase 6.3 — closing what the round-3 review found — **DONE**

Codex reviewed 6.2 and came back "not closed yet", with seven ranked defects.
Four were verified independently before being acted on; all seven are fixed.

- **The use-site check was not on the build path.** It lived only in a test,
  and `npm run check` runs the build *before* the tests — so an absent builtin
  was emitted into `platform/idm/script/` and the command failed afterwards,
  leaving output `fo sync` would push. It is part of `tools/build.mjs`'s
  type-check step now, verified by making a real endpoint read
  `new Float32Array(2)["reduce"]` and watching the build refuse before writing.
  This was the same build/check split fixed one commit earlier in `c979da8`,
  recreated.
- **The check missed four of the five forms it implied it covered.**
  `arr["map"]`, `arr[key]` for a finite union, `const { map } = arr` and
  `({ map } = arr)` were all invisible, and `Math[Symbol.toStringTag]` resolved
  to a `Symbol` holder rather than a `Math` one — so the one member PingAM is
  known to lack was reachable and reported clean. The fixture now carries one
  case per form. What it still cannot see — dynamic keys, structural erasure,
  dependency implementation code — is stated in the file rather than implied
  away.
- **The census hashed the wrong lib files.** `fo build` type-checks with
  `tsgo`; the manifest digested the `typescript` package's copies, which the
  emission gate never reads. All twelve differ byte for byte. Both are frozen
  now, the required set is their union, and a test fails if their derived
  surfaces stop agreeing.
- **`length` and `name` were excluded from the census**, so `Function#name`
  was never probed while the count claimed to be exhaustive. Restoring them
  took 714 to 728; all fourteen turned out to be present on both engines, which
  is the answer you only get by asking.
- **`goTo` could still be widened.** `outcomes: ["high", ...names]` satisfies
  the non-empty tuple and collapses the union to `string`, so `goTo("hihg")`
  compiled. Rejected now by a `string extends Outcomes[number]` test
  intersected onto the spec — it cannot live on `outcomes` itself, because a
  conditional type there stops being an inference site.
- **…and annotating the callback parameter bypassed it entirely.** TypeScript
  compares method parameters bivariantly, so `{ goTo(o: string): void }` is an
  accepted stand-in and no variance annotation on `AmAction` refuses it — the
  bivariance comes from the annotation's own declaration. Making `goTo` a
  function-typed property was tried and changes nothing. It is closed from the
  source instead: `tools/am-source-rules.mjs` fails the build on an annotated
  `main` parameter.
- **`--record` could still write a partial measurement.** It checked that both
  engines answered, not that they answered every key, so a run that skipped one
  would have shrunk the file to whatever it covered. It also carried the old
  `forgeopsRelease` forward, dating a new measurement to the build it was not
  taken on.
- **Readiness could still report success for a missing workload.** `waitReady`
  asked only whether every pod that *exists* is settled, and a Deployment that
  produced no pod at all contributes nothing unready — so `fo up` printed URLs
  and exited zero for a stack missing a component. It counts from the workload
  side too now. Alongside: `getPods` turned every non-zero `kubectl` exit into
  an empty namespace (an expired credential read as "nothing deployed"), init
  container states were never decoded, and the crash-loop threshold used the
  *lifetime* restart count, so a pod that had ever restarted three times was
  declared terminal on the first tick of the next `fo up`.
- **A decision, not a probe: `async`, `await`, generators and native
  subclassing are banned.** An `async` function is assignable to a `() => void`
  handler, so it compiles — and an endpoint's response body is the script's
  completion value, an AM node's outcome is read when `main` returns, and Rhino
  has no event loop here to settle a Promise. Babel's `_wrapNativeSuper` breaks for *any*
  native superclass and not just `Error`. *(Superseded by phase 6.4: the
  reasoning offered here — "`_wrapNativeSuper` needs `Reflect`, which is
  absent" — is wrong. It falls back to `Function#bind` and
  `Object.setPrototypeOf`, both present. The conclusion survives because it was
  then measured; the argument did not.)*

The honest claim, which the code now states rather than implies: *direct,
statically resolvable builtin uses in this package's TypeScript are rejected
before emission; dynamic access, structural erasure and bundled dependency
implementations are outside the proof.*

### Phase 6.4 — the round-4 review — **DONE**

Codex reviewed 6.3 and found six more. Two of them overturned something the
previous round had asserted.

- **A type-level close for the `goTo` annotation exists after all.** 6.3
  concluded it did not and closed the hole with a syntactic source rule; codex
  produced the shape, and it holds under tsgo. `MainMustNotWiden` infers `Main`
  as a second `const` parameter and reads the outcome type back out of whatever
  annotation the author supplied — rejecting `string`, `any`, and one extra
  literal, while still accepting an exact or narrower one. The source rule and
  its fixtures are deleted. It would also have been easy to walk past: an object
  method, a `main` defined elsewhere, an aliased `defineAmScript`. A constraint
  that travels with the type has none of those seams.
- **"No `Reflect`, therefore every native subclass breaks" was never
  measured.** Babel's `_construct` falls back to `Function#bind` and
  `Object.setPrototypeOf` when `Reflect.construct` is missing, and both are
  recorded present — so the inference does not follow, and the project had been
  generalising from one measurement of `Error`. Measured properly, both cases
  fail on both engines and for *different* reasons: an `Error` subclass
  constructs and satisfies `instanceof Error` but not `instanceof` its own
  class, while a `Map` subclass does not construct at all. The ban stands on a
  stronger footing than the one written down, and `emit:subclass-error` /
  `emit:subclass-map` keep it live.
- **The native-subclass ban moved from eslint to the checker.** A syntactic
  selector had escapes (`const E = Error`, `globalThis.Error`) and false
  positives (a project class named `Map`), and the companion
  `instanceof /Error$/` rule caught `instanceof DomainError` for no reason. It
  resolves the heritage expression through the compiler now, on the build path;
  the `instanceof` rule is gone, because with subclassing rejected there is
  nothing left for it to protect.
- **`npm run check` could emit against types it never checked.** Its
  `type-check` step did not regenerate managed types and the build did, so a
  changed `managed.json` meant the two ran on different `src/generated/`. The
  check is `lint && build && test` now — the build does its own type-check, in
  the right order — and the `--type-check-only` path regenerates first so the
  two paths cannot disagree again.
- **`fo status` still had the missing-workload false success** that `waitReady`
  had been fixed for, so the two commands disagreed about the same cluster.
  It counts workload gaps now. A DaemonSet desiring zero pods is healthy by
  Kubernetes' reckoning and is left alone — except `fo-vector`, which we install
  and promise: scheduling nowhere means the log console collects nothing.
- **The progress ticker could kill `fo up`.** `getPods` throws on a real
  kubectl failure now, and the ticker called it inside an unguarded
  `setInterval` outside the awaited helm promise. A transient read failure
  would have taken the process down mid-install — the exact opposite of the
  decision not to interrupt helm.
- **Computed and quoted destructuring keys escaped the use-site check.**
  `const { ["map"]: m } = arr` and `({ "map": m } = arr)` resolve now; the
  second needs the right-hand side's type walked, because the pattern's own
  type describes the *targets*, not the source. The fixture also claimed a
  parameter-binding case it did not have. Twelve forms, one case each.
- **The measurement's own gates ran after emission.** Coverage, compiler-surface
  equality and manifest freshness lived only in a test, and a direct `fo build`
  never ran it — so after a compiler bump a newly declared builtin would be
  *absent* from the surface rather than recorded `false`, and an absent key
  reads as fine. They run before emission now, and the analysis program refuses
  to report a clean result if TypeScript disagrees with tsgo about the sources
  at all.

### Bug found on the way: `fo amster` failed on a first install

Amster walks the config tree without knowing which entity types depend on
which, and sorts `ScriptedDecision` before `Scripts` — so a scripted decision
node is imported before the script it references and PingAM rejects it.
`fo add example-risk-login && fo build && fo amster`, the exact sequence that
package's README prescribes, failed every time on a stack that did not already
have the script. Reproduced deterministically, and fixed with a **targeted**
second pass: a blanket retry would double the time every genuinely broken
import takes to fail.

### Second bug found on the way: `fo sync` never removed anything

Tier 1 pushes a tar of the current tree, which adds and overwrites but does
not delete. So deleting an endpoint's TypeScript left it **serving**: the
build retired the generated files from disk, the next sync reported success,
and the endpoint you deleted still answered 200. Found because the engine
probe was still live after its source was gone.

`fo sync` now deletes generated files the pod has and the repo does not, gated
on the `@generated by \`fo build\`` marker `fo` itself writes. That guard is
the whole safety of it, and it was verified rather than assumed: PingIDM ships
four endpoints of its own in the same directory (`oauthproxy`,
`validateQueryFilter`, `linkedView`, `mappingDetails`), and an ungated sweep
would have deleted all four on the first sync. They survive, along with a
hand-written `endpoint-*.json`, while the orphan goes to 404.

### Known gap: the GitHub runner environment

What has not been exercised is the runner itself. Action versions are pinned
to tags that exist today. Two things the first real run has to settle:
disk headroom (2.8 GB of images against a standard runner's 14 GB, which is
why it reclaims the runner's preinstalled toolchains first) and whether
PingAM's cold start fits the 60-minute cap. `dev.localhost` resolution is not
left to chance - the workflow writes `/etc/hosts` rather than relying on the
runner's resolver, which is a CI crutch and says so.

---

### Phase 6.2 — narrow the JSON boundaries — **DONE**

The one benefit the Rust option had that D9 gave up, taken in TypeScript:
`tools/fo/lib/shape.ts`, about a hundred lines, no dependency.

**The bug it was really about.** `getPods` and `clusterExists` both wrapped
their parse in a `try/catch` that returned "nothing" — so a kubectl or k3d
shape change would have made `fo status` report an empty cluster and
`clusterExists` answer *false*, sending `fo up` to create a cluster that
already existed. Silent, and wrong in a direction that does damage. The
validators exist to separate the two cases that `catch` conflated: the command
**failed** (ordinary — nothing deployed yet, no cluster, job not created) and
the command **succeeded but said something we do not understand** (a bug,
worth a loud error naming the field that moved).

Applied at every boundary whose shape belongs to somebody else — kubectl pods
and jobs, k3d cluster list, `nix flake archive`, PingAM authenticate, PingIDM
token and script eval, VictoriaLogs events. Deliberately **not** applied to
`flake.lock`, `.fo/packages.lock`, package manifests or
`engine-surface.json`: those are ours, so a shape change there is a bug we
introduced and the tests catch it.

Unlisted fields pass through unchecked. These payloads belong to Kubernetes;
objecting to a field it added would break `fo` on an upgrade that changed
nothing we use.

Twelve tests, including the messages themselves — a renamed field must name
the path that moved, a wrong type must not be coerced, non-JSON must name the
source, and an error must stay readable rather than dumping a 5 KB payload.

---

### Phase 6.3 — derive the image tag — **DONE**

The last hand-maintained pin. ForgeOps publishes images as `<release>-<build>`,
and the build number comes from their pipeline: it appears **nowhere** in the
source tree the flake pins, so `2026.3.0-1849` had always been read off a
release note and typed into `config.ts`. `fo upgrade` said as much — "RELEASE
is set by hand, not by the flake" — which is an instruction, not a check.

It is also the pin most likely to be quietly wrong. A stale tag installs an
older platform than the chart expects and nothing complains, because the
images it names still exist — `checkImagesExist` passes either way.

The registry knows, and lists tags anonymously, so `fo upgrade` now asks:
newest build for the pinned release, compared against `RELEASE.imageTag`.
Advisory when a newer build merely exists (normal, and the pinned one still
resolves); an error when the tag belongs to a **different release** than the
chart, which is the case nothing else could catch.

Build numbers are compared numerically. They are four digits today, which
makes a string sort agree by accident — nobody promised that, and a five-digit
build sorts below `9999` as text. There is a test for exactly that case.

Verified live against the registry, and both failure paths driven by editing
the pin: an older build warns with the tag to take, and a tag from another
release fails.

`RELEASE.productVersion` stays by hand. It is not derivable from the tag list
— the mapping from `2026.3.0` to `8.1.1` is not published anywhere machine-
readable — but a wrong value fails loudly, because `am-config-upgrader` is
published under it and is one of the refs probed.

---

## 12. Risks

| Risk                                                                                                                            | Severity | Mitigation                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~k3d is not a Ping-validated environment~~ | **Retired** | Phase 0 proved it: all pods up, Traefik serves the ingress on plain `https://dev.localhost/am/` with no `/etc/hosts` and no tunnel, and local-path aliased to `fast` satisfies DS. Residual closed: `fo` pins `rancher/k3s:v1.34.4-k3s1` explicitly (tools/fo/cluster/k3d.ts). |
| ~~IDM hot-reload is unverified~~ | **Retired, with a change** | Proven, but only after the dev profile sets `openidm.fileinstall.enabled=true`; ForgeOps ships it `false`. See section 3. |
| **Published chart 2026.3.0 will not install unmodified** | Medium | Its publish script rewrites every `tag:` to the release tag including third-party images, and `dockette/ssh:2026.3.0-1849` does not exist. The failure cascade (ssh-keygen -> no amster secret -> AM `FailedMount`) points nowhere near the cause. `fo` pins `ssh_keygen.initImage.tag` and `ssh_keygen.image.tag` explicitly. Vindicates D2. |
| **Two incompatible image tag schemes** | Medium | The docs say `8.1.1`; the chart pins `2026.3.0-1849`; they are different builds with different digests. `fo` pins the chart's scheme - that is the combination ForgeOps tested. |
| ~~We own values generation (D2)~~ | **Mitigated** | `fo upgrade` diffs the old and new chart `values.yaml`, naming changed image repositories, added/removed image keys and removed top-level keys; `verifyImageCoverage` then fails on any image key `fo` has no decision about. Verified against 2026.2, which reported all five real differences. |
| RAM | **Low** (was Medium) | Measured **4.4 GiB actual** for the whole stack, against 6.5 GiB of requests. A 16 GB laptop is comfortable, not marginal. macOS still needs Docker Desktop's VM raised. `fo doctor` checks and warns. |
| **The stack trusts a client-supplied transaction id** | Low (dev only) | `fo` sets `PLATFORM_TRUST_TRANSACTION_HEADER=true` on PingAM, PingIDM and both PingDS instances, because without it `fo trace` cannot work at all — each component mints its own root id. It means a caller can dictate what its requests correlate to. Harmless on a local dev stack; in production the header must be stripped at the edge. Stated in the README, not just here. |
| **Licensing**                                                                                                                   | Medium   | Images pull anonymously, but Ping's subscription terms govern _use_. This is a dev/eval stack; the README must say so plainly and must not imply a production path.                                                                                                          |
| **ForgeOps churn** (2026.1 moved config profiles out of the app images; 2026.3 removed secret-generator and added Helm secrets) | **Low** (was Medium) | Pinned hard via the flake input, and `fo upgrade` now bumps it, diffs the chart and probes all seventeen pinned image refs. `RELEASE.imageTag` was the residual - chosen by hand, because the build number appears nowhere in the source we pin - and is now derived: `fo upgrade` lists the registry's published tags and reports whether the pin is the newest build of the pinned release. Residual: `RELEASE.productVersion` is still by hand, but a wrong one fails loudly, because `am-config-upgrader:<productVersion>` is one of the seventeen refs probed. |
| **Tilt is a second daemon**                                                                                                     | ~~Low~~ **Gone** | Resolved in Phase 2 rather than mitigated: `fo up` no longer starts Tilt at all. Tilt runs only for as long as a developer keeps `fo dev` in the foreground, and `fo watch` does the same job without it.                                                                     |

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
| Should `fo up` block on the Tilt UI? | **No** — `fo up` converges and exits; `fo dev` owns the live session | Revised in Phase 2 |
| Log console? | Tiered, VictoriaLogs as the opt-in default | D7, section 9, Phase 4.5 |
| Is a Rust store lighter than VictoriaLogs? | **No** — measured; nothing beat 13 MB / 3.4 MiB idle, and OpenObserve lowercases field names | D7 revisited, section 9 |
| Replace Tilt with our own tooling? | No — keep it, and bound it so it stays replaceable | D6, section 10 |

Still open, flagged **[OPEN]** in place:

1. ~~**IDM hot-reload** from a `live_update` sync (section 3) — the biggest
   technical assumption here. Phase 0 settles it.~~ — **answered by Phase 0,
   proven.** It works, but only once the dev profile sets
   `openidm.fileinstall.enabled=true`; ForgeOps ships it `false`. The risk
   table has recorded this as retired since Phase 0 and this list did not,
   which is the contradiction the doc pass found.
2. **FQDN strategy** (section 7) — `<env>.localhost` with an `nip.io` fallback,
   pending a real resolution test on macOS.
3. ~~**DS access logs** in the collector (section 9)~~ — **answered
   2026-08-25, premise disproved.** PingDS is the quietest component, not the
   loudest; the noise is kubelet health probes. See section 9.
4. **Where the package registry lives** (section 8.1) — in-repo until there is
   a second consumer.
5. **`tsgo` on aarch64-darwin** — added 2026-08-26 with D11. The
   `importNpmLock` path is proven on x86_64-linux: it builds, honours the
   lockfile's `cpu`/`os` gating (fetches all seven platform tarballs, installs
   one), and the binary runs on NixOS without patchelf because Go links
   statically. The darwin derivation **evaluates** but has never been built or
   run — same class of gap as the macOS FQDN item above, and it should be
   closed by the same first run on a Mac.

### Backlog, not scheduled

- ~~**Narrow at the JSON boundary**~~ — **done 2026-08-26**, see Phase 6.2.

### Phase 6.5 — the failure-conversion audit — **DONE**

Three separate defects this sprint had the same shape: a tool that could not
run became a confident negative. `getPods` turned an unreadable API server into
an empty namespace, `clusterExists` turned a stopped Docker daemon into "no
cluster", and the use-site checker's lib-file path match turned "found nothing"
and "cannot find anything" into the same green tick. So rather than wait for
the next review to find the fourth, codex was asked to trace every
`allowFailure` and empty-result conversion in `tools/fo`. It found seven more.

- **`fo amster` exited zero on timeout**, so a config import that never
  finished reported success. `--timeout 0` was worse: it polled zero times and
  returned immediately. It now means "no deadline", as it does everywhere else
  in this CLI. (`fo up` does not use this path — it waits on the chart's own
  post-install hook — but `fo amster` and the watcher do, and a timeout is
  reported as UNCONFIRMED rather than as "not imported", because the job may be
  partly applied or about to finish.)
- **`fo amster` also folded two unreadable-cluster cases into "keep going".**
  The initial job lookup treated any failure as an empty list, and the polling
  GET treated any failure as "not visible yet" — burning the whole timeout and
  then blaming the job. Both comments already claimed the distinction the code
  did not make.
- **`fo sync` had two false-success paths.** `podName()` folded every kubectl
  failure into "no pod", `syncIdm` warned and returned false, and `main.ts`
  discarded the return value — so a dead API server exited zero having pushed
  nothing. And orphan retirement explicitly ignored its `kubectl exec` failure,
  so the files could copy, the deleted endpoint stay live, and `fo sync` print
  "synced". That is the stale-endpoint bug phase 6 fixed, reintroduced by one
  line that decided not to look.
- **`fo info --json` printed empty credentials and exited zero** against a
  cluster it could not read. `fo shell` and `fo restart` reported "no pod" and
  "no workload" for the same reason. All four now use `--ignore-not-found`,
  which is the distinction `allowFailure: true` throws away: absence is exit
  zero and empty output, and everything else is a failure.
- **`fo doctor` reported checks green when their tools were missing.** `ss` and
  `free` are Linux-only, neither is in `runtimeTools`, and both pipelines end in
  `2>/dev/null` — so on a machine without them the output was empty, empty read
  as "nothing is listening", and a preflight that could not look said "ports
  free". Checks can answer `unknown` now, which warns and never prints `ok`.
- **Filesystem reads treated unreadable as empty.** `copyTree` and `fileCount`
  caught every `readdirSync` error, so a permission problem built an IDM profile
  with the authored config silently missing. Absence is `existsSync`; everything
  else propagates.
- **The census followed only `tsconfig.json`.** One shared measurement covering
  both engines is the premise of the whole audit, and nothing checked that the
  two runtime programs still pin the same `lib` — an entry added to
  `tsconfig.am.json` would be type-checked against and never probed.
  `sharedRuntimeLibs()` asserts it, and the seed, manifest, coverage gate and
  test all read through it.

The seven sites were fixed individually. There is no abstraction quietly
enforcing this, and an earlier draft of these notes claimed one — a predicate
form of `allowFailure` was added and removed within the same sprint, because it
had no call sites and `stream()` ignored it. Unused scaffolding that *looks*
like a policy is worse than a comment admitting it is one.

What there is instead: `lib/k8s.ts` grew `getOptional()` for the “named
resource that may not exist” case, which covers most of them, and
`allowFailure`'s doc comment names the defects that came from reaching for it
and spells out the three questions to ask first — is this a list query (exits
zero when empty, so there is nothing to allow), a named get (wants
`--ignore-not-found`), or genuinely best-effort (the only case that qualifies)?

Verified by pointing the kubeconfig at a dead port: `fo sync`, `fo info`,
`fo shell`, `fo restart` and `fo status` all exit non-zero with the runtime's
own error, where four of them previously exited zero.

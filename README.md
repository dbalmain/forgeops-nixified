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

## Environments

`--env NAME` (default `dev`) is one flag that derives everything: the namespace,
the FQDN `NAME.localhost`, and the state directory `.fo/NAME/`. One k3d cluster,
many namespaces. If you never type it, you never see it.

```sh
fo up --env feature-x     # https://feature-x.localhost
```

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
```

## Status

Phase 1 of [PLAN.md](PLAN.md): a developer can get a stack. Tilt and the
hot-reload inner loop (Phase 2), the TypeScript endpoint framework (Phase 3),
and config round-tripping (Phase 4) are not built yet — though the IDM dev
profile `fo` builds already enables the file watcher that Phase 2 depends on.

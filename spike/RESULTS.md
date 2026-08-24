# Phase 0 spike — results

Run 2026-08-25 on NixOS, 22 cores / 30 GB, Docker 29.6.2.
**Verdict: GO.** k3d works. Every assumption in `PLAN.md` is now either
confirmed or has a concrete, known fix.

## What was proved

| Assumption | Result |
| ---------- | ------ |
| ForgeOps 2026.3 comes up on k3d | **Yes.** All 10 pods Running/Completed, amster job succeeded |
| Traefik (k3s built-in) serves the platform ingress | **Yes.** `https://dev.localhost/am/` → 200 with **plain curl** — no `/etc/hosts`, no `--resolve`, no `minikube tunnel` |
| local-path aliased to a `fast` StorageClass satisfies DS | **Yes.** `ds-idrepo-0` and `ds-cts-0` both Running |
| Helm-generated secrets remove the operator | **Yes.** No secret-agent, no secret-generator. cert-manager is the *only* prereq |
| **IDM hot-reloads config synced into a running pod** | **Yes — but only after a change we must make.** See below |

## Timings and footprint

| Metric | Measured |
| ------ | -------- |
| `k3d cluster create` | **35 s** |
| cert-manager install (v1.21.1) | **26 s** |
| Cold image pull (7 platform images) | 2.8 GB |
| `k3d image import` of those | 40 s |
| Helm install → amster job complete | **~7 min** (AM is the long pole) |
| **Actual memory in use, whole stack** | **4.4 GiB** (vs 6.5 GiB of *requests*) |
| Disk under `/var/lib/rancher/k3s` | 6.1 GB (includes imported images) |

4.4 GiB actual is materially better than the 6.5 GiB of requests the plan
budgeted for. A 16 GB laptop is comfortable, not marginal.

## Three findings that change the plan

### 1. IDM's file watcher ships DISABLED

`/opt/openidm/conf/system.properties` line 14:

```properties
openidm.fileinstall.enabled=false
```

So out of the box, a file synced into a running IDM pod is **ignored** — the
plan's headline inner loop does not work as ForgeOps ships it. This was the
biggest risk in `PLAN.md` and it was, as written, wrong.

It is a *setting*, not a constraint. Rebuilding the config profile with
`openidm.fileinstall.enabled=true` and rolling IDM once makes it work:

| Test | Result |
| ---- | ------ |
| New `conf/schedule-*.json` written into the running pod | picked up in **< 5 s**, 0 restarts |
| Changed `script/*.js` written into the running pod | picked up in **~15 s**, 0 restarts |

Both verified by a 5-second scheduler invoking a script that logs a version
marker, then changing the marker — no HTTP auth involved.

The 15 s for scripts is `conf/script.json`:

```json
"javascript.recompile.minimumInterval" : 60000
```

Lowering that in the dev profile should take script reload to near-instant.

**Consequence for the plan**: `fo` owns a **dev config profile** that differs
from a production profile by exactly two properties — `fileinstall.enabled` and
the recompile interval. That is a good shape: the difference is explicit,
tiny, reviewable, and obviously not for production.

### 2. The published Helm chart 2026.3.0 is broken out of the box

The chart-publishing script blanket-rewrites **every** `tag:` field to the
release tag, including third-party images:

```yaml
ssh_keygen:
  initImage:
    repository: dockette/ssh
    tag: "2026.3.0-1849"   # this tag does not exist
```

`dockette/ssh` publishes only `latest`. So `helm install identity-platform
--version 2026.3.0` fails: `ssh-keygen` → `ImagePullBackOff` → no `amster`
secret → AM blocks on `FailedMount` → amster never runs. Nothing in the error
points at the cause.

Required override:

```yaml
ssh_keygen:
  initImage: { tag: "latest" }
  image:     { tag: "1.36.1" }   # kubectl:2026.3.0-1849 also does not exist
```

This is a good advertisement for D2 (own the values generation): `fo` pins
these explicitly and the bug never reaches a developer.

### 3. Two incompatible image tagging schemes

The docs tell you to use the product version (`8.1.1`). The published chart
pins `<forgeops-release>-<build>` (`2026.3.0-1849`). **These are different
builds:**

```text
am:8.1.1           sha256:af04bf72f1e6ebb39026a4f947d75c5f9ff938b8b6d931da7dfa54b4ec938e99
am:2026.3.0-1849   sha256:97847e79b05a7542c501ad5df052f5ffc958d9d35eb220a1c6bb30c368c1ff10
```

`fo` must pin the **chart's** scheme — that is the combination ForgeOps tested.
(The spike itself ran on `8.1.1` and worked, but that is luck, not a guarantee.)

## Still open

- **macOS `*.localhost` resolution.** Confirmed working on NixOS via
  systemd-resolved, and k3d binds both IPv4 and IPv6. Untested on macOS; the
  `nip.io` fallback in `PLAN.md` section 7 stays.
- **k3s version.** k3d 5.9.0 defaults to k3s v1.32.5, while ForgeOps validates
  kubectl 1.36.1. Nothing failed, but `fo` should pin a newer k3s image and
  re-verify.
- **IDM auth for `fo config export`.** Header auth is disabled in ForgeOps
  (403) and `client_credentials` on `idm-provisioning` was rejected (401). The
  working path needs finding — likely the amster-created client with a
  different grant. Not a blocker for Phase 1.

## Reproducing

`values.yaml` and `idm-dev-profile/` in this directory are the working
artefacts, and are the seed for Phase 1's values generation.

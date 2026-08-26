import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, sleep, stream } from "../lib/proc.ts";
import { detail, die, heading, ok, step } from "../lib/ui.ts";
import { ensureCluster } from "../cluster/k3d.ts";
import { ensureCertManager, ensureNamespace, ensureStorageClass } from "../prereqs.ts";
import { buildAmProfile, buildIdmProfile } from "../profile.ts";
import { ensureSecrets } from "../secrets.ts";
import { buildValues, renderValues } from "../values.ts";
import { doctor } from "./doctor.ts";
import { ensureLogStack } from "./logstore.ts";
import { blockers, getPods, settled } from "./status.ts";
import { info } from "./info.ts";
import type { ResolvedConfig } from "../config.ts";

const RELEASE_NAME = "identity-platform";

/**
 * `fo up` is an idempotent converge, not a script: every step checks before it
 * acts, so re-running after a laptop sleep or a failed pull is the normal
 * recovery rather than a reinstall.
 */
export async function up(
  cfg: ResolvedConfig,
  opts: { timeoutSeconds: number },
): Promise<void> {
  heading(`fo up  ${cfg.env}`);

  if (!(await doctor(cfg))) {
    die("preflight failed - fix the items marked XX above and re-run");
  }

  await ensureCluster(cfg);
  ensureStorageClass(cfg);
  await ensureCertManager(cfg, { timeoutSeconds: opts.timeoutSeconds });
  ensureNamespace(cfg);
  ensureSecrets(cfg);

  const idmImage = cfg.components.includes("idm")
    ? await buildIdmProfile(cfg)
    : undefined;
  // Only built when platform/am/config exists, which it does not until
  // `fo config export am` has run. Until then PingAM boots from its own image.
  const amImage = cfg.components.includes("am")
    ? await buildAmProfile(cfg)
    : undefined;

  step("Generating Helm values");
  mkdirSync(cfg.stateDir, { recursive: true });
  const valuesPath = join(cfg.stateDir, "values.json");
  writeFileSync(
    valuesPath,
    renderValues(buildValues(cfg, { idm: idmImage, am: amImage })),
  );
  detail(valuesPath);

  step(`Deploying identity-platform`);
  detail("PingAM is the long pole; a first run also pulls about 2.8 GB");

  // Helm 4 defaults to `--wait hookOnly`, and the amster Job is a post-install
  // hook, so helm blocks until amster finishes - which cannot happen until AM
  // is serving. That is the signal we actually want, but the default 5m
  // timeout is shorter than a cold start, so raise it and report progress
  // ourselves rather than sitting silent.
  const ticker = startTicker(cfg);
  try {
    await stream(
      "helm",
      [
        "upgrade",
        "--install",
        RELEASE_NAME,
        cfg.chartPath,
        "--namespace",
        cfg.namespace,
        "--values",
        cfg.secretsValuesPath,
        "--values",
        valuesPath,
        // Helm 4 applies server-side, and `fo restart am` reaches in with
        // `kubectl set image` to swap the config-profile image between
        // deploys. That leaves the field owned by `kubectl-set`, and the next
        // `fo up` fails outright with a field-ownership conflict - a converge
        // that refuses to converge. Taking ownership back is right here:
        // `fo` regenerates the same image tag from the same content hash, so
        // Helm is reasserting a value it already agrees with.
        "--force-conflicts",
        "--timeout",
        // `--timeout 0s` is not "no deadline" to helm, so spell the unbounded
        // case as a ceiling no real install reaches rather than passing a
        // zero whose meaning we would be guessing at.
        opts.timeoutSeconds === 0 ? "24h" : `${opts.timeoutSeconds}s`,
      ],
      { env: { KUBECONFIG: cfg.kubeconfig } },
    );
  } finally {
    ticker.stop();
  }

  // After helm, because the collector is scoped to this namespace and the
  // store's Ingress reuses the chart's TLS secret - but BEFORE waitReady, so
  // the one wait below covers the log stack too.
  //
  // It used to be after. `fo up` then returned with the console still
  // Pending on its PVC and its image pull, having reported success and
  // printed a URL that 404s - and `fo trace` immediately after a `fo up`
  // failed with "no log store running". Caught by running the CI sequence
  // from a destroyed cluster, which is the only place the ordering shows.
  await ensureLogStack(cfg);

  // The caller's timeout, not a third hardcoded number. This was the last of
  // THREE waits in `fo up` and only one of them honoured `--timeout`; the
  // cert-manager one above was found by an e2e failure, and this one by
  // reading the log of the run that fixed it, which printed "up to 300s"
  // under a `--timeout` that was 900.
  //
  // It is the cheapest of the three to extend: helm has already returned, so
  // this is only covering the log stack and any pod still settling.
  await waitReady(cfg, opts.timeoutSeconds);
  info(cfg, false);
}

/** Report pod progress while helm waits on its hooks. */
function startTicker(cfg: ResolvedConfig): { stop: () => void } {
  let last = "";
  const t = setInterval(() => {
    const pods = getPods(cfg);
    if (pods.length === 0) return;
    const line = `${pods.filter(settled).length}/${pods.length} pods settled`;
    if (line !== last) {
      detail(line);
      last = line;
    }
  }, 15000);
  t.unref?.();
  return { stop: () => clearInterval(t) };
}

async function waitReady(
  cfg: ResolvedConfig,
  timeoutSeconds: number,
): Promise<void> {
  // 0 means "no deadline": an honest option for a first run on a slow link,
  // rather than making unbounded waiting the implicit default for everyone.
  const unbounded = timeoutSeconds === 0;
  step(
    unbounded
      ? "Waiting for pods (no deadline)"
      : `Waiting for pods (up to ${timeoutSeconds}s)`,
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastLine = "";
  while (unbounded || Date.now() < deadline) {
    const pods = getPods(cfg);
    if (pods.length > 0) {
      const done = pods.filter(settled).length;
      const line = `${done}/${pods.length} settled`;
      if (line !== lastLine) {
        detail(line);
        lastLine = line;
      }
      if (done === pods.length) {
        ok("all pods settled");
        return;
      }
      // Waiting out a deadline for something that cannot fix itself wastes
      // the developer's time and buries the real error under a timeout.
      const dead = blockers(pods).filter((b) => b.terminal);
      if (dead.length > 0) {
        for (const b of dead) detail(`${b.pod}: ${b.summary}`);
        showLogs(cfg, dead.map((b) => b.pod));
        die(
          `${dead[0]!.pod} cannot start: ${dead[0]!.summary}. ` +
            "Nothing was torn down; fix it and re-run `fo up`.",
        );
      }
    }
    await sleep(5000);
  }
  // A timeout is a FAILURE, even though the stack may well finish on its own a
  // minute later. `fo up` promises a working stack when it returns; Kubernetes
  // getting there afterwards does not make this invocation successful, and
  // returning zero here is what let the command print URLs and an admin
  // password for a stack that was not serving.
  //
  // Nothing is torn down: leaving the slow resources running is what makes
  // re-running cheap, and a re-run is the documented recovery.
  const left = blockers(getPods(cfg));
  for (const b of left) detail(`${b.pod}: ${b.summary}`);
  die(
    `timed out after ${timeoutSeconds}s with ${left.length} pod(s) not ready. ` +
      "They are still running - re-run `fo up` to keep waiting, use " +
      "`fo up --timeout 0` for no deadline, or see `fo status`.",
  );
}

/** The previous container's output, which is where a crash loop says why. */
function showLogs(cfg: ResolvedConfig, pods: string[]): void {
  for (const pod of pods.slice(0, 3)) {
    for (const previous of [true, false]) {
      const r = capture(
        "kubectl",
        [
          "-n",
          cfg.namespace,
          "logs",
          pod,
          "--tail=20",
          ...(previous ? ["--previous"] : []),
        ],
        { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
      );
      if (r.code === 0 && r.stdout.trim()) {
        detail(`${pod} logs${previous ? " (previous container)" : ""}:`);
        for (const l of r.stdout.trimEnd().split("\n")) detail(`  ${l}`);
        break;
      }
    }
  }
}

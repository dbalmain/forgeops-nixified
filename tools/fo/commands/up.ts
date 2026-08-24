import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, stream } from "../lib/proc.ts";
import { detail, die, heading, ok, step } from "../lib/ui.ts";
import { ensureCluster } from "../cluster/k3d.ts";
import { ensureCertManager, ensureNamespace, ensureStorageClass } from "../prereqs.ts";
import { buildIdmProfile } from "../profile.ts";
import { ensureSecrets } from "../secrets.ts";
import { buildValues, renderValues } from "../values.ts";
import { doctor } from "./doctor.ts";
import { getPods, settled } from "./status.ts";
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
  await ensureCertManager(cfg);
  ensureNamespace(cfg);
  ensureSecrets(cfg);

  const idmImage = cfg.components.includes("idm")
    ? await buildIdmProfile(cfg)
    : undefined;

  step("Generating Helm values");
  mkdirSync(cfg.stateDir, { recursive: true });
  const valuesPath = join(cfg.stateDir, "values.json");
  writeFileSync(valuesPath, renderValues(buildValues(cfg, idmImage)));
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
        "--timeout",
        `${opts.timeoutSeconds}s`,
      ],
      { env: { KUBECONFIG: cfg.kubeconfig } },
    );
  } finally {
    ticker.stop();
  }

  await waitReady(cfg, 300);
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
  step(`Waiting for pods (up to ${timeoutSeconds}s)`);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastLine = "";
  while (Date.now() < deadline) {
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
    }
    await sleep(5000);
  }
  // Not fatal: a slow image pull is the usual cause and the stack recovers on
  // its own. Say so rather than tearing anything down.
  detail("timed out waiting; check `fo status` - a slow pull will catch up");
}

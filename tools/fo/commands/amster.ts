import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capture, sleep } from "../lib/proc.ts";
import { kubeEnv, ns, q } from "../lib/k8s.ts";
import { detail, ok, step, warn } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Tier 2 of the inner loop: re-import amster config (journeys, OAuth2 clients,
 * services) into a running PingAM.
 *
 * The chart mounts an OPTIONAL configMap called `amster-config` at
 * `/opt/amster/config/amster-import.tar.gz` and never creates it - a documented
 * extension point that `fo` fills from `platform/amster/config/`.
 */

const JOB = "amster";

function configDir(cfg: ResolvedConfig): string {
  return join(cfg.root, "platform", "amster", "config");
}

function hasConfig(cfg: ResolvedConfig): boolean {
  const d = configDir(cfg);
  if (!existsSync(d)) return false;
  return (
    readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    ).length > 0
  );
}

/** Pack platform/amster/config into the configMap the amster job expects. */
export function packAmsterConfig(cfg: ResolvedConfig): boolean {
  if (!hasConfig(cfg)) {
    detail("platform/amster/config is empty; nothing to import");
    return false;
  }
  const d = configDir(cfg);
  const n = readdirSync(d, { recursive: true, withFileTypes: true }).filter(
    (e) => e.isFile(),
  ).length;

  // --from-file gives the configMap a binary entry under the exact key the
  // job's subPath mount looks for. Recreate rather than patch, so deleted
  // files actually disappear.
  capture(
    "sh",
    [
      "-c",
      `tar -C ${q(d)} -czf /tmp/fo-amster-import.tar.gz . && ` +
        `kubectl -n ${q(cfg.namespace)} create configmap amster-config ` +
        `--from-file=amster-import.tar.gz=/tmp/fo-amster-import.tar.gz ` +
        `--dry-run=client -o json | kubectl -n ${q(cfg.namespace)} apply -f -`,
    ],
    { env: kubeEnv(cfg) },
  );
  detail(`packed ${n} file${n === 1 ? "" : "s"} into configmap/amster-config`);
  return true;
}

/**
 * Clone the existing amster Job under a fresh name and run it.
 *
 * The Job is a Helm post-install hook, so it cannot simply be restarted: a
 * completed Job is immutable, and re-running it through Helm would mean a full
 * `helm upgrade`. Cloning strips the fields the API server generates and the
 * Helm hook annotations, so the copy is an ordinary Job that Helm ignores.
 */
export async function runAmster(
  cfg: ResolvedConfig,
  opts: { timeoutSeconds: number } = { timeoutSeconds: 300 },
): Promise<void> {
  step("Re-importing amster config");
  packAmsterConfig(cfg);

  const src = capture(
    "kubectl",
    ns(cfg, ["get", "job", "-l", "app=amster", "-o", "json"]),
    { env: kubeEnv(cfg), allowFailure: true },
  );
  let template: Record<string, unknown> | undefined;
  try {
    const items = (JSON.parse(src.stdout) as { items: Array<Record<string, unknown>> })
      .items;
    template = items[items.length - 1];
  } catch {
    /* fall through */
  }
  if (!template) {
    warn("no existing amster job to clone; run `fo up` first");
    return;
  }

  const name = `${JOB}-fo-${Date.now().toString(36)}`;
  const spec = template["spec"] as Record<string, unknown>;
  const pod = spec["template"] as { metadata: { labels?: Record<string, string> } };
  for (const k of [
    "controller-uid",
    "batch.kubernetes.io/controller-uid",
    "job-name",
    "batch.kubernetes.io/job-name",
  ]) {
    delete pod.metadata.labels?.[k];
  }
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: cfg.namespace, labels: { app: "amster", "fo/rerun": "true" } },
    spec: {
      backoffLimit: spec["backoffLimit"],
      ttlSecondsAfterFinished: 600,
      template: pod,
    },
  };

  capture("kubectl", ["apply", "-f", "-"], {
    env: kubeEnv(cfg),
    input: JSON.stringify(job),
  });
  detail(`job/${name} created`);

  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const r = capture(
      "kubectl",
      ns(cfg, ["get", "job", name, "-o", "jsonpath={.status.succeeded} {.status.failed}"]),
      { env: kubeEnv(cfg), allowFailure: true },
    );
    const [succeeded, failed] = r.stdout.trim().split(/\s+/);
    if (succeeded === "1") {
      ok("amster import complete");
      return;
    }
    if (failed && Number(failed) > 0) {
      warn(`job/${name} failed; see: fo logs amster`);
      return;
    }
    await sleep(3000);
  }
  warn(`job/${name} still running after ${opts.timeoutSeconds}s`);
}

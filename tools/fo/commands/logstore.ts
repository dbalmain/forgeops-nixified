import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, stream } from "../lib/proc.ts";
import { kubeEnv, ns } from "../lib/k8s.ts";
import { detail, ok, step, warn } from "../lib/ui.ts";
import {
  LOGS_NAME,
  VECTOR_NAME,
  clusterScopedNames,
  logStackManifests,
  logsUrl,
} from "../logstack.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Converge the tier-1 log stack to whatever `logs.backend` says, including
 * removing it when that is `off`.
 *
 * Removal on `off` matters more than it looks: without it, turning the console
 * back off in fo.config.ts would leave a Deployment, a DaemonSet and a PVC
 * running forever, and the "defaults off because RAM is the binding
 * constraint" promise would only hold for people who never turned it on.
 */
export async function ensureLogStack(cfg: ResolvedConfig): Promise<void> {
  if (cfg.logs.backend === "off") {
    removeLogStack(cfg, { quiet: true });
    return;
  }

  step(`Deploying the log console (${cfg.logs.backend})`);
  const manifests = logStackManifests(cfg);
  mkdirSync(cfg.stateDir, { recursive: true });
  const path = join(cfg.stateDir, "logstack.json");
  writeFileSync(
    path,
    JSON.stringify({ apiVersion: "v1", kind: "List", items: manifests }, null, 2) +
      "\n",
  );
  detail(path);

  await stream("kubectl", ns(cfg, ["apply", "-f", path]), {
    env: kubeEnv(cfg),
  });
  detail(`console: ${logsUrl(cfg)}`);
  detail(
    cfg.logs.includeHealthChecks
      ? "shipping kubelet health-probe traffic too"
      : "health probes excluded; set logs.includeHealthChecks to keep them",
  );
}

/**
 * Delete everything `ensureLogStack` creates.
 *
 * `quiet` is for the converge path, where "there was nothing to remove" is the
 * normal case and should not print anything.
 */
export function removeLogStack(
  cfg: ResolvedConfig,
  opts: { quiet?: boolean } = {},
): void {
  const del = (args: string[]) =>
    capture("kubectl", args, { env: kubeEnv(cfg), allowFailure: true });

  const namespaced = del(
    ns(cfg, [
      "delete",
      "deployment,daemonset,service,ingress,configmap,serviceaccount,pvc",
      "-l",
      "app.kubernetes.io/part-of=fo-logs",
      "--ignore-not-found",
    ]),
  );
  // Cluster-scoped objects carry no namespace, so they are named per-env
  // instead; deleting by label would take out another env's binding.
  const cluster = del([
    "delete",
    "clusterrole,clusterrolebinding",
    ...clusterScopedNames(cfg),
    "--ignore-not-found",
  ]);

  const touched = `${namespaced.stdout}${cluster.stdout}`.trim();
  if (!touched) {
    if (!opts.quiet) ok("no log console deployed");
    return;
  }
  step("Removing the log console");
  for (const line of touched.split("\n")) detail(line);
}

/** Is the store actually running? Used to give a useful error, not to gate. */
export function logStackReady(cfg: ResolvedConfig): boolean {
  const r = capture(
    "kubectl",
    ns(cfg, [
      "get",
      "deployment",
      LOGS_NAME,
      "-o",
      "jsonpath={.status.readyReplicas}",
    ]),
    { env: kubeEnv(cfg), allowFailure: true },
  );
  return r.code === 0 && Number(r.stdout.trim() || "0") > 0;
}

/** Warn, but do not fail, when the collector is not up. */
export function warnIfCollectorDown(cfg: ResolvedConfig): void {
  const r = capture(
    "kubectl",
    ns(cfg, [
      "get",
      "daemonset",
      VECTOR_NAME,
      "-o",
      "jsonpath={.status.numberReady}",
    ]),
    { env: kubeEnv(cfg), allowFailure: true },
  );
  if (r.code === 0 && Number(r.stdout.trim() || "0") === 0) {
    warn(`${VECTOR_NAME} has no ready pods; nothing is being collected`);
  }
}

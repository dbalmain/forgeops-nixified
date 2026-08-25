import { rmSync } from "node:fs";
import { capture, stream } from "../lib/proc.ts";
import { detail, ok, step } from "../lib/ui.ts";
import { clusterExists, deleteCluster } from "../cluster/k3d.ts";
import { removeLogStack } from "./logstore.ts";
import type { ResolvedConfig } from "../config.ts";

export async function down(
  cfg: ResolvedConfig,
  opts: { destroy: boolean },
): Promise<void> {
  if (opts.destroy) {
    await deleteCluster(cfg.clusterName);
    rmSync(cfg.stateDir, { recursive: true, force: true });
    ok("cluster and local state removed");
    return;
  }

  if (!clusterExists(cfg.clusterName)) {
    ok(`cluster ${cfg.clusterName} does not exist; nothing to do`);
    return;
  }

  // Before the namespace: the log collector's ClusterRole and
  // ClusterRoleBinding are cluster-scoped, so deleting the namespace leaves
  // them behind to accumulate one pair per env, forever.
  removeLogStack(cfg, { quiet: true });

  step(`Removing namespace ${cfg.namespace}`);
  detail("the cluster and cert-manager stay, so the next `fo up` is quick");
  await stream(
    "kubectl",
    ["delete", "namespace", cfg.namespace, "--ignore-not-found", "--wait=true"],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );

  const remaining = capture(
    "kubectl",
    ["get", "ns", "-o", "name"],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  ).stdout;
  ok(`${cfg.env} removed`);
  if (!/namespace\/(?!default|kube-|cert-manager)/.test(remaining)) {
    detail("no other fo environments left - `fo down --destroy` frees the rest");
  }
}

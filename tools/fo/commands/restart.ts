import { capture, stream } from "../lib/proc.ts";
import { kubeEnv, ns } from "../lib/k8s.ts";
import { die, step } from "../lib/ui.ts";
import { POD_SELECTOR, type Component } from "../config.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Tier 3: roll a component. The slow tier, and the only option for PingAM,
 * whose config is read at startup.
 */
export async function restart(
  cfg: ResolvedConfig,
  component: string,
): Promise<void> {
  if (!POD_SELECTOR[component as Component]) {
    die(
      `unknown component "${component}". one of: ${Object.keys(POD_SELECTOR).join(", ")}`,
    );
  }
  // Deployments and StatefulSets both take `rollout restart`; find which.
  const kind = capture(
    "kubectl",
    ns(cfg, ["get", "deployment,statefulset", "-l", `app=${component}`, "-o", "name"]),
    { env: kubeEnv(cfg), allowFailure: true },
  ).stdout.trim().split("\n")[0];
  if (!kind) die(`no deployment or statefulset for ${component}`);

  step(`Restarting ${kind}`);
  await stream("kubectl", ns(cfg, ["rollout", "restart", kind]), {
    env: kubeEnv(cfg),
  });
  await stream("kubectl", ns(cfg, ["rollout", "status", kind, "--timeout=5m"]), {
    env: kubeEnv(cfg),
  });
}

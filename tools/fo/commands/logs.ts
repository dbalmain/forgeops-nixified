import { stream } from "../lib/proc.ts";
import { die } from "../lib/ui.ts";
import { POD_SELECTOR, type Component, type ResolvedConfig } from "../config.ts";

/**
 * Tier 0 of the log story (PLAN.md section 9): live multi-pod tail, zero
 * cluster footprint. Indexed search over history is `fo logs search`, which
 * needs the opt-in tier-1 store - see commands/trace.ts.
 */
export async function logs(
  cfg: ResolvedConfig,
  component: string | undefined,
  extra: string[],
): Promise<void> {
  const args = ["-n", cfg.namespace];
  if (component) {
    const sel = POD_SELECTOR[component as Component];
    if (!sel) {
      die(
        `unknown component "${component}". one of: ${Object.keys(POD_SELECTOR).join(", ")}`,
      );
    }
    args.push("--selector", sel);
  } else {
    args.push(".");
  }
  await stream("stern", [...args, ...extra], {
    env: { KUBECONFIG: cfg.kubeconfig },
  });
}

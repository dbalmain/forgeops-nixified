import { capture, stream } from "../lib/proc.ts";
import { die } from "../lib/ui.ts";
import { POD_SELECTOR, type Component, type ResolvedConfig } from "../config.ts";

/** Container to attach to when a pod runs more than one. */
const CONTAINER: Partial<Record<Component, string>> = {
  am: "openam",
  idm: "openidm",
};

export async function shell(
  cfg: ResolvedConfig,
  component: string,
  cmd: string[],
): Promise<void> {
  const sel = POD_SELECTOR[component as Component];
  if (!sel) {
    die(
      `unknown component "${component}". one of: ${Object.keys(POD_SELECTOR).join(", ")}`,
    );
  }
  // A LIST query matching nothing exits zero with empty output, so there is no
  // failure to allow: a non-zero exit means the cluster could not be read, and
  // reporting that as "no running pod" pointed the reader at the wrong thing.
  const r = capture(
    "kubectl",
    ["-n", cfg.namespace, "get", "pod", "-l", sel, "-o", "jsonpath={.items[0].metadata.name}"],
    { env: { KUBECONFIG: cfg.kubeconfig } },
  );
  const pod = r.stdout.trim();
  if (!pod) die(`no running pod for ${component} in namespace ${cfg.namespace}`);

  const container = CONTAINER[component as Component];
  await stream(
    "kubectl",
    [
      "-n",
      cfg.namespace,
      "exec",
      // -t only when we actually have a terminal, so `fo shell x -- cmd` works
      // in a script or CI without kubectl refusing.
      ...(process.stdin.isTTY ? ["-it"] : ["-i"]),
      pod,
      ...(container ? ["-c", container] : []),
      "--",
      ...(cmd.length > 0 ? cmd : ["sh"]),
    ],
    { env: { KUBECONFIG: cfg.kubeconfig } },
  );
}

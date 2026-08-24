import { capture } from "../lib/proc.ts";
import { dim, green, heading, red, table, yellow } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

type Pod = {
  metadata: { name: string };
  status: {
    phase: string;
    containerStatuses?: Array<{ ready: boolean; restartCount: number }>;
  };
};

export function getPods(cfg: ResolvedConfig): Pod[] {
  const r = capture(
    "kubectl",
    ["-n", cfg.namespace, "get", "pods", "-o", "json"],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );
  if (r.code !== 0) return [];
  try {
    return (JSON.parse(r.stdout) as { items: Pod[] }).items;
  } catch {
    return [];
  }
}

/** A pod is settled when it is Running and ready, or has Succeeded (a Job). */
export function settled(p: Pod): boolean {
  if (p.status.phase === "Succeeded") return true;
  if (p.status.phase !== "Running") return false;
  const cs = p.status.containerStatuses ?? [];
  return cs.length > 0 && cs.every((c) => c.ready);
}

export function status(cfg: ResolvedConfig): void {
  const pods = getPods(cfg);
  heading(`${cfg.env}  ${dim(`namespace ${cfg.namespace}`)}`);
  if (pods.length === 0) {
    console.log(`   ${dim("nothing deployed. try: fo up")}`);
    return;
  }
  table(
    pods.map((p) => {
      const cs = p.status.containerStatuses ?? [];
      const ready = `${cs.filter((c) => c.ready).length}/${cs.length}`;
      const restarts = cs.reduce((n, c) => n + c.restartCount, 0);
      const phase = settled(p)
        ? green(p.status.phase)
        : p.status.phase === "Failed"
          ? red(p.status.phase)
          : yellow(p.status.phase);
      return [
        p.metadata.name,
        `${ready}  ${phase}${restarts > 0 ? dim(`  ${restarts} restarts`) : ""}`,
      ] as [string, string];
    }),
  );
}

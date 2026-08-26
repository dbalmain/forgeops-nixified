import { capture } from "../lib/proc.ts";
import { arrayOf, bool, decode, num, obj, opt, str } from "../lib/shape.ts";
import { dim, green, heading, red, table, yellow } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * `state` and `lastState` are here so a wait can tell a pod that is still
 * arriving from one that is never going to. Both are optional: a pod that has
 * not been scheduled yet has no container statuses at all.
 */
const CONTAINER_STATE = obj({
  waiting: opt(obj({ reason: opt(str), message: opt(str) })),
  terminated: opt(obj({ reason: opt(str), exitCode: opt(num) })),
});

const POD_LIST = obj({
  items: arrayOf(
    obj({
      metadata: obj({ name: str }),
      status: obj({
        phase: str,
        containerStatuses: opt(
          arrayOf(
            obj({
              name: opt(str),
              ready: bool,
              restartCount: num,
              state: opt(CONTAINER_STATE),
              lastState: opt(CONTAINER_STATE),
            }),
          ),
        ),
      }),
    }),
  ),
});

export type Pod = ReturnType<typeof POD_LIST>["items"][number];

export function getPods(cfg: ResolvedConfig): Pod[] {
  const r = capture(
    "kubectl",
    ["-n", cfg.namespace, "get", "pods", "-o", "json"],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );
  // A non-zero exit is the ordinary "nothing deployed yet" case and stays
  // quiet. Output we cannot read is NOT that case, and used to be swallowed
  // into the same empty list - so `fo status` would report an empty cluster
  // and `waitReady` would wait for pods it could no longer see.
  if (r.code !== 0) return [];
  return decode(r.stdout, "kubectl get pods", POD_LIST).items;
}

/** A pod is settled when it is Running and ready, or has Succeeded (a Job). */
export function settled(p: Pod): boolean {
  if (p.status.phase === "Succeeded") return true;
  if (p.status.phase !== "Running") return false;
  const cs = p.status.containerStatuses ?? [];
  return cs.length > 0 && cs.every((c) => c.ready);
}

/**
 * States a wait must not sit through.
 *
 * Deliberately short. Every entry here is a configuration mistake that cannot
 * fix itself: the image name is not a name, or the container's env/volume
 * references do not resolve. An image that is merely slow, a pod that is
 * Pending on a PVC, and ordinary scheduling are all NOT here - they recover on
 * their own and belong to the deadline instead.
 *
 * CrashLoopBackOff is deliberately absent. A container that crashes while it
 * waits for a dependency is normal on a cold stack - PingAM against PingDS is
 * exactly that shape - so it is judged by repetition below, not on sight.
 */
const TERMINAL_WAITING = new Set([
  "InvalidImageName",
  "CreateContainerConfigError",
  "ErrImageNeverPull",
]);

/** How many identical restarts before a crash loop stops being a phase. */
const CRASHLOOP_RESTARTS = 3;

export type Blocker = {
  pod: string;
  /** terminal: give up now. waiting: keep waiting until the deadline. */
  terminal: boolean;
  summary: string;
};

/**
 * Why a pod is not settled, and whether waiting longer could possibly help.
 */
export function blocker(p: Pod): Blocker | undefined {
  if (settled(p)) return undefined;
  const name = p.metadata.name;

  if (p.status.phase === "Failed") {
    return { pod: name, terminal: true, summary: "phase Failed" };
  }

  for (const c of p.status.containerStatuses ?? []) {
    if (c.ready) continue;
    const reason = c.state?.waiting?.reason;
    if (reason && TERMINAL_WAITING.has(reason)) {
      const msg = c.state?.waiting?.message;
      return {
        pod: name,
        terminal: true,
        summary: msg ? `${reason}: ${msg}` : reason,
      };
    }
    if (reason === "CrashLoopBackOff" && c.restartCount >= CRASHLOOP_RESTARTS) {
      const last = c.lastState?.terminated;
      const why = last?.reason
        ? `${last.reason}${last.exitCode === undefined ? "" : ` (exit ${last.exitCode})`}`
        : "no exit status recorded";
      return {
        pod: name,
        terminal: true,
        summary: `CrashLoopBackOff after ${c.restartCount} restarts, last ${why}`,
      };
    }
    if (reason) {
      return { pod: name, terminal: false, summary: reason };
    }
  }

  return { pod: name, terminal: false, summary: `phase ${p.status.phase}` };
}

/** Every reason the namespace is not ready, terminal ones first. */
export function blockers(pods: Pod[]): Blocker[] {
  const found = pods.map(blocker).filter((b): b is Blocker => b !== undefined);
  return [...found].sort((a, b) => Number(b.terminal) - Number(a.terminal));
}

export function status(cfg: ResolvedConfig): void {
  const pods = getPods(cfg);
  heading(`${cfg.env}  ${dim(`namespace ${cfg.namespace}`)}`);
  if (pods.length === 0) {
    console.log(`   ${dim("nothing deployed. try: fo up")}`);
    // Nonzero, because a status command that cannot fail is useless as a
    // gate - and CI uses this one as exactly that.
    process.exitCode = 1;
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

  const unready = blockers(pods);
  if (unready.length > 0) {
    console.log(
      `   ${dim(`${unready.length} pod(s) not ready. try: fo up`)}`,
    );
    process.exitCode = 1;
  }
}

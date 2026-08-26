import { capture } from "../lib/proc.ts";
import { VECTOR_NAME } from "../logstack.ts";
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

const CONTAINER_STATUS = obj({
  name: opt(str),
  ready: bool,
  restartCount: num,
  state: opt(CONTAINER_STATE),
  lastState: opt(CONTAINER_STATE),
});

const POD_LIST = obj({
  items: arrayOf(
    obj({
      metadata: obj({ name: str }),
      status: obj({
        phase: str,
        containerStatuses: opt(arrayOf(CONTAINER_STATUS)),
        // Init containers are where a misconfigured volume or a bad image
        // shows up FIRST, and leaving them undecoded meant a pod wedged in
        // `Init:CreateContainerConfigError` reported only "phase Pending" and
        // waited out the whole deadline.
        initContainerStatuses: opt(arrayOf(CONTAINER_STATUS)),
      }),
    }),
  ),
});

export type Pod = ReturnType<typeof POD_LIST>["items"][number];

/**
 * The one non-zero `kubectl` exit that honestly means "nothing deployed yet".
 *
 * Everything else - an expired credential, an unreachable API server, a
 * kubeconfig pointing at a cluster that no longer exists - used to be folded
 * into the same empty list. `fo status` then printed "nothing deployed. try:
 * fo up" for a broken connection, and `waitReady` sat in a loop over zero pods
 * until its deadline, because an empty namespace and an unusable cluster
 * looked identical.
 *
 * An empty namespace that DOES exist exits zero with `{"items": []}`, so this
 * only covers the window before `fo up` creates it.
 */
function isMissingNamespace(stderr: string): boolean {
  return /namespaces? "[^"]*" not found/i.test(stderr);
}

export function getPods(cfg: ResolvedConfig): Pod[] {
  const r = capture(
    "kubectl",
    ["-n", cfg.namespace, "get", "pods", "-o", "json"],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );
  if (r.code !== 0) {
    if (isMissingNamespace(r.stderr)) return [];
    throw new Error(
      `kubectl get pods -n ${cfg.namespace} exited ${r.code}. This is not an ` +
        "empty namespace - the cluster could not be read, so nothing here " +
        `knows what is running:\n${(r.stderr || r.stdout).trimEnd()}`,
    );
  }
  return decode(r.stdout, "kubectl get pods", POD_LIST).items;
}

/* --------------------------------------------------------------- workloads */

/**
 * Deployments, StatefulSets, DaemonSets and Jobs, with just the two numbers
 * that say whether each one arrived.
 *
 * Requesting several kinds at once returns a `List` whose items each carry
 * their own `kind`, which is what lets one decode cover all four.
 */
const WORKLOAD_LIST = obj({
  items: arrayOf(
    obj({
      kind: str,
      metadata: obj({ name: str }),
      spec: opt(
        obj({
          replicas: opt(num),
          completions: opt(num),
          suspend: opt(bool),
        }),
      ),
      status: opt(
        obj({
          readyReplicas: opt(num),
          desiredNumberScheduled: opt(num),
          numberReady: opt(num),
          succeeded: opt(num),
        }),
      ),
    }),
  ),
});

export type WorkloadGap = { what: string; have: number; want: number };

/**
 * DaemonSets this project deploys and promises will run somewhere.
 *
 * Kubernetes is right that a DaemonSet desiring zero pods is not unhealthy --
 * it just has no eligible node. For a collector we installed and told the
 * developer about, "no eligible node" is a failure, not a shrug.
 *
 * Derived from the config rather than named: the string comes from
 * `logstack.ts`, so it cannot drift from what is actually deployed, and it is
 * only expected while the log console is ON. Otherwise a leftover `fo-vector`
 * from before `logs.backend: off` would be held to a promise nobody is making
 * any more.
 */
function expectedOnEveryNode(cfg: ResolvedConfig): ReadonlySet<string> {
  return cfg.logs.backend === "off" ? new Set() : new Set([VECTOR_NAME]);
}

/**
 * Workloads that have not produced everything they were asked for.
 *
 * WHY THIS EXISTS ALONGSIDE THE POD CHECK. `waitReady` used to ask only
 * whether every pod that currently EXISTS is settled, and a Deployment that
 * produced no pod at all - an unschedulable node selector, a quota rejection,
 * a controller that has not reconciled yet - contributes no pod to be unready.
 * With the rest of the stack up, `done === pods.length` held, `fo up` printed
 * URLs and exited zero, and the missing component was discovered by using it.
 *
 * Counting from the workload side is what closes that: a Deployment wanting
 * one ready replica and having none is a gap whether or not a pod exists.
 */
export function workloadGaps(cfg: ResolvedConfig): WorkloadGap[] {
  const r = capture(
    "kubectl",
    [
      "-n",
      cfg.namespace,
      "get",
      "deployments,statefulsets,daemonsets,jobs",
      "-o",
      "json",
    ],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );
  if (r.code !== 0) {
    if (isMissingNamespace(r.stderr)) return [];
    throw new Error(
      `kubectl get workloads -n ${cfg.namespace} exited ${r.code}:\n` +
        (r.stderr || r.stdout).trimEnd(),
    );
  }

  return gapsIn(
    decode(r.stdout, "kubectl get workloads", WORKLOAD_LIST).items,
    expectedOnEveryNode(cfg),
  );
}

type Workload = ReturnType<typeof WORKLOAD_LIST>["items"][number];

/**
 * The classification, separated from the `kubectl` call so it can be tested.
 *
 * The case that matters has no pod in it at all, which makes it impossible to
 * reach through anything that starts from a pod list.
 */
export function gapsIn(
  items: Workload[],
  expected: ReadonlySet<string> = new Set(),
): WorkloadGap[] {
  const gaps: WorkloadGap[] = [];
  for (const item of items) {
    const what = `${item.kind}/${item.metadata.name}`;
    if (item.kind === "DaemonSet") {
      // A DaemonSet's desired count comes from the scheduler, not the spec, so
      // zero eligible nodes is zero wanted rather than a gap -- EXCEPT for one
      // we put there ourselves and promised would run. `fo-vector` scheduling
      // nowhere means the log console collects nothing, and reporting that as
      // healthy is the same false success this function exists to stop.
      const want = Math.max(
        item.status?.desiredNumberScheduled ?? 0,
        expected.has(item.metadata.name) ? 1 : 0,
      );
      const have = item.status?.numberReady ?? 0;
      if (have < want) gaps.push({ what, have, want });
    } else if (item.kind === "Job") {
      // A suspended Job is not trying to run and must not hold up a wait.
      if (item.spec?.suspend === true) continue;
      const want = item.spec?.completions ?? 1;
      const have = item.status?.succeeded ?? 0;
      if (have < want) gaps.push({ what, have, want });
    } else {
      // `replicas` defaults to 1 when omitted, and `readyReplicas` is ABSENT
      // rather than zero when nothing is ready - which is exactly the shape a
      // Deployment that produced no pod at all has.
      const want = item.spec?.replicas ?? 1;
      const have = item.status?.readyReplicas ?? 0;
      if (have < want) gaps.push({ what, have, want });
    }
  }
  return gaps;
}

export function formatGap(g: WorkloadGap): string {
  return `${g.what}: ${g.have}/${g.want} ready`;
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

/** How many restarts DURING THIS WAIT before a crash loop stops being a phase. */
const CRASHLOOP_RESTARTS = 3;

/**
 * What each container's restart count was when the current wait began.
 *
 * `restartCount` is a pod's lifetime total, so judging a crash loop on it
 * directly declared any pod that had ever restarted three times terminal the
 * instant `fo up` looked at it - including a healthy pod restarted by a node
 * drain last week, and including the second `fo up` after a first one that
 * legitimately waited through PingAM's startup crashes. Snapshot the counts at
 * the start of a wait and judge the DELTA.
 *
 * `fo status` passes none, which reports lifetime counts. That is the right
 * reading for a report: it has no deadline to cut short.
 */
export type RestartBaseline = ReadonlyMap<string, number>;

export function restartBaseline(pods: Pod[]): RestartBaseline {
  const baseline = new Map<string, number>();
  for (const p of pods) {
    for (const c of allContainerStatuses(p)) {
      baseline.set(`${p.metadata.name}/${c.name ?? ""}`, c.restartCount);
    }
  }
  return baseline;
}

/**
 * Init containers first, then app containers.
 *
 * Order matters: a pod stuck in `Init:ImagePullBackOff` has no app container
 * status at all, and one whose init step failed should report the init step.
 */
function allContainerStatuses(p: Pod) {
  return [
    ...(p.status.initContainerStatuses ?? []),
    ...(p.status.containerStatuses ?? []),
  ];
}

export type Blocker = {
  pod: string;
  /** terminal: give up now. waiting: keep waiting until the deadline. */
  terminal: boolean;
  summary: string;
};

/**
 * Why a pod is not settled, and whether waiting longer could possibly help.
 */
export function blocker(p: Pod, baseline?: RestartBaseline): Blocker | undefined {
  if (settled(p)) return undefined;
  const name = p.metadata.name;

  if (p.status.phase === "Failed") {
    return { pod: name, terminal: true, summary: "phase Failed" };
  }

  const initNames = new Set(
    (p.status.initContainerStatuses ?? []).map((c) => c.name),
  );
  for (const c of allContainerStatuses(p)) {
    if (c.ready) continue;
    // An init container that ran to completion reports terminated/Completed
    // and `ready: false`; that is success, not a blocker.
    if (
      initNames.has(c.name) &&
      c.state?.terminated?.exitCode === 0
    ) {
      continue;
    }
    const where = initNames.has(c.name) ? `init ${c.name ?? "?"}: ` : "";
    const reason = c.state?.waiting?.reason;
    if (reason && TERMINAL_WAITING.has(reason)) {
      const msg = c.state?.waiting?.message;
      return {
        pod: name,
        terminal: true,
        summary: where + (msg ? `${reason}: ${msg}` : reason),
      };
    }
    const since =
      c.restartCount - (baseline?.get(`${name}/${c.name ?? ""}`) ?? 0);
    if (reason === "CrashLoopBackOff" && since >= CRASHLOOP_RESTARTS) {
      const last = c.lastState?.terminated;
      const why = last?.reason
        ? `${last.reason}${last.exitCode === undefined ? "" : ` (exit ${last.exitCode})`}`
        : "no exit status recorded";
      return {
        pod: name,
        terminal: true,
        summary:
          where +
          `CrashLoopBackOff after ${since} restarts` +
          (since === c.restartCount ? "" : ` this wait (${c.restartCount} total)`) +
          `, last ${why}`,
      };
    }
    if (reason) {
      return { pod: name, terminal: false, summary: where + reason };
    }
  }

  return { pod: name, terminal: false, summary: `phase ${p.status.phase}` };
}

/** Every reason the namespace is not ready, terminal ones first. */
export function blockers(pods: Pod[], baseline?: RestartBaseline): Blocker[] {
  const found = pods
    .map((p) => blocker(p, baseline))
    .filter((b): b is Blocker => b !== undefined);
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

  // Not just the pods. A Deployment that produced NO pod contributes nothing
  // unready, so `fo status` exited zero for a stack missing a component while
  // README described it as an "anything unready" gate. `waitReady` was fixed
  // and this was not, which left the two disagreeing about the same cluster.
  const short = workloadGaps(cfg);
  for (const g of short) console.log(`   ${yellow(formatGap(g))}`);

  const unready = blockers(pods);
  if (unready.length > 0 || short.length > 0) {
    const parts = [];
    if (unready.length > 0) parts.push(`${unready.length} pod(s) not ready`);
    if (short.length > 0) parts.push(`${short.length} workload(s) short`);
    console.log(`   ${dim(`${parts.join(", ")}. try: fo up`)}`);
    process.exitCode = 1;
  }
}

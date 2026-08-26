import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  blocker,
  blockers,
  gapsIn,
  restartBaseline,
  settled,
} from "../commands/status.ts";
import type { Pod } from "../commands/status.ts";

type Container = {
  name?: string;
  ready: boolean;
  restartCount: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; exitCode?: number };
  };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
};

function pod(
  name: string,
  phase: string,
  containers: Container[] = [],
  initContainers: Container[] = [],
): Pod {
  return {
    metadata: { name },
    status: {
      phase,
      containerStatuses: containers,
      initContainerStatuses: initContainers,
    },
  } as unknown as Pod;
}

const waiting = (reason: string, extra: Partial<Container> = {}): Container => ({
  ready: false,
  restartCount: 0,
  state: { waiting: { reason } },
  ...extra,
});

test("a settled pod has no blocker at all", () => {
  const running = pod("am-0", "Running", [{ ready: true, restartCount: 0 }]);
  assert.equal(settled(running), true);
  assert.equal(blocker(running), undefined);
  assert.equal(blocker(pod("amster-1", "Succeeded")), undefined);
});

test("a configuration mistake is terminal, because waiting cannot fix it", () => {
  for (const reason of ["InvalidImageName", "CreateContainerConfigError", "ErrImageNeverPull"]) {
    const b = blocker(pod("am-0", "Pending", [waiting(reason)]));
    assert.equal(b?.terminal, true, reason);
    assert.match(b!.summary, new RegExp(reason));
  }
  assert.equal(blocker(pod("am-0", "Failed"))?.terminal, true);
});

/**
 * The discriminating case. A slow pull and a broken image name look identical
 * if you only ask "is this pod ready" - and treating the slow one as terminal
 * would break every cold start on a domestic connection.
 */
test("a slow start is NOT terminal, however unready it looks", () => {
  for (const reason of ["ContainerCreating", "PodInitializing", "ImagePullBackOff", "ErrImagePull"]) {
    const b = blocker(pod("am-0", "Pending", [waiting(reason)]));
    assert.equal(b?.terminal, false, reason);
  }
  assert.equal(blocker(pod("ds-idrepo-0", "Pending"))?.terminal, false);
});

/**
 * PingAM crash-looping while PingDS is still coming up is normal on a cold
 * stack, so the first restarts must be tolerated and the persistent ones must
 * not be.
 */
test("a crash loop is judged by repetition, not on sight", () => {
  const early = pod("am-0", "Running", [
    waiting("CrashLoopBackOff", { restartCount: 2 }),
  ]);
  assert.equal(blocker(early)?.terminal, false);

  const persistent = pod("am-0", "Running", [
    waiting("CrashLoopBackOff", {
      restartCount: 3,
      lastState: { terminated: { reason: "Error", exitCode: 1 } },
    }),
  ]);
  const b = blocker(persistent);
  assert.equal(b?.terminal, true);
  assert.match(b!.summary, /3 restarts/);
  assert.match(b!.summary, /exit 1/);
});

test("a crash loop with no recorded exit status still reports something", () => {
  const b = blocker(
    pod("am-0", "Running", [waiting("CrashLoopBackOff", { restartCount: 5 })]),
  );
  assert.equal(b?.terminal, true);
  assert.match(b!.summary, /no exit status recorded/);
});

test("terminal blockers sort ahead of recoverable ones", () => {
  const found = blockers([
    pod("slow", "Pending", [waiting("ContainerCreating")]),
    pod("broken", "Pending", [waiting("InvalidImageName")]),
    pod("ok", "Running", [{ ready: true, restartCount: 0 }]),
  ]);
  assert.equal(found.length, 2);
  assert.equal(found[0]?.pod, "broken");
  assert.equal(found[0]?.terminal, true);
  assert.equal(found[1]?.pod, "slow");
});

test("a ready container does not mask an unready sibling", () => {
  const b = blocker(
    pod("am-0", "Running", [
      { ready: true, restartCount: 0 },
      waiting("InvalidImageName"),
    ]),
  );
  assert.equal(b?.terminal, true);
});

test("an init container's terminal failure is terminal", () => {
  // A pod wedged in `Init:CreateContainerConfigError` has no app container
  // status at all, so scanning only `containerStatuses` reported "phase
  // Pending" and waited out the whole deadline for something that could never
  // start.
  const p = pod(
    "idm-0",
    "Pending",
    [],
    [
      {
        name: "wait-for-ds",
        ready: false,
        restartCount: 0,
        state: { waiting: { reason: "CreateContainerConfigError" } },
      },
    ],
  );
  const b = blocker(p);
  assert.equal(b?.terminal, true);
  assert.match(b!.summary, /init wait-for-ds: CreateContainerConfigError/);
});

test("a completed init container is not a blocker", () => {
  // Init containers report `ready: false` once they exit, which is success.
  const p = pod(
    "idm-0",
    "Running",
    [{ name: "idm", ready: true, restartCount: 0 }],
    [
      {
        name: "wait-for-ds",
        ready: false,
        restartCount: 0,
        state: { terminated: { reason: "Completed", exitCode: 0 } },
      },
    ],
  );
  assert.equal(settled(p), true);
  assert.equal(blocker(p), undefined);
});

test("a crash loop is judged from the start of this wait, not from birth", () => {
  // `restartCount` is a lifetime total. Without a baseline, a pod that had
  // already crash-looped through a slow first `fo up` was declared terminal on
  // the first tick of the second one - which is the run that would have
  // succeeded.
  const before = pod("am-0", "Running", [
    {
      name: "am",
      ready: false,
      restartCount: 7,
      state: { waiting: { reason: "CrashLoopBackOff" } },
    },
  ]);
  const baseline = restartBaseline([before]);
  assert.equal(blocker(before, baseline)?.terminal, false);

  const worse = pod("am-0", "Running", [
    {
      name: "am",
      ready: false,
      restartCount: 10,
      state: { waiting: { reason: "CrashLoopBackOff" } },
      lastState: { terminated: { reason: "Error", exitCode: 1 } },
    },
  ]);
  const b = blocker(worse, baseline);
  assert.equal(b?.terminal, true);
  assert.match(b!.summary, /3 restarts this wait \(10 total\)/);

  // And with no baseline - which is what `fo status` passes - the lifetime
  // count is still what gets reported.
  assert.equal(blocker(before)?.terminal, true);
});

/* --------------------------------------------------------------- workloads */

type Workload = Parameters<typeof gapsIn>[0][number];

const workload = (o: unknown): Workload => o as Workload;

test("a workload that produced no pod at all is a gap", () => {
  // THE case. `waitReady` used to ask only whether every pod that exists is
  // settled, so a Deployment with zero pods contributed nothing unready: with
  // the rest of the stack up, `fo up` printed URLs and exited zero for a stack
  // that was missing a component. A Deployment with nothing ready reports no
  // `readyReplicas` key at all, not a zero.
  assert.deepEqual(
    gapsIn([
      workload({ kind: "Deployment", metadata: { name: "idm" }, spec: { replicas: 1 }, status: {} }),
    ]),
    [{ what: "Deployment/idm", have: 0, want: 1 }],
  );
});

test("an arrived stack has no gaps", () => {
  // The positive control: without it, a classifier that reported everything as
  // a gap would pass the test above.
  assert.deepEqual(
    gapsIn([
      workload({ kind: "Deployment", metadata: { name: "am" }, spec: { replicas: 1 }, status: { readyReplicas: 1 } }),
      workload({ kind: "StatefulSet", metadata: { name: "ds-cts" }, spec: { replicas: 1 }, status: { readyReplicas: 1 } }),
      workload({ kind: "DaemonSet", metadata: { name: "fo-vector" }, status: { desiredNumberScheduled: 1, numberReady: 1 } }),
      workload({ kind: "Job", metadata: { name: "keystore" }, spec: { completions: 1 }, status: { succeeded: 1 } }),
    ]),
    [],
  );
});

test("a DaemonSet nobody schedules is not a gap, and a suspended Job is not either", () => {
  // A DaemonSet's desired count comes from the scheduler: zero eligible nodes
  // means zero wanted, not a missing workload. A suspended Job is not trying.
  assert.deepEqual(
    gapsIn([
      workload({ kind: "DaemonSet", metadata: { name: "some-addon" }, status: { desiredNumberScheduled: 0, numberReady: 0 } }),
      workload({ kind: "Job", metadata: { name: "paused" }, spec: { completions: 1, suspend: true }, status: {} }),
    ]),
    [],
  );
});

test("...but a collector WE deployed that schedules nowhere is a gap", () => {
  // Kubernetes is right in general and wrong for this one: `fo up` installs
  // fo-vector and tells the developer the log console works. An eligibility
  // regression leaves it collecting nothing, and "desired 0" would report that
  // as healthy.
  assert.deepEqual(
    gapsIn([
      workload({ kind: "DaemonSet", metadata: { name: "fo-vector" }, status: { desiredNumberScheduled: 0, numberReady: 0 } }),
    ]),
    [{ what: "DaemonSet/fo-vector", have: 0, want: 1 }],
  );
});

test("an omitted replicas count still means one", () => {
  assert.deepEqual(
    gapsIn([
      workload({ kind: "Deployment", metadata: { name: "login-ui" }, spec: {}, status: {} }),
    ]),
    [{ what: "Deployment/login-ui", have: 0, want: 1 }],
  );
});

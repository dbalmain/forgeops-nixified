import { strict as assert } from "node:assert";
import { test } from "node:test";
import { blocker, blockers, settled } from "../commands/status.ts";
import type { Pod } from "../commands/status.ts";

type Container = {
  ready: boolean;
  restartCount: number;
  state?: { waiting?: { reason?: string; message?: string } };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
};

function pod(name: string, phase: string, containers: Container[] = []): Pod {
  return {
    metadata: { name },
    status: { phase, containerStatuses: containers },
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

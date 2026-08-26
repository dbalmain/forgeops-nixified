import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { arrayOf, decode, obj, str } from "../lib/shape.ts";
import { capture, stream } from "../lib/proc.ts";
import { detail, ok, step } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * k3s image k3d should run. k3d 5.9.0 defaults to v1.32.5, older than the
 * v1.36.x ForgeOps validates against, so we pin forward deliberately rather
 * than inheriting whatever k3d happens to default to.
 */
export const K3S_IMAGE = "rancher/k3s:v1.34.4-k3s1";

/**
 * k3d's way of saying "there is nothing here", which it does with exit 1.
 *
 * Measured against k3d v5.9.0: a name filter matching nothing prints
 * `No nodes found for given cluster`, and a broken Docker connection prints
 * `runtime failed to list nodes: ...`. BOTH exit 1, so the exit code cannot
 * tell them apart and the message has to.
 */
const NO_CLUSTERS = /no (nodes|clusters) found/i;

/**
 * Whether the named k3d cluster exists.
 *
 * FAILS CLOSED. This used to return `false` for every non-zero exit, directly
 * against what its own comment said it must not do -- so a stopped Docker
 * daemon read as "no cluster", and `fo down` reported "nothing to do" while
 * `fo down --destroy` went on to delete the state directory of a cluster that
 * was still running. There is no answer to give when the runtime cannot be
 * read, so it throws instead of inventing one.
 */
export function clusterExists(name: string): boolean {
  const r = capture("k3d", ["cluster", "list", "-o", "json"], {
    allowFailure: true,
  });
  if (r.code !== 0) {
    if (NO_CLUSTERS.test(r.stderr) || NO_CLUSTERS.test(r.stdout)) return false;
    throw new Error(
      `k3d cluster list exited ${r.code}. This is not "no cluster" - the ` +
        "container runtime could not be read, so nothing here knows whether " +
        `${name} exists:\n${(r.stderr || r.stdout).trim()}`,
    );
  }
  const list = decode(r.stdout, "k3d cluster list", arrayOf(obj({ name: str })));
  return list.some((c) => c.name === name);
}

export async function ensureCluster(cfg: ResolvedConfig): Promise<void> {
  if (clusterExists(cfg.clusterName)) {
    ok(`k3d cluster ${cfg.clusterName} already exists`);
  } else {
    step(`Creating k3d cluster ${cfg.clusterName}`);
    detail("ports 80 and 443 map straight to the host; no tunnel needed");
    await stream("k3d", [
      "cluster",
      "create",
      cfg.clusterName,
      "--servers",
      "1",
      "--agents",
      "0",
      "--image",
      K3S_IMAGE,
      "-p",
      "80:80@loadbalancer",
      "-p",
      "443:443@loadbalancer",
      "--k3s-arg",
      "--disable=metrics-server@server:0",
      "--wait",
      "--timeout",
      "300s",
    ]);
  }
  writeKubeconfig(cfg);
}

export function writeKubeconfig(cfg: ResolvedConfig): void {
  mkdirSync(dirname(cfg.kubeconfig), { recursive: true });
  capture("k3d", [
    "kubeconfig",
    "write",
    cfg.clusterName,
    "--output",
    cfg.kubeconfig,
  ]);
}

export async function deleteCluster(name: string): Promise<void> {
  if (!clusterExists(name)) {
    ok(`k3d cluster ${name} already gone`);
    return;
  }
  step(`Deleting k3d cluster ${name}`);
  await stream("k3d", ["cluster", "delete", name]);
  // Verified, not assumed. The caller deletes the state directory next, and
  // that is the one thing in `fo` a git revert cannot undo.
  if (clusterExists(name)) {
    throw new Error(
      `k3d reported success but cluster ${name} is still listed. Nothing ` +
        "further was removed.",
    );
  }
}

/**
 * Push a locally-built image into the cluster's containerd. Needed because k3s
 * has its own image store and cannot see the host Docker daemon's.
 */
export async function importImage(
  clusterName: string,
  image: string,
): Promise<void> {
  await stream("k3d", ["image", "import", "-c", clusterName, image]);
}

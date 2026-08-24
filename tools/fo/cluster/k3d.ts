import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { capture, stream } from "../lib/proc.ts";
import { detail, ok, step } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * k3s image k3d should run. k3d 5.9.0 defaults to v1.32.5, older than the
 * v1.36.x ForgeOps validates against, so we pin forward deliberately rather
 * than inheriting whatever k3d happens to default to.
 */
export const K3S_IMAGE = "rancher/k3s:v1.34.4-k3s1";

export function clusterExists(name: string): boolean {
  const r = capture("k3d", ["cluster", "list", "-o", "json"], {
    allowFailure: true,
  });
  if (r.code !== 0) return false;
  try {
    const list = JSON.parse(r.stdout) as Array<{ name: string }>;
    return list.some((c) => c.name === name);
  } catch {
    return false;
  }
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

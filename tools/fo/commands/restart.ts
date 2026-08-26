import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capture, stream } from "../lib/proc.ts";
import { kubeEnv, ns } from "../lib/k8s.ts";
import { detail, die, step } from "../lib/ui.ts";
import { buildAmProfile } from "../profile.ts";
import { POD_SELECTOR, type Component } from "../config.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Tier 3: roll a component. The slow tier, and the only option for PingAM,
 * whose config is read at startup.
 *
 * For PingAM this is NOT just a rollout once `platform/am/config` exists. The
 * init container would re-run from the SAME `am_custom` image and copy the FBC
 * it copied last time, so an edit would look applied and do nothing. The
 * profile image is rebuilt first; its tag is a content hash, so this agrees
 * with what `fo up` generates and nothing drifts by doing it out of band.
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
  if (component === "am" && hasAmConfig(cfg)) {
    await applyAmProfile(cfg);
  }
  await roll(cfg, component);
}

function hasAmConfig(cfg: ResolvedConfig): boolean {
  const dir = join(cfg.root, "platform", "am", "config");
  return existsSync(dir) && readdirSync(dir).length > 0;
}

async function applyAmProfile(cfg: ResolvedConfig): Promise<void> {
  const image = await buildAmProfile(cfg);
  if (!image) return;
  step("Pointing PingAM at the config profile");
  const ref = `${image.repository}:${image.tag}`;
  await stream(
    "kubectl",
    ns(cfg, ["set", "image", "deployment/am", `custom-vol-init=${ref}`]),
    { env: kubeEnv(cfg) },
  );
  detail(ref);
}

async function roll(cfg: ResolvedConfig, component: string): Promise<void> {
  // Deployments and StatefulSets both take `rollout restart`; find which.
  // Same as `fo shell`: a list query with no matches is exit zero and empty,
  // so a failure here is the cluster, not the absence of a workload.
  const kind = capture(
    "kubectl",
    ns(cfg, ["get", "deployment,statefulset", "-l", `app=${component}`, "-o", "name"]),
    { env: kubeEnv(cfg) },
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

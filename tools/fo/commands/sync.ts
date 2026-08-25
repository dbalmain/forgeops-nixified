import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../lib/proc.ts";
import { kubeEnv, podName, q } from "../lib/k8s.ts";
import { detail, ok, warn } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Tier 1 of the inner loop: push authored files straight into the running pod
 * and let PingIDM's file-install watcher reload them. No image build, no
 * rollout, no restart.
 *
 * This only works because `fo`'s dev config profile turns the watcher on -
 * ForgeOps ships `openidm.fileinstall.enabled=false`, and against a stock
 * profile every sync here would be silently ignored. See profile.ts.
 */

type Target = { name: string; local: string; remote: string };

function targets(cfg: ResolvedConfig): Target[] {
  return [
    {
      name: "conf",
      local: join(cfg.root, "platform", "idm", "conf"),
      remote: "/opt/openidm/conf",
    },
    {
      name: "script",
      local: join(cfg.root, "platform", "idm", "script"),
      remote: "/opt/openidm/script",
    },
    {
      // Sample data a connector reads from disk, e.g. a CSV an example syncs
      // from. NOT a mount, so a pod restart loses it until the next sync -
      // which is fine for sample data and wrong for anything else.
      name: "data",
      local: join(cfg.root, "platform", "idm", "data"),
      remote: "/opt/openidm/data",
    },
  ];
}

function fileCount(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
      (e) => e.isFile(),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Returns false if nothing could be synced, so a watcher can tell "no pod" from
 * "nothing to do" rather than reporting success either way.
 */
export function syncIdm(
  cfg: ResolvedConfig,
  only?: "conf" | "script" | "data",
): boolean {
  const pod = podName(cfg, "app=idm");
  if (!pod) {
    warn("no running idm pod; skipping sync");
    return false;
  }

  let synced = 0;
  for (const t of targets(cfg)) {
    if (only && t.name !== only) continue;
    if (!existsSync(t.local)) continue;
    const n = fileCount(t.local);
    if (n === 0) continue;

    // tar over exec rather than a `kubectl cp` per file: one round trip for
    // the whole tree, which is what keeps this inside the 5s budget.
    capture(
      "sh",
      [
        "-c",
        // mkdir first: `data` is not one of the image's directories.
        `kubectl -n ${q(cfg.namespace)} exec ${q(pod)} -c openidm -- ` +
          `mkdir -p ${q(t.remote)} && ` +
          `tar -C ${q(t.local)} -cf - . | ` +
          `kubectl -n ${q(cfg.namespace)} exec -i ${q(pod)} -c openidm -- ` +
          `tar -C ${q(t.remote)} -xf -`,
      ],
      { env: kubeEnv(cfg) },
    );
    detail(`${t.name}: ${n} file${n === 1 ? "" : "s"} -> ${pod}:${t.remote}`);
    synced += n;
  }

  if (synced === 0) {
    detail("nothing to sync (platform/idm/{conf,script} are empty)");
    return false;
  }
  ok(`synced ${synced} file${synced === 1 ? "" : "s"}`);
  return true;
}

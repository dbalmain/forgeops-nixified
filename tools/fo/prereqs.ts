import { capture, stream } from "./lib/proc.ts";
import { detail, ok, step } from "./lib/ui.ts";
import type { ResolvedConfig } from "./config.ts";

export const CERT_MANAGER_VERSION = "v1.21.1";

/**
 * A kubectl probe. `allowFailure` is on by default because every caller here
 * is asking "does this exist?", and a missing object is a legitimate answer,
 * not an error.
 */
function probe(cfg: ResolvedConfig, args: string[]) {
  return capture("kubectl", args, {
    env: { KUBECONFIG: cfg.kubeconfig },
    allowFailure: true,
  });
}

/**
 * The chart and its size presets ask for a StorageClass called `fast`. k3s
 * ships `local-path`, so we add an alias rather than patching the chart.
 */
export function ensureStorageClass(cfg: ResolvedConfig): void {
  const existing = probe(cfg, ["get", "sc", "fast", "-o", "name"]);
  if (existing.code === 0 && existing.stdout.trim()) {
    ok("StorageClass fast exists");
    return;
  }
  step("Creating StorageClass fast (alias for k3s local-path)");
  capture(
    "kubectl",
    ["apply", "-f", "-"],
    {
      env: { KUBECONFIG: cfg.kubeconfig },
      input: JSON.stringify({
        apiVersion: "storage.k8s.io/v1",
        kind: "StorageClass",
        metadata: { name: "fast" },
        provisioner: "rancher.io/local-path",
        reclaimPolicy: "Delete",
        volumeBindingMode: "WaitForFirstConsumer",
        allowVolumeExpansion: true,
      }),
    },
  );
  ok("StorageClass fast created");
}

/**
 * cert-manager is the only cluster prerequisite. Since ForgeOps 2026.3 the
 * chart generates its own secrets with Helm's own functions, so neither
 * secret-agent nor secret-generator is needed.
 *
 * Takes the caller's timeout rather than hardcoding one, because `fo up
 * --timeout` reached the platform install below and silently did not reach
 * here - one of the two waits ignored the only knob there was.
 *
 * That is a consistency fix, NOT a diagnosis. The first e2e run died at
 * exactly 5m00s here with the webhook Available 0/1, and the obvious story was
 * that cold image pulls on a runner outgrew a hardcoded 5m. Measured instead
 * of assumed: into a brand-new k3d cluster with an empty containerd, pulling
 * all three images from quay.io for real, this takes 31 SECONDS. 5m had ten
 * times the headroom it needed, so whatever the runner hit, it was not this.
 */
export async function ensureCertManager(
  cfg: ResolvedConfig,
  opts: { timeoutSeconds: number },
): Promise<void> {
  // Converge every time rather than short-circuiting on "does a release
  // exist". `helm status` exiting zero says a release object is there, NOT
  // that its webhook is serving - so a half-installed or unhealthy
  // cert-manager was reported as "already installed" and `fo up` walked on to
  // fail later, somewhere less obvious. A healthy converge is a few seconds
  // and needs no second state machine to decide whether to skip it.
  step(`Converging cert-manager ${CERT_MANAGER_VERSION}`);
  detail("issues the ingress cert and the PingDS keypairs");
  detail(
    opts.timeoutSeconds === 0
      ? "about 30s on a cold cluster; no deadline"
      : `about 30s on a cold cluster; giving up after ${opts.timeoutSeconds}s`,
  );
  await stream(
    "helm",
    [
      "upgrade",
      "--install",
      "cert-manager",
      "cert-manager",
      "--repo",
      "https://charts.jetstack.io",
      "--version",
      CERT_MANAGER_VERSION,
      "--namespace",
      "cert-manager",
      "--create-namespace",
      "--set",
      "crds.enabled=true",
      "--wait",
      "--timeout",
      opts.timeoutSeconds === 0 ? "24h" : `${opts.timeoutSeconds}s`,
    ],
    { env: { KUBECONFIG: cfg.kubeconfig } },
  );
  ok("cert-manager ready");
}

export function ensureNamespace(cfg: ResolvedConfig): void {
  const r = probe(cfg, ["get", "ns", cfg.namespace, "-o", "name"]);
  if (r.code === 0 && r.stdout.trim()) {
    ok(`namespace ${cfg.namespace} exists`);
    return;
  }
  capture("kubectl", ["create", "namespace", cfg.namespace], {
    env: { KUBECONFIG: cfg.kubeconfig },
  });
  ok(`namespace ${cfg.namespace} created`);
}

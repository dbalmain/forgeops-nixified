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
 */
export async function ensureCertManager(cfg: ResolvedConfig): Promise<void> {
  const installed = capture(
    "helm",
    ["-n", "cert-manager", "status", "cert-manager", "-o", "json"],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );
  if (installed.code === 0) {
    ok(`cert-manager already installed`);
    return;
  }
  step(`Installing cert-manager ${CERT_MANAGER_VERSION}`);
  detail("issues the ingress cert and the PingDS keypairs");
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
      "5m",
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

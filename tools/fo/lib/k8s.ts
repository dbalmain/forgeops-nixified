import { capture } from "./proc.ts";
import type { ResolvedConfig } from "../config.ts";

/** kubectl args that every call needs, so no caller can forget the namespace. */
export function ns(cfg: ResolvedConfig, args: string[]): string[] {
  return ["-n", cfg.namespace, ...args];
}

export function kubeEnv(cfg: ResolvedConfig): Record<string, string> {
  return { KUBECONFIG: cfg.kubeconfig };
}

/**
 * Name of the first pod matching a label selector, or undefined.
 *
 * NO `allowFailure`. A LIST query for a selector that matches nothing exits
 * ZERO with empty output, so a non-zero exit is never "no pod" -- it is an
 * unreachable API server, an expired credential, a kubeconfig pointing
 * somewhere else. Folding those into `undefined` made `fo sync` warn "no IDM
 * pod" and exit zero against a dead cluster, and did the same to both
 * config-export paths.
 */
export function podName(
  cfg: ResolvedConfig,
  selector: string,
): string | undefined {
  const r = capture(
    "kubectl",
    ns(cfg, [
      "get",
      "pod",
      "-l",
      selector,
      "--field-selector=status.phase=Running",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ]),
    { env: kubeEnv(cfg) },
  );
  return r.stdout.trim() || undefined;
}

/**
 * `kubectl get` for a NAMED resource that may legitimately not exist.
 *
 * `--ignore-not-found` turns absence into exit zero and empty output, which is
 * the distinction `allowFailure: true` throws away: without it, "this secret
 * does not exist yet" and "the cluster cannot be reached" are the same answer,
 * and every caller here picked the reassuring reading.
 */
export function getOptional(cfg: ResolvedConfig, args: string[]): string {
  return capture(
    "kubectl",
    ns(cfg, ["get", ...args, "--ignore-not-found"]),
    { env: kubeEnv(cfg) },
  ).stdout;
}

/** Shell-quote a path for use inside `sh -c`. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

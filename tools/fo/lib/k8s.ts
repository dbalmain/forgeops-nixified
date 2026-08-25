import { capture } from "./proc.ts";
import type { ResolvedConfig } from "../config.ts";

/** kubectl args that every call needs, so no caller can forget the namespace. */
export function ns(cfg: ResolvedConfig, args: string[]): string[] {
  return ["-n", cfg.namespace, ...args];
}

export function kubeEnv(cfg: ResolvedConfig): Record<string, string> {
  return { KUBECONFIG: cfg.kubeconfig };
}

/** Name of the first pod matching a label selector, or undefined. */
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
    { env: kubeEnv(cfg), allowFailure: true },
  );
  return r.stdout.trim() || undefined;
}

/** Shell-quote a path for use inside `sh -c`. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

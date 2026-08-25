import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { capture, stream } from "../lib/proc.ts";
import { detail, ok, step, warn } from "../lib/ui.ts";
import { tsRoot } from "./build.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Regenerate platform/typescript/package-lock.json after editing its
 * package.json.
 *
 * This exists because doing it by hand walks into three traps in a row:
 *
 *  1. node_modules is a symlink into the read-only nix store, so npm cannot
 *     write its bookkeeping and fails with EROFS.
 *  2. Once package.json names a dependency the lock does not have, the FLAKE
 *     stops evaluating - so `nix develop` no longer works and you cannot get
 *     to a shell with npm in it.
 *  3. npm exits non-zero on its allow-scripts warning even though the lock was
 *     written correctly.
 *
 * So this unlinks the store tree, runs npm with a nixpkgs node that does not
 * depend on the flake evaluating, and leaves the lock in place for the next
 * `nix develop` to build from.
 */
export async function deps(cfg: ResolvedConfig): Promise<void> {
  const root = tsRoot(cfg);
  if (!existsSync(root)) {
    warn("no platform/typescript");
    return;
  }

  const modules = join(root, "node_modules");
  if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) {
    step("Unlinking the store node_modules");
    detail("npm cannot write its bookkeeping into a read-only nix store");
    rmSync(modules);
  }

  step("Regenerating package-lock.json");
  // `nix shell` rather than the current devShell: this command's whole job is
  // to run when the flake may no longer evaluate.
  const r = capture(
    "nix",
    [
      "shell",
      "nixpkgs#nodejs_24",
      "--command",
      "npm",
      "install",
      "--package-lock-only",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: root, allowFailure: true },
  );
  if (!existsSync(join(root, "package-lock.json"))) {
    throw new Error(`npm did not write a lockfile:\n${r.stderr || r.stdout}`);
  }
  ok("package-lock.json updated");

  step("Rebuilding node_modules from the lock");
  await stream("nix", ["build", ".#nodeModules", "--no-link"], {
    cwd: cfg.root,
  });
  ok("done - re-enter the dev shell (direnv reload) to pick up the new link");
}

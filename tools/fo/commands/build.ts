import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { stream } from "../lib/proc.ts";
import { detail, die, step } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * The platform TypeScript build: type-check, bundle, downlevel to ES5, and
 * emit into platform/idm/script + platform/idm/conf.
 *
 * `fo` shells out to the project's own npm scripts rather than reimplementing
 * the pipeline, so `npm run build` in platform/typescript and `fo build` can
 * never disagree.
 */

export function tsRoot(cfg: ResolvedConfig): string {
  return join(cfg.root, "platform", "typescript");
}

/**
 * node_modules must be the devShell's symlink into the nix store. If it is a
 * real directory, someone has run `npm install`, and they are now building
 * against a dependency set nix did not pin - which is exactly the drift the
 * flake exists to prevent.
 */
function assertStoreModules(cfg: ResolvedConfig): void {
  const modules = join(tsRoot(cfg), "node_modules");
  if (!existsSync(modules)) {
    die(
      "platform/typescript/node_modules is missing. Enter the dev shell " +
        "(direnv allow, or nix develop) - it links the nix-built tree.",
    );
  }
  if (!lstatSync(modules).isSymbolicLink()) {
    die(
      "platform/typescript/node_modules is a real directory, so something ran " +
        "`npm install`. Delete it and re-enter the dev shell; dependencies " +
        "come from nix, and `fo deps` is how you change them.",
    );
  }
}

async function npm(cfg: ResolvedConfig, script: string): Promise<void> {
  await stream("npm", ["run", "--silent", script], { cwd: tsRoot(cfg) });
}

export async function build(cfg: ResolvedConfig): Promise<void> {
  if (!existsSync(tsRoot(cfg))) {
    detail("no platform/typescript; nothing to build");
    return;
  }
  assertStoreModules(cfg);
  step("Building platform TypeScript");
  await npm(cfg, "build");
}

/** Everything the build does, plus lint and the test suite. */
export async function check(cfg: ResolvedConfig): Promise<void> {
  if (!existsSync(tsRoot(cfg))) {
    detail("no platform/typescript; nothing to check");
    return;
  }
  assertStoreModules(cfg);
  step("Checking platform TypeScript (types, lint, tests, build)");
  await npm(cfg, "check");
}

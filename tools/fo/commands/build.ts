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
  await checkFo(cfg);
  if (!existsSync(tsRoot(cfg))) {
    detail("no platform/typescript; nothing to check");
    return;
  }
  assertStoreModules(cfg);
  step("Checking platform TypeScript (types, lint, tests, build)");
  await npm(cfg, "check");
}

/**
 * Type-check `fo` itself.
 *
 * Node 24 strips types and runs the .ts sources directly, so nothing compiles
 * `tools/fo` and a type error in it surfaces only when the broken line runs -
 * possibly ten minutes into `fo up`. This is the gate that stops that.
 */
export async function checkFo(cfg: ResolvedConfig): Promise<void> {
  assertStoreModules(cfg);
  step("Type-checking fo");
  // tsgo, not tsc: the TypeScript 7 native compiler. Same diagnostics on this
  // codebase - every strict flag `fo` and the platform rely on was checked
  // against tsc 5.9 on deliberate violations and agreed - at about a fifth of
  // the wall clock. `typescript` stays in platform/typescript's dependencies
  // because typescript-eslint's PARSER needs it; only the checking moved.
  await stream(
    join(tsRoot(cfg), "node_modules", ".bin", "tsgo"),
    ["--noEmit", "-p", join(cfg.root, "tsconfig.json")],
    { cwd: cfg.root },
  );
  step("Testing fo");
  // Node's own runner over the .ts sources directly - no npm dependency, and
  // nothing to keep in step with the platform's separate test setup. These
  // cover the pure parts of `fo`: manifest shape, config normalisation, query
  // construction. Anything needing a cluster is verified by running it.
  await stream("node", ["--test", "tools/fo/tests/*.test.ts"], { cwd: cfg.root });
}

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ALL_COMPONENTS, type Component, type ResolvedConfig } from "./config.ts";

/**
 * Installable example packages.
 *
 * The alternative was seeding `platform/` with examples in every checkout,
 * where they rot: nobody deletes them, nobody updates them, and they turn into
 * noise a reader has to learn to ignore. A package is taken deliberately and
 * can be removed cleanly.
 *
 * The whole design rests on one idea: `fo` records the hash of every file it
 * writes. A file that still matches its hash is `fo`'s to update or delete; a
 * file that does not is YOURS, and `fo` will not touch it. That is the same
 * managed/seeded/yours rule the TypeScript framework uses, applied to config.
 */

export type PackageManifest = {
  name: string;
  version: string;
  description?: string;
  requires?: {
    /** Components that must be enabled for this package to make sense. */
    components?: Component[];
  };
};

export type PackageSource = { manifest: PackageManifest; dir: string };

export type LockEntry = {
  version: string;
  /** repo-relative path -> sha256 of the content `fo` wrote. */
  files: Record<string, string>;
};

export type Lock = { version: 1; packages: Record<string, LockEntry> };

export function lockPath(cfg: ResolvedConfig): string {
  return join(cfg.root, ".fo", "packages.lock");
}

export function readLock(cfg: ResolvedConfig): Lock {
  const path = lockPath(cfg);
  if (!existsSync(path)) return { version: 1, packages: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Lock;
    if (parsed.version !== 1 || typeof parsed.packages !== "object") {
      throw new Error("unrecognised shape");
    }
    return parsed;
  } catch (e) {
    // Refuse rather than guess: this file decides which files `fo` believes it
    // owns, and a wrong answer means deleting someone's work.
    throw new Error(
      `${path} is unreadable (${e instanceof Error ? e.message : e}). ` +
        `Delete it to forget what is installed - installed FILES are left ` +
        `alone, they just stop being tracked.`,
    );
  }
}

export function writeLock(cfg: ResolvedConfig, lock: Lock): void {
  const path = lockPath(cfg);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
}

export function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/**
 * Where `fo add` looks, in order: this repo's `packages/` (the built-in
 * registry), then any directory named in `fo.config.ts`. Nothing is fetched
 * over the network - a third-party source is a path you wrote down.
 */
export function searchPath(cfg: ResolvedConfig): string[] {
  return [
    join(cfg.root, "packages"),
    ...cfg.packageSources.map((p) =>
      p.startsWith("/") ? p : join(cfg.root, p),
    ),
  ];
}

export function resolvePackage(
  cfg: ResolvedConfig,
  name: string,
): PackageSource | undefined {
  for (const root of searchPath(cfg)) {
    const dir = join(root, name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as PackageManifest;
    if (manifest.name !== name) {
      throw new Error(
        `${manifestPath} declares name "${manifest.name}" but lives in a ` +
          `directory called "${name}"`,
      );
    }
    return { manifest, dir };
  }
  return undefined;
}

export function availablePackages(cfg: ResolvedConfig): PackageSource[] {
  const seen = new Set<string>();
  const out: PackageSource[] = [];
  for (const root of searchPath(cfg)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const found = resolvePackage(cfg, entry.name);
      if (found) {
        seen.add(entry.name);
        out.push(found);
      }
    }
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** The files a package would install, as repo-relative paths. */
export function payload(source: PackageSource): Array<[string, string]> {
  const root = join(source.dir, "platform");
  return listFiles(root).map((rel) => [
    join("platform", rel),
    join(root, rel),
  ]);
}

export type FileState = "ok" | "modified" | "missing";

export function fileState(
  cfg: ResolvedConfig,
  repoRelative: string,
  recorded: string,
): FileState {
  const path = join(cfg.root, repoRelative);
  if (!existsSync(path)) return "missing";
  return hash(readFileSync(path)) === recorded ? "ok" : "modified";
}

export function checkRequirements(
  cfg: ResolvedConfig,
  manifest: PackageManifest,
): string[] {
  const problems: string[] = [];
  for (const component of manifest.requires?.components ?? []) {
    if (!ALL_COMPONENTS.includes(component)) {
      problems.push(`unknown component "${component}"`);
    } else if (!cfg.components.includes(component)) {
      problems.push(
        `needs the "${component}" component, which fo.config.ts disables`,
      );
    }
  }
  return problems;
}

/** Remove now-empty directories left behind by a removal, up to `stopAt`. */
export function pruneEmptyDirs(from: string, stopAt: string): void {
  let dir = dirname(from);
  while (dir.startsWith(stopAt + sep) || dir === stopAt) {
    if (!existsSync(dir)) {
      dir = dirname(dir);
      continue;
    }
    if (readdirSync(dir).length > 0) return;
    if (dir === stopAt) return;
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

export { listFiles, rmSync, statSync };

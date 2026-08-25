import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  availablePackages,
  checkRequirements,
  fileState,
  hash,
  payload,
  pruneEmptyDirs,
  readLock,
  resolvePackage,
  searchPath,
  writeLock,
  type LockEntry,
} from "../packages.ts";
import { bold, detail, die, dim, green, heading, ok, red, step, table, warn, yellow } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

export function add(
  cfg: ResolvedConfig,
  name: string | undefined,
  opts: { force: boolean } = { force: false },
): void {
  if (!name) die("fo add needs a package name. see: fo list");
  const source = resolvePackage(cfg, name);
  if (!source) {
    die(
      `no package "${name}". looked in:\n` +
        searchPath(cfg)
          .map((p) => `    ${p}`)
          .join("\n") +
        `\n  see what is available: fo list`,
    );
  }

  const problems = checkRequirements(cfg, source.manifest);
  if (problems.length > 0) {
    die(`${name} cannot be installed:\n${problems.map((p) => `    ${p}`).join("\n")}`);
  }

  const lock = readLock(cfg);
  const files = payload(source);
  if (files.length === 0) die(`${name} has no platform/ payload`);

  // Refuse BEFORE writing anything. A half-installed package is worse than an
  // uninstalled one, because the lock would then disagree with the tree.
  const collisions: string[] = [];
  const untracked: string[] = [];
  const previous = lock.packages[name];
  for (const [repoRelative] of files) {
    const target = join(cfg.root, repoRelative);
    if (!existsSync(target)) continue;
    const recordedHere = previous?.files[repoRelative];
    if (recordedHere !== undefined) {
      // Ours from a previous install of THIS package: fine to replace, unless
      // the developer has since edited it.
      if (
        !opts.force &&
        fileState(cfg, repoRelative, recordedHere) === "modified"
      ) {
        collisions.push(`${repoRelative} (you edited it)`);
      }
      continue;
    }
    const owner = Object.entries(lock.packages).find(
      ([other, entry]) => other !== name && entry.files[repoRelative] !== undefined,
    );
    if (owner) {
      // Never forceable: taking a file another package owns would leave THAT
      // package's lock describing content it no longer has.
      collisions.push(`${repoRelative} (installed by ${owner[0]})`);
      continue;
    }
    // An untracked file in the way. Usually the orphan `fo remove` leaves
    // behind on purpose when you have edited it, so --force is the intended
    // way back.
    if (!opts.force) {
      collisions.push(`${repoRelative} (already exists)`);
    } else {
      untracked.push(repoRelative);
    }
  }
  if (collisions.length > 0) {
    die(
      `${name} would overwrite files fo does not own:\n` +
        collisions.map((c) => `    ${c}`).join("\n") +
        `\n  move or delete them, or re-install over your own edits with ` +
        `--force`,
    );
  }

  step(`Installing ${name} ${dim(source.manifest.version)}`);
  const entry: LockEntry = { version: source.manifest.version, files: {} };
  const overwritten: string[] = [];
  for (const [repoRelative, from] of files) {
    const target = join(cfg.root, repoRelative);
    const recordedHere = previous?.files[repoRelative];
    if (
      opts.force &&
      recordedHere !== undefined &&
      fileState(cfg, repoRelative, recordedHere) === "modified"
    ) {
      overwritten.push(repoRelative);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(from, target);
    entry.files[repoRelative] = hash(readFileSync(from));
    detail(repoRelative);
  }
  lock.packages[name] = entry;
  writeLock(cfg, lock);
  ok(`${files.length} file${files.length === 1 ? "" : "s"} installed`);
  for (const file of untracked) {
    if (!overwritten.includes(file)) overwritten.push(file);
  }
  if (overwritten.length > 0) {
    // Say exactly what was destroyed. --force is the one path here that can
    // lose work, so it does not get to be quiet about it.
    warn(`--force discarded your edits to:`);
    for (const file of overwritten) detail(file);
  }

  const readme = join(source.dir, "README.md");
  if (existsSync(readme)) detail(`read: ${readme}`);
  detail("apply it: fo build && fo amster && fo sync");
}

export function list(cfg: ResolvedConfig): void {
  const lock = readLock(cfg);
  const installed = Object.entries(lock.packages);

  heading("Installed");
  if (installed.length === 0) {
    console.log(`   ${dim("nothing yet")}`);
  }
  for (const [name, entry] of installed) {
    const states = Object.entries(entry.files).map(([f, h]) => fileState(cfg, f, h));
    const modified = states.filter((s) => s === "modified").length;
    const missing = states.filter((s) => s === "missing").length;
    const summary =
      modified === 0 && missing === 0
        ? green("clean")
        : [
            modified > 0 ? yellow(`${modified} yours`) : "",
            missing > 0 ? red(`${missing} missing`) : "",
          ]
            .filter(Boolean)
            .join(" ");
    console.log(`   ${bold(name)} ${dim(entry.version)}  ${summary}`);
    for (const [file, recorded] of Object.entries(entry.files)) {
      const state = fileState(cfg, file, recorded);
      if (state === "ok") continue;
      console.log(
        `      ${state === "modified" ? yellow("yours") : red("missing")}  ${file}`,
      );
    }
  }

  const notInstalled = availablePackages(cfg).filter(
    (p) => !lock.packages[p.manifest.name],
  );
  heading("Available");
  if (notInstalled.length === 0) {
    console.log(`   ${dim("everything found is installed")}`);
  } else {
    table(
      notInstalled.map((p) => [
        p.manifest.name,
        p.manifest.description ?? "",
      ]),
    );
  }
  console.log(`\n ${dim("install one: fo add <name>")}`);
}

export function remove(cfg: ResolvedConfig, name: string | undefined): void {
  if (!name) die("fo remove needs a package name. see: fo list");
  const lock = readLock(cfg);
  const entry = lock.packages[name];
  if (!entry) die(`${name} is not installed. see: fo list`);

  step(`Removing ${name}`);
  let removed = 0;
  const kept: string[] = [];
  for (const [repoRelative, recorded] of Object.entries(entry.files)) {
    const state = fileState(cfg, repoRelative, recorded);
    if (state === "missing") continue;
    if (state === "modified") {
      // Never delete an edited file. It stopped being the package's the
      // moment someone changed it.
      kept.push(repoRelative);
      continue;
    }
    const target = join(cfg.root, repoRelative);
    rmSync(target, { force: true });
    pruneEmptyDirs(target, join(cfg.root, "platform"));
    removed += 1;
  }

  delete lock.packages[name];
  writeLock(cfg, lock);
  ok(`${removed} file${removed === 1 ? "" : "s"} removed`);
  if (kept.length > 0) {
    warn(`left behind because you edited ${kept.length === 1 ? "it" : "them"}:`);
    for (const file of kept) detail(file);
  }
  detail("re-apply the platform: fo build && fo amster && fo sync");
}

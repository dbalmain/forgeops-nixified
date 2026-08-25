import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../lib/proc.ts";
import { kubeEnv, podName, q } from "../lib/k8s.ts";
import { detail, dim, die, heading, ok, step, warn } from "../lib/ui.ts";
import {
  diffTrees,
  isEmptyDiff,
  isText,
  readTree,
  subtree,
  writeTree,
  type Tree,
  type TreeDiff,
} from "../lib/tree.ts";
import { RELEASE, REGISTRY, forgeopsSrc, type ResolvedConfig } from "../config.ts";

export type ExportComponent = "am" | "idm";

export const EXPORT_COMPONENTS: ExportComponent[] = ["am", "idm"];

/**
 * PingIDM conf files that `fo` itself writes into the config profile, and so
 * must never come back out of a running pod into the repo.
 *
 * Both carry dev-only overrides (see profile.ts): `system.properties` turns
 * the file-install watcher ON, and `script.json` drops the recompile interval
 * to ~1s. The profile build copies `platform/idm/conf` over its own output, so
 * an exported copy would WIN and freeze whatever the pod happened to have -
 * silently pinning the inner loop's settings and ignoring fo.config.ts.
 */
const IDM_FO_OWNED = new Set(["system.properties", "script.json"]);

/**
 * Always export this even when it matches the stock image, because it is the
 * input to managed-object type generation (`src/generated/managed.ts`).
 * Everything else is exported only when it differs, to keep the repo free of
 * files you did not choose to own.
 */
const IDM_ALWAYS = new Set(["managed.json"]);

/**
 * The PingAM config upgrader is published under the PRODUCT version, not the
 * release tag every other image uses: `am-config-upgrader:8.1.1` exists and
 * `am-config-upgrader:2026.3.0-1849` does not (checked 2026-08-25). This is
 * the same two-tag-schemes hazard as spike/RESULTS.md finding 3, pointing the
 * other way, so it gets its own constant rather than reusing RELEASE.imageTag.
 */
export const AM_UPGRADER_IMAGE = `${REGISTRY}/am-config-upgrader:${RELEASE.productVersion}`;

/** Where each component's exported config lives in the repo. */
export function exportDir(cfg: ResolvedConfig, component: ExportComponent): string {
  return component === "idm"
    ? join(cfg.root, "platform", "idm", "conf")
    : join(cfg.root, "platform", "am", "config");
}

// ---------------------------------------------------------------------------
// Collecting what the repo SHOULD contain
// ---------------------------------------------------------------------------

/** Pull a tarball out of a command's stdout and read it back as a Tree. */
function tarToTree(shellCommand: string, strip: string, env?: Record<string, string>): Tree {
  const dir = mkdtempSync(join(tmpdir(), "fo-export-"));
  try {
    capture("sh", ["-c", `${shellCommand} | tar -C ${q(dir)} -xf -`], { env: env ?? {} });
    return subtree(readTree(dir), strip);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The stock PingIDM image's `conf/`, cached under `.fo/baseline/`.
 *
 * Without a baseline, exporting means adopting all 52 of the image's config
 * files into the repo, every one of which then has to be reviewed on every
 * upgrade. With one, the export is the delta - which is the only part that is
 * actually yours.
 */
function idmBaseline(cfg: ResolvedConfig): Tree {
  const cache = join(cfg.root, ".fo", "baseline", `idm-${RELEASE.imageTag}`);
  const cached = readTree(cache);
  if (cached.size > 0) return subtree(cached, "conf");

  step("Extracting the stock PingIDM config for comparison");
  const tree = tarToTree(
    `docker run --rm --entrypoint tar ${q(`${REGISTRY}/idm:${RELEASE.imageTag}`)} ` +
      `-C /opt/openidm -cf - conf`,
    "conf",
  );
  mkdirSync(cache, { recursive: true });
  writeTree(cache, new Map([...tree].map(([k, v]) => [`conf/${k}`, v])));
  detail(`${tree.size} files cached in .fo/baseline/idm-${RELEASE.imageTag}`);
  return tree;
}

function collectIdm(cfg: ResolvedConfig, opts: { schema: boolean }): Tree {
  const pod = podName(cfg, "app=idm");
  if (!pod) die("no running idm pod - `fo up` first");

  const live = tarToTree(
    `kubectl -n ${q(cfg.namespace)} exec ${q(pod)} -c openidm -- ` +
      `tar -C /opt/openidm -cf - conf`,
    "conf",
    kubeEnv(cfg),
  );
  const base = idmBaseline(cfg);

  const out: Tree = new Map();
  const skipped: string[] = [];
  for (const [rel, content] of live) {
    if (IDM_FO_OWNED.has(rel)) {
      skipped.push(rel);
      continue;
    }
    const b = base.get(rel);
    const forced = opts.schema && IDM_ALWAYS.has(rel);
    if (forced || b === undefined || !b.equals(content)) out.set(rel, content);
  }
  if (skipped.length > 0) {
    detail(dim(`not exported (fo owns these in the dev profile): ${skipped.join(", ")}`));
  }
  detail(`${live.size} files in the pod, ${out.size} differ from the stock image`);
  return out;
}

/**
 * PingAM's own export script, then the config upgrader.
 *
 * `export.sh` tars only `config/services`, which PingAM writes on first boot
 * and updates thereafter, so the result is already the delta from the image -
 * no baseline needed on this side. The upgrader then runs TWICE, because it
 * applies one rule set per invocation: the bundled version rules, then
 * ForgeOps' `placeholders.groovy`, which puts `%BASE_DN%`-style placeholders
 * back where the live config has concrete values. Skipping the second pass
 * bakes this environment's DNs into the repo.
 */
/**
 * True when a PingAM FBC entity's `data` is `_id` and `_type` and nothing
 * else - the entity exists, and carries no settings.
 *
 * These are NOT droppable, which is worth stating because it looks like they
 * are. A running PingAM materialises such files unprompted: all fourteen
 * social identity providers appeared minutes after a boot nobody had touched
 * (observed 2026-08-25), and filtering them out of the export was the obvious
 * fix. It is wrong. A `DataStoreDecision` node has no settings either, so its
 * file has exactly the same shape - and the entity's EXISTENCE is the
 * configuration. Dropping it deletes a node from a journey.
 *
 * So the export keeps everything, and this is used only to classify what
 * `fo config diff` counts as drift. A config-free entity that appeared on its
 * own is reported and not counted; anything with settings is drift.
 */
function isEmptyEntity(content: Buffer): boolean {
  let parsed: { data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content.toString("utf8")) as { data?: Record<string, unknown> };
  } catch {
    return false;
  }
  const data = parsed.data;
  if (!data || typeof data !== "object") return false;
  const keys = Object.keys(data).sort();
  return keys.length === 2 && keys[0] === "_id" && keys[1] === "_type";
}

function collectAm(cfg: ResolvedConfig, opts: { upgrade: boolean }): Tree {
  const pod = podName(cfg, "app=am");
  if (!pod) die("no running am pod - `fo up` first");

  // Under .fo/, not the system temp dir: the upgrader runs as a container with
  // this directory bind-mounted, and Docker Desktop on macOS does not share
  // `/var/folders/...` by default. The repo lives in the user's home, which it
  // does share.
  const work = join(cfg.stateDir, "am-export");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    capture(
      "sh",
      [
        "-c",
        `kubectl -n ${q(cfg.namespace)} exec ${q(pod)} -c openam -- ` +
          `/home/forgerock/export.sh - | tar -C ${q(work)} -xf -`,
      ],
      { env: kubeEnv(cfg) },
    );
    const raw = subtree(readTree(work), "config");
    if (raw.size === 0) {
      die("PingAM exported nothing - config/services is empty, so AM has not written its config yet");
    }
    detail(`${raw.size} files exported from ${pod}`);

    if (opts.upgrade) {
      runAmUpgrader(work);
      return subtree(readTree(work), "config");
    }
    warn("skipped the config upgrader; placeholders will hold this environment's values");
    return raw;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function runAmUpgrader(work: string): void {
  const rules = join(forgeopsSrc(), "etc", "am-upgrader-rules");
  const run = (extra: string[]): void => {
    capture("docker", [
      "run", "--rm", "--user", "0",
      "--volume", `${work}:/am-config`,
      ...extra,
      AM_UPGRADER_IMAGE,
    ]);
  };

  step("Running the PingAM config upgrader");
  run([]);
  detail("version rules applied");
  run(["--volume", `${rules}:/rules`]);
  detail("placeholder rules applied");

  // The upgrader runs as root inside the container, so everything it rewrote
  // is now root-owned on the host. Hand it back before anything tries to read
  // or clean up the directory.
  capture("docker", [
    "run", "--rm", "--user", "0", "--volume", `${work}:/am-config`,
    AM_UPGRADER_IMAGE, "chown", "-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, "/am-config",
  ]);
}

function collect(
  cfg: ResolvedConfig,
  component: ExportComponent,
  opts: { upgrade: boolean; schema: boolean },
): Tree {
  return component === "idm" ? collectIdm(cfg, opts) : collectAm(cfg, opts);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function configExport(
  cfg: ResolvedConfig,
  component: ExportComponent,
  opts: { upgrade: boolean },
): void {
  heading(`fo config export ${component}  ${cfg.env}`);
  const target = exportDir(cfg, component);
  const wanted = collect(cfg, component, { ...opts, schema: true });
  const repo = readTree(target);

  // Compare only against what we are about to write. Files already in the repo
  // that the export does not mention are left alone: `fo build` output, files
  // an installed package owns, and anything you wrote by hand all live here
  // too, and an export must never be a deletion.
  const d = diffTrees(repo, wanted);
  if (d.added.length === 0 && d.changed.length === 0) {
    ok(`${target.replace(cfg.root + "/", "")} is already up to date`);
    return;
  }

  mkdirSync(target, { recursive: true });
  writeTree(target, wanted);
  for (const rel of d.added) detail(`+ ${rel}`);
  for (const rel of d.changed) detail(`~ ${rel}`);
  ok(
    `wrote ${d.added.length + d.changed.length} file` +
      `${d.added.length + d.changed.length === 1 ? "" : "s"} to ` +
      target.replace(cfg.root + "/", ""),
  );

  if (component === "idm" && wanted.has("managed.json")) {
    detail("run `fo build` to regenerate src/generated/managed.ts");
  }
  if (component === "am") {
    detail("run `fo up` to rebuild the am_custom image and roll PingAM onto it");
  }
}

export function configDiff(
  cfg: ResolvedConfig,
  components: ExportComponent[],
  opts: { upgrade: boolean },
): boolean {
  let clean = true;
  for (const component of components) {
    heading(`fo config diff ${component}  ${cfg.env}`);
    const target = exportDir(cfg, component);
    // `schema: false`: managed.json is force-exported because it is the input
    // to type generation, but a managed.json that matches the stock image is
    // not DRIFT, and reporting it as such would make `fo config diff` fail
    // forever on a repo that has never exported.
    const wanted = collect(cfg, component, { ...opts, schema: false });
    const repo = readTree(target);

    const d = diffTrees(repo, wanted);
    // Repo files the export did not produce are reported but never counted as
    // drift: an endpoint conf that `fo build` emits is expected to be here and
    // absent from the pod's delta only if the pod is behind.
    //
    // Nor is a NEW entity that carries no settings, for PingAM: see
    // isEmptyEntity. It is still exported, but a file the server wrote by
    // itself is not something a person changed, and counting it makes the
    // command cry wolf on a schedule nobody controls.
    const appeared = component === "am"
      ? d.added.filter((rel) => isEmptyEntity(wanted.get(rel)!))
      : [];
    const drift: TreeDiff = {
      added: d.added.filter((rel) => !appeared.includes(rel)),
      changed: d.changed,
      removed: [],
    };
    if (isEmptyDiff(drift)) {
      ok(`${component}: live config matches ${target.replace(cfg.root + "/", "")}`);
    } else {
      clean = false;
      renderDiff(repo, wanted, drift);
      warn(
        `${component}: ${drift.added.length} new, ${drift.changed.length} changed ` +
          `- \`fo config export ${component}\` to adopt them`,
      );
    }
    if (appeared.length > 0) {
      detail(
        dim(`${appeared.length} config-free entities PingAM wrote by itself (not drift, still exported)`),
      );
    }
    if (d.removed.length > 0) {
      // Not counted as drift, and not an error: these are files the repo has
      // and the export did not produce. Almost always the deployed config
      // profile predates them - `fo sync` pushes files into a running pod
      // without rebuilding the image, so a long session leaves the pod ahead
      // of its own profile and a roll puts it behind the repo.
      detail(dim(`in the repo but not in the pod (roll or re-deploy): ${d.removed.join(", ")}`));
    }
  }
  return clean;
}

/**
 * Render a unified diff with `diff -u`. Shelling out rather than implementing
 * an LCS keeps `fo` dependency-free without hand-rolling something subtly
 * wrong; diffutils is pinned in the flake alongside kubectl and helm.
 */
function renderDiff(repo: Tree, wanted: Tree, d: TreeDiff): void {
  const dir = mkdtempSync(join(tmpdir(), "fo-diff-"));
  try {
    for (const rel of [...d.added, ...d.changed]) {
      const after = wanted.get(rel)!;
      const before = repo.get(rel);
      if (!isText(after) || (before && !isText(before))) {
        console.log(`Binary file ${rel} differs`);
        continue;
      }
      const a = join(dir, "a");
      const b = join(dir, "b");
      writeTree(dir, new Map([["a", before ?? Buffer.alloc(0)], ["b", after]]));
      const r = capture("diff", ["-u", "--label", `repo/${rel}`, "--label", `live/${rel}`, a, b], {
        allowFailure: true,
      });
      process.stdout.write(r.stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

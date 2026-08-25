import { decode, obj, opt, record, str } from "../lib/shape.ts";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { capture, captureAsync, stream } from "../lib/proc.ts";
import { detail, dim, fail, heading, ok, step, warn } from "../lib/ui.ts";
import { chartImages, resolvedImages, verifyImageCoverage } from "../values.ts";
import { AM_UPGRADER_IMAGE } from "./config.ts";
import { forgeopsSrc, RELEASE, type ResolvedConfig } from "../config.ts";

/**
 * `fo upgrade` moves the pinned ForgeOps tree forward and then answers the two
 * questions that actually decide whether the new pin will install:
 *
 *  - did the chart gain an image key `fo` has no decision about? (that key
 *    would silently stay on the chart's `latest`, a different build from the
 *    rest of the stack)
 *  - does every image ref `fo` pins actually exist in the registry?
 *
 * The second is the check the Phase 0 spike needed and did not have.
 * `dockette/ssh:2026.3.0-1849` does not exist, and the resulting failure
 * cascade - no ssh-keygen, no amster secret, PingAM stuck in FailedMount -
 * pointed nowhere near the cause. Here it is one line of output.
 */
export async function upgrade(
  cfg: ResolvedConfig,
  opts: { check: boolean },
): Promise<boolean> {
  heading(opts.check ? "fo upgrade --check" : "fo upgrade");

  const before = forgeopsSrc();
  let after = before;

  if (!opts.check) {
    step("Updating the forgeops-src flake input");
    const wasRev = lockedRev(cfg.root);
    await stream("nix", ["flake", "update", "forgeops-src"], { cwd: cfg.root });
    const nowRev = lockedRev(cfg.root);
    if (wasRev === nowRev) {
      detail(`already at ${short(nowRev)}`);
    } else {
      ok(`${short(wasRev)} -> ${short(nowRev)}`);
    }
    after = inputPath(cfg.root, "forgeops-src");
  }

  const oldChart = join(before, "charts", "identity-platform");
  const newChart = join(after, "charts", "identity-platform");
  let clean = true;

  if (after !== before) {
    clean = reportChartChanges(oldChart, newChart) && clean;
  } else if (!opts.check) {
    detail("chart unchanged");
  }

  step("Checking image coverage");
  try {
    verifyImageCoverage(newChart);
    ok("every image key in the chart has an explicit decision in fo");
  } catch (e) {
    clean = false;
    fail(e instanceof Error ? e.message : String(e));
  }

  clean = (await checkImagesExist(newChart)) && clean;

  // The IDM baseline is "the stock image's conf", so it is only valid for one
  // image tag. `fo config export idm` keys the cache by tag and would simply
  // extract a new one - but a stale directory per release adds up, and after
  // an upgrade nothing will ever read the old one again.
  clearStaleBaselines(cfg);

  if (!opts.check) {
    step("Next");
    detail("review tools/fo/config.ts: RELEASE is set by hand, not by the flake");
    detail("`fo up` to converge onto the new pin");
    detail(dim("PingAM FBC in platform/am/config is upgraded by `fo config export am`,"));
    detail(dim("which runs the am-config-upgrader for the new release."));
  }

  return clean;
}

function lockedRev(root: string): string {
  const lock = JSON.parse(readFileSync(join(root, "flake.lock"), "utf8")) as {
    nodes: Record<string, { locked?: { rev?: string; ref?: string } }>;
  };
  return lock.nodes["forgeops-src"]?.locked?.rev ?? "unknown";
}

function short(rev: string): string {
  return rev === "unknown" ? rev : rev.slice(0, 12);
}

/**
 * The store path of a flake input after a lock change.
 *
 * The running `fo` has FO_FORGEOPS_SRC baked in by the nix wrapper, so it
 * still points at the OLD tree; `nix flake archive --json` is what makes the
 * new one visible without re-entering the shell.
 */
function inputPath(root: string, name: string): string {
  const r = capture("nix", ["flake", "archive", "--json", "--no-write-lock-file"], {
    cwd: root,
  });
  const parsed = decode(
    r.stdout,
    "nix flake archive --json",
    obj({ inputs: opt(record(obj({ path: opt(str) }))) }),
  );
  const path = parsed.inputs?.[name]?.path;
  if (!path) throw new Error(`nix flake archive did not report a path for ${name}`);
  return path;
}

function reportChartChanges(oldChart: string, newChart: string): boolean {
  step("Chart changes");
  const oldV = chartVersion(oldChart);
  const newV = chartVersion(newChart);
  if (oldV !== newV) detail(`chart version ${oldV} -> ${newV}`);

  const before = chartImages(oldChart);
  const after = chartImages(newChart);
  let clean = true;

  for (const [key, image] of after) {
    const was = before.get(key);
    if (!was) {
      clean = false;
      warn(`new image key ${key} (${image.repository}:${image.tag})`);
    } else if (was.repository !== image.repository) {
      clean = false;
      warn(`${key} repository ${was.repository} -> ${image.repository}`);
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) {
      clean = false;
      warn(`image key ${key} removed - drop it from tools/fo/values.ts`);
    }
  }

  // Value keys, not just images: a renamed key means the value fo generates is
  // silently ignored, which is the failure mode D2 accepted responsibility for.
  const nowKeys = new Set(topLevelKeys(newChart));
  const removed = topLevelKeys(oldChart).filter((k) => !nowKeys.has(k));
  if (removed.length > 0) {
    clean = false;
    warn(`top-level values keys removed: ${removed.join(", ")}`);
  }

  if (clean) ok("no image or top-level key changes");
  return clean;
}

function chartVersion(chartPath: string): string {
  const text = readFileSync(join(chartPath, "Chart.yaml"), "utf8");
  return /^version: *"?([^"\n]+)"?/m.exec(text)?.[1]?.trim() ?? "unknown";
}

function topLevelKeys(chartPath: string): string[] {
  const text = readFileSync(join(chartPath, "values.yaml"), "utf8");
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):/.exec(line);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

/**
 * Ask the registry whether each ref exists, without pulling it.
 *
 * `docker manifest inspect` is a HEAD against the registry's manifest
 * endpoint, so this is cheap even for the 1.5 GB images.
 */
async function checkImagesExist(chartPath: string): Promise<boolean> {
  step("Checking every pinned image exists");
  const refs = [
    ...resolvedImages(chartPath),
    // Not in the chart at all: the config upgrader is a local docker run, and
    // it is published under the PRODUCT version rather than the release tag
    // every other image uses. Checking it here is the only place that catches
    // a release where that assumption breaks.
    { key: "am-config-upgrader", ref: AM_UPGRADER_IMAGE },
  ];
  // Concurrently: each probe is a round trip to a registry that can take tens
  // of seconds, and sequentially this was the slowest thing `fo` did.
  const results = await Promise.all(
    refs.map(async ({ key, ref }) => ({
      key,
      ref,
      code: (await captureAsync("docker", ["manifest", "inspect", ref], { allowFailure: true })).code,
    })),
  );
  let allOk = true;
  for (const { key, ref, code } of results) {
    if (code === 0) {
      detail(`ok   ${key} -> ${ref}`);
    } else {
      allOk = false;
      fail(`MISSING ${key} -> ${ref}`);
    }
  }
  if (allOk) ok(`${refs.length} images resolve`);
  else {
    fail(
      "a missing image will not fail the helm install - it fails much later, " +
        "in a pod event nobody reads. Fix the tag in tools/fo/values.ts.",
    );
  }
  return allOk;
}

function clearStaleBaselines(cfg: ResolvedConfig): void {
  const dir = join(cfg.root, ".fo", "baseline");
  if (!existsSync(dir)) return;
  const keep = `idm-${RELEASE.imageTag}`;
  let removed = 0;
  for (const e of readdirSync(dir)) {
    if (e !== keep) {
      rmSync(join(dir, e), { recursive: true, force: true });
      removed += 1;
    }
  }
  if (removed > 0) detail(`cleared ${removed} stale config baseline(s)`);
}


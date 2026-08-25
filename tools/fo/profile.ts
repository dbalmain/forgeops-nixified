import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { capture } from "./lib/proc.ts";
import { detail, ok, step } from "./lib/ui.ts";
import { importImage } from "./cluster/k3d.ts";
import { RELEASE, REGISTRY, type ResolvedConfig } from "./config.ts";

/**
 * IDM's config profile is a busybox image whose /config is copied into the
 * pod by an init container. We build one so that:
 *
 *  - the dev profile can turn IDM's file watcher ON. ForgeOps ships
 *    `openidm.fileinstall.enabled=false`, and without flipping it a file
 *    synced into a running pod is simply ignored, which kills the entire
 *    inner loop. See spike/RESULTS.md, finding 1.
 *  - the script recompile interval can drop from ForgeOps' 60s to ~1s.
 *  - whatever the user has authored under platform/idm/ ships with it.
 *
 * These two properties are the ONLY difference between this and a production
 * profile, and neither belongs in production.
 */
export const IDM_PROFILE_IMAGE = "fo-idm-config";

export type BuiltImage = { repository: string; tag: string };

/** Read a file out of the pinned IDM image without running a container shell. */
function readFromIdmImage(path: string): string {
  const image = `${REGISTRY}/idm:${RELEASE.imageTag}`;
  const r = capture("docker", ["run", "--rm", "--entrypoint", "cat", image, path]);
  return r.stdout;
}

function applyDevOverrides(cfg: ResolvedConfig, systemProps: string): string {
  let out = systemProps;
  if (cfg.idmHotReload) {
    if (!/^openidm\.fileinstall\.enabled=/m.test(out)) {
      throw new Error(
        "openidm.fileinstall.enabled not found in the IDM image's " +
          "system.properties. ForgeOps may have moved it; fo cannot enable " +
          "hot reload blindly.",
      );
    }
    out = out.replace(
      /^openidm\.fileinstall\.enabled=.*$/m,
      "openidm.fileinstall.enabled=true",
    );
  }
  return out;
}

function copyTree(from: string, to: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync(from);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const src = join(from, e);
    const dst = join(to, e);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      n += copyTree(src, dst);
    } else {
      mkdirSync(join(dst, ".."), { recursive: true });
      writeFileSync(dst, readFileSync(src));
      n += 1;
    }
  }
  return n;
}

function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else {
        h.update(relative(dir, p));
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 12);
}

export async function buildIdmProfile(
  cfg: ResolvedConfig,
): Promise<BuiltImage> {
  step("Building IDM config profile");

  const build = join(cfg.stateDir, "idm-profile");
  rmSync(build, { recursive: true, force: true });
  mkdirSync(join(build, "conf"), { recursive: true });
  mkdirSync(join(build, "script"), { recursive: true });

  const props = applyDevOverrides(cfg, readFromIdmImage(
    "/opt/openidm/conf/system.properties",
  ));
  writeFileSync(join(build, "conf", "system.properties"), props);

  // Lower the script recompile interval so a changed script shows up in
  // seconds rather than up to a minute.
  const scriptJson = readFromIdmImage("/opt/openidm/conf/script.json");
  writeFileSync(
    join(build, "conf", "script.json"),
    scriptJson.replace(
      /"javascript\.recompile\.minimumInterval"\s*:\s*\d+/,
      `"javascript.recompile.minimumInterval" : ${cfg.idmScriptRecompileMs}`,
    ),
  );

  const userConf = copyTree(join(cfg.root, "platform", "idm", "conf"), join(build, "conf"));
  const userScript = copyTree(join(cfg.root, "platform", "idm", "script"), join(build, "script"));
  detail(
    `hot reload ${cfg.idmHotReload ? "on" : "off"}, ` +
      `recompile ${cfg.idmScriptRecompileMs}ms, ` +
      `${userConf} user conf + ${userScript} user script files`,
  );

  writeFileSync(
    join(build, "Dockerfile"),
    ["FROM busybox:musl", "RUN mkdir /config", "COPY conf /config/conf", "COPY script /config/script", ""].join("\n"),
  );

  const tag = hashTree(join(build, "conf")) + "-" + hashTree(join(build, "script"));
  const image = `${IDM_PROFILE_IMAGE}:${tag}`;
  capture("docker", ["build", "-q", "-t", image, build]);
  await importImage(cfg.clusterName, image);
  ok(`${image}`);
  return { repository: IDM_PROFILE_IMAGE, tag };
}

export const AM_PROFILE_IMAGE = "fo-am-config";

/**
 * PingAM's config profile, built from `platform/am/config` - the tree
 * `fo config export am` writes.
 *
 * The chart's `am_custom` image is a plain container whose `/config/config` an
 * init container copies onto an emptyDir before PingAM boots (see the chart's
 * `custom-vol-init.sh`), exactly like IDM's profile. It defaults to
 * `busybox:musl`, which has no `/config`, so a stock deploy takes the image's
 * own config.
 *
 * Returns undefined when there is nothing to ship, so `fo up` leaves
 * `am_custom` at the chart's default rather than deploying an empty profile -
 * an empty `/config/config` would still count as "custom FBC found" and PingAM
 * would boot with no services at all.
 */
export async function buildAmProfile(
  cfg: ResolvedConfig,
): Promise<BuiltImage | undefined> {
  const source = join(cfg.root, "platform", "am", "config");
  if (!existsSync(source) || countFiles(source) === 0) return undefined;

  step("Building PingAM config profile");
  const build = join(cfg.stateDir, "am-profile");
  rmSync(build, { recursive: true, force: true });
  mkdirSync(join(build, "config"), { recursive: true });
  const n = copyTree(source, join(build, "config"));
  detail(`${n} FBC files from platform/am/config`);

  writeFileSync(
    join(build, "Dockerfile"),
    ["FROM busybox:musl", "RUN mkdir /config", "COPY config /config/config", ""].join("\n"),
  );

  const tag = hashTree(join(build, "config"));
  const image = `${AM_PROFILE_IMAGE}:${tag}`;
  capture("docker", ["build", "-q", "-t", image, build]);
  await importImage(cfg.clusterName, image);
  ok(`${image}`);
  return { repository: AM_PROFILE_IMAGE, tag };
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

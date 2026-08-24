import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

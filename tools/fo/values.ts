import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE, type Component, type ResolvedConfig } from "./config.ts";

const CHART_KEY: Record<Component, string> = {
  am: "am",
  idm: "idm",
  "ds-idrepo": "ds_idrepo",
  "ds-cts": "ds_cts",
  amster: "amster",
  "admin-ui": "admin_ui",
  "end-user-ui": "end_user_ui",
  "login-ui": "login_ui",
};

type ImageRef = [chartKey: string, field: string];

/**
 * Images that must move together with the ForgeOps release.
 *
 * This is a list of (chart key, field) pairs rather than a list of chart keys
 * because SOME KEYS HOLD TWO IMAGES and the second is not a platform image:
 * `keystore_create.image` is kubectl and `keystore_create.initImage` is PingAM;
 * `ssh_keygen.image` is kubectl and `ssh_keygen.initImage` is dockette/ssh.
 * Blanket-setting `<key>.image.tag` asks for `kubectl:2026.3.0-1849`, which
 * does not exist, and the job then hangs forever with the real cause buried in
 * a pod event. `verifyImageCoverage` below stops that recurring.
 */
const PLATFORM_IMAGES: ImageRef[] = [
  ["am", "image"],
  ["amster", "image"],
  ["idm", "image"],
  ["ds_idrepo", "image"],
  ["ds_cts", "image"],
  ["ds_set_passwords", "image"],
  ["keystore_create", "initImage"],
  ["admin_ui", "image"],
  ["end_user_ui", "image"],
  ["login_ui", "image"],
];

/** Utility images ForgeOps pins independently of the platform release. */
const PINNED_IMAGES: Array<{ ref: ImageRef; tag: string }> = [
  { ref: ["keystore_create", "image"], tag: "1.36.1" },
  { ref: ["ds_snapshot", "image"], tag: "1.36.1" },
  { ref: ["ssh_keygen", "image"], tag: "1.36.1" },
  // dockette/ssh publishes ONLY `latest`. The repo chart already says
  // `latest`, but the PUBLISHED chart rewrites every tag to the release tag
  // and so cannot install at all. Pinning here means an upstream change
  // cannot reintroduce that. See spike/RESULTS.md, finding 2.
  { ref: ["ssh_keygen", "initImage"], tag: "latest" },
];

/** Config-profile images, which we build ourselves; busybox otherwise. */
const PROFILE_IMAGES: ImageRef[] = [
  ["am_custom", "image"],
  ["idm_custom", "image"],
];

export type Values = Record<string, unknown>;

function setImage(v: Values, [key, field]: ImageRef, image: object): void {
  const parent = (v[key] as Record<string, unknown> | undefined) ?? {};
  v[key] = { ...parent, [field]: { ...(parent[field] as object), ...image } };
}

export type ChartImage = { repository: string; tag: string };

/**
 * Every `<key>.<field>.repository` in a chart's values.yaml, with the tag the
 * chart defaults to.
 *
 * A regex over the YAML rather than a parse, which is what lets `fo` have no
 * npm dependencies at all.
 */
export function chartImages(chartPath: string): Map<string, ChartImage> {
  const text = readFileSync(join(chartPath, "values.yaml"), "utf8");
  const found = new Map<string, ChartImage>();
  let top = "";
  let field = "";
  for (const line of text.split("\n")) {
    const t = /^([a-z_]+):/.exec(line);
    if (t) {
      top = t[1]!;
      field = "";
    }
    const f = /^ {2}([a-zA-Z_]*[Ii]mage):/.exec(line);
    if (f) field = f[1]!;
    if (!field) continue;
    const repo = /^ {4}repository: *(\S+)/.exec(line);
    if (repo) found.set(`${top}.${field}`, { repository: repo[1]!, tag: "" });
    const tag = /^ {4}tag: *(\S+)/.exec(line);
    const entry = found.get(`${top}.${field}`);
    if (tag && entry) entry.tag = tag[1]!;
  }
  return found;
}

/**
 * The image refs `fo` actually deploys: the chart's repositories with fo's
 * tags. `fo upgrade` checks each of these exists in the registry, which is the
 * check that would have caught `dockette/ssh:2026.3.0-1849` in one command
 * instead of via a four-step failure cascade.
 */
export function resolvedImages(chartPath: string): Array<{ key: string; ref: string }> {
  const chart = chartImages(chartPath);
  const out: Array<{ key: string; ref: string }> = [];
  const push = (key: string, tag: string): void => {
    const entry = chart.get(key);
    if (entry) out.push({ key, ref: `${entry.repository}:${tag}` });
  };
  for (const [k, f] of PLATFORM_IMAGES) push(`${k}.${f}`, RELEASE.imageTag);
  for (const { ref: [k, f], tag } of PINNED_IMAGES) push(`${k}.${f}`, tag);
  for (const [k, f] of PROFILE_IMAGES) {
    const entry = chart.get(`${k}.${f}`);
    // Profile images are only the chart default until `fo` builds one locally,
    // and a locally-built image is not in any registry to check.
    if (entry) out.push({ key: `${k}.${f}`, ref: `${entry.repository}:${entry.tag}` });
  }
  return out;
}

/**
 * Assert that every `repository:` in the pinned chart's values.yaml is one we
 * have an explicit decision about. A component ForgeOps adds in a future
 * release would otherwise silently keep the chart's `latest`, which is a
 * different build from the rest of the stack.
 */
export function verifyImageCoverage(chartPath: string): void {
  const known = new Set(
    [
      ...PLATFORM_IMAGES,
      ...PINNED_IMAGES.map((p) => p.ref),
      ...PROFILE_IMAGES,
    ].map(([k, f]) => `${k}.${f}`),
  );

  const found = [...chartImages(chartPath).keys()];
  const unknown = found.filter((f) => !known.has(f));
  if (unknown.length > 0) {
    throw new Error(
      `chart values.yaml has image keys fo does not know about: ` +
        `${unknown.join(", ")}. Add them to PLATFORM_IMAGES or PINNED_IMAGES ` +
        `in tools/fo/values.ts - leaving them unset pins them to the chart's ` +
        `"latest", which is a different build from the rest of the stack.`,
    );
  }
}

export type ProfileImages = {
  idm?: { repository: string; tag: string } | undefined;
  am?: { repository: string; tag: string } | undefined;
};

export function buildValues(
  cfg: ResolvedConfig,
  profiles: ProfileImages = {},
): Values {
  verifyImageCoverage(cfg.chartPath);

  const enabled = new Set(cfg.components);
  const v: Values = {
    platform: {
      ingress: {
        className: "traefik",
        hosts: [cfg.fqdn],
        tls: {
          issuer: {
            name: "platform-issuer",
            kind: "Issuer",
            create: { type: "self-signed" },
          },
          secret: { name: "platform-tls" },
        },
      },
      // k3s ships `local-path`; `fo` adds a `fast` alias because that is the
      // name the chart and its size presets expect.
      storage: { storage_class: { name: "fast" } },
    },
  };

  for (const ref of PLATFORM_IMAGES) {
    setImage(v, ref, { tag: RELEASE.imageTag, pullPolicy: "IfNotPresent" });
  }
  for (const { ref, tag } of PINNED_IMAGES) {
    setImage(v, ref, { tag, pullPolicy: "IfNotPresent" });
  }

  for (const [component, key] of Object.entries(CHART_KEY)) {
    const parent = (v[key] as Record<string, unknown> | undefined) ?? {};
    v[key] = { ...parent, enabled: enabled.has(component as Component) };
  }

  for (const key of ["ds_idrepo", "ds_cts"]) {
    const parent = (v[key] as Record<string, unknown> | undefined) ?? {};
    v[key] = {
      ...parent,
      volumeClaimSpec: {
        storageClassName: "fast",
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: cfg.dsDiskSize } },
      },
    };
  }

  for (const [key, image] of [
    ["idm_custom", profiles.idm],
    ["am_custom", profiles.am],
  ] as const) {
    if (!image) continue;
    setImage(v, [key, "image"], {
      repository: image.repository,
      tag: image.tag,
      pullPolicy: "IfNotPresent",
    });
  }

  return v;
}

/**
 * Helm parses values files as YAML, and YAML is a superset of JSON, so we emit
 * JSON. That is why `fo` needs no YAML library and therefore no npm
 * dependencies at all.
 */
export function renderValues(v: Values): string {
  return JSON.stringify(v, null, 2) + "\n";
}

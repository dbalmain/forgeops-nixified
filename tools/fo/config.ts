import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The ForgeOps release this checkout is pinned to.
 *
 * `imageTag` is deliberately NOT the product version. The docs tell you to use
 * the product version (8.1.1), but the published Helm chart pins
 * <release>-<build> (2026.3.0-1849) and the two are DIFFERENT BUILDS with
 * different digests. We pin the chart's scheme because that is the combination
 * ForgeOps actually tested. See spike/RESULTS.md, finding 3.
 */
export const RELEASE = {
  forgeops: "2026.3.0",
  imageTag: "2026.3.0-1849",
  productVersion: "8.1.1",
} as const;

export const REGISTRY = "us-docker.pkg.dev/forgeops-public/images";

export type Component =
  | "am"
  | "idm"
  | "ds-idrepo"
  | "ds-cts"
  | "amster"
  | "admin-ui"
  | "end-user-ui"
  | "login-ui";

export const ALL_COMPONENTS: Component[] = [
  "am",
  "idm",
  "ds-idrepo",
  "ds-cts",
  "amster",
  "admin-ui",
  "end-user-ui",
  "login-ui",
];

export type StackConfig = {
  /** Components to deploy. Defaults to all of ALL_COMPONENTS. */
  components?: Component[];
  /** k3d cluster name shared by every env on this machine. */
  clusterName?: string;
  /** Default env name when --env is not given. */
  defaultEnv?: string;
  /**
   * FQDN template. `{env}` is substituted. `*.localhost` resolves to loopback
   * on systemd hosts; `fo doctor` verifies it and suggests the nip.io fallback
   * when it does not.
   */
  fqdnTemplate?: string;
  /** Persistent volume size for each DS instance. */
  dsDiskSize?: string;
  /**
   * Turn IDM's file watcher on so config synced into a running pod reloads.
   * ForgeOps ships this OFF; without it the inner loop does not work at all.
   * Never enable this in production. See spike/RESULTS.md, finding 1.
   */
  idmHotReload?: boolean;
  /**
   * How long IDM waits before recompiling a changed script, in ms. ForgeOps
   * ships 60000, which makes a script edit take up to a minute to show up.
   */
  idmScriptRecompileMs?: number;
};

export type ResolvedConfig = Required<StackConfig> & {
  env: string;
  namespace: string;
  fqdn: string;
  root: string;
  stateDir: string;
  kubeconfig: string;
  chartPath: string;
  secretsValuesPath: string;
};

export function defineStack(cfg: StackConfig): StackConfig {
  return cfg;
}

const DEFAULTS = {
  components: ALL_COMPONENTS,
  clusterName: "fo",
  defaultEnv: "dev",
  fqdnTemplate: "{env}.localhost",
  dsDiskSize: "10Gi",
  idmHotReload: true,
  idmScriptRecompileMs: 1000,
} satisfies Required<StackConfig>;

export function root(): string {
  const r = process.env["FO_ROOT"];
  if (!r) {
    throw new Error(
      "FO_ROOT is not set. Run `fo` from the nix devShell (direnv allow) " +
        "or via `nix run`.",
    );
  }
  return r;
}

export function forgeopsSrc(): string {
  const p = process.env["FO_FORGEOPS_SRC"];
  if (!p) {
    throw new Error(
      "FO_FORGEOPS_SRC is not set. Run `fo` from the nix devShell or " +
        "via `nix run`.",
    );
  }
  return p;
}

export async function loadConfig(envName?: string): Promise<ResolvedConfig> {
  const r = root();
  const configPath = join(r, "fo.config.ts");
  let user: StackConfig = {};
  if (existsSync(configPath)) {
    const mod = (await import(configPath)) as { default?: StackConfig };
    user = mod.default ?? {};
  }
  const merged = { ...DEFAULTS, ...stripUndefined(user) };
  const env = envName ?? process.env["FO_ENV"] ?? merged.defaultEnv;
  const src = forgeopsSrc();
  return {
    ...merged,
    env,
    namespace: env,
    fqdn: merged.fqdnTemplate.replace("{env}", env),
    root: r,
    stateDir: join(r, ".fo", env),
    kubeconfig: join(r, ".fo", env, "kubeconfig"),
    chartPath: join(src, "charts", "identity-platform"),
    secretsValuesPath: join(
      src,
      "charts",
      "identity-platform",
      "values-helm-generate-secrets.yaml",
    ),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Map a component name to the Kubernetes label selector that finds its pods. */
export const POD_SELECTOR: Record<Component, string> = {
  am: "app=am",
  idm: "app=idm",
  "ds-idrepo": "app=ds-idrepo",
  "ds-cts": "app=ds-cts",
  amster: "app=amster",
  "admin-ui": "app=admin-ui",
  "end-user-ui": "app=end-user-ui",
  "login-ui": "app=login-ui",
};

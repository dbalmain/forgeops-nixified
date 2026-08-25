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

/**
 * The log console (PLAN.md section 9). `off` is tier 0: `fo logs` tails pods
 * with stern and the cluster carries nothing. `victorialogs` adds the tier-1
 * indexed store plus a Vector DaemonSet.
 */
export type LogsBackend = "off" | "victorialogs";

export type LogsOptions = {
  backend?: LogsBackend;
  /**
   * Ship the kubelet's own health-probe traffic.
   *
   * Off by default, and this is where the noise actually is. Measured on a
   * 13-hour-old stack: 99% of login-ui's log lines and 96% of admin-ui's were
   * `kube-probe` requests, against 1.4 MB per UI pod. Dropping them is the
   * difference between a console showing what the platform did and one
   * showing what Kubernetes asked it every ten seconds.
   *
   * PLAN.md proposed excluding PingDS `ldap-access` instead. Measurement said
   * otherwise: ForgeOps ships PingDS's console access logger with
   * `filtering-policy: inclusive` and only four criteria - administrative
   * requests, auth failures, requests over 1000 ms, and misbehaving clients -
   * so PingDS wrote 18 KB where each UI pod wrote 1.4 MB. Excluding it would
   * have dropped the most useful DS signal there is to solve a volume problem
   * upstream had already solved.
   */
  includeHealthChecks?: boolean;
  /**
   * How much PingDS puts on stdout.
   *
   * `filtered` is what ForgeOps ships: PingDS's console access logger runs
   * `filtering-policy: inclusive` with four criteria - administrative
   * requests, auth failures, requests over 1000 ms, and misbehaving clients.
   * Quiet, and the right four things to be told about unprompted.
   *
   * `full` turns the filter off, which is what makes PingDS appear in an
   * ordinary `fo trace`: under the default, a healthy login produces no DS
   * console output at all, so the DS leg of a trace is empty exactly when
   * nothing is wrong. Measured cost: about 8 KB of DS output per PingIDM REST
   * call, against 18 KB TOTAL over a 13-hour idle stack when filtered.
   */
  dsAccessDetail?: "filtered" | "full";
  /** How long VictoriaLogs keeps data. Its own `-retentionPeriod` syntax. */
  retention?: string;
  /** PersistentVolumeClaim size for the log store. */
  diskSize?: string;
};

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
   * Extra directories to look in for packages, after this repo's `packages/`.
   * Paths only - nothing is fetched over the network, so a third-party source
   * is something you wrote down deliberately.
   */
  packageSources?: string[];
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
  /**
   * The log console. A bare string is shorthand for `{ backend: "..." }`, so
   * turning it on really is one line in this file.
   */
  logs?: LogsBackend | LogsOptions;
};

export type ResolvedConfig = Required<Omit<StackConfig, "logs">> & {
  /** Always the object form; `normalizeLogs` widens the string shorthand. */
  logs: Required<LogsOptions>;
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
  packageSources: [],
  logs: "off",
} satisfies Required<StackConfig>;

export const LOGS_DEFAULTS: Required<LogsOptions> = {
  backend: "off",
  includeHealthChecks: false,
  dsAccessDetail: "filtered",
  retention: "7d",
  diskSize: "5Gi",
};

/**
 * Accept both `logs: "victorialogs"` and the full object, so the common case
 * stays one word and the tuning knobs are still typed.
 */
export function normalizeLogs(
  logs: LogsBackend | LogsOptions | undefined,
): Required<LogsOptions> {
  if (logs === undefined) return { ...LOGS_DEFAULTS };
  if (typeof logs === "string") return { ...LOGS_DEFAULTS, backend: logs };
  return { ...LOGS_DEFAULTS, ...stripUndefined(logs) };
}

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
    logs: normalizeLogs(user.logs),
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

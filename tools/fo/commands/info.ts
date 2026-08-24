import { capture } from "../lib/proc.ts";
import { bold, dim, heading, table } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Where each credential actually lives. The chart generates these with Helm's
 * own functions and reads any existing Secret before generating, so they are
 * stable across redeploys - which is why printing them is useful rather than
 * merely momentarily true.
 */
const CREDENTIALS: Array<{
  label: string;
  secret: string;
  key: string;
  user: string;
}> = [
  {
    label: "AM admin",
    secret: "am-env-secrets",
    key: "AM_PASSWORDS_AMADMIN_CLEAR",
    user: "amadmin",
  },
  {
    label: "IDM admin",
    secret: "idm-env-secrets",
    key: "OPENIDM_ADMIN_PASSWORD",
    user: "openidm-admin",
  },
  {
    label: "DS dirmanager",
    secret: "ds-passwords",
    key: "dirmanager.pw",
    user: "uid=admin",
  },
];

export function readSecret(
  cfg: ResolvedConfig,
  secret: string,
  key: string,
): string | undefined {
  const r = capture(
    "kubectl",
    [
      "-n",
      cfg.namespace,
      "get",
      "secret",
      secret,
      "-o",
      `jsonpath={.data.${key.replace(/\./g, "\\.")}}`,
    ],
    { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
  );
  const b64 = r.stdout.trim();
  if (r.code !== 0 || !b64) return undefined;
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Taken from the chart's Ingress objects, which the flake pins, not from the
 * chart's NOTES.txt - the NOTES advertise `/admin`, but that path routes to
 * PingIDM and 404s, because the platform UI replaced IDM's own admin UI.
 *
 * The full ingress table is:
 *   /platform -> admin-ui      /enduser  -> end-user-ui
 *   /am       -> am            /am/XUI   -> login-ui
 *   /openidm, /upload, /export, /admin, /openicf -> idm
 */
export function urls(cfg: ResolvedConfig): Array<[string, string]> {
  const base = `https://${cfg.fqdn}`;
  return [
    ["Platform admin", `${base}/platform`],
    ["End user", `${base}/enduser`],
    ["AM console", `${base}/am`],
    ["Login UI", `${base}/am/XUI`],
    ["IDM REST", `${base}/openidm`],
  ];
}

export function info(cfg: ResolvedConfig, asJson: boolean): void {
  const creds = CREDENTIALS.map((c) => ({
    ...c,
    password: readSecret(cfg, c.secret, c.key),
  })).filter((c) => c.password !== undefined);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          env: cfg.env,
          namespace: cfg.namespace,
          fqdn: cfg.fqdn,
          urls: Object.fromEntries(urls(cfg)),
          credentials: creds.map(({ label, user, password }) => ({
            label,
            user,
            password,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  heading(`${cfg.env}  ${dim(`namespace ${cfg.namespace}`)}`);
  console.log(`\n ${bold("URLs")}`);
  table(urls(cfg));
  console.log(`\n ${bold("Credentials")}`);
  if (creds.length === 0) {
    console.log(`   ${dim("no secrets yet - is the stack up? try: fo up")}`);
  } else {
    table(creds.map((c) => [c.label, `${c.user} / ${c.password}`]));
  }
  console.log(
    `\n ${dim("TLS is a cert-manager self-signed cert, so browsers will warn.")}`,
  );
}

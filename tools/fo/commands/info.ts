import { getOptional } from "../lib/k8s.ts";
import { logsUrl } from "../logstack.ts";
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
  note?: string;
}> = [
  {
    label: "AM admin",
    secret: "am-env-secrets",
    key: "AM_PASSWORDS_AMADMIN_CLEAR",
    user: "amadmin",
    note: "the platform UI and the AM console",
  },
  {
    label: "IDM admin",
    secret: "idm-env-secrets",
    key: "OPENIDM_ADMIN_PASSWORD",
    user: "openidm-admin",
    // ForgeOps runs IDM in platform mode, so authentication is delegated to
    // AM. This password is IDM's internal admin and does NOT work against
    // /openidm/** through the ingress - you get `authenticationId: anonymous`
    // and a 403 that reads like an access-control problem. Saying so here
    // costs one line and saves an afternoon.
    note: "internal only - NOT valid for /openidm REST; use `fo token`",
  },
  {
    label: "DS dirmanager",
    secret: "ds-passwords",
    key: "dirmanager.pw",
    user: "uid=admin",
    note: "LDAP, via `fo shell ds-idrepo`",
  },
];

export function readSecret(
  cfg: ResolvedConfig,
  secret: string,
  key: string,
): string | undefined {
  // `--ignore-not-found` rather than `allowFailure`. A secret that does not
  // exist yet is a real answer; an unreachable cluster is not, and folding the
  // two together made `fo info --json` print empty credentials and exit ZERO
  // against a stack it could not read.
  const b64 = getOptional(cfg, [
    "secret",
    secret,
    "-o",
    `jsonpath={.data.${key.replace(/\./g, "\\.")}}`,
  ]).trim();
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : undefined;
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
    // Only when the opt-in tier is on: advertising a URL that 404s is worse
    // than not mentioning the feature.
    ...(cfg.logs.backend !== "off"
      ? ([["Log console", logsUrl(cfg)]] as Array<[string, string]>)
      : []),
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
          credentials: creds.map(({ label, user, password, note }) => ({
            label,
            user,
            password,
            ...(note ? { note } : {}),
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
    table(
      creds.map((c) => [
        c.label,
        `${c.user} / ${c.password}${c.note ? dim(`   ${c.note}`) : ""}`,
      ]),
    );
  }
  console.log(
    `\n ${dim("TLS is a cert-manager self-signed cert, so browsers will warn.")}`,
  );
  console.log(
    ` ${dim("For IDM REST: curl -k -H \"Authorization: Bearer $(fo token)\" ...")}`,
  );
}

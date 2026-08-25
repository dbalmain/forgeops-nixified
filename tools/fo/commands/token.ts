import { readSecret } from "./info.ts";
import { fetchIngress } from "../lib/http.ts";
import { die } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * An OAuth2 access token for calling PingIDM's REST API.
 *
 * Needed because ForgeOps runs IDM in platform mode, where authentication is
 * delegated to PingAM: the `openidm-admin` password in `fo info` is NOT usable
 * against `/openidm/**` through the ingress. Anything else gets
 * `authenticationId: anonymous` and a 403 that looks like an access-control
 * problem rather than an authentication one.
 *
 * The `idm-provisioning` client and its secret are created by the amster job,
 * and it lives in the ROOT realm - not `alpha`, which this deployment does not
 * have.
 */
const CLIENT = "idm-provisioning";
const SCOPE = "fr:idm:*";

export async function getToken(cfg: ResolvedConfig): Promise<string> {
  const secret = readSecret(
    cfg,
    "amster-env-secrets",
    "IDM_PROVISIONING_CLIENT_SECRET",
  );
  if (!secret) {
    die(
      `no ${CLIENT} client secret in namespace ${cfg.namespace}. ` +
        `Is the stack up? try: fo status`,
    );
  }
  const ca = readSecret(cfg, "platform-tls", "ca.crt");

  const res = await fetchIngress(cfg, "/am/oauth2/access_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " +
        Buffer.from(`${CLIENT}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: SCOPE,
    }).toString(),
    ...(ca ? { ca } : {}),
  });

  if (res.status !== 200) {
    die(`AM returned ${res.status} for a token request: ${res.body.slice(0, 300)}`);
  }
  const token = (JSON.parse(res.body) as { access_token?: string }).access_token;
  if (!token) die(`AM returned no access_token: ${res.body.slice(0, 300)}`);
  return token;
}

export async function token(cfg: ResolvedConfig): Promise<void> {
  console.log(await getToken(cfg));
}

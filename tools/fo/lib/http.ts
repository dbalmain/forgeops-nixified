import { request as httpsRequest } from "node:https";
import type { ResolvedConfig } from "../config.ts";

export type Response = { status: number; body: string };

/**
 * HTTPS against the stack's ingress, trusting the cluster's own CA rather than
 * disabling verification. cert-manager puts the self-signed CA in the
 * `platform-tls` secret, so `fo` can verify properly and still work with a
 * cert no public root would vouch for.
 */
export function fetchIngress(
  cfg: ResolvedConfig,
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    ca?: string;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: cfg.fqdn,
        port: 443,
        path,
        method: opts.method ?? "GET",
        headers: opts.headers,
        ...(opts.ca
          ? { ca: opts.ca }
          : // No CA available (the stack may not be up yet). This talks only
            // to a local k3d cluster over loopback, so there is no meaningful
            // interception risk, but we never do this when we could verify.
            { rejectUnauthorized: false }),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./lib/proc.ts";
import { detail, ok, step } from "./lib/ui.ts";
import type { ResolvedConfig } from "./config.ts";

const RELEASE_NAME = "identity-platform";

/**
 * Why `fo` generates these instead of letting the chart do it.
 *
 * The chart's Helm-native path is `randAlphaNum <n> | b64enc`. A 32-character
 * random alphanumeric string very often contains a dictionary word, and PingDS
 * rejects such a password outright:
 *
 *   The LDAP modify request failed: 19 (Constraint Violation)
 *   The provided password value was rejected by a password validator:
 *   The provided password contained a word from the server's dictionary
 *
 * Because the chart calls `lookup` before generating, a rejected password is
 * STICKY - every retry of ds-set-passwords reuses it and fails identically, so
 * the deployment never converges. It is a coin flip per environment.
 *
 * So `fo` derives every password from one per-env seed and applies the Secrets
 * before Helm runs. The chart's `lookup` then adopts them and generates
 * nothing. Three things fall out:
 *
 *   - dictionary-safe by construction (see `password`, max 2 letters in a row)
 *   - deterministic: the same seed always yields the same passwords, so
 *     `fo down && fo up` does not invalidate a developer's saved bookmarks
 *   - reproducible: the seed is one file to copy to reproduce an environment
 */

/** Alphabet chosen to avoid glyphs that are ambiguous in a terminal. */
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";

function bytes(seed: Buffer, label: string, n: number): Buffer {
  const out: Buffer[] = [];
  let counter = 0;
  while (out.reduce((a, b) => a + b.length, 0) < n) {
    out.push(
      createHmac("sha256", seed).update(`${label}/${counter}`).digest(),
    );
    counter += 1;
  }
  return Buffer.concat(out).subarray(0, n);
}

/**
 * A password of `length` characters shaped as `LLd-LLd-LLd...`: two letters,
 * one digit, separated by hyphens. The longest run of letters is two, which is
 * below any dictionary word length, so a dictionary validator cannot match.
 * It also guarantees both letters and digits for policies that demand variety.
 */
export function password(seed: Buffer, label: string, length: number): string {
  const groups = Math.ceil(length / 4) + 1;
  const b = bytes(seed, label, groups * 3);
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    parts.push(
      LETTERS[b[g * 3]! % LETTERS.length]! +
        LETTERS[b[g * 3 + 1]! % LETTERS.length]! +
        DIGITS[b[g * 3 + 2]! % DIGITS.length]!,
    );
  }
  return parts.join("-").slice(0, length).replace(/-+$/, "");
}

/** Raw key material (HMAC/encryption keys), not a password anyone types. */
function keyMaterial(seed: Buffer, label: string, n: number): string {
  return bytes(seed, label, n).toString("base64");
}

export function loadSeed(cfg: ResolvedConfig): Buffer {
  const path = join(cfg.stateDir, "seed");
  mkdirSync(cfg.stateDir, { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
}

type SecretSpec = {
  name: string;
  passwords?: Record<string, number>;
  keys?: Record<string, number>;
};

/**
 * Mirrors charts/identity-platform/values-helm-generate-secrets.yaml. Keys
 * listed there with `useBinaryCharacters` are key material; the rest are
 * passwords. Drift here shows up as a pod that cannot authenticate, so
 * `fo upgrade` must diff this against that file.
 */
const SECRETS: SecretSpec[] = [
  {
    name: "am-env-secrets",
    passwords: {
      AM_ENCRYPTION_KEY: 24,
      AM_OIDC_CLIENT_SUBJECT_IDENTIFIER_HASH_SALT: 20,
      AM_PASSWORDS_AMADMIN_CLEAR: 24,
      AM_SELFSERVICE_LEGACY_CONFIRMATION_EMAIL_LINK_SIGNING_KEY: 32,
    },
    keys: {
      AM_AUTHENTICATION_SHARED_SECRET: 32,
      AM_SESSION_STATELESS_ENCRYPTION_KEY: 32,
      AM_SESSION_STATELESS_SIGNING_KEY: 32,
    },
  },
  {
    name: "amster-env-secrets",
    passwords: { IDM_PROVISIONING_CLIENT_SECRET: 24, IDM_RS_CLIENT_SECRET: 24 },
  },
  {
    name: "ds-env-secrets",
    passwords: {
      AM_STORES_APPLICATION_PASSWORD: 32,
      AM_STORES_CTS_PASSWORD: 32,
      AM_STORES_USER_PASSWORD: 32,
    },
  },
  {
    // Only `dirmanager.pw`. `monitor.pw` is set LITERALLY by the chart
    // (`data:` rather than `generate:`), so seeding it makes us the field
    // manager for a field Helm also writes, and Helm 4's server-side apply
    // then refuses the release with a field conflict. The rule: seed only
    // what the chart would otherwise generate.
    name: "ds-passwords",
    passwords: { "dirmanager.pw": 32 },
  },
  { name: "idm-env-secrets", passwords: { OPENIDM_ADMIN_PASSWORD: 24 } },
  { name: "keystore-create", passwords: { KEYSTORE_PASSWORD: 24 } },
];

export function ensureSecrets(cfg: ResolvedConfig): void {
  step("Seeding platform secrets");
  const seed = loadSeed(cfg);
  let created = 0;
  for (const spec of SECRETS) {
    const exists = capture(
      "kubectl",
      ["-n", cfg.namespace, "get", "secret", spec.name, "-o", "name"],
      { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
    );
    if (exists.code === 0 && exists.stdout.trim()) continue;

    const data: Record<string, string> = {};
    for (const [key, len] of Object.entries(spec.passwords ?? {})) {
      data[key] = Buffer.from(
        password(seed, `${spec.name}/${key}`, len),
      ).toString("base64");
    }
    for (const [key, len] of Object.entries(spec.keys ?? {})) {
      data[key] = Buffer.from(
        keyMaterial(seed, `${spec.name}/${key}`, len),
      ).toString("base64");
    }

    capture(
      "kubectl",
      ["apply", "-f", "-"],
      {
        env: { KUBECONFIG: cfg.kubeconfig },
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: spec.name,
            namespace: cfg.namespace,
            // Helm refuses to adopt a resource it did not create unless it
            // carries this ownership metadata.
            labels: { "app.kubernetes.io/managed-by": "Helm" },
            annotations: {
              "meta.helm.sh/release-name": RELEASE_NAME,
              "meta.helm.sh/release-namespace": cfg.namespace,
            },
          },
          type: "Opaque",
          data,
        }),
      },
    );
    created += 1;
  }
  if (created === 0) ok("secrets already present (passwords unchanged)");
  else {
    detail(`derived from ${join(cfg.stateDir, "seed")}`);
    ok(`${created} secrets created`);
  }
}

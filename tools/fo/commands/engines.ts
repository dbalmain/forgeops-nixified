import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../lib/proc.ts";
import { fetchIngress } from "../lib/http.ts";
import { detail, fail, heading, ok, step, warn } from "../lib/ui.ts";
import { arrayOf, decode, obj, opt, str } from "../lib/shape.ts";
import { readSecret } from "./info.ts";
import { getToken } from "./token.ts";
import {
  diffSurface,
  driftIsClean,
  parseProbeOutput,
  probeSource,
  unprobeableKeys,
  type Drift,
  type Surface,
} from "../engine-probe.ts";
import { RELEASE, type ResolvedConfig } from "../config.ts";

type SurfaceFile = {
  probedOn: string;
  forgeopsRelease: string;
  platformVersion: string;
  engine: string;
  am: Surface;
  idm: Surface;
};

const SURFACE = ["platform", "typescript", "framework", "engine-surface.json"];
// The behavioural corpus, generated from tools/emit-corpus.ts by the same
// esbuild+Babel pipeline that builds an endpoint. Committed so the probe needs
// no node_modules; tests/emit-probe.test.mjs fails if it drifts from the
// pipeline.
const EMIT_PROBE = ["platform", "typescript", "framework", "engine-emit-probe.js"];

export function readSurfaceFile(cfg: ResolvedConfig): SurfaceFile {
  return JSON.parse(
    readFileSync(join(cfg.root, ...SURFACE), "utf8"),
  ) as SurfaceFile;
}

/* ------------------------------------------------------------------ PingIDM */

/**
 * PingIDM evaluates script inline over REST, so the probe needs no deploy and
 * leaves nothing behind: one POST, one answer.
 */
async function probeIdm(cfg: ResolvedConfig, source: string): Promise<Surface> {
  const token = await getToken(cfg);
  const ca = readSecret(cfg, "platform-tls", "ca.crt");
  const res = await fetchIngress(cfg, "/openidm/script?_action=eval", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "text/javascript", source }),
    ...(ca ? { ca } : {}),
  });
  if (res.status !== 200) {
    throw new Error(
      `IDM returned ${res.status} for script eval: ${res.body.slice(0, 300)}`,
    );
  }
  return parseProbeOutput(decode(res.body, "IDM script eval", arrayOf(str)));
}

/* ------------------------------------------------------------------- PingAM */

const AM_SCRIPT = "fo-engine-probe";
const AM_NODE = "f0f0f0f0-0000-4000-8000-00000000f0f0";
// AM's built-in terminal nodes. Failure, not Success, because the probe
// authenticates nobody: routing to Success asks AM to mint a session for a
// subject that does not exist, which answers 500 and buries the real outcome.
const AM_FAILURE = "e301438c-0bd0-429c-ab0c-66126501069a";
const MARKER = "FO-ENGINE-PROBE";

type AmCall = {
  path: string;
  method: string;
  body?: string;
  version: string;
};

// The deployment has no `alpha` realm; everything lives in root.
const AM_REALM = "/am/json/realms/root";

async function am(
  cfg: ResolvedConfig,
  sso: string,
  ca: string | undefined,
  call: AmCall,
): Promise<{ status: number; body: string }> {
  return fetchIngress(cfg, `${AM_REALM}${call.path}`, {
    method: call.method,
    headers: {
      iPlanetDirectoryPro: sso,
      "Accept-API-Version": call.version,
      "content-type": "application/json",
    },
    ...(call.body === undefined ? {} : { body: call.body }),
    ...(ca ? { ca } : {}),
  });
}

async function amSsoToken(
  cfg: ResolvedConfig,
  ca: string | undefined,
): Promise<string> {
  const pw = readSecret(cfg, "am-env-secrets", "AM_PASSWORDS_AMADMIN_CLEAR");
  if (!pw) throw new Error("no amadmin password in am-env-secrets");
  const res = await fetchIngress(cfg, `${AM_REALM}/authenticate`, {
    method: "POST",
    headers: {
      "X-OpenAM-Username": "amadmin",
      "X-OpenAM-Password": pw,
      "Accept-API-Version": "resource=2.0, protocol=1.0",
      "content-type": "application/json",
    },
    ...(ca ? { ca } : {}),
  });
  const t = decode(res.body, "AM authenticate", obj({ tokenId: opt(str) })).tokenId;
  if (!t) throw new Error(`AM did not return a tokenId: ${res.body.slice(0, 200)}`);
  return t;
}

/**
 * PingAM has no eval action - `_action=evaluate` answers 501 - so the probe
 * has to be a real script in a real tree. It is created over REST rather than
 * through amster and `fo build`: six calls against the running stack, no
 * rebuild, no touching the repo's own journeys, and a teardown that runs even
 * when the probe throws.
 *
 * The script reports through `logger.error` because a scripted decision has no
 * other way out; the authenticate response carries a callback, not our data.
 */
async function probeAm(cfg: ResolvedConfig, source: string): Promise<Surface> {
  const ca = readSecret(cfg, "platform-tls", "ca.crt");
  const sso = await amSsoToken(cfg, ca);
  const V_SCRIPT = "resource=1.1";
  const V_TREE = "protocol=2.1,resource=1.0";
  const NODES = "/realm-config/authentication/authenticationtrees/nodes/ScriptedDecisionNode";
  const TREES = "/realm-config/authentication/authenticationtrees/trees";

  // One line, so a single `kubectl logs` grep recovers it whole.
  const script =
    `var probe = ${source};\n` +
    `logger.error("${MARKER} " + probe.join(" "));\n` +
    `outcome = "true";\n`;

  const created: AmCall[] = [];
  try {
    const s = await am(cfg, sso, ca, {
      path: `/scripts/${AM_SCRIPT}`,
      method: "PUT",
      version: V_SCRIPT,
      body: JSON.stringify({
        name: AM_SCRIPT,
        context: "AUTHENTICATION_TREE_DECISION_NODE",
        language: "JAVASCRIPT",
        script: Buffer.from(script, "utf8").toString("base64"),
      }),
    });
    if (s.status >= 300) {
      throw new Error(`AM refused the probe script (${s.status}): ${s.body.slice(0, 300)}`);
    }
    created.push({ path: `/scripts/${AM_SCRIPT}`, method: "DELETE", version: V_SCRIPT });

    const n = await am(cfg, sso, ca, {
      path: `${NODES}/${AM_NODE}`,
      method: "PUT",
      version: V_TREE,
      body: JSON.stringify({ script: AM_SCRIPT, outcomes: ["true"] }),
    });
    if (n.status >= 300) {
      throw new Error(`AM refused the probe node (${n.status}): ${n.body.slice(0, 300)}`);
    }
    created.push({ path: `${NODES}/${AM_NODE}`, method: "DELETE", version: V_TREE });

    const t = await am(cfg, sso, ca, {
      path: `${TREES}/${AM_SCRIPT}`,
      method: "PUT",
      version: V_TREE,
      body: JSON.stringify({
        entryNodeId: AM_NODE,
        nodes: {
          [AM_NODE]: {
            displayName: "fo engine probe",
            nodeType: "ScriptedDecisionNode",
            connections: { true: AM_FAILURE },
          },
        },
      }),
    });
    if (t.status >= 300) {
      throw new Error(`AM refused the probe tree (${t.status}): ${t.body.slice(0, 300)}`);
    }
    created.push({ path: `${TREES}/${AM_SCRIPT}`, method: "DELETE", version: V_TREE });

    // The status is deliberately not checked: the tree ends at Failure, so a
    // 401 is the SUCCESSFUL path. What matters is that the script ran, and
    // the only evidence of that is in the log.
    await fetchIngress(
      cfg,
      `${AM_REALM}/authenticate?authIndexType=service&authIndexValue=${AM_SCRIPT}`,
      {
        method: "POST",
        headers: {
          "Accept-API-Version": "resource=2.0, protocol=1.0",
          "content-type": "application/json",
        },
        ...(ca ? { ca } : {}),
      },
    );

    const logs = capture(
      "kubectl",
      ["-n", cfg.namespace, "logs", "deploy/am", "--tail=600"],
      { env: { KUBECONFIG: cfg.kubeconfig }, allowFailure: true },
    );
    const hit = logs.stdout
      .split("\n")
      .filter((l) => l.includes(MARKER))
      .pop();
    if (!hit) {
      throw new Error(
        "the probe script produced no output in AM's log - it was installed " +
          "and the tree ran, so this is a reporting problem, not an engine one",
      );
    }
    // AM logs JSON, so the message runs to the next quote, not to end of
    // line: without this the final token arrives welded to `","context":...`
    // and its key is silently lost.
    const after = hit.slice(hit.indexOf(MARKER) + MARKER.length);
    const quote = after.indexOf('"');
    const payload = quote === -1 ? after : after.slice(0, quote);
    return parseProbeOutput(payload.trim().split(/\s+/));
  } finally {
    // Reverse order, and best-effort: a probe that half-installed must not
    // leave a journey behind, and a teardown failure must not mask the
    // original error.
    for (const c of created.reverse()) {
      try {
        await am(cfg, sso, ca, c);
      } catch {
        warn(`could not remove ${c.path} - remove it by hand`);
      }
    }
  }
}

/* ------------------------------------------------------------------ report */

function report(name: string, d: Drift): void {
  if (driftIsClean(d)) {
    const extra = d.added.length ? ` (${d.added.length} newly probed)` : "";
    ok(`${name}: matches the recorded surface${extra}`);
    return;
  }
  fail(`${name}: the engine no longer matches engine-surface.json`);
  for (const c of d.changed) {
    detail(
      `  ${c.key}: recorded ${c.was ? "present" : "absent"}, ` +
        `now ${c.now ? "PRESENT" : "ABSENT"}`,
    );
  }
  for (const k of d.missing) detail(`  ${k}: probe returned no answer`);
}

/**
 * Write what the engines just answered into engine-surface.json.
 *
 * The recorded file is a MEASUREMENT, so there has to be a way to retake it
 * that is not hand-editing 700 booleans. It is a separate flag rather than
 * automatic on drift, because "the engine changed" and "we accept the change"
 * are different decisions and only the second one is a person's.
 */
function record(
  cfg: ResolvedConfig,
  surface: SurfaceFile,
  measured: { am: Surface; idm: Surface },
  today: string,
): void {
  const next = {
    ...surface,
    probedOn: today,
    // Stamped from the pinned release, not carried over. Keeping the previous
    // values dated a new measurement while attributing it to the build it was
    // NOT taken on, which is exactly the claim the file exists to make.
    forgeopsRelease: RELEASE.forgeops,
    platformVersion: RELEASE.productVersion,
    am: sorted(measured.am),
    idm: sorted(measured.idm),
  };
  writeFileSync(
    join(cfg.root, ...SURFACE),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
}

/** ISO date, so `probedOn` says when rather than how long ago. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sorted(s: Surface): Surface {
  return Object.fromEntries(
    Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

export async function doctorEngines(
  cfg: ResolvedConfig,
  writeBack = false,
): Promise<boolean> {
  heading(`fo doctor --engines  (env ${cfg.env})`);

  const surface = readSurfaceFile(cfg);
  const keys = [...new Set([...Object.keys(surface.am), ...Object.keys(surface.idm)])];
  const bad = unprobeableKeys(keys);
  if (bad.length) {
    warn(`engine-surface.json has keys the probe cannot generate: ${bad.join(", ")}`);
    if (writeBack) {
      // Recording writes what the probe ANSWERED, so a key it cannot generate
      // would be dropped from the file rather than reported - the surface
      // would quietly shrink back to whatever the generator happens to
      // support, which is the circularity this whole audit exists to break.
      fail("refusing to record while any key is ungeneratable; teach parseKey first");
      return false;
    }
  }
  detail(
    `recorded ${surface.probedOn} against ForgeOps ${surface.forgeopsRelease} ` +
      `(platform ${surface.platformVersion})`,
  );
  detail(`probing ${keys.length} builtins on both engines`);

  const source = probeSource(
    keys,
    readFileSync(join(cfg.root, ...EMIT_PROBE), "utf8"),
  );
  let allOk = true;
  let idmMeasured: Surface | undefined;
  let amMeasured: Surface | undefined;

  step("PingIDM (inline script eval)");
  try {
    idmMeasured = await probeIdm(cfg, source);
    report("PingIDM", diffSurface(surface.idm, idmMeasured));
    allOk &&= driftIsClean(diffSurface(surface.idm, idmMeasured));
  } catch (e) {
    fail(`PingIDM: ${(e as Error).message}`);
    allOk = false;
  }

  step("PingAM (temporary scripted decision, removed afterwards)");
  try {
    amMeasured = await probeAm(cfg, source);
    report("PingAM", diffSurface(surface.am, amMeasured));
    allOk &&= driftIsClean(diffSurface(surface.am, amMeasured));
  } catch (e) {
    fail(`PingAM: ${(e as Error).message}`);
    allOk = false;
  }

  if (writeBack) {
    step("Recording");
    if (idmMeasured === undefined || amMeasured === undefined) {
      // Half a measurement would leave the file claiming both engines were
      // probed on the same day when one of them was not answered at all.
      fail("both engines must answer before the surface can be recorded");
      return false;
    }
    // ...and a measurement that answered all but one key is also half a
    // measurement. Recording writes what the probe returned, so a key it
    // skipped would simply vanish from the file: the surface would shrink to
    // whatever the run happened to cover, and the coverage test would then
    // pass against a smaller pin. Both engines must answer EVERY key.
    const unanswered = Object.fromEntries(
      (["am", "idm"] as const)
        .map((engine) => [
          engine,
          keys.filter(
            (k) => (engine === "am" ? amMeasured : idmMeasured)[k] === undefined,
          ),
        ])
        .filter(([, missing]) => (missing as string[]).length > 0),
    ) as Partial<Record<"am" | "idm", string[]>>;
    if (Object.keys(unanswered).length > 0) {
      fail("refusing to record a partial measurement");
      for (const [engine, missing] of Object.entries(unanswered)) {
        detail(
          `  ${engine}: ${missing.length} key(s) unanswered, ` +
            `first: ${missing.slice(0, 5).join(", ")}`,
        );
      }
      return false;
    }
    record(cfg, surface, { am: amMeasured, idm: idmMeasured }, today());
    ok(
      `wrote ${Object.keys(amMeasured).length} AM and ` +
        `${Object.keys(idmMeasured).length} IDM probes to engine-surface.json`,
    );
    detail("`npm test` in platform/typescript now says whether the pin holds.");
    return true;
  }

  if (!allOk) {
    detail("");
    detail(
      "If the change is real, re-record it: update " +
        "platform/typescript/framework/engine-surface.json, then let " +
        "tests/engine-lib.test.mjs tell you which tsconfig `lib` entries " +
        "no longer hold. Do not widen a lib to make a check pass.",
    );
  }
  return allOk;
}

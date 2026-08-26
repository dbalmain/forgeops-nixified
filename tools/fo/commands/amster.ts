import { anyObject, arrayOf, decode, num, obj, opt } from "../lib/shape.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capture, sleep } from "../lib/proc.ts";
import { kubeEnv, ns, q } from "../lib/k8s.ts";
import { detail, ok, step, warn } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Tier 2 of the inner loop: re-import amster config (journeys, OAuth2 clients,
 * services) into a running PingAM.
 *
 * The chart mounts an OPTIONAL configMap called `amster-config` at
 * `/opt/amster/config/amster-import.tar.gz` and never creates it - a documented
 * extension point that `fo` fills from `platform/amster/config/`.
 */

const JOB = "amster";

function configDir(cfg: ResolvedConfig): string {
  return join(cfg.root, "platform", "amster", "config");
}

function hasConfig(cfg: ResolvedConfig): boolean {
  const d = configDir(cfg);
  if (!existsSync(d)) return false;
  return (
    readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    ).length > 0
  );
}

/** Pack platform/amster/config into the configMap the amster job expects. */
export function packAmsterConfig(cfg: ResolvedConfig): boolean {
  if (!hasConfig(cfg)) {
    detail("platform/amster/config is empty; nothing to import");
    return false;
  }
  const d = configDir(cfg);
  const n = readdirSync(d, { recursive: true, withFileTypes: true }).filter(
    (e) => e.isFile(),
  ).length;

  // --from-file gives the configMap a binary entry under the exact key the
  // job's subPath mount looks for. Recreate rather than patch, so deleted
  // files actually disappear.
  capture(
    "sh",
    [
      "-c",
      `tar -C ${q(d)} -czf /tmp/fo-amster-import.tar.gz . && ` +
        `kubectl -n ${q(cfg.namespace)} create configmap amster-config ` +
        `--from-file=amster-import.tar.gz=/tmp/fo-amster-import.tar.gz ` +
        `--dry-run=client -o json | kubectl -n ${q(cfg.namespace)} apply -f -`,
    ],
    { env: kubeEnv(cfg) },
  );
  detail(`packed ${n} file${n === 1 ? "" : "s"} into configmap/amster-config`);
  return true;
}

/**
 * Say what amster actually did.
 *
 * Without this the command reports success and tells you nothing: amster
 * SKIPS a file whose entity type it does not recognise and still exits 0, so a
 * journey can import while the nodes it references silently do not, and the
 * first sign of trouble is a 401 and `Node did not exist` buried in AM's log.
 */
function reportImport(cfg: ResolvedConfig, jobName: string): string {
  // By pod, not `job/<name>`: `kubectl logs job/x` waits for a RUNNING pod and
  // times out the moment the job has finished, which is exactly when we want
  // to read it.
  const pods = capture(
    "kubectl",
    ns(cfg, [
      "get", "pod",
      "-l", `batch.kubernetes.io/job-name=${jobName}`,
      "-o", "jsonpath={.items[*].metadata.name}",
    ]),
    { env: kubeEnv(cfg), allowFailure: true },
  ).stdout.trim();
  if (!pods) {
    detail("the job's pod is gone, so there is no import log to show");
    return "";
  }
  const log = capture(
    "kubectl",
    ns(cfg, ["logs", pods.split(/\s+/)[0]!, "-c", "amster"]),
    { env: kubeEnv(cfg), allowFailure: true },
  ).stdout;
  if (!log) return "";

  const imported = log.match(/^Imported .*$/gm) ?? [];
  const problems = (log.match(/^.*(ERROR|Unable to|Unknown|failed).*$/gim) ?? [])
    .filter((l) => !/^Imported /.test(l))
    .slice(0, 10);

  if (imported.length > 0) {
    detail(`amster imported ${imported.length} entities`);
  }
  for (const problem of problems) {
    warn(problem.trim().slice(0, 200));
  }
  return log;
}

/**
 * Does this failure look like an entity that referenced one amster had not
 * imported yet?
 *
 * Amster walks the config tree without knowing which entity types depend on
 * which, so a node can be processed before the thing it points at. It sorts
 * `ScriptedDecision` before `Scripts`, which means a scripted decision node
 * lands before its script exists and PingAM rejects the reference. A second
 * pass then succeeds, because the first pass created everything else.
 *
 * Reproduced deterministically: on a stack with no `risk-login-check` script,
 * `fo add example-risk-login && fo build && fo amster` fails here every time -
 * which is the exact sequence the package README tells you to run.
 */
const JOB_LIST = obj({ items: arrayOf(anyObject) });
const JOB_STATUS = obj({
  status: opt(obj({ succeeded: opt(num), failed: opt(num) })),
});

export function looksLikeForwardReference(log: string): boolean {
  return /Data validation failed for the attribute/i.test(log);
}

/**
 * Clone the existing amster Job under a fresh name and run it.
 *
 * The Job is a Helm post-install hook, so it cannot simply be restarted: a
 * completed Job is immutable, and re-running it through Helm would mean a full
 * `helm upgrade`. Cloning strips the fields the API server generates and the
 * Helm hook annotations, so the copy is an ordinary Job that Helm ignores.
 */
export async function runAmster(
  cfg: ResolvedConfig,
  opts: { timeoutSeconds: number } = { timeoutSeconds: 300 },
): Promise<void> {
  step("Re-importing amster config");
  packAmsterConfig(cfg);

  const first = await runImportJob(cfg, opts);
  if (first.state === "ok") return;
  // A TIMEOUT IS NOT A SUCCESS. This returned normally for `timeout`, so an
  // import that never finished -- or `--timeout 0`, which polls zero times --
  // reported "amster config imported" and exited zero, with the entities
  // absent. `fo up` runs this, so the whole install claimed to have worked.
  if (first.state === "timeout") throw new Error(first.error);

  if (!looksLikeForwardReference(first.log)) {
    throw new Error(first.error);
  }
  // Not a blanket retry: a genuinely malformed entity fails the same way
  // twice and should say so at once rather than taking a second job to do it.
  detail("an entity referenced one amster had not imported yet; second pass");
  const second = await runImportJob(cfg, opts);
  if (second.state !== "ok") {
    throw new Error(
      second.error +
        "\n(this was the second pass; the first failed the same way)",
    );
  }
}

type ImportOutcome =
  | { state: "ok"; log: string }
  | { state: "failed"; log: string; error: string }
  | { state: "timeout"; log: string; error: string };

async function runImportJob(
  cfg: ResolvedConfig,
  opts: { timeoutSeconds: number },
): Promise<ImportOutcome> {
  // No `allowFailure`: a LIST query with no matches exits zero with an empty
  // `items`, so a non-zero exit means the cluster could not be read. The
  // comment here used to claim exactly that distinction while the code folded
  // both into an empty list, and the empty list then reported success.
  const src = capture(
    "kubectl",
    ns(cfg, ["get", "job", "-l", "app=amster", "-o", "json"]),
    { env: kubeEnv(cfg) },
  );
  const items = decode(src.stdout, "kubectl get job -l app=amster", JOB_LIST).items;
  const template: Record<string, unknown> | undefined = items[items.length - 1];
  if (!template) {
    return {
      state: "timeout",
      log: "",
      error:
        "no existing amster job to clone, so nothing was imported. Run " +
        "`fo up` first - the chart's own amster job is the template this " +
        "clones.",
    };
  }

  const name = `${JOB}-fo-${Date.now().toString(36)}`;
  const spec = template["spec"] as Record<string, unknown>;
  const pod = spec["template"] as {
    metadata: { labels?: Record<string, string> };
    spec: Record<string, unknown>;
  };
  // The chart's template uses OnFailure, which makes the job controller DELETE
  // the pod once the backoff limit is hit - taking the log that says why the
  // import failed with it. `Never` keeps the failed pod for inspection.
  pod.spec["restartPolicy"] = "Never";
  for (const k of [
    "controller-uid",
    "batch.kubernetes.io/controller-uid",
    "job-name",
    "batch.kubernetes.io/job-name",
  ]) {
    delete pod.metadata.labels?.[k];
  }
  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: cfg.namespace, labels: { app: "amster", "fo/rerun": "true" } },
    spec: {
      // One attempt. A rejected import fails the same way six times, and each
      // retry destroys the pod whose log says why.
      backoffLimit: 0,
      ttlSecondsAfterFinished: 900,
      template: pod,
    },
  };

  capture("kubectl", ["apply", "-f", "-"], {
    env: kubeEnv(cfg),
    input: JSON.stringify(job),
  });
  detail(`job/${name} created`);

  // `0` is "no deadline", the same as `fo up --timeout 0`. It used to mean
  // "poll zero times", so `fo amster --timeout 0` warned once and exited zero
  // having imported nothing -- the opposite of what the flag says everywhere
  // else in this CLI.
  const unbounded = opts.timeoutSeconds === 0;
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  while (unbounded || Date.now() < deadline) {
    // Read the whole status as JSON rather than two jsonpath fields joined by
    // a space: `{.status.succeeded} {.status.failed}` renders as " 1" for a
    // FAILED job, and trimming that leaves "1" in the succeeded slot. That
    // made every failed import report success.
    // `--ignore-not-found` is the distinction this needs. The job may not be
    // visible for a moment after `apply`, which is exit zero and empty output;
    // anything else is the cluster failing, and treating THAT as "keep
    // waiting" burnt the whole timeout and then blamed the job.
    const r = capture(
      "kubectl",
      ns(cfg, ["get", "job", name, "-o", "json", "--ignore-not-found"]),
      { env: kubeEnv(cfg) },
    );
    if (r.stdout.trim() === "") {
      await sleep(3000);
      continue;
    }
    const status = decode(r.stdout, `kubectl get job ${name}`, JOB_STATUS)
      .status ?? { succeeded: undefined, failed: undefined };
    if ((status.succeeded ?? 0) > 0) {
      const log = reportImport(cfg, name);
      ok("amster import complete");
      return { state: "ok", log };
    }
    if ((status.failed ?? 0) > 0) {
      const log = reportImport(cfg, name);
      return {
        state: "failed",
        log,
        error:
          `amster job/${name} failed. Its pod is usually gone by now; ` +
          `re-run with the job kept: kubectl -n ${cfg.namespace} get job ${name}`,
      };
    }
    await sleep(3000);
  }
  return {
    state: "timeout",
    log: "",
    error:
      `amster job/${name} was still running after ${opts.timeoutSeconds}s, ` +
      "so the config was NOT imported. It is still going - watch it with " +
      `\`kubectl -n ${cfg.namespace} get job ${name} -w\`, or re-run with a ` +
      "longer --timeout. Nothing was torn down.",
  };
}

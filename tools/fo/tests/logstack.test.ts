import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forgeopsSrc, normalizeLogs, type ResolvedConfig } from "../config.ts";
import {
  LOGS_NAME,
  VECTOR_NAME,
  clusterScopedNames,
  logStackManifests,
  logsUrl,
  vectorConfig,
} from "../logstack.ts";
import { byTime, traceQuery } from "../commands/trace.ts";
import { buildValues } from "../values.ts";

/**
 * The VRL pipeline itself is NOT asserted here beyond its structure: a unit
 * test that restated what the remap does would only prove the test agrees with
 * itself. It was verified by running the real `vector vrl` binary over real
 * PingAM audit output - see PLAN.md, Phase 4.5.
 */

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    components: ["am", "idm"],
    clusterName: "fo",
    defaultEnv: "dev",
    fqdnTemplate: "{env}.localhost",
    dsDiskSize: "10Gi",
    packageSources: [],
    idmHotReload: true,
    idmScriptRecompileMs: 1000,
    logs: normalizeLogs("victorialogs"),
    env: "dev",
    namespace: "dev",
    fqdn: "dev.localhost",
    root: "/repo",
    stateDir: "/repo/.fo/dev",
    kubeconfig: "/repo/.fo/dev/kubeconfig",
    // The real pinned chart: `buildValues` reads its values.yaml to verify
    // every image key is one `fo` has a decision about.
    chartPath: join(forgeopsSrc(), "charts", "identity-platform"),
    secretsValuesPath: "/chart/secrets.yaml",
    ...over,
  } as ResolvedConfig;
}

test("logs config accepts the string shorthand and the object form", () => {
  assert.equal(normalizeLogs(undefined).backend, "off");
  assert.equal(normalizeLogs("victorialogs").backend, "victorialogs");
  // The shorthand must still get every default, or `fo up` would deploy a
  // store with no retention and no disk size.
  assert.equal(normalizeLogs("victorialogs").retention, "7d");
  assert.equal(normalizeLogs("victorialogs").includeHealthChecks, false);

  const tuned = normalizeLogs({ backend: "victorialogs", includeHealthChecks: true });
  assert.equal(tuned.includeHealthChecks, true);
  assert.equal(tuned.retention, "7d", "unset fields keep their default");
});

test("a trace query matches sub-transactions, not just the root", () => {
  const q = traceQuery("abc-123");
  // The discriminating case: PingAM calling PingIDM emits `abc-123/1`, so an
  // equality filter returns the entry point and loses every downstream call.
  assert.ok(q.endsWith("*"), `expected a prefix filter, got ${q}`);
  // And the id must be quoted, or LogsQL word-splits on the hyphens and
  // matches unrelated transactions that merely contain "abc".
  assert.ok(q.includes('"abc-123"'), `expected a quoted value, got ${q}`);
  assert.ok(q.includes(":="), `expected an exact-value filter, got ${q}`);
});

test("the log store deployment cannot deadlock on its own volume", () => {
  const dep = logStackManifests(cfg()).find(
    (m) => m["kind"] === "Deployment" && (m["metadata"] as { name: string }).name === LOGS_NAME,
  );
  assert.ok(dep);
  const spec = dep["spec"] as { strategy?: { type?: string } };
  // ReadWriteOnce plus an exclusive lock on the data directory: a rolling
  // update would wait for a pod that cannot start.
  assert.equal(spec.strategy?.type, "Recreate");
});

test("cluster-scoped objects are named per environment", () => {
  const dev = clusterScopedNames(cfg({ env: "dev", namespace: "dev" }));
  const test2 = clusterScopedNames(cfg({ env: "test", namespace: "test" }));
  // Two environments share one cluster. A shared ClusterRoleBinding name means
  // `fo down --env test` silently unbinds dev's collector.
  assert.notDeepEqual(dev, test2);
  const names = logStackManifests(cfg({ env: "test", namespace: "test" }))
    .filter((m) => String(m["kind"]).startsWith("ClusterRole"))
    .map((m) => (m["metadata"] as { name: string }).name);
  assert.deepEqual(new Set(names), new Set(clusterScopedNames(cfg({ env: "test", namespace: "test" }))));
});

test("every namespaced object is labelled for teardown", () => {
  const manifests = logStackManifests(cfg());
  const namespaced = manifests.filter(
    (m) => !String(m["kind"]).startsWith("ClusterRole"),
  );
  for (const m of namespaced) {
    const meta = m["metadata"] as { labels?: Record<string, string>; name: string };
    assert.equal(
      meta.labels?.["app.kubernetes.io/part-of"],
      "fo-logs",
      `${m["kind"]}/${meta.name} would survive fo down`,
    );
  }
  // And the label selector `removeLogStack` uses must cover every kind
  // present, or the leftover object blocks the next deploy.
  const deleted = new Set([
    "Deployment",
    "DaemonSet",
    "Service",
    "Ingress",
    "ConfigMap",
    "ServiceAccount",
    "PersistentVolumeClaim",
  ]);
  for (const m of namespaced) {
    assert.ok(deleted.has(String(m["kind"])), `fo down does not delete ${String(m["kind"])}`);
  }
});

test("the console reuses the platform host and its certificate", () => {
  const ing = logStackManifests(cfg()).find((m) => m["kind"] === "Ingress");
  assert.ok(ing);
  const spec = ing["spec"] as {
    tls: Array<{ hosts: string[]; secretName: string }>;
    rules: Array<{ host: string }>;
  };
  assert.equal(spec.rules[0]?.host, "dev.localhost");
  assert.equal(spec.tls[0]?.secretName, "platform-tls");
  assert.equal(logsUrl(cfg()), "https://dev.localhost/logs/");
});

test("the collector is scoped to its own namespace", () => {
  // Otherwise every env's collector ships every other env's logs, and the
  // per-env store stops meaning anything.
  assert.match(vectorConfig(cfg()), /extra_field_selector: metadata\.namespace=dev\b/);
  assert.match(
    vectorConfig(cfg({ env: "test", namespace: "test" })),
    /extra_field_selector: metadata\.namespace=test\b/,
  );
});

test("kubelet health probes are excluded unless asked for", () => {
  const off = vectorConfig(cfg());
  // Compared to `true` rather than negated: VRL cannot prove a field's type
  // and rejects `!.probe` at load time. This assertion checks the string; that
  // VRL ACCEPTS it is proven by deploying, which is how the bug was found.
  assert.match(off, /condition: '\.probe != true'/);
  // The filter is worthless if the sink does not actually read from it.
  assert.match(off, /inputs: \[keep\]/);

  const on = vectorConfig(
    cfg({ logs: normalizeLogs({ backend: "victorialogs", includeHealthChecks: true }) }),
  );
  assert.doesNotMatch(on, /condition: '\.probe != true'/);
  assert.doesNotMatch(on, /inputs: \[keep\]/);
});

test("every component's health probes are recognisable", () => {
  // The three components disagree about where the evidence is, and a rule
  // that only catches nginx would leave PingAM's probe traffic in the trace.
  const vrl = vectorConfig(cfg());
  for (const marker of ["kube-probe", "/json/health/", "/info/ping", "/isAlive"]) {
    assert.ok(vrl.includes(marker), `probe rule does not cover ${marker}`);
  }
  // Marked in the shape transform, not the filter, so it stays queryable
  // when health checks ARE kept.
  assert.match(vrl, /\.probe = contains\(msg,/);
});

test("PingDS access events are shipped, not filtered out", () => {
  // Measured: ForgeOps ships PingDS's console access logger filtered to
  // admin requests, auth failures and slow queries, so it wrote 18 KB where
  // each UI pod wrote 1.4 MB. An earlier draft excluded it and lost exactly
  // the DS signal worth having.
  assert.doesNotMatch(vectorConfig(cfg()), /ldap-access/);
});

test("the sink declares a content type VictoriaLogs accepts", () => {
  // Verified against the real server: the jsonline endpoint answers 200 and
  // ingests ZERO rows for a content type it does not recognise, with no error
  // logged anywhere. Losing this line loses every log, silently.
  assert.match(vectorConfig(cfg()), /Content-Type: application\/json/);
});

test("the collector restarts when its pipeline changes", () => {
  const hashOf = (c: ResolvedConfig): string => {
    const ds = logStackManifests(c).find(
      (m) => m["kind"] === "DaemonSet" && (m["metadata"] as { name: string }).name === VECTOR_NAME,
    );
    const spec = ds?.["spec"] as {
      template: { metadata: { annotations: Record<string, string> } };
    };
    return spec.template.metadata.annotations["fo/config-hash"]!;
  };
  const a = hashOf(cfg());
  const b = hashOf(
    cfg({ logs: normalizeLogs({ backend: "victorialogs", includeHealthChecks: true }) }),
  );
  // Without this the ConfigMap changes, the DaemonSet does not, and the new
  // pipeline looks like it did nothing.
  assert.notEqual(a, b);
  assert.equal(a, hashOf(cfg()), "the hash must be stable for unchanged config");
});

test("events sort by real time, not by string length", () => {
  // VictoriaLogs trims trailing zeros, so the same instant comes back at
  // different precisions. Compared as plain strings, ".57Z" sorts AFTER
  // ".571Z" because "1" < "Z" - which silently reorders a trace.
  const events = [
    { _time: "2026-08-25T12:39:24.571Z", eventName: "second" },
    { _time: "2026-08-25T12:39:24.57Z", eventName: "first" },
    { _time: "2026-08-25T12:39:24.5709Z", eventName: "between" },
  ];
  assert.deepEqual(
    byTime(events).map((e) => e["eventName"]),
    ["first", "between", "second"],
  );
});

test("the generated pipeline loads in the real Vector binary", () => {
  // The gate that matters. A pipeline can be valid YAML, pass every assertion
  // above, deploy cleanly - and then be rejected by VRL at startup, leaving a
  // crash-looping collector and a console that silently receives nothing.
  // That happened: `!.probe` is a type error VRL only reports at load time.
  //
  // nixpkgs pins the same version the DaemonSet runs, so this is the same
  // parser. `--no-environment` skips the healthchecks, which would need a
  // cluster.
  for (const logs of [
    normalizeLogs("victorialogs"),
    normalizeLogs({ backend: "victorialogs", includeHealthChecks: true }),
  ]) {
    const file = join(
      mkdtempSync(join(tmpdir(), "fo-vector-")),
      "vector.yaml",
    );
    writeFileSync(file, vectorConfig(cfg({ logs })));
    const r = spawnSync("vector", ["validate", "--no-environment", file], {
      encoding: "utf8",
    });
    if (r.error) {
      assert.fail(
        "vector is not on PATH - run this from the nix devShell, which pins it",
      );
    }
    assert.equal(
      r.status,
      0,
      `vector rejected the generated config:\n${r.stdout}${r.stderr}`,
    );
  }
});

test("PingDS access detail is always stated, so it can be switched back", () => {
  type WithEnv = Record<string, { env?: Array<{ name: string; value: string }> }>;
  const filtered = buildValues(cfg()) as WithEnv;
  const full = buildValues(
    cfg({
      logs: normalizeLogs({ backend: "victorialogs", dsAccessDetail: "full" }),
    }),
  ) as WithEnv;

  // Both stores, or a trace through the CTS is still blank.
  for (const key of ["ds_idrepo", "ds_cts"]) {
    assert.deepEqual(full[key]?.env, [
      { name: "DS_LOG_FILTERING_POLICY", value: "no-filtering" },
    ]);
    // The discriminating case: the default must state `inclusive` rather than
    // omit the key. The chart drops an empty env list from the manifest, so
    // an omitted key leaves whatever was there before - switching back from
    // `full` would be a silent no-op.
    assert.deepEqual(filtered[key]?.env, [
      { name: "DS_LOG_FILTERING_POLICY", value: "inclusive" },
    ]);
  }
});

test("the whole stack is told to trust an inbound transaction id", () => {
  // Without it every component mints its own root id and `fo trace` can only
  // ever show one of them. `platform.env` is the one chart key that reaches
  // PingAM, PingIDM and both PingDS instances.
  const v = buildValues(cfg()) as {
    platform: { env: Array<{ name: string; value: string }> };
  };
  assert.deepEqual(v.platform.env, [
    { name: "PLATFORM_TRUST_TRANSACTION_HEADER", value: "true" },
  ]);
});

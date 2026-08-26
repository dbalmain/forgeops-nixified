import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import { assertEnvName, assertInsideStateRoot } from "../config.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * The environment name reaches `rmSync(stateDir, {recursive: true})` through
 * `join(root, ".fo", env)`, and `join` resolves `..`. These are the inputs
 * that walked out of the repo before the guard existed.
 */
test("an environment name cannot traverse out of the state directory", () => {
  for (const env of ["../..", "../../..", "..", "a/../..", "./.."]) {
    assert.throws(() => assertEnvName(env), /invalid environment name/, env);
  }
});

test("an absolute path is not an environment name", () => {
  // join(root, ".fo", "/etc") is NOT /etc - join does not honour a leading
  // slash the way resolve does - but it is still not a name we want to see.
  assert.throws(() => assertEnvName("/etc"), /invalid environment name/);
});

test("ordinary names still work", () => {
  for (const env of ["dev", "prod", "test-2", "a", "a1-b2-c3"]) {
    assert.doesNotThrow(() => assertEnvName(env), env);
  }
});

test("names Kubernetes would reject are rejected here too", () => {
  // The namespace, the hostname label and the directory are all the same
  // string, so the strictest of the three is the rule.
  for (const env of ["Dev", "-dev", "dev-", "dev_1", "dev.1", "", "a".repeat(64)]) {
    assert.throws(() => assertEnvName(env), /invalid environment name/, JSON.stringify(env));
  }
});

test("63 characters is allowed, 64 is not", () => {
  assert.doesNotThrow(() => assertEnvName("a".repeat(63)));
  assert.throws(() => assertEnvName("a".repeat(64)), /invalid environment name/);
});

function cfg(root: string, stateDir: string): ResolvedConfig {
  return { root, stateDir } as unknown as ResolvedConfig;
}

/**
 * The discriminating case for the SECOND guard: every name here is a perfectly
 * valid DNS-1123 label, so assertEnvName would pass them all. If the deletion
 * site merely trusted the validator, these would delete the wrong tree.
 */
test("the deletion guard rejects a stateDir that is not an immediate child", () => {
  const root = "/home/dave/w/forgeops";
  const bad = [
    "/home/dave/w",
    "/home/dave",
    join(root, ".fo"),
    join(root, "platform"),
    join(root, ".fo", "dev", "nested"),
    "/",
  ];
  for (const dir of bad) {
    assert.throws(
      () => assertInsideStateRoot(cfg(root, dir)),
      /refusing to delete/,
      dir,
    );
  }
});

test("the deletion guard allows a real environment state directory", () => {
  const root = "/home/dave/w/forgeops";
  for (const env of ["dev", "prod"]) {
    assert.doesNotThrow(() =>
      assertInsideStateRoot(cfg(root, join(root, ".fo", env))),
    );
  }
});

test("the deletion guard normalises before deciding", () => {
  // A traversal that lands back inside is fine; one that escapes is not,
  // however it is spelled.
  const root = "/home/dave/w/forgeops";
  assert.doesNotThrow(() =>
    assertInsideStateRoot(cfg(root, join(root, ".fo", "x", "..", "dev"))),
  );
  assert.throws(
    () => assertInsideStateRoot(cfg(root, join(root, ".fo", "dev", "..", "..", ".."))),
    /refusing to delete/,
  );
});

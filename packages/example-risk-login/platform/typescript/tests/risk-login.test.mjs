// Guards the one coupling in `example-risk-login` that nothing else would
// catch: the journey's Scripted Decision node references the script by UUID,
// and that UUID is DERIVED from the script's name by `fo build`.
//
// So renaming risk-login-check.ts silently repoints the node at a script that
// no longer exists, and the journey dead-ends for a real user with no error
// anywhere in the build. This test fails instead.
//
// Installed by `fo add example-risk-login`.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformRoot = join(projectRoot, "..");
const SCRIPT_NAME = "risk-login-check";
const NODE = join(
  platformRoot,
  // amster's entity type drops the "Node" suffix for most node types
  // (but NOT for PageNode). Getting this wrong is a silent skip on import.
  "amster/config/realms/root/ScriptedDecision",
  "11111111-1111-4111-8111-000000000005.json",
);
const TREE = join(
  platformRoot,
  "amster/config/realms/root/AuthTree/risk-login.json",
);

function manifest() {
  const path = join(projectRoot, ".fo-ts-manifest.json");
  if (!existsSync(path)) return { amScripts: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

test("the journey's scripted node points at the built script", () => {
  const built = (manifest().amScripts ?? []).find(
    (s) => s.name === SCRIPT_NAME,
  );
  assert.ok(built, `run \`fo build\` — no built script called ${SCRIPT_NAME}`);

  const node = JSON.parse(readFileSync(NODE, "utf8"));
  assert.equal(
    node.data.script,
    built.id,
    "the Scripted Decision node references a different UUID than `fo build` " +
      "derives for " + SCRIPT_NAME + " — did the script get renamed?",
  );
});

test("the node declares exactly the outcomes the journey wires up", () => {
  const built = (manifest().amScripts ?? []).find(
    (s) => s.name === SCRIPT_NAME,
  );
  assert.ok(built);

  const node = JSON.parse(readFileSync(NODE, "utf8"));
  assert.deepEqual([...node.data.outcomes].sort(), [...built.outcomes].sort());

  // Every outcome must have somewhere to go, or the journey dead-ends.
  const tree = JSON.parse(readFileSync(TREE, "utf8"));
  const connections =
    tree.data.nodes["11111111-1111-4111-8111-000000000005"].connections;
  for (const outcome of node.data.outcomes) {
    assert.ok(
      typeof connections[outcome] === "string",
      `outcome "${outcome}" is not connected in the journey`,
    );
  }
});

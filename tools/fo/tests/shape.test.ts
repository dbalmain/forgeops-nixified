import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ShapeError,
  anyObject,
  arrayOf,
  bool,
  decode,
  num,
  obj,
  opt,
  record,
  str,
} from "../lib/shape.ts";

// The real shape `fo status` and `waitReady` depend on.
const POD_LIST = obj({
  items: arrayOf(
    obj({
      metadata: obj({ name: str }),
      status: obj({
        phase: str,
        containerStatuses: opt(arrayOf(obj({ ready: bool, restartCount: num }))),
      }),
    }),
  ),
});

const ONE_POD = JSON.stringify({
  items: [
    {
      metadata: { name: "am-0", uid: "not-our-business" },
      status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }] },
    },
  ],
});

test("a well-formed payload passes and keeps its values", () => {
  const pods = decode(ONE_POD, "kubectl get pods", POD_LIST).items;
  assert.equal(pods.length, 1);
  assert.equal(pods[0]!.metadata.name, "am-0");
  assert.equal(pods[0]!.status.containerStatuses?.[0]?.ready, true);
});

test("fields we did not ask about are left alone", () => {
  // These shapes belong to Kubernetes. Objecting to a field it added would
  // break `fo` on an upgrade that changed nothing we use.
  assert.doesNotThrow(() => decode(ONE_POD, "kubectl get pods", POD_LIST));
});

test("an absent optional is undefined, not an error", () => {
  const noStatuses = JSON.stringify({
    items: [{ metadata: { name: "job-1" }, status: { phase: "Succeeded" } }],
  });
  const pods = decode(noStatuses, "kubectl get pods", POD_LIST).items;
  assert.equal(pods[0]!.status.containerStatuses, undefined);
});

/*
 * The point of the whole module: a changed shape must be LOUD. Each of these
 * used to be swallowed into an empty pod list, which reads as "nothing is
 * deployed" - indistinguishable from a healthy empty cluster.
 */
test("a renamed field is reported, with the path that moved", () => {
  const renamed = JSON.stringify({
    items: [{ metadata: { name: "am-0" }, status: { state: "Running" } }],
  });
  assert.throws(
    () => decode(renamed, "kubectl get pods", POD_LIST),
    (e: Error) =>
      e instanceof ShapeError &&
      e.message.includes("items[0].status.phase") &&
      e.message.includes("kubectl get pods"),
  );
});

test("a wrong type is reported, not coerced", () => {
  const stringy = JSON.stringify({
    items: [{
      metadata: { name: "am-0" },
      status: { phase: "Running", containerStatuses: [{ ready: "yes", restartCount: 0 }] },
    }],
  });
  assert.throws(
    () => decode(stringy, "kubectl get pods", POD_LIST),
    (e: Error) => e.message.includes("containerStatuses[0].ready") &&
      e.message.includes("expected a boolean"),
  );
});

test("a top-level shape change names the payload, not a field", () => {
  // kubectl answering with a bare array instead of a list object never gets
  // as far as `items`, so the error must describe what arrived.
  assert.throws(
    () => decode(JSON.stringify([{ metadata: {} }]), "kubectl get pods", POD_LIST),
    (e: Error) =>
      e.message === "kubectl get pods: expected an object, got an array of 1",
  );
});

test("output that is not JSON at all names the source and shows the start", () => {
  assert.throws(
    () => decode("error: connection refused", "kubectl get pods", POD_LIST),
    (e: Error) =>
      e.message.includes("kubectl get pods") &&
      e.message.includes("not JSON") &&
      e.message.includes("connection refused"),
  );
});

test("empty output is reported as empty rather than as a parse mystery", () => {
  assert.throws(
    () => decode("", "k3d cluster list", arrayOf(obj({ name: str }))),
    (e: Error) => e.message.includes("empty"),
  );
});

test("an error message never dumps the whole payload", () => {
  const huge = JSON.stringify({ items: [{ metadata: { name: "x".repeat(5000) } }] });
  try {
    decode(huge, "kubectl get pods", POD_LIST);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok((e as Error).message.length < 300, "error should stay readable");
  }
});

test("null is treated as absent by opt, and as wrong by a required field", () => {
  assert.equal(opt(str)(null, "x"), undefined);
  assert.throws(() => str(null, "x"), (e: Error) => e.message.includes("got null"));
});

test("record accepts unknown keys but checks every value", () => {
  const v = record(obj({ path: opt(str) }));
  assert.deepEqual(v({ "forgeops-src": { path: "/nix/store/abc" } }, ""),
    { "forgeops-src": { path: "/nix/store/abc" } });
  assert.throws(
    () => v({ nixpkgs: { path: 42 } }, ""),
    (e: Error) => e.message.includes(".nixpkgs.path") && e.message.includes("a string"),
  );
});

test("anyObject rejects an array, which typeof calls an object", () => {
  assert.throws(() => anyObject([], "x"), (e: Error) => e.message.includes("an array of 0"));
  assert.deepEqual(anyObject({ a: 1 }, "x"), { a: 1 });
});

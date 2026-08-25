// The demo endpoint, driven through `dispatch` exactly as PingIDM drives the
// generated bundle. Replace this alongside `src/endpoints/hello.ts` when you
// write your own endpoints.
//
// User file — seeded once, yours to change.

import assert from "node:assert/strict";
import { test } from "node:test";

import hello from "../src/endpoints/hello.ts";
import { callContext, crestErrorFrom, crestRequest } from "./harness.ts";

test("read on / returns the default greeting", () => {
  const result = hello.dispatch(crestRequest("read"), callContext()) as {
    message: string;
  };
  assert.equal(result.message, "hello from forgeops-nixified");
});

test("read on /{name} greets by name, and shout upper-cases it", () => {
  const plain = hello.dispatch(
    crestRequest("read", { resourcePath: "dave" }),
    callContext(),
  ) as { message: string };
  assert.equal(plain.message, "hello, dave");

  const shouted = hello.dispatch(
    crestRequest("read", { resourcePath: "dave", query: { shout: "true" } }),
    callContext(),
  ) as { message: string };
  assert.equal(shouted.message, "HELLO, DAVE");
});

test("a declared fault becomes a CREST 400, not a thrown Error", () => {
  const error = crestErrorFrom(() =>
    hello.dispatch(
      crestRequest("read", { resourcePath: "nobody" }),
      callContext(),
    ),
  );
  assert.equal(error.code, 400);
});

test("a name longer than its declared maximum is a 400", () => {
  const error = crestErrorFrom(() =>
    hello.dispatch(
      crestRequest("read", { resourcePath: "x".repeat(65) }),
      callContext(),
    ),
  );
  assert.equal(error.code, 400);
});

test("query returns every style, and filters to one when asked", () => {
  const all = hello.dispatch(crestRequest("query"), callContext()) as {
    result: { _id: string }[];
  };
  assert.deepEqual(
    all.result.map((row) => row._id),
    ["hello", "g'day", "howdy"],
  );

  const one = hello.dispatch(
    crestRequest("query", { query: { style: "howdy" } }),
    callContext(),
  ) as { result: { _id: string }[] };
  assert.deepEqual(
    one.result.map((row) => row._id),
    ["howdy"],
  );
});

test("an undeclared query style is rejected", () => {
  const error = crestErrorFrom(() =>
    hello.dispatch(
      crestRequest("query", { query: { style: "yo" } }),
      callContext(),
    ),
  );
  assert.equal(error.code, 400);
});

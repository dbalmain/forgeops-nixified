import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  diffSurface,
  parseKey,
  parseProbeOutput,
  probeSource,
  unprobeableKeys,
} from "../engine-probe.ts";

// The behavioural corpus as `fo doctor --engines` splices it in: the real
// output of the real build pipeline, committed under framework/.
const EMIT_PROBE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..",
    "platform", "typescript", "framework", "engine-emit-probe.js",
  ),
  "utf8",
);

/** Run generated probe source the way an engine would, and read the answers. */
function runHere(keys: string[]): Record<string, boolean> {
  const out = new Function(
    `return ${probeSource(keys, EMIT_PROBE)}`,
  )() as string[];
  return parseProbeOutput(out);
}

test("every key shape in the recorded surface decomposes", () => {
  assert.deepEqual(parseKey("Array#flat"), {
    kind: "proto", key: "Array#flat", holder: "Array", member: "flat",
  });
  assert.deepEqual(parseKey("Object.hasOwn"), {
    kind: "static", key: "Object.hasOwn", holder: "Object", member: "hasOwn",
  });
  assert.deepEqual(parseKey("g:Proxy"), {
    kind: "global", key: "g:Proxy", name: "Proxy",
  });
  assert.deepEqual(parseKey("e:java"), {
    kind: "engine", key: "e:java", name: "java",
  });
  assert.deepEqual(parseKey("Array#[Symbol.iterator]"), {
    kind: "protoSymbol", key: "Array#[Symbol.iterator]",
    holder: "Array", symbol: "iterator",
  });
  // Behavioural checks and the sentinel are hand-written, not generated.
  assert.equal(parseKey("emit:for-of-array"), null);
  assert.equal(parseKey("g:<global-reachable>"), null);
});

test("a typo in the surface file is reported, not silently skipped", () => {
  assert.deepEqual(unprobeableKeys(["Array#flat", "Array flat", "??"]),
    ["Array flat", "??"]);
});

/*
 * The generator's real gate: run its output on an engine whose surface we
 * already know. A generator that answered `false` to everything would satisfy
 * a shape-only test, so these assert BOTH directions on this Node.
 */
test("generated source reports what the running engine actually has", () => {
  const got = runHere([
    "Array#flat", "Object.hasOwn", "String#trimStart", "Math.cbrt",
    "g:Proxy", "g:Reflect", "Number.EPSILON", "Promise#finally",
  ]);
  for (const k of ["Array#flat", "Object.hasOwn", "String#trimStart",
    "Math.cbrt", "g:Proxy", "g:Reflect", "Number.EPSILON", "Promise#finally"]) {
    assert.equal(got[k], true, `${k} should be present on Node`);
  }
});

test("an absent builtin reports absent rather than throwing", () => {
  const got = runHere(["Array#definitelyNotAMethod", "Object.alsoNot", "g:NopeJS"]);
  assert.equal(got["Array#definitelyNotAMethod"], false);
  assert.equal(got["Object.alsoNot"], false);
  assert.equal(got["g:NopeJS"], false);
});

test("a missing holder does not abort the rest of the probe", () => {
  // If `NoSuchCtor` blew up instead of answering, `Array#map` after it would
  // never be reported - the failure mode that makes a probe lie wholesale.
  const got = runHere(["NoSuchCtor#anything", "Array#map"]);
  assert.equal(got["NoSuchCtor#anything"], false);
  assert.equal(got["Array#map"], true);
});

test("a well-known symbol is looked up by the symbol, not by its name", () => {
  // The trap this hit for real: `String(Symbol.iterator)` is "Symbol(Symbol.
  // iterator)", a key nothing has, so the probe called arrays non-iterable on
  // an engine where they iterate - and the fix would have been to NARROW the
  // lib on false evidence.
  const got = runHere(["Array#[Symbol.iterator]"]);
  assert.equal(got["Array#[Symbol.iterator]"], true);
  assert.ok(
    !probeSource(["Array#[Symbol.iterator]"], "[]").includes('"Symbol.iterator"'),
    "the symbol must not be stringified into a property name",
  );
});

test("the behavioural corpus runs, and it is the pipeline's own output", () => {
  const got = runHere([]);
  for (const k of ["emit:for-of-array", "emit:spread-array",
    "emit:spread-object", "emit:destructure-object", "emit:class-inheritance",
    "emit:optional-chaining"]) {
    assert.equal(got[k], true, `${k} should hold on Node`);
  }
  assert.equal(got["g:<global-reachable>"], true);

  // The old checks were hand-written ES5 that MIRRORED what Babel was assumed
  // to emit: the spread case was a literal `[].concat(...)`. These helper
  // names only exist because the corpus went through Babel, so their presence
  // is what distinguishes the real output from another impression of it.
  assert.match(EMIT_PROBE, /_toConsumableArray/);
  assert.match(EMIT_PROBE, /_objectSpread/);
  assert.match(EMIT_PROBE, /_createForOfIteratorHelper/);
});

test("output survives AM's JSON log, which welds junk onto the last token", () => {
  // PingAM reports through a JSON log line, so the final token arrives as
  // `+emit:template-ok","context":"default",...`. Accepting it would invent a
  // key; rejecting the line wholesale would lose every earlier answer.
  const got = parseProbeOutput([
    "+Array#flat",
    "-Object.hasOwn",
    '+emit:template-ok","context":"default","transactionId":"abc-123"',
  ]);
  assert.equal(got["Array#flat"], true);
  assert.equal(got["Object.hasOwn"], false);
  assert.deepEqual(Object.keys(got).filter((k) => k.includes("context")), []);
});

test("a camelCase behavioural key is not dropped by the key guard", () => {
  // `emit:map-forEach` has a capital in it; a lowercase-only guard silently
  // dropped it and reported drift on both engines at once.
  assert.deepEqual(parseProbeOutput(["+emit:map-forEach"]),
    { "emit:map-forEach": true });
});

test("drift is reported in both directions, and separately from new keys", () => {
  const d = diffSurface(
    { "Object.hasOwn": false, "Array#flat": false, "String#at": true, "Map#entries": true },
    { "Object.hasOwn": true, "Array#flat": false, "String#at": false, "g:BigInt": true },
  );
  assert.deepEqual(d.changed, [
    { key: "Object.hasOwn", was: false, now: true },
    { key: "String#at", was: true, now: false },
  ]);
  assert.deepEqual(d.added, ["g:BigInt"]);
  assert.deepEqual(d.missing, ["Map#entries"]);
});

test("a newly probed key alone is not drift", () => {
  const d = diffSurface({ "Array#flat": true }, { "Array#flat": true, "g:New": true });
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.added, ["g:New"]);
});

test("the probe list is derived from the surface, so it cannot drift from it", () => {
  const src = probeSource(["Array#flat", "Object.hasOwn"], "[]");
  assert.ok(src.includes('"Array#flat"'));
  assert.ok(src.includes('"Object.hasOwn"'));
  assert.ok(!src.includes('"String#at"'));
});

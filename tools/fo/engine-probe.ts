/**
 * The engine probe: does the script engine still provide what the `lib` pin
 * claims it does?
 *
 * `platform/typescript/framework/engine-surface.json` records what PingAM's
 * and PingIDM's Rhino engines actually had when they were last measured, and
 * `tests/engine-lib.test.mjs` gates the tsconfig `lib` arrays against it. That
 * chain has one weak link: the JSON is a MEASUREMENT, and a ForgeOps upgrade
 * can change the engine underneath it. Nothing in the build would notice -
 * every gate would stay green while the pin quietly described the old engine.
 *
 * This module re-takes the measurement against a running stack.
 *
 * WHY THE PROBE IS GENERATED. The two spike probes were hand-written, once per
 * engine, and had already drifted apart (97 checks against 95). Here the list
 * of builtins comes FROM the recorded surface, so the thing being verified and
 * the thing doing the verifying cannot disagree about what to check: add a key
 * to the JSON and it gets probed, on both engines, automatically.
 *
 * Existence is tested with `in`, never by CALLING the thing - one absent
 * builtin would otherwise abort the whole probe at its first miss and report
 * everything after it as missing.
 *
 * WHY `in` AND NOT `typeof`. Reading a property invokes an accessor, and an
 * accessor read off the PROTOTYPE throws: `typeof Map.prototype.size` answers
 * `TypeError: Method "get size" called on incompatible object` on this engine,
 * which the old probe caught and recorded as absent. `Map#size` is very much
 * present. Any getter-backed member was measured wrong the same way.
 *
 * WHY AN INSTANCE IS TRIED TOO. Some members the lib declares on an interface
 * are own properties of an INSTANCE rather than of the prototype - `Error#stack`
 * is the one that matters here, and `"stack" in Error.prototype` is false on
 * an engine where `new Error().stack` is a string. Constructing one sample per
 * holder, inside a try, is what makes the answer about the engine rather than
 * about where the engine chose to hang the property.
 */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A key that names a builtin, decomposed into something we can emit code for. */
export type ProbeSpec =
  | { kind: "global"; key: string; name: string }
  | { kind: "engine"; key: string; name: string }
  | { kind: "static"; key: string; holder: string; member: string }
  | { kind: "proto"; key: string; holder: string; member: string }
  | { kind: "protoSymbol"; key: string; holder: string; symbol: string }
  | { kind: "staticSymbol"; key: string; holder: string; symbol: string };

/**
 * Decompose a surface key.
 *
 * Returns null for keys this cannot generate code for - the `emit:*`
 * behavioural keys, which are answered by the generated corpus rather than by
 * a name lookup, and the `g:<global-reachable>` sentinel, which the preamble
 * answers.
 */
export function parseKey(key: string): ProbeSpec | null {
  if (key === "g:<global-reachable>") return null;
  if (key.startsWith("emit:")) return null;

  if (key.startsWith("g:") || key.startsWith("e:")) {
    const name = key.slice(2);
    if (!IDENT.test(name)) return null;
    return key.startsWith("g:")
      ? { kind: "global", key, name }
      : { kind: "engine", key, name };
  }

  // `Array#[Symbol.iterator]` - a well-known symbol on a prototype. Indexed
  // with the SYMBOL, never with String(symbol): stringifying it yields a key
  // no object has, so the probe reports absent on an engine that has it.
  const sym = /^([A-Za-z_$][\w$]*)#\[Symbol\.([A-Za-z]+)\]$/.exec(key);
  if (sym) return { kind: "protoSymbol", key, holder: sym[1]!, symbol: sym[2]! };

  // `Array.[Symbol.species]` - the same thing on the constructor rather than
  // the prototype. `lib.es2015.symbol.wellknown.d.ts` declares a dozen of
  // these, so leaving them ungeneratable left a hole in the coverage the
  // audit is supposed to close.
  const staticSym = /^([A-Za-z_$][\w$]*)\.\[Symbol\.([A-Za-z]+)\]$/.exec(key);
  if (staticSym) {
    return {
      kind: "staticSymbol",
      key,
      holder: staticSym[1]!,
      symbol: staticSym[2]!,
    };
  }

  // The legacy RegExp statics: `RegExp.$&`, `RegExp.$\``, `RegExp.$'`,
  // `RegExp.$+`. Real properties with names no identifier rule admits, so
  // they need their own case rather than being quietly skipped.
  const legacy = /^RegExp\.(\$[&`'+])$/.exec(key);
  if (legacy) {
    return { kind: "static", key, holder: "RegExp", member: legacy[1]! };
  }

  const hash = key.indexOf("#");
  if (hash > 0) {
    const holder = key.slice(0, hash);
    const member = key.slice(hash + 1);
    if (!IDENT.test(holder) || !IDENT.test(member)) return null;
    return { kind: "proto", key, holder, member };
  }

  const dot = key.indexOf(".");
  if (dot > 0) {
    const holder = key.slice(0, dot);
    const member = key.slice(dot + 1);
    if (!IDENT.test(holder) || !IDENT.test(member)) return null;
    return { kind: "static", key, holder, member };
  }
  return null;
}

/** Keys the generator refuses; surfaced so a typo in the JSON is not silent. */
export function unprobeableKeys(keys: string[]): string[] {
  return keys.filter((k) => parseKey(k) === null && !k.startsWith("emit:") &&
    k !== "g:<global-reachable>");
}

function line(spec: ProbeSpec): string {
  const k = JSON.stringify(spec.key);
  switch (spec.kind) {
    case "global":
      return `  add(${k}, hasOn(GLOBAL, ${JSON.stringify(spec.name)}));`;
    // An engine global is a top-level BINDING, not necessarily an own property
    // of the global object, so this has to be a literal `typeof` - the holder
    // lookup used for `g:` would report `java` absent on Rhino, where it is
    // very much present.
    case "engine":
      return `  add(${k}, typeof ${spec.name} !== "undefined");`;
    case "static":
      return `  add(${k}, typeof ${spec.holder} !== "undefined" && hasOn(${spec.holder}, ${JSON.stringify(spec.member)}));`;
    case "proto":
      return `  add(${k}, hasProto(typeof ${spec.holder} === "undefined" ? undefined : ${spec.holder}, ${JSON.stringify(spec.holder)}, ${JSON.stringify(spec.member)}));`;
    case "protoSymbol":
      return `  add(${k}, typeof Symbol !== "undefined" && Symbol.${spec.symbol} !== undefined && hasProto(typeof ${spec.holder} === "undefined" ? undefined : ${spec.holder}, ${JSON.stringify(spec.holder)}, Symbol.${spec.symbol}));`;
    case "staticSymbol":
      return `  add(${k}, typeof Symbol !== "undefined" && typeof ${spec.holder} !== "undefined" && typeof ${spec.holder}[Symbol.${spec.symbol}] !== "undefined");`;
  }
}

/**
 * An ES5 expression evaluating to an array of `+key` / `-key` strings.
 *
 * ES5 on purpose: this runs in the engine directly, not through Babel, so it
 * must be accepted by the oldest thing we might point it at. The one
 * exception is inside the behavioural block, where newer syntax IS the thing
 * under test and every case is wrapped in its own try.
 */
export function probeSource(keys: string[], emitProbe: string): string {
  const specs = keys.map(parseKey).filter((s): s is ProbeSpec => s !== null);
  // Sorted so the emitted source is stable for a given surface - a diff of
  // two probe runs should show engine drift, not key ordering.
  specs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [
    "(function () {",
    "  var out = [];",
    "  function add(k, present) { out.push((present ? \"+\" : \"-\") + k); }",
    "  function hasOn(holder, name) {",
    "    if (holder === null || holder === undefined) return false;",
    "    try { if (name in Object(holder)) return true; } catch (e) {}",
    "    try { return typeof holder[name] !== \"undefined\"; } catch (e) { return false; }",
    "  }",
    // One sample per constructor, built with whatever argument it accepts.
    // Everything is wrapped: a constructor that refuses every shape simply
    // yields no sample, and the prototype answer stands on its own.
    "  var samples = {};",
    "  function sample(holder, name) {",
    "    if (!(name in samples)) {",
    "      samples[name] = undefined;",
    "      var tries = [",
    "        function () { return new holder(); },",
    "        function () { return new holder(0); },",
    "        function () { return new holder(function () {}); },",
    "        function () { return new holder(new ArrayBuffer(8)); }",
    "      ];",
    "      for (var i = 0; i < tries.length; i++) {",
    "        try { samples[name] = tries[i](); break; } catch (e) {}",
    "      }",
    "    }",
    "    return samples[name];",
    "  }",
    "  function hasProto(holder, name, member) {",
    "    if (typeof holder === \"undefined\") return false;",
    "    if (hasOn(holder.prototype, member)) return true;",
    "    return hasOn(sample(holder, name), member);",
    "  }",
    "  var GLOBAL;",
    "  try { GLOBAL = (function () { return this; })(); } catch (e) { GLOBAL = undefined; }",
    "  add(\"g:<global-reachable>\", GLOBAL !== null && GLOBAL !== undefined);",
    ...specs.map(line),
    // The behavioural half, spliced in verbatim from
    // platform/typescript/framework/engine-emit-probe.js - the REAL output of
    // the real esbuild+Babel pipeline, not a hand-written impression of it.
    // Wrapped so a wholesale failure leaves the `emit:*` keys unanswered
    // (which `diffSurface` reports as missing) rather than silently absent.
    "  try {",
    "    var emitted = " + emitProbe.trimEnd() + ";",
    "    for (var ei = 0; ei < emitted.length; ei++) out.push(emitted[ei]);",
    "  } catch (e) { out.push(\"emit-probe-threw:\" + e); }",
    "  return out;",
    "})()",
  ].join("\n");
}

export type Surface = Record<string, boolean>;

// A probe key, anchored. AM reports through its JSON log, so a token can pick
// up the closing quote and the rest of the record; anything that is not
// exactly a key is dropped rather than becoming one.
const KEY =
  /^[+-]([A-Za-z_$][\w$]*[#.][\w$]+|[A-Za-z_$][\w$]*[#.]\[Symbol\.[A-Za-z]+\]|RegExp\.\$[&`'+]|[ge]:[A-Za-z_$][\w$]*|g:<global-reachable>|emit:[A-Za-z-]+)$/;

/** Turn `["+Array#flat", "-Object.hasOwn"]` into a surface map. */
export function parseProbeOutput(lines: readonly string[]): Surface {
  const out: Surface = {};
  for (const raw of lines) {
    const s = raw.trim();
    if (!KEY.test(s)) continue;
    out[s.slice(1)] = s[0] === "+";
  }
  return out;
}

export type Drift = {
  /** Recorded and measured disagree - the case that invalidates the lib pin. */
  changed: { key: string; was: boolean; now: boolean }[];
  /** Probed but not in the recorded surface (a key was added to the JSON). */
  added: string[];
  /** Recorded but the probe produced no answer (engine or delivery problem). */
  missing: string[];
};

export function diffSurface(recorded: Surface, measured: Surface): Drift {
  const changed: Drift["changed"] = [];
  const missing: string[] = [];
  for (const [key, was] of Object.entries(recorded)) {
    if (!(key in measured)) { missing.push(key); continue; }
    const now = measured[key]!;
    if (now !== was) changed.push({ key, was, now });
  }
  const added = Object.keys(measured).filter((k) => !(k in recorded));
  changed.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { changed, added: added.sort(), missing: missing.sort() };
}

export function driftIsClean(d: Drift): boolean {
  return d.changed.length === 0 && d.missing.length === 0;
}

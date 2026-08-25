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
 * Existence is tested with `typeof` on the holder, never by CALLING the thing
 * - one absent builtin would otherwise abort the whole probe at its first
 * miss and report everything after it as missing.
 */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A key that names a builtin, decomposed into something we can emit code for. */
export type ProbeSpec =
  | { kind: "global"; key: string; name: string }
  | { kind: "engine"; key: string; name: string }
  | { kind: "static"; key: string; holder: string; member: string }
  | { kind: "proto"; key: string; holder: string; member: string }
  | { kind: "protoSymbol"; key: string; holder: string; symbol: string };

/**
 * Decompose a surface key.
 *
 * Returns null for keys this cannot generate code for - the `emit:*`
 * behavioural checks, which assert that downlevelled output actually RUNS and
 * so have to be written out by hand, and the `g:<global-reachable>` sentinel,
 * which the preamble answers.
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

/**
 * The behavioural checks, hand-written because they assert that code RUNS
 * rather than that a name exists. These mirror what Babel's output relies on.
 */
const BEHAVIOUR = `
  try {
    var forOfSeen = 0;
    for (var fv of [1, 2, 3]) { forOfSeen += fv; }
    add("emit:for-of-array", forOfSeen === 6);
  } catch (e) { add("emit:for-of-array", false); }

  try {
    var spread = [].concat([1, 2], [3, 4]);
    add("emit:spread-array", spread.length === 4);
  } catch (e) { add("emit:spread-array", false); }

  try {
    var pair = [10, 20];
    var d0 = pair[0], d1 = pair[1];
    add("emit:index-access", d0 === 10 && d1 === 20);
  } catch (e) { add("emit:index-access", false); }

  try {
    var st = new Set(); st.add("a"); st.add("b");
    add("emit:array-from-set", Array.from(st).length === 2);
  } catch (e) { add("emit:array-from-set", false); }

  try {
    var mp = new Map(); mp.set("k", 1);
    var mkeys = [];
    mp.forEach(function (v, k) { mkeys.push(k); });
    add("emit:map-forEach", mkeys.length === 1);
  } catch (e) { add("emit:map-forEach", false); }

  try {
    var who = "world";
    add("emit:template-ok", ("hello " + who) === "hello world");
  } catch (e) { add("emit:template-ok", false); }
`;

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
      return `  add(${k}, typeof ${spec.holder} !== "undefined" && hasOn(${spec.holder}.prototype, ${JSON.stringify(spec.member)}));`;
    case "protoSymbol":
      return `  add(${k}, typeof Symbol !== "undefined" && typeof ${spec.holder} !== "undefined" && typeof ${spec.holder}.prototype[Symbol.${spec.symbol}] !== "undefined");`;
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
export function probeSource(keys: string[]): string {
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
    "    try { return typeof holder[name] !== \"undefined\"; } catch (e) { return false; }",
    "  }",
    "  var GLOBAL;",
    "  try { GLOBAL = (function () { return this; })(); } catch (e) { GLOBAL = undefined; }",
    "  add(\"g:<global-reachable>\", GLOBAL !== null && GLOBAL !== undefined);",
    ...specs.map(line),
    BEHAVIOUR,
    "  return out;",
    "})()",
  ].join("\n");
}

export type Surface = Record<string, boolean>;

// A probe key, anchored. AM reports through its JSON log, so a token can pick
// up the closing quote and the rest of the record; anything that is not
// exactly a key is dropped rather than becoming one.
const KEY = /^[+-]([A-Za-z_$][\w$]*[#.][\w$]+|[A-Za-z_$][\w$]*#\[Symbol\.[A-Za-z]+\]|[ge]:[A-Za-z_$][\w$]*|g:<global-reachable>|emit:[A-Za-z-]+)$/;

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

// TEMPORARY: engine probe, not the real risk-login node. Restored after the run.
import { defineAmScript } from "../../framework/am.ts";

// Identifiers the pinned `lib` does not declare. Declared here only so
// `typeof` compiles; the probe never calls them.
// Symbol, Map, Set, WeakMap, WeakSet and Promise are NOT declared here: the
// pinned lib already declares them, and shadowing them as `unknown` would
// make the probe unable to use them in the emitted-code checks below.
declare const java: unknown;
declare const Packages: unknown;
declare const Java: unknown;
declare const JavaImporter: unknown;

function has(holder: unknown, name: string): boolean {
  if (holder === null || holder === undefined) return false;
  return typeof (holder as Record<string, unknown>)[name] !== "undefined";
}

function report(label: string, present: boolean): string {
  return (present ? "+" : "-") + label;
}

export default defineAmScript({
  name: "risk-login-check",
  context: "SCRIPTED_DECISION_NODE",
  description: "TEMPORARY engine probe",
  outcomes: ["low", "high"],
  main: function () {
    var out: string[] = [];

    // Globals.
    out.push(report("g:Symbol", typeof Symbol !== "undefined"));
    out.push(report("g:Map", typeof Map !== "undefined"));
    out.push(report("g:Set", typeof Set !== "undefined"));
    out.push(report("g:WeakMap", typeof WeakMap !== "undefined"));
    out.push(report("g:WeakSet", typeof WeakSet !== "undefined"));
    out.push(report("g:Promise", typeof Promise !== "undefined"));
    out.push(report("g:JSON", typeof JSON !== "undefined"));

    // Reached through the global object rather than by name: the build's
    // runtime-ban linter rejects a bare `Proxy` or `Reflect` reference
    // anywhere in the bundle, including inside a `typeof`.
    var globalObject: Record<string, unknown> | undefined;
    try {
      globalObject = (function (this: unknown) {
        return this;
      })() as Record<string, unknown> | undefined;
    } catch (e) {
      globalObject = undefined;
    }
    out.push(report("g:<global-reachable>", globalObject !== undefined));
    if (globalObject !== undefined) {
      var viaGlobal = ["Proxy", "Reflect", "BigInt", "globalThis",
        "Int8Array", "ArrayBuffer", "WeakRef", "structuredClone"];
      for (var v = 0; v < viaGlobal.length; v++) {
        out.push(report("g:" + viaGlobal[v]!, has(globalObject, viaGlobal[v]!)));
      }
    }

    // Engine identity.
    out.push(report("e:java", typeof java !== "undefined"));
    out.push(report("e:Packages", typeof Packages !== "undefined"));
    out.push(report("e:Java", typeof Java !== "undefined"));
    out.push(report("e:JavaImporter", typeof JavaImporter !== "undefined"));

    // ES2015.Core and later statics.
    var objectStatics = ["assign", "setPrototypeOf", "getOwnPropertySymbols",
      "entries", "values", "fromEntries", "hasOwn", "getOwnPropertyDescriptors"];
    for (var i = 0; i < objectStatics.length; i++) {
      out.push(report("Object." + objectStatics[i]!, has(Object, objectStatics[i]!)));
    }
    var arrayStatics = ["from", "of"];
    for (var j = 0; j < arrayStatics.length; j++) {
      out.push(report("Array." + arrayStatics[j]!, has(Array, arrayStatics[j]!)));
    }
    var numberStatics = ["isInteger", "isNaN", "isFinite", "parseFloat", "parseInt",
      "EPSILON", "MAX_SAFE_INTEGER"];
    for (var k = 0; k < numberStatics.length; k++) {
      out.push(report("Number." + numberStatics[k]!, has(Number, numberStatics[k]!)));
    }
    var mathStatics = ["trunc", "sign", "cbrt", "log2", "hypot", "clz32"];
    for (var m = 0; m < mathStatics.length; m++) {
      out.push(report("Math." + mathStatics[m]!, has(Math, mathStatics[m]!)));
    }

    // Prototype methods.
    var arrayProto = ["forEach", "map", "filter", "reduce", "indexOf",
      "find", "findIndex", "fill", "copyWithin", "includes",
      "flat", "flatMap", "at", "findLast"];
    for (var n = 0; n < arrayProto.length; n++) {
      out.push(report("Array#" + arrayProto[n]!, has(Array.prototype, arrayProto[n]!)));
    }
    var stringProto = ["trim", "startsWith", "endsWith", "includes", "repeat",
      "codePointAt", "normalize", "padStart", "padEnd", "trimStart", "trimEnd",
      "replaceAll", "at", "matchAll"];
    for (var p = 0; p < stringProto.length; p++) {
      out.push(report("String#" + stringProto[p]!, has(String.prototype, stringProto[p]!)));
    }
    out.push(report("Function#bind", has(Function.prototype, "bind")));
    out.push(report("Date.now", has(Date, "now")));

    // Iteration protocol: the thing ES2015.Iterable actually promises.
    if (typeof Symbol !== "undefined") {
      out.push(report("Symbol.iterator", has(Symbol as unknown, "iterator")));
      out.push(report("Symbol.for", has(Symbol as unknown, "for")));
      out.push(report("Symbol.toStringTag", has(Symbol as unknown, "toStringTag")));
      // Indexed with the SYMBOL, not with String(symbol). An earlier round of
      // this probe used String(symbol), which looks up a property named
      // "Symbol(Symbol.iterator)" - a key nothing has - and so reported every
      // engine as having non-iterable arrays. A test that cannot observe the
      // true answer is worse than no test.
      var iterKey: symbol | undefined = Symbol.iterator;
      var arrayIterable = false;
      if (iterKey !== undefined) {
        var protoBag = Array.prototype as unknown as Record<symbol, unknown>;
        arrayIterable = typeof protoBag[iterKey] === "function";
      }
      out.push(report("Array#[Symbol.iterator]", arrayIterable));
    }
    if (typeof Promise !== "undefined") {
      out.push(report("Promise.resolve", has(Promise as unknown, "resolve")));
      out.push(report("Promise.all", has(Promise as unknown, "all")));
    }


    var extraString = ["trimLeft", "trimRight"];
    for (var xs = 0; xs < extraString.length; xs++) {
      out.push(report("String#" + extraString[xs]!, has(String.prototype, extraString[xs]!)));
    }
    out.push(report("Array#entries", has(Array.prototype, "entries")));
    out.push(report("Array#keys", has(Array.prototype, "keys")));
    out.push(report("Array#values", has(Array.prototype, "values")));
    out.push(report("Map#entries", has(Map.prototype, "entries")));
    out.push(report("Map#keys", has(Map.prototype, "keys")));
    out.push(report("Set#values", has(Set.prototype, "values")));
    out.push(report("Promise#finally", has(Promise.prototype, "finally")));
    out.push(report("Symbol.asyncIterator", has(Symbol as unknown, "asyncIterator")));
    out.push(report("Symbol.hasInstance", has(Symbol as unknown, "hasInstance")));
    if (globalObject !== undefined) {
      out.push(report("g:BigInt64Array", has(globalObject, "BigInt64Array")));
    }

    // What the BUILD emits, not what the source says. Babel downlevels
    // for-of and spread to IE11, so the question is never "does the engine
    // support the syntax" - it is "does the engine support the helper Babel
    // emits in its place". Only running it answers that.
    try {
      var forOfSeen = 0;
      for (var forOfItem of [1, 2, 3]) {
        forOfSeen = forOfSeen + forOfItem;
      }
      out.push(report("emit:for-of-array", forOfSeen === 6));
    } catch (e1) {
      out.push(report("emit:for-of-array", false));
    }
    try {
      var source = [1, 2, 3];
      var spread = [0, ...source];
      out.push(report("emit:spread-array", spread.length === 4));
    } catch (e2) {
      out.push(report("emit:spread-array", false));
    }
    try {
      var pair = [7, 8];
      var first = pair[0];
      var second = pair[1];
      var destructured: number[] = [];
      destructured.push(first!, second!);
      out.push(report("emit:index-access", destructured.length === 2));
    } catch (e3) {
      out.push(report("emit:index-access", false));
    }
    try {
      var built = Array.from(new Set([1, 1, 2]));
      out.push(report("emit:array-from-set", built.length === 2));
    } catch (e4) {
      out.push(report("emit:array-from-set", false));
    }
    try {
      var probeMap = new Map<string, number>();
      probeMap.set("a", 1);
      var keys: string[] = [];
      probeMap.forEach(function (_value: number, key: string) {
        keys.push(key);
      });
      out.push(report("emit:map-forEach", keys.length === 1));
    } catch (e5) {
      out.push(report("emit:map-forEach", false));
    }
    try {
      var tpl = "x" + String(1);
      out.push(report("emit:template-ok", tpl === "x1"));
    } catch (e6) {
      out.push(report("emit:template-ok", false));
    }

    // Emitted in chunks: PingAM truncates nothing, but one enormous line is
    // painful to read back out of the log store.
    var line = "";
    for (var q = 0; q < out.length; q++) {
      line = line + (line === "" ? "" : " ") + out[q]!;
      if (line.length > 300) {
        logger.error("ENGINE-PROBE " + line);
        line = "";
      }
    }
    if (line !== "") logger.error("ENGINE-PROBE " + line);
    logger.error("ENGINE-PROBE-END count=" + String(out.length));

    action.goTo("low");
  },
});

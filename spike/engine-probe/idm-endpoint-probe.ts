// TEMPORARY: PingIDM engine probe. Deleted after the run.
import { defineEndpoint, queryResult, queryRoute, v } from "../../framework/index.ts";

declare const java: unknown;
declare const Packages: unknown;
declare const Java: unknown;
declare const JavaImporter: unknown;

function has(holder: unknown, name: string): boolean {
  if (holder === null || holder === undefined) return false;
  return typeof (holder as Record<string, unknown>)[name] !== "undefined";
}

function probe(): string[] {
  var out: string[] = [];
  var add = function (label: string, present: boolean): void {
    out.push((present ? "+" : "-") + label);
  };

  add("g:Symbol", typeof Symbol !== "undefined");
  add("g:Map", typeof Map !== "undefined");
  add("g:Set", typeof Set !== "undefined");
  add("g:WeakMap", typeof WeakMap !== "undefined");
  add("g:WeakSet", typeof WeakSet !== "undefined");
  add("g:Promise", typeof Promise !== "undefined");
  add("g:JSON", typeof JSON !== "undefined");
  add("e:java", typeof java !== "undefined");
  add("e:Packages", typeof Packages !== "undefined");
  add("e:Java", typeof Java !== "undefined");
  add("e:JavaImporter", typeof JavaImporter !== "undefined");

  var globalObject: Record<string, unknown> | undefined;
  try {
    globalObject = (function (this: unknown) {
      return this;
    })() as Record<string, unknown> | undefined;
  } catch (e) {
    globalObject = undefined;
  }
  add("g:<global-reachable>", globalObject !== undefined);
  if (globalObject !== undefined) {
    var viaGlobal = ["Proxy", "Reflect", "BigInt", "globalThis",
      "Int8Array", "ArrayBuffer", "WeakRef", "structuredClone"];
    for (var g = 0; g < viaGlobal.length; g++) {
      add("g:" + viaGlobal[g]!, has(globalObject, viaGlobal[g]!));
    }
  }

  var objectStatics = ["assign", "setPrototypeOf", "getOwnPropertySymbols",
    "entries", "values", "fromEntries", "hasOwn", "getOwnPropertyDescriptors"];
  for (var i = 0; i < objectStatics.length; i++) {
    add("Object." + objectStatics[i]!, has(Object, objectStatics[i]!));
  }
  var arrayStatics = ["from", "of"];
  for (var j = 0; j < arrayStatics.length; j++) {
    add("Array." + arrayStatics[j]!, has(Array, arrayStatics[j]!));
  }
  var numberStatics = ["isInteger", "isNaN", "isFinite", "parseFloat", "parseInt",
    "EPSILON", "MAX_SAFE_INTEGER"];
  for (var k = 0; k < numberStatics.length; k++) {
    add("Number." + numberStatics[k]!, has(Number, numberStatics[k]!));
  }
  var mathStatics = ["trunc", "sign", "cbrt", "log2", "hypot", "clz32"];
  for (var m = 0; m < mathStatics.length; m++) {
    add("Math." + mathStatics[m]!, has(Math, mathStatics[m]!));
  }
  var arrayProto = ["forEach", "map", "filter", "reduce", "indexOf",
    "find", "findIndex", "fill", "copyWithin", "includes",
    "flat", "flatMap", "at", "findLast"];
  for (var n = 0; n < arrayProto.length; n++) {
    add("Array#" + arrayProto[n]!, has(Array.prototype, arrayProto[n]!));
  }
  var stringProto = ["trim", "startsWith", "endsWith", "includes", "repeat",
    "codePointAt", "normalize", "padStart", "padEnd", "trimStart", "trimEnd",
    "replaceAll", "at", "matchAll"];
  for (var p = 0; p < stringProto.length; p++) {
    add("String#" + stringProto[p]!, has(String.prototype, stringProto[p]!));
  }
  add("Function#bind", has(Function.prototype, "bind"));
  add("Date.now", has(Date, "now"));

  if (typeof Symbol !== "undefined") {
    add("Symbol.iterator", has(Symbol as unknown, "iterator"));
    add("Symbol.for", has(Symbol as unknown, "for"));
    add("Symbol.toStringTag", has(Symbol as unknown, "toStringTag"));
    var iterKey: symbol | undefined = Symbol.iterator;
    var arrayIterable = false;
    if (iterKey !== undefined) {
      var protoBag = Array.prototype as unknown as Record<symbol, unknown>;
      arrayIterable = typeof protoBag[iterKey] === "function";
    }
    add("Array#[Symbol.iterator]", arrayIterable);
  }
  if (typeof Promise !== "undefined") {
    add("Promise.resolve", has(Promise as unknown, "resolve"));
    add("Promise.all", has(Promise as unknown, "all"));
  }


  var extraString = ["trimLeft", "trimRight"];
  for (var xs = 0; xs < extraString.length; xs++) {
    add("String#" + extraString[xs]!, has(String.prototype, extraString[xs]!));
  }
  add("Array#entries", has(Array.prototype, "entries"));
  add("Array#keys", has(Array.prototype, "keys"));
  add("Array#values", has(Array.prototype, "values"));
  add("Map#entries", has(Map.prototype, "entries"));
  add("Map#keys", has(Map.prototype, "keys"));
  add("Set#values", has(Set.prototype, "values"));
  add("Promise#finally", has(Promise.prototype, "finally"));
  add("Symbol.asyncIterator", has(Symbol as unknown, "asyncIterator"));
  add("Symbol.hasInstance", has(Symbol as unknown, "hasInstance"));
  if (globalObject !== undefined) {
    add("g:BigInt64Array", has(globalObject, "BigInt64Array"));
  }

  try {
    var seen = 0;
    for (var item of [1, 2, 3]) seen = seen + item;
    add("emit:for-of-array", seen === 6);
  } catch (e1) {
    add("emit:for-of-array", false);
  }
  try {
    var spread = [0, ...[1, 2, 3]];
    add("emit:spread-array", spread.length === 4);
  } catch (e2) {
    add("emit:spread-array", false);
  }
  try {
    add("emit:array-from-set", Array.from(new Set([1, 1, 2])).length === 2);
  } catch (e3) {
    add("emit:array-from-set", false);
  }
  try {
    var pm = new Map<string, number>();
    pm.set("a", 1);
    var keys: string[] = [];
    pm.forEach(function (_v: number, key: string) {
      keys.push(key);
    });
    add("emit:map-forEach", keys.length === 1);
  } catch (e4) {
    add("emit:map-forEach", false);
  }
  return out;
}

export default defineEndpoint({
  name: "__engine-probe",
  summary: "TEMPORARY engine probe",
  routes: [
    queryRoute({
      path: "/",
      response: v.object({ _id: v.string(), feature: v.string() }),
      handler: () =>
        queryResult(
          probe().map(function (feature: string) {
            return { _id: feature, message: feature, feature: feature };
          }),
        ),
    }),
  ],
});

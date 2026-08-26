// BREADTH, not depth: one absent builtin reached every way it can be written.
//
// `uses-absent-builtins.ts` has one case per resolvable FORM, which proves the
// checker handles each mechanism. It does not say much about coverage, because
// the forms were chosen by the same person who wrote the resolver — asked what
// is least verified in this subsystem, codex named exactly that.
//
// So this file takes ONE member the engine lacks (`Float32Array#map`, absent on
// both engines) and expresses it through as many shapes as can be written,
// including the ones the analyser is documented NOT to resolve. The test
// asserts both halves: every REACHED line is found, and every DECLINED line is
// still not found. The second half is what keeps the boundary honest — if a
// decline quietly becomes catchable, the documentation is wrong and nobody
// would otherwise notice.
//
// Not part of any program: compiled only by tsconfig.absent.json's sibling,
// tests/fixtures/tsconfig.breadth.json.

declare const flag: boolean;
declare const anyKey: string;

const arr = new Float32Array(4);

/* ------------------------------------------------------- REACHED (12 uses) */

export const r01 = arr.map;
export const r02 = arr["map"];
export const r03 = (arr as Float32Array).map;
export const r04 = arr?.map;
export const r05 = (flag ? arr : arr).map;
export const r06 = (arr satisfies Float32Array).map;
export const r07 = new Float32Array(2).map;
export const { map: r08 } = arr;
export const { ["map"]: r09 } = arr;
export const { "map": r10 } = arr;
export function r11({ map }: Float32Array): unknown {
  return map;
}
const union: "map" | "map" = "map";
export const r12 = arr[union];

/* ------------------------------------ DECLINED (documented outside the proof) */

// A key the compiler cannot narrow to a literal.
export const d01 = (arr as unknown as Record<string, unknown>)[anyKey];
// Structural erasure: the constraint is a shape, not Float32Array.
export function d02<T extends { map: unknown }>(x: T): unknown {
  return x.map;
}
// `any` discards the receiver type entirely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const d03 = (arr as any).map;
// An array-pattern assignment position with a non-shorthand key. Initialised
// so this is a real re-assignment; the syntax is the point of the case.
let d04: unknown = null;
[{ "map": d04 }] = [arr];
export { d04 };

// A fixture the native-subclass gate MUST reject, one case per way of naming
// the superclass.
//
// `tools/emit-corpus.ts` proves the LOWERING fails on the engines; it says
// nothing about whether the source gate can see it. Without this the gate
// could resolve nothing at all and every green build would look the same.
//
// Not part of any program: compiled only by tests/fixtures/tsconfig.subclass.json.

const Aliased = Error;
declare const choose: boolean;

/** A project class. The gate must NOT flag this one. */
class Local {
  run(): number {
    return 1;
  }
}

export class Direct extends Map<string, string> {}
export class ViaAlias extends Aliased {}
export class ViaGlobal extends globalThis.Error {}
// The union case: no symbol on the type itself, and one branch is the native.
export class ViaUnion extends (choose ? Error : Local) {}

/** The positive control: extending project code is fine and must stay fine. */
export class NotNative extends Local {}

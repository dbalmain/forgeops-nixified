// A fixture that MUST fail the engine-usage check.
//
// The check went blind once already: it matched lib files by path, and
// `node_modules` is a symlink into the nix store, so it compared
// `<project>/node_modules/...` against `/nix/store/...`, matched nothing, and
// reported this exact file clean. A checker that cannot fail is worse than no
// checker, because the green tick is read as proof.
//
// So the discriminating case is committed, and tests/engine-lib.test.mjs
// asserts the check finds every line of it.
//
// Not part of any runtime program: tsconfig.tests.json excludes it, and it is
// compiled only by tests/fixtures/tsconfig.absent.json.

export function usesAbsentBuiltins(): number {
  // Rhino's typed arrays carry only get/set/subarray; the %TypedArray% method
  // suite is not there. This type-checks and throws.
  const samples = new Float32Array(8);
  const doubled = samples.map((x) => x * 2);

  // `RegExp#flags` is ES2015.Core, pinned, and absent from the engine.
  const flags = /a/g.flags;

  return doubled.length + flags.length;
}

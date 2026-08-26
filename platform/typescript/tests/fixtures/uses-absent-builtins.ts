// A fixture that MUST fail the engine-usage check.
//
// The check went blind once already: it matched lib files by path, and
// `node_modules` is a symlink into the nix store, so it compared
// `<project>/node_modules/...` against `/nix/store/...`, matched nothing, and
// reported this exact file clean. A checker that cannot fail is worse than no
// checker, because the green tick is read as proof.
//
// So the discriminating case is committed, and tests/engine-lib.test.mjs
// asserts the check finds every line of it. One case per FORM the checker
// claims to resolve -- an earlier version caught only the property access and
// silently passed the other four.
//
// Not part of any runtime program: tsconfig.tests.json excludes it, and it is
// compiled only by tests/fixtures/tsconfig.absent.json.

export function usesAbsentBuiltins(): number {
  // Property access. Rhino's typed arrays carry only get/set/subarray; the
  // %TypedArray% method suite is not there. This type-checks and throws.
  const samples = new Float32Array(8);
  const doubled = samples.map((x) => x * 2);

  // `RegExp#flags` is ES2015.Core, pinned, and absent from the engine.
  const flags = /a/g.flags;

  // Element access with a literal key: the same member, spelled the way a
  // lookup table or a minifier writes it.
  const byLiteral = samples["reduce"];

  // Element access with a finite union. The compiler knows both members, so
  // both are resolvable and `fill` is absent.
  const key: "fill" | "subarray" = Math.random() > 0.5 ? "fill" : "subarray";
  const byUnion = samples[key];

  // Binding pattern, including through a parameter and a nested pattern.
  const { forEach } = samples;
  const { inner: { slice } } = { inner: new Uint8Array(4) };

  // Destructuring assignment, which reads a property without ever naming it
  // in a property-access position.
  // The binding is initialised first so this really is a re-assignment: the
  // point of the case is the `({ x } = y)` form, which needs a binding that
  // already exists.
  let indexOf: unknown = null;
  ({ indexOf } = samples);

  return (
    doubled.length +
    flags.length +
    Number(!!byLiteral && !!byUnion && !!forEach && !!slice && !!indexOf)
  );
}

/**
 * A well-known symbol member, which only PingAM's engine lacks.
 *
 * Kept separate so the test can point it at the engine that actually differs:
 * checking it against PingIDM would assert the wrong thing.
 */
export function usesAmOnlyAbsentBuiltin(): string {
  return Math[Symbol.toStringTag];
}

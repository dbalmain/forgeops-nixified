// A COMPILE-TIME test. Nothing here runs — `openidm` does not exist in node —
// and the file is deliberately not named `*.test.ts` so the runner ignores it.
// It is in the program because tsconfig.tests.json includes tests/**, and it
// fails the build if the generated managed types stop augmenting `openidm`.
//
// The seam it guards is easy to break invisibly: `src/generated/managed.ts`
// has to carry a `declare global` block keyed by COLLECTION PATH
// (`managed/user`), because an ambient .d.ts is not visible from inside a
// module graph and a plain `export interface ManagedObjects` would shadow
// nothing. Get either wrong and every call below still compiles — against
// `CrestResource`, with index-only access and no field checking. So the
// assertions are written to fail in exactly that case.

/** Fails to compile unless `Actual` is assignable to `Expected`. */
function expectAssignable<Expected>(_value: Expected): void {}

export function _managedTypingIsWired(): void {
  // `managed/user` must resolve to the generated interface, not CrestResource.
  const user = openidm.read("managed/user/some-id");
  expectAssignable<string | undefined>(user?.userName);

  // Property ACCESS is the discriminating part: CrestResource is index-only,
  // so `user.userName` would be an error if the augmentation were missing.
  if (user) {
    const name: string = user.userName;
    void name;
  }

  // A field list is checked against the schema. `notAProperty` below would be
  // accepted if ManagedObjects were still empty, because FieldsArg falls back
  // to `readonly string[]` for unknown paths.
  const projected = openidm.read("managed/user/some-id", null, ["mail", "sn"]);
  expectAssignable<string | undefined>(projected?.mail);

  // @ts-expect-error `notAProperty` is not in the managed/user schema.
  openidm.read("managed/user/some-id", null, ["notAProperty"]);

  // A managed object other than user must be generated too.
  const role = openidm.read("managed/role/some-id");
  expectAssignable<string | undefined>(role?.name);
}

// A COMPILE-TIME test. Nothing here runs — `action` does not exist in node —
// and the file is deliberately not named `*.test.ts` so the runner ignores it.
// It belongs to the PingAM program (tsconfig.am.json includes it by name) and
// is excluded from the test program, whose globals collide with AM's.
//
// What it guards: an outcome PingAM does not know about is invisible until a
// real user walks into it. The journey dead-ends, AM logs nothing useful, and
// `fo amster` reports success — so the only place a typo can be caught is the
// compiler.
//
// tests/am-scripts.test.mjs greps the BUILT body for `goTo("literal")` and is
// a good backstop, but it can only see outcomes that survive as quoted string
// literals next to the call. Everything below marked with a `@ts-expect-error`
// is a case that passes that grep.

import { defineAmScript } from "../framework/am.ts";

/** Fails to compile unless `Actual` is assignable to `Expected`. */
function expectAssignable<Expected>(_value: Expected): void {}

export function _amTypingIsWired(risky: boolean): void {
  const script = defineAmScript({
    name: "am-typing",
    context: "SCRIPTED_DECISION_NODE",
    outcomes: ["high", "low"],
    main: (action) => {
      action.goTo("high");

      // THE discriminating case, and the one codex raised: the bad name never
      // appears as a quoted argument to `goTo` in the emitted body, so the
      // built-artefact grep cannot see it. Only the parameter's type can.
      // @ts-expect-error "hihg" is not a declared outcome.
      action.goTo(risky ? "high" : "hihg");

      // Same class, one step further from a literal: a name computed at
      // runtime cannot be checked against the declared exits at all, so a
      // plain `string` has to be rejected outright.
      const computed: string = risky ? "high" : "low";
      // @ts-expect-error an arbitrary string is not a declared outcome.
      action.goTo(computed);
    },
  });

  // The raw global PingAM puts in scope. Naming the parameter `action` shadows
  // it inside `main`, but a script that names the parameter something else --
  // or takes none at all -- can still reach it, so it has to refuse on its own.
  // @ts-expect-error the global accepts no outcome; use main's parameter.
  action.goTo("high");

  // The metadata the build reads survives the generic.
  expectAssignable<string>(script.definition.name);
  expectAssignable<readonly string[]>(script.definition.outcomes);
  expectAssignable<"am-script">(script.definition.kind);

  defineAmScript({
    name: "empty-outcomes",
    context: "SCRIPTED_DECISION_NODE",
    // A node with no exits is unreachable in a journey. The runtime throw in
    // `defineAmScript` is the backstop; this is the compile error.
    // @ts-expect-error a scripted decision node needs at least one outcome.
    outcomes: [],
    main: () => {},
  });

  const names: string[] = ["high", "low"];

  // Spreading loses the names, and AM needs them statically to draw the node.
  // Without this rejection `Outcomes[number]` widens to `string` and every
  // check above quietly stops working.
  //
  // A naked spread is rejected by `AmOutcomes` itself: `string[]` has no
  // element the tuple's required first position can match.
  defineAmScript({
    name: "spread-outcomes",
    context: "SCRIPTED_DECISION_NODE",
    // @ts-expect-error outcomes must be written as literals.
    outcomes: [...names],
    main: () => {},
  });

  // The case a naked-spread check misses, and the one codex found still
  // compiling: one real literal in front of the spread. `AmOutcomes` is
  // satisfied -- the tuple has a first element -- so only the widening test
  // rejects it, and the error lands on the ARGUMENT rather than on the
  // property, because the constraint is intersected onto the whole spec. (A
  // conditional type written directly on `outcomes` would stop `Outcomes`
  // being inferred at all.) Without this the `goTo("hihg")` below type-checks.
  // @ts-expect-error outcomes must be written as literals.
  defineAmScript({
    name: "partial-spread-outcomes",
    context: "SCRIPTED_DECISION_NODE",
    outcomes: ["high", ...names],
    main: (action) => {
      action.goTo("hihg");
    },
  });

  // The other way back to a wide `goTo`: annotate the callback parameter
  // instead of letting it be inferred. Written as a function-typed PROPERTY
  // the comparison is contravariant and the compiler rejects it, which is what
  // this locks in.
  //
  // Written as a METHOD -- `{ goTo(outcome: string): void }` -- it is accepted,
  // because TypeScript compares method parameters bivariantly and the
  // bivariance comes from the annotation's own declaration, so no variance
  // trick on `AmAction` can refuse it. That case is not expressible here as a
  // negative test; `tools/am-source-rules.mjs` catches it at the source and
  // `tests/am-source-rules.test.mjs` holds the fixture.
  defineAmScript({
    name: "annotated-action",
    context: "SCRIPTED_DECISION_NODE",
    outcomes: ["high", "low"],
    // @ts-expect-error a wider `goTo` cannot stand in for the narrow one.
    main: (action: { goTo: (outcome: string) => void }) => {
      action.goTo("hihg");
    },
  });
}

// A fixture the AM source rule MUST reject. Not part of any program: nothing
// includes it, and it is here so `tests/am-source-rules.test.mjs` can prove
// the rule still fires.
//
// The method-syntax annotation is the one that matters. TypeScript accepts it
// -- method parameters compare bivariantly even under `strictFunctionTypes` --
// so `goTo("hihg")` inside it is not a compile error, and only this rule
// catches it.

import { defineAmScript } from "../../framework/am.ts";

export default defineAmScript({
  name: "am-annotated-action",
  context: "SCRIPTED_DECISION_NODE",
  outcomes: ["high", "low"],
  main: (action: { goTo(outcome: string): void }) => {
    action.goTo("hihg");
  },
});

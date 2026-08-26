// The positive control for `tests/am-source-rules.test.mjs`: the ordinary way
// to write a PingAM script, which the rule must leave alone. Not part of any
// program.

import { defineAmScript } from "../../framework/am.ts";

export default defineAmScript({
  name: "am-inferred-action",
  context: "SCRIPTED_DECISION_NODE",
  outcomes: ["high", "low"],
  main: (action) => {
    action.goTo("high");
  },
});

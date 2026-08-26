// The decision node in the `risk-login` journey.
//
// Installed by `fo add example-risk-login`. `fo build` compiles it to ES5 and
// emits it as an amster `Scripts` entity; `fo amster` puts it in PingAM, where
// the journey's Scripted Decision node calls it.
//
// The rule is deliberately trivial so the demo is easy to drive by hand: a
// username with a high-risk prefix takes the "high" outcome, anything else
// takes "low". Replace the rule, not the plumbing.
//
// Yours to change: `fo list` will report it as edited and never overwrite it.

import { defineAmScript } from "../../framework/am.ts";

/** Sign-ins for these are treated as needing more than a password. */
const HIGH_RISK_PREFIXES = ["svc-", "admin"];

export default defineAmScript({
  name: "risk-login-check",
  context: "SCRIPTED_DECISION_NODE",
  description: "Routes risky usernames to the high outcome (example)",
  outcomes: ["low", "high"],
  // `action` is handed in, narrowed to the outcomes declared just above: a
  // `goTo` that misspells one is a compile error, not a journey that
  // dead-ends in front of a user.
  main: function (action) {
    // `username` is what a Username Collector puts into shared state.
    // `nodeState.get` hands back the raw value, so coerce it rather than
    // calling anything on it -- it may be null, and it is a Java String, not
    // a JavaScript one.
    const collected = nodeState.get("username");
    const username = collected === null || collected === undefined
      ? ""
      : String(collected);

    const high = HIGH_RISK_PREFIXES.some(function (prefix) {
      return username.indexOf(prefix) === 0;
    });

    logger.info(
      "risk-login-check: username=" + username + " outcome=" +
        (high ? "high" : "low"),
    );
    action.goTo(high ? "high" : "low");
  },
});

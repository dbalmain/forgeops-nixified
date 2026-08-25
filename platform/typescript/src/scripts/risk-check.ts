// A PingAM scripted decision node, deployed as an amster `Scripts` entity.
//
// It exists to show the AM half of the pipeline: the same TypeScript, the same
// ES5 downlevel and the same runtime bans as an IDM endpoint, but different
// globals (`nodeState`, `action`, `logger` — no `openidm`, no `request`) and a
// different deployment route. `fo build` emits it under
// platform/amster/config/, so `fo amster` puts it in AM.
//
// Wire it into a journey by adding a Scripted Decision node and choosing
// "risk-check", with outcomes "low" and "high".
//
// User file — seeded once, yours to change.

import { defineAmScript } from "../../framework/am.ts";

/** Countries we treat as low-risk without further checks. */
const LOW_RISK_COUNTRIES = ["AU", "NZ"];

export default defineAmScript({
  name: "risk-check",
  context: "SCRIPTED_DECISION_NODE",
  description: "Routes low-risk sign-ins past step-up (demo)",
  outcomes: ["low", "high"],
  main: function () {
    const country = nodeState.get("country");
    const code = country === null || country.isNull() ? "" : country.asString();

    // `indexOf` rather than `includes`: this program's `lib` is inherited from
    // the PingIDM bindings matrix and has NOT been verified against PingAM's
    // engine (see tsconfig.am.json), so prefer what ES5 guarantees.
    const low = LOW_RISK_COUNTRIES.indexOf(code) >= 0;

    logger.message("risk-check: country=" + code + " low=" + String(low));
    action.goTo(low ? "low" : "high");
  },
});

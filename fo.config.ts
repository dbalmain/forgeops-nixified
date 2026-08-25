import { defineStack } from "./tools/fo/config.ts";

/**
 * The whole surface for shaping this stack. Every field is optional; the
 * defaults in tools/fo/config.ts are what you get with an empty object.
 */
export default defineStack({
  // components: ["am", "idm", "ds-idrepo", "ds-cts", "amster",
  //              "admin-ui", "end-user-ui", "login-ui"],
  // fqdnTemplate: "{env}.localhost",
  // dsDiskSize: "10Gi",

  // The log console is ON by default: VictoriaLogs plus a Vector DaemonSet,
  // about 250 Mi, a web console on /logs, and `fo trace <transactionId>`.
  //
  // Turn it off if you are tight on RAM:
  //
  // logs: "off",
  //
  // The long form, with the defaults spelled out:
  //
  // logs: {
  //   backend: "victorialogs",
  //   includeHealthChecks: false,  // kubelet probes: 96-99% of the UI pods
  //   dsAccessDetail: "full",      // "filtered" restores upstream's quiet DS
  //   retention: "7d",
  //   diskSize: "5Gi",
  // },
});

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

  // The log console. Off by default: RAM is the binding constraint on a
  // laptop. Uncomment to add VictoriaLogs plus a Vector DaemonSet (~250 Mi),
  // a web console on /logs, and `fo trace <transactionId>`.
  //
  // logs: "victorialogs",
  //
  // The long form, with the defaults spelled out:
  //
  // logs: {
  //   backend: "victorialogs",
  //   includeHealthChecks: false,  // kubelet probes: 96-99% of the UI pods
  //   dsAccessDetail: "filtered",  // "full" puts PingDS in every trace
  //   retention: "7d",
  //   diskSize: "5Gi",
  // },
});

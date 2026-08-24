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
});

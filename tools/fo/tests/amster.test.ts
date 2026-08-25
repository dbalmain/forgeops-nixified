import { strict as assert } from "node:assert";
import { test } from "node:test";
import { looksLikeForwardReference } from "../commands/amster.ts";

test("a forward reference triggers a second pass", () => {
  // The real failure, verbatim from an amster job that imported a scripted
  // decision node before the script it points at. Reproduced deterministically
  // by running the sequence the example-risk-login README tells you to run.
  const log = [
    "Imported /opt/amster/config/realms/root/AuthTree/risk-login.json",
    "ERROR org.forgerock.openam.sdk.http.DefaultErrorHandler - Unhandled client error: [Status: 400 Bad Request]",
    "IMPORT ERRORS",
    "Failed to import /opt/amster/config/realms/root/ScriptedDecision/1111.json  : 400 Bad Request: Data validation failed for the attribute, Script",
  ].join("\n");
  assert.equal(looksLikeForwardReference(log), true);
});

test("an unrelated failure is not retried", () => {
  // The discriminating case. A blanket retry would double the time every
  // genuinely broken import takes to report, and report it twice.
  const log = [
    "IMPORT ERRORS",
    "Failed to import /opt/amster/config/realms/root/OAuth2Client/x.json : 401 Unauthorized",
  ].join("\n");
  assert.equal(looksLikeForwardReference(log), false);

  assert.equal(looksLikeForwardReference(""), false);
  assert.equal(
    looksLikeForwardReference("Imported 20 entities"),
    false,
    "a clean log must never look like a forward reference",
  );
});

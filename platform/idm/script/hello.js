/**
 * A custom IDM endpoint, reachable at /openidm/endpoint/hello.
 *
 * It exists to prove the inner loop: edit this file and `fo sync` (or `fo
 * dev`) has the change live in the running pod in well under a second, with no
 * restart. Phase 3 replaces hand-written scripts like this with TypeScript
 * compiled into script/.
 *
 * Call it with a token, because IDM delegates auth to AM:
 *   curl -k -H "Authorization: Bearer $(fo token)" \
 *     https://dev.localhost/openidm/endpoint/hello
 */
(function () {
  return {
    message: "hello from forgeops-nixified",
    method: request.method,
  };
}());

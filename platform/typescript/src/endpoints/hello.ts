// The demo endpoint, deployed as `endpoint/hello`.
//
// It exists to prove the whole Phase 3 pipeline in one file: TypeScript here
// becomes an ES5 bundle in `platform/idm/script/hello.js` plus the
// `platform/idm/conf/endpoint-hello.json` that binds it to a route, and `fo
// dev` has both live in the running pod in about a second.
//
// Note what is NOT annotated below: `params.name` is `string` because it was
// declared `v.string`, and `query.shout` is `boolean | undefined` because it
// was declared an optional `v.boolean`. Change a validator and the handler
// stops compiling.
//
// Call it:
//   curl -k -H "Authorization: Bearer $(fo token)" \
//     https://dev.localhost/openidm/endpoint/hello
//
// User file — seeded once, yours to change.

import {
  badRequest,
  defineEndpoint,
  queryResult,
  queryRoute,
  route,
  v,
} from "../../framework/index.ts";

const GREETINGS = ["hello", "g'day", "howdy"] as const;

const GREETING_RESPONSE = v.object({
  _id: v.string(),
  message: v.string({
    description: "The greeting, in whatever style was asked for.",
  }),
});

export default defineEndpoint({
  name: "hello",
  summary: "Greeting (demo)",
  // Validated on every route, and used as the log correlation id when present.
  headers: { "x-request-id": v.optional(v.uuid()) },
  routes: [
    route({
      method: "read",
      path: "/",
      response: GREETING_RESPONSE,
      handler: ({ log }) => {
        log.debug("greeted the world");
        return { _id: "", message: "hello from forgeops-nixified" };
      },
    }),

    route({
      method: "read",
      path: "/{name}",
      params: { name: v.string({ minLength: 1, maxLength: 64 }) },
      query: { shout: v.optional(v.boolean()) },
      response: GREETING_RESPONSE,
      handler: ({ params, query, log }) => {
        if (params.name === "nobody") {
          // A tagged fault, never a subclassed Error: `Reflect` is absent in
          // IDM's script engine, so Babel's `_wrapNativeSuper` silently breaks
          // `instanceof`.
          throw badRequest("There is no greeting for nobody.", {
            name: params.name,
          });
        }
        const message = "hello, " + params.name;
        log.debug("greeted a caller", { name: params.name });
        return {
          _id: params.name,
          message: query.shout === true ? message.toUpperCase() : message,
        };
      },
    }),

    queryRoute({
      path: "/",
      query: { style: v.optional(v.enumOf(GREETINGS)) },
      response: GREETING_RESPONSE,
      handler: ({ query }) => {
        const styles = query.style === undefined ? GREETINGS : [query.style];
        return queryResult(
          styles.map((style) => ({ _id: style, message: style + ", world" })),
        );
      },
    }),
  ],
});

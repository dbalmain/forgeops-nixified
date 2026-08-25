import { anyObject, decode } from "../lib/shape.ts";
import { fetchIngress } from "../lib/http.ts";
import { bold, cyan, die, dim, warn, yellow } from "../lib/ui.ts";
import { readSecret } from "./info.ts";
import { logStackReady, warnIfCollectorDown } from "./logstore.ts";
import { LOGS_PATH } from "../logstack.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Querying the tier-1 store.
 *
 * `fo trace` is the reason this tier exists (PLAN.md section 9): one command
 * that returns a single login as one time-ordered list across PingAM, PingIDM
 * and PingDS, which is the thing a ForgeRock developer wants and cannot easily
 * get today.
 */

export type LogEvent = Record<string, unknown>;

/**
 * Sub-transactions are `<root>/<n>`, and nested ones `<root>/<n>/<m>`: PingAM
 * calling PingIDM does not reuse the parent id, it extends it. So a trace is a
 * PREFIX query, not an equality one - matching exactly would return the entry
 * point and lose every downstream call, which is the whole point of tracing.
 *
 * `:=` is LogsQL's exact-value filter and `*` makes it an exact-prefix filter,
 * which is what keeps a transaction id containing `-` from being word-split.
 */
export function traceQuery(transactionId: string): string {
  return `transactionId:=${JSON.stringify(transactionId)}*`;
}

/** POST a LogsQL query to the store through the platform ingress. */
export async function queryLogs(
  cfg: ResolvedConfig,
  query: string,
  opts: { limit?: number } = {},
): Promise<LogEvent[]> {
  if (cfg.logs.backend === "off") {
    die(
      "the log console is off. Set `logs: \"victorialogs\"` in fo.config.ts " +
        "and run `fo up`.",
    );
  }
  if (!logStackReady(cfg)) {
    die(
      `no log store running in namespace ${cfg.namespace}. Run \`fo up\` - ` +
        `or \`fo status\` if you expected one.`,
    );
  }
  warnIfCollectorDown(cfg);

  const ca = readSecret(cfg, "platform-tls", "ca.crt");
  const res = await fetchIngress(cfg, `${LOGS_PATH}/select/logsql/query`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      query,
      limit: String(opts.limit ?? 1000),
    }).toString(),
    ...(ca ? { ca } : {}),
  });
  if (res.status !== 200) {
    die(
      `the log store returned ${res.status} for ${query}: ` +
        res.body.slice(0, 300),
    );
  }
  // The response is newline-delimited JSON, one object per event, NOT a JSON
  // array - so it streams, and so a partial read is still parseable.
  return res.body
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => decode(l, `log store event ${i + 1}`, anyObject));
}

function str(e: LogEvent, key: string): string {
  const v = e[key];
  return typeof v === "string" ? v : v === undefined ? "" : String(v);
}

/**
 * A sortable key for a `_time` value.
 *
 * Needed because VictoriaLogs returns whatever precision the source wrote and
 * TRIMS TRAILING ZEROS, so `...24.57Z` and `...24.571Z` come back at different
 * lengths - and comparing them as plain strings puts the later event first,
 * because "1" sorts before "Z". Padding the fraction to nanoseconds makes the
 * comparison mean what it looks like it means, without losing sub-millisecond
 * ordering the way `Date.parse` would.
 */
export function timeKey(time: string): string {
  const m = /^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$/.exec(time);
  if (!m) return time;
  return `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}`;
}

/** Sort ascending by `_time`, which the collector stamps from the event. */
export function byTime(events: LogEvent[]): LogEvent[] {
  return [...events].sort((a, b) =>
    timeKey(str(a, "_time")).localeCompare(timeKey(str(b, "_time"))),
  );
}

const COMPONENT_COLOUR: Record<string, (s: string) => string> = {
  am: cyan,
  idm: yellow,
};

/**
 * hh:mm:ss.mmm, always the same width.
 *
 * Not a slice of the raw string: VictoriaLogs returns whatever precision the
 * source had, from `12:35:08.35Z` to `12:35:08.370123456Z`, so slicing makes
 * the column ragged and the ordering hard to read.
 */
function clock(e: LogEvent): string {
  const d = new Date(str(e, "_time"));
  if (Number.isNaN(d.getTime())) return "".padEnd(12);
  return d.toISOString().slice(11, 23);
}

/**
 * What to call the event.
 *
 * Audit events have `eventName`. PingAM's ordinary JSON logging does not, but
 * it DOES carry the transaction id, so those lines land in a trace too - and
 * printing their whole JSON body as a name is unreadable. Their `message` is
 * the useful part.
 */
function label(e: LogEvent): string {
  const name = str(e, "eventName");
  if (name) return name;
  const message = str(e, "message");
  if (message) {
    const level = str(e, "level");
    return `${level ? `${level} ` : ""}${message.split("\n")[0]!.slice(0, 90)}`;
  }
  return str(e, "_msg").slice(0, 90);
}

/**
 * One line per event: when, which component, what happened.
 *
 * Deliberately not the raw JSON. A trace of a single login is 20-40 events and
 * the value is seeing the SHAPE of it - AM tree, then IDM read, then DS search
 * - which raw JSON buries.
 */
function printTrace(events: LogEvent[]): void {
  const rows = byTime(events);
  const width = Math.max(
    2,
    ...rows.map((e) => (str(e, "component") || "?").length),
  );
  for (const e of rows) {
    const comp = str(e, "component") || "?";
    const paint = COMPONENT_COLOUR[comp] ?? ((s: string) => s);
    const detailBits = [
      str(e, "auditComponent"),
      str(e, "response.status") || str(e, "result"),
      str(e, "request.operation"),
      str(e, "http.request.method"),
      str(e, "http.request.path") || str(e, "request.dn"),
      str(e, "userId") || str(e, "principal"),
    ].filter(Boolean);
    // The sub-transaction suffix is what says WHICH downstream call this is,
    // so it earns its place on the line even though the root is in the header.
    const sub = str(e, "transactionId");
    const suffix = sub.includes("/") ? dim(` ${sub.slice(sub.indexOf("/"))}`) : "";
    console.log(
      `${dim(clock(e))}  ${paint(comp.padEnd(width))} ${label(e)}${suffix}` +
        (detailBits.length ? dim(`  ${detailBits.join(" ")}`) : ""),
    );
  }
}

export async function trace(
  cfg: ResolvedConfig,
  transactionId: string | undefined,
  opts: { json?: boolean; limit?: number } = {},
): Promise<void> {
  if (!transactionId) die("fo trace needs a transaction id");
  const events = await queryLogs(cfg, traceQuery(transactionId), {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(byTime(events), null, 2));
    return;
  }
  if (events.length === 0) {
    warn(`no events for transaction ${transactionId}`);
    console.log(
      dim(
        "   Transaction ids only cross components when the stack trusts the\n" +
          "   inbound header - `fo up` sets that. A client-supplied id also\n" +
          "   needs X-ForgeRock-TransactionId on the original request.",
      ),
    );
    return;
  }
  const components = [...new Set(events.map((e) => str(e, "component")))].sort();
  console.log(
    `\n${bold(transactionId)}  ${dim(`${events.length} events across ${components.join(", ")}`)}\n`,
  );
  printTrace(events);
}

/** `fo logs search '<LogsQL>'` - the general escape hatch under `fo trace`. */
export async function logsSearch(
  cfg: ResolvedConfig,
  query: string | undefined,
  opts: { json?: boolean; limit?: number } = {},
): Promise<void> {
  if (!query) die("fo logs search needs a LogsQL query, e.g. 'component:am error'");
  const events = await queryLogs(cfg, query, {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(byTime(events), null, 2));
    return;
  }
  if (events.length === 0) {
    warn(`no events for ${query}`);
    return;
  }
  printTrace(events);
}

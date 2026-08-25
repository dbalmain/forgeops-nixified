/**
 * Narrowing for JSON that came from somewhere else.
 *
 * `fo` reads kubectl, k3d, PingAM, PingIDM and VictoriaLogs, and every one of
 * those shapes is owned by somebody who can change it in a release. A cast
 * (`JSON.parse(x) as Pod[]`) asserts the shape without checking it, so a
 * change surfaces as `undefined` several frames away from the boundary that
 * let it in - or, worse, not at all.
 *
 * The failure that motivated this: `getPods` and `clusterExists` both caught
 * the parse and returned "nothing". A shape change would have made `fo status`
 * report an empty cluster and `clusterExists` answer false - sending `fo up`
 * to create a cluster that already existed. Both would have been silent.
 *
 * So these validators exist to separate two cases a `try/catch` conflates:
 * the command FAILED (expected - not deployed yet, no cluster) and the command
 * SUCCEEDED but said something we do not understand (a bug, and worth a loud
 * error naming the field).
 *
 * Hand-written rather than a schema library: it is about sixty lines, `fo`
 * has no npm dependencies by design, and the six shapes involved are small.
 */

export class ShapeError extends Error {
  override name = "ShapeError";
}

/** What a value looks like, for an error message - never the whole payload. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    const shown = keys.slice(0, 5).join(", ");
    return `an object {${shown}${keys.length > 5 ? ", …" : ""}}`;
  }
  if (typeof v === "string") {
    return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  }
  return `${typeof v} ${String(v)}`;
}

function bad(path: string, expected: string, got: unknown): never {
  // The root has no path to name, and "`: expected an object`" reads as a
  // missing field rather than as the whole payload being wrong.
  const where = path === "" ? "" : `${path}: `;
  throw new ShapeError(`${where}expected ${expected}, got ${describe(got)}`);
}

/** A validator both narrows and reports where it gave up. */
export type Validator<T> = (v: unknown, path: string) => T;

export const str: Validator<string> = (v, path) =>
  typeof v === "string" ? v : bad(path, "a string", v);

export const num: Validator<number> = (v, path) =>
  typeof v === "number" ? v : bad(path, "a number", v);

export const bool: Validator<boolean> = (v, path) =>
  typeof v === "boolean" ? v : bad(path, "a boolean", v);

/** Any JSON object, contents unchecked - for genuinely open shapes. */
export const anyObject: Validator<Record<string, unknown>> = (v, path) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : bad(path, "an object", v);

/** Absent or null passes as undefined; present must satisfy `inner`. */
export function opt<T>(inner: Validator<T>): Validator<T | undefined> {
  return (v, path) => (v === undefined || v === null ? undefined : inner(v, path));
}

export function arrayOf<T>(inner: Validator<T>): Validator<T[]> {
  return (v, path) => {
    if (!Array.isArray(v)) return bad(path, "an array", v);
    return v.map((item, i) => inner(item, `${path}[${i}]`));
  };
}

/** An object used as a map: unknown keys, every value the same shape. */
export function record<T>(inner: Validator<T>): Validator<Record<string, T>> {
  return (v, path) => {
    const o = anyObject(v, path);
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(o)) {
      out[key] = inner(value, `${path}.${key}`);
    }
    return out;
  };
}

/**
 * An object with known fields. Unlisted fields are kept as-is and never
 * checked - these shapes belong to other people, and objecting to a field
 * they added is not our business.
 */
export function obj<T extends Record<string, Validator<unknown>>>(
  fields: T,
): Validator<{ [K in keyof T]: T[K] extends Validator<infer U> ? U : never }> {
  return (v, path) => {
    const o = anyObject(v, path);
    const out: Record<string, unknown> = {};
    for (const [key, validate] of Object.entries(fields)) {
      out[key] = validate(o[key], path === "" ? key : `${path}.${key}`);
    }
    return out as { [K in keyof T]: T[K] extends Validator<infer U> ? U : never };
  };
}

/**
 * Parse and narrow in one step.
 *
 * `what` names the SOURCE, not the shape - "kubectl get pods", not "PodList" -
 * because the person reading the error needs to know which command lied to
 * them, and the field path already says what was wrong with it.
 */
export function decode<T>(raw: string, what: string, validate: Validator<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShapeError(
      `${what}: output is not JSON (${raw.trim().slice(0, 120) || "empty"})`,
    );
  }
  try {
    return validate(parsed, "");
  } catch (e) {
    if (e instanceof ShapeError) throw new ShapeError(`${what}: ${e.message}`);
    throw e;
  }
}

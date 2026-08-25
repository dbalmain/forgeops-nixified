import { strict as assert } from "node:assert";
import { test } from "node:test";
import { newestBuild } from "../commands/upgrade.ts";

// A trimmed copy of what the registry actually returns for `am`: several
// release families, the product-version scheme, and assorted branch tags.
const REAL_TAGS = [
  "2026.2.0-1830", "2026.2.0-2225", "2026.2.1-0302", "2026.2.1-1747",
  "2026.2.1-2305", "2026.3.0-1512", "2026.3.0-1530", "2026.3.0-1849",
  "8.1.1-202608240523", "8.1.1-latest", "9.0.1-20241125-140337",
  "latest", "dev", "build-cache", "ptest",
];

test("picks the newest build of the requested release", () => {
  assert.equal(newestBuild(REAL_TAGS, "2026.3.0"), "2026.3.0-1849");
});

test("does not stray into a neighbouring release", () => {
  // "2026.2.1" must not match "2026.2.1x" nor collect 2026.2.0 builds.
  assert.equal(newestBuild(REAL_TAGS, "2026.2.1"), "2026.2.1-2305");
  assert.equal(newestBuild(REAL_TAGS, "2026.2.0"), "2026.2.0-2225");
});

test("an unpublished release yields nothing rather than a wrong guess", () => {
  assert.equal(newestBuild(REAL_TAGS, "2026.4.0"), undefined);
});

test("build numbers compare numerically, not as strings", () => {
  // Builds are four-digit today, which makes a string sort agree by accident.
  // Nobody promised that, and a five-digit build sorts BELOW "9999" as text -
  // so this is the case that separates a real comparison from a lucky one.
  assert.equal(
    newestBuild(["2026.3.0-9999", "2026.3.0-10250"], "2026.3.0"),
    "2026.3.0-10250",
  );
});

test("a non-numeric suffix is not a build", () => {
  // `8.1.1-latest` is a moving pointer, not a release, and pinning it would
  // reintroduce exactly the drift the flake pin exists to prevent.
  assert.equal(newestBuild(["8.1.1-latest", "8.1.1-202608240523"], "8.1.1"),
    "8.1.1-202608240523");
  assert.equal(newestBuild(["2026.3.0-latest"], "2026.3.0"), undefined);
});

test("the version is matched whole, not as a prefix", () => {
  // "2026.3" must not match "2026.3.0-1849" - a truncated version in
  // config.ts should find nothing, not silently adopt another release.
  assert.equal(newestBuild(REAL_TAGS, "2026.3"), undefined);
});

test("order in the registry listing does not matter", () => {
  assert.equal(newestBuild([...REAL_TAGS].reverse(), "2026.3.0"), "2026.3.0-1849");
});

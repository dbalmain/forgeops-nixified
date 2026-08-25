# What the Ping script engines actually provide

`platform/typescript/framework/engine-surface.json` is the data. This is how
it was obtained and what it settles.

## Why this exists

The two runtime TypeScript programs pin `lib` narrowly, and `fo build` runs
`@babel/preset-env` with **`useBuiltIns: false`** — nothing is polyfilled. So
`lib` is a load-bearing claim about the engine, not a style preference: declare
a builtin the engine lacks and the code type-checks, lints, builds, deploys,
and throws in the middle of somebody's login.

`tsconfig.am.json` carried this note for two phases:

> KNOWN GAP: `lib` is inherited from tsconfig.json, where it was pinned to
> PingIDM's script-bindings matrix. It has NOT been verified against PingAM's
> engine, so it may permit a method AM does not have.

That gap is now closed, by measurement rather than by reading documentation.

## Method

Two probes, one per engine, each reporting whether a builtin exists rather than
using it:

- **PingAM** — `spike/engine-probe/am-scripted-decision-probe.ts`, deployed as
  the `risk-login` journey's scripted decision node (`fo add
  example-risk-login`, then `fo build && fo amster`), driven by one
  authentication against `?authIndexType=service&authIndexValue=risk-login`,
  reporting through `logger.error`.
- **PingIDM** — `spike/engine-probe/idm-endpoint-probe.ts`, deployed as a
  custom endpoint (`fo build && fo sync`) and queried over REST, reporting in
  the response body.

To re-run either, copy it into `platform/typescript/src/scripts/` or
`src/endpoints/` respectively, build, deploy, invoke, and read the output.

Existence is tested with `typeof` and with bracket access on the holder — never
by calling the thing, which would abort the probe at its first absence.

## Two traps this hit, both worth knowing

**A probe that cannot observe the answer.** The first round tested array
iterability as `Array.prototype[String(Symbol.iterator)]`. `String(symbol)`
yields `"Symbol(Symbol.iterator)"`, a key nothing has, so it reported arrays as
non-iterable — on an engine where they are iterable. Indexing with the symbol
itself gives the true answer. A green-looking result from an experiment that
could not have found the opposite is a coin flip.

**Syntax is not the question.** Babel downlevels `for...of`, spread and
destructuring to IE11, so whether the engine supports the *syntax* is
irrelevant; what matters is whether the helper Babel emits in its place works.
The probes therefore run those constructs and report the outcome, rather than
inspecting the engine for them.

## Result

Both engines are the **same Rhino build** — `java`, `Packages` and
`JavaImporter` are present, Nashorn's `Java` is absent — and they **agreed on
all 95 shared probes**. That is what makes one shared `lib` sound, and the
test `tests/engine-lib.test.mjs` fails if they ever diverge.

### The pinned `lib` was correct, and too narrow

Every entry already pinned is genuinely present: ES5, ES2015.Core,
ES2015.Collection, ES2015.Iterable (`Symbol.iterator` is on `Array.prototype`
and `for...of` works), ES2015.Symbol, ES2015.Symbol.WellKnown, ES2015.Promise,
ES2016.Array.Include. **No change was needed** — which is the outcome worth
having verified rather than assumed.

Four entries were added, each fully present:

| Added | Members | Verified |
| --- | --- | --- |
| `ES2017.String` | `padStart`, `padEnd` | both |
| `ES2018.Promise` | `finally` | yes |
| `ES2019.Object` | `fromEntries` | yes |
| `ES2019.String` | `trimStart`, `trimEnd`, `trimLeft`, `trimRight` | all four |

`ES2017.Object` is a **partial** match: `entries` and `values` are present but
`getOwnPropertyDescriptors` is not, and a lib entry is all-or-nothing. Those
two are declared instead in `framework/engine-lib.d.ts`, which the test checks
member by member against this data.

### Absent, and correctly excluded

`Proxy`, `Reflect`, `WeakRef`, `structuredClone`, `BigInt64Array`,
`Symbol.asyncIterator`, `Object.hasOwn`, `Object.getOwnPropertyDescriptors`,
`Array#flat`, `Array#flatMap`, `Array#at`, `Array#findLast`,
`String#replaceAll`, `String#at`, `String#matchAll`.

The absence of `Proxy` and `Reflect` also confirms the build's runtime-ban
rule, which had only been justified against PingIDM.

### Present but not declared

`BigInt`, `globalThis`, `Int8Array`, `ArrayBuffer`. Left undeclared: nothing
here needs them, and every declaration is a liability the next upgrade has to
re-verify.

## Keeping it honest

`tests/engine-lib.test.mjs` cross-checks the tsconfigs against this file by
reading TypeScript's own lib `.d.ts` sources — so adding a lib entry that
declares an absent builtin fails the build. Both failure modes were exercised
before the test was committed: adding `ES2019.Array` (which declares `flat`)
fails it, and so does declaring `Object.hasOwn` in `engine-lib.d.ts`.

Re-run the probes after a ForgeOps upgrade. The engine can change underneath
this file, and nothing else will notice.

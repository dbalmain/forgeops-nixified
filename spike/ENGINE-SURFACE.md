# What the Ping script engines actually provide

`platform/typescript/framework/engine-surface.json` is the data. This is the
**original spike**: how the first measurement was obtained, the traps it hit,
and what it settled at the time.

> **Superseded in part.** The audit was retaken at a much larger scale after
> the first version was found to be circular — it generated its probes from the
> file it was verifying, so it could only ever confirm the 97 keys somebody had
> thought of. Reading the required set out of the lib `.d.ts` files instead put
> the count at **728**, and the numbers and mechanisms below moved with it:
>
> | This document says | Current |
> | --- | --- |
> | 95 shared probes, engines identical | **767** each; they differ on `Math`/`JSON` `Symbol.toStringTag` |
> | the pinned `lib` was correct | the pin is sound but **wider than the engine** — 234 declarations are absent and cannot be removed |
> | `tests/engine-lib.test.mjs` fails on a lib entry that declares an absent builtin | unsatisfiable, and replaced: **`fo build` fails on a USE**, before emission |
> | six hand-written `emit:*` checks | 15 cases generated through the real esbuild+Babel pipeline |
> | existence tested with `typeof` | `in` on the holder plus instance sampling — `typeof Map.prototype.size` *throws* |
>
> The current method lives in `platform/typescript/tools/engine-coverage.mjs`
> (what the lib promises), `tools/engine-usage.mjs` (the use-site gate and its
> stated boundary) and `tools/emit-probe.mjs` (the behavioural half). The
> narrative of why it changed is in `PLAN.md`, phase 6.2. What follows is left
> as written, because the traps in it are the part still worth reading.

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

The baseline was taken with two hand-written probes, one deployed per engine.
Both have since been replaced by `fo doctor --engines`, which re-takes the
measurement against a running stack:

```sh
fo doctor --engines
```

- **PingIDM** — `POST /openidm/script?_action=eval`. IDM evaluates script
  inline, so the probe needs no deploy and leaves nothing behind.
- **PingAM** — AM has no eval action (`_action=evaluate` answers 501), so the
  probe is installed over REST as a script, a `ScriptedDecisionNode` and a
  one-node tree, driven by a single authentication, and read back from
  `logger.error` in AM's log. All three objects are removed afterwards,
  including when the probe throws. The tree ends at **Failure**, not Success:
  the probe authenticates nobody, and asking AM to mint a session for a
  subject that does not exist answers 500 and buries the outcome.

**The probe list is generated from `engine-surface.json` itself**, so the thing
being verified and the thing verifying it cannot disagree about what to check.
Add a key to the JSON and both engines probe it on the next run. The original
probes did drift this way — they had reached 97 checks against 95 — which is
why they are gone rather than kept as a second copy of the list. They are in
git history if the original wording of a check is ever needed.

> This is the circularity. Generating the probes from the file makes the two
> consistent, and consistency is not coverage: a builtin nobody added to the
> JSON is never probed, never reported, and silently assumed present. The
> required set is now derived from the lib `.d.ts` files instead, and a key the
> lib promises but the measurement lacks is a test failure.

Only the six `emit:*` entries are still hand-written, because they assert that
downlevelled output *runs* rather than that a name exists.

> Also superseded. Hand-written ES5 tests a guess about the pipeline, not the
> pipeline: the "spread" case was a literal `[].concat(...)` when Babel emits
> `_toConsumableArray`. `tools/emit-corpus.ts` is now compiled through the real
> path and the committed result is what the engines run.

Existence is tested with `typeof` and with bracket access on the holder — never
by calling the thing, which would abort the probe at its first absence.

> `typeof` alone was wrong, and it took a wider measurement to find out.
> `typeof Map.prototype.size` **throws** on this Rhino (`Method "get size"
> called on incompatible object`), so `Map#size`, `Set#size` and `Error#stack`
> were all recorded absent while being plainly present. The probe now uses
> `in` on the holder and falls back to sampling a real instance.

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
all 95 shared probes**.

> At 767 probes they do not. PingIDM's Rhino carries `Symbol.toStringTag` on
> `Math` and `JSON`; PingAM's does not. Neither is reachable from anything
> worth writing, so the shared `lib` survives — but it survives because each
> program is checked against **its own** engine, not because the engines are
> the same object. "They agree" was an artefact of measuring 95 things.

### The pinned `lib` was correct, and too narrow

> Correct in the sense that every entry pinned is genuinely present. Not in the
> sense that everything the pin *declares* is present: `lib.es5` is monolithic,
> and it brings in the whole typed-array suite, `RegExp#flags` and
> `Date#[Symbol.toPrimitive]`, none of which this Rhino has. 234 of the 728
> declarations are absent. That cannot be fixed by choosing better entries, so
> the gate moved to the use site.

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

> The first of those two is not a check any real lib list can satisfy, and it
> only ever passed because the measurement was small enough not to notice.
> `fo build` now fails on a **use** of an absent builtin instead, before
> anything is emitted; the `engine-lib.d.ts` check is unchanged and still
> exercised. The discriminating fixture is committed at
> `platform/typescript/tests/fixtures/uses-absent-builtins.ts`.

Run `fo doctor --engines` after a ForgeOps upgrade. The engine can change
underneath this file, and nothing in the build would notice: every gate would
stay green while the pin quietly described the old engine. The command exits
non-zero on drift and names the builtins that moved, in both directions.

If it reports drift, re-record it — update `engine-surface.json`, then let
`tests/engine-lib.test.mjs` tell you which `lib` entries no longer hold. Never
widen a `lib` to make a check pass; that is the failure this whole chain
exists to prevent.

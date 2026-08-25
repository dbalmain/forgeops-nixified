import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { detail, dim, heading, step, warn } from "../lib/ui.ts";
import { syncIdm } from "./sync.ts";
import { runAmster } from "./amster.ts";
import { restart } from "./restart.ts";
import { build } from "./build.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * `fo watch` - a Tilt-free watcher for the three-tier inner loop.
 *
 * This exists to keep Tilt honest. The boundary rule (PLAN.md section 10) says
 * everything Tilt does must be reachable from `fo` with Tilt not running; a
 * rule like that decays into a comment unless something actually exercises the
 * path. This is that something, and it is also what CI uses.
 */

type Tier = {
  name: string;
  dir: string[];
  budget: string;
  run: (cfg: ResolvedConfig) => Promise<void> | void;
};

const TIERS: Tier[] = [
  // TypeScript only BUILDS here. The emitted files land in platform/idm/, and
  // the two tiers below pick them up and sync - so the chain is one
  // responsibility per tier rather than a build step that also knows how to
  // talk to a pod.
  {
    name: "typescript",
    dir: ["platform", "typescript", "src"],
    budget: "build, then sync",
    run: (cfg) => build(cfg),
  },
  {
    name: "framework",
    dir: ["platform", "typescript", "framework"],
    budget: "build, then sync",
    run: (cfg) => build(cfg),
  },
  {
    name: "idm-conf",
    dir: ["platform", "idm", "conf"],
    budget: "<1s",
    run: (cfg) => void syncIdm(cfg, "conf"),
  },
  {
    name: "idm-script",
    dir: ["platform", "idm", "script"],
    budget: "<1s",
    run: (cfg) => void syncIdm(cfg, "script"),
  },
  {
    name: "idm-data",
    dir: ["platform", "idm", "data"],
    budget: "<1s",
    run: (cfg) => void syncIdm(cfg, "data"),
  },
  {
    name: "amster",
    dir: ["platform", "amster", "config"],
    budget: "~60s",
    run: (cfg) => runAmster(cfg),
  },
  {
    // `restart` rebuilds the am_custom image first when this directory has
    // content: a bare rollout re-runs the init container against the OLD
    // image and silently applies nothing.
    name: "am-config",
    dir: ["platform", "am", "config"],
    budget: "~2min",
    run: (cfg) => restart(cfg, "am"),
  },
];

/** Coalesce a burst of events - editors write, rename and chmod in sequence. */
const DEBOUNCE_MS = 150;

export async function watchLoop(cfg: ResolvedConfig): Promise<void> {
  heading(`fo watch  ${cfg.env}`);

  const pending = new Set<Tier>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const flush = async () => {
    if (running) {
      // Re-arm rather than overlap: a second amster job while the first is
      // still importing is a good way to corrupt a realm.
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
      return;
    }
    const due = [...pending];
    pending.clear();
    if (due.length === 0) return;
    running = true;
    try {
      for (const tier of due) {
        step(`${tier.name} changed ${dim(`(${tier.budget})`)}`);
        const started = Date.now();
        await tier.run(cfg);
        detail(`${Date.now() - started}ms`);
      }
    } catch (e) {
      warn(e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  };

  let watched = 0;
  for (const tier of TIERS) {
    const dir = join(cfg.root, ...tier.dir);
    if (!existsSync(dir)) continue;
    watched += 1;
    detail(`${relative(cfg.root, dir)}${sep}**  ${dim(tier.budget)}`);
    watch(dir, { recursive: true }, (_event, filename) => {
      // Editors drop temp files next to the real one; syncing those into a
      // running pod makes IDM log parse errors for files nobody wrote.
      if (filename && /(~|\.swp|\.tmp|^\.#|^4913$)/.test(filename)) return;
      pending.add(tier);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), DEBOUNCE_MS);
    });
  }

  if (watched === 0) {
    warn("nothing to watch - platform/ has no tier directories");
    return;
  }
  console.log(`\n${dim("watching; ctrl-c to stop")}`);
  // Resolve never: the watchers keep the process alive.
  await new Promise<void>(() => {});
}

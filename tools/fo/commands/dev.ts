import { has, stream } from "../lib/proc.ts";
import { detail, heading, step } from "../lib/ui.ts";
import { watchLoop } from "./watch.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * The live inner-loop session. Blocks until you stop it.
 *
 * Deliberately NOT folded into `fo up`. `fo up` converging and then printing
 * URLs and credentials is the thing that makes the stack approachable, and
 * burying that under a full-screen Tilt UI would cost more than the extra
 * command does. So `fo up` gets you a stack; `fo dev` gets you the loop.
 *
 * Tilt is used when present and `fo watch` when it is not, which is what keeps
 * the boundary rule (PLAN.md section 10) honest rather than aspirational: both
 * paths run the same `fo` subcommands.
 */
export async function dev(
  cfg: ResolvedConfig,
  opts: { noTilt: boolean },
): Promise<void> {
  if (!opts.noTilt && has("tilt")) {
    heading(`fo dev  ${cfg.env}  (tilt)`);
    detail("web UI on http://localhost:10350 - ctrl-c to stop");
    await stream("tilt", ["up", "--stream"], {
      cwd: cfg.root,
      env: { KUBECONFIG: cfg.kubeconfig, FO_ENV: cfg.env },
    });
    return;
  }
  if (!opts.noTilt) {
    step("tilt not on PATH; using the built-in watcher");
    detail("add `tilt` to the flake's runtimeTools for the web UI");
  }
  await watchLoop(cfg);
}

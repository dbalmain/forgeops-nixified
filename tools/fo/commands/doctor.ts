import { lookup } from "node:dns/promises";
import { capture, has } from "../lib/proc.ts";
import { fail, heading, ok, warn } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * A check's answer: passed, a message saying what is wrong, or `unknown`.
 *
 * `unknown` exists because the tool a check depends on may not be there. `ss`
 * and `free` are Linux-only and neither is in `runtimeTools`, and their
 * pipelines end in `2>/dev/null` -- so on a machine without them the output was
 * empty, empty read as "nothing is listening", and a preflight that could not
 * look reported "ports free". A check that cannot run has to say so.
 */
type Answer = true | string | { unknown: string };

/**
 * `fatal` blocks `fo up`; everything else is advisory and only warns.
 *
 * Declared per check rather than matched on the name, which is what this used
 * to do (`c.name.includes("tools")`). A check's severity should not change
 * because somebody reworded its label.
 */
type Check = { name: string; fatal?: boolean; run: () => Promise<Answer> };


const REQUIRED_TOOLS = ["docker", "k3d", "kubectl", "helm"];

export async function doctor(cfg: ResolvedConfig): Promise<boolean> {
  heading(`fo doctor  (env ${cfg.env}, fqdn ${cfg.fqdn})`);

  const checks: Check[] = [
    {
      name: "required tools on PATH",
      fatal: true,
      run: async () => {
        const missing = REQUIRED_TOOLS.filter((t) => !has(t));
        return missing.length === 0
          ? true
          : `missing: ${missing.join(", ")} - are you in the nix devShell? (direnv allow)`;
      },
    },
    {
      name: "docker daemon reachable",
      fatal: true,
      run: async () => {
        const r = capture("docker", ["info", "--format", "{{.ServerVersion}}"], {
          allowFailure: true,
        });
        return r.code === 0
          ? true
          : "docker is not running. k3d needs a container runtime; start Docker Desktop or the docker service.";
      },
    },
    {
      name: `${cfg.fqdn} resolves to loopback`,
      // FATAL. Every URL `fo up` finishes by printing is behind this hostname,
      // so a stack the developer cannot open is not a successful `fo up` -- it
      // used to warn, deploy the whole platform, and then hand over a link
      // that does not resolve. The message says how to fix it in one config
      // line, which is a better escape hatch than a flag for building an
      // unreachable stack.
      fatal: true,
      run: async () => {
        try {
          const r = await lookup(cfg.fqdn, { all: true });
          const loop = r.some(
            (a) => a.address === "127.0.0.1" || a.address === "::1",
          );
          return loop
            ? true
            : `resolves to ${r.map((a) => a.address).join(", ")}, not loopback`;
        } catch {
          return (
            `does not resolve. *.localhost needs systemd-resolved or an ` +
            `equivalent. Set fqdnTemplate: "{env}.127.0.0.1.nip.io" in ` +
            `fo.config.ts, which needs no local DNS config.`
          );
        }
      },
    },
    {
      name: "ports 80 and 443 free (or already ours)",
      run: async () => {
        if (!has("ss")) {
          return { unknown: "`ss` is not on PATH (iproute2), so nothing here can see what is listening" };
        }
        // `ss` DIRECTLY, not down a pipe. `ss ... | awk ... | head -1` takes
        // its exit status from `head`, which succeeds whatever `ss` did -- so
        // an `ss` that ran and failed produced empty output, and empty read as
        // "nothing is listening". The missing-binary case above is only half
        // of that; this is the other half.
        const listening = capture("ss", ["-lnt"], { allowFailure: true });
        if (listening.code !== 0) {
          return {
            unknown:
              `\`ss -lnt\` exited ${listening.code}: ` +
              (listening.stderr.trim() || "no output"),
          };
        }
        const busy: string[] = [];
        for (const p of [80, 443]) {
          const port = new RegExp(`:${p}\\s`);
          const found = listening.stdout
            .split("\n")
            .slice(1)
            .some((line) => port.test(line.trim().split(/\s+/)[3] + " "));
          if (found) busy.push(String(p));
        }
        if (busy.length === 0) return true;
        const ours = capture(
          "sh",
          ["-c", `docker ps --format '{{.Names}}' | grep -c '^k3d-${cfg.clusterName}-serverlb$'`],
          { allowFailure: true },
        );
        return ours.stdout.trim() === "1"
          ? true
          : `ports ${busy.join(", ")} are in use by something other than this cluster`;
      },
    },
    {
      name: "memory headroom",
      run: async () => {
        if (!has("free")) {
          return { unknown: "`free` is not on PATH (procps), so available memory is unknown" };
        }
        const r = capture("sh", ["-c", "free -m 2>/dev/null | awk '/^Mem:/{print $7}'"], {
          allowFailure: true,
        });
        const avail = Number(r.stdout.trim());
        if (!Number.isFinite(avail) || avail === 0) {
          return { unknown: "`free` produced nothing readable" };
        }
        // Measured 4.4 GiB actual for the whole stack in the Phase 0 spike.
        return avail >= 6000
          ? true
          : `${avail} MB available; the stack uses about 4.5 GB and wants some room`;
      },
    },
    {
      name: "disk headroom",
      run: async () => {
        const r = capture("sh", ["-c", "df -Pm / | awk 'NR==2{print $4}'"], {
          allowFailure: true,
        });
        const avail = Number(r.stdout.trim());
        if (!Number.isFinite(avail) || avail === 0) {
          return { unknown: "`df` produced nothing readable" };
        }
        return avail >= 20000
          ? true
          : `${avail} MB free; images plus DS volumes need roughly 10 GB`;
      },
    },
  ];

  let allOk = true;
  for (const c of checks) {
    const r = await c.run();
    if (r === true) ok(c.name);
    else if (typeof r === "object") {
      // Never `ok`. "I could not look" and "I looked and it is fine" are
      // different answers, and printing the second for the first is what makes
      // a preflight worse than no preflight.
      warn(`${c.name}: unknown - ${r.unknown}`);
    } else {
      if (c.fatal === true) {
        fail(`${c.name}: ${r}`);
        allOk = false;
      } else {
        warn(`${c.name}: ${r}`);
      }
    }
  }
  return allOk;
}

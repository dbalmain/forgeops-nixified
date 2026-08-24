import { lookup } from "node:dns/promises";
import { capture, has } from "../lib/proc.ts";
import { fail, heading, ok, warn } from "../lib/ui.ts";
import type { ResolvedConfig } from "../config.ts";

type Check = { name: string; run: () => Promise<string | true> };

const REQUIRED_TOOLS = ["docker", "k3d", "kubectl", "helm"];

export async function doctor(cfg: ResolvedConfig): Promise<boolean> {
  heading(`fo doctor  (env ${cfg.env}, fqdn ${cfg.fqdn})`);

  const checks: Check[] = [
    {
      name: "required tools on PATH",
      run: async () => {
        const missing = REQUIRED_TOOLS.filter((t) => !has(t));
        return missing.length === 0
          ? true
          : `missing: ${missing.join(", ")} - are you in the nix devShell? (direnv allow)`;
      },
    },
    {
      name: "docker daemon reachable",
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
        const busy: string[] = [];
        for (const p of [80, 443]) {
          const r = capture(
            "sh",
            ["-c", `ss -lnt 2>/dev/null | awk '$4 ~ /:${p}$/' | head -1`],
            { allowFailure: true },
          );
          if (r.stdout.trim()) busy.push(String(p));
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
        const r = capture("sh", ["-c", "free -m 2>/dev/null | awk '/^Mem:/{print $7}'"], {
          allowFailure: true,
        });
        const avail = Number(r.stdout.trim());
        if (!Number.isFinite(avail) || avail === 0) return true;
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
        if (!Number.isFinite(avail) || avail === 0) return true;
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
    else {
      // Resolution and headroom are advisory; tools and docker are fatal.
      const fatal = c.name.includes("tools") || c.name.includes("docker daemon");
      if (fatal) {
        fail(`${c.name}: ${r}`);
        allOk = false;
      } else {
        warn(`${c.name}: ${r}`);
      }
    }
  }
  return allOk;
}

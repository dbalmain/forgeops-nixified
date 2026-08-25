import { loadConfig, RELEASE } from "./config.ts";
import { bold, die, dim } from "./lib/ui.ts";
import { doctor } from "./commands/doctor.ts";
import { up } from "./commands/up.ts";
import { down } from "./commands/down.ts";
import { status } from "./commands/status.ts";
import { info } from "./commands/info.ts";
import { logs } from "./commands/logs.ts";
import { shell } from "./commands/shell.ts";
import { syncIdm } from "./commands/sync.ts";
import { token } from "./commands/token.ts";
import { runAmster } from "./commands/amster.ts";
import { restart } from "./commands/restart.ts";
import { watchLoop } from "./commands/watch.ts";
import { dev } from "./commands/dev.ts";
import { build, check } from "./commands/build.ts";
import { deps } from "./commands/deps.ts";

const USAGE = `
${bold("fo")} - local Ping Identity Platform stack (ForgeOps ${RELEASE.forgeops}, platform ${RELEASE.productVersion})

  fo up [--env NAME] [--timeout SECONDS]   bring the stack up (idempotent)
  fo down [--env NAME] [--destroy]         remove the env; --destroy kills the cluster
  fo status [--env NAME]                   pod readiness
  fo info [--env NAME] [--json]            URLs and passwords
  fo logs [COMPONENT] [--env NAME] [...]   live tail (extra args go to stern)
  fo shell COMPONENT [-- CMD...]           exec into a component's pod
  fo doctor [--env NAME]                   preflight checks
  fo token [--env NAME]                    OAuth2 access token for IDM REST

${bold("Inner loop")}
  fo dev [--env NAME] [--no-tilt]          live session: watch and apply changes
  fo watch [--env NAME]                    the same loop without Tilt
  fo sync [conf|script]                    tier 1: push IDM config into the pod   <1s
  fo amster [--env NAME]                   tier 2: re-import amster config       ~60s
  fo restart COMPONENT                     tier 3: roll a component             ~2min

${bold("TypeScript")}
  fo build [--env NAME]                    compile platform/typescript -> idm/
  fo check [--env NAME]                    types, lint, tests, build
  fo deps                                  re-lock platform/typescript deps

${dim("COMPONENT is one of: am idm ds-idrepo ds-cts amster admin-ui end-user-ui login-ui")}
${dim("--env defaults to `dev`; every env is a namespace in one shared k3d cluster.")}
`;

type Flags = {
  env?: string;
  json: boolean;
  destroy: boolean;
  noTilt: boolean;
  timeout: number;
  rest: string[];
  passthrough: string[];
};

function parse(argv: string[]): Flags {
  const f: Flags = {
    json: false,
    destroy: false,
    noTilt: false,
    timeout: 900,
    rest: [],
    passthrough: [],
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      f.passthrough = argv.slice(i + 1);
      break;
    } else if (a === "--env" || a === "-e") {
      f.env = argv[++i];
    } else if (a.startsWith("--env=")) {
      f.env = a.slice(6);
    } else if (a === "--json") {
      f.json = true;
    } else if (a === "--destroy") {
      f.destroy = true;
    } else if (a === "--no-tilt") {
      f.noTilt = true;
    } else if (a === "--timeout") {
      f.timeout = Number(argv[++i]);
    } else {
      f.rest.push(a);
    }
  }
  return f;
}

async function main(): Promise<void> {
  // Flags are parsed from the WHOLE argv, not just after the subcommand, so
  // `fo --env dev sync conf` and `fo sync conf --env dev` are both valid. The
  // first non-flag token is the command. (Tilt writes the former shape
  // naturally, and an earlier version of this parser rejected it.)
  const flags = parse(process.argv.slice(2));
  const command = flags.rest[0];
  const args = flags.rest.slice(1);

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }

  const cfg = await loadConfig(flags.env);

  switch (command) {
    case "up":
      await up(cfg, { timeoutSeconds: flags.timeout });
      break;
    case "down":
      await down(cfg, { destroy: flags.destroy });
      break;
    case "status":
      status(cfg);
      break;
    case "info":
      info(cfg, flags.json);
      break;
    case "doctor": {
      const okAll = await doctor(cfg);
      if (!okAll) process.exitCode = 1;
      break;
    }
    case "dev":
      await dev(cfg, { noTilt: flags.noTilt });
      break;
    case "watch":
      await watchLoop(cfg);
      break;
    case "sync": {
      const only = args[0];
      if (only && only !== "conf" && only !== "script") {
        die(`fo sync takes "conf" or "script", not "${only}"`);
      }
      syncIdm(cfg, only as "conf" | "script" | undefined);
      break;
    }
    case "build":
      await build(cfg);
      break;
    case "check":
      await check(cfg);
      break;
    case "deps":
      await deps(cfg);
      break;
    case "amster":
      await runAmster(cfg, { timeoutSeconds: flags.timeout });
      break;
    case "restart": {
      const component = args[0];
      if (!component) die("fo restart needs a component");
      await restart(cfg, component);
      break;
    }
    case "token":
      await token(cfg);
      break;
    case "logs":
      await logs(cfg, args[0], args.slice(1));
      break;
    case "shell": {
      const component = args[0];
      if (!component) die("fo shell needs a component");
      await shell(cfg, component, flags.passthrough);
      break;
    }
    default:
      console.log(USAGE);
      die(`unknown command "${command}"`);
  }
}

main().catch((e: unknown) => {
  die(e instanceof Error ? e.message : String(e));
});

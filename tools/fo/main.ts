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
import { add, list, remove } from "./commands/pkg.ts";
import {
  configDiff,
  configExport,
  EXPORT_COMPONENTS,
  type ExportComponent,
} from "./commands/config.ts";
import { upgrade } from "./commands/upgrade.ts";

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
  fo sync [conf|script|data]               tier 1: push IDM config into the pod   <1s
  fo amster [--env NAME]                   tier 2: re-import amster config       ~60s
  fo restart COMPONENT                     tier 3: roll a component             ~2min

${bold("TypeScript")}
  fo build [--env NAME]                    compile platform/typescript -> idm/
  fo check [--env NAME]                    types, lint, tests, build
  fo deps                                  re-lock platform/typescript deps

${bold("Round-trip and upgrade")}
  fo config export am|idm                  live config -> platform/, minus the stock defaults
  fo config diff [am|idm]                  what the live stack has that the repo does not
  fo upgrade [--check]                     bump forgeops-src; verify the chart and every image

${bold("Packages")}
  fo list                                  installed and available examples
  fo add NAME [--force]                    install an example into platform/
  fo remove NAME                           uninstall it, keeping anything you edited

${dim("COMPONENT is one of: am idm ds-idrepo ds-cts amster admin-ui end-user-ui login-ui")}
${dim("--env defaults to `dev`; every env is a namespace in one shared k3d cluster.")}
`;

type Flags = {
  // `| undefined` explicitly, not just `?`: exactOptionalPropertyTypes means
  // an optional property may be ABSENT but not assigned undefined, and
  // `--env` with nothing after it assigns exactly that.
  env?: string | undefined;
  json: boolean;
  destroy: boolean;
  noTilt: boolean;
  force: boolean;
  check: boolean;
  noUpgrade: boolean;
  timeout: number;
  rest: string[];
  passthrough: string[];
};

function parse(argv: string[]): Flags {
  const f: Flags = {
    json: false,
    destroy: false,
    noTilt: false,
    force: false,
    check: false,
    noUpgrade: false,
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
    } else if (a === "--force") {
      f.force = true;
    } else if (a === "--check") {
      f.check = true;
    } else if (a === "--no-upgrade") {
      f.noUpgrade = true;
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
      if (only && !["conf", "script", "data"].includes(only)) {
        die(`fo sync takes "conf", "script" or "data", not "${only}"`);
      }
      syncIdm(cfg, only as "conf" | "script" | "data" | undefined);
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
    case "add":
      add(cfg, args[0], { force: flags.force });
      break;
    case "list":
      list(cfg);
      break;
    case "remove":
      remove(cfg, args[0]);
      break;
    case "config": {
      const action = args[0];
      const rest = args.slice(1);
      const parseComponent = (name: string | undefined): ExportComponent => {
        if (name !== "am" && name !== "idm") {
          die(`fo config ${action} takes "am" or "idm", not "${name ?? ""}"`);
        }
        return name;
      };
      if (action === "export") {
        configExport(cfg, parseComponent(rest[0]), { upgrade: !flags.noUpgrade });
      } else if (action === "diff") {
        const which = rest[0] ? [parseComponent(rest[0])] : EXPORT_COMPONENTS;
        if (!configDiff(cfg, which, { upgrade: !flags.noUpgrade })) process.exitCode = 1;
      } else {
        die(`fo config takes "export" or "diff", not "${action ?? ""}"`);
      }
      break;
    }
    case "upgrade": {
      const clean = await upgrade(cfg, { check: flags.check });
      if (!clean) process.exitCode = 1;
      break;
    }
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

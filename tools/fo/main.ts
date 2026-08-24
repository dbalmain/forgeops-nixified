import { loadConfig, RELEASE } from "./config.ts";
import { bold, die, dim } from "./lib/ui.ts";
import { doctor } from "./commands/doctor.ts";
import { up } from "./commands/up.ts";
import { down } from "./commands/down.ts";
import { status } from "./commands/status.ts";
import { info } from "./commands/info.ts";
import { logs } from "./commands/logs.ts";
import { shell } from "./commands/shell.ts";

const USAGE = `
${bold("fo")} - local Ping Identity Platform stack (ForgeOps ${RELEASE.forgeops}, platform ${RELEASE.productVersion})

  fo up [--env NAME] [--timeout SECONDS]   bring the stack up (idempotent)
  fo down [--env NAME] [--destroy]         remove the env; --destroy kills the cluster
  fo status [--env NAME]                   pod readiness
  fo info [--env NAME] [--json]            URLs and passwords
  fo logs [COMPONENT] [--env NAME] [...]   live tail (extra args go to stern)
  fo shell COMPONENT [-- CMD...]           exec into a component's pod
  fo doctor [--env NAME]                   preflight checks

${dim("COMPONENT is one of: am idm ds-idrepo ds-cts amster admin-ui end-user-ui login-ui")}
${dim("--env defaults to `dev`; every env is a namespace in one shared k3d cluster.")}
`;

type Flags = {
  env?: string;
  json: boolean;
  destroy: boolean;
  timeout: number;
  rest: string[];
  passthrough: string[];
};

function parse(argv: string[]): Flags {
  const f: Flags = {
    json: false,
    destroy: false,
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
    } else if (a === "--timeout") {
      f.timeout = Number(argv[++i]);
    } else {
      f.rest.push(a);
    }
  }
  return f;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }

  const flags = parse(argv.slice(1));
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
    case "logs":
      await logs(cfg, flags.rest[0], flags.rest.slice(1));
      break;
    case "shell": {
      const component = flags.rest[0];
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

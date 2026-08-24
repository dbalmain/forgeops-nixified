import { spawnSync, spawn } from "node:child_process";

export type RunOptions = {
  /** Extra environment for the child. Merged over process.env. */
  env?: Record<string, string>;
  /** Feed this to the child's stdin. */
  input?: string;
  /** Don't throw on a non-zero exit; return it instead. */
  allowFailure?: boolean;
  cwd?: string;
};

export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * Run a command and capture its output. Throws on failure unless
 * `allowFailure` is set, because a silently-ignored kubectl error is how you
 * end up debugging the wrong thing ten minutes later.
 */
export function capture(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  const res = {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
  if (res.code !== 0 && !opts.allowFailure) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${res.code}\n${res.stderr || res.stdout}`,
    );
  }
  return res;
}

/** Run a command with its output streamed straight through to the terminal. */
export function stream(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const c = code ?? -1;
      if (c !== 0 && !opts.allowFailure) {
        reject(new Error(`${cmd} ${args.join(" ")} exited ${c}`));
      } else {
        resolve(c);
      }
    });
  });
}

/** True if the command exists on PATH. */
export function has(cmd: string): boolean {
  return (
    capture("sh", ["-c", `command -v ${cmd}`], { allowFailure: true }).code === 0
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

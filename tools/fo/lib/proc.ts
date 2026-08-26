import { spawnSync, spawn } from "node:child_process";

export type RunOptions = {
  /** Extra environment for the child. Merged over process.env. */
  env?: Record<string, string>;
  /** Feed this to the child's stdin. */
  input?: string;
  /**
   * Don't throw on a non-zero exit; return it instead.
   *
   * READ THIS BEFORE REACHING FOR IT. It accepts EVERY failure, and the
   * recurring bug in this CLI has been exactly that -- a tool that could not
   * run becoming a confident negative. A dead Docker daemon became "no
   * cluster" and `fo down --destroy` deleted live state. An unreadable API
   * server became "no pods" and `fo up` reported a stack that was not serving.
   * An unreachable cluster became "no IDM pod" and `fo sync` exited zero. A
   * missing `ss` became "ports free".
   *
   * Before using it, check which question you are actually asking:
   *
   *   - A LIST query (`get pods -l ...`) exits ZERO with empty output when
   *     nothing matches. There is no failure to allow; do not pass this.
   *   - A NAMED GET for something that may not exist wants
   *     `--ignore-not-found` (see `getOptional` in lib/k8s.ts), which makes
   *     absence exit zero and leaves real failures failing.
   *   - BEST-EFFORT work belongs here: fetching a crash log to print, tearing
   *     down a probe, a capability sniff. Nothing downstream believes the
   *     answer.
   *   - So does EXPLICIT CLASSIFICATION -- taking the result back and deciding
   *     from `code`/`stderr` which failure this is. `clusterExists` does that
   *     (k3d says "no clusters" and "Docker is unreachable" with the same exit
   *     code, so only the message separates them) and so does `getPods`. What
   *     is NOT allowed is taking the result and ignoring it, which is how all
   *     three defects above happened.
   */
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

/**
 * Same as `capture`, but async, so independent calls can overlap.
 *
 * Used for the registry probes in `fo upgrade`: fourteen sequential
 * `docker manifest inspect` calls take minutes, and they have no reason to
 * wait for each other.
 */
export function captureAsync(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const res = { code: code ?? -1, stdout, stderr };
      if (res.code !== 0 && !opts.allowFailure) {
        reject(new Error(`${cmd} ${args.join(" ")} exited ${res.code}\n${stderr || stdout}`));
      } else {
        resolve(res);
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

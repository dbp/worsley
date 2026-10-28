import { spawn } from "node:child_process";

export interface CommandResult {
  /** Null when the command was killed. */
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Output was dropped from the middle to keep it to `maxChars`. */
  truncated: boolean;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** How much output is kept: the start and, mostly, the end. */
  maxChars?: number;
}

/**
 * Runs `command` in a shell, with stdout and stderr together in the order
 * they came, and nothing on stdin. It runs in a process group of its own so
 * that stopping it (on timeout or abort) also stops what it started, such as
 * test workers. `CI` and `NO_COLOR` keep test runners from waiting for
 * input or colouring their output.
 */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const maxChars = options.maxChars ?? 200_000;
  const headChars = Math.floor(maxChars / 8);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
    });
    let head = "";
    let tail = "";
    let dropped = 0;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const take = (chunk: Buffer): void => {
      let text = chunk.toString("utf8");
      if (head.length < headChars) {
        const room = headChars - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      tail += text;
      const over = tail.length - (maxChars - headChars);
      if (over > 0) {
        tail = tail.slice(over);
        dropped += over;
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    const stop = (): void => {
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 3000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      options.signal.removeEventListener("abort", onAbort);
      const output = stripAnsi(dropped > 0 ? `${head}\n… [${dropped} characters of output dropped] …\n${tail}` : head + tail);
      resolve({
        exitCode: code,
        output,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        truncated: dropped > 0,
      });
    });
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // Already gone.
  }
}

/** Colour and cursor escapes, which some tools print even when asked not to. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/**
 * Output cut down for the model: the start, where a command says what it is
 * doing, and more of the end, where test runners put failures and totals.
 */
export function clipOutput(output: string, maxChars = 16_000): string {
  if (output.length <= maxChars) {
    return output;
  }
  const head = Math.floor(maxChars / 5);
  const tail = maxChars - head;
  return `${output.slice(0, head)}\n… [${output.length - maxChars} characters omitted] …\n${output.slice(-tail)}`;
}

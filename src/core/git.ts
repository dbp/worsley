import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { FileChange } from "../protocol";

/**
 * Read-only git: Worsley never stages, commits or changes branches. Changes
 * are reviewed and kept (or thrown away) with git by the user.
 */

interface GitResult {
  code: number;
  stdout: string;
}

export function git(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
      resolve({ code, stdout });
    });
  });
}

export async function isGitRepo(root: string): Promise<boolean> {
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

/**
 * The uncommitted changes in `root`, file by file, or undefined outside a
 * repository: what each tracked file gained and lost since the last commit,
 * staged or not, and each new file that git doesn't ignore, counted whole.
 * `root` may be a folder inside the repository: only its files count, with
 * paths relative to it.
 */
export async function uncommittedChanges(root: string): Promise<FileChange[] | undefined> {
  if (!(await isGitRepo(root))) {
    return undefined;
  }
  const numstat = ["diff", "--numstat", "-z", "--no-renames", "--relative"];
  // Before the first commit there is only the index to compare with.
  const committed = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  const changes = new Map<string, FileChange>();
  for (const args of committed ? [[...numstat, "HEAD"]] : [[...numstat, "--cached"], numstat]) {
    for (const change of parseNumstat((await git(root, args)).stdout)) {
      const known = changes.get(change.path);
      if (known === undefined) {
        changes.set(change.path, change);
      } else {
        // Both staged and not, before the first commit.
        const [a, b] = [known.lines, change.lines];
        known.lines = a !== undefined && b !== undefined ? { added: a.added + b.added, removed: a.removed + b.removed } : undefined;
      }
    }
  }
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of untracked.stdout.split("\0").filter((f) => f !== "")) {
    const added = await countLines(path.join(root, file));
    changes.set(file, { path: file, untracked: true, lines: added === undefined ? undefined : { added, removed: 0 } });
  }
  return [...changes.values()];
}

/**
 * The uncommitted changes in `root`, or in its `file` alone, as a diff, or
 * undefined outside a repository: what tracked files changed since the last
 * commit, staged or not, then each new file that git doesn't ignore, whole.
 * Paths are relative to `root`, as in `uncommittedChanges`.
 */
export async function uncommittedDiff(root: string, file?: string): Promise<string | undefined> {
  if (!(await isGitRepo(root))) {
    return undefined;
  }
  const only = file !== undefined ? ["--", file] : [];
  const diff = ["diff", "--no-color", "--no-ext-diff", "--relative"];
  const committed = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  const parts: string[] = [];
  for (const args of committed ? [[...diff, "HEAD"]] : [[...diff, "--cached"], diff]) {
    parts.push((await git(root, [...args, ...only])).stdout);
  }
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...only]);
  for (const newFile of untracked.stdout.split("\0").filter((f) => f !== "")) {
    // Against nothing, which leaves the index alone.
    parts.push((await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", newFile])).stdout);
  }
  return parts.join("");
}

/** `git diff --numstat -z`: lines added, lines removed and the path, with `-` for a binary file. */
export function parseNumstat(text: string): FileChange[] {
  return text.split("\0").flatMap((entry) => {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
    if (match === null) {
      return [];
    }
    const [, added = "-", removed = "-", file = ""] = match;
    const lines = added === "-" || removed === "-" ? undefined : { added: Number(added), removed: Number(removed) };
    return [{ path: file, untracked: false, lines }];
  });
}

/** The lines of a new file, unless it is binary or too big to read for this. */
async function countLines(file: string): Promise<number | undefined> {
  try {
    if ((await stat(file)).size > 8 * 1024 * 1024) {
      return undefined;
    }
    const data = await readFile(file);
    if (data.subarray(0, 8000).includes(0)) {
      return undefined;
    }
    const breaks = data.reduce((n, byte) => (byte === 0x0a ? n + 1 : n), 0);
    return data.length > 0 && data[data.length - 1] !== 0x0a ? breaks + 1 : breaks;
  } catch {
    return undefined;
  }
}

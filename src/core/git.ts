import { execFile } from "node:child_process";

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
 * Files in `root` with uncommitted changes, relative to `root`, or undefined
 * outside a repository. `root` may be a folder inside the repository; git
 * reports paths from the repository's top, so its prefix is taken off.
 */
export async function uncommittedFiles(root: string): Promise<string[] | undefined> {
  const prefixResult = await git(root, ["rev-parse", "--show-prefix"]);
  if (prefixResult.code !== 0) {
    return undefined;
  }
  const prefix = prefixResult.stdout.trim();
  const result = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (result.code !== 0) {
    return undefined;
  }
  const files: string[] = [];
  const fields = result.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry.length < 4) {
      continue;
    }
    const path = entry.slice(3);
    if (path.startsWith(prefix)) {
      files.push(path.slice(prefix.length));
    }
    // A rename's original path follows as its own field.
    if (entry[0] === "R" || entry[0] === "C") {
      i++;
    }
  }
  return files;
}

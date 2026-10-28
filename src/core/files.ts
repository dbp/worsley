import * as fs from "node:fs/promises";
import * as path from "node:path";
import { git } from "./git";

/** Folders a walk skips, for a workspace that isn't a git repository and so has no .gitignore to go by. */
const SKIPPED_FOLDERS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".cache",
  ".idea",
  ".vscode-test",
]);

const MAX_WALKED_FILES = 50_000;

/**
 * Every file in the workspace folder, relative with `/`, sorted. In a git
 * repository these are the files git tracks or would add, so .gitignore
 * applies; elsewhere, everything outside the usual dependency and build
 * folders.
 */
export async function listFiles(root: string): Promise<string[]> {
  const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed.code === 0) {
    const deleted = await git(root, ["ls-files", "-z", "--deleted"]);
    const gone = new Set(deleted.code === 0 ? deleted.stdout.split("\0") : []);
    return [...new Set(listed.stdout.split("\0"))].filter((file) => file !== "" && !gone.has(file)).sort();
  }
  return walk(root);
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_WALKED_FILES) {
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) {
          await visit(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        }
      } else if (entry.isFile()) {
        files.push(prefix + entry.name);
      }
    }
  }
  await visit(root, "");
  return files.sort();
}

/** A file's lines, without the empty one after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

const MAX_LINE_CHARS = 500;

/**
 * Lines `start` to `end` (1-based, inclusive) with their numbers, as the
 * model reads them: `  12\tcode`. Very long lines are cut short.
 */
export function numberLines(lines: readonly string[], start: number, end: number): string {
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end && n <= lines.length; n++) {
    let line = lines[n - 1] ?? "";
    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more characters]`;
    }
    out.push(`${String(n).padStart(width)}\t${line}`);
  }
  return out.join("\n");
}

export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\u0000");
}

/**
 * The workspace's files for the system prompt: every path when there are
 * few enough, otherwise folders with their file counts, as deep as `budget`
 * lines allow.
 */
export function summarizeFiles(paths: readonly string[], budget = 250): string {
  if (paths.length <= budget) {
    return paths.join("\n");
  }
  let best: string[] | undefined;
  for (let depth = 1; depth <= 6; depth++) {
    const lines = collapse(paths, depth);
    if (lines.length > budget) {
      break;
    }
    best = lines;
  }
  best ??= collapse(paths, 1).slice(0, budget);
  return `${best.join("\n")}\n(${paths.length} files in all; folders show how many files are inside.)`;
}

/** Paths at most `depth` names deep as they are; deeper ones folded into `folder/ (N files)`. */
function collapse(paths: readonly string[], depth: number): string[] {
  const counts = new Map<string, number>();
  const lines: string[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length <= depth) {
      lines.push(p);
    } else {
      const folder = `${parts.slice(0, depth).join("/")}/`;
      if (!counts.has(folder)) {
        lines.push(folder);
      }
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return lines.map((line) => {
    const count = counts.get(line);
    return count === undefined ? line : `${line} (${count} file${count === 1 ? "" : "s"})`;
  });
}

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { compileGlob } from "./glob";
import { looksBinary, splitLines } from "./files";
import { absolutePath } from "./paths";

export interface SearchQuery {
  pattern: string;
  /** The pattern is plain text rather than a regular expression. */
  literal: boolean;
  /** Undefined: case-insensitive unless the pattern has a capital letter, as ripgrep's `--smart-case`. */
  caseSensitive?: boolean;
  glob?: string;
  limit: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** More matched than `limit`. */
  truncated: boolean;
}

/** Bigger files are skipped by the search that runs without ripgrep. */
const MAX_SEARCHED_BYTES = 2 * 1024 * 1024;

/**
 * Searches the workspace's files: with ripgrep when there is one (VS Code
 * bundles it), otherwise by reading `files` one by one. Both give the same
 * results for the patterns models write; ripgrep is just faster.
 */
export async function search(
  root: string,
  query: SearchQuery,
  files: () => Promise<string[]>,
  ripgrep: string | undefined,
  signal: AbortSignal,
): Promise<SearchResult> {
  if (ripgrep !== undefined) {
    return searchWithRipgrep(root, query, ripgrep, signal);
  }
  return searchInProcess(root, query, await files(), signal);
}

function smartCase(query: SearchQuery): boolean {
  return query.caseSensitive ?? /[A-Z]/.test(query.pattern);
}

function searchWithRipgrep(root: string, query: SearchQuery, ripgrep: string, signal: AbortSignal): Promise<SearchResult> {
  const args = [
    "--json",
    "--no-config",
    "--hidden",
    "--no-require-git",
    "--max-columns",
    "400",
    "--max-columns-preview",
    "--glob",
    "!.git",
    smartCase(query) ? "--case-sensitive" : "--ignore-case",
  ];
  if (query.literal) {
    args.push("--fixed-strings");
  }
  if (query.glob !== undefined && query.glob !== "") {
    args.push("--glob", query.glob);
  }
  args.push("--regexp", query.pattern, "--", ".");

  return new Promise((resolve, reject) => {
    const child = spawn(ripgrep, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], signal });
    const matches: SearchMatch[] = [];
    let truncated = false;
    let pending = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const match = parseRipgrepLine(line);
        if (match === undefined) {
          continue;
        }
        if (matches.length >= query.limit) {
          truncated = true;
          child.kill();
          return;
        }
        matches.push(match);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      // 1 is "no matches"; 2 with matches is an unreadable file along the way.
      if (code === 2 && matches.length === 0 && !truncated) {
        reject(new Error(stderr.trim().split("\n")[0] || "ripgrep failed"));
        return;
      }
      matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
      resolve({ matches, truncated });
    });
  });
}

function parseRipgrepLine(line: string): SearchMatch | undefined {
  let message: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  const data = message.data;
  if (message.type !== "match" || typeof data?.path?.text !== "string" || typeof data.line_number !== "number") {
    return undefined;
  }
  const path = data.path.text.replace(/^\.\//, "");
  return { path, line: data.line_number, text: (data.lines?.text ?? "").replace(/\r?\n$/, "") };
}

async function searchInProcess(root: string, query: SearchQuery, files: string[], signal: AbortSignal): Promise<SearchResult> {
  const source = query.literal ? query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : query.pattern;
  const regex = new RegExp(source, smartCase(query) ? "" : "i");
  const glob = query.glob !== undefined && query.glob !== "" ? compileGlob(query.glob) : undefined;
  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (glob !== undefined && !glob.test(file)) {
      continue;
    }
    let text: string;
    try {
      const full = absolutePath(root, file);
      const stat = await fs.stat(full);
      if (stat.size > MAX_SEARCHED_BYTES) {
        continue;
      }
      text = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    if (looksBinary(text)) {
      continue;
    }
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        if (matches.length >= query.limit) {
          return { matches, truncated: true };
        }
        matches.push({ path: file, line: i + 1, text: line.length > 400 ? `${line.slice(0, 400)}…` : line });
      }
    }
  }
  return { matches, truncated: false };
}

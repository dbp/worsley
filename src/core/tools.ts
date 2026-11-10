import type { Approval, ChangedFile, Mode, ToolIcon } from "../protocol";
import type { ToolSpec } from "./chat";
import { replaceText, withoutLineNumbers } from "./edit";
import { errorText } from "./errorText";
import { looksBinary, numberLines, splitLines } from "./files";
import { compileGlob } from "./glob";
import { formatHref, labelRef, resolvePath } from "./links";
import { workspacePath } from "./paths";
import { search } from "./search";
import { clipOutput, runCommand } from "./shell";

/** Lines, 1-based and inclusive, in a file relative to the workspace folder. */
export interface CodeLocation {
  path: string;
  start: number;
  end: number;
}

export interface OutlineEntry {
  name: string;
  kind: string;
  start: number;
  end: number;
  children: OutlineEntry[];
}

/**
 * The workspace as the tools see it. Paths are relative to `root` with `/`
 * between folders. The editor's implementation reads unsaved changes and
 * asks the language servers; the tests' reads and writes the disk.
 */
export interface Workspace {
  readonly root: string;
  /** ripgrep's binary, if there is one; otherwise search reads the files itself. */
  readonly ripgrep: string | undefined;
  listFiles(): Promise<string[]>;
  exists(path: string): Promise<"file" | "folder" | undefined>;
  /** The text the user sees: an open editor's, if it has unsaved changes. */
  readText(path: string): Promise<string>;
  /** Writes the file to disk, creating folders as needed. */
  writeText(path: string, text: string): Promise<void>;
  /** From the editor's language support; undefined where there is none. */
  outline?(path: string): Promise<OutlineEntry[] | undefined>;
  /** Locations outside the workspace have absolute paths. */
  references?(path: string, line: number, character: number): Promise<CodeLocation[] | undefined>;
  definitions?(path: string, line: number, character: number): Promise<CodeLocation[] | undefined>;
}

export interface Place extends CodeLocation {
  note: string;
}

export interface TourStep extends CodeLocation {
  title: string;
  /** What the step will explain, from when the tour was planned. */
  summary: string;
}

/** A tour of how the codebase is put together, or a walk through something in the order it happens. */
export type TourKind = "structure" | "walkthrough";

export interface TourPlan {
  title: string;
  kind: TourKind;
  steps: TourStep[];
}

/** What the tools need from the panel. */
export interface ToolUi {
  showLocations(title: string, places: Place[]): Promise<void>;
  presentTour(plan: TourPlan): void;
  /** The user's decision; with "always", the panel remembers what they allowed. */
  approveCommand(command: string, signal: AbortSignal): Promise<Approval>;
}

export interface ToolContext {
  workspace: Workspace;
  ui: ToolUi;
  mode: Mode;
  signal: AbortSignal;
  commandTimeoutMs: number;
  /** The test command, and commands the user said to always allow, run without asking. */
  preapproved(command: string): boolean;
  /** Files the model has read or written in this thread; write_file replaces only these. */
  seen: Set<string>;
}

/** How a call shows in the panel. */
export interface ToolDisplay {
  icon: ToolIcon;
  summary: string;
  href?: string;
  detail?: string;
  diffPath?: string;
  failed?: boolean;
  /** Its result shows some other way, as a list of locations or the tour. */
  hidden?: boolean;
  changed?: ChangedFile;
}

export interface ToolOutcome {
  /** What the model is told. */
  content: string;
  display: ToolDisplay;
}

export interface Tool {
  spec: ToolSpec;
  /** Called in another mode, the tool is refused with `refusal`. */
  modes: readonly Mode[];
  refusal?: string;
  /** How the call shows while it runs. */
  describe(args: Args): ToolDisplay;
  run(args: Args, ctx: ToolContext): Promise<ToolOutcome>;
}

export type Args = Record<string, unknown>;

/** A mistake the model can fix: its message is what the model is told. */
export class ToolError extends Error {}

const BOTH: readonly Mode[] = ["ask", "change"];
const CHANGE: readonly Mode[] = ["change"];
const MAX_LISTED = 400;
const MAX_READ_LINES = 500;
const MAX_REFERENCES = 200;

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

function text(args: Args, name: string): string {
  const value = args[name];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new ToolError(`${name} is required, as a string.`);
}

function optionalText(args: Args, name: string): string | undefined {
  const value = args[name];
  return value === undefined || value === null || value === "" ? undefined : text(args, name);
}

function integer(args: Args, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new ToolError(`${name} must be a whole number.`);
  }
  return n;
}

function flag(args: Args, name: string): boolean {
  const value = args[name];
  return value === true || value === "true";
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function quote(s: string): string {
  return `“${s.length > 60 ? `${s.slice(0, 60)}…` : s}”`;
}

/**
 * The file a path from the model names. A path that isn't a file but ends
 * one file's path (`parser.py` for `src/app/parser.py`) is taken as that
 * file.
 */
async function locate(ctx: ToolContext, given: string): Promise<string> {
  const ws = ctx.workspace;
  const relative = workspacePath(ws.root, given);
  if (relative === undefined) {
    throw new ToolError(`${JSON.stringify(given)} isn't a path inside the workspace folder.`);
  }
  const kind = await ws.exists(relative);
  if (kind === "file") {
    return relative;
  }
  if (kind === "folder") {
    throw new ToolError(`${relative} is a folder. Use list_files with the glob "${relative}/**" to see what is in it.`);
  }
  const found = resolvePath(relative, given, new Set(await ws.listFiles()));
  if (found !== undefined) {
    return found;
  }
  throw new ToolError(`There is no file ${relative}. Use list_files or search to find the right path.`);
}

/** An entry of show_locations or present_tour, checked against the file. */
async function checkRange(ctx: ToolContext, entry: unknown): Promise<CodeLocation & { args: Args }> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ToolError("each entry must be an object with path, start_line and end_line.");
  }
  const args = entry as Args;
  const path = await locate(ctx, text(args, "path"));
  const lines = splitLines(await ctx.workspace.readText(path)).length;
  const start = integer(args, "start_line") ?? 1;
  const end = integer(args, "end_line") ?? start;
  if (start < 1 || start > lines) {
    throw new ToolError(`${path} has ${plural(lines, "line")}, so start_line ${start} isn't in it.`);
  }
  return { path, start, end: Math.min(Math.max(start, end), lines), args };
}

/** Where `symbol` is on `line`, or on a line near it, as the language servers count characters. */
function findSymbol(lines: readonly string[], line: number, symbol: string): { line: number; character: number } | undefined {
  const name = symbol.split(".").pop() ?? symbol;
  const pattern = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    const n = line + offset;
    const lineText = lines[n - 1];
    if (lineText === undefined) {
      continue;
    }
    const match = pattern.exec(lineText);
    if (match !== null) {
      return { line: n, character: match.index };
    }
  }
  return undefined;
}

/** `path:line: text` for each location, sorted, with the line's text where it can be read. */
async function describeLocations(ctx: ToolContext, locations: readonly CodeLocation[]): Promise<string[]> {
  const texts = new Map<string, string[] | undefined>();
  const sorted = [...locations].sort((a, b) => (a.path === b.path ? a.start - b.start : a.path < b.path ? -1 : 1));
  const out: string[] = [];
  for (const location of sorted) {
    if (location.path.startsWith("/")) {
      out.push(`${location.path}:${location.start} (outside the workspace)`);
      continue;
    }
    if (!texts.has(location.path)) {
      texts.set(location.path, await ctx.workspace.readText(location.path).then(splitLines, () => undefined));
    }
    const line = texts.get(location.path)?.[location.start - 1]?.trim() ?? "";
    out.push(`${location.path}:${location.start}: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
  }
  return out;
}

const listFiles: Tool = {
  spec: spec(
    "list_files",
    "List the workspace's files (ignored files are left out), optionally only those whose path matches a glob such as `src/**/*.py`, `*.md` or `tests/**`.",
    { glob: { type: "string", description: "A glob over paths relative to the workspace folder. A pattern without `/` matches file names in any folder." } },
    [],
  ),
  modes: BOTH,
  describe: (args) => ({ icon: "list", summary: `Listing files${typeof args.glob === "string" ? ` matching ${args.glob}` : ""}` }),
  async run(args, ctx) {
    const glob = optionalText(args, "glob");
    let files = await ctx.workspace.listFiles();
    if (glob !== undefined) {
      const pattern = compileGlob(glob);
      files = files.filter((file) => pattern.test(file));
    }
    let content = files.slice(0, MAX_LISTED).join("\n");
    if (files.length === 0) {
      content = glob !== undefined ? `No files match ${glob}.` : "The workspace has no files.";
    } else if (files.length > MAX_LISTED) {
      content += `\n… and ${files.length - MAX_LISTED} more. Use a narrower glob to see them.`;
    }
    return {
      content,
      display: { icon: "list", summary: `Listed ${plural(files.length, "file")}${glob !== undefined ? ` matching ${glob}` : ""}` },
    };
  },
};

const searchTool: Tool = {
  spec: spec(
    "search",
    "Search the contents of the workspace's files. `pattern` is a regular expression (ripgrep's syntax, like Rust's) unless `literal` is true. It is case-insensitive unless the pattern has a capital letter. Returns matching lines as `path:line: text`.",
    {
      pattern: { type: "string" },
      literal: { type: "boolean", description: "Match the pattern as plain text." },
      glob: { type: "string", description: "Only search files whose path matches this glob, such as `src/**/*.ts` or `*.py`." },
      limit: { type: "integer", description: "The most matching lines to return; 100 if not given." },
    },
    ["pattern"],
  ),
  modes: BOTH,
  describe: (args) => ({ icon: "search", summary: `Searching for ${quote(String(args.pattern ?? ""))}` }),
  async run(args, ctx) {
    const pattern = text(args, "pattern");
    const glob = optionalText(args, "glob");
    const limit = Math.min(500, Math.max(1, integer(args, "limit") ?? 100));
    const query = { pattern, literal: flag(args, "literal"), glob, limit };
    let result;
    try {
      result = await search(ctx.workspace.root, query, () => ctx.workspace.listFiles(), ctx.workspace.ripgrep, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) {
        throw err;
      }
      throw new ToolError(`The search failed: ${errorText(err)}. If the pattern isn't a valid regular expression, escape it or set literal.`);
    }
    const lines = result.matches.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`);
    const fileCount = new Set(result.matches.map((m) => m.path)).size;
    let content = lines.join("\n");
    if (lines.length === 0) {
      content = `No matches for ${JSON.stringify(pattern)}${glob !== undefined ? ` in ${glob}` : ""}.`;
    } else if (result.truncated) {
      content += `\n(Stopped at ${limit} matches. Narrow the pattern or the glob, or raise limit.)`;
    }
    const found = lines.length === 0 ? "no matches" : `${plural(lines.length, "match", "matches")}${result.truncated ? "+" : ""} in ${plural(fileCount, "file")}`;
    return {
      content,
      display: {
        icon: "search",
        summary: `Searched for ${quote(pattern)}${glob !== undefined ? ` in ${glob}` : ""}: ${found}`,
        detail: lines.length > 0 ? lines.slice(0, 200).join("\n") : undefined,
      },
    };
  },
};

const readFile: Tool = {
  spec: spec(
    "read_file",
    `Read a file, with line numbers. Find the part you need first, with search or outline, and read just those lines with start_line and end_line (1-based, inclusive); read a whole file only when you need all of it. At most ${MAX_READ_LINES} lines come back at once.`,
    {
      path: { type: "string" },
      start_line: { type: "integer" },
      end_line: { type: "integer" },
    },
    ["path"],
  ),
  modes: BOTH,
  describe: (args) => ({ icon: "read", summary: `Reading ${String(args.path ?? "")}` }),
  async run(args, ctx) {
    const path = await locate(ctx, text(args, "path"));
    const fileText = await ctx.workspace.readText(path);
    if (looksBinary(fileText)) {
      return { content: `${path} is a binary file.`, display: { icon: "read", summary: `${path} is binary`, failed: true } };
    }
    const lines = splitLines(fileText);
    const total = fileText === "" ? 0 : lines.length;
    ctx.seen.add(path);
    if (total === 0) {
      return { content: `${path} is empty.`, display: { icon: "read", summary: `Read ${path} (empty)`, href: path } };
    }
    const start = Math.min(Math.max(1, integer(args, "start_line") ?? 1), total);
    const asked = integer(args, "end_line") ?? total;
    const end = Math.max(start, Math.min(asked, total, start + MAX_READ_LINES - 1));
    let content = `${path}, lines ${start}-${end} of ${total}:\n${numberLines(lines, start, end)}`;
    if (end < Math.min(asked, total)) {
      content += `\n(Stopped at ${MAX_READ_LINES} lines; ${total - end} more follow. Read on from start_line ${end + 1}.)`;
    } else if (end < total && start === 1 && integer(args, "end_line") === undefined) {
      content += `\n(${total - end} more lines follow.)`;
    }
    const ref = { path, start, end };
    return { content, display: { icon: "read", summary: `Read ${labelRef(ref)}`, href: formatHref(ref) } };
  },
};

const outline: Tool = {
  spec: spec(
    "outline",
    "The functions, classes and other symbols a file defines, with their line ranges, from the editor's language support. Use it to find your way around a long file before reading parts of it.",
    { path: { type: "string" } },
    ["path"],
  ),
  modes: BOTH,
  describe: (args) => ({ icon: "outline", summary: `Outlining ${String(args.path ?? "")}` }),
  async run(args, ctx) {
    const path = await locate(ctx, text(args, "path"));
    const entries = await ctx.workspace.outline?.(path);
    if (entries === undefined || entries.length === 0) {
      return {
        content: `No outline for ${path}: the editor has no language support for it, or it defines nothing. Read it instead.`,
        display: { icon: "outline", summary: `No outline for ${path}`, href: path },
      };
    }
    const lines: string[] = [];
    const walk = (list: readonly OutlineEntry[], depth: number): void => {
      for (const entry of list) {
        if (lines.length >= 400) {
          return;
        }
        lines.push(`${"  ".repeat(depth)}${entry.kind} ${entry.name} (lines ${entry.start}-${entry.end})`);
        walk(entry.children, depth + 1);
      }
    };
    walk(entries, 0);
    return {
      content: `${path}:\n${lines.join("\n")}`,
      display: { icon: "outline", summary: `Outlined ${path}`, href: path, detail: lines.join("\n") },
    };
  },
};

function lookupTool(kind: "references" | "definitions"): Tool {
  const name = kind === "references" ? "find_references" : "find_definition";
  const description =
    kind === "references"
      ? "Every place a symbol is used, from the editor's language support, which knows scopes and imports, so it is more precise than search. Give a file and a line where the symbol appears (its definition or any use) and its name."
      : "Where a symbol is defined, from the editor's language support. Give a file and a line where the symbol is used, and its name.";
  return {
    spec: spec(
      name,
      description,
      {
        path: { type: "string" },
        line: { type: "integer", description: "A 1-based line on which the symbol appears." },
        symbol: { type: "string", description: "The name, as it is written there." },
      },
      ["path", "line", "symbol"],
    ),
    modes: BOTH,
    describe: (args) => ({
      icon: "references",
      summary: `Finding ${kind === "references" ? "references to" : "the definition of"} ${String(args.symbol ?? "")}`,
    }),
    async run(args, ctx) {
      const path = await locate(ctx, text(args, "path"));
      const symbol = text(args, "symbol");
      const line = integer(args, "line");
      if (line === undefined) {
        throw new ToolError("line is required.");
      }
      const lines = splitLines(await ctx.workspace.readText(path));
      const at = findSymbol(lines, line, symbol);
      if (at === undefined) {
        throw new ToolError(`${symbol} doesn't appear on line ${line} of ${path}, or near it. Give a line where it appears.`);
      }
      const lookup = kind === "references" ? ctx.workspace.references : ctx.workspace.definitions;
      const found = await lookup?.call(ctx.workspace, path, at.line, at.character);
      if (found === undefined) {
        return {
          content: `There is no language support for ${path}, so this can't be looked up; search for ${JSON.stringify(symbol)} instead.`,
          display: { icon: "references", summary: `No language support for ${path}`, failed: true },
        };
      }
      const what = kind === "references" ? `${plural(found.length, "reference")} to ${symbol}` : `${plural(found.length, "definition")} of ${symbol}`;
      const described = await describeLocations(ctx, found.slice(0, MAX_REFERENCES));
      let content = `${what}:\n${described.join("\n")}`;
      if (found.length > MAX_REFERENCES) {
        content += `\n… and ${found.length - MAX_REFERENCES} more.`;
      }
      return {
        content: found.length === 0 ? `No ${kind} of ${symbol} found.` : content,
        display: { icon: "references", summary: `Found ${what}`, detail: described.join("\n") },
      };
    },
  };
}

const locationItems = {
  type: "object",
  properties: {
    path: { type: "string" },
    start_line: { type: "integer" },
    end_line: { type: "integer" },
    note: { type: "string", description: "What is here, in a few words." },
  },
  required: ["path", "start_line", "end_line", "note"],
};

const showLocations: Tool = {
  spec: spec(
    "show_locations",
    "Show the user a list of places in the code, each with a short note, which they can click through and peek at in the editor. This is how to answer where something happens, what uses something, or what is involved: put every relevant place here, rather than listing places in your reply.",
    {
      title: { type: "string", description: "What the places have in common, such as “Where sessions expire”." },
      locations: { type: "array", items: locationItems },
    },
    ["title", "locations"],
  ),
  modes: BOTH,
  describe: () => ({ icon: "references", summary: "Showing locations", hidden: true }),
  async run(args, ctx) {
    const title = optionalText(args, "title") ?? "Locations";
    const raw = args.locations;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ToolError("locations must be a non-empty array of {path, start_line, end_line, note}.");
    }
    const places: Place[] = [];
    const problems: string[] = [];
    for (const [i, entry] of raw.entries()) {
      try {
        const { args: entryArgs, ...location } = await checkRange(ctx, entry);
        places.push({ ...location, note: optionalText(entryArgs, "note") ?? "" });
      } catch (err) {
        problems.push(`locations[${i}]: ${errorText(err)}`);
      }
    }
    if (places.length === 0) {
      throw new ToolError(`None of the locations could be shown:\n${problems.join("\n")}`);
    }
    await ctx.ui.showLocations(title, places);
    let content = `Shown to the user: ${plural(places.length, "location")}.`;
    if (problems.length > 0) {
      content += ` These were left out:\n${problems.join("\n")}`;
    }
    return { content, display: { icon: "references", summary: title, hidden: true } };
  },
};

const presentTour: Tool = {
  spec: spec(
    "present_tour",
    "Start a step-by-step tour of the code for the user. Each step opens a range of code in their editor, and you'll be asked to explain each step when they reach it. Order the steps so that each builds on the ones before.",
    {
      title: { type: "string", description: "What the tour covers." },
      kind: {
        type: "string",
        enum: ["structure", "walkthrough"],
        description: "structure: how the codebase is put together, through its components and what separates and connects them. walkthrough: a feature, a flow or a change, in the order it happens.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            start_line: { type: "integer" },
            end_line: { type: "integer" },
            title: { type: "string", description: "A few words, such as “Parsing the arguments”." },
            summary: { type: "string", description: "One sentence: what this step will explain." },
          },
          required: ["path", "start_line", "end_line", "title", "summary"],
        },
      },
    },
    ["title", "kind", "steps"],
  ),
  modes: ["ask"],
  refusal: "Tours are for ask requests. Finish the change, and summarize it with links.",
  describe: () => ({ icon: "outline", summary: "Planning a tour", hidden: true }),
  async run(args, ctx) {
    const title = text(args, "title");
    const kind = text(args, "kind");
    if (kind !== "structure" && kind !== "walkthrough") {
      throw new ToolError(`kind must be "structure" or "walkthrough", not "${kind}".`);
    }
    const raw = args.steps;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ToolError("steps must be a non-empty array of {path, start_line, end_line, title, summary}.");
    }
    const steps: TourStep[] = [];
    const problems: string[] = [];
    for (const [i, entry] of raw.entries()) {
      try {
        const { args: stepArgs, ...location } = await checkRange(ctx, entry);
        steps.push({ ...location, title: text(stepArgs, "title"), summary: optionalText(stepArgs, "summary") ?? "" });
      } catch (err) {
        problems.push(`steps[${i}]: ${errorText(err)}`);
      }
    }
    if (problems.length > 0) {
      throw new ToolError(`The tour wasn't shown, because some steps are wrong:\n${problems.join("\n")}\nFix them and call present_tour again.`);
    }
    ctx.ui.presentTour({ title, kind, steps });
    return {
      content: `The tour is open in the panel, with ${plural(steps.length, "step")}, and the user steps through it in the editor. You'll be asked to explain each step when they reach it, so don't explain the steps now: reply with one or two sentences that introduce the tour.`,
      display: { icon: "outline", summary: title, hidden: true },
    };
  },
};

const editFile: Tool = {
  spec: spec(
    "edit_file",
    "Replace text in a file. old_string must match the file's text exactly, including indentation, and occur once (or set replace_all). Include enough of the surrounding lines to make it unique, and don't include line numbers. Read the file first.",
    {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    ["path", "old_string", "new_string"],
  ),
  modes: CHANGE,
  refusal:
    "This is an ask request, so files can't change. Answer the question; if a change would help, describe it, and the user can ask for it in Change mode.",
  describe: (args) => ({ icon: "edit", summary: `Editing ${String(args.path ?? "")}` }),
  async run(args, ctx) {
    const path = await locate(ctx, text(args, "path"));
    const before = await ctx.workspace.readText(path);
    const oldString = text(args, "old_string");
    const newString = text(args, "new_string");
    const replaceAll = flag(args, "replace_all");
    let result = replaceText(before, oldString, newString, replaceAll);
    // Lines copied from read_file with their numbers still on.
    const bare = withoutLineNumbers(oldString);
    if (!result.ok && bare !== undefined) {
      const retry = replaceText(before, bare, withoutLineNumbers(newString) ?? newString, replaceAll);
      if (retry.ok) {
        result = retry;
      }
    }
    if (!result.ok) {
      throw new ToolError(`${path}: ${result.error}`);
    }
    await ctx.workspace.writeText(path, result.text);
    ctx.seen.add(path);
    const lines = splitLines(result.text);
    const from = Math.max(1, result.firstLine - 2);
    const to = Math.min(lines.length, result.lastLine + 2, from + 40);
    const ref = { path, start: result.firstLine, end: result.lastLine };
    return {
      content: `Edited ${path}${result.count > 1 ? ` in ${result.count} places` : ""}. Lines ${from}-${to} now read:\n${numberLines(lines, from, to)}`,
      display: {
        icon: "edit",
        summary: `Edited ${labelRef(ref)}${result.count > 1 ? ` and ${plural(result.count - 1, "other place")}` : ""}`,
        href: formatHref(ref),
        diffPath: path,
        changed: { path, created: false },
      },
    };
  },
};

const writeFile: Tool = {
  spec: spec(
    "write_file",
    "Create a file with `content`, or replace the whole of a file you have read. Folders are created as needed. To change part of an existing file, use edit_file.",
    {
      path: { type: "string" },
      content: { type: "string" },
    },
    ["path", "content"],
  ),
  modes: CHANGE,
  refusal: editFile.refusal,
  describe: (args) => ({ icon: "create", summary: `Writing ${String(args.path ?? "")}` }),
  async run(args, ctx) {
    const given = text(args, "path");
    const path = workspacePath(ctx.workspace.root, given);
    if (path === undefined) {
      throw new ToolError(`${JSON.stringify(given)} isn't a file path inside the workspace folder.`);
    }
    const content = text(args, "content");
    const kind = await ctx.workspace.exists(path);
    if (kind === "folder") {
      throw new ToolError(`${path} is a folder.`);
    }
    if (kind === "file" && !ctx.seen.has(path)) {
      throw new ToolError(`${path} already exists. Read it first, then change it with edit_file or replace it whole with write_file.`);
    }
    await ctx.workspace.writeText(path, content);
    ctx.seen.add(path);
    const created = kind === undefined;
    return {
      content: `${created ? "Created" : "Replaced"} ${path} (${plural(splitLines(content).length, "line")}).`,
      display: {
        icon: "create",
        summary: `${created ? "Created" : "Rewrote"} ${path}`,
        href: path,
        diffPath: path,
        changed: { path, created },
      },
    };
  },
};

const runCommandTool: Tool = {
  spec: spec(
    "run_command",
    "Run a shell command in the workspace folder, and get its exit code and output (stdout and stderr together; long output is cut to its start and end). Use it to run the tests and other checks. Any command but the configured test command needs the user's approval. Don't use it to read, search or edit files: the other tools do that.",
    { command: { type: "string" } },
    ["command"],
  ),
  modes: CHANGE,
  refusal: "Commands can't run for an ask request. Answer from the code instead.",
  describe: (args) => ({ icon: "run", summary: `Running ${String(args.command ?? "")}` }),
  async run(args, ctx) {
    const command = text(args, "command").trim();
    if (command === "") {
      throw new ToolError("command is empty.");
    }
    if (!ctx.preapproved(command)) {
      const decision = await ctx.ui.approveCommand(command, ctx.signal);
      if (decision === "deny") {
        return {
          content: "The user declined to run this command. Carry on without it, or ask them about it in your reply.",
          display: { icon: "run", summary: `Not run: ${command}`, failed: true },
        };
      }
    }
    const result = await runCommand(command, { cwd: ctx.workspace.root, timeoutMs: ctx.commandTimeoutMs, signal: ctx.signal });
    const seconds = `${(result.durationMs / 1000).toFixed(1)}s`;
    let how: string;
    if (result.aborted) {
      how = `Stopped by the user after ${seconds}.`;
    } else if (result.timedOut) {
      how = `Stopped after ${seconds}: it ran past the ${Math.round(ctx.commandTimeoutMs / 1000)}s time limit.`;
    } else {
      how = `Exit code ${result.exitCode} after ${seconds}.`;
    }
    const output = result.output.trim();
    const failed = result.exitCode !== 0;
    const status = result.aborted ? "stopped" : result.timedOut ? "timed out" : `exit ${result.exitCode}`;
    return {
      content: `${how}\n<output>\n${clipOutput(output) || "(no output)"}\n</output>`,
      display: {
        icon: "run",
        summary: `Ran ${command}: ${status}, ${seconds}`,
        detail: clipOutput(output, 30_000) || "(no output)",
        failed,
      },
    };
  },
};

/**
 * Every tool, whatever the request's mode: the list is part of the prompt,
 * so keeping it the same keeps the prompt the server has cached.
 */
export const TOOLS: readonly Tool[] = [
  listFiles,
  searchTool,
  readFile,
  outline,
  lookupTool("references"),
  lookupTool("definitions"),
  showLocations,
  presentTour,
  editFile,
  writeFile,
  runCommandTool,
];

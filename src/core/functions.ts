import type { OutlineEntry } from "./tools";

/**
 * Functions and their tests, for level 2's requests: finding the function
 * the cursor is in, its documentation, and the tests that call it, and
 * telling whether it has a body yet. A file's outline from the editor's
 * language support does most of it, in any language; without one, Python's
 * own shape stands in, since that is what courses mostly use. Lines are
 * 1-based and inclusive throughout.
 */

/** Lines of a file, as the model is shown them. */
export interface Excerpt {
  path: string;
  start: number;
  lines: string[];
}

export interface LineRange {
  path: string;
  start: number;
  end: number;
}

export function excerptEnd(excerpt: Excerpt): number {
  return excerpt.start + excerpt.lines.length - 1;
}

const FUNCTION_KINDS = new Set(["function", "method", "constructor"]);

/** A function without a name of its own, as outlines show one: `reduce() callback`, `<lambda>`. */
export function isAnonymous(name: string): boolean {
  return /(?:^|\s)callback$|^<.*>$|^$/.test(name);
}

/**
 * The innermost function or method in an outline that holds `line`, among
 * those `accept` takes: by default, those with names of their own, so that a
 * callback passed to another function is part of the function it is in.
 */
export function functionAt(entries: readonly OutlineEntry[], line: number, accept: (entry: OutlineEntry) => boolean = (e) => !isAnonymous(e.name)): OutlineEntry | undefined {
  for (const entry of entries) {
    if (line < entry.start || line > entry.end) {
      continue;
    }
    const inner = functionAt(entry.children, line, accept);
    if (inner !== undefined) {
      return inner;
    }
    if (FUNCTION_KINDS.has(entry.kind) && accept(entry)) {
      return entry;
    }
  }
  return undefined;
}

/** How far a line is indented, a tab counting as 8 columns as Python counts it. */
function indentation(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === " ") {
      columns++;
    } else if (ch === "\t") {
      columns += 8 - (columns % 8);
    } else {
      break;
    }
  }
  return columns;
}

/**
 * The Python function whose `def` holds `line`, by indentation alone, for a
 * file the editor has no outline of. Its body is every line after the `def`
 * that is indented more than it, blank lines between them included.
 */
export function pythonFunctionAt(lines: readonly string[], line: number): (Omit<LineRange, "path"> & { name: string }) | undefined {
  let least = Number.POSITIVE_INFINITY;
  for (let n = Math.min(line, lines.length); n >= 1; n--) {
    const text = lines[n - 1] ?? "";
    if (text.trim() === "") {
      continue;
    }
    const indent = indentation(text);
    const def = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(text);
    if (def !== null && (n === line || indent < least)) {
      let end = n;
      for (let m = n + 1; m <= lines.length; m++) {
        const after = lines[m - 1] ?? "";
        if (after.trim() === "") {
          continue;
        }
        if (indentation(after) <= indent) {
          break;
        }
        end = m;
      }
      return { start: n, end, name: def[1] as string };
    }
    least = Math.min(least, indent);
    if (least === 0) {
      return undefined;
    }
  }
  return undefined;
}

const COMMENT = /^(?:#|\/\/|\/\*|\*|--|;)/;

/** Where a function's documentation starts: the comments and decorators just above it, if any. */
export function docStart(lines: readonly string[], start: number): number {
  let n = start;
  while (n > 1) {
    const above = (lines[n - 2] ?? "").trim();
    if (above === "" || !(COMMENT.test(above) || above.startsWith("@"))) {
      break;
    }
    n--;
  }
  return n;
}

/** The name a function's header gives it, in the languages courses use. */
export function functionName(header: string): string | undefined {
  const patterns = [
    /\bdef\s+([A-Za-z_]\w*)/,
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    /\(define\s+\(\s*([^\s()]+)/,
    /\b(?:fn|func|fun)\s+([A-Za-z_]\w*)/,
    /([A-Za-z_$][\w$]*)\s*\(/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(header);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

/** A file of tests, by the names test runners look for. */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? "";
  if (parts.slice(0, -1).some((dir) => /^(?:tests?|specs?|__tests__)$/i.test(dir))) {
    return true;
  }
  return /^test.*\.py$|^test_|_test\.\w+$|[.-](?:test|spec)\.\w+$|Tests?\.\w+$/.test(file);
}

/**
 * A function or method that is a test, by its name: test_total, testTotal,
 * TotalTest, or the callback a test framework is given, as outlines name it:
 * `it("adds up") callback`.
 */
export function isTestName(name: string): boolean {
  return /^test|_test|Test|^(?:it|specify)\(.*\) callback$/.test(name);
}

/** A line outside any function that tests something, such as an assert at the end of a file. */
export function isTestLine(text: string): boolean {
  return /\b(?:assert|check|expect|test)/i.test(text);
}

/**
 * The test around a call to a function at `line` of a file: the function it
 * is in, if that is a test or the file is a test file, or else the line
 * itself, if it is a test outside any function. Undefined for a call that
 * isn't in a test, such as one from other code. `outline` is the file's,
 * from the editor's language support; without one, Python's shape is used.
 */
export function testAround(lines: readonly string[], outline: readonly OutlineEntry[] | undefined, path: string, line: number): LineRange | undefined {
  // A test framework's callback is a test of its own, though it has no name.
  const fn = outline !== undefined ? functionAt(outline, line, (e) => !isAnonymous(e.name) || isTestName(e.name)) : pythonFunctionAt(lines, line);
  if (fn !== undefined) {
    return isTestName(fn.name) || isTestPath(path) ? { path, start: fn.start, end: fn.end } : undefined;
  }
  return isTestPath(path) || isTestLine(lines[line - 1] ?? "") ? { path, start: line, end: line } : undefined;
}

/** Ranges in the same file that overlap or touch, joined, in order. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => (a.path === b.path ? a.start - b.start : a.path < b.path ? -1 : 1));
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.path === range.path && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** A body that stands in for one not yet written: pass, ..., a TODO, NotImplementedError. */
const PLACEHOLDER =
  /^(?:pass|\.\.\.|raise NotImplementedError\b.*|(?:#|\/\/|--|;+)\s*TODO\b.*|todo!\(.*\);?|unimplemented!\(.*\);?|throw new (?:UnsupportedOperationException|Error)\((?:["'`](?:not (?:yet )?implemented|todo)\b.*)?\);?)$/i;

export function isPlaceholder(line: string): boolean {
  return PLACEHOLDER.test(line.trim());
}

function isFiller(line: string): boolean {
  const text = line.trim();
  return text === "" || COMMENT.test(text) || isPlaceholder(text) || /^[{}()[\];]+$|^end$/.test(text);
}

/**
 * Whether a function has a body yet: any line besides its header, its
 * documentation, comments and a placeholder. A Python docstring is the
 * documentation; elsewhere the body is what is inside the braces, or after
 * the header.
 */
export function hasBody(lines: readonly string[]): boolean {
  const def = lines.findIndex((line) => /^\s*(?:async\s+)?def\b/.test(line));
  if (def >= 0) {
    let i = def;
    while (i < lines.length && !/:\s*(?:#.*)?$/.test(lines[i] ?? "")) {
      i++;
    }
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() === "") {
      i++;
    }
    const first = (lines[i] ?? "").trim();
    const quote = /^[rRuUbBfF]{0,2}("""|'''|"|')/.exec(first)?.[1];
    if (quote !== undefined) {
      const rest = first.slice(first.indexOf(quote) + quote.length);
      if (quote.length === 3 && !rest.includes(quote)) {
        i++;
        while (i < lines.length && !(lines[i] ?? "").includes(quote)) {
          i++;
        }
      }
      i++;
    }
    return lines.slice(i).some((line) => !isFiller(line));
  }
  let i = 0;
  while (i < lines.length && isFiller(lines[i] ?? "")) {
    i++;
  }
  const brace = lines.findIndex((line, n) => n >= i && line.includes("{"));
  const header = brace >= 0 ? brace : i;
  const sameLine = brace >= 0 ? (lines[brace] ?? "").slice((lines[brace] ?? "").indexOf("{") + 1) : "";
  return [sameLine, ...lines.slice(header + 1)].some((line) => !isFiller(line));
}

/**
 * Whether a function written from `original` kept every line of it, in
 * order, but a placeholder: its header and documentation, and any line the
 * student had written in it.
 */
export function keepsLines(original: readonly string[], written: readonly string[]): boolean {
  const wanted = original.map((line) => line.trim()).filter((line) => line !== "" && !isPlaceholder(line));
  let found = 0;
  for (const line of written) {
    if (found < wanted.length && line.trim() === wanted[found]) {
      found++;
    }
  }
  return found === wanted.length;
}

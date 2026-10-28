import { splitLines } from "./files";

export type EditResult =
  | {
      ok: true;
      text: string;
      /** The first and last lines (1-based) of the replaced text, in the new file. */
      firstLine: number;
      lastLine: number;
      count: number;
    }
  | { ok: false; error: string };

/**
 * Replaces `oldString` with `newString` in `text`: the one place it occurs,
 * or every place with `replaceAll`. The model writes `\n` line endings; a
 * file that uses `\r\n` keeps them.
 */
export function replaceText(text: string, oldString: string, newString: string, replaceAll: boolean): EditResult {
  if (oldString === "") {
    return { ok: false, error: "old_string is empty. To create a file, or replace all of it, use write_file." };
  }
  if (oldString === newString) {
    return { ok: false, error: "old_string and new_string are the same, so there is nothing to change." };
  }
  const crlf = text.includes("\r\n");
  const from = crlf ? toCrlf(oldString) : oldString;
  const to = crlf ? toCrlf(newString) : newString;

  const offsets: number[] = [];
  for (let at = text.indexOf(from); at >= 0; at = text.indexOf(from, at + from.length)) {
    offsets.push(at);
  }
  if (offsets.length === 0) {
    return { ok: false, error: notFound(text, oldString) };
  }
  if (offsets.length > 1 && !replaceAll) {
    const lines = [...new Set(offsets.map((at) => lineOf(text, at)))];
    return {
      ok: false,
      error: `old_string occurs ${offsets.length} times (at lines ${lines.join(", ")}). Include more of the surrounding lines to pick one, or set replace_all to change them all.`,
    };
  }

  let result = "";
  let last = 0;
  let firstOffset = 0;
  let lastEnd = 0;
  for (const [i, at] of offsets.entries()) {
    result += text.slice(last, at);
    if (i === 0) {
      firstOffset = result.length;
    }
    result += to;
    lastEnd = result.length;
    last = at + from.length;
  }
  result += text.slice(last);
  const firstLine = lineOf(result, firstOffset);
  // A replacement that ends with a newline ends on the line before.
  const lastLine = Math.max(firstLine, lineOf(result, Math.max(firstOffset, lastEnd - (to.endsWith("\n") ? 1 : 0))));
  return { ok: true, text: result, firstLine, lastLine, count: offsets.length };
}

/**
 * `text` without the numbers read_file puts before each line (`  12\t`),
 * when every line that isn't blank has one; undefined otherwise.
 */
export function withoutLineNumbers(text: string): string | undefined {
  const lines = text.split("\n");
  const numbered = /^ *\d+\t/;
  const blank = (line: string): boolean => line.trim() === "";
  if (lines.every(blank) || !lines.every((line) => blank(line) || numbered.test(line))) {
    return undefined;
  }
  return lines.map((line) => line.replace(numbered, "")).join("\n");
}

function toCrlf(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

/** The 1-based line holding `offset`. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
  }
  return line;
}

/**
 * Why `oldString` didn't match, and where the passage it was meant to be
 * probably is: models most often get indentation or trailing spaces wrong,
 * so the lines are compared with their whitespace trimmed.
 */
function notFound(text: string, oldString: string): string {
  const fileLines = splitLines(text).map((line) => line.trim());
  const wanted = splitLines(oldString)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const base = "old_string was not found in the file; it must match the file's text exactly, including indentation.";
  const first = wanted[0];
  if (first === undefined) {
    return base;
  }
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i] !== first) {
      continue;
    }
    // Every wanted line, in order, from here on (blank lines aside).
    let j = i;
    let k = 0;
    while (j < fileLines.length && k < wanted.length) {
      if (fileLines[j] === "") {
        j++;
        continue;
      }
      if (fileLines[j] !== wanted[k]) {
        break;
      }
      j++;
      k++;
    }
    if (k === wanted.length) {
      return `${base} Lines ${i + 1}-${j} match it apart from whitespace: read them again and copy them exactly.`;
    }
  }
  return `${base} Read the file again: it may have changed.`;
}

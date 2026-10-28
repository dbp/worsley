import type { ContextChip } from "../protocol";
import { numberLines, splitLines } from "./files";

/**
 * What the user's editor shows, sent with each message so that "this" and
 * "here" mean what the user is looking at. Selections are always sent; a
 * visible file is sent whole when it is short, otherwise as the lines on
 * screen and some around them.
 */

/** Lines, 1-based and inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

export interface EditorFile {
  /** Relative to the workspace folder. */
  path: string;
  text: string;
  active: boolean;
  /** It has changes the user hasn't saved; `text` includes them. */
  dirty: boolean;
  visible: LineRange[];
  /** Non-empty selections, with the exact text selected. */
  selections: (LineRange & { text: string })[];
}

export interface ContextOptions {
  maxFileLines: number;
  excluded: ReadonlySet<string>;
  /**
   * What this thread has already sent of each file, by path, as a hash of
   * the text sent: a file that hasn't changed isn't sent again. Updated by
   * `formatContext`.
   */
  sent: Map<string, string>;
}

/** Lines shown around the visible ones of a file too long to send whole. */
const MARGIN = 40;

export function fileKey(file: EditorFile): string {
  return `file:${file.path}`;
}

export function selectionKey(file: EditorFile, selection: LineRange): string {
  return `sel:${file.path}:${selection.start}-${selection.end}`;
}

/** The active file first, then the others in the editor's order. */
function ordered(files: readonly EditorFile[]): EditorFile[] {
  return [...files].sort((a, b) => Number(b.active) - Number(a.active));
}

/** The chips the panel shows above the message box: what the next message will include. */
export function contextChips(files: readonly EditorFile[], options: Omit<ContextOptions, "sent">): ContextChip[] {
  const selections: ContextChip[] = [];
  const whole: ContextChip[] = [];
  for (const file of ordered(files)) {
    const name = file.path.split("/").pop() ?? file.path;
    for (const selection of file.selections) {
      const key = selectionKey(file, selection);
      selections.push({
        key,
        kind: "selection",
        label: `${name}:${rangeText(selection)}`,
        detail: `Selected: ${file.path}, ${selection.start === selection.end ? `line ${selection.start}` : `lines ${rangeText(selection)}`}`,
        excluded: options.excluded.has(key),
      });
    }
    const lines = splitLines(file.text).length;
    const key = fileKey(file);
    const shown = lines <= options.maxFileLines ? `all ${lines} lines` : `lines ${file.visible.map(rangeText).join(", ")} of ${lines} on screen`;
    whole.push({
      key,
      kind: "file",
      label: name,
      detail: `${file.active ? "Active editor" : "Visible"}: ${file.path}, ${shown}${file.dirty ? ", unsaved" : ""}`,
      excluded: options.excluded.has(key),
    });
  }
  return [...selections, ...whole];
}

/**
 * The `<editor_context>` block for a message, or undefined when nothing is
 * visible or everything is excluded.
 */
export function formatContext(files: readonly EditorFile[], options: ContextOptions): string | undefined {
  const parts: string[] = [];
  const sorted = ordered(files);
  for (const file of sorted) {
    const lines = splitLines(file.text);
    for (const selection of file.selections) {
      if (options.excluded.has(selectionKey(file, selection))) {
        continue;
      }
      const end = Math.min(selection.end, lines.length);
      let body = numberLines(lines, selection.start, end);
      if (selection.start === selection.end && selection.text.trim() !== (lines[selection.start - 1] ?? "").trim()) {
        body += `\nSelected text: ${JSON.stringify(selection.text)}`;
      }
      parts.push(`<selection path="${file.path}" lines="${rangeText(selection)}">\n${body}\n</selection>`);
    }
  }
  // A long file's lines on screen, or a short file whole, until the budget runs out.
  let budget = options.maxFileLines * 2;
  for (const file of sorted) {
    if (options.excluded.has(fileKey(file))) {
      continue;
    }
    const lines = splitLines(file.text);
    const visible = file.visible.map(rangeText).join(",");
    const attributes = [`path="${file.path}"`, `visible="${visible}"`, `total_lines="${lines.length}"`];
    if (file.active) {
      attributes.push(`active="true"`);
    }
    if (file.dirty) {
      attributes.push(`unsaved="true"`);
    }
    let shown: LineRange[];
    if (lines.length <= options.maxFileLines && lines.length <= budget) {
      shown = [{ start: 1, end: Math.max(1, lines.length) }];
    } else {
      shown = mergeRanges(file.visible.map((r) => ({ start: Math.max(1, r.start - MARGIN), end: Math.min(lines.length, r.end + MARGIN) })));
    }
    const body = shown.map((r) => numberLines(lines, r.start, r.end)).join("\n…\n");
    attributes.push(`shown="${shown.map(rangeText).join(",")}"`);
    const hash = fnv1a(`${shown.map(rangeText).join(",")}\n${body}`);
    if (options.sent.get(file.path) === hash) {
      parts.push(`<file ${attributes.join(" ")}>(unchanged since an earlier message, so not repeated)</file>`);
      continue;
    }
    options.sent.set(file.path, hash);
    budget -= shown.reduce((n, r) => n + r.end - r.start + 1, 0);
    parts.push(`<file ${attributes.join(" ")}>\n${body}\n</file>`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `<editor_context>\nThe user's editor right now. Line numbers are 1-based.\n${parts.join("\n")}\n</editor_context>`;
}

export function rangeText(range: LineRange): string {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** A short hash of a string, to tell whether a file has changed. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

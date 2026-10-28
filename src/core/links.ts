/**
 * Links from an answer into the code. The model is asked for Markdown links
 * like `[parse](src/cli.py#L10-L32)`; models also fall back on
 * `src/cli.py:10-32` and `src/cli.py:10`, so those work too. Lines are
 * 1-based and inclusive. The panel and the extension both use this module,
 * so they agree on what a link is.
 */
export interface CodeRef {
  path: string;
  start?: number;
  end?: number;
}

/** The reference in a link's target, or undefined for a web link or a bare anchor. */
export function parseCodeRef(href: string): CodeRef | undefined {
  let text = href.trim();
  try {
    text = decodeURI(text);
  } catch {
    // Leave it as written.
  }
  if (text.startsWith("file://")) {
    text = text.slice("file://".length);
  } else if (/^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|command:|data:|javascript:)/i.test(text)) {
    return undefined;
  }
  if (text === "" || text.startsWith("#")) {
    return undefined;
  }
  const hash = /^(.+?)#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(text);
  if (hash !== null) {
    return withLines(hash[1] as string, hash[2], hash[3]);
  }
  const colon = /^(.+?):(\d+)(?::\d+)?(?:-(\d+))?$/.exec(text);
  if (colon !== null) {
    return withLines(colon[1] as string, colon[2], colon[3]);
  }
  const path = text.replace(/#.*$/, "");
  return path === "" ? undefined : { path };
}

function withLines(path: string, from: string | undefined, to: string | undefined): CodeRef {
  const a = Number(from);
  const b = to === undefined ? a : Number(to);
  return { path, start: Math.min(a, b), end: Math.max(a, b) };
}

/** `path#L10-L20`, the form links take in the panel. */
export function formatHref(ref: CodeRef): string {
  if (ref.start === undefined) {
    return ref.path;
  }
  return ref.end === undefined || ref.end === ref.start ? `${ref.path}#L${ref.start}` : `${ref.path}#L${ref.start}-L${ref.end}`;
}

/** `path:10–20`, for showing. */
export function labelRef(ref: CodeRef): string {
  if (ref.start === undefined) {
    return ref.path;
  }
  return ref.end === undefined || ref.end === ref.start ? `${ref.path}:${ref.start}` : `${ref.path}:${ref.start}–${ref.end}`;
}

/**
 * A path with a line number in prose, such as `src/a.py:12` or `a.py:12-20`.
 * The panel turns these, and code spans that hold one, into links once the
 * extension confirms the file exists.
 */
export const PATH_WITH_LINE = /(?<![\w/.\-])((?:[\w.\-]+\/)*[\w.\-]+\.[A-Za-z0-9]{1,10}):(\d+)(?:-(\d+))?(?![\w])/g;

/**
 * A code span that may name a file or folder: `src/a.py`, `a.py:12`,
 * `src/a.py#L3-L9`, `src/core/`. Many that look like one aren't, so these
 * become links only once the extension finds them.
 */
export function mayBePath(text: string): boolean {
  const file = /^(?:\.{0,2}\/)?(?:[\w.\-]+\/)*[\w\-][\w.\-]*\.[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?$/;
  const folder = /^(?:\.{1,2}\/)?[\w.\-]+(?:\/[\w.\-]+)*\/?$/;
  return file.test(text) || (text.includes("/") && folder.test(text));
}

/** Every folder that holds one of `files`, as paths like theirs. */
export function foldersOf(files: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const file of files) {
    for (let at = file.indexOf("/"); at > 0; at = file.indexOf("/", at + 1)) {
      folders.add(file.slice(0, at));
    }
  }
  return folders;
}

/**
 * The one of `files` (or folders) a path from the model means. Models
 * sometimes drop the leading folders (`parser.py:12` for
 * `src/app/parser.py`), so when the path isn't one of them, the one whose
 * path ends with it is taken instead.
 */
export function resolvePath(relative: string | undefined, given: string, files: ReadonlySet<string>): string | undefined {
  if (relative !== undefined && files.has(relative)) {
    return relative;
  }
  const tail = given.replace(/^(?:\.?\/)+/, "");
  if (tail === "") {
    return undefined;
  }
  let found: string | undefined;
  for (const file of files) {
    if (file === tail || file.endsWith(`/${tail}`)) {
      if (found !== undefined) {
        return undefined;
      }
      found = file;
    }
  }
  return found;
}

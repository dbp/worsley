/**
 * Glob patterns as the model writes them for `list_files` and `search`,
 * matched against a path relative to the workspace folder with `/` between
 * folders. This is the part of VS Code's glob syntax that `files.exclude`
 * patterns use:
 *
 * - `*` is any run of characters within one name, and `?` is one character;
 * - `**` as a whole segment is any number of folders, including none;
 * - `{a,b}` is either alternative, and may nest;
 * - `[abc]`, `[a-z]` and `[!a]` are one character from a set.
 *
 * A pattern with no `/` matches a name in any folder, as ripgrep's `-g`
 * does: `*.py` is every Python file. Matching is case-sensitive.
 */
export function compileGlob(pattern: string): RegExp {
  const trimmed = pattern.replace(/^(?:\.?\/)+/, "");
  const anywhere = !trimmed.includes("/") ? `**/${trimmed}` : trimmed;
  const alternatives = expandBraces(anywhere).map(globSource);
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

/**
 * `a{b,c}d` as `abd` and `acd`. Braces are expanded before the pattern is
 * split into segments, so an alternative may contain `/`. A `{` with no
 * partner is an ordinary character.
 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) {
    return [pattern];
  }
  let depth = 0;
  let start = open + 1;
  const options: string[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") {
      depth++;
    } else if (c === "," && depth === 1) {
      options.push(pattern.slice(start, i));
      start = i + 1;
    } else if (c === "}" && --depth === 0) {
      options.push(pattern.slice(start, i));
      const head = pattern.slice(0, open);
      const tail = pattern.slice(i + 1);
      return options.flatMap((option) => expandBraces(head + option + tail));
    }
  }
  const literal = pattern.slice(0, open + 1);
  return expandBraces(pattern.slice(open + 1)).map((rest) => literal + rest);
}

/** A brace-free pattern as a regular expression's source. */
function globSource(pattern: string): string {
  const segments = pattern.split("/");
  let out = "";
  // Whether the next segment needs a `/` before it.
  let separate = false;
  segments.forEach((segment, i) => {
    if (segment === "**") {
      const last = i === segments.length - 1;
      if (last) {
        // `a/**` is everything inside `a`; a lone `**` is everything.
        out += separate ? "/.*" : ".*";
      } else {
        // `**/b` and `a/**/b` allow any folders, or none, before `b`.
        out += separate ? "/(?:.*/)?" : "(?:.*/)?";
      }
      separate = false;
    } else {
      if (separate) {
        out += "/";
      }
      out += segmentSource(segment);
      separate = true;
    }
  });
  return out;
}

function segmentSource(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === "*") {
      while (segment[i + 1] === "*") {
        i++;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[" && segment.indexOf("]", i + 1) > i + 1) {
      const close = segment.indexOf("]", i + 1);
      let body = segment.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) {
        body = body.slice(1);
      }
      const escaped = body.replace(/[\\\]^]/g, "\\$&");
      out += negated ? `[^/${escaped}]` : `[${escaped}]`;
      i = close;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

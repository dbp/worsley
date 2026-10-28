import * as path from "node:path";

/**
 * A path the model or the panel gave, made relative to the workspace folder
 * with `/` between folders; undefined when it is empty, the folder itself,
 * or outside it. It may be written relative (`src/a.py`, `./src/a.py`) or
 * absolute under the folder.
 */
export function workspacePath(root: string, given: string): string | undefined {
  const trimmed = given.trim();
  if (trimmed === "") {
    return undefined;
  }
  const absolute = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

export function absolutePath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

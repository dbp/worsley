import MarkdownIt from "markdown-it";
import { labelRef, mayBePath, parseCodeRef, PATH_WITH_LINE } from "../core/links";
import type { LinkStatus } from "../protocol";

// Raw HTML in a reply is shown as text, and markdown-it refuses
// javascript: and similar links.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * A reply rendered from Markdown, with its links to code marked: a link's
 * target in `data-ref`, and code spans or prose that may name a file in
 * `data-candidate` until the extension says whether the file exists.
 */
export function renderMarkdown(source: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "md";
  container.innerHTML = md.render(source);
  for (const a of container.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    const ref = parseCodeRef(href);
    if (/^https?:\/\//i.test(href)) {
      a.dataset.external = href;
      a.title = href;
    } else if (ref !== undefined) {
      a.dataset.ref = href;
      a.classList.add("code-link");
      a.title = labelRef(ref);
    }
  }
  // The panel loads no remote images (see its CSP), so each becomes a link to open.
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const link = document.createElement("a");
    link.textContent = `[image: ${img.getAttribute("alt") || src}]`;
    if (/^https?:\/\//i.test(src)) {
      link.dataset.external = src;
      link.title = src;
    }
    img.replaceWith(link);
  }
  for (const code of container.querySelectorAll("code")) {
    const text = code.textContent ?? "";
    if (code.closest("pre, a") === null && mayBePath(text)) {
      code.dataset.candidate = text;
    }
  }
  markPathsInProse(container);
  return container;
}

/** `src/a.py:12` in ordinary text becomes a candidate link. */
function markPathsInProse(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("a, code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  while (walker.nextNode() !== null) {
    texts.push(walker.currentNode as Text);
  }
  for (const node of texts) {
    const value = node.nodeValue ?? "";
    const matches = [...value.matchAll(PATH_WITH_LINE)];
    if (matches.length === 0) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of matches) {
      const at = match.index ?? 0;
      fragment.append(value.slice(last, at));
      const span = document.createElement("span");
      span.dataset.candidate = match[0];
      span.textContent = match[0];
      fragment.append(span);
      last = at + match[0].length;
    }
    fragment.append(value.slice(last));
    node.replaceWith(fragment);
  }
}

/** Every link target and candidate in a rendered reply, for the extension to check. */
export function collectRefs(container: HTMLElement): string[] {
  const refs = new Set<string>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-ref], [data-candidate]")) {
    refs.add(el.dataset.ref ?? el.dataset.candidate ?? "");
  }
  refs.delete("");
  return [...refs];
}

/** Marks links that lead nowhere, and turns candidates that name a file into links. */
export function applyStatuses(container: HTMLElement, statuses: Record<string, LinkStatus>): void {
  for (const el of container.querySelectorAll<HTMLElement>("[data-ref]")) {
    if (statuses[el.dataset.ref ?? ""] === "missing") {
      el.classList.add("broken");
      el.title = "Not found in this workspace";
    }
  }
  for (const el of container.querySelectorAll<HTMLElement>("[data-candidate]")) {
    const candidate = el.dataset.candidate ?? "";
    if (statuses[candidate] === "ok") {
      el.dataset.ref = candidate;
      el.classList.add("code-link");
      const ref = parseCodeRef(candidate);
      el.title = ref !== undefined ? labelRef(ref) : candidate;
      el.setAttribute("role", "link");
      el.tabIndex = 0;
    }
  }
}

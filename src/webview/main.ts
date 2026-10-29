import { EXACTLY } from "../core/commandLine";
import type { Approval, ContextChip, HostMessage, Item, LinkStatus, Mode, PanelMessage, ToolIcon, TourView } from "../protocol";
import { applyStatuses, collectRefs, renderMarkdown } from "./markdown";

/**
 * The panel. It keeps no state of its own that matters: the extension sends
 * the thread, item by item, and the panel draws it and reports clicks.
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

function send(message: PanelMessage): void {
  vscode.postMessage(message);
}

type Child = Node | string | undefined | false;

/** An element, with attributes (skipped when undefined or false) and children. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) {
      continue;
    }
    el.setAttribute(key === "className" ? "class" : key, value === true ? "" : value);
  }
  for (const child of children) {
    if (child !== undefined && child !== false) {
      el.append(child);
    }
  }
  return el;
}

const mac = navigator.userAgent.includes("Mac");
const keys = (key: string): string => (mac ? `⌘⌥${key}` : `Ctrl+Alt+${key}`);

const app = document.getElementById("app") as HTMLElement;
// The thread and the tour bar take focus when clicked, so that text selected
// in them can be copied. Before VS Code copies from a page that has no
// element focused, it gives focus back to the last one that had it, usually
// the message box, and the selection is lost.
const tourBar = h("div", { id: "tour", hidden: true, tabindex: "-1" });
const thread = h("main", { id: "thread", tabindex: "-1" });
const empty = h(
  "div",
  { id: "empty" },
  h("p", { className: "empty-title" }, "Read the code, with help."),
  h("p", {}, "Select some code and press ", h("kbd", {}, keys("A")), " to ask about it, or ", h("kbd", {}, keys("E")), " to change it. Worsley sees the files you have open and what you select."),
  h("p", {}, "Ask where something happens and it lists every place; ask how something works and it can walk you through the code a step at a time."),
  h("button", { className: "secondary", "data-action": "start-tour" }, "Tour this codebase"),
);
thread.append(empty);
const chipsRow = h("div", { id: "chips" });
const input = h("textarea", { id: "input", rows: "3", "aria-label": "Message" });
const modeButtons = (["ask", "change"] as const).map((m) =>
  h(
    "button",
    {
      "data-mode": m,
      title: m === "ask" ? "Answer questions; no files change" : "Change the code and what depends on it, and run the tests",
    },
    m === "ask" ? "Ask" : "Change",
  ),
);
const statusText = h("span", { id: "status" });
const sendButton = h("button", { id: "send", className: "primary" }, "Send");
const backendButton = h("button", { id: "backend", className: "link-button", title: "Choose another model" });
const composer = h(
  "footer",
  { id: "composer" },
  chipsRow,
  input,
  h("div", { id: "controls" }, h("div", { className: "modes", role: "group", "aria-label": "Mode" }, ...modeButtons), statusText, sendButton),
  backendButton,
);
app.append(tourBar, thread, composer);

// ---- State

let busy = false;
let mode: Mode = "ask";
let tour: TourView | undefined;
const items = new Map<string, Item>();
const nodes = new Map<string, HTMLElement>();
const statuses = new Map<string, Record<string, LinkStatus>>();
/** The text of each reply whose links have been sent for checking. */
const checked = new Map<string, string>();
/** Open `<details>`, by item and name, so that redrawing an item keeps them open. */
const openDetails = new Set<string>();

// ---- Drawing items

const ICONS: Record<ToolIcon, string> = {
  list: "☰",
  search: "⌕",
  read: "▤",
  outline: "≣",
  references: "⇄",
  edit: "✎",
  create: "+",
  run: "▶",
};

function details(itemId: string, name: string, summary: Child, body: Node, className?: string): HTMLDetailsElement {
  const key = `${itemId}:${name}`;
  const head = h("summary", {}, summary);
  // Selecting the summary's text, to copy it, shouldn't open or close it.
  head.addEventListener("click", (event) => {
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed && head.contains(selection.anchorNode)) {
      event.preventDefault();
    }
  });
  const el = h("details", { className, open: openDetails.has(key) }, head, body);
  el.addEventListener("toggle", () => {
    if (el.open) {
      openDetails.add(key);
    } else {
      openDetails.delete(key);
    }
  });
  return el;
}

/** Copies through the extension, which can always reach the clipboard. */
function copyButton(text: string): HTMLButtonElement {
  return h("button", { className: "link-button copy", "data-action": "copy", "data-copy": text, title: "Copy this to the clipboard" }, "Copy");
}

function draw(item: Item): HTMLElement {
  switch (item.kind) {
    case "user":
      return h(
        "div",
        { className: `item user ${item.mode}` },
        h("div", { className: "who" }, item.mode === "change" ? "Change" : "Ask"),
        h("div", { className: "user-text" }, item.text),
        item.context.length > 0 && h("div", { className: "user-context" }, ...item.context.map((label) => h("span", { className: "chip static" }, label))),
      );
    case "step":
      return h(
        "div",
        { className: "item step" },
        h(
          "button",
          { className: "step-link", "data-action": "step", "data-index": String(item.index), title: `Open step ${item.index + 1} in the editor` },
          h("span", { className: "step-number" }, `Step ${item.index + 1} of ${item.total}`),
          h("span", { className: "step-title" }, item.title),
        ),
      );
    case "assistant": {
      const body = renderMarkdown(item.text);
      const known = statuses.get(item.id);
      if (known !== undefined) {
        applyStatuses(body, known);
      }
      const words = item.reasoning.trim() === "" ? 0 : item.reasoning.trim().split(/\s+/).length;
      const thinking =
        item.reasoning.trim() !== "" &&
        details(
          item.id,
          "thinking",
          h("span", {}, item.streaming && item.text === "" ? "Thinking… " : "Thought ", h("span", { className: "muted" }, `(${words} words)`)),
          h("div", { className: "reasoning" }, item.reasoning.trim()),
          "thinking",
        );
      return h(
        "div",
        { className: `item assistant${item.streaming ? " streaming" : ""}` },
        thinking,
        body,
        item.stats !== undefined && h("div", { className: "stats" }, item.stats),
      );
    }
    case "tool": {
      const summary = item.href !== undefined ? h("a", { className: "code-link", "data-ref": item.href, href: "#" }, item.summary) : h("span", {}, item.summary);
      const line = h(
        "div",
        { className: "tool-line" },
        h("span", { className: "tool-icon", "aria-hidden": "true" }, ICONS[item.icon] ?? "•"),
        h("span", { className: "tool-summary" }, summary),
        item.diffPath !== undefined && h("button", { className: "link-button", "data-action": "diff", "data-path": item.diffPath, title: "Open the git diff" }, "diff"),
        item.status === "failed" && copyButton(item.detail !== undefined && item.detail !== item.summary ? `${item.summary}\n\n${item.detail}` : item.summary),
      );
      return h(
        "div",
        { className: `item tool ${item.status}` },
        item.detail !== undefined ? details(item.id, "detail", line, h("pre", { className: "tool-detail" }, item.detail), "tool-details") : line,
      );
    }
    case "locations":
      return h(
        "div",
        { className: "item card locations" },
        h(
          "div",
          { className: "card-head" },
          h("span", { className: "card-title" }, item.title),
          h("span", { className: "muted" }, `${item.locations.length} place${item.locations.length === 1 ? "" : "s"}`),
          h("button", { className: "link-button", "data-action": "peek", "data-id": item.id, title: "Show them all in the editor's peek view" }, "Peek all"),
        ),
        h(
          "ol",
          { className: "loc-list" },
          ...item.locations.map((loc) =>
            h(
              "li",
              {},
              h(
                "button",
                { className: "loc", "data-ref": loc.href, title: `Open ${loc.label}` },
                h("span", { className: "loc-label" }, loc.label),
                loc.note !== "" && h("span", { className: "loc-note" }, loc.note),
                loc.preview !== "" && h("pre", { className: "loc-preview" }, loc.preview),
              ),
            ),
          ),
        ),
      );
    case "approval": {
      const pending = item.status === "pending";
      const decide = (decision: string, label: string, primary = false, title?: string): HTMLButtonElement =>
        h("button", { className: primary ? "primary" : "secondary", "data-action": "approve", "data-id": item.id, "data-decision": decision, title }, label);
      // "cargo test …" is cargo test with any arguments; the last scope is the exact line.
      const scope =
        item.scopes.length > 1
          ? h(
              "select",
              { className: "scope", "aria-label": "What to allow from now on", title: "What runs without asking from now on: … stands for any arguments" },
              ...item.scopes.map((label, i) => h("option", { value: String(i), selected: i === item.scope }, label)),
            )
          : h("span", { className: "muted" }, "this exact command");
      return h(
        "div",
        { className: `item card approval ${item.status}` },
        h("div", { className: "card-head" }, h("span", { className: "card-title" }, pending ? "Run this command?" : item.status === "approved" ? "You allowed" : "You declined")),
        h("pre", { className: "approval-command" }, item.command),
        pending && h("div", { className: "buttons" }, decide("once", "Run", true), decide("deny", "Don't run")),
        pending && h("div", { className: "buttons always" }, decide("always", "Always allow", false, "Run it now, and from now on in this workspace without asking"), scope),
        item.allowed !== undefined &&
          h("div", { className: "approval-note muted" }, `From now on in this workspace: ${item.allowed === EXACTLY ? "this exact command" : item.allowed}`),
      );
    }
    case "changes":
      return h(
        "div",
        { className: "item card changes" },
        h("div", { className: "card-head" }, h("span", { className: "card-title" }, `Changed ${item.files.length} file${item.files.length === 1 ? "" : "s"}`)),
        h(
          "ul",
          { className: "change-list" },
          ...item.files.map((file) =>
            h(
              "li",
              {},
              h("a", { className: "code-link", "data-ref": file.path, href: "#" }, file.path),
              file.created && h("span", { className: "muted" }, " new"),
              " ",
              h("button", { className: "link-button", "data-action": "diff", "data-path": file.path, title: "Open the git diff" }, "diff"),
            ),
          ),
        ),
        h(
          "div",
          { className: "card-foot" },
          h("span", { className: "muted" }, "Nothing is staged or committed: review it with git."),
          h("button", { className: "secondary", "data-action": "walk" }, "Walk me through it"),
        ),
      );
    case "notice":
      return h("div", { className: `item notice ${item.level}` }, h("span", {}, item.text), item.level !== "info" && copyButton(item.text));
  }
}

function nearBottom(): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
}

/**
 * Whether the thread follows its end: true until the user scrolls up, and
 * again once they scroll back down. Items that grow after they are drawn
 * (as fonts load, or a reply streams in) keep it there, and so does the
 * thread getting shorter as the chips above the message box come and go.
 */
let following = true;
thread.addEventListener("scroll", () => {
  following = nearBottom();
});
const growth = new ResizeObserver(() => {
  if (following) {
    thread.scrollTop = thread.scrollHeight;
  }
});
growth.observe(thread);

function upsert(item: Item): void {
  const stick = following || nearBottom();
  items.set(item.id, item);
  const node = draw(item);
  node.dataset.id = item.id;
  const old = nodes.get(item.id);
  if (old !== undefined) {
    growth.unobserve(old);
    old.replaceWith(node);
  } else {
    thread.append(node);
  }
  nodes.set(item.id, node);
  growth.observe(node);
  empty.hidden = true;
  if (stick) {
    thread.scrollTop = thread.scrollHeight;
  }
  if (item.kind === "assistant" && !item.streaming && checked.get(item.id) !== item.text) {
    checked.set(item.id, item.text);
    const md = node.querySelector<HTMLElement>(".md");
    const hrefs = md !== null ? collectRefs(md) : [];
    if (hrefs.length > 0) {
      send({ type: "checkLinks", id: item.id, hrefs });
    }
  }
}

function resetThread(list: Item[]): void {
  for (const node of nodes.values()) {
    growth.unobserve(node);
    node.remove();
  }
  following = true;
  items.clear();
  nodes.clear();
  statuses.clear();
  checked.clear();
  openDetails.clear();
  empty.hidden = list.length > 0;
  for (const item of list) {
    upsert(item);
  }
  thread.scrollTop = thread.scrollHeight;
}

// ---- The tour bar

function drawTour(): void {
  tourBar.replaceChildren();
  tourBar.hidden = tour === undefined;
  if (tour === undefined) {
    return;
  }
  const t = tour;
  const select = h(
    "select",
    { className: "tour-steps", "aria-label": "Steps" },
    ...t.steps.map((step, i) => h("option", { value: String(i), selected: i === t.current }, `${i + 1}. ${step.title}${step.itemId !== undefined && i !== t.current ? " ✓" : ""}`)),
  );
  if (t.current < 0) {
    select.prepend(h("option", { value: "-1", selected: true, disabled: true }, `${t.steps.length} steps`));
  }
  select.addEventListener("change", () => send({ type: "tourGo", index: Number(select.value) }));
  const next = t.steps[t.current + 1];
  const blocked = (step: { itemId?: string } | undefined): boolean => step === undefined || (busy && step.itemId === undefined);
  tourBar.append(
    h(
      "div",
      { className: "tour-row" },
      h("span", { className: "tour-label" }, "Tour"),
      h("span", { className: "tour-title", title: t.title }, t.title),
      h("button", { className: "icon-button", "data-action": "tour-end", title: "End the tour", "aria-label": "End the tour" }, "✕"),
    ),
    h(
      "div",
      { className: "tour-row tour-nav" },
      h("button", { className: "secondary", "data-action": "tour-back", disabled: t.current <= 0 || blocked(t.steps[t.current - 1]) }, "‹ Back"),
      select,
      h("button", { className: "primary", "data-action": "tour-next", disabled: blocked(next) }, t.current < 0 ? "Start ›" : "Next ›"),
    ),
  );
}

function showTourStep(): void {
  const id = tour?.steps[tour.current]?.itemId;
  const node = id !== undefined ? nodes.get(id) : undefined;
  node?.scrollIntoView({ block: "start", behavior: "smooth" });
}

// ---- The composer

function drawChips(chips: ContextChip[]): void {
  chipsRow.replaceChildren(
    ...chips.map((chip) =>
      h(
        "button",
        {
          className: `chip ${chip.kind}${chip.excluded ? " excluded" : ""}`,
          "data-action": "chip",
          "data-key": chip.key,
          title: `${chip.detail}\n${chip.excluded ? "Left out of the next message. Click to include it." : "Included in the next message. Click to leave it out."}`,
          "aria-pressed": String(!chip.excluded),
        },
        chip.label,
      ),
    ),
  );
  chipsRow.hidden = chips.length === 0;
}

function setMode(next: Mode): void {
  mode = next;
  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  input.placeholder = mode === "ask" ? "Ask about the code…" : "Describe the change to make…";
  composer.classList.toggle("change", mode === "change");
}

function setBusy(next: boolean, status: string): void {
  busy = next;
  statusText.textContent = status;
  statusText.classList.toggle("active", busy);
  sendButton.textContent = busy ? "Stop" : "Send";
  sendButton.className = busy ? "secondary" : "primary";
  drawTour();
}

function submit(): void {
  if (busy) {
    send({ type: "stop" });
    return;
  }
  const text = input.value.trim();
  if (text === "") {
    return;
  }
  send({ type: "send", text, mode });
  input.value = "";
  grow();
}

function grow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
}

input.addEventListener("input", grow);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
sendButton.addEventListener("click", submit);
for (const button of modeButtons) {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode as Mode);
    input.focus();
  });
}
backendButton.addEventListener("click", () => send({ type: "pickBackend" }));

// ---- Clicks anywhere

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]");
  if (action !== null && !(action as HTMLButtonElement).disabled) {
    const data = action.dataset;
    switch (data.action) {
      case "approve": {
        const decision = data.decision as Approval;
        const scope = action.closest(".item")?.querySelector<HTMLSelectElement>("select.scope");
        send({ type: "approve", id: data.id ?? "", decision, scope: decision === "always" && scope !== null && scope !== undefined ? Number(scope.value) : undefined });
        return;
      }
      case "diff":
        send({ type: "diff", path: data.path ?? "" });
        return;
      case "peek":
        send({ type: "peek", id: data.id ?? "" });
        return;
      case "walk":
        send({ type: "walkChanges" });
        return;
      case "step":
        send({ type: "tourGo", index: Number(data.index) });
        return;
      case "chip":
        send({ type: "toggleChip", key: data.key ?? "" });
        return;
      case "start-tour":
        send({ type: "startTour" });
        return;
      case "copy":
        send({ type: "copy", text: data.copy ?? "" });
        action.textContent = "Copied";
        setTimeout(() => {
          action.textContent = "Copy";
        }, 1500);
        return;
      case "tour-end":
        send({ type: "tourEnd" });
        return;
      case "tour-back":
        if (tour !== undefined) {
          send({ type: "tourGo", index: tour.current - 1 });
        }
        return;
      case "tour-next":
        if (tour !== undefined) {
          send({ type: "tourGo", index: tour.current + 1 });
        }
        return;
    }
  }
  const ref = target.closest<HTMLElement>("[data-ref]");
  if (ref !== null) {
    event.preventDefault();
    if (!ref.classList.contains("broken")) {
      send({ type: "open", href: ref.dataset.ref ?? "" });
    }
    return;
  }
  const external = target.closest<HTMLElement>("[data-external]");
  if (external !== null) {
    event.preventDefault();
    send({ type: "openExternal", url: external.dataset.external ?? "" });
    return;
  }
  if (target.closest("a") !== null) {
    event.preventDefault();
  }
});

document.addEventListener("keydown", (event) => {
  const ref = (event.target as HTMLElement).closest?.<HTMLElement>("[data-ref][role=link]");
  if (ref !== null && ref !== undefined && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    send({ type: "open", href: ref.dataset.ref ?? "" });
  }
});

// ---- Messages from the extension

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "reset":
      resetThread(message.items);
      tour = message.tour;
      setBusy(message.busy, message.status);
      return;
    case "item":
      upsert(message.item);
      return;
    case "busy":
      setBusy(message.busy, message.status);
      return;
    case "context":
      drawChips(message.chips);
      return;
    case "tour": {
      const moved = message.tour?.current !== tour?.current;
      tour = message.tour;
      drawTour();
      if (moved) {
        showTourStep();
      }
      return;
    }
    case "backend":
      backendButton.textContent = message.label;
      backendButton.title = message.tooltip;
      return;
    case "links": {
      statuses.set(message.id, message.statuses);
      const md = nodes.get(message.id)?.querySelector<HTMLElement>(".md");
      if (md !== null && md !== undefined) {
        applyStatuses(md, message.statuses);
      }
      return;
    }
    case "focus":
      if (message.mode !== undefined) {
        setMode(message.mode);
      }
      if (message.text !== undefined) {
        input.value = message.text;
        grow();
      }
      input.focus();
      return;
  }
});

setMode("ask");
drawChips([]);
send({ type: "ready" });

/**
 * What the extension and its panel say to each other. The extension owns the
 * thread, the tour and the context; the panel draws them and reports what
 * the user did.
 */

/**
 * `ask` answers without changing files; `change` may edit them and run
 * commands. Each message carries its own mode, so one thread can mix them.
 */
export type Mode = "ask" | "change";

/**
 * Requests that stand alone, outside the thread: the model sees only the
 * code they are about. `explain` explains one line; `translate` turns the
 * student's pseudocode into code; `check` compares a function with its
 * documentation and tests; `fill` writes a function's body from them.
 */
export type Standalone = "explain" | "translate" | "check" | "fill";

/** What a user's message in the thread asked for. */
export type Request = Mode | Standalone;

/** Something Worsley does, which its level offers or doesn't (see core/levels.ts). */
export type Feature = Request | "tour" | "review";

/** Something in the editor that the next message will include. */
export interface ContextChip {
  key: string;
  kind: "file" | "selection";
  label: string;
  detail: string;
  /** The user clicked it away: the next message leaves it out. */
  excluded: boolean;
}

export type ToolIcon = "list" | "search" | "read" | "outline" | "references" | "edit" | "create" | "run";

/** A place in the code, as the panel lists it. */
export interface LocationView {
  /** `path#L10-L20`, which the panel sends back to open it. */
  href: string;
  label: string;
  note: string;
  /** The first few lines of the range. */
  preview: string;
}

export interface ChangedFile {
  path: string;
  created: boolean;
}

/** A file with changes that aren't committed. */
export interface FileChange {
  path: string;
  /** New to git. */
  untracked: boolean;
  /** Since the last commit; not counted for a binary file. */
  lines?: { added: number; removed: number };
}

/** One entry in the thread, as the panel draws it. Items are replaced whole by id. */
export type Item =
  /** For a request that stands alone, `text` is the code it is about, and `context` where that is. */
  | { kind: "user"; id: string; mode: Request; text: string; context: string[] }
  | { kind: "step"; id: string; index: number; total: number; title: string; href: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      reasoning: string;
      streaming: boolean;
      /** Token counts and speed, once the reply is complete. */
      stats?: string;
    }
  | {
      kind: "tool";
      id: string;
      icon: ToolIcon;
      summary: string;
      href?: string;
      detail?: string;
      /** For an edit: the file whose git diff the panel can open. */
      diffPath?: string;
      status: "running" | "done" | "failed";
    }
  | { kind: "locations"; id: string; title: string; locations: LocationView[] }
  | {
      kind: "approval";
      id: string;
      command: string;
      status: "pending" | "approved" | "denied";
      /** What "Always allow" can cover: `cargo test …`, `grep … and head …`, ending with the exact line. */
      scopes: string[];
      /** Index into `scopes` of the one suggested. */
      scope: number;
      /** What the user allowed from now on, once they have. */
      allowed?: string;
    }
  | { kind: "changes"; id: string; files: ChangedFile[] }
  /**
   * Before a Change request goes to the model: what is uncommitted, which git
   * would show mixed in with the change, and files not yet saved, which the
   * change saves first. The user sends the request anyway, or not.
   */
  | { kind: "uncommitted"; id: string; files: FileChange[]; unsaved: string[]; status: "pending" | "sent" | "cancelled" }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string };

export interface TourView {
  title: string;
  /** Index into `steps` of the step open in the editor; -1 before the first. */
  current: number;
  /** `itemId` is the step's header in the thread, once it has been explained. */
  steps: { title: string; href: string; itemId?: string }[];
}

export type LinkStatus = "ok" | "missing";

export type Approval = "once" | "always" | "deny";

export type HostMessage =
  | { type: "reset"; items: Item[]; tour: TourView | undefined; busy: boolean; status: string }
  | { type: "item"; item: Item }
  | { type: "busy"; busy: boolean; status: string }
  | { type: "context"; chips: ContextChip[] }
  | { type: "tour"; tour: TourView | undefined }
  | { type: "backend"; label: string; tooltip: string }
  /** Which of the links in an assistant item lead somewhere. */
  | { type: "links"; id: string; statuses: Record<string, LinkStatus> }
  | { type: "focus"; mode?: Mode; text?: string }
  /** What Worsley offers at its level, which the panel shows and nothing else. */
  | { type: "level"; level: number | "N"; features: Feature[] };

export type PanelMessage =
  | { type: "ready" }
  | { type: "send"; text: string; mode: Mode }
  | { type: "stop" }
  | { type: "newThread" }
  | { type: "open"; href: string }
  | { type: "openExternal"; url: string }
  | { type: "diff"; path: string }
  /** With "always", `scope` indexes the approval's scopes. */
  | { type: "approve"; id: string; decision: Approval; scope?: number }
  | { type: "toggleChip"; key: string }
  | { type: "tourGo"; index: number }
  | { type: "tourEnd" }
  | { type: "peek"; id: string }
  | { type: "walkChanges" }
  | { type: "checkLinks"; id: string; hrefs: string[] }
  | { type: "startTour" }
  | { type: "copy"; text: string }
  | { type: "pickBackend" }
  /** A request that stands alone, about what the editor has selected. */
  | { type: "standalone"; request: Standalone };

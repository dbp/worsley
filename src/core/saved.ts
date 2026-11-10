import type { ChangedFile, Item } from "../protocol";
import type { ChatMessage } from "./chat";
import type { Place, TourPlan } from "./tools";

/**
 * A thread as it is kept for its workspace, so that it outlasts a reload of
 * the window: what the panel shows, what the model has seen, the tour, and
 * what the tools and the context know of the files.
 */
export interface SavedThread {
  version: 1;
  items: Item[];
  messages: ChatMessage[];
  tour?: { plan: TourPlan; current: number; explained: [number, string][] };
  /** Files read or written, for write_file's check. */
  seen: string[];
  /** What of each visible file was sent, as hashes. */
  sent: [string, string][];
  lastChanges: ChangedFile[];
  warnedGit: boolean;
  /** The places of each list of locations, for Peek all. */
  locations: [string, Place[]][];
  nextId: number;
}

/** The thread in `text`, or undefined if it isn't one that this version wrote. */
export function parseSaved(text: string): SavedThread | undefined {
  let value: Partial<SavedThread> | null;
  try {
    value = JSON.parse(text) as Partial<SavedThread> | null;
  } catch {
    return undefined;
  }
  const lists = [value?.items, value?.messages, value?.seen, value?.sent, value?.lastChanges, value?.locations];
  if (value?.version !== 1 || !lists.every(Array.isArray) || typeof value.nextId !== "number") {
    return undefined;
  }
  return value as SavedThread;
}

export const RELOADED = "The window was reloaded while Worsley was working, so the request stopped there. Say “go on” to pick it up.";

/**
 * A thread caught in the middle of a request, as a stop would leave it: the
 * reply being written ends where it got to, for the model as in the panel;
 * every tool call has a result, as the API requires, and a tool still
 * running shows that it didn't finish; a command waiting for approval goes;
 * and a notice says why.
 */
export function interrupted(thread: SavedThread): SavedThread {
  const items: Item[] = [];
  let partial = "";
  for (const item of thread.items) {
    if (item.kind === "assistant" && item.streaming) {
      partial = item.text;
      items.push({ ...item, streaming: false });
    } else if (item.kind === "tool" && item.status === "running") {
      items.push({ ...item, status: "failed", detail: "The window was reloaded before this finished." });
    } else if (!(item.kind === "approval" && item.status === "pending")) {
      items.push(item);
    }
  }
  const messages = [...thread.messages];
  const last = messages.map((m) => m.role).lastIndexOf("assistant");
  const reply = messages[last];
  const calls = reply?.role === "assistant" ? (reply.tool_calls ?? []) : [];
  const answered = new Set(messages.slice(last + 1).flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
  for (const call of calls.filter((c) => !answered.has(c.id))) {
    messages.push({ role: "tool", tool_call_id: call.id, content: "Not run, or stopped partway: the window was reloaded." });
  }
  if (partial.trim() !== "") {
    messages.push({ role: "assistant", content: `${partial}\n\n[Stopped: the window was reloaded.]` });
  }
  items.push({ kind: "notice", id: `i${thread.nextId}`, level: "info", text: RELOADED });
  return { ...thread, items, messages, nextId: thread.nextId + 1 };
}

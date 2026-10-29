import type { Chat } from "./agent";
import { ContextOverflowError, type ChatMessage, type ToolMessage, type ToolSpec, type UserMessage } from "./chat";

/**
 * Keeping a thread inside the model's context window. Before each turn the
 * prompt's size is estimated in tokens, and when it nears the window room
 * is made:
 *
 * 1. Tool results are cleared, oldest first, until the prompt is well
 *    inside the limit: file contents, search hits and test output are most
 *    of a thread, and the model can fetch any of them again. The current
 *    request's latest few stay.
 * 2. Only if the prompt still doesn't fit does the model summarize the
 *    requests before the current one, and the summary replaces them: that
 *    costs a turn and loses detail.
 *
 * If the server still says the prompt is too long, room is made the same
 * way and the turn is tried once more. Making room costs a local server its
 * cached prompt from the first change on, so it happens only when needed,
 * and makes enough room that it isn't needed again soon.
 */

/** Tokens estimated from characters, at the rate the server's own counts show. */
export class TokenGauge {
  // A first guess for JSON-encoded chat; the first reply's count replaces it.
  private charsPerToken = 3.5;

  /** A prompt `chars` long, as promptSize measures it, came to `tokens`. */
  learn(chars: number, tokens: number): void {
    if (chars > 0 && tokens >= 100) {
      this.charsPerToken = chars / tokens;
    }
  }

  tokens(chars: number): number {
    return Math.ceil(chars / this.charsPerToken);
  }

  chars(tokens: number): number {
    return Math.floor(tokens * this.charsPerToken);
  }
}

export function promptSize(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): number {
  return JSON.stringify(messages).length + JSON.stringify(tools).length;
}

/** How much of a window a prompt may take: the rest is for the reply, reasoning and all. */
export function promptLimit(window: number): number {
  return window - Math.min(32_768, Math.max(4_096, Math.round(window * 0.15)));
}

/** Room is made down to this share of the limit, so that it lasts. */
const TARGET = 0.6;
/** The current request's latest tool results stay: they're what the model is working from. */
const KEEP_RECENT = 3;
/** Smaller results aren't worth clearing. */
const SMALL_RESULT = 400;
const CLEARED = "[Cleared to make room in the conversation:";

/**
 * What the model is asked for, in at most `words` words. An earlier
 * summary is folded in rather than carried along whole, or each summary
 * would be longer than the last.
 */
export function summaryRequest(words: number): string {
  return `This conversation is about to be shortened to fit your context window. Write a summary of everything before this message, in at most ${words} words, which will replace it: what the user asked for, what you found (with file paths and line numbers), what you changed and why, what is unfinished, and anything the user asked you to keep in mind. If it begins with a summary of its own, fold that in rather than repeating it. Don't call any tools.`;
}

const SUMMARY_TAG = "<earlier_conversation>";

function summaryMessage(summary: string | undefined): UserMessage {
  const body = summary ?? "(It couldn't be summarized, so it was dropped.)";
  return {
    role: "user",
    content: `${SUMMARY_TAG}\nThe start of this conversation was replaced by this summary, to fit the model's context window.\n${body}\n</earlier_conversation>`,
  };
}

/** The prompt's size in characters, and the size to bring it down to. */
interface Budget {
  chars: number;
  target: number;
}

/**
 * Replaces the tool results in messages[from, to) with a note of what each
 * one was, oldest first, until the budget is met; the last `keep` in that
 * range stay. How many were cleared.
 */
export function clearToolResults(messages: ChatMessage[], from: number, to: number, keep: number, budget: Budget): number {
  const candidates: number[] = [];
  for (let i = from; i < to; i++) {
    const m = messages[i];
    if (m?.role === "tool" && m.content.length > SMALL_RESULT && !m.content.startsWith(CLEARED)) {
      candidates.push(i);
    }
  }
  let cleared = 0;
  for (const i of candidates.slice(0, Math.max(0, candidates.length - keep))) {
    if (budget.chars <= budget.target) {
      break;
    }
    const message = messages[i] as ToolMessage;
    const note = `${CLEARED} it was the result of ${describeCall(messages, i)}. Call the tool again if you need it.]`;
    budget.chars -= JSON.stringify(message.content).length - JSON.stringify(note).length;
    message.content = note;
    cleared++;
  }
  return cleared;
}

/** `read_file {"path":"a.py"}`: the call the tool result at `index` answers. */
function describeCall(messages: readonly ChatMessage[], index: number): string {
  const id = (messages[index] as ToolMessage).tool_call_id;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const call = m.tool_calls?.find((c) => c.id === id);
      if (call !== undefined) {
        const args = call.function.arguments;
        return `${call.function.name} ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`;
      }
    }
  }
  return "a tool call";
}

/** What making room did, for the panel. */
export interface Compaction {
  /** Tool results cleared. */
  cleared: number;
  /** The requests before the current one were replaced by a summary. */
  summarized: boolean;
  /** Estimated tokens before and after. */
  before: number;
  after: number;
}

export interface Room {
  /** The model's window in tokens, when known. */
  window(): number | undefined;
  /** What a server said the window is, from an overflow error. */
  learnWindow(tokens: number): void;
  gauge: TokenGauge;
  /** Room was made: say so, and mend anything that relied on what went. */
  made(compaction: Compaction): void;
  status?(text: string): void;
}

/** `chat`, keeping the thread inside the model's window as described above. */
export function withRoom(chat: Chat, room: Room): Chat {
  return async (messages, tools, handlers, signal) => {
    await makeRoom(messages, tools, room, chat, signal, false);
    let size = promptSize(messages, tools);
    try {
      const turn = await chat(messages, tools, handlers, signal);
      if (turn.usage?.promptTokens !== undefined) {
        room.gauge.learn(size, turn.usage.promptTokens);
      }
      return turn;
    } catch (err) {
      if (!(err instanceof ContextOverflowError)) {
        throw err;
      }
      if (err.limit !== undefined) {
        room.learnWindow(err.limit);
      }
      if (err.promptTokens !== undefined) {
        room.gauge.learn(size, err.promptTokens);
      }
      const made = await makeRoom(messages, tools, room, chat, signal, true);
      if (made === undefined || made.after >= made.before) {
        throw err;
      }
      size = promptSize(messages, tools);
      const turn = await chat(messages, tools, handlers, signal);
      if (turn.usage?.promptTokens !== undefined) {
        room.gauge.learn(size, turn.usage.promptTokens);
      }
      return turn;
    }
  };
}

async function makeRoom(
  messages: ChatMessage[],
  tools: ToolSpec[],
  room: Room,
  chat: Chat,
  signal: AbortSignal,
  overflowed: boolean,
): Promise<Compaction | undefined> {
  const chars = promptSize(messages, tools);
  const before = room.gauge.tokens(chars);
  // With no window known, only an overflow says it's time, and the
  // prompt that overflowed is the measure.
  const window = room.window() ?? (overflowed ? Math.floor(before * 0.9) : undefined);
  if (window === undefined) {
    return undefined;
  }
  const limit = promptLimit(window);
  if (!overflowed && before <= limit) {
    return undefined;
  }
  room.status?.("Making room in the conversation…");
  const budget: Budget = { chars, target: room.gauge.chars(Math.floor(limit * TARGET)) };
  // The current request: its user message and everything after.
  const start = messages.map((m) => m.role).lastIndexOf("user");
  let cleared = clearToolResults(messages, 1, start, 0, budget);
  if (budget.chars > budget.target) {
    cleared += clearToolResults(messages, start, messages.length, KEEP_RECENT, budget);
  }
  let summarized = false;
  // A summary gets half the room the rest of the prompt leaves, and is
  // only worth writing if what it would replace is bigger than that.
  const kept = room.gauge.tokens(promptSize([messages[0] as ChatMessage, ...messages.slice(start)], tools));
  const summaryTokens = Math.min(4_000, Math.max(200, Math.floor((limit - kept) / 2)));
  const earlier = messages.slice(1, start);
  const replaceable = earlier.length > 0 && !(earlier.length === 1 && earlier[0]?.content?.startsWith(SUMMARY_TAG) === true);
  if (budget.chars > room.gauge.chars(limit) && replaceable && room.gauge.tokens(promptSize(earlier, [])) > summaryTokens) {
    room.status?.("Summarizing the earlier conversation to make room…");
    const summary = await summarize(messages.slice(0, start), Math.floor(summaryTokens * 0.75), tools, chat, signal);
    messages.splice(1, start - 1, summaryMessage(summary));
    summarized = true;
  }
  const compaction = { cleared, summarized, before, after: room.gauge.tokens(promptSize(messages, tools)) };
  room.made(compaction);
  return compaction;
}

/** The model's summary of `earlier`, or undefined if it gave none. */
async function summarize(earlier: ChatMessage[], words: number, tools: ToolSpec[], chat: Chat, signal: AbortSignal): Promise<string | undefined> {
  try {
    // The same tools, so a local server keeps its cached prompt for this.
    const turn = await chat([...earlier, { role: "user", content: summaryRequest(words) }], tools, {}, signal);
    const text = turn.content.trim();
    return text === "" ? undefined : text;
  } catch (err) {
    if (signal.aborted) {
      throw err;
    }
    return undefined;
  }
}

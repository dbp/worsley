import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Chat } from "../../src/core/agent";
import { ContextOverflowError, type ChatMessage, type ToolSpec } from "../../src/core/chat";
import { clearToolResults, promptLimit, promptSize, TokenGauge, withRoom, type Compaction, type Room } from "../../src/core/compact";

const tools: ToolSpec[] = [{ type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: {}, required: [] } } }];
const CHARS_PER_TOKEN = 4;
const system: ChatMessage = { role: "system", content: "You are a test." };
const tokensOf = (messages: ChatMessage[]): number => Math.ceil(promptSize(messages, tools) / CHARS_PER_TOKEN);

/**
 * A model whose server counts four characters, as promptSize measures
 * them, to a token. It records every prompt, refuses any over `refuseOver`
 * tokens, and summarizes when asked to.
 */
function model(refuseOver?: number): { chat: Chat; prompts: ChatMessage[][] } {
  const prompts: ChatMessage[][] = [];
  const chat: Chat = async (messages, specs) => {
    prompts.push(structuredClone(messages));
    const tokens = Math.ceil(promptSize(messages, specs) / CHARS_PER_TOKEN);
    if (refuseOver !== undefined && tokens > refuseOver) {
      throw new ContextOverflowError(`request (${tokens} tokens) exceeds the available context size (${refuseOver} tokens)`, refuseOver, tokens);
    }
    const last = messages[messages.length - 1];
    const content = last?.role === "user" && isSummaryRequest(last.content) ? "SUMMARY: asked about totals; read cart.py." : "Done.";
    return { message: { role: "assistant", content }, content, reasoning: "", toolCalls: [], usage: { promptTokens: tokens } };
  };
  return { chat, prompts };
}

const isSummaryRequest = (text: string | null): boolean => text?.startsWith("This conversation is about to be shortened") === true;

/** A request: the user's message, `reads` file reads of `size` characters each, and an answer. */
function request(n: number, reads: number, size: number, answer = `Answer ${n}.`): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: `<request mode="ask">\nQuestion ${n}\n</request>` }];
  for (let i = 0; i < reads; i++) {
    const id = `r${n}_${i}`;
    messages.push(
      { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: `{"path":"src/f${n}_${i}.py"}` } }] },
      { role: "tool", tool_call_id: id, content: `${n}.${i}:`.padEnd(size, "x") },
    );
  }
  messages.push({ role: "assistant", content: answer });
  return messages;
}

/** The request being worked on: its message and what has happened so far, with no answer yet. */
const current = (n: number, reads: number, size: number): ChatMessage[] => request(n, reads, size).slice(0, -1);

/** A Room that already knows the server's rate, recording what it's told. */
function roomFor(window: number | undefined): { room: Room; made: Compaction[]; learned: number[] } {
  const made: Compaction[] = [];
  const learned: number[] = [];
  let known = window;
  const gauge = new TokenGauge();
  gauge.learn(CHARS_PER_TOKEN * 1000, 1000);
  const room: Room = {
    window: () => known,
    learnWindow: (tokens) => {
      learned.push(tokens);
      known = tokens;
    },
    gauge,
    made: (compaction) => {
      made.push(compaction);
    },
  };
  return { room, made, learned };
}

describe("the prompt's limit", () => {
  it("leaves room for the reply", () => {
    assert.equal(promptLimit(262_144), 262_144 - 32_768);
    assert.equal(promptLimit(32_768), 32_768 - 4_915);
    assert.equal(promptLimit(8_192), 8_192 - 4_096);
  });

  it("is measured at the rate the server counts", () => {
    const gauge = new TokenGauge();
    gauge.learn(30_000, 10_000);
    assert.equal(gauge.tokens(9_000), 3_000);
    assert.equal(gauge.chars(100), 300);
    gauge.learn(500, 20);
    assert.equal(gauge.tokens(9_000), 3_000, "too small a sample to learn from");
  });
});

describe("making room", () => {
  it("leaves a thread that fits alone", async () => {
    const { chat, prompts } = model();
    const { room, made } = roomFor(100_000);
    const messages = [system, ...request(1, 2, 1_000), ...current(2, 0, 0)];
    const before = structuredClone(messages);
    await withRoom(chat, room)(messages, tools, {}, new AbortController().signal);
    assert.deepEqual(prompts[0], before);
    assert.deepEqual(made, []);
  });

  it("clears the oldest tool results first, and keeps the current request's latest", async () => {
    const { chat, prompts } = model();
    const messages = [system, ...request(1, 4, 8_000), ...current(2, 5, 8_000)];
    // A window the thread has just outgrown.
    const window = tokensOf(messages) + 1_000;
    assert.ok(tokensOf(messages) > promptLimit(window));
    const { room, made } = roomFor(window);
    await withRoom(chat, room)(messages, tools, {}, new AbortController().signal);
    const sent = prompts[0] ?? [];
    const cleared = sent.filter((m) => m.role === "tool").map((m) => m.content.startsWith("[Cleared"));
    // Request 1's four go first, then request 2's oldest, only as many as needed; its last three stay.
    assert.deepEqual(cleared.slice(0, 4), [true, true, true, true]);
    assert.deepEqual(cleared.slice(-3), [false, false, false]);
    assert.ok(cleared[4] === true, "the target needed one of the current request's too");
    assert.equal(made.length, 1);
    assert.deepEqual([made[0]?.cleared, made[0]?.summarized], [cleared.filter(Boolean).length, false]);
    assert.ok(tokensOf(sent) <= promptLimit(window) * 0.6 + 100);
    assert.equal(
      sent.find((m) => m.role === "tool")?.content,
      '[Cleared to make room in the conversation: it was the result of read_file {"path":"src/f1_0.py"}. Call the tool again if you need it.]',
    );
  });

  it("summarizes the earlier requests when clearing isn't enough", async () => {
    const { chat, prompts } = model();
    const long = "A long answer. ".repeat(2_000);
    const messages = [system, ...request(1, 0, 0, long), ...request(2, 0, 0, long), ...current(3, 0, 0)];
    const { room, made } = roomFor(tokensOf(messages));
    await withRoom(chat, room)(messages, tools, {}, new AbortController().signal);
    // First the summary of everything before the current request is asked for…
    assert.equal(prompts[0]?.length, 6);
    assert.ok(isSummaryRequest(prompts[0]?.at(-1)?.content ?? null));
    assert.match(prompts[0]?.at(-1)?.content ?? "", /in at most \d+ words/);
    // …then the turn goes ahead with the summary in place of what it covers.
    assert.deepEqual(
      prompts[1]?.map((m) => m.role),
      ["system", "user", "user"],
    );
    assert.match(prompts[1]?.[1]?.content ?? "", /^<earlier_conversation>\nThe start of this conversation was replaced by this summary.*\nSUMMARY: asked about totals; read cart.py.\n<\/earlier_conversation>$/s);
    assert.match(prompts[1]?.[2]?.content ?? "", /Question 3/);
    assert.equal(made[0]?.summarized, true);
    assert.deepEqual(messages, prompts[1], "the thread itself is shortened");
  });

  it("makes room and tries again when the server says the prompt is too long", async () => {
    const messages = [system, ...request(1, 6, 6_000), ...current(2, 2, 6_000)];
    const limit = Math.floor(tokensOf(messages) * 0.8);
    const { chat, prompts } = model(limit);
    // No window known: only the error says it.
    const { room, made, learned } = roomFor(undefined);
    const turn = await withRoom(chat, room)(messages, tools, {}, new AbortController().signal);
    assert.equal(turn.content, "Done.");
    assert.equal(prompts.length, 2);
    assert.deepEqual(learned, [limit]);
    assert.ok(tokensOf(prompts[1] ?? []) <= limit);
    assert.equal(made.length, 1);
  });

  it("doesn't summarize a summary on its own, or what is shorter than a summary would be", async () => {
    const { chat, prompts } = model();
    const summarized = [system, { role: "user" as const, content: "<earlier_conversation>\nThe start of this conversation was replaced.\nS.\n</earlier_conversation>" }];
    const lone = [...summarized, ...current(9, 0, 0)];
    const { room } = roomFor(Math.floor(tokensOf(lone) * 0.5));
    await withRoom(chat, room)(lone, tools, {}, new AbortController().signal);
    assert.equal(prompts.length, 1, "no summary was asked for");
    const short = [system, ...request(1, 0, 0, "Short."), { role: "user" as const, content: "x".repeat(30_000) }];
    await withRoom(chat, roomFor(Math.floor(tokensOf(short) * 0.9)).room)(short, tools, {}, new AbortController().signal);
    assert.equal(prompts.length, 2, "still none");
  });

  it("gives up when there is no room left to make", async () => {
    const messages = [system, { role: "user" as const, content: "x".repeat(40_000) }];
    const { chat } = model(1_000);
    const { room } = roomFor(undefined);
    await assert.rejects(withRoom(chat, room)(messages, tools, {}, new AbortController().signal), ContextOverflowError);
  });

  it("clears only results worth clearing, and each once", () => {
    const messages = [system, ...request(1, 3, 200), ...request(2, 2, 5_000)];
    const budget = { chars: 1_000_000, target: 0 };
    assert.equal(clearToolResults(messages, 0, messages.length, 0, budget), 2, "the 200-character results stay");
    assert.equal(clearToolResults(messages, 0, messages.length, 0, budget), 0);
  });
});

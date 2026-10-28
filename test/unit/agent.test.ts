import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { runAgent, type AgentHooks, type Chat } from "../../src/core/agent";
import { chatTurn, type AssistantMessage, type ChatMessage, type Turn } from "../../src/core/chat";
import { TOOLS, type ToolContext } from "../../src/core/tools";
import { lastOf, startFakeModel } from "../fakeModel";
import { DiskWorkspace, tempFolder, toolContext } from "./helpers";

type Step = { content?: string; calls?: [string, unknown][] } | Error;

/** A model that plays `steps` in order, one per turn. */
function scripted(steps: Step[]): { chat: Chat; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let n = 0;
  const chat: Chat = async (messages, _tools, handlers) => {
    seen.push(structuredClone(messages));
    const step = steps[n++];
    if (step === undefined) {
      throw new Error("the script ran out");
    }
    if (step instanceof Error) {
      throw step;
    }
    const content = step.content ?? "";
    if (content !== "") {
      handlers.content?.(content);
    }
    const toolCalls = (step.calls ?? []).map(([name, args], i) => ({
      id: `c${n}_${i}`,
      type: "function" as const,
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    }));
    const message: AssistantMessage = { role: "assistant", content: content === "" && toolCalls.length > 0 ? null : content };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    const turn: Turn = { message, content, reasoning: "", toolCalls, finishReason: toolCalls.length > 0 ? "tool_calls" : "stop" };
    return turn;
  };
  return { chat, seen };
}

function recorder(): { hooks: AgentHooks; log: string[] } {
  const log: string[] = [];
  return {
    log,
    hooks: {
      turnStarted: () => log.push("turn"),
      content: (d) => log.push(`content:${d}`),
      reasoning: () => {},
      status: () => {},
      turnFinished: () => log.push("finished"),
      toolStarted: (call, display) => log.push(`start:${call.function.name}:${display.summary}`),
      toolFinished: (call, outcome) => log.push(`done:${call.function.name}:${outcome.display.failed === true ? "failed" : "ok"}`),
    },
  };
}

const project = {
  "src/cart.py": "def total(items):\n    return sum(items)\n",
  "tests/test_cart.py": "from src.cart import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n",
};

function start(messages: ChatMessage[], text: string): ChatMessage[] {
  messages.push({ role: "system", content: "test" }, { role: "user", content: text });
  return messages;
}

describe("the agent loop", () => {
  it("runs the tools the model calls, gives it their results, and stops when it answers", async () => {
    const root = tempFolder(project);
    const { chat, seen } = scripted([
      { content: "Reading.", calls: [["read_file", { path: "src/cart.py" }], ["search", { pattern: "total" }]] },
      { calls: [["edit_file", { path: "src/cart.py", old_string: "return sum(items)", new_string: "return sum(items, 0)" }]] },
      { content: "Done: [total](src/cart.py#L1-L2)." },
    ]);
    const { hooks, log } = recorder();
    const messages = start([], "change it");
    const end = await runAgent({ chat, messages, tools: TOOLS, maxRounds: 10, context: toolContext(new DiskWorkspace(root)), hooks });
    assert.deepEqual(end, { reason: "done", finish: "stop" });
    assert.deepEqual(
      messages.slice(2).map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}` : m.role === "assistant" ? `assistant:${m.tool_calls?.length ?? 0}` : m.role)),
      ["assistant:2", "tool:c1_0", "tool:c1_1", "assistant:1", "tool:c2_0", "assistant:0"],
    );
    assert.match(lastOf({ model: "", messages: seen[1] as never }, "tool"), /^src\/cart.py:1: def total/);
    assert.equal(fs.readFileSync(path.join(root, "src/cart.py"), "utf8"), "def total(items):\n    return sum(items, 0)\n");
    assert.deepEqual(log, [
      "turn",
      "content:Reading.",
      "finished",
      "start:read_file:Reading src/cart.py",
      "done:read_file:ok",
      "start:search:Searching for “total”",
      "done:search:ok",
      "turn",
      "finished",
      "start:edit_file:Editing src/cart.py",
      "done:edit_file:ok",
      "turn",
      "content:Done: [total](src/cart.py#L1-L2).",
      "finished",
    ]);
  });

  it("refuses editing tools for an ask request, and tells the model why", async () => {
    const root = tempFolder(project);
    const { chat } = scripted([
      { calls: [["edit_file", { path: "src/cart.py", old_string: "sum", new_string: "max" }], ["run_command", { command: "touch made" }]] },
      { content: "I would change it like this…" },
    ]);
    const { hooks, log } = recorder();
    const messages = start([], "what would you change?");
    await runAgent({ chat, messages, tools: TOOLS, maxRounds: 10, context: toolContext(new DiskWorkspace(root), { mode: "ask" }), hooks });
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(results[0] ?? "", /^Refused: This is an ask request, so files can't change/);
    assert.match(results[1] ?? "", /^Refused: Commands can't run for an ask request/);
    assert.equal(fs.readFileSync(path.join(root, "src/cart.py"), "utf8"), project["src/cart.py"]);
    assert.equal(fs.existsSync(path.join(root, "made")), false);
    assert.ok(log.includes("done:edit_file:failed"));
  });

  it("answers calls to unknown tools, bad JSON and missing arguments with errors the model can fix", async () => {
    const { chat } = scripted([{ calls: [["delete_everything", {}], ["read_file", "{not json"], ["read_file", { start_line: 3 }], ["read_file", [1, 2]]] }, { content: "Sorry." }]);
    const messages = start([], "go");
    await runAgent({ chat, messages, tools: TOOLS, maxRounds: 10, context: toolContext(new DiskWorkspace(tempFolder(project))), hooks: recorder().hooks });
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(results[0] ?? "", /^Error: there is no tool called delete_everything. The tools are: list_files, search, /);
    assert.match(results[1] ?? "", /^Error: the arguments to read_file aren't valid JSON/);
    assert.equal(results[2], "Error: read_file needs path.");
    assert.match(results[3] ?? "", /must be a JSON object/);
  });

  it("stops after too many rounds", async () => {
    const steps: Step[] = Array.from({ length: 5 }, () => ({ calls: [["list_files", {}]] as [string, unknown][] }));
    const { chat } = scripted(steps);
    const end = await runAgent({ chat, messages: start([], "go"), tools: TOOLS, maxRounds: 3, context: toolContext(new DiskWorkspace(tempFolder(project))), hooks: recorder().hooks });
    assert.deepEqual(end, { reason: "rounds" });
  });

  it("reports the model's errors", async () => {
    const { chat } = scripted([new Error("Couldn't connect to http://x (ECONNREFUSED).")]);
    const end = await runAgent({ chat, messages: start([], "go"), tools: TOOLS, maxRounds: 3, context: toolContext(new DiskWorkspace(tempFolder(project))), hooks: recorder().hooks });
    assert.deepEqual(end, { reason: "error", message: "Couldn't connect to http://x (ECONNREFUSED)." });
  });

  it("stops a command when aborted, and still answers every call", async () => {
    const controller = new AbortController();
    const { chat } = scripted([{ calls: [["run_command", { command: "sleep 30" }], ["list_files", {}]] }]);
    const context: ToolContext = toolContext(new DiskWorkspace(tempFolder(project)), { signal: controller.signal, preapproved: () => true });
    const { hooks } = recorder();
    hooks.toolStarted = (call) => {
      if (call.function.name === "run_command") {
        setTimeout(() => controller.abort(), 100);
      }
    };
    const messages = start([], "go");
    const end = await runAgent({ chat, messages, tools: TOOLS, maxRounds: 3, context, hooks });
    assert.deepEqual(end, { reason: "aborted" });
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(results[0] ?? "", /^Stopped by the user after/);
    assert.equal(results[1], "Not run: the user stopped the request.");
  });

  it("keeps what was streamed when stopped mid-reply", async () => {
    const controller = new AbortController();
    const chat: Chat = async (_messages, _tools, handlers) => {
      handlers.content?.("Half an ans");
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const messages = start([], "go");
    const end = await runAgent({ chat, messages, tools: TOOLS, maxRounds: 3, context: toolContext(new DiskWorkspace(tempFolder(project)), { signal: controller.signal }), hooks: recorder().hooks });
    assert.deepEqual(end, { reason: "aborted" });
    assert.deepEqual(messages.at(-1), { role: "assistant", content: "Half an ans\n\n[Stopped by the user.]" });
  });
});

describe("the agent loop over HTTP", () => {
  const closers: (() => Promise<void>)[] = [];
  after(async () => {
    for (const close of closers) {
      await close();
    }
  });

  it("sends the tool results back with their ids, and the reasoning as it came", async () => {
    const model = await startFakeModel((_request, index) =>
      index === 0 ? { reasoning: "Look first.", toolCalls: [{ name: "read_file", arguments: { path: "src/cart.py" } }] } : { content: "It sums the items." },
    );
    closers.push(model.close);
    const messages = start([], "what does total do?");
    const end = await runAgent({
      chat: (m, t, h, s) => chatTurn({ baseUrl: model.url, model: "fake-small" }, m, t, h, s),
      messages,
      tools: TOOLS,
      maxRounds: 5,
      context: toolContext(new DiskWorkspace(tempFolder(project)), { mode: "ask" }),
      hooks: recorder().hooks,
    });
    assert.deepEqual(end, { reason: "done", finish: "stop" });
    const second = model.requests[1];
    assert.ok(second);
    const [, , assistant, tool] = second.messages;
    assert.equal(assistant?.role, "assistant");
    assert.equal((assistant as unknown as { reasoning_content: string }).reasoning_content, "Look first.");
    assert.equal(assistant?.tool_calls?.[0]?.id, "fake_0");
    assert.equal(tool?.role, "tool");
    assert.equal(tool?.tool_call_id, "fake_0");
    assert.match(tool?.content ?? "", /^src\/cart.py, lines 1-2 of 2:/);
    assert.equal(second.tools?.length, TOOLS.length, "every tool is offered in every mode");
  });
});

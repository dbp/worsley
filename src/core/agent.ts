import type { ChatMessage, ToolCall, ToolSpec, Turn, TurnHandlers } from "./chat";
import { errorText } from "./errorText";
import type { Args, Tool, ToolContext, ToolDisplay, ToolOutcome } from "./tools";

/**
 * The loop behind every request: ask the model, run the tools it calls,
 * give it their results, and go round again until it answers without
 * calling any.
 */

export type Chat = (messages: ChatMessage[], tools: ToolSpec[], handlers: TurnHandlers, signal: AbortSignal) => Promise<Turn>;

export interface AgentHooks {
  turnStarted(): void;
  content(delta: string): void;
  reasoning(delta: string): void;
  status(text: string): void;
  turnFinished(turn: Turn): void;
  toolStarted(call: ToolCall, display: ToolDisplay): void;
  toolFinished(call: ToolCall, outcome: ToolOutcome): void;
}

export type AgentEnd =
  | { reason: "done"; finish: string | undefined }
  | { reason: "aborted" }
  | { reason: "rounds" }
  | { reason: "error"; message: string };

export interface AgentOptions {
  chat: Chat;
  /** The thread so far, ending with the new request. The loop appends to it. */
  messages: ChatMessage[];
  tools: readonly Tool[];
  maxRounds: number;
  context: ToolContext;
  hooks: AgentHooks;
}

export async function runAgent(options: AgentOptions): Promise<AgentEnd> {
  const { chat, messages, tools, context, hooks } = options;
  const { signal } = context;
  const specs = tools.map((tool) => tool.spec);
  const byName = new Map(tools.map((tool) => [tool.spec.function.name, tool]));

  for (let round = 0; round < options.maxRounds; round++) {
    hooks.turnStarted();
    let partial = "";
    let turn: Turn;
    try {
      turn = await chat(
        messages,
        specs,
        {
          content: (delta) => {
            partial += delta;
            hooks.content(delta);
          },
          reasoning: (delta) => hooks.reasoning(delta),
          status: (text) => hooks.status(text),
          toolCall: (name) => hooks.status(`Calling ${name}…`),
        },
        signal,
      );
    } catch (err) {
      if (signal.aborted) {
        // What the user saw stays in the thread, so the next request follows on from it.
        if (partial !== "") {
          messages.push({ role: "assistant", content: `${partial}\n\n[Stopped by the user.]` });
        }
        return { reason: "aborted" };
      }
      return { reason: "error", message: errorText(err) };
    }
    messages.push(turn.message);
    hooks.turnFinished(turn);
    if (turn.toolCalls.length === 0) {
      return { reason: "done", finish: turn.finishReason };
    }
    // Every call gets a result, even once stopped: the API requires one.
    for (const call of turn.toolCalls) {
      const outcome = signal.aborted
        ? { content: "Not run: the user stopped the request.", display: { icon: "run" as const, summary: "", hidden: true } }
        : await runCall(call, byName, context, hooks);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
    if (signal.aborted) {
      return { reason: "aborted" };
    }
  }
  return { reason: "rounds" };
}

async function runCall(call: ToolCall, byName: ReadonlyMap<string, Tool>, context: ToolContext, hooks: AgentHooks): Promise<ToolOutcome> {
  const name = call.function.name;
  const fail = (content: string, display: ToolDisplay): ToolOutcome => {
    const outcome = { content, display: { ...display, failed: true } };
    hooks.toolStarted(call, outcome.display);
    hooks.toolFinished(call, outcome);
    return outcome;
  };

  const tool = byName.get(name);
  if (tool === undefined) {
    const names = [...byName.keys()].join(", ");
    return fail(`Error: there is no tool called ${name}. The tools are: ${names}.`, { icon: "run", summary: `Called a tool that doesn't exist: ${name}` });
  }
  let args: Args;
  try {
    const raw = call.function.arguments.trim();
    const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("the arguments must be a JSON object");
    }
    args = parsed as Args;
  } catch (err) {
    return fail(`Error: the arguments to ${name} aren't valid JSON (${errorText(err)}). Call it again with a JSON object.`, {
      icon: tool.describe({}).icon,
      summary: `Called ${name} with arguments that aren't JSON`,
    });
  }
  const display = tool.describe(args);
  if (!tool.modes.includes(context.mode)) {
    return fail(`Refused: ${tool.refusal ?? `${name} isn't available for a ${context.mode} request.`}`, {
      ...display,
      summary: `Refused ${name}: not allowed in ${context.mode === "ask" ? "Ask" : "Change"} mode`,
      hidden: false,
    });
  }
  const missing = requiredOf(tool).filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return fail(`Error: ${name} needs ${missing.join(", ")}.`, { ...display, summary: `Called ${name} without ${missing.join(", ")}`, hidden: false });
  }

  hooks.toolStarted(call, display);
  let outcome: ToolOutcome;
  try {
    outcome = await tool.run(args, context);
  } catch (err) {
    const message = errorText(err);
    const firstLine = message.split("\n")[0] ?? "";
    outcome = {
      content: `Error: ${message}`,
      display: {
        ...display,
        summary: `${display.summary}: ${firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine}`,
        detail: message,
        failed: true,
        hidden: false,
      },
    };
  }
  hooks.toolFinished(call, outcome);
  return outcome;
}

function requiredOf(tool: Tool): string[] {
  const required = (tool.spec.function.parameters as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
}

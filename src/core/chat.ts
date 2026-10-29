import { errorText } from "./errorText";
import { sseData } from "./sse";

/**
 * One streamed turn of an OpenAI-compatible chat completion, the API that
 * both llama.cpp's `llama-server` and OpenRouter serve.
 */

/** A call the model asks for. `arguments` is JSON text, as the API sends it. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

/**
 * Besides content and tool calls, the model's reasoning, in whichever fields
 * the server sent it: `reasoning_content` from llama.cpp, `reasoning` and
 * `reasoning_details` from OpenRouter. They go back to the server as they
 * came: some models need them to carry their reasoning across tool calls,
 * and llama.cpp then finds the prompt it has cached.
 */
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: unknown[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Endpoint {
  /** Up to and including `/v1` (or OpenRouter's `/api/v1`). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Merged into the request body, under the fields this module sets. */
  extraBody?: Record<string, unknown>;
}

export interface Usage {
  promptTokens?: number;
  /** Prompt tokens the server had cached from an earlier turn. */
  cachedTokens?: number;
  completionTokens?: number;
  /** Generation speed, when the server reports it (llama.cpp does). */
  tokensPerSecond?: number;
  /** In US dollars, when the server reports it (OpenRouter does). */
  cost?: number;
}

export interface Turn {
  /** The reply as it goes back into the history. */
  message: AssistantMessage;
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: Usage;
}

export interface TurnHandlers {
  content?(delta: string): void;
  reasoning?(delta: string): void;
  /** The model has started writing a call to this tool. */
  toolCall?(name: string): void;
  /** Something worth showing while waiting, such as a model loading. */
  status?(text: string): void;
}

export class ChatError extends Error {}

/**
 * The prompt didn't fit the model's context window. `limit` is the
 * window's size, and `promptTokens` the prompt's, when the server says.
 */
export class ContextOverflowError extends ChatError {
  constructor(
    message: string,
    readonly limit: number | undefined,
    readonly promptTokens: number | undefined,
  ) {
    super(message);
  }
}

const OVERFLOW = /exceed_context_size|context_length_exceeded|exceeds the (?:available )?context|maximum context length|context (?:window|length) (?:is )?exceeded|prompt is too long|too many (?:input )?tokens/i;

/**
 * The error as a ContextOverflowError when that is what it says: in
 * llama.cpp's fields (`n_ctx`, `n_prompt_tokens`) or in the wording other
 * servers use, such as "maximum context length is 131072 tokens" or
 * "prompt is too long: 210000 tokens > 200000 maximum".
 */
export function asOverflow(message: string, body: unknown): ContextOverflowError | undefined {
  const fields = (body as { error?: { type?: unknown; n_ctx?: unknown; n_prompt_tokens?: unknown } } | undefined)?.error;
  const typed = fields?.type === "exceed_context_size_error";
  if (!typed && !OVERFLOW.test(message)) {
    return undefined;
  }
  const number = (pattern: RegExp): number | undefined => {
    const found = pattern.exec(message)?.[1];
    return found === undefined ? undefined : Number(found.replace(/,/g, ""));
  };
  const limit =
    (typeof fields?.n_ctx === "number" ? fields.n_ctx : undefined) ??
    number(/context size \((\d[\d,]*) tokens\)/i) ??
    number(/maximum context length is (\d[\d,]*)/i) ??
    number(/> (\d[\d,]*) maximum/i) ??
    number(/context (?:window|length) of (\d[\d,]*)/i);
  const prompt =
    (typeof fields?.n_prompt_tokens === "number" ? fields.n_prompt_tokens : undefined) ??
    number(/request \((\d[\d,]*) tokens\)/i) ??
    number(/requested (?:about )?(\d[\d,]*) tokens/i) ??
    number(/too long: (\d[\d,]*) tokens/i);
  return new ContextOverflowError(message, limit, prompt);
}

/**
 * `over` merged into `base`, as a request's extra body for its mode is
 * merged into the backend's: objects key by key all the way down, so
 * `{"chat_template_kwargs": {"enable_thinking": true}}` changes that one
 * key and keeps the rest; anything else is replaced.
 */
export function mergeBodies(
  base: Record<string, unknown> | undefined,
  over: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (over === undefined || base === undefined) {
    return over ?? base;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const old = merged[key];
    merged[key] = isObject(old) && isObject(value) ? mergeBodies(old, value) : value;
  }
  return merged;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How long to keep retrying while a llama.cpp server says it is loading the model. */
const LOADING_LIMIT_MS = 10 * 60_000;

export async function chatTurn(
  endpoint: Endpoint,
  messages: ChatMessage[],
  tools: ToolSpec[],
  handlers: TurnHandlers,
  signal: AbortSignal,
): Promise<Turn> {
  const body = {
    ...endpoint.extraBody,
    model: endpoint.model,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
  const response = await post(endpoint, body, handlers, signal);
  if (response.body === null) {
    throw new ChatError(`${endpoint.baseUrl} sent an empty reply.`);
  }

  const calls: { id: string; name: string; arguments: string }[] = [];
  let content = "";
  const reasoningByField = new Map<"reasoning_content" | "reasoning", string>();
  // Some servers send the same text under both names; it is shown once.
  let shownField: "reasoning_content" | "reasoning" | undefined;
  const details: Record<string, unknown>[] = [];
  let finishReason: string | undefined;
  let usage: Usage | undefined;

  for await (const data of sseData(response.body)) {
    if (data === "[DONE]") {
      break;
    }
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue;
    }
    if (chunk.error !== undefined) {
      const message = describeError(chunk.error) ?? "The server reported an error mid-reply.";
      throw asOverflow(message, chunk) ?? new ChatError(message);
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta !== undefined) {
      if (typeof delta.content === "string" && delta.content !== "") {
        content += delta.content;
        handlers.content?.(delta.content);
      }
      for (const field of ["reasoning_content", "reasoning"] as const) {
        const piece = delta[field];
        if (typeof piece === "string" && piece !== "") {
          shownField ??= field;
          reasoningByField.set(field, (reasoningByField.get(field) ?? "") + piece);
          if (field === shownField) {
            handlers.reasoning?.(piece);
          }
        }
      }
      if (Array.isArray(delta.reasoning_details)) {
        mergeDetails(details, delta.reasoning_details);
      }
      for (const piece of delta.tool_calls ?? []) {
        let index: number;
        if (typeof piece.index === "number") {
          index = piece.index;
        } else {
          // Without an index, a new id starts a new call.
          const last = calls[calls.length - 1];
          const fresh = typeof piece.id === "string" && piece.id !== "" && last?.id !== "" && piece.id !== last?.id;
          index = last === undefined || fresh ? calls.length : calls.length - 1;
        }
        const call = (calls[index] ??= { id: "", name: "", arguments: "" });
        if (typeof piece.id === "string" && call.id === "") {
          call.id = piece.id;
        }
        const name = piece.function?.name;
        if (typeof name === "string" && name !== "" && call.name === "") {
          call.name = name;
          handlers.toolCall?.(name);
        }
        const args = piece.function?.arguments;
        if (typeof args === "string") {
          call.arguments += args;
        } else if (args !== undefined && args !== null) {
          call.arguments += JSON.stringify(args);
        }
      }
    }
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = { ...usage, ...readUsage(chunk.usage) };
    }
    if (chunk.timings !== undefined) {
      usage = { ...usage, ...readTimings(chunk.timings) };
    }
  }

  let toolCalls: ToolCall[] = calls
    .filter((call) => call !== undefined && call.name !== "")
    .map((call, i) => ({
      id: call.id !== "" ? call.id : `call_${Date.now().toString(36)}_${i}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  if (toolCalls.length === 0) {
    const written = toolCallsInText(content);
    if (written !== undefined) {
      toolCalls = written.calls;
      content = written.rest;
    }
  }

  const message: AssistantMessage = {
    role: "assistant",
    content: content === "" && toolCalls.length > 0 ? null : content,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  for (const [field, text] of reasoningByField) {
    message[field] = text;
  }
  if (details.length > 0) {
    message.reasoning_details = details;
  }
  const reasoning = shownField === undefined ? "" : (reasoningByField.get(shownField) ?? "");
  return { message, content, reasoning, toolCalls, finishReason, usage };
}

export interface ModelInfo {
  id: string;
  /** Context size, whether it is loaded, and so on, for a picker. */
  detail: string;
}

/**
 * The models an endpoint offers, from its `/models`. From OpenRouter, only
 * those that take tools, since Worsley can't work without them.
 */
export async function listModels(endpoint: Endpoint, signal: AbortSignal): Promise<ModelInfo[]> {
  const url = `${trimSlash(endpoint.baseUrl)}/models`;
  let response: Response;
  try {
    response = await fetch(url, { headers: headersFor(endpoint), signal });
  } catch (err) {
    if (signal.aborted) {
      throw err;
    }
    throw new ChatError(connectionError(endpoint.baseUrl, err));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ChatError(`${url} answered ${response.status}: ${describeError(text) ?? response.statusText}`);
  }
  const json = (await response.json()) as { data?: unknown };
  const models: ModelInfo[] = [];
  for (const entry of Array.isArray(json.data) ? json.data : []) {
    if (typeof entry !== "object" || entry === null || typeof (entry as { id?: unknown }).id !== "string") {
      continue;
    }
    const model = entry as {
      id: string;
      context_length?: number;
      supported_parameters?: string[];
      status?: { value?: string } | string;
    };
    if (Array.isArray(model.supported_parameters) && !model.supported_parameters.includes("tools")) {
      continue;
    }
    const parts: string[] = [];
    const status = typeof model.status === "string" ? model.status : model.status?.value;
    if (typeof status === "string") {
      parts.push(status);
    }
    if (typeof model.context_length === "number") {
      parts.push(`${Math.round(model.context_length / 1024)}K context`);
    }
    models.push({ id: model.id, detail: parts.join(" · ") });
  }
  return models;
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: Record<string, unknown>[];
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: unknown };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Record<string, unknown> | null;
  timings?: Record<string, unknown>;
  error?: unknown;
}

async function post(
  endpoint: Endpoint,
  body: unknown,
  handlers: TurnHandlers,
  signal: AbortSignal,
): Promise<Response> {
  const url = `${trimSlash(endpoint.baseUrl)}/chat/completions`;
  const started = Date.now();
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headersFor(endpoint) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        throw err;
      }
      throw new ChatError(connectionError(endpoint.baseUrl, err));
    }
    if (response.ok) {
      return response;
    }
    const text = await response.text().catch(() => "");
    const message = describeError(text) ?? response.statusText;
    if (response.status === 503 && /loading/i.test(message) && Date.now() - started < LOADING_LIMIT_MS) {
      handlers.status?.(`Loading ${endpoint.model}…`);
      await sleep(2000, signal);
      continue;
    }
    const full = `${endpoint.baseUrl} answered ${response.status}: ${message}`;
    throw asOverflow(full, parseJson(text)) ?? new ChatError(full);
  }
}

/**
 * The model's context window in tokens, as its server reports it: the
 * running size (`meta.n_ctx`) or the model's (`context_length`) in its entry
 * of `/models`, which llama.cpp's router and OpenRouter both give; then
 * llama.cpp's `/props`, which a single-model server answers. Undefined when
 * neither says.
 */
export async function contextWindowOf(endpoint: Endpoint, signal: AbortSignal): Promise<number | undefined> {
  const positive = (n: unknown): number | undefined => (typeof n === "number" && n > 0 ? n : undefined);
  const get = async (url: string): Promise<unknown> => {
    try {
      const response = await fetch(url, { headers: headersFor(endpoint), signal });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const base = trimSlash(endpoint.baseUrl);
  const models = (await get(`${base}/models`)) as { data?: unknown } | undefined;
  const entry = (Array.isArray(models?.data) ? models.data : []).find((m: { id?: unknown } | null) => m?.id === endpoint.model) as
    | { context_length?: unknown; meta?: { n_ctx?: unknown }; top_provider?: { context_length?: unknown }; max_model_len?: unknown }
    | undefined;
  const listed = positive(entry?.meta?.n_ctx) ?? positive(entry?.top_provider?.context_length) ?? positive(entry?.context_length) ?? positive(entry?.max_model_len);
  if (listed !== undefined) {
    return listed;
  }
  const props = (await get(`${base.replace(/\/v1$/, "")}/props?model=${encodeURIComponent(endpoint.model)}`)) as
    | { default_generation_settings?: { n_ctx?: unknown } }
    | undefined;
  return positive(props?.default_generation_settings?.n_ctx);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headersFor(endpoint: Endpoint): Record<string, string> {
  return {
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    ...endpoint.headers,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `Couldn't connect to …`, with the system's reason, such as ECONNREFUSED. */
function connectionError(baseUrl: string, err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const reason = cause?.code ?? cause?.message ?? errorText(err);
  return `Couldn't connect to ${baseUrl} (${reason}).`;
}

/** The message in an error body such as `{"error": {"message": …}}`, if there is one. */
function describeError(error: unknown): string | undefined {
  let value = error;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") {
      return undefined;
    }
    try {
      value = JSON.parse(text);
    } catch {
      return text.slice(0, 500);
    }
  }
  if (typeof value !== "object" || value === null) {
    return String(value);
  }
  const inner = (value as { error?: unknown }).error ?? value;
  if (typeof inner === "string") {
    return inner;
  }
  const message = (inner as { message?: unknown }).message;
  if (typeof message === "string") {
    // OpenRouter puts the provider's own message in metadata.raw.
    const raw = (inner as { metadata?: { raw?: unknown } }).metadata?.raw;
    return typeof raw === "string" && raw !== "" && !message.includes(raw) ? `${message} (${raw.slice(0, 300)})` : message;
  }
  return JSON.stringify(inner).slice(0, 500);
}

function readUsage(raw: Record<string, unknown>): Usage {
  const usage: Usage = {};
  if (typeof raw.prompt_tokens === "number") {
    usage.promptTokens = raw.prompt_tokens;
  }
  if (typeof raw.completion_tokens === "number") {
    usage.completionTokens = raw.completion_tokens;
  }
  const cached = (raw.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens;
  if (typeof cached === "number") {
    usage.cachedTokens = cached;
  }
  if (typeof raw.cost === "number") {
    usage.cost = raw.cost;
  }
  return usage;
}

/** llama.cpp's own counts: `prompt_n` tokens processed on top of `cache_n` cached. */
function readTimings(raw: Record<string, unknown>): Usage {
  const usage: Usage = {};
  if (typeof raw.predicted_per_second === "number" && Number.isFinite(raw.predicted_per_second)) {
    usage.tokensPerSecond = raw.predicted_per_second;
  }
  if (typeof raw.cache_n === "number") {
    usage.cachedTokens = raw.cache_n;
    if (typeof raw.prompt_n === "number") {
      usage.promptTokens = raw.prompt_n + raw.cache_n;
    }
  }
  if (typeof raw.predicted_n === "number") {
    usage.completionTokens = raw.predicted_n;
  }
  return usage;
}

/**
 * OpenRouter streams `reasoning_details` in pieces, each with the `index` of
 * the entry it belongs to. Pieces of one entry are joined, text fields end
 * to end.
 */
function mergeDetails(into: Record<string, unknown>[], pieces: Record<string, unknown>[]): void {
  for (const piece of pieces) {
    if (typeof piece !== "object" || piece === null) {
      continue;
    }
    const index = typeof piece.index === "number" ? piece.index : into.length;
    const entry = into[index];
    if (entry === undefined) {
      into[index] = { ...piece };
      continue;
    }
    for (const [key, value] of Object.entries(piece)) {
      const old = entry[key];
      entry[key] = typeof old === "string" && typeof value === "string" && key !== "type" && key !== "format" && key !== "id" ? old + value : value;
    }
  }
}

/**
 * Tool calls a model wrote as text, in the `<tool_call>{"name": …,
 * "arguments": …}</tool_call>` form Qwen and Hermes models use, for a server
 * that passed them through unparsed. Undefined when there are none.
 */
export function toolCallsInText(text: string): { calls: ToolCall[]; rest: string } | undefined {
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1] ?? "") as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== "string") {
        return undefined;
      }
      const args = typeof parsed.arguments === "string" ? parsed.arguments : JSON.stringify(parsed.arguments ?? {});
      calls.push({ id: `call_text_${calls.length}`, type: "function", function: { name: parsed.name, arguments: args } });
    } catch {
      return undefined;
    }
  }
  if (calls.length === 0) {
    return undefined;
  }
  return { calls, rest: text.replace(pattern, "").trim() };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

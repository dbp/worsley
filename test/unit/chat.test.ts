import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { asOverflow, chatTurn, ContextOverflowError, contextWindowOf, listModels, mergeBodies, refusedKey, bareKey, spendOf, toolCallsInText, type ChatMessage, type Endpoint } from "../../src/core/chat";
import { startFakeModel } from "../fakeModel";

const messages: ChatMessage[] = [
  { role: "system", content: "You are a test." },
  { role: "user", content: "Hello" },
];

/** A server whose replies are written out by hand, chunk by chunk. */
async function rawServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("a streamed chat turn", () => {
  const closers: (() => Promise<void>)[] = [];
  after(async () => {
    for (const close of closers) {
      await close();
    }
  });

  it("gathers content, reasoning and tool calls, and puts them back as the server sent them", async () => {
    const model = await startFakeModel(() => ({
      reasoning: "The user wants a file.",
      content: "Let me look.",
      toolCalls: [
        { name: "read_file", arguments: { path: "src/a.py" } },
        { name: "search", arguments: { pattern: "def main" } },
      ],
    }));
    closers.push(model.close);
    const seen = { content: "", reasoning: "", calls: [] as string[] };
    const turn = await chatTurn(
      { baseUrl: `${model.url}/`, model: "fake-small", apiKey: "k", extraBody: { temperature: 0.2, model: "ignored" } },
      messages,
      [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }],
      {
        content: (d) => (seen.content += d),
        reasoning: (d) => (seen.reasoning += d),
        toolCall: (name) => seen.calls.push(name),
      },
      new AbortController().signal,
    );
    assert.equal(turn.content, "Let me look.");
    assert.equal(seen.content, "Let me look.");
    assert.equal(seen.reasoning, "The user wants a file.");
    assert.deepEqual(seen.calls, ["read_file", "search"]);
    assert.deepEqual(
      turn.toolCalls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]),
      [
        ["fake_0", "read_file", { path: "src/a.py" }],
        ["fake_1", "search", { pattern: "def main" }],
      ],
    );
    assert.equal(turn.finishReason, "tool_calls");
    assert.deepEqual(turn.message, {
      role: "assistant",
      content: "Let me look.",
      tool_calls: turn.toolCalls,
      reasoning_content: "The user wants a file.",
    });
    assert.deepEqual(turn.usage, { promptTokens: 1200, completionTokens: 34, cachedTokens: 1000, tokensPerSecond: 42.5 });

    const request = model.requests[0];
    assert.equal(request?.model, "fake-small", "the endpoint's model wins over extraBody's");
    assert.equal(request?.temperature, 0.2);
    assert.equal(request?.stream, true);
    assert.equal(request?.tools?.[0]?.function.name, "read_file");
  });

  it("sends the key, and leaves tools out when there are none", async () => {
    let auth: string | undefined;
    let body: Record<string, unknown> = {};
    const server = await rawServer((req, res) => {
      auth = req.headers.authorization;
      let text = "";
      req.on("data", (c: Buffer) => (text += c.toString()));
      req.on("end", () => {
        body = JSON.parse(text) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    closers.push(server.close);
    const turn = await chatTurn({ baseUrl: server.url, model: "m", apiKey: "sk-test" }, messages, [], {}, new AbortController().signal);
    assert.equal(auth, "Bearer sk-test");
    assert.equal("tools" in body, false);
    assert.deepEqual(turn.message, { role: "assistant", content: "hi" });
  });

  it("merges OpenRouter's reasoning details and keeps both reasoning fields", async () => {
    const server = await rawServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { reasoning: "Think", reasoning_details: [{ type: "reasoning.text", text: "Think", index: 0 }] } }] },
        { choices: [{ delta: { reasoning: "ing.", reasoning_details: [{ type: "reasoning.text", text: "ing.", index: 0, signature: "sig" }] } }] },
        { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } },
      ];
      res.end(`: OPENROUTER PROCESSING\n\n${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`);
    });
    closers.push(server.close);
    const turn = await chatTurn({ baseUrl: server.url, model: "m" }, messages, [], {}, new AbortController().signal);
    assert.equal(turn.reasoning, "Thinking.");
    assert.equal(turn.message.reasoning, "Thinking.");
    assert.deepEqual(turn.message.reasoning_details, [{ type: "reasoning.text", text: "Thinking.", index: 0, signature: "sig" }]);
    assert.equal(turn.usage?.cost, 0.0001);
  });

  it("reports HTTP errors with the server's message, and mid-stream errors too", async () => {
    const model = await startFakeModel(() => ({ status: 400, errorMessage: "tools are not supported" }));
    closers.push(model.close);
    await assert.rejects(chatTurn({ baseUrl: model.url, model: "m" }, messages, [], {}, new AbortController().signal), /answered 400: tools are not supported/);

    const server = await rawServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"par"}}]}\n\ndata: {"error":{"message":"Provider returned error","metadata":{"raw":"overloaded"}}}\n\n');
    });
    closers.push(server.close);
    await assert.rejects(chatTurn({ baseUrl: server.url, model: "m" }, messages, [], {}, new AbortController().signal), /Provider returned error \(overloaded\)/);
  });

  it("says when the server turned the request away for want of a key", async () => {
    for (const status of [401, 403]) {
      const model = await startFakeModel(() => ({ status, errorMessage: "Invalid API key" }));
      closers.push(model.close);
      await assert.rejects(chatTurn({ baseUrl: model.url, model: "m" }, messages, [], {}, new AbortController().signal), refusedKey);
    }
    const server = await rawServer((req, res) => {
      res.writeHead(req.headers.authorization === "Bearer sesame" ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    closers.push(server.close);
    await assert.rejects(listModels({ baseUrl: server.url, model: "m" }, new AbortController().signal), refusedKey);
    assert.deepEqual(
      (await listModels({ baseUrl: server.url, model: "m", apiKey: "sesame" }, new AbortController().signal)).map((m) => m.id),
      ["m"],
    );
    // A key copied with its header's "Bearer " still goes as one bearer.
    assert.deepEqual(
      (await listModels({ baseUrl: server.url, model: "m", apiKey: "Bearer sesame" }, new AbortController().signal)).map((m) => m.id),
      ["m"],
    );
    assert.deepEqual(["  sk-unsloth-1 ", "Bearer sk-unsloth-1", "bearer   sk-unsloth-1\n"].map(bareKey), ["sk-unsloth-1", "sk-unsloth-1", "sk-unsloth-1"]);
    const other = await startFakeModel(() => ({ status: 400, errorMessage: "bad request" }));
    closers.push(other.close);
    await assert.rejects(chatTurn({ baseUrl: other.url, model: "m" }, messages, [], {}, new AbortController().signal), (err: unknown) => !refusedKey(err));
  });

  it("asks what the key has spent, as OpenRouter's /key says", async () => {
    const server = await rawServer((req, res) => {
      if (req.url !== "/v1/key" || req.headers.authorization !== "Bearer sesame") {
        res.writeHead(req.url === "/v1/key" ? 401 : 404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { label: "test", usage: 40.1, usage_daily: 0.4237, usage_weekly: 1.5, usage_monthly: 3.25 } }));
    });
    closers.push(server.close);
    const signal = new AbortController().signal;
    assert.deepEqual(await spendOf({ baseUrl: server.url, model: "m", apiKey: "sesame" }, signal), { today: 0.4237, week: 1.5, month: 3.25 });
    assert.equal(await spendOf({ baseUrl: server.url, model: "m" }, signal), undefined, "without the key");
    const plain = await rawServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    closers.push(plain.close);
    assert.equal(await spendOf({ baseUrl: plain.url, model: "m", apiKey: "k" }, signal), undefined, "from a server that doesn't say");
  });

  it("waits while llama.cpp is loading the model", async () => {
    let calls = 0;
    const statuses: string[] = [];
    const server = await rawServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}');
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\n');
    });
    closers.push(server.close);
    const turn = await chatTurn({ baseUrl: server.url, model: "big" }, messages, [], { status: (s) => statuses.push(s) }, new AbortController().signal);
    assert.equal(turn.content, "ready");
    assert.equal(calls, 2);
    assert.deepEqual(statuses, ["Loading big…"]);
  });

  it("says plainly when nothing is listening", async () => {
    const endpoint: Endpoint = { baseUrl: "http://127.0.0.1:4/v1", model: "m" };
    await assert.rejects(chatTurn(endpoint, messages, [], {}, new AbortController().signal), /Couldn't connect to http:\/\/127\.0\.0\.1:4\/v1 \(ECONNREFUSED\)/);
  });

  it("stops when aborted", async () => {
    const server = await rawServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"slow"}}]}\n\n');
      // Never ends.
    });
    closers.push(server.close);
    const controller = new AbortController();
    const turn = chatTurn({ baseUrl: server.url, model: "m" }, messages, [], { content: () => controller.abort() }, controller.signal);
    await assert.rejects(turn, (err: Error) => err.name === "AbortError");
  });

  it("lists models, leaving out OpenRouter's that take no tools", async () => {
    const model = await startFakeModel(() => ({}));
    closers.push(model.close);
    const models = await listModels({ baseUrl: model.url, model: "m" }, new AbortController().signal);
    assert.deepEqual(models, [
      { id: "fake-small", detail: "32K context" },
      { id: "fake-large", detail: "128K context" },
    ]);

    const server = await rawServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "a/tools", supported_parameters: ["tools", "temperature"] },
            { id: "b/none", supported_parameters: ["temperature"] },
            { id: "local", status: { value: "loaded" } },
          ],
        }),
      );
    });
    closers.push(server.close);
    const listed = await listModels({ baseUrl: server.url, model: "m" }, new AbortController().signal);
    assert.deepEqual(listed, [
      { id: "a/tools", detail: "" },
      { id: "local", detail: "loaded" },
    ]);
  });
});

describe("a prompt too long for the model", () => {
  it("is recognised in each server's words, with the sizes they give", () => {
    const llama = { error: { code: 400, message: "request (1283602 tokens) exceeds the available context size (262144 tokens), try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 1283602, n_ctx: 262144 } };
    const fromLlama = asOverflow(`x answered 400: ${llama.error.message}`, llama);
    assert.deepEqual([fromLlama?.limit, fromLlama?.promptTokens], [262144, 1283602]);
    const openai = asOverflow("This endpoint's maximum context length is 131,072 tokens. However, you requested about 140000 tokens (139000 of text input).", undefined);
    assert.deepEqual([openai?.limit, openai?.promptTokens], [131072, 140000]);
    const anthropic = asOverflow("prompt is too long: 210000 tokens > 200000 maximum", undefined);
    assert.deepEqual([anthropic?.limit, anthropic?.promptTokens], [200000, 210000]);
    const bare = asOverflow("context_length_exceeded", undefined);
    assert.ok(bare instanceof ContextOverflowError);
    assert.deepEqual([bare.limit, bare.promptTokens], [undefined, undefined]);
    assert.equal(asOverflow("Rate limit exceeded: try again in 20s", undefined), undefined);
  });

  it("makes chatTurn fail with a ContextOverflowError", async () => {
    const server = await rawServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":{"code":400,"message":"request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":8192}}');
    });
    try {
      await assert.rejects(
        chatTurn({ baseUrl: server.url, model: "m" }, messages, [], {}, new AbortController().signal),
        (err: unknown) => err instanceof ContextOverflowError && err.limit === 8192 && err.promptTokens === 9000 && /answered 400: request \(9000 tokens\)/.test(err.message),
      );
    } finally {
      await server.close();
    }
  });
});

describe("a model's context window", () => {
  it("comes from its entry in /models: the running size first, then the model's", async () => {
    const server = await rawServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "loaded", context_length: 262144, meta: { n_ctx: 131072 } },
            { id: "routed", context_length: 1000000, top_provider: { context_length: 163840 } },
            { id: "listed", context_length: 32768 },
            { id: "bare" },
          ],
        }),
      );
      void req;
    });
    try {
      const window = (model: string): Promise<number | undefined> => contextWindowOf({ baseUrl: server.url, model }, new AbortController().signal);
      assert.equal(await window("loaded"), 131072);
      assert.equal(await window("routed"), 163840);
      assert.equal(await window("listed"), 32768);
      assert.equal(await window("bare"), undefined);
      assert.equal(await window("unknown"), undefined);
    } finally {
      await server.close();
    }
  });

  it("comes from llama.cpp's /props when /models doesn't say", async () => {
    const asked: string[] = [];
    const server = await rawServer((req, res) => {
      asked.push(req.url ?? "");
      if (req.url?.startsWith("/props")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"default_generation_settings":{"n_ctx":16384}}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      assert.equal(await contextWindowOf({ baseUrl: server.url, model: "a b" }, new AbortController().signal), 16384);
      assert.deepEqual(asked, ["/v1/models", "/props?model=a%20b"]);
    } finally {
      await server.close();
    }
  });
});

describe("a mode's extra body", () => {
  it("is merged over the backend's, object by object", () => {
    const backend = { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }, temperature: 0.2, stop: ["a"] };
    assert.deepEqual(mergeBodies(backend, { chat_template_kwargs: { enable_thinking: true }, stop: ["b"] }), {
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      temperature: 0.2,
      stop: ["b"],
    });
    assert.deepEqual(backend.chat_template_kwargs, { enable_thinking: false, preserve_thinking: true }, "the backend's own is left as it was");
    assert.deepEqual(mergeBodies(undefined, { a: 1 }), { a: 1 });
    assert.deepEqual(mergeBodies({ a: 1 }, undefined), { a: 1 });
    assert.equal(mergeBodies(undefined, undefined), undefined);
  });
});

describe("tool calls written as text", () => {
  it("reads the <tool_call> form and leaves the rest of the text", () => {
    const found = toolCallsInText('Looking.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.py"}}\n</tool_call>');
    assert.equal(found?.rest, "Looking.");
    assert.deepEqual(
      found?.calls.map((c) => [c.function.name, c.function.arguments]),
      [["read_file", '{"path":"a.py"}']],
    );
  });

  it("ignores text with no well-formed calls", () => {
    assert.equal(toolCallsInText("No calls here."), undefined);
    assert.equal(toolCallsInText("<tool_call>not json</tool_call>"), undefined);
  });
});

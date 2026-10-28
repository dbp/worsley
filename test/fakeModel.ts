import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for llama-server or OpenRouter: an OpenAI-compatible
 * `/v1/chat/completions` that streams whatever the test's `respond` says,
 * cut into small pieces the way real servers send them, and a `/v1/models`.
 */

export interface FakeReply {
  content?: string;
  /** Sent as llama.cpp does, in `reasoning_content`. */
  reasoning?: string;
  toolCalls?: { name: string; arguments: unknown }[];
  finishReason?: string;
  /** An HTTP error instead of a reply. */
  status?: number;
  errorMessage?: string;
}

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  [key: string]: unknown;
}

export interface FakeModel {
  url: string;
  requests: ChatRequest[];
  close(): Promise<void>;
}

export async function startFakeModel(respond: (request: ChatRequest, index: number) => FakeReply | Promise<FakeReply>): Promise<FakeModel> {
  const requests: ChatRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-small", context_length: 32768 }, { id: "fake-large", context_length: 131072 }] }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const request = JSON.parse(body) as ChatRequest;
        requests.push(request);
        const reply = await respond(request, requests.length - 1);
        if (reply.status !== undefined) {
          res.writeHead(reply.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: reply.errorMessage ?? "error" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const chunk of streamChunks(reply)) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await new Promise((resolve) => setImmediate(resolve));
        }
        res.end("data: [DONE]\n\n");
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

function* streamChunks(reply: FakeReply): Generator<unknown> {
  const delta = (d: Record<string, unknown>, finish: string | null = null): unknown => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
  yield delta({ role: "assistant", content: null });
  for (const piece of pieces(reply.reasoning ?? "", 7)) {
    yield delta({ reasoning_content: piece });
  }
  for (const piece of pieces(reply.content ?? "", 5)) {
    yield delta({ content: piece });
  }
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
    yield delta({ tool_calls: [{ index, id: `fake_${index}`, type: "function", function: { name: call.name, arguments: "" } }] });
    for (const piece of pieces(args, 9)) {
      yield delta({ tool_calls: [{ index, function: { arguments: piece } }] });
    }
  }
  const finish = reply.finishReason ?? ((reply.toolCalls ?? []).length > 0 ? "tool_calls" : "stop");
  yield delta({}, finish);
  yield { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 34 }, timings: { prompt_n: 200, cache_n: 1000, predicted_n: 34, predicted_per_second: 42.5 } };
}

/** The text of the last message with this role. */
export function lastOf(request: ChatRequest, role: string): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i];
    if (m?.role === role) {
      return m.content ?? "";
    }
  }
  return "";
}

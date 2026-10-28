import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sseData } from "../../src/core/sse";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const data of sseData(stream(chunks))) {
    out.push(data);
  }
  return out;
}

describe("server-sent events", () => {
  it("yields each event's data, however the stream is cut", async () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    const whole = await collect([text]);
    assert.deepEqual(whole, ['{"a":1}', '{"b":2}', "[DONE]"]);
    const byChar = await collect([...text]);
    assert.deepEqual(byChar, whole);
  });

  it("skips comments and other fields, and joins multi-line data", async () => {
    const out = await collect([": OPENROUTER PROCESSING\n\n", "event: x\nid: 3\ndata: one\ndata: two\n\n", "data:three\n\n"]);
    assert.deepEqual(out, ["one\ntwo", "three"]);
  });

  it("takes \\r\\n and \\r line endings, even split between chunks", async () => {
    assert.deepEqual(await collect(["data: a\r", "\n\r", "\ndata: b\r\r"]), ["a", "b"]);
  });

  it("keeps a last event that has no blank line after it", async () => {
    assert.deepEqual(await collect(["data: a\n\ndata: b"]), ["a", "b"]);
    assert.deepEqual(await collect(["data: a\n"]), ["a"]);
  });
});

/**
 * The `data` of each event in a server-sent event stream, which is how the
 * OpenAI-compatible chat API streams a reply. Comment lines (OpenRouter
 * sends `: OPENROUTER PROCESSING` while it waits for a provider) and other
 * fields are skipped. Lines may end in `\n`, `\r\n` or `\r`, split anywhere
 * across chunks.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  function* takeLines(final: boolean): Generator<string> {
    for (;;) {
      const end = buffer.search(/[\r\n]/);
      if (end < 0) {
        break;
      }
      // A `\r` at the very end may be the first half of a `\r\n`.
      if (buffer[end] === "\r" && end === buffer.length - 1 && !final) {
        break;
      }
      const line = buffer.slice(0, end);
      buffer = buffer.slice(buffer.startsWith("\r\n", end) ? end + 2 : end + 1);
      const event = takeLine(line);
      if (event !== undefined) {
        yield event;
      }
    }
  }

  /** Adds a line to the event being read; returns the event once a blank line ends it. */
  function takeLine(line: string): string | undefined {
    if (line === "") {
      if (data.length === 0) {
        return undefined;
      }
      const event = data.join("\n");
      data = [];
      return event;
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field === "data") {
      const value = colon < 0 ? "" : line.slice(colon + 1);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    return undefined;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* takeLines(false);
    }
    buffer += decoder.decode();
    yield* takeLines(true);
    // A stream may end without the blank line after its last event.
    const last = takeLine(buffer);
    if (last !== undefined) {
      yield last;
    }
    if (data.length > 0) {
      yield data.join("\n");
    }
  } finally {
    reader.releaseLock();
  }
}

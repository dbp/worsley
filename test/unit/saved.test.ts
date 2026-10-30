import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interrupted, parseSaved, RELOADED, type SavedThread } from "../../src/core/saved";

function thread(fields: Partial<SavedThread>): SavedThread {
  return {
    version: 1,
    items: [],
    messages: [{ role: "system", content: "You are a test." }],
    seen: [],
    sent: [],
    changedInThread: [],
    lastChanges: [],
    warnedGit: false,
    locations: [],
    nextId: 1,
    ...fields,
  };
}

describe("a saved thread", () => {
  it("is read back as it was written", () => {
    const saved = thread({
      items: [{ kind: "user", id: "i1", mode: "ask", text: "Where?", context: ["cart.py"] }],
      tour: { plan: { title: "The shop", steps: [{ title: "Totals", summary: "How the total is worked out", path: "cart.py", start: 1, end: 9 }] }, current: 0, explained: [[0, "i2"]] },
      seen: ["cart.py"],
      sent: [["cart.py", "abc123"]],
      locations: [["i3", [{ path: "cart.py", start: 3, end: 5, note: "adds up" }]]],
      nextId: 4,
    });
    assert.deepEqual(parseSaved(JSON.stringify(saved)), saved);
  });

  it("isn't read if it's from another version, damaged, or incomplete", () => {
    assert.equal(parseSaved(JSON.stringify({ ...thread({}), version: 2 })), undefined);
    assert.equal(parseSaved('{"version": 1, "items": ['), undefined);
    assert.equal(parseSaved("null"), undefined);
    const { locations: _, ...partial } = thread({});
    assert.equal(parseSaved(JSON.stringify(partial)), undefined);
  });
});

describe("a thread caught in the middle of a request", () => {
  it("keeps the reply as far as it got, for the model as in the panel", () => {
    const caught = thread({
      items: [
        { kind: "user", id: "i1", mode: "ask", text: "How is the total worked out?", context: [] },
        { kind: "assistant", id: "i2", text: "It adds up the pri", reasoning: "", streaming: true },
      ],
      messages: [
        { role: "system", content: "You are a test." },
        { role: "user", content: "How is the total worked out?" },
      ],
      nextId: 3,
    });
    const before = structuredClone(caught);
    const kept = interrupted(caught);
    assert.deepEqual(kept.items[1], { kind: "assistant", id: "i2", text: "It adds up the pri", reasoning: "", streaming: false });
    assert.deepEqual(kept.messages.at(-1), { role: "assistant", content: "It adds up the pri\n\n[Stopped: the window was reloaded.]" });
    assert.deepEqual(kept.items.at(-1), { kind: "notice", id: "i3", level: "info", text: RELOADED });
    assert.equal(kept.nextId, 4);
    assert.deepEqual(caught, before, "the live thread is left as it was");
  });

  it("gives every tool call a result, and drops a question no one can answer now", () => {
    const kept = interrupted(
      thread({
        items: [
          { kind: "user", id: "i1", mode: "change", text: "Fix it", context: [] },
          { kind: "tool", id: "i2", icon: "read", summary: "Read cart.py", status: "done" },
          { kind: "tool", id: "i3", icon: "run", summary: "Running make", status: "running" },
          { kind: "approval", id: "i4", command: "make", status: "pending", scopes: ["make …", "exactly this command"], scope: 0 },
        ],
        messages: [
          { role: "system", content: "You are a test." },
          { role: "user", content: "Fix it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"cart.py"}' } },
              { id: "b", type: "function", function: { name: "run_command", arguments: '{"command":"make"}' } },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "1: total = 0" },
        ],
        nextId: 5,
      }),
    );
    assert.deepEqual(
      kept.messages.slice(-2),
      [
        { role: "tool", tool_call_id: "a", content: "1: total = 0" },
        { role: "tool", tool_call_id: "b", content: "Not run, or stopped partway: the window was reloaded." },
      ],
    );
    assert.deepEqual(
      kept.items.map((i) => `${i.kind}:${"status" in i ? i.status : ""}`),
      ["user:", "tool:done", "tool:failed", "notice:"],
    );
  });

  it("leaves a question with no answer yet as it is, with the notice", () => {
    const caught = thread({
      items: [{ kind: "user", id: "i1", mode: "ask", text: "Why?", context: [] }],
      messages: [
        { role: "system", content: "You are a test." },
        { role: "user", content: "Why?" },
      ],
      nextId: 2,
    });
    const kept = interrupted(caught);
    assert.deepEqual(kept.messages, caught.messages);
    assert.deepEqual(
      kept.items.map((i) => i.kind),
      ["user", "notice"],
    );
  });
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { clipOutput, runCommand, stripAnsi } from "../../src/core/shell";
import { tempFolder } from "./helpers";

describe("running a command", () => {
  it("gives the exit code and both streams, in the folder, with nothing on stdin", async () => {
    const root = tempFolder({ "x.txt": "here\n" });
    const result = await runCommand("cat x.txt; echo oops >&2; read line || echo no-input; exit 3", { cwd: root, timeoutMs: 10_000, signal: new AbortController().signal });
    assert.equal(result.exitCode, 3);
    // The two streams are separate pipes, so their order between them isn't certain.
    assert.deepEqual(result.output.split("\n").sort(), ["", "here", "no-input", "oops"]);
    assert.equal(result.timedOut, false);
  });

  it("tells test runners not to colour or wait", async () => {
    const result = await runCommand('echo "$CI $NO_COLOR"', { cwd: tempFolder({}), timeoutMs: 10_000, signal: new AbortController().signal });
    assert.equal(result.output, "1 1\n");
  });

  it("stops a command that runs too long, and what it started", async () => {
    const root = tempFolder({});
    const marker = path.join(root, "child-ran");
    const started = Date.now();
    const result = await runCommand(`(sleep 2; touch ${marker}) & sleep 30`, { cwd: root, timeoutMs: 300, signal: new AbortController().signal });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - started < 5000);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(fs.existsSync(marker), false, "the background child was stopped too");
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runCommand("sleep 30", { cwd: tempFolder({}), timeoutMs: 60_000, signal: controller.signal });
    assert.equal(result.aborted, true);
  });

  it("keeps the start and the end of long output", async () => {
    const result = await runCommand("seq 1 100000", { cwd: tempFolder({}), timeoutMs: 20_000, signal: new AbortController().signal, maxChars: 8000 });
    assert.equal(result.truncated, true);
    assert.match(result.output, /^1\n2\n3\n/);
    assert.match(result.output, /characters of output dropped/);
    assert.match(result.output, /\n99999\n100000\n$/);
  });
});

describe("output", () => {
  it("loses colour escapes", () => {
    assert.equal(stripAnsi("\u001b[31mFAIL\u001b[0m test \u001b]8;;http://x\u0007link\u001b]8;;\u0007"), "FAIL test link");
  });

  it("is clipped for the model, keeping more of the end", () => {
    const text = "a".repeat(100) + "b".repeat(100);
    const clipped = clipOutput(text, 50);
    assert.match(clipped, /^a{10}\n… \[150 characters omitted\] …\nb{40}$/);
    assert.equal(clipOutput("short", 50), "short");
  });
});

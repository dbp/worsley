import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WorsleyApi } from "../../src/extension";
import type { HostMessage, Item } from "../../src/protocol";

/**
 * Inside VS Code, against the fake model: ask about a selection (with the
 * editor's references and a list of locations), check the reply's links,
 * open one; keep the thread for the next window; change the code (two
 * edits, then the tests, which run without asking); commands that need
 * approval, one allowed by its class; and a two-step tour, each step
 * opening its code. test-electron calls `run`; a throw fails the run.
 */

const WORKSPACE = process.env.WORSLEY_TEST_WORKSPACE ?? "";

export async function run(): Promise<void> {
  try {
    await scenario();
    console.log("integration: passed");
  } catch (err) {
    const api = vscode.extensions.getExtension<WorsleyApi>("worsley.worsley")?.exports;
    const items = api?.session.snapshot.items ?? [];
    console.error(`integration: failed. The thread:\n  ${items.map(brief).join("\n  ")}`);
    throw err;
  }
}

function brief(item: Item): string {
  switch (item.kind) {
    case "user":
      return `user(${item.mode}): ${item.text} [${item.context.join(", ")}]`;
    case "assistant":
      return `assistant: ${item.text.slice(0, 160)}`;
    case "tool":
      return `tool(${item.status}): ${item.summary}`;
    case "locations":
      return `locations: ${item.title} ${item.locations.map((l) => l.label).join(", ")}`;
    case "approval":
      return `approval(${item.status}): ${item.command}`;
    case "changes":
      return `changes: ${item.files.map((f) => f.path).join(", ")}`;
    case "notice":
      return `notice(${item.level}): ${item.text}`;
    case "step":
      return `step ${item.index + 1}: ${item.title}`;
  }
}

async function waitFor<T>(what: string, check: () => T | undefined | false, ms = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() - started > ms) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function scenario(): Promise<void> {
  assert.ok(WORKSPACE, "WORSLEY_TEST_WORKSPACE isn't set");
  const extension = vscode.extensions.getExtension<WorsleyApi>("worsley.worsley");
  assert.ok(extension, "the extension isn't loaded");
  const { session, panel, threadFile } = await extension.activate();
  const posted: HostMessage[] = [];
  session.onDidPost((message) => posted.push(message));
  const items = (): readonly Item[] => session.snapshot.items;
  const idle = (): Promise<true> => waitFor("the request to finish", () => !session.snapshot.busy);
  const file = (name: string): string => fs.readFileSync(path.join(WORKSPACE, name), "utf8");

  // ---- Ask about a selection.
  const cart = await vscode.window.showTextDocument(vscode.Uri.file(path.join(WORKSPACE, "src/cart.js")));
  cart.selection = new vscode.Selection(2, 0, 5, 0);
  await vscode.commands.executeCommand("worsley.ask", "What does this do?");
  await idle();
  const user = items().find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  assert.deepEqual(user?.context, ["cart.js:3-5", "cart.js"], "the selection and the file went with the question");
  const references = items().find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool" && i.summary.includes("reference"));
  assert.ok(references !== undefined && /Found \d+ references? to total/.test(references.summary), `references: ${references?.summary}`);
  const locations = items().find((i): i is Extract<Item, { kind: "locations" }> => i.kind === "locations");
  assert.deepEqual(
    locations?.locations.map((l) => [l.href, l.note, l.preview.split("\n")[0]]),
    [
      ["src/cart.js#L3-L5", "adds up the prices", "function total(items) {"],
      ["test/cart.test.js#L6-L8", "its test", 'test("total adds up the prices", () => {'],
    ],
  );
  const answer = items().find((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant" && i.text.startsWith("It adds up"));
  assert.ok(answer, "the answer is in the thread");
  // The window, 32768 tokens, comes from the fake server's /models.
  assert.match(answer.stats ?? "", /3 rounds · 1\.2K of 33K context · 102 generated · 42\.5 tok\/s/);

  // A moment after the request ends, the thread is kept for the next window.
  assert.ok(threadFile !== undefined, "the workspace has storage");
  const kept = await waitFor("the thread to be kept", () => {
    try {
      const saved = JSON.parse(fs.readFileSync(threadFile, "utf8")) as { items: Item[]; messages: unknown[] };
      return saved.items.length === items().length ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  assert.deepEqual(kept.items, JSON.parse(JSON.stringify(items())));
  assert.deepEqual(kept.messages, JSON.parse(JSON.stringify(session.snapshot.messages)));

  // The panel asks which of the reply's links lead somewhere.
  await session.checkLinks(answer.id, ["src/cart.js#L3-L5", "cart.test.js:6", "missing.js:3", "src/cart.js#L90", "src", "test/", "missing/"]);
  const links = posted.find((m): m is Extract<HostMessage, { type: "links" }> => m.type === "links");
  assert.deepEqual(links?.statuses, {
    "src/cart.js#L3-L5": "ok",
    "cart.test.js:6": "ok",
    "missing.js:3": "missing",
    "src/cart.js#L90": "missing",
    src: "ok",
    "test/": "ok",
    "missing/": "missing",
  });
  // A folder is revealed in the Explorer rather than opened.
  await session.openHref("test/");
  await session.openHref("cart.test.js:6");
  const opened = vscode.window.activeTextEditor;
  assert.equal(opened?.document.uri.fsPath, path.join(WORKSPACE, "test/cart.test.js"));
  assert.equal(opened?.selection.active.line, 5);

  // ---- Change the code; the tests run without asking.
  await vscode.commands.executeCommand("worsley.change", "Add a discount to total");
  await idle();
  assert.match(file("src/cart.js"), /function total\(items, discount = 0\) \{\n {2}return items\.reduce\(\(sum, item\) => sum \+ item\.price, 0\) \* \(1 - discount\);/);
  assert.match(file("test/cart.test.js"), /test\("total takes a discount"/);
  const ran = items().find((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool" && i.icon === "run");
  assert.match(ran?.summary ?? "", /^Ran node --test: exit 0, /);
  assert.equal(items().some((i) => i.kind === "approval"), false, "the test command didn't need approval");
  const changes = items().find((i): i is Extract<Item, { kind: "changes" }> => i.kind === "changes");
  assert.deepEqual(changes?.files, [
    { path: "src/cart.js", created: false },
    { path: "test/cart.test.js", created: false },
  ]);
  assert.ok(items().some((i) => i.kind === "assistant" && i.text.includes("The tests pass.")));
  assert.equal(items().some((i) => i.kind === "notice" && i.level !== "info"), false, `no warnings: ${items().filter((i) => i.kind === "notice").map(brief).join("; ")}`);

  // ---- Any other command waits for approval, which can cover its class:
  // once git log … is allowed, the next git log runs without asking, and git status still asks.
  type ApprovalItem = Extract<Item, { kind: "approval" }>;
  const pending = (): ApprovalItem | undefined => items().find((i): i is ApprovalItem => i.kind === "approval" && i.status === "pending");
  void vscode.commands.executeCommand("worsley.change", "Look at the history");
  const status = (): string | undefined => [...posted].reverse().find((m): m is Extract<HostMessage, { type: "busy" }> => m.type === "busy")?.status;
  const first = await waitFor("an approval", pending);
  assert.equal(first.command, "git log --oneline -1");
  assert.deepEqual(first.scopes, ["git log …", "git log --oneline …", "exactly this command"]);
  assert.equal(first.scopes[first.scope], "git log …");
  assert.equal(status(), "Waiting for you to approve a command…");
  session.approve(first.id, "always", 0);
  assert.equal(status(), "Running git log --oneline -1…", "once allowed, the status says the command is running");
  const second = await waitFor("a second approval", () => {
    const p = pending();
    return p !== undefined && p.id !== first.id ? p : undefined;
  });
  assert.equal(second.command, "git status --short");
  session.approve(second.id, "deny");
  await idle();
  const runs = items()
    .filter((i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool" && i.icon === "run")
    .map((i) => i.summary.replace(/, [\d.]+s$/, ""));
  assert.deepEqual(runs.slice(-3), ["Ran git log --oneline -1: exit 0", "Ran git log --oneline --stat -1: exit 0", "Not run: git status --short"]);
  assert.equal(items().filter((i) => i.kind === "approval").length, 2);
  assert.equal(items().find((i): i is ApprovalItem => i.kind === "approval" && i.id === first.id)?.allowed, "git log …");
  assert.deepEqual(session.allowedCommands, { exact: [], prefixes: [["git", "log"]] });

  // ---- A tour: the first step opens and is explained at once, the next when asked.
  await session.reset();
  assert.equal(fs.existsSync(threadFile), false, "a new thread leaves nothing kept");
  assert.equal(items().length, 0);
  await vscode.commands.executeCommand("worsley.tour");
  const explained = await waitFor("the first step's explanation", () => items().find((i) => i.kind === "assistant" && i.text.startsWith("Step 1:")));
  await idle();
  // The tour opened the panel, whose script runs under the webview's CSP:
  // it drew the explanation and asked which of its links lead somewhere.
  await waitFor("the panel to load", () => panel.isReady);
  const checked = await waitFor("the panel to check the step's links", () =>
    posted.find((m): m is Extract<HostMessage, { type: "links" }> => m.type === "links" && m.id === explained.id),
  );
  assert.deepEqual(checked.statuses, { "src/cart.js#L3-L5": "ok" });
  assert.equal(session.snapshot.tour?.current, 0);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(WORKSPACE, "src/cart.js"));
  assert.equal(vscode.window.activeTextEditor?.selection.active.line, 2);
  await session.tourGo(1);
  await idle();
  assert.ok(items().some((i) => i.kind === "assistant" && i.text.startsWith("Step 2:")));
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(WORKSPACE, "test/cart.test.js"));
  const steps = items().filter((i) => i.kind === "step").map(brief);
  assert.deepEqual(steps, ["step 1: Totals", "step 2: The test"]);
  // Going back doesn't ask again.
  const before = session.snapshot.messages.length;
  await session.tourGo(0);
  assert.equal(session.snapshot.messages.length, before);
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(WORKSPACE, "src/cart.js"));
}

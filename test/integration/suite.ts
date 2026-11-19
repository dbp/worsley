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
 * edits, then the tests, which run without asking); review those changes,
 * of one file and of all; hold the next change for the uncommitted one,
 * cancel it, then send one anyway; commands that need approval, one allowed
 * by its class; a two-step tour of the structure, each step opening its
 * code; and level 1, where only a line's explanation and a translation are
 * offered, each with nothing but its own code, the translation put in place
 * of the student's lines unless they changed meanwhile. test-electron calls
 * `run`; a throw fails the run.
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
    case "uncommitted":
      return `uncommitted(${item.status}): ${[...item.files.map((f) => f.path), ...item.unsaved].join(", ")}`;
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

  // ---- A light review of those changes, as an Ask: of the file in the
  // editor, then of them all. The panel shows the request; the model gets the diff.
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(WORKSPACE, "src/cart.js")));
  await vscode.commands.executeCommand("worsley.reviewFile");
  await idle();
  const lastUser = (): Extract<Item, { kind: "user" }> | undefined => [...items()].reverse().find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  const lastAnswer = (): string => [...items()].reverse().find((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant")?.text ?? "";
  assert.deepEqual([lastUser()?.mode, lastUser()?.text], ["ask", "Review my uncommitted changes to src/cart.js."]);
  assert.match(lastAnswer(), /^Reviewed src\/cart\.js: /);
  const asked = [...session.snapshot.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  assert.match(asked, /<diff>\ndiff --git a\/src\/cart\.js b\/src\/cart\.js\n[\s\S]*\+function total\(items, discount = 0\) \{/);
  await vscode.commands.executeCommand("worsley.reviewAll");
  await idle();
  assert.equal(lastUser()?.text, "Review my uncommitted changes.");
  assert.match(lastAnswer(), /^Reviewed src\/cart\.js, test\/cart\.test\.js: /);

  // ---- With that change not committed, the next one waits for the user to
  // send it anyway, showing what git would mix in. Cancelled, nothing goes
  // to the model and the message goes back in the box.
  type UncommittedItem = Extract<Item, { kind: "uncommitted" }>;
  const held = (): UncommittedItem | undefined => items().find((i): i is UncommittedItem => i.kind === "uncommitted" && i.status === "pending");
  const status = (): string | undefined => [...posted].reverse().find((m): m is Extract<HostMessage, { type: "busy" }> => m.type === "busy")?.status;
  const sentBefore = session.snapshot.messages.length;
  void vscode.commands.executeCommand("worsley.change", "Rename total to sum");
  const cancelled = await waitFor("the uncommitted changes", held);
  assert.deepEqual(cancelled.files, [
    { path: "src/cart.js", untracked: false, lines: { added: 2, removed: 2 } },
    { path: "test/cart.test.js", untracked: false, lines: { added: 4, removed: 0 } },
  ]);
  assert.deepEqual(cancelled.unsaved, []);
  assert.equal(status(), "Waiting for you to confirm…");
  session.approve(cancelled.id, "deny");
  await idle();
  assert.equal(session.snapshot.messages.length, sentBefore, "nothing went to the model");
  assert.equal(items().some((i) => i.kind === "user" && i.text === "Rename total to sum"), false);
  assert.ok(posted.some((m) => m.type === "focus" && m.mode === "change" && m.text === "Rename total to sum"), "the message went back in the box");

  // ---- Any other command waits for approval, which can cover its class:
  // once git log … is allowed, the next git log runs without asking, and git status still asks.
  type ApprovalItem = Extract<Item, { kind: "approval" }>;
  const pending = (): ApprovalItem | undefined => items().find((i): i is ApprovalItem => i.kind === "approval" && i.status === "pending");
  void vscode.commands.executeCommand("worsley.change", "Look at the history");
  const sent = await waitFor("the uncommitted changes again", held);
  session.approve(sent.id, "once");
  const first = await waitFor("an approval", pending);
  assert.equal(sent.status, "sent");
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
  const explained = await waitFor("the first step's explanation", () =>
    items().find((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant" && i.text.startsWith("Step 1:")),
  );
  await idle();
  assert.equal(session.snapshot.tour?.title, "How the shop is built");
  assert.match(explained.text, /explained as structure\.$/, "the tour of the codebase is a tour of its structure");
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

  await levelOne(session, posted);
  await levelTwo(session, posted);
  await levelThree(session, posted);
}

/**
 * At level 1, as a course's workspace settings would set it: Ask and tours
 * are refused; a line is explained, and pseudocode translated in place,
 * each sent to the model with nothing but its own code and kept out of the
 * thread the model sees for Ask and Change.
 */
async function levelOne(session: WorsleyApi["session"], posted: HostMessage[]): Promise<void> {
  const items = (): readonly Item[] => session.snapshot.items;
  const idle = (): Promise<true> => waitFor("the request to finish", () => !session.snapshot.busy);
  const notices = (): string[] => items().flatMap((i) => (i.kind === "notice" ? [i.text] : []));
  const config = vscode.workspace.getConfiguration("worsley");
  await session.reset();
  await config.update("level", 1, vscode.ConfigurationTarget.Workspace);
  await waitFor("the panel to hear of level 1", () => posted.some((m) => m.type === "level" && m.level === 1 && m.features.join(",") === "explain,translate"));

  await vscode.commands.executeCommand("worsley.ask", "What does this do?");
  await vscode.commands.executeCommand("worsley.tour");
  assert.deepEqual(notices(), ["Worsley is at level 1, which doesn't include asking about the code.", "Worsley is at level 1, which doesn't include tours."]);
  assert.equal(session.snapshot.messages.length, 0, "nothing went to the model");
  assert.equal(session.snapshot.tour, undefined);

  // ---- A line, explained on its own.
  const shipping = await vscode.window.showTextDocument(vscode.Uri.file(path.join(WORKSPACE, "src/shipping.js")));
  shipping.selection = new vscode.Selection(10, 3, 10, 3);
  await vscode.commands.executeCommand("worsley.explainLine");
  await idle();
  assert.deepEqual(items().filter((i) => i.kind === "user" || i.kind === "assistant").map(brief), [
    "user(explain): module.exports = { shipping }; [shipping.js:11]",
    "assistant: `module.exports` is what another file gets when it `require`s this one.",
  ]);
  assert.equal(session.snapshot.messages.length, 0, "the explanation stays out of the thread the model sees");
  shipping.selection = new vscode.Selection(3, 0, 5, 3);
  await vscode.commands.executeCommand("worsley.explainLine");
  assert.equal(notices().at(-1), "Explain Line explains one line at a time. Put the cursor on the line to explain, or select part of it.");

  // ---- Pseudocode, translated in place: from after the first line's
  // indentation to the start of the line after the last, it is lines 4-8.
  const original = shipping.document.getText();
  shipping.selection = new vscode.Selection(3, 2, 8, 0);
  await vscode.commands.executeCommand("worsley.translate");
  await idle();
  const translated = original.replace(
    "  set cost to 5\n  if order's weight is more than 10\n    add 2 to cost\n  make it cheaper for members\n  return cost\n",
    "  let cost = 5;\n  if (order.weight > 10) {\n    cost += 2;\n  }\n  make it cheaper for members\n  return cost;\n",
  );
  assert.equal(shipping.document.getText(), translated, `the translation took the lines' place, kept their indentation, and kept the line it couldn't translate: ${notices().join(" | ")}`);
  assert.ok(shipping.document.isDirty, "the translation is in the editor, for the student to save");
  assert.equal(fs.readFileSync(path.join(WORKSPACE, "src/shipping.js"), "utf8"), original, "and not yet on disk");
  assert.equal(notices().at(-1), "Put the translation in shipping.js, at lines 4-9, in place of your lines. Undo in the editor brings them back.");
  const asked = [...items()].reverse().find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  assert.deepEqual(
    [asked?.mode, asked?.text, asked?.context],
    ["translate", "set cost to 5\nif order's weight is more than 10\n  add 2 to cost\nmake it cheaper for members\nreturn cost", ["shipping.js:4-8"]],
  );
  assert.equal(session.snapshot.messages.length, 0, "the translation stays out of the thread the model sees");
  await vscode.window.showTextDocument(shipping.document);
  await vscode.commands.executeCommand("undo");
  assert.equal(shipping.document.getText(), original, "undo brings the student's lines back");

  // ---- Lines changed while the model works aren't replaced.
  shipping.selection = new vscode.Selection(3, 0, 7, 13);
  const translating = vscode.commands.executeCommand("worsley.translate");
  await waitFor("the translation to start", () => session.snapshot.busy);
  await shipping.edit((edit) => edit.insert(new vscode.Position(0, 0), "// changed meanwhile\n"));
  await translating;
  await idle();
  assert.equal(notices().at(-1), "shipping.js changed while Worsley was working, so the translation isn't in it. Copy it from here instead.");
  assert.equal(shipping.document.getText(), `// changed meanwhile\n${original}`);
  await vscode.window.showTextDocument(shipping.document);
  await vscode.commands.executeCommand("workbench.action.files.revert");

  // ---- A file in no programming language has nothing to translate into.
  const scratch = await vscode.workspace.openTextDocument({ content: "set x to 1\n", language: "plaintext" });
  await vscode.window.showTextDocument(scratch);
  await vscode.commands.executeCommand("worsley.translate");
  assert.match(notices().at(-1) ?? "", /^Translate writes code in the language of the file the lines are in, and Untitled-\d+ isn't in a programming language\./);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
}

/**
 * At level 2, which keeps level 1's requests: Ask is refused; a function is
 * checked against the tests that call it, found by the language server; a
 * function with a body, or with no tests, isn't filled in; and one with a
 * placeholder and tests is, in place, keeping its doc comment.
 */
async function levelTwo(session: WorsleyApi["session"], posted: HostMessage[]): Promise<void> {
  const items = (): readonly Item[] => session.snapshot.items;
  const idle = (): Promise<true> => waitFor("the request to finish", () => !session.snapshot.busy);
  const notices = (): string[] => items().flatMap((i) => (i.kind === "notice" ? [i.text] : []));
  const lastUser = (): Extract<Item, { kind: "user" }> | undefined => [...items()].reverse().find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  const config = vscode.workspace.getConfiguration("worsley");
  await session.reset();
  await config.update("level", 2, vscode.ConfigurationTarget.Workspace);
  await waitFor("the panel to hear of level 2", () => posted.some((m) => m.type === "level" && m.level === 2 && m.features.join(",") === "explain,translate,check,fill"));
  await vscode.commands.executeCommand("worsley.ask", "What does this do?");
  assert.deepEqual(notices(), ["Worsley is at level 2, which doesn't include asking about the code."]);

  // ---- total, as the Change left it, checked against the tests that call it.
  const cart = await vscode.window.showTextDocument(vscode.Uri.file(path.join(WORKSPACE, "src/cart.js")));
  cart.selection = new vscode.Selection(3, 4, 3, 4);
  await vscode.commands.executeCommand("worsley.checkFunction");
  await idle();
  const checked = lastUser();
  // Its tests are the callbacks node:test is given, each found whole.
  assert.deepEqual([checked?.mode, checked?.text, checked?.context], ["check", "function total(items, discount = 0) {", ["cart.js:3-5", "cart.test.js:6-8", "cart.test.js:10-12"]]);
  assert.ok(items().some((i) => i.kind === "assistant" && i.text.startsWith("**They fit.**")), `the check's reply: ${items().map(brief).join(" | ")}`);
  assert.equal(session.snapshot.messages.length, 0, "the check stays out of the thread the model sees");

  // ---- Fill In won't touch a function with a body, or one without tests.
  await vscode.commands.executeCommand("worsley.fillFunction");
  await idle();
  assert.equal(notices().at(-1), "total has a body already. Fill In writes the body of a function that has only its header, its documentation and tests, and perhaps a placeholder such as pass.");
  const discount = await vscode.window.showTextDocument(vscode.Uri.file(path.join(WORKSPACE, "src/discount.js")));
  discount.selection = new vscode.Selection(13, 2, 13, 2);
  await vscode.commands.executeCommand("worsley.fillFunction");
  await idle();
  assert.match(notices().at(-1) ?? "", /^No tests that call taxed were found, and Fill In writes a body from its documentation and its tests\./);

  // ---- A function with a placeholder and a test is filled in, in place.
  const original = discount.document.getText();
  discount.selection = new vscode.Selection(6, 2, 6, 2);
  await vscode.commands.executeCommand("worsley.fillFunction");
  await idle();
  const filled = lastUser();
  assert.deepEqual([filled?.mode, filled?.text, filled?.context], ["fill", "function discounted(price, percent) {", ["discount.js:3-8", "discount.spec.js:6-8"]]);
  assert.equal(
    discount.document.getText(),
    original.replace("function discounted(price, percent) {\n  // TODO\n}", "function discounted(price, percent) {\n  return price * (1 - percent / 100);\n}"),
    `the body took the placeholder's place, and the doc comment stayed: ${notices().join(" | ")}`,
  );
  assert.equal(notices().at(-1), "Filled in discounted in discount.js, at lines 3-8. Undo in the editor brings back what was there.");
  await vscode.window.showTextDocument(discount.document);
  await vscode.commands.executeCommand("undo");
  assert.equal(discount.document.getText(), original, "undo brings the placeholder back");
}

/**
 * At level 3, which keeps levels 1 and 2: a review of what the Change left
 * uncommitted in the file in the editor, sent with its diff; a review of
 * all the changes, and Ask, are refused. Back at level N, the panel hears
 * of everything, a section for each level.
 */
async function levelThree(session: WorsleyApi["session"], posted: HostMessage[]): Promise<void> {
  const items = (): readonly Item[] => session.snapshot.items;
  const idle = (): Promise<true> => waitFor("the request to finish", () => !session.snapshot.busy);
  const notices = (): string[] => items().flatMap((i) => (i.kind === "notice" ? [i.text] : []));
  const config = vscode.workspace.getConfiguration("worsley");
  await session.reset();
  await config.update("level", 3, vscode.ConfigurationTarget.Workspace);
  const heard = await waitFor("the panel to hear of level 3", () =>
    posted.find((m): m is Extract<HostMessage, { type: "level" }> => m.type === "level" && m.level === 3 && m.features.join(",") === "explain,translate,check,fill,reviewFile"),
  );
  assert.deepEqual(
    heard.sections.map((s) => `${s.level} ${s.name}: ${s.features.join(", ")}`),
    ["1 Syntax: explain, translate", "2 Functions: check, fill", "3 Changes: reviewFile"],
  );
  await vscode.commands.executeCommand("worsley.reviewAll");
  await vscode.commands.executeCommand("worsley.ask", "What does this do?");
  assert.deepEqual(notices(), ["Worsley is at level 3, which doesn't include reviewing all your changes at once.", "Worsley is at level 3, which doesn't include asking about the code."]);

  await vscode.window.showTextDocument(vscode.Uri.file(path.join(WORKSPACE, "src/cart.js")));
  await vscode.commands.executeCommand("worsley.reviewFile");
  await idle();
  const asked = [...items()].reverse().find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  assert.deepEqual([asked?.mode, asked?.text], ["ask", "Review my uncommitted changes to src/cart.js."]);
  assert.ok(items().some((i) => i.kind === "assistant" && i.text.startsWith("Reviewed src/cart.js: ")), `the review: ${items().map(brief).join(" | ")}`);
  const sent = [...session.snapshot.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  assert.match(sent, /<diff>\ndiff --git a\/src\/cart\.js b\/src\/cart\.js\n/, "the review went with the file's diff");

  await config.update("level", undefined, vscode.ConfigurationTarget.Workspace);
  const all = await waitFor("the panel to hear of level N", () => posted.find((m): m is Extract<HostMessage, { type: "level" }> => m.type === "level" && m.level === "N"));
  assert.equal(all.features.length, 9);
  assert.deepEqual(
    all.sections.map((s) => s.level),
    [1, 2, 3, "N"],
  );
}

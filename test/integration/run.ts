import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";
import { TOUR_REQUEST } from "../../src/core/prompts";
import { EXPLAIN_SYSTEM, explainRequest, TRANSLATE_SYSTEM } from "../../src/core/standalone";
import { lastOf, startFakeModel, type ChatRequest, type FakeReply } from "../fakeModel";

/**
 * Runs `suite.ts` inside VS Code, with the extension talking to a fake
 * model that plays a script, in a small JavaScript project whose tests run
 * with `node --test`.
 *
 * By default test-electron downloads VS Code 1.101.0, the `engines.vscode`
 * floor, into `.vscode-test/`. `WORSLEY_TEST_VSCODE` names another: a
 * version such as `stable`, or the path of an installed VS Code's binary,
 * such as `/usr/share/code/code`.
 *
 * VS Code opens a window while the test runs.
 */

/** The extension's root: this file runs from out/test/integration. */
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRATCH = path.join(ROOT, ".vscode-test", "integration");

export const FILES: Record<string, string> = {
  "package.json": '{ "name": "shop", "private": true }\n',
  "src/cart.js": [
    '"use strict";',
    "",
    "function total(items) {",
    "  return items.reduce((sum, item) => sum + item.price, 0);",
    "}",
    "",
    "module.exports = { total };",
    "",
  ].join("\n"),
  "test/cart.test.js": [
    '"use strict";',
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const { total } = require("../src/cart");',
    "",
    'test("total adds up the prices", () => {',
    "  assert.equal(total([{ price: 1.5 }, { price: 2 }]), 3.5);",
    "});",
    "",
  ].join("\n"),
  // Pseudocode in a function, for Translate at level 1.
  "src/shipping.js": [
    '"use strict";',
    "",
    "function shipping(order) {",
    "  set cost to 5",
    "  if order's weight is more than 10",
    "    add 2 to cost",
    "  make it cheaper for members",
    "  return cost",
    "}",
    "",
    "module.exports = { shipping };",
    "",
  ].join("\n"),
};

/** What the fake model is sent to translate from src/shipping.js, without the indentation its lines share. */
const SHIPPING_STEPS = "set cost to 5\nif order's weight is more than 10\n  add 2 to cost\nmake it cheaper for members\nreturn cost";

/**
 * A request that stands alone, which must come with its own system prompt
 * and one message, and no tools: the model sees nothing but the code.
 */
async function respondStandalone(request: ChatRequest, system: string, user: string): Promise<FakeReply> {
  if (request.messages.length !== 2 || request.tools !== undefined) {
    return { content: `Not alone: ${request.messages.length} messages and ${request.tools?.length ?? 0} tools.` };
  }
  if (system === EXPLAIN_SYSTEM) {
    const expected = explainRequest("module.exports = { shipping };", "JavaScript");
    return { content: user === expected ? "`module.exports` is what another file gets when it `require`s this one." : `Explained the wrong thing: ${user}` };
  }
  if (!user.includes(`<pseudocode>\n${SHIPPING_STEPS}\n</pseudocode>`) || !user.includes("to translate into JavaScript")) {
    return { content: `Translated the wrong thing: ${user}` };
  }
  if (!user.includes("indenting with 2 spaces")) {
    return { content: `Indenting with the wrong unit: ${user}` };
  }
  // Long enough for the test to change the file while it waits.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    content:
      "```javascript\nlet cost = 5;\nif (order.weight > 10) {\n  cost += 2;\n}\nmake it cheaper for members\nreturn cost;\n```\n" +
      '- "make it cheaper for members": this says what to achieve. Say how much cheaper, and for whom.',
  };
}

/** The turns of the current request so far: how many replies the model has given since the user spoke. */
function round(request: ChatRequest): number {
  let n = 0;
  for (let i = request.messages.length - 1; i >= 0 && request.messages[i]?.role !== "user"; i--) {
    if (request.messages[i]?.role === "assistant") {
      n++;
    }
  }
  return n;
}

async function respond(request: ChatRequest): Promise<FakeReply> {
  const user = lastOf(request, "user");
  const system = request.messages[0]?.content ?? "";
  if (system === EXPLAIN_SYSTEM || system === TRANSLATE_SYSTEM) {
    return respondStandalone(request, system, user);
  }
  const n = round(request);
  if (user.includes("What does this do?")) {
    if (!user.includes('<selection path="src/cart.js" lines="3-5">') || !user.includes('<request mode="ask">')) {
      return { content: `The request didn't carry the selection: ${user.slice(0, 400)}` };
    }
    switch (n) {
      case 0:
        return { toolCalls: [{ name: "find_references", arguments: { path: "src/cart.js", line: 3, symbol: "total" } }] };
      case 1:
        return {
          toolCalls: [
            {
              name: "show_locations",
              arguments: {
                title: "Where totals come from",
                locations: [
                  { path: "src/cart.js", start_line: 3, end_line: 5, note: "adds up the prices" },
                  { path: "test/cart.test.js", start_line: 6, end_line: 8, note: "its test" },
                ],
              },
            },
          ],
        };
      default:
        return { content: "It adds up the prices: [total](src/cart.js#L3-L5), tested in `cart.test.js:6`. Not in `missing.js:3`." };
    }
  }
  if (user.includes("Add a discount")) {
    switch (n) {
      case 0:
        return { reasoning: "Read it first.", toolCalls: [{ name: "read_file", arguments: { path: "src/cart.js" } }] };
      case 1:
        return {
          toolCalls: [
            {
              name: "edit_file",
              arguments: {
                path: "src/cart.js",
                old_string: "function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}",
                new_string: "function total(items, discount = 0) {\n  return items.reduce((sum, item) => sum + item.price, 0) * (1 - discount);\n}",
              },
            },
            {
              name: "edit_file",
              arguments: {
                path: "test/cart.test.js",
                old_string: "  assert.equal(total([{ price: 1.5 }, { price: 2 }]), 3.5);\n});\n",
                new_string: '  assert.equal(total([{ price: 1.5 }, { price: 2 }]), 3.5);\n});\n\ntest("total takes a discount", () => {\n  assert.equal(total([{ price: 10 }], 0.25), 7.5);\n});\n',
              },
            },
          ],
        };
      case 2:
        return { toolCalls: [{ name: "run_command", arguments: { command: "node --test" } }] };
      default: {
        const output = request.messages[request.messages.length - 1]?.content ?? "";
        return { content: /Exit code 0/.test(output) ? "Added `discount` to [total](src/cart.js#L3-L5), with [a test](test/cart.test.js#L10-L12). The tests pass." : `The tests failed:\n${output}` };
      }
    }
  }
  if (user.includes("Review my uncommitted changes")) {
    const diff = /<diff>\n([\s\S]*)<\/diff>/.exec(user)?.[1] ?? "";
    const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
    return { content: `Reviewed ${files.join(", ") || "no diff"}: [total](src/cart.js#L3-L5) takes a discount that no caller passes.` };
  }
  if (user.includes("Look at the history")) {
    const command = ["git log --oneline -1", "git log --oneline --stat -1", "git status --short"][n];
    return command !== undefined ? { toolCalls: [{ name: "run_command", arguments: { command } }] } : { content: "Checked." };
  }
  if (user.includes(TOUR_REQUEST)) {
    return n === 0
      ? {
          toolCalls: [
            {
              name: "present_tour",
              arguments: {
                title: "How the shop is built",
                kind: "structure",
                steps: [
                  { path: "src/cart.js", start_line: 3, end_line: 5, title: "Totals", summary: "How a total is made." },
                  { path: "test/cart.test.js", start_line: 6, end_line: 8, title: "The test", summary: "What the test checks." },
                ],
              },
            },
          ],
        }
      : { content: "Two stops: the code, then its test." };
  }
  const step = /<tour_step number="(\d+)"/.exec(user);
  if (step !== null) {
    const as = user.includes("what it separates or connects") ? "structure" : "a walkthrough";
    return { content: `Step ${step[1]}: see [this](${step[1] === "1" ? "src/cart.js#L3-L5" : "test/cart.test.js#L6-L8"}), explained as ${as}.` };
  }
  return { content: `I don't know what to do with: ${user.slice(-200)}` };
}

async function main(): Promise<void> {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  const workspace = path.join(SCRATCH, "shop");
  for (const [name, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), text);
  }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: workspace, stdio: "ignore" });
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "The shop");

  const model = await startFakeModel(respond);
  const userData = path.join(SCRATCH, "user-data");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify(
      {
        "worsley.backends": [
          {
            name: "fake",
            baseUrl: model.url,
            model: "fake-small",
            extraBody: { chat_template_kwargs: { enable_thinking: false } },
            changeExtraBody: { chat_template_kwargs: { enable_thinking: true } },
          },
        ],
        "worsley.backend": "fake",
        "worsley.testCommand": "node --test",
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "window.restoreWindows": "none",
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "git.enabled": false,
        "security.workspace.trust.enabled": false,
      },
      null,
      2,
    ),
  );

  const requested = process.env.WORSLEY_TEST_VSCODE ?? "1.101.0";
  const isPath = requested.includes("/") || requested.includes("\\");
  try {
    await runTests({
      ...(isPath ? { vscodeExecutablePath: requested } : { version: requested }),
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      extensionTestsEnv: { WORSLEY_TEST_WORKSPACE: workspace },
      launchArgs: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(SCRATCH, "extensions")}`, "--disable-extensions", "--password-store=basic"],
    });
  } finally {
    await model.close();
  }
  // Every turn of a Change request thinks, and nothing else does.
  for (const request of model.requests) {
    const change = lastOf(request, "user").includes('<request mode="change">');
    const thinking = (request.chat_template_kwargs as { enable_thinking?: unknown } | undefined)?.enable_thinking;
    if (thinking !== change) {
      throw new Error(`A ${change ? "Change" : "Ask"} request was sent with enable_thinking ${String(thinking)}: ${lastOf(request, "user").slice(-120)}`);
    }
  }
  console.log(`integration: the fake model answered ${model.requests.length} requests, thinking for the Change ones only`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

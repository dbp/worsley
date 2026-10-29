import * as path from "node:path";
import { parseArgs } from "node:util";
import { runAgent, type AgentHooks } from "../../src/core/agent";
import { chatTurn, contextWindowOf, mergeBodies, type ChatMessage, type Endpoint } from "../../src/core/chat";
import { TokenGauge, withRoom, type Compaction } from "../../src/core/compact";
import { formatContext, type EditorFile } from "../../src/core/context";
import { errorText } from "../../src/core/errorText";
import * as fs from "node:fs";
import { numberLines, splitLines, summarizeFiles } from "../../src/core/files";
import { isGitRepo } from "../../src/core/git";
import { parseCodeRef, resolvePath } from "../../src/core/links";
import { workspacePath } from "../../src/core/paths";
import { systemPrompt, tourStepRequest, userRequest } from "../../src/core/prompts";
import { TOOLS, type Place, type ToolUi, type TourPlan } from "../../src/core/tools";
import type { Mode } from "../../src/protocol";
import { DiskWorkspace } from "../unit/helpers";

/**
 * One request against a real model, from the command line, with the same
 * prompts and tools as the extension (but no language servers). For trying
 * out models and prompts:
 *
 *   pnpm run live -- --root ../some-project "How are requests routed?"
 *   pnpm run live -- --mode change --test-command "pytest -q" --root … "Rename foo to bar"
 *   pnpm run live -- --base-url https://openrouter.ai/api/v1 --model anthropic/claude-sonnet-5.5 --key-env OPENROUTER_API_KEY …
 *
 * The model's reply goes to stdout; what it did along the way, to stderr.
 * Commands other than the test command run only with --yes. With --steps,
 * a tour's steps are explained one after another, as if the user pressed
 * Next each time. As the extension's `local` backend does, Change requests
 * think and others don't (`--extra`, and `--change-extra` merged over it for
 * Change requests). `--select shop/cart.py:25-28` sends the request with that
 * selection, and its file on screen, as the extension would. `--json-out`
 * writes what happened as JSON: times, tokens, tool calls, the tour, and
 * which of the replies' links lead nowhere. Room is made in the thread as
 * in the extension, in the window the server reports, or `--context N`.
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    mode: { type: "string", default: "ask" },
    "base-url": { type: "string", default: "http://127.0.0.1:8080/v1" },
    model: { type: "string", default: "Qwen3.6-35B-A3B-Q4_K_M" },
    "key-env": { type: "string" },
    extra: { type: "string", default: '{"chat_template_kwargs":{"enable_thinking":false}}' },
    "change-extra": { type: "string", default: '{"chat_template_kwargs":{"enable_thinking":true}}' },
    "test-command": { type: "string", default: "" },
    "max-rounds": { type: "string", default: "40" },
    yes: { type: "boolean", default: false },
    steps: { type: "boolean", default: false },
    select: { type: "string", multiple: true, default: [] },
    "json-out": { type: "string" },
    context: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const root = path.resolve(values.root);
const mode = values.mode as Mode;
const question = positionals.join(" ").trim();
if (values.help || question === "" || (mode !== "ask" && mode !== "change")) {
  console.error('Usage: run.js [--root DIR] [--mode ask|change] [--model ID] [--base-url URL] [--key-env VAR] [--extra JSON] [--change-extra JSON] [--test-command CMD] [--yes] [--steps] [--select PATH:START-END] [--json-out FILE] [--context TOKENS] "question"');
  process.exit(values.help ? 0 : 64);
}
const endpoint: Endpoint = {
  baseUrl: values["base-url"],
  model: values.model,
  apiKey: values["key-env"] !== undefined ? process.env[values["key-env"]] : undefined,
  extraBody: JSON.parse(values.extra) as Record<string, unknown>,
};
const changeExtraBody = JSON.parse(values["change-extra"]) as Record<string, unknown>;

const say = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

/** One request, or one tour step's explanation, as `--json-out` reports it. */
interface RequestReport {
  kind: "request" | "step";
  seconds: number;
  rounds: number;
  generated: number;
  /** The largest prompt of any turn: the context the request needed. */
  prompt: number;
  /** Prompt tokens processed rather than taken from the cache, over all turns. */
  processed: number;
  /** Generation speed of each turn. */
  speeds: number[];
  tools: { name: string; failed: boolean; summary: string }[];
  end: string;
  text: string;
  links: { ok: number; broken: string[] };
}

const report = {
  model: values.model,
  root,
  mode,
  question,
  select: values.select ?? [],
  requests: [] as RequestReport[],
  tour: undefined as TourPlan | undefined,
  locations: [] as { title: string; places: Place[] }[],
  commands: [] as string[],
  window: undefined as number | undefined,
  compactions: [] as Compaction[],
};

const gauge = new TokenGauge();

let tour: TourPlan | undefined;
const ui: ToolUi = {
  async showLocations(title: string, places: Place[]) {
    report.locations.push({ title, places });
    say(`  ▸ locations: ${title}`);
    for (const p of places) {
      say(`      ${p.path}:${p.start}-${p.end}  ${p.note}`);
    }
  },
  presentTour(plan: TourPlan) {
    tour = plan;
    report.tour = plan;
    say(`  ▸ tour: ${plan.title}`);
    for (const [i, s] of plan.steps.entries()) {
      say(`      ${i + 1}. ${s.title} (${s.path}:${s.start}-${s.end}): ${s.summary}`);
    }
  },
  async approveCommand(command: string) {
    say(`  ▸ ${values.yes ? "running" : "not running (no --yes)"}: ${command}`);
    return values.yes ? "once" : "deny";
  },
};

async function main(): Promise<void> {
  report.window = values.context !== undefined ? Number(values.context) : await contextWindowOf(endpoint, AbortSignal.timeout(10_000));
  say(`  · context window: ${report.window ?? "not reported"}`);
  const workspace = new DiskWorkspace(root);
  const files = await workspace.listFiles();
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt({
        folderName: path.basename(root),
        isGit: await isGitRepo(root),
        testCommand: values["test-command"],
        fileCount: files.length,
        files: summarizeFiles(files),
      }),
    },
    { role: "user", content: userRequest(mode, question, await editorContext(workspace)) },
  ];
  await request(workspace, messages, mode, "request");
  if (values.steps && tour !== undefined) {
    const plan: TourPlan = tour;
    for (const [i, step] of plan.steps.entries()) {
      say(`\n=== step ${i + 1}: ${step.title}`);
      const lines = splitLines(await workspace.readText(step.path));
      messages.push({ role: "user", content: tourStepRequest(plan, i, numberLines(lines, step.start, step.end)) });
      await request(workspace, messages, "ask", "step");
    }
  }
}

/** Written after every request, so a run that is stopped part way still leaves what it did. */
function writeReport(): void {
  if (values["json-out"] !== undefined) {
    fs.writeFileSync(values["json-out"], `${JSON.stringify(report, null, 2)}\n`);
  }
}

/**
 * The reply's Markdown links to code, checked against the workspace, more
 * strictly than the panel does: a range must end inside the file too.
 */
async function checkLinks(text: string, workspace: DiskWorkspace): Promise<{ ok: number; broken: string[] }> {
  const files = new Set(await workspace.listFiles());
  let ok = 0;
  const broken: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1] ?? "";
    const ref = parseCodeRef(href);
    if (ref === undefined) {
      continue;
    }
    const found = resolvePath(workspacePath(workspace.root, ref.path), ref.path, files);
    let good = found !== undefined;
    if (found !== undefined && ref.start !== undefined) {
      const lines = splitLines(await workspace.readText(found)).length;
      good = ref.start <= lines && (ref.end ?? ref.start) <= lines;
    }
    if (good) {
      ok++;
    } else {
      broken.push(href);
    }
  }
  return { ok, broken };
}

/**
 * The editor as `--select` describes it: each selection in its file, the
 * first file active, with the selection and 20 lines either side on screen.
 */
async function editorContext(workspace: DiskWorkspace): Promise<string | undefined> {
  const files = new Map<string, EditorFile>();
  for (const spec of values.select ?? []) {
    const match = /^(.+):(\d+)-(\d+)$/.exec(spec);
    if (match === null) {
      throw new Error(`--select ${spec}: expected PATH:START-END`);
    }
    const [, file = "", from = "", to = ""] = match;
    const start = Number(from);
    const end = Number(to);
    const text = await workspace.readText(file);
    const lines = splitLines(text);
    const entry = files.get(file) ?? { path: file, text, active: files.size === 0, dirty: false, visible: [], selections: [] };
    entry.visible.push({ start: Math.max(1, start - 20), end: Math.min(lines.length, end + 20) });
    entry.selections.push({ start, end, text: lines.slice(start - 1, end).join("\n") });
    files.set(file, entry);
  }
  return formatContext([...files.values()], { maxFileLines: 600, excluded: new Set(), sent: new Map() });
}

async function request(workspace: DiskWorkspace, messages: ChatMessage[], requestMode: Mode, kind: RequestReport["kind"]): Promise<void> {
  const started = Date.now();
  let generated = 0;
  let thinking = false;
  const entry: RequestReport = { kind, seconds: 0, rounds: 0, generated: 0, prompt: 0, processed: 0, speeds: [], tools: [], end: "", text: "", links: { ok: 0, broken: [] } };
  const hooks: AgentHooks = {
    turnStarted: () => {},
    content: (delta) => {
      if (thinking) {
        process.stderr.write("\n");
        thinking = false;
      }
      process.stdout.write(delta);
      entry.text += delta;
    },
    reasoning: (delta) => {
      if (!thinking) {
        process.stderr.write("  ▸ thinking: ");
        thinking = true;
      }
      process.stderr.write(delta.replace(/\n/g, " "));
    },
    status: () => {},
    turnFinished: (turn) => {
      generated += turn.usage?.completionTokens ?? 0;
      if (turn.content !== "") {
        process.stdout.write("\n");
        entry.text += "\n";
      }
      const u = turn.usage;
      entry.rounds++;
      entry.prompt = Math.max(entry.prompt, u?.promptTokens ?? 0);
      entry.processed += (u?.promptTokens ?? 0) - (u?.cachedTokens ?? 0);
      if (u?.tokensPerSecond !== undefined) {
        entry.speeds.push(Math.round(u.tokensPerSecond * 10) / 10);
      }
      say(`  · turn: ${u?.promptTokens ?? "?"} prompt (${u?.cachedTokens ?? 0} cached), ${u?.completionTokens ?? "?"} out${u?.tokensPerSecond !== undefined ? `, ${u.tokensPerSecond.toFixed(1)} tok/s` : ""}`);
    },
    toolStarted: (call) => say(`  ▸ ${call.function.name} ${call.function.arguments.slice(0, 300)}`),
    toolFinished: (call, outcome) => {
      entry.tools.push({ name: call.function.name, failed: outcome.display.failed === true, summary: outcome.display.summary });
      if (call.function.name === "run_command") {
        report.commands.push(outcome.display.summary);
      }
      const first = outcome.content.split("\n").slice(0, 3).join(" ⏎ ");
      say(`    ${outcome.display.failed === true ? "✗" : "✓"} ${first.slice(0, 240)}`);
    },
  };
  const end = await runAgent({
    chat: withRoom(
      (m, t, h, s) => chatTurn({ ...endpoint, extraBody: requestMode === "change" ? mergeBodies(endpoint.extraBody, changeExtraBody) : endpoint.extraBody }, m, t, h, s),
      {
        window: () => report.window,
        learnWindow: (tokens) => {
          report.window = tokens;
        },
        gauge,
        made: (compaction) => {
          report.compactions.push(compaction);
          say(`  ▸ made room: about ${compaction.before} → ${compaction.after} tokens, ${compaction.cleared} results cleared${compaction.summarized ? ", the earlier requests summarized" : ""}`);
        },
      },
    ),
    messages,
    tools: TOOLS,
    maxRounds: Number(values["max-rounds"]),
    context: {
      workspace,
      ui,
      mode: requestMode,
      signal: new AbortController().signal,
      commandTimeoutMs: 600_000,
      preapproved: (command) => command === values["test-command"],
      seen: new Set(),
    },
    hooks,
  });
  say(`  = ${end.reason}${end.reason === "error" ? `: ${end.message}` : ""} after ${((Date.now() - started) / 1000).toFixed(1)}s, ${generated} tokens generated`);
  entry.seconds = Math.round((Date.now() - started) / 100) / 10;
  entry.generated = generated;
  entry.end = end.reason === "error" ? `error: ${end.message}` : end.reason;
  entry.links = await checkLinks(entry.text, workspace);
  if (entry.links.broken.length > 0) {
    say(`  ! links that lead nowhere: ${entry.links.broken.join(", ")}`);
  }
  report.requests.push(entry);
  writeReport();
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});

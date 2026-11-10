import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { TOUR_REQUEST } from "../../src/core/prompts";

/**
 * Worsley's six tasks on one local model, each a run of `run.js` with
 * `--json-out`, then checked:
 *
 * - shop-ask: a question about a selected method, in the small sample;
 * - worsley-where: where something is decided, in Worsley's own source,
 *   which should end in a list of locations;
 * - shop-tour and worsley-tour: a tour, every step explained in turn;
 * - shop-change: a change with the sample's tests, and a hidden check of
 *   the behaviour asked for;
 * - worsley-change: a change to Worsley's source, with its unit tests.
 *
 * The code comes from copies made once in OUT/fixtures, so every model sees
 * the same files; each change runs in its own fresh copy. Each copy is a git
 * repository of its own, as a workspace would be. A task whose result exists
 * is skipped, so a stopped run picks up where it left off.
 *
 *   node out/test/live/suite.js --out DIR --model ID [--tasks a,b] [--extra JSON] [--change-extra JSON] [--label NAME] [--task-minutes N]
 *   node out/test/live/suite.js --out DIR --summary
 */

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "live-results" },
    model: { type: "string", default: "Qwen3.6-35B-A3B-Q4_K_M" },
    label: { type: "string" },
    extra: { type: "string", default: '{"chat_template_kwargs":{"enable_thinking":false}}' },
    "change-extra": { type: "string", default: '{"chat_template_kwargs":{"enable_thinking":true}}' },
    tasks: { type: "string" },
    // A slow local model can take half an hour over the tour of Worsley itself.
    "task-minutes": { type: "string", default: "45" },
    summary: { type: "boolean", default: false },
  },
});

/** The extension's root: this file runs from out/test/live. */
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT = path.resolve(values.out);
const FIXTURES = path.join(OUT, "fixtures");
const RUNNER = path.join(__dirname, "run.js");
const WORSLEY_TESTS = 'node esbuild.config.mjs --tests && node --test "out/test/unit/*.test.js"';

interface Report {
  model: string;
  requests: { kind: string; seconds: number; rounds: number; generated: number; prompt: number; processed: number; speeds: number[]; tools: { name: string; failed: boolean; summary: string }[]; end: string; text: string; links: { ok: number; broken: string[] } }[];
  tour?: { title: string; steps: { path: string; start: number; end: number; title: string }[] };
  locations: { title: string; places: { path: string; start: number; end: number; note: string }[] }[];
  commands: string[];
}

interface Task {
  name: string;
  /** The folder to work in, made ready for this model. */
  prepare(work: string): string;
  args(root: string): string[];
  question: string;
  /** What is wrong with the result; empty when it passes. */
  check(root: string, report: Report): string[];
}

/** Builds, packages, caches and these results, which copies leave behind. */
const LEFT_BEHIND = ["node_modules", "out", "dist", ".vscode-test", "__pycache__", "live-results"];

function skipped(name: string): boolean {
  return name === ".git" || LEFT_BEHIND.includes(name) || name.endsWith(".vsix");
}

function copy(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  // Entry by entry: cpSync won't copy a folder into one inside it, as when
  // these results are kept in the folder being copied.
  for (const name of fs.readdirSync(from).filter((n) => !skipped(n))) {
    fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, filter: (src) => !skipped(path.basename(src)) });
  }
}

/**
 * Makes `dir` a git repository of its own, with what it holds committed.
 * The runner lists a workspace's files with git, and OUT may be inside a
 * repository that ignores it, which would hide every file. What copies
 * leave behind is ignored here too, as is what the tasks write or link in,
 * such as Python's caches or Worsley's node_modules.
 */
function repository(dir: string): void {
  if (fs.existsSync(path.join(dir, ".git"))) {
    return;
  }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=suite@example.com", "-c", "user.name=Worsley's suite", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q");
  fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), [...LEFT_BEHIND, "*.vsix", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "The code as the tasks start");
}

/** The fixtures: the sample, and Worsley's source as it is now. */
function makeFixtures(): void {
  if (!fs.existsSync(path.join(FIXTURES, "shop"))) {
    copy(path.join(ROOT, "samples", "shop"), path.join(FIXTURES, "shop"));
  }
  if (!fs.existsSync(path.join(FIXTURES, "worsley"))) {
    copy(ROOT, path.join(FIXTURES, "worsley"));
    fs.rmSync(path.join(FIXTURES, "worsley", "samples"), { recursive: true, force: true });
  }
  repository(path.join(FIXTURES, "shop"));
  repository(path.join(FIXTURES, "worsley"));
}

function linkPackages(worsley: string): void {
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(worsley, "node_modules"));
}

/** The lines of `file` from the one matching `from` to the first after it matching `to`. */
function linesOf(file: string, from: RegExp, to: RegExp): string {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => from.test(l));
  const end = lines.findIndex((l, i) => i > start && to.test(l));
  if (start < 0 || end < 0) {
    throw new Error(`No ${from} … ${to} in ${file}`);
  }
  return `${start + 1}-${end + 1}`;
}

function run(command: string, cwd: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("sh", ["-c", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Problems every task can have: a request that didn't finish, links to nothing, tools failing. */
function basics(report: Report): string[] {
  const problems: string[] = [];
  for (const [i, r] of report.requests.entries()) {
    if (r.end !== "done") {
      problems.push(`request ${i + 1} ended: ${r.end}`);
    }
    if (r.text.trim() === "") {
      problems.push(`request ${i + 1} said nothing`);
    }
  }
  const broken = report.requests.flatMap((r) => r.links.broken);
  if (broken.length > 0) {
    problems.push(`links to nothing: ${broken.join(", ")}`);
  }
  // A file without language support is expected here: the runner has none.
  const failed = report.requests.flatMap((r) => r.tools).filter((t) => t.failed && !/language support/.test(t.summary));
  if (failed.length > 0) {
    problems.push(`tool calls that failed: ${failed.map((t) => `${t.name} (${t.summary.slice(0, 80)})`).join("; ")}`);
  }
  return problems;
}

function tourProblems(report: Report, mustVisit: string[], atLeast: number): string[] {
  const tour = report.tour;
  if (tour === undefined) {
    return ["no tour was presented"];
  }
  const problems: string[] = [];
  const steps = report.requests.filter((r) => r.kind === "step");
  if (steps.length !== tour.steps.length) {
    problems.push(`${steps.length} of ${tour.steps.length} steps explained`);
  }
  if (tour.steps.length < 4 || tour.steps.length > 12) {
    problems.push(`${tour.steps.length} steps, not 4 to 12`);
  }
  const visited = mustVisit.filter((file) => tour.steps.some((s) => s.path === file));
  if (visited.length < atLeast) {
    problems.push(`visits ${visited.length} of the expected files (${visited.join(", ")}), wanted ${atLeast} of ${mustVisit.join(", ")}`);
  }
  return problems;
}

const TASKS: Task[] = [
  {
    name: "shop-ask",
    prepare: () => path.join(FIXTURES, "shop"),
    args: () => ["--select", "shop/cart.py:25-28"],
    question: "Why does this take the discount off before adding the tax? Is anything relying on that order?",
    check: (_root, report) => basics(report),
  },
  {
    name: "worsley-where",
    prepare: () => path.join(FIXTURES, "worsley"),
    args: () => [],
    question: "Where does Worsley decide whether a command may run without asking the user first? Show me every place involved.",
    check: (_root, report) => {
      const problems = basics(report);
      const shown = report.locations.flatMap((l) => l.places.map((p) => p.path));
      if (shown.length === 0) {
        problems.push("no list of locations");
      }
      for (const file of ["src/core/tools.ts", "src/editor/session.ts"]) {
        if (!shown.includes(file)) {
          problems.push(`the locations leave out ${file}`);
        }
      }
      return problems;
    },
  },
  {
    name: "shop-tour",
    prepare: () => path.join(FIXTURES, "shop"),
    args: () => ["--steps"],
    question: TOUR_REQUEST,
    check: (_root, report) => [...basics(report), ...tourProblems(report, ["shop/cli.py", "shop/cart.py", "shop/pricing.py", "tests/test_cart.py"], 3)],
  },
  {
    name: "worsley-tour",
    prepare: () => path.join(FIXTURES, "worsley"),
    args: () => ["--steps"],
    question:
      "Walk me through what happens when the user sends a message from the panel: from the panel's script, through the extension, to the model and back. Step by step, please.",
    check: (_root, report) => [
      ...basics(report),
      ...tourProblems(report, ["src/webview/main.ts", "src/editor/panel.ts", "src/editor/session.ts", "src/core/agent.ts", "src/core/chat.ts"], 4),
    ],
  },
  {
    name: "shop-change",
    prepare: (work) => {
      copy(path.join(FIXTURES, "shop"), work);
      repository(work);
      return work;
    },
    args: () => ["--mode", "change", "--test-command", "python3 -m unittest -q", "--select", "shop/pricing.py:5-9"],
    question: "Let a discount code take a fixed amount off, as well as a percentage. Add a code TAKE2 that takes 2.00 off. A fixed discount must never take the amount below zero.",
    check: (root, report) => {
      const problems = basics(report);
      const tests = run("python3 -m unittest -q", root);
      if (!tests.ok) {
        problems.push(`the tests fail afterwards: ${tests.output.slice(-300)}`);
      }
      const hidden = run(
        `python3 -c "from shop.pricing import apply_discount as a; ` +
          `assert abs(a(10.0, 'TAKE2') - 8.0) < 1e-9, a(10.0, 'TAKE2'); ` +
          `assert a(1.5, 'TAKE2') == 0, a(1.5, 'TAKE2'); ` +
          `assert abs(a(10.0, 'save10') - 9.0) < 1e-9, a(10.0, 'save10'); ` +
          `assert a(5.0, None) == 5.0 and a(5.0, 'NOPE') == 5.0"`,
        root,
      );
      if (!hidden.ok) {
        problems.push(`the hidden check fails: ${hidden.output.trim().split("\n").slice(-2).join(" ")}`);
      }
      return problems;
    },
  },
  {
    name: "worsley-change",
    prepare: (work) => {
      copy(path.join(FIXTURES, "worsley"), work);
      repository(work);
      linkPackages(work);
      return work;
    },
    args: (root) => [
      "--mode",
      "change",
      "--test-command",
      WORSLEY_TESTS,
      "--select",
      `src/core/tools.ts:${linesOf(path.join(root, "src/core/tools.ts"), /^const readFile: Tool = \{/, /^\};/)}`,
    ],
    question:
      "Let read_file take an optional max_lines argument, so the model can read fewer or more lines at a time: 500 when it isn't given, and never more than 2000. Update the tests.",
    check: (root, report) => {
      const problems = basics(report);
      const tests = run(WORSLEY_TESTS, root);
      if (!tests.ok) {
        problems.push(`the unit tests fail afterwards: ${tests.output.split("\n").filter((l) => /✖|fail \d/.test(l)).slice(0, 6).join(" | ")}`);
      }
      const types = run("node_modules/.bin/tsc -p . && node_modules/.bin/tsc -p test", root);
      if (!types.ok) {
        problems.push(`it doesn't type-check: ${types.output.trim().split("\n").slice(0, 3).join(" | ")}`);
      }
      const tools = fs.readFileSync(path.join(root, "src/core/tools.ts"), "utf8");
      if (!/max_lines/.test(tools)) {
        problems.push("read_file has no max_lines");
      }
      if (!/max_lines/.test(fs.readFileSync(path.join(root, "test/unit/tools.test.ts"), "utf8"))) {
        problems.push("no test uses max_lines");
      }
      return problems;
    },
  },
];

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9.-]+/g, "_");
}

function runTask(task: Task, dir: string): Promise<void> {
  const work = path.join(dir, "work", task.name);
  fs.mkdirSync(path.dirname(work), { recursive: true });
  const root = task.prepare(work);
  const json = path.join(dir, `${task.name}.json`);
  const args = [RUNNER, "--root", root, "--model", values.model, "--extra", values.extra, "--change-extra", values["change-extra"], "--json-out", json, ...task.args(root), task.question];
  const started = Date.now();
  process.stderr.write(`[${new Date().toLocaleTimeString()}] ${task.name}…`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", fs.openSync(path.join(dir, `${task.name}.out`), "w"), fs.openSync(path.join(dir, `${task.name}.err`), "w")] });
    const timer = setTimeout(() => child.kill(), Number(values["task-minutes"]) * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 1000);
      let problems: string[];
      if (!fs.existsSync(json)) {
        problems = [`the runner exited with ${code} and no report`];
      } else {
        const report = JSON.parse(fs.readFileSync(json, "utf8")) as Report;
        const stopped = code !== 0 ? [`stopped after ${seconds}s (exit ${code}); what it did by then is checked`] : [];
        try {
          problems = [...stopped, ...task.check(root, report)];
        } catch (err) {
          problems = [...stopped, `the check failed: ${err instanceof Error ? err.message : String(err)}`];
        }
        if (task.name.endsWith("change")) {
          const diff = run(`diff -ruN --exclude=.git --exclude=node_modules --exclude=out --exclude=__pycache__ ${JSON.stringify(path.join(FIXTURES, task.name.split("-")[0] as string))} ${JSON.stringify(root)} || true`, dir);
          fs.writeFileSync(path.join(dir, `${task.name}.diff`), diff.output);
        }
      }
      fs.writeFileSync(path.join(dir, `${task.name}.check`), `${JSON.stringify({ seconds, problems }, null, 2)}\n`);
      process.stderr.write(` ${seconds}s, ${problems.length === 0 ? "passed" : `${problems.length} problem(s)`}\n`);
      for (const problem of problems) {
        process.stderr.write(`    - ${problem}\n`);
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  if (values.summary) {
    summarize();
    return;
  }
  makeFixtures();
  const dir = path.join(OUT, slug(values.label ?? values.model));
  fs.mkdirSync(dir, { recursive: true });
  const wanted = values.tasks?.split(",") ?? TASKS.map((t) => t.name);
  for (const task of TASKS.filter((t) => wanted.includes(t.name))) {
    if (fs.existsSync(path.join(dir, `${task.name}.check`))) {
      process.stderr.write(`${task.name}: done already\n`);
      continue;
    }
    await runTask(task, dir);
  }
}

/** A table of every model's results in OUT, task by task. */
function summarize(): void {
  const models = fs
    .readdirSync(OUT)
    .filter((name) => name !== "fixtures" && fs.statSync(path.join(OUT, name)).isDirectory())
    .sort();
  const rows: string[] = ["| task | model | result | time | rounds | generated | tok/s | prompt processed | context |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const task of TASKS) {
    for (const model of models) {
      const check = path.join(OUT, model, `${task.name}.check`);
      const json = path.join(OUT, model, `${task.name}.json`);
      if (!fs.existsSync(check)) {
        continue;
      }
      const { seconds, problems } = JSON.parse(fs.readFileSync(check, "utf8")) as { seconds: number; problems: string[] };
      const report = fs.existsSync(json) ? (JSON.parse(fs.readFileSync(json, "utf8")) as Report) : undefined;
      const requests = report?.requests ?? [];
      const sum = (f: (r: Report["requests"][number]) => number): number => requests.reduce((n, r) => n + f(r), 0);
      const speeds = requests.flatMap((r) => r.speeds).sort((a, b) => a - b);
      const median = speeds.length > 0 ? speeds[Math.floor(speeds.length / 2)] : undefined;
      const result = problems.length === 0 ? "pass" : `**${problems.length} problem${problems.length === 1 ? "" : "s"}**`;
      rows.push(
        `| ${task.name} | ${model} | ${result} | ${seconds}s | ${sum((r) => r.rounds)} | ${sum((r) => r.generated)} | ${median ?? "?"} | ${sum((r) => r.processed)} | ${Math.max(0, ...requests.map((r) => r.prompt))} |`,
      );
    }
  }
  const text = `${rows.join("\n")}\n`;
  fs.writeFileSync(path.join(OUT, "SUMMARY.md"), text);
  process.stdout.write(text);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { chatTurn, type Endpoint } from "../../src/core/chat";
import { errorText } from "../../src/core/errorText";
import { keepsLines, type Excerpt } from "../../src/core/functions";
import { parseCodeRef } from "../../src/core/links";
import { CHECK_SYSTEM, checkRequest, codeIn, FILL_SYSTEM, fillRequest } from "../../src/core/standalone";

/**
 * Level 2, measured against a real model, on Python.
 *
 * Check: a function, its docstring and its tests, which either fit together
 * or have something planted that doesn't: code that contradicts the
 * docstring, a special case nothing mentions, a promised error the code
 * doesn't raise, a test that contradicts the docstring. A check passes when
 * its verdict is right and, where something doesn't fit, it links to the
 * lines where it is.
 *
 * Fill: a header, a docstring and tests. The body written must keep the
 * header and docstring, add nothing the case rules out, and pass the tests,
 * which are run with python3. Where the docstring and tests contradict each
 * other, or the function has a body already, it must write nothing.
 *
 *   pnpm run live:functions -- [--base-url URL] [--model ID] [--key-env VAR] [--extra JSON] [--runs N] [--parallel N] [--cases a,b] [--show] [--json-out FILE]
 */

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:8080/v1" },
    model: { type: "string", default: "Qwen3.6-35B-A3B-Q4_K_M" },
    "key-env": { type: "string" },
    extra: { type: "string", default: '{"chat_template_kwargs":{"enable_thinking":false}}' },
    runs: { type: "string", default: "3" },
    parallel: { type: "string", default: "1" },
    cases: { type: "string" },
    show: { type: "boolean", default: false },
    "json-out": { type: "string" },
  },
});

const endpoint: Endpoint = {
  baseUrl: values["base-url"],
  model: values.model,
  apiKey: values["key-env"] !== undefined ? process.env[values["key-env"]] : undefined,
  extraBody: JSON.parse(values.extra) as Record<string, unknown>,
};

interface CheckCase {
  kind: "check";
  name: string;
  /** The function, starting at line 1 of `<name>.py`. */
  fn: string;
  /** The tests, starting at line 1 of `test_<name>.py`. */
  tests: string;
  fits: boolean;
  /** Lines a report that something doesn't fit must link to: `fn` or `tests`, and a line. */
  links?: ["fn" | "tests", number][];
  mention?: RegExp[];
}

interface FillCase {
  kind: "fill";
  name: string;
  fn: string;
  tests: string;
  /** It must write no code. */
  none?: boolean;
  /** Writing nothing is right too, as long as the reply says why. */
  noneAllowed?: boolean;
  noMatch?: RegExp[];
  /** What the notes after the code must mention. */
  mention?: RegExp[];
}

type Case = CheckCase | FillCase;

const CASES: Case[] = [
  {
    kind: "check",
    name: "fits",
    fn: 'def average(numbers):\n    """Return the mean of numbers. An empty list has mean 0."""\n    if not numbers:\n        return 0\n    return sum(numbers) / len(numbers)',
    tests: "def test_average():\n    assert average([1, 2, 3]) == 2\n\ndef test_average_empty():\n    assert average([]) == 0",
    fits: true,
  },
  {
    kind: "check",
    name: "fits-loop",
    fn: 'def longest_word(words):\n    """Return the longest string in words; if several are longest, the first of them.\n    An empty list gives the empty string."""\n    longest = ""\n    for word in words:\n        if len(word) > len(longest):\n            longest = word\n    return longest',
    tests:
      'def test_longest_word():\n    assert longest_word(["a", "abc", "ab"]) == "abc"\n\ndef test_longest_word_tie():\n    assert longest_word(["ab", "cd"]) == "ab"\n\ndef test_longest_word_empty():\n    assert longest_word([]) == ""',
    fits: true,
  },
  {
    kind: "check",
    name: "code-contradicts-doc",
    fn: 'def largest(numbers):\n    """Return the largest of numbers."""\n    best = numbers[0]\n    for n in numbers:\n        if n < best:\n            best = n\n    return best',
    tests: "def test_largest():\n    assert largest([3, 1, 2]) == 3",
    fits: false,
    links: [["fn", 5]],
  },
  {
    kind: "check",
    name: "unmentioned-case",
    fn: 'def shipping_cost(weight):\n    """Return the cost of shipping a parcel: 2 per kilogram."""\n    if weight > 20:\n        return 50\n    return weight * 2',
    tests: "def test_shipping_cost():\n    assert shipping_cost(3) == 6\n    assert shipping_cost(10) == 20",
    fits: false,
    links: [["fn", 3]],
  },
  {
    kind: "check",
    name: "promised-error",
    fn: 'def average_grade(grades):\n    """Return the mean of grades. Raises ValueError if grades is empty."""\n    return sum(grades) / len(grades)',
    tests: "def test_average_grade():\n    assert average_grade([80, 90]) == 85",
    fits: false,
    links: [["fn", 2]],
    mention: [/ValueError/],
  },
  {
    kind: "check",
    name: "test-contradicts-doc",
    fn: 'def count_vowels(word):\n    """Return how many of the letters in word are vowels: a, e, i, o, u or y."""\n    return sum(1 for letter in word if letter in "aeiouy")',
    tests: 'def test_count_vowels():\n    assert count_vowels("hello") == 2\n    assert count_vowels("sky") == 0',
    fits: false,
    links: [["tests", 3]],
  },
  {
    kind: "fill",
    name: "fill-average",
    fn: 'def average(numbers):\n    """Return the mean of numbers. An empty list has mean 0."""\n    pass',
    tests: "def test_average():\n    assert average([1, 2, 3]) == 2\n    assert average([5]) == 5\n\ndef test_average_empty():\n    assert average([]) == 0",
  },
  {
    kind: "fill",
    name: "fill-leaves-open",
    fn: 'def average(numbers):\n    """Return the mean of numbers."""\n    pass',
    tests: "def test_average():\n    assert average([2, 4]) == 3",
    noMatch: [/if not numbers|len\(numbers\) == 0|if numbers|try:|except/],
    mention: [/empty/i],
  },
  {
    kind: "fill",
    name: "fill-no-extra-checks",
    fn: 'def initial(name):\n    """Return the first letter of name, in upper case."""\n    ...',
    tests: 'def test_initial():\n    assert initial("ada") == "A"',
    noMatch: [/if not name|len\(name\)|try:|raise|isinstance/],
  },
  {
    kind: "fill",
    name: "fill-fizzbuzz",
    fn: 'def fizzbuzz(n):\n    """Return "Fizz" for a multiple of 3, "Buzz" for a multiple of 5,\n    "FizzBuzz" for a multiple of both, and n as a string otherwise."""\n    pass',
    tests: 'def test_fizzbuzz():\n    assert fizzbuzz(3) == "Fizz"\n    assert fizzbuzz(5) == "Buzz"\n    assert fizzbuzz(15) == "FizzBuzz"\n    assert fizzbuzz(7) == "7"',
  },
  {
    kind: "fill",
    name: "fill-too-little",
    fn: 'def grade(score):\n    """Return the letter grade for score."""\n    pass',
    tests: 'def test_grade():\n    assert grade(95) == "A"\n    assert grade(85) == "B"\n    assert grade(50) == "F"',
    noneAllowed: true,
    // Grades the tests never mention would be the model's own.
    noMatch: [/["'][CDE]["']/],
    mention: [/open|say|threshold|cut|boundar|between|unclear|only/i],
  },
  {
    kind: "fill",
    name: "fill-contradiction",
    fn: 'def bigger(a, b):\n    """Return the larger of a and b."""\n    pass',
    tests: "def test_bigger():\n    assert bigger(1, 2) == 1",
    none: true,
    mention: [/bigger\(1, 2\)|test/i],
  },
  {
    kind: "fill",
    name: "fill-has-body",
    fn: 'def double(n):\n    """Return twice n."""\n    return n * 2',
    tests: "def test_double():\n    assert double(4) == 8",
    none: true,
  },
];

function excerpt(file: string, text: string): Excerpt {
  return { path: file, start: 1, lines: text.split("\n") };
}

interface Result {
  reply: string;
  seconds: number;
  cost: number;
  problems: string[];
}

/** Whether the tests pass with `code` as the function, run by python3 in a folder of its own. */
function testsPass(code: string, tests: string): { ok: boolean; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worsley-fill-"));
  const file = path.join(dir, "check.py");
  const runner = "\n\nfor _name, _test in list(globals().items()):\n    if _name.startswith('test_') and callable(_test):\n        _test()\nprint('passed')\n";
  fs.writeFileSync(file, `${code}\n\n${tests}${runner}`);
  try {
    const output = execFileSync("python3", ["-I", file], { cwd: dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: output.includes("passed"), output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkCheck(c: CheckCase, reply: string): string[] {
  const problems: string[] = [];
  const first = reply.trim().split("\n")[0] ?? "";
  const verdict = /^\*\*They (don['’]t )?fit\.\*\*/.exec(first);
  if (verdict === null) {
    problems.push(`no verdict: ${first.slice(0, 60)}`);
  } else if ((verdict[1] === undefined) !== c.fits) {
    problems.push(c.fits ? "says they don't fit" : "says they fit");
  }
  const links = [...reply.matchAll(/\]\(([^)\s]+)\)/g)].flatMap((m) => {
    const ref = parseCodeRef(m[1] ?? "");
    return ref === undefined ? [] : [ref];
  });
  for (const [which, line] of c.links ?? []) {
    const file = which === "fn" ? `${c.name}.py` : `test_${c.name}.py`;
    const found = links.some((ref) => ref.path.endsWith(file) && ref.start !== undefined && ref.start <= line && line <= (ref.end ?? ref.start));
    if (!found) {
      problems.push(`no link to ${file}:${line}`);
    }
  }
  for (const pattern of c.mention ?? []) {
    if (!pattern.test(reply)) {
      problems.push(`doesn't mention ${pattern}`);
    }
  }
  if (/^ {0,3}```/m.test(reply)) {
    problems.push("wrote code");
  }
  return problems;
}

function checkFill(c: FillCase, reply: string): string[] {
  const written = codeIn(reply);
  // The function given back as it was changes nothing in the editor, as no code doesn't.
  const same = (a: string, b: string): boolean => a.split("\n").filter((l) => l.trim() !== "").join("\n") === b.split("\n").filter((l) => l.trim() !== "").join("\n");
  const code = written !== undefined && same(written, c.fn) ? undefined : written;
  if (code === undefined) {
    if (c.none === true || c.noneAllowed === true) {
      return (c.mention ?? []).filter((p) => c.none === true && !p.test(reply)).map((p) => `doesn't mention ${p}`);
    }
    return ["no code"];
  }
  if (c.none === true) {
    return ["wrote code where it should have written none"];
  }
  const problems: string[] = [];
  if (!keepsLines(c.fn.split("\n"), code.split("\n"))) {
    problems.push("changed the header or docstring");
  }
  for (const pattern of c.noMatch ?? []) {
    if (pattern.test(code)) {
      problems.push(`has ${pattern}`);
    }
  }
  const after = reply.slice(reply.lastIndexOf("```") + 3);
  for (const pattern of c.mention ?? []) {
    if (!pattern.test(after)) {
      problems.push(`the notes don't mention ${pattern}`);
    }
  }
  const run = testsPass(code, c.tests);
  if (!run.ok) {
    problems.push(`the tests fail: ${run.output.split("\n").slice(-1)[0] ?? ""}`);
  }
  return problems;
}

async function ask(c: Case): Promise<Result> {
  const started = Date.now();
  const fn = excerpt(`${c.name}.py`, c.fn);
  const tests = [excerpt(`test_${c.name}.py`, c.tests)];
  const turn = await chatTurn(
    endpoint,
    [
      { role: "system", content: c.kind === "check" ? CHECK_SYSTEM : FILL_SYSTEM },
      { role: "user", content: c.kind === "check" ? checkRequest(fn, tests, "Python") : fillRequest(fn, tests, "Python", "4 spaces") },
    ],
    [],
    {},
    AbortSignal.timeout(600_000),
  );
  const problems = c.kind === "check" ? checkCheck(c, turn.content) : checkFill(c, turn.content);
  return { reply: turn.content, seconds: (Date.now() - started) / 1000, cost: turn.usage?.cost ?? 0, problems };
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number(values.runs));
  const wanted = values.cases?.split(",");
  const cases = CASES.filter((c) => wanted === undefined || wanted.includes(c.name));
  const results = cases.map((c) => ({ name: c.name, kind: c.kind, replies: [] as Result[] }));
  const jobs = cases.flatMap((c, i) => Array.from({ length: runs }, () => ({ c, result: results[i] as (typeof results)[number] })));
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
      let r: Result;
      try {
        r = await ask(job.c);
      } catch (err) {
        r = { reply: "", seconds: 0, cost: 0, problems: [`error: ${errorText(err)}`] };
      }
      job.result.replies.push(r);
      process.stderr.write(`${job.c.name} #${job.result.replies.length}: ${r.problems.length === 0 ? "pass" : r.problems.join("; ")} (${r.seconds.toFixed(1)}s)\n`);
      if (values.show) {
        process.stderr.write(`${r.reply.replace(/^/gm, "    ")}\n`);
      }
      if (values["json-out"] !== undefined) {
        fs.writeFileSync(values["json-out"], `${JSON.stringify({ model: values.model, extra: values.extra, results }, null, 2)}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  const rows = ["| case | passed | seconds |", "| --- | --- | --- |"];
  for (const r of results) {
    const passed = r.replies.filter((x) => x.problems.length === 0).length;
    rows.push(`| ${r.name} | ${passed}/${r.replies.length} | ${(r.replies.reduce((n, x) => n + x.seconds, 0) / r.replies.length).toFixed(1)} |`);
  }
  const all = results.flatMap((r) => r.replies);
  const by = (kind: Case["kind"]): string => {
    const replies = results.filter((r) => r.kind === kind).flatMap((r) => r.replies);
    return `${replies.filter((x) => x.problems.length === 0).length}/${replies.length}`;
  };
  const cost = all.reduce((n, x) => n + x.cost, 0);
  process.stdout.write(`${values.model} (${values.extra})\n\n${rows.join("\n")}\n\nCheck: ${by("check")} passed. Fill: ${by("fill")} passed.${cost > 0 ? ` Cost: $${cost.toFixed(4)}.` : ""}\n`);
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});

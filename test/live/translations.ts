import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { chatTurn, type Endpoint } from "../../src/core/chat";
import { errorText } from "../../src/core/errorText";
import { codeIn, languageName, TRANSLATE_SYSTEM, translateRequest } from "../../src/core/standalone";
import { addedDetails, type CheckedLanguage } from "./details";

/**
 * Translate, measured against a real model. Each case is a student's lines
 * with something in them to get wrong: a line that asks for code, a step
 * that leaves out a value, a mistake that must stay a mistake, input that
 * mustn't be turned into a number. Each is translated several times, and
 * each translation is checked for the user's measure, that nothing is in
 * the code that isn't in what the student wrote (see details.ts), and for
 * what the case itself expects.
 *
 *   pnpm run live:translate -- [--base-url URL] [--model ID] [--key-env VAR] [--extra JSON] [--runs N] [--parallel N] [--cases a,b] [--show] [--json-out FILE]
 *
 * With --show each reply is printed as it comes. --parallel sends that many
 * requests at once, for a server that takes them, such as OpenRouter. As
 * with run.ts, the defaults are the `local` backend: llama.cpp, Qwen
 * without thinking, one request at a time.
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
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.error("Usage: translations.js [--base-url URL] [--model ID] [--key-env VAR] [--extra JSON] [--runs N] [--parallel N] [--cases a,b] [--show] [--json-out FILE]");
  process.exit(0);
}

const endpoint: Endpoint = {
  baseUrl: values["base-url"],
  model: values.model,
  apiKey: values["key-env"] !== undefined ? process.env[values["key-env"]] : undefined,
  extraBody: JSON.parse(values.extra) as Record<string, unknown>,
};

interface Case {
  name: string;
  language: CheckedLanguage;
  /** What the student wrote. */
  lines: string;
  /** Lines that aren't steps, which must come back exactly as written. */
  keep?: string[];
  match?: RegExp[];
  noMatch?: RegExp[];
  /** Names and numbers this case accepts, besides the student's words. */
  allow?: string[];
  /** It is code already, which must come back as it is. */
  same?: boolean;
}

const CASES: Case[] = [
  {
    name: "steps",
    language: "python",
    lines: "set total to 0\nfor each price in prices\n    add price to total\nreturn total",
    match: [/^total = 0$/m, /^for price in prices:$/m, /^ {4}total (?:\+= price|= total \+ price)$/m, /^return total$/m],
  },
  {
    name: "steps-into-code",
    language: "python",
    lines: 'def count_vowels(word):\n    set count to 0\n    for each letter in word\n        if letter is in "aeiou"\n            add 1 to count\n    return count',
    match: [/^def count_vowels\(word\):$/m, /^ {4}count = 0$/m, /^ {4}for letter in word:$/m, /^ {8}if letter in "aeiou":$/m, /count (?:\+= 1|= count \+ 1)$/m, /^ {4}return count$/m],
  },
  {
    name: "keeps-comment",
    language: "python",
    lines: "# add up the prices\nset total to 0\nfor each price in prices\n    add price to total",
    match: [/^# add up the prices$/m, /^total = 0$/m],
  },
  {
    name: "asks-for-code",
    language: "python",
    lines: "write a function that sorts the list of names alphabetically",
    keep: ["write a function that sorts the list of names alphabetically"],
  },
  {
    name: "asks-for-function",
    language: "python",
    lines: "make a function to compute the average of the list",
    keep: ["make a function to compute the average of the list"],
  },
  {
    name: "goal",
    language: "python",
    lines: "check whether n is prime",
    keep: ["check whether n is prime"],
  },
  {
    name: "asks-for-algorithm",
    language: "python",
    lines: "sort the scores using bubble sort",
    keep: ["sort the scores using bubble sort"],
  },
  {
    name: "request-among-steps",
    language: "python",
    lines: "set count to 0\nfor each line in lines\n    now make this ignore blank lines\n    add 1 to count\nprint count",
    keep: ["now make this ignore blank lines"],
    match: [/^count = 0$/m, /^for line in lines:$/m, /^ {4}count (?:\+= 1|= count \+ 1)$/m, /^print\(count\)$/m],
    noMatch: [/if not line|line\.strip\(\)|if line/],
  },
  {
    name: "vague-under-condition",
    language: "python",
    lines: "if password is not equal to secret\n    tell the user",
    keep: ["tell the user"],
    match: [/^if password != secret:$/m],
  },
  {
    name: "goal-among-steps",
    language: "python",
    lines:
      "define a function average that takes numbers\n    set total to 0\n    for each n in numbers\n        add n to total\n    handle the case where numbers is empty\n    return total divided by length of numbers",
    keep: ["handle the case where numbers is empty"],
    match: [/^def average\(numbers\):$/m, /^ {4}return total \/ len\(numbers\)$/m],
    noMatch: [/if not numbers|len\(numbers\) == 0|if numbers/],
  },
  {
    name: "vague-condition",
    language: "python",
    lines: 'if the score is high enough\n    print "you win"',
    keep: ["if the score is high enough"],
  },
  {
    name: "vague-action",
    language: "python",
    lines: "for each order in orders\n    if the order's total is more than 100\n        deal with it",
    keep: ["deal with it"],
    match: [/^for order in orders:$/m, /^ {4}if order\.total > 100:$/m],
  },
  {
    name: "keeps-mistake",
    language: "python",
    lines: "for i from 1 to length of items\n    print items[i]",
    match: [/^for i in range\(1, len\(items\) \+ 1\):$/m, /^ {4}print\(items\[i\]\)$/m],
  },
  {
    name: "no-conversion",
    language: "python",
    lines: 'ask the user for their age\nif age is greater than 18\n    print "adult"',
    match: [/^age = input\(\)$/m, /^if age > 18:$/m],
    noMatch: [/\bint\(/],
  },
  {
    name: "no-starting-value",
    language: "python",
    lines: "for each item in cart\n    add the item's price to total\nprint total",
    match: [/^print\(total\)$/m],
    noMatch: [/^total = /m],
  },
  {
    name: "mends-syntax",
    language: "python",
    lines: "if x = 5\n  print x\nelse\n  x++",
    match: [/^if x == 5:$/m, /^ {4}print\(x\)$/m, /^else:$/m, /^ {4}x (?:\+= 1|= x \+ 1)$/m],
  },
  {
    name: "built-in-steps",
    language: "python",
    lines: "sort the names\nprint the first name",
    match: [/names\.sort\(\)|sorted\(names\)/, /print\(names\[0\]\)/],
    allow: ["0"],
  },
  {
    name: "header-only",
    language: "python",
    lines: "function greet that takes name",
    match: [/^def greet\(name\):$/m],
    noMatch: [/\bpass\b|return|print/],
  },
  {
    name: "fizzbuzz",
    language: "python",
    lines:
      'for each number from 1 to 100\n    if number is divisible by 15\n        print "FizzBuzz"\n    otherwise if number is divisible by 3\n        print "Fizz"\n    otherwise if number is divisible by 5\n        print "Buzz"\n    otherwise\n        print number',
    match: [
      /^for number in range\(1, 101\):$/m,
      /^ {4}if number % 15 == 0:$/m,
      /^ {8}print\("FizzBuzz"\)$/m,
      /^ {4}elif number % 3 == 0:$/m,
      /^ {4}elif number % 5 == 0:$/m,
      /^ {4}else:$/m,
      /^ {8}print\(number\)$/m,
    ],
    // Divisible means no remainder.
    allow: ["0"],
  },
  {
    name: "already-code",
    language: "python",
    lines: "for name in names:\n    print(name)",
    same: true,
  },
  {
    name: "java-steps",
    language: "java",
    lines: "set count to 0\nfor each word in words\n    if word's length is more than 5\n        add 1 to count\nprint count",
    match: [/count = 0;/, /for \((?:String|var) word : words\)/, /word\.length\(\) > 5/, /count(?:\+\+| \+= 1| = count \+ 1);/, /System\.out\.println\(count\);/],
  },
  {
    name: "java-asks-for-code",
    language: "java",
    lines: "create a method that reverses a string",
    keep: ["create a method that reverses a string"],
  },
];

const NAMES: Record<CheckedLanguage, string> = { python: "python", java: "java", javascript: "javascript" };

interface Translation {
  reply: string;
  reasoning: string;
  seconds: number;
  /** In US dollars, as OpenRouter reports it. */
  cost: number;
  problems: string[];
  /** Nothing in the code that isn't in what the student wrote. */
  faithful: boolean;
}

/** Kinds of problem, for the summary, by how each problem's text starts. */
const KINDS: [string, RegExp][] = [
  ["added details", /^not in the original/],
  ["didn't keep a line", /^didn't keep/],
  ["didn't say why", /^didn't say why/],
  ["explained a translated line", /^explained /],
  ["missed what the case expects", /^(?:nothing matches|has |changed code)/],
  ["no code", /^no code block/],
  ["errors", /^error/],
];

/** What is wrong with one translation of `c`. */
function check(c: Case, reply: string): { problems: string[]; faithful: boolean } {
  const code = codeIn(reply);
  if (code === undefined) {
    return { problems: ["no code block"], faithful: false };
  }
  const problems: string[] = [];
  const codeLines = code.split("\n").map((line) => line.trim());
  const after = reply.slice(reply.indexOf(code) + code.length);
  for (const line of c.keep ?? []) {
    if (!codeLines.includes(line.trim())) {
      problems.push(`didn't keep “${line}” as written`);
    } else if (!after.includes(line.trim())) {
      problems.push(`didn't say why “${line}” was kept`);
    }
  }
  // Notes are for lines kept as written: one about a line that was translated contradicts the code.
  const studentLines = c.lines.split("\n").map((line) => line.trim());
  for (const quote of after.matchAll(/["“`]([^"”`\n]+)["”`]/g)) {
    const quoted = (quote[1] ?? "").trim();
    if (studentLines.includes(quoted) && !codeLines.includes(quoted)) {
      problems.push(`explained “${quoted}”, which it translated`);
    }
  }
  for (const pattern of c.match ?? []) {
    if (!pattern.test(code)) {
      problems.push(`nothing matches ${pattern}`);
    }
  }
  for (const pattern of c.noMatch ?? []) {
    if (pattern.test(code)) {
      problems.push(`has ${pattern}`);
    }
  }
  if (c.same === true && code.trim() !== c.lines.trim()) {
    problems.push("changed code that needed no translating");
  }
  const added = addedDetails(code, c.lines, c.language, c.allow);
  const details = [
    added.names.length > 0 && `names: ${added.names.join(", ")}`,
    added.numbers.length > 0 && `numbers: ${added.numbers.join(", ")}`,
    added.strings.length > 0 && `strings: ${added.strings.join(", ")}`,
    added.comments.length > 0 && `comments: ${added.comments.join(" | ")}`,
  ].filter((d): d is string => typeof d === "string");
  if (details.length > 0) {
    problems.push(`not in the original: ${details.join("; ")}`);
  }
  return { problems, faithful: details.length === 0 };
}

async function translate(c: Case): Promise<Translation> {
  const started = Date.now();
  const language = languageName(NAMES[c.language]) ?? c.language;
  const turn = await chatTurn(
    endpoint,
    [
      { role: "system", content: TRANSLATE_SYSTEM },
      { role: "user", content: translateRequest(c.lines, language, "4 spaces") },
    ],
    [],
    {},
    AbortSignal.timeout(600_000),
  );
  return { reply: turn.content, reasoning: turn.reasoning, seconds: (Date.now() - started) / 1000, cost: turn.usage?.cost ?? 0, ...check(c, turn.content) };
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number(values.runs));
  const wanted = values.cases?.split(",");
  const cases = CASES.filter((c) => wanted === undefined || wanted.includes(c.name));
  const results = cases.map((c) => ({ name: c.name, translations: [] as Translation[] }));
  const jobs = cases.flatMap((c, i) => Array.from({ length: runs }, () => ({ c, result: results[i] as (typeof results)[number] })));
  const save = (): void => {
    if (values["json-out"] !== undefined) {
      fs.writeFileSync(values["json-out"], `${JSON.stringify({ model: values.model, extra: values.extra, results }, null, 2)}\n`);
    }
  };
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
      let t: Translation;
      try {
        t = await translate(job.c);
      } catch (err) {
        t = { reply: "", reasoning: "", seconds: 0, cost: 0, problems: [`error: ${errorText(err)}`], faithful: false };
      }
      job.result.translations.push(t);
      const n = job.result.translations.length;
      process.stderr.write(`${job.c.name} #${n}: ${t.problems.length === 0 ? "pass" : t.problems.join("; ")} (${t.seconds.toFixed(1)}s${t.reasoning !== "" ? `, thought ${t.reasoning.length} chars` : ""})\n`);
      if (values.show) {
        process.stderr.write(`${t.reply.replace(/^/gm, "    ")}\n`);
      }
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  const all = results.flatMap((r) => r.translations);
  const rows = ["| case | passed | faithful | seconds |", "| --- | --- | --- | --- |"];
  for (const r of results) {
    const passed = r.translations.filter((t) => t.problems.length === 0).length;
    const faithful = r.translations.filter((t) => t.faithful).length;
    const seconds = r.translations.reduce((n, t) => n + t.seconds, 0) / r.translations.length;
    rows.push(`| ${r.name} | ${passed}/${r.translations.length} | ${faithful}/${r.translations.length} | ${seconds.toFixed(1)} |`);
  }
  const passed = all.filter((t) => t.problems.length === 0).length;
  const faithful = all.filter((t) => t.faithful).length;
  rows.push(`| **all** | **${passed}/${all.length}** | **${faithful}/${all.length}** | |`);
  const kinds = KINDS.map(([kind, pattern]) => `${kind}: ${all.filter((t) => t.problems.some((p) => pattern.test(p))).length}`).filter((k) => !k.endsWith(": 0"));
  const cost = all.reduce((n, t) => n + t.cost, 0);
  process.stdout.write(
    `${values.model} (${values.extra})\n\n${rows.join("\n")}\n\n` +
      "faithful: nothing in the code that isn't in what the student wrote. passed: that, and everything the case expects.\n" +
      (kinds.length > 0 ? `Translations with each kind of problem: ${kinds.join("; ")}.\n` : "") +
      (cost > 0 ? `Cost: $${cost.toFixed(4)}.\n` : ""),
  );
}

main().catch((err: unknown) => {
  console.error(errorText(err));
  process.exit(1);
});

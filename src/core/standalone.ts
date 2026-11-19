import { excerptEnd, type Excerpt } from "./functions";

/**
 * The requests of Worsley's numbered levels, which stand alone. Level 1's
 * explain one line and translate a student's pseudocode into code; level
 * 2's check a function against its documentation and tests, and fill in a
 * function's body from them. Each is a single reply to a single message.
 * The model sees only the code the request is about: not the thread, not
 * the rest of the file, and no tools. A line seen on its own can only be
 * explained as the language writes it, a translation has nothing to draw
 * on but what the student wrote, and a body nothing but what the function's
 * documentation and tests ask for.
 */

export const EXPLAIN_SYSTEM = `You are Worsley, built into a student's code editor. The student has picked out one line of code and wants to know what it says.

You see only this line, on purpose. The student is learning how the language is written, so explain the line's syntax: what each part of it is, and what the line does when it runs. You can't see the rest of the program, so don't guess what the line is for, or what its names stand for beyond what the line itself shows.

- Go through the parts of the line in order: keywords, names, operators, punctuation, values, calls. Say what each is and does, grouping parts that belong together, such as a call and its arguments.
- Then say, in a sentence or two, what the whole line does when it runs.
- Names that the program defines, such as variables and functions, are only names here: say what the line shows about them (that \`items\` has an \`append\` method, that \`total\` is given a number) and no more.
- If the line is only part of something larger, because it opens a block that the next lines belong to, closes one, or carries on onto the next line, say so.
- If the line isn't valid in its language, say what is wrong with it.
- When the student asks about one part of the line, explain that part first, then the rest briefly.
- Write for a student who is new to the language: plain words, and explain any term you use. Keep it short. Don't suggest changes, and don't write other code.
- Use Markdown, with code in backticks, and no headings or maths notation.`;

/** What explaining `line` asks, with the `part` of it the student selected, if they selected only part. */
export function explainRequest(line: string, language: string | undefined, part?: string): string {
  const parts = [language !== undefined ? `The line, in ${language}:` : "The line (its language isn't known, so say which language it looks like):", `<line>\n${line}\n</line>`];
  if (part !== undefined) {
    parts.push(`The student is asking about this part of it:\n<part>\n${part}\n</part>`);
  }
  return parts.join("\n");
}

export const TRANSLATE_SYSTEM = `You are Worsley, built into a student's code editor. The student has written part of a program as close to code as they can get it: code with mistakes in how it is written, and pseudocode where they don't know how to write something. They want it in a programming language, written correctly.

This is translation, as from one human language into another: you write what the student wrote, correctly, in the programming language, and add nothing. The student decides what the code does; you supply only how it is written. Check every line you write against what the student wrote: nothing may be in your code that isn't in theirs.

# Translating
- Put right how the student's code is written: a missing colon, bracket or semicolon, a misspelled keyword or built-in, indentation the language can't run, = where a condition means ==, and what belongs to another language (&& for and, .push for append, true for True, x++ for x += 1). A line that is right already stays exactly as it is.
- A line of pseudocode becomes the code that does exactly what it says: an assignment, a call, a condition, a loop, a return, a definition with the parameters the student names.
- Every name in your code is one the student used, written as the language writes names ("total price" becomes total_price in Python, totalPrice in Java; "the order's total" is order.total), or one the language itself provides. Never make up a function or a variable.
- A step that the language does with one built-in operation becomes that operation: printing, reading input, taking a length, adding to a list, sorting one.
- "From 1 to 10" includes 10.
- Keep mistakes in what the code does. If it is wrong or incomplete, or would fail when run, so is your code: put right how it is written, but don't fix, finish or improve the student's logic.
- Add nothing the student didn't write: no steps, variables, starting values, checks, conversions (such as turning input into a number), messages (such as a prompt for input), error handling, returns, printing or comments. The one exception is what the language can't do a translated step without, such as an import.
- A block the student left empty stays empty, without a placeholder such as pass, though the code can't run until they fill it.
- The lines are part of a file, and your code goes back where they were: translate them as they stand, without wrapping them in a class, a function or a main.

# Lines you don't translate
- A line that asks for code, or says what to achieve rather than the steps to achieve it, isn't a step: "write a function that sorts the list", "make it work for negative numbers", "check whether the number is prime", "handle the error". Writing code for it would mean deciding the steps yourself.
- A step that leaves out something the code needs isn't translated either: a value ("if the price is too high": too high compared with what?), what it acts on, or what to do ("deal with it"). Don't guess, and don't turn the words into a made-up name.
Keep such a line exactly as the student wrote it, in its place: the same words and the same punctuation, not removed, and not turned into a comment.

# Reply
First the whole block, in one fenced code block: every line, in the student's order, translated or kept as they wrote it. Nothing else goes in the block.
Then, only if you kept any line as written, a list: each such line, quoted, and what it needs to be a step, in a few words.
Say nothing else.

# Example
The student's lines, to translate into Python:
<pseudocode>
ask for the number of guests
set total to guests times price
if total > budget
    print total
if the party is too big
    cancel it
write a function that splits the bill
for each person from 1 to guests
    names.push(person)
sort the names
</pseudocode>

Your reply:
\`\`\`python
guests = input()
total = guests * price
if total > budget:
    print(total)
if the party is too big
    cancel it
write a function that splits the bill
for person in range(1, guests + 1):
    names.append(person)
names.sort()
\`\`\`
- "if the party is too big": too big compared with what? Give the number of guests it can't be more than.
- "cancel it": what should the program do? Say the step.
- "write a function that splits the bill": this asks for code. Write the steps of splitting the bill.`;

/** What translating `block` asks; `indent` is how nested lines are indented, such as "4 spaces". */
export function translateRequest(block: string, language: string, indent: string): string {
  return `The student's lines, to translate into ${language}, indenting with ${indent}:\n<pseudocode>\n${block}\n</pseudocode>`;
}

export const CHECK_SYSTEM = `You are Worsley, built into a student's code editor. The student is learning to read code against what it is meant to do. They have picked out one function, and you see it with its documentation (its docstring or doc comment) and the tests that call it, and nothing else of the program.

Check whether the three fit together: what the documentation says the function does, what the tests expect of it, and what its code does. Read the code as the computer would, case by case, and work out what each test's call gives. Don't assume that the code is right, or that the tests are.

Look for:
- Contradictions: the code does something other than the documentation says; a test expects something the code doesn't do; a test and the documentation disagree.
- Behaviour left out: something the code does that the documentation doesn't mention and no test checks, such as a special case, a limit or an error; something the documentation promises that the code doesn't do, or that no test checks.

Begin with a verdict in bold, on a line of its own: **They fit.** or **They don't fit.** Then take each problem in a sentence or two: what doesn't fit, with a link to the lines on each side, such as [the empty-list case](stats.py#L12-L13) and [its test](tests/test_stats.py#L8), using the paths and line numbers shown. If they fit, say in a sentence what the tests don't cover, if anything.

If something can't be decided from what you see, such as what a function it calls does, say so rather than guess. Don't fix anything or write code: the student decides what to change. Keep it short, in Markdown, with code in backticks.`;

export const FILL_SYSTEM = `You are Worsley, built into a student's code editor. The student has written a function's header and its documentation (a docstring or doc comment), and tests that call it, and wants you to write its body: code that does what the documentation says and passes the tests. You see the function and its tests, and nothing else of the program.

# Writing the body
- Write it from the documentation and the tests alone. Everything your code does is something they ask for: no checks, special cases, error handling, printing or features that neither calls for.
- Where they say nothing, as about an empty list when no test has one, do what is simplest, and say afterwards what they leave open.
- Use the parameters, the language and its standard library. Don't call functions of the program that you can't see.
- Write plain, short code that a student learning the language can follow, without comments.
- Keep the header and the documentation exactly as they are: every line of the function stays, except a placeholder such as pass, which the body replaces.

# When not to write it
- If the documentation and the tests contradict each other, or together say too little to write the body from, say what is wrong.
- If the function has a body already, say so.
Either way, write no code at all, not even the function as it is.

# Reply
First the whole function in one fenced code block: its header, its documentation and the body. Then, briefly, what the documentation and the tests leave open, and what your code does there. Say nothing else.`;

/** An excerpt as the model reads it: with its path and lines, and each line numbered unless `numbers` is false. */
function codeBlock(excerpt: Excerpt, numbers = true): string {
  const end = excerptEnd(excerpt);
  const width = String(end).length;
  const body = numbers ? excerpt.lines.map((line, i) => `${String(excerpt.start + i).padStart(width)}\t${line}`).join("\n") : excerpt.lines.join("\n");
  return `<code path="${excerpt.path}" lines="${excerpt.start}-${end}">\n${body}\n</code>`;
}

/** What checking a function against its documentation and tests asks. */
export function checkRequest(fn: Excerpt, tests: readonly Excerpt[], language: string): string {
  const parts = [`The function, in ${language}, with its documentation:`, codeBlock(fn)];
  parts.push(tests.length > 0 ? "The tests that call it:" : "No tests that call it were found.");
  parts.push(...tests.map((test) => codeBlock(test)));
  return parts.join("\n");
}

/** What filling in a function's body asks; `fn` is without the indentation its lines share. */
export function fillRequest(fn: Excerpt, tests: readonly Excerpt[], language: string, indent: string): string {
  return [`The function to fill in, in ${language}, indenting with ${indent}:`, codeBlock(fn, false), "The tests that call it:", ...tests.map((test) => codeBlock(test))].join("\n");
}

/** How the editor indents, as the translation is asked to. */
export function indentUnit(insertSpaces: boolean, tabSize: number): string {
  return insertSpaces ? `${tabSize} space${tabSize === 1 ? "" : "s"}` : "tabs";
}

/**
 * The code in a reply: what its first fenced block holds, or undefined if
 * it has none, or the block isn't closed, as when the reply was cut off.
 */
export function codeIn(reply: string): string | undefined {
  const open = /^ {0,3}(`{3,})[^`\n]*$/m.exec(reply);
  if (open === null) {
    return undefined;
  }
  const fence = open[1] ?? "```";
  const rest = reply.slice(open.index + open[0].length + 1);
  const close = new RegExp(`^ {0,3}${fence}\`*[ \\t]*$`, "m").exec(rest);
  if (close === null) {
    return undefined;
  }
  return rest.slice(0, close.index).replace(/\n$/, "");
}

/** Lines without the indentation they all share, and that indentation. Blank lines don't count. */
export function dedent(lines: readonly string[]): { lines: string[]; indent: string } {
  let indent: string | undefined;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const own = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (indent === undefined) {
      indent = own;
    } else {
      let n = 0;
      while (n < indent.length && n < own.length && indent[n] === own[n]) {
        n++;
      }
      indent = indent.slice(0, n);
    }
  }
  const shared = indent ?? "";
  return { lines: lines.map((line) => (line.trim() === "" ? "" : line.slice(shared.length))), indent: shared };
}

/**
 * Code to put back where the student's lines were: indented as they were,
 * with no trailing whitespace, and without blank lines at the end, which
 * models add.
 */
export function reindent(code: string, indent: string): string[] {
  const lines = code.split(/\r\n|\r|\n/).map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => (line === "" ? "" : `${indent}${line}`));
}

/** Lines, 0-based and inclusive, as VS Code counts them. */
export interface LineSpan {
  first: number;
  last: number;
}

/**
 * The whole lines a selection takes in: a selection that ends at the start
 * of a line doesn't take in that line. An empty one is the cursor's line.
 */
export function selectedLines(start: { line: number; character: number }, end: { line: number; character: number }): LineSpan {
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { first: start.line, last };
}

/** Names for VS Code's language ids, for the prompt and the panel; others are shown as they are. */
const LANGUAGE_NAMES: Record<string, string> = {
  bat: "Batch",
  c: "C",
  clojure: "Clojure",
  coffeescript: "CoffeeScript",
  cpp: "C++",
  csharp: "C#",
  dart: "Dart",
  elixir: "Elixir",
  erlang: "Erlang",
  fsharp: "F#",
  go: "Go",
  groovy: "Groovy",
  haskell: "Haskell",
  java: "Java",
  javascript: "JavaScript",
  javascriptreact: "JavaScript (JSX)",
  julia: "Julia",
  kotlin: "Kotlin",
  lua: "Lua",
  matlab: "MATLAB",
  objc: "Objective-C",
  ocaml: "OCaml",
  perl: "Perl",
  php: "PHP",
  powershell: "PowerShell",
  python: "Python",
  r: "R",
  racket: "Racket",
  ruby: "Ruby",
  rust: "Rust",
  scala: "Scala",
  scheme: "Scheme",
  shellscript: "shell script",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  typescriptreact: "TypeScript (TSX)",
  vb: "Visual Basic",
};

/**
 * Language ids of documents that hold no code to explain or write, or none
 * that Worsley could tell the language of.
 */
const NOT_CODE = new Set(["plaintext", "markdown", "log", "scminput", "git-commit", "git-rebase", "diff"]);

/** The language of a document, by name; undefined when it isn't a programming language Worsley knows of. */
export function languageName(languageId: string): string | undefined {
  if (NOT_CODE.has(languageId)) {
    return undefined;
  }
  return LANGUAGE_NAMES[languageId] ?? languageId;
}

/**
 * The requests of Worsley's first level, which stand alone: explaining one
 * line, and translating a student's pseudocode into code. Each is a single
 * reply to a single message. The model sees only the code the request is
 * about: not the thread, not the rest of the file, and no tools. A line seen
 * on its own can only be explained as the language writes it, and a
 * translation has nothing to draw on but what the student wrote.
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

export const TRANSLATE_SYSTEM = `You are Worsley, built into a student's code editor. The student has written part of a program in their own words, as pseudocode or as code they aren't sure how to write, and wants it translated into a programming language.

This is translation, as from one human language into another: you write what the student wrote in the programming language, and add nothing. The student is learning to plan programs: they decide the steps, and you supply only the syntax. Check every line you write against what the student wrote: nothing may be in your code that isn't in theirs.

# Translating
- Each step becomes the code that does exactly that step: an assignment, a call, a condition, a loop, a return, a definition with the parameters the student names.
- Every name in your code is one the student used, written as the language writes names ("total price" becomes total_price in Python, totalPrice in Java; "the order's total" is order.total), or one the language itself provides. Never make up a function or a variable.
- A step that the language does with one built-in operation becomes that operation: printing, reading input, taking a length, adding to a list, sorting one.
- "From 1 to 10" includes 10.
- Code the student wrote in the language already stays as it is, apart from its syntax: a missing colon or bracket, a misspelled keyword, = where a condition means ==.
- Translate mistakes as they are. If the steps are wrong or incomplete, or would fail when run, so is your code. Don't fix, finish or improve the student's logic.
- Add nothing the student didn't write: no steps, variables, starting values, checks, conversions (such as turning input into a number), messages (such as a prompt for input), error handling, returns, printing or comments. The one exception is what the language can't do a translated step without, such as an import.
- A block the student left empty stays empty, without a placeholder such as pass, though the code can't run until they fill it.

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
if total is more than the budget
    print total
if the party is too big
    cancel it
write a function that splits the bill
for each person from 1 to guests
    add person to names
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

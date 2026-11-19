import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampLevel, featuresAt, LEVELS, notAtLevel, TOP_LEVEL } from "../../src/core/levels";
import {
  codeIn,
  dedent,
  explainRequest,
  indentUnit,
  languageName,
  reindent,
  selectedLines,
  TRANSLATE_SYSTEM,
  translateRequest,
} from "../../src/core/standalone";
import { addedDetails } from "../live/details";

describe("the levels", () => {
  it("start with explaining a line and translating, and end with everything", () => {
    assert.deepEqual([...featuresAt(1)].sort(), ["explain", "translate"]);
    assert.deepEqual([...featuresAt(TOP_LEVEL)].sort(), ["ask", "change", "explain", "review", "tour", "translate"]);
  });

  it("each offer what the one below offers, and more", () => {
    for (let level = 2; level <= TOP_LEVEL; level++) {
      const below = featuresAt(level - 1);
      const here = featuresAt(level);
      assert.ok([...below].every((f) => here.has(f)), `level ${level} keeps what level ${level - 1} offers`);
      assert.ok(here.size > below.size, `level ${level} adds something`);
    }
    assert.equal(new Set(LEVELS.flatMap((l) => l.adds)).size, LEVELS.flatMap((l) => l.adds).length, "no feature comes at two levels");
  });

  it("are whole numbers from 1 to the top, the top unless a setting is a number", () => {
    assert.equal(clampLevel(0), 1);
    assert.equal(clampLevel(1.7), 1);
    assert.equal(clampLevel(99), TOP_LEVEL);
    assert.equal(clampLevel(Number.NaN), TOP_LEVEL);
  });

  it("say what a level leaves out", () => {
    assert.equal(notAtLevel("tour", 1), "Worsley is at level 1, which doesn't include tours.");
  });
});

describe("explaining a line", () => {
  it("sends the line and its language, and nothing else", () => {
    assert.equal(explainRequest("total += price", "Python"), "The line, in Python:\n<line>\ntotal += price\n</line>");
  });

  it("says which part the student selected", () => {
    assert.match(explainRequest("for i in range(10):", "Python", "range(10)"), /<\/line>\nThe student is asking about this part of it:\n<part>\nrange\(10\)\n<\/part>$/);
  });

  it("asks for the language when the editor doesn't know it", () => {
    assert.match(explainRequest("x := 1", undefined), /^The line \(its language isn't known, so say which language it looks like\):/);
  });
});

describe("translating", () => {
  it("sends the student's lines, the language and how to indent", () => {
    assert.equal(
      translateRequest("set total to 0", "Python", "4 spaces"),
      "The student's lines, to translate into Python, indenting with 4 spaces:\n<pseudocode>\nset total to 0\n</pseudocode>",
    );
    assert.equal(indentUnit(true, 4), "4 spaces");
    assert.equal(indentUnit(true, 1), "1 space");
    assert.equal(indentUnit(false, 4), "tabs");
  });

  it("takes the code from the reply's first code block", () => {
    assert.equal(codeIn("```python\ntotal = 0\nfor p in prices:\n    total += p\n```\n- a note"), "total = 0\nfor p in prices:\n    total += p");
    assert.equal(codeIn("Here:\n```\nx = 1\n```\n```\ny = 2\n```"), "x = 1");
    assert.equal(codeIn("````\na = '```'\n````"), "a = '```'");
    assert.equal(codeIn("```python\n\n```"), "");
  });

  it("finds no code in a reply without a code block, or one cut off", () => {
    assert.equal(codeIn("Nothing here can be translated."), undefined);
    assert.equal(codeIn("```python\ntotal = 0\nfor p in"), undefined);
  });

  it("sends lines without the indentation they share, and puts it back", () => {
    const { lines, indent } = dedent(["    for x in xs", "", "        add x to total", "    print total"]);
    assert.equal(indent, "    ");
    assert.deepEqual(lines, ["for x in xs", "", "    add x to total", "print total"]);
    assert.deepEqual(reindent("for x in xs:\n\n    total += x  \nprint(total)\n\n", indent), ["    for x in xs:", "", "        total += x", "    print(total)"]);
  });

  it("keeps tabs and spaces apart when finding the shared indentation", () => {
    assert.equal(dedent(["\t  a", "\t b"]).indent, "\t ");
    assert.equal(dedent(["\ta", "  b"]).indent, "");
  });

  it("works on whole lines: a selection's, or the cursor's", () => {
    assert.deepEqual(selectedLines({ line: 4, character: 3 }, { line: 4, character: 3 }), { first: 4, last: 4 });
    assert.deepEqual(selectedLines({ line: 4, character: 2 }, { line: 7, character: 5 }), { first: 4, last: 7 });
    // Ending at the start of a line, as a triple-click or Shift+Down leaves it.
    assert.deepEqual(selectedLines({ line: 4, character: 0 }, { line: 5, character: 0 }), { first: 4, last: 4 });
  });

  it("names the file's language, and has none for files that hold no code", () => {
    assert.equal(languageName("python"), "Python");
    assert.equal(languageName("cpp"), "C++");
    assert.equal(languageName("pyret"), "pyret");
    assert.equal(languageName("plaintext"), undefined);
    assert.equal(languageName("markdown"), undefined);
  });

  it("shows the model an example that adds nothing to the student's lines", () => {
    const pseudocode = /<pseudocode>\n([\s\S]*?)\n<\/pseudocode>/.exec(TRANSLATE_SYSTEM)?.[1] ?? "";
    const reply = TRANSLATE_SYSTEM.slice(TRANSLATE_SYSTEM.indexOf("Your reply:"));
    const code = codeIn(reply) ?? "";
    assert.notEqual(code, "");
    assert.deepEqual(addedDetails(code, pseudocode, "python"), { names: [], numbers: [], strings: [], comments: [] });
    // Each line it doesn't translate is in the code as the student wrote it, and explained after.
    for (const kept of ["if the party is too big", "cancel it", "write a function that splits the bill"]) {
      assert.ok(pseudocode.split("\n").some((line) => line.trim() === kept));
      assert.ok(code.split("\n").some((line) => line.trim() === kept));
      assert.ok(reply.slice(reply.lastIndexOf("```")).includes(`"${kept}"`));
    }
  });
});

describe("the measure of a translation", () => {
  const added = (code: string, original: string, allow?: string[]): ReturnType<typeof addedDetails> => addedDetails(code, original, "python", allow);

  it("finds nothing added to a faithful translation", () => {
    const original = "set total price to 0\nfor each item in the cart\n    add the item's price to total price\nprint total price";
    const code = "total_price = 0\nfor item in cart:\n    total_price += item.price\nprint(total_price)";
    assert.deepEqual(added(code, original), { names: [], numbers: [], strings: [], comments: [] });
  });

  it("finds made-up names, starting values, messages and comments", () => {
    const original = "ask the user for their age\nfor each n in numbers\n    add n to total";
    const code = '# work out the total\ncount = 0\nage = int(input("Enter your age: "))\nfor n in numbers:\n    total += n\n    count += 1';
    assert.deepEqual(added(code, original), { names: ["count"], numbers: ["0", "1"], strings: ['"Enter your age: "'], comments: ["work out the total"] });
  });

  it("takes the language's own names, a range's end and a case's allowances", () => {
    assert.deepEqual(added("for i in range(1, len(items) + 1):\n    items.append(i)", "for i from 1 to length of items\n    add i to items").names, []);
    assert.deepEqual(added("for i in range(1, 11):\n    print(i)", "for i from 1 to 10\n    print i").numbers, []);
    assert.deepEqual(added("count += 1", "add one to count").numbers, []);
    assert.deepEqual(added("print(names[0])", "print the first name", ["0"]).numbers, []);
  });

  it("tells a method from a name of the student's", () => {
    // count is a method of lists, but not a name the student used.
    assert.deepEqual(added("n = names.count(x)", "set n to how many times x is in names").names, []);
    assert.deepEqual(added("count = len(names)", "set n to the length of names").names, ["count"]);
  });

  it("knows Java's names too", () => {
    const code = "int count = 0;\nfor (String word : words) {\n    if (word.length() > 5) {\n        count++;\n    }\n}\nSystem.out.println(count);";
    const original = "set count to 0\nfor each word in words\n    if word's length is more than 5\n        add 1 to count\nprint count";
    assert.deepEqual(addedDetails(code, original, "java"), { names: [], numbers: [], strings: [], comments: [] });
  });
});

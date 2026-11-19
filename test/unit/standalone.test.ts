import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  docStart,
  functionAt,
  functionName,
  hasBody,
  isTestLine,
  isTestName,
  isTestPath,
  keepsLines,
  mergeRanges,
  pythonFunctionAt,
  testAround,
  type Excerpt,
} from "../../src/core/functions";
import { featuresAt, LEVEL_CHOICES, LEVEL_N, levelOf, notAtLevel, NUMBERED, sectionsAt, type LevelName } from "../../src/core/levels";
import {
  CHECK_SYSTEM,
  checkRequest,
  codeIn,
  dedent,
  explainRequest,
  fillRequest,
  indentUnit,
  languageName,
  reindent,
  selectedLines,
  TRANSLATE_SYSTEM,
  translateRequest,
} from "../../src/core/standalone";
import type { OutlineEntry } from "../../src/core/tools";
import { addedDetails } from "../live/details";

describe("the levels", () => {
  it("are 1, explaining and translating; 2, checking and filling in functions; 3, reviewing a file's changes; and N, everything", () => {
    assert.deepEqual([...featuresAt(1)].sort(), ["explain", "translate"]);
    assert.deepEqual([...featuresAt(2)].sort(), ["check", "explain", "fill", "translate"]);
    assert.deepEqual([...featuresAt(3)].sort(), ["check", "explain", "fill", "reviewFile", "translate"]);
    assert.deepEqual([...featuresAt("N")].sort(), ["ask", "change", "check", "explain", "fill", "reviewAll", "reviewFile", "tour", "translate"]);
  });

  it("group what they offer by the level each thing comes at, for the panel's buttons", () => {
    assert.deepEqual(sectionsAt(2), [
      { level: 1, name: "Syntax", features: ["explain", "translate"] },
      { level: 2, name: "Specs", features: ["check", "fill"] },
    ]);
    assert.deepEqual(
      sectionsAt("N").map((s) => [s.level, s.name]),
      [
        [1, "Syntax"],
        [2, "Specs"],
        [3, "Changes"],
        ["N", "Everything"],
      ],
    );
    // The panel's choice of level offers every one, whatever the level is now.
    assert.deepEqual(LEVEL_CHOICES, [
      { level: 1, name: "Syntax" },
      { level: 2, name: "Specs" },
      { level: 3, name: "Changes" },
      { level: "N", name: "Everything" },
    ]);
  });

  it("each offer what the one below offers, and more", () => {
    const order: LevelName[] = [...NUMBERED.map((_, i) => i + 1), "N"];
    for (const [i, level] of order.entries()) {
      const below = i === 0 ? new Set() : featuresAt(order[i - 1] as LevelName);
      const here = featuresAt(level);
      assert.ok([...below].every((f) => here.has(f as never)), `level ${level} keeps what the level below offers`);
      assert.ok(here.size > below.size, `level ${level} adds something`);
    }
    const all = [...NUMBERED, LEVEL_N].flatMap((l) => l.adds);
    assert.equal(new Set(all).size, all.length, "no feature comes at two levels");
  });

  it("are named by number, the nearest that exists, or by N, the default", () => {
    assert.equal(levelOf(1), 1);
    assert.equal(levelOf(3), 3);
    assert.equal(levelOf(4), 3, "until there is a level 4");
    assert.equal(levelOf(0), 1);
    assert.equal(levelOf(1.7), 1);
    assert.equal(levelOf("2"), 2);
    assert.equal(levelOf("N"), "N");
    assert.equal(levelOf(undefined), "N");
    assert.equal(levelOf(Number.NaN), "N");
  });

  it("say what a level leaves out", () => {
    assert.equal(notAtLevel("tour", 2), "Worsley is at level 2, which doesn't include tours.");
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

describe("finding a function and its tests", () => {
  const outline: OutlineEntry[] = [
    {
      name: "Cart",
      kind: "class",
      start: 1,
      end: 10,
      children: [
        { name: "__init__", kind: "method", start: 2, end: 3, children: [] },
        { name: "total", kind: "method", start: 5, end: 10, children: [{ name: "price", kind: "function", start: 6, end: 7, children: [] }] },
      ],
    },
    { name: "TAX", kind: "constant", start: 12, end: 12, children: [] },
  ];

  it("finds the innermost function or method around a line, from the outline", () => {
    assert.equal(functionAt(outline, 6)?.name, "price");
    assert.equal(functionAt(outline, 9)?.name, "total");
    assert.equal(functionAt(outline, 4), undefined, "in the class, between its methods");
    assert.equal(functionAt(outline, 12), undefined);
  });

  it("takes a callback as part of the function it is in, but a test framework's as a test", () => {
    const js: OutlineEntry[] = [
      { name: "total", kind: "function", start: 3, end: 5, children: [{ name: "reduce() callback", kind: "function", start: 4, end: 4, children: [] }] },
      { name: 'test("total adds up") callback', kind: "function", start: 8, end: 10, children: [] },
      { name: 'it("totals") callback', kind: "function", start: 12, end: 14, children: [] },
    ];
    assert.equal(functionAt(js, 4)?.name, "total");
    assert.equal(functionAt(js, 9), undefined, "a test's callback is no function to check");
    const lines = Array.from({ length: 14 }, () => "x");
    assert.deepEqual(testAround(lines, js, "cart.test.js", 9), { path: "cart.test.js", start: 8, end: 10 });
    assert.deepEqual(testAround(lines, js, "cart.js", 13), { path: "cart.js", start: 12, end: 14 });
  });

  it("finds a Python function by its indentation, without an outline", () => {
    const lines = ["import math", "", "def area(r):", '    """The area."""', "", "    return math.pi * r ** 2", "", "x = area(2)"];
    assert.deepEqual(pythonFunctionAt(lines, 6), { start: 3, end: 6, name: "area" });
    assert.deepEqual(pythonFunctionAt(lines, 5), { start: 3, end: 6, name: "area" }, "a blank line inside it");
    assert.deepEqual(pythonFunctionAt(lines, 3), { start: 3, end: 6, name: "area" });
    assert.equal(pythonFunctionAt(lines, 8), undefined);
    assert.deepEqual(pythonFunctionAt(["class Cart:", "    def total(self):", "        return 1"], 3), { start: 2, end: 3, name: "total" });
  });

  it("takes in the comments and decorators above a function", () => {
    assert.equal(docStart(["x = 1", "", "/**", " * Adds.", " */", "function add(a, b) {", "}"], 6), 3);
    assert.equal(docStart(["@cache", "def f():", "    pass"], 2), 1);
    assert.equal(docStart(["x = 1", "def f():"], 2), 2);
  });

  it("knows a function's name from its header", () => {
    assert.equal(functionName("def average(numbers):"), "average");
    assert.equal(functionName("async def fetch(url):"), "fetch");
    assert.equal(functionName("function total(items) {"), "total");
    assert.equal(functionName("const total = (items) => {"), "total");
    assert.equal(functionName("(define (area r)"), "area");
    assert.equal(functionName("public static int total(int[] items) {"), "total");
  });

  it("knows tests by their files' names, their own names and their lines", () => {
    for (const path of ["tests/test_cart.py", "test_cart.py", "cart_test.py", "src/cart.test.js", "spec/cart.spec.ts", "CartTest.java", "tests.py"]) {
      assert.ok(isTestPath(path), path);
    }
    for (const path of ["cart.py", "src/contest.py", "latest.js", "attestation.py"]) {
      assert.ok(!isTestPath(path), path);
    }
    assert.ok(isTestName("test_total") && isTestName("testTotal") && isTestName("TotalTest") && isTestName('test("total adds up") callback'));
    assert.ok(!isTestName("latest") && !isTestName("contest"));
    assert.ok(isTestLine("assert total([1]) == 1") && isTestLine("(check-expect (area 1) 3.14)") && !isTestLine("print(total([1]))"));
  });

  it("finds the test around a call: the test function it is in, or a line of tests", () => {
    const lines = ["from cart import total", "", "def test_total():", "    assert total([1, 2]) == 3", "", "def helper():", "    return total([])", "", "assert total([]) == 0", "print(total([5]))"];
    assert.deepEqual(testAround(lines, undefined, "checks.py", 4), { path: "checks.py", start: 3, end: 4 });
    assert.equal(testAround(lines, undefined, "checks.py", 7), undefined, "a helper isn't a test");
    assert.deepEqual(testAround(lines, undefined, "checks.py", 9), { path: "checks.py", start: 9, end: 9 });
    assert.equal(testAround(lines, undefined, "checks.py", 10), undefined, "printing isn't testing");
    // In a file of tests, every call is part of one.
    assert.deepEqual(testAround(lines, undefined, "test_cart.py", 7), { path: "test_cart.py", start: 6, end: 7 });
    assert.deepEqual(testAround(lines, undefined, "test_cart.py", 1), { path: "test_cart.py", start: 1, end: 1 });
    // With an outline, its functions are the ones that count.
    assert.deepEqual(testAround(lines, [{ name: "test_total", kind: "function", start: 3, end: 4, children: [] }], "checks.py", 4), { path: "checks.py", start: 3, end: 4 });
  });

  it("joins ranges of tests that overlap or touch", () => {
    const ranges = [
      { path: "b.py", start: 1, end: 2 },
      { path: "a.py", start: 5, end: 9 },
      { path: "a.py", start: 1, end: 3 },
      { path: "a.py", start: 4, end: 4 },
      { path: "a.py", start: 7, end: 12 },
      { path: "a.py", start: 20, end: 21 },
    ];
    assert.deepEqual(mergeRanges(ranges), [
      { path: "a.py", start: 1, end: 12 },
      { path: "a.py", start: 20, end: 21 },
      { path: "b.py", start: 1, end: 2 },
    ]);
  });

  it("tells a function with a body from one waiting for one", () => {
    assert.equal(hasBody(["def f(x):", '    """Twice x."""', "    pass"]), false);
    assert.equal(hasBody(["def f(x):", '    """Twice x.', "", '    More."""', "    ..."]), false);
    assert.equal(hasBody(["@cache", "def f(", "    x,", "):", "    # TODO", "    raise NotImplementedError"]), false);
    assert.equal(hasBody(["def f(x):", '    """Twice x."""', "    return x * 2"]), true);
    assert.equal(hasBody(["/**", " * Twice x.", " */", "function f(x) {", "  // TODO", "}"]), false);
    assert.equal(hasBody(["function f(x) {", "  return x * 2;", "}"]), true);
    assert.equal(hasBody(["function f(x) { return x * 2; }"]), true);
  });

  it("knows whether a function written from another kept all its lines but a placeholder", () => {
    const before = ["def f(x):", '    """Twice x."""', "    pass"];
    assert.ok(keepsLines(before, ["def f(x):", '    """Twice x."""', "    return x * 2"]));
    assert.ok(!keepsLines(before, ["def f(x):", '    """Return twice x."""', "    return x * 2"]), "the docstring changed");
    assert.ok(!keepsLines(before, ["def f(n):", '    """Twice x."""', "    return n * 2"]), "the header changed");
    assert.ok(keepsLines(["function f(x) {", "  // TODO", "}"], ["function f(x) {", "  return x * 2;", "}"]));
  });
});

describe("checking and filling in a function", () => {
  const fn: Excerpt = { path: "stats.py", start: 3, lines: ["def average(numbers):", '    """The mean."""', "    pass"] };
  const tests: Excerpt[] = [{ path: "tests/test_stats.py", start: 9, lines: ["def test_average():", "    assert average([2, 4]) == 3"] }];

  it("shows a check the function and its tests, numbered, with their paths", () => {
    const request = checkRequest(fn, tests, "Python");
    assert.match(request, /^The function, in Python, with its documentation:\n<code path="stats.py" lines="3-5">\n3\tdef average\(numbers\):\n/);
    assert.match(request, /\nThe tests that call it:\n<code path="tests\/test_stats.py" lines="9-10">\n 9\tdef test_average\(\):\n10\t {4}assert/);
    assert.match(checkRequest(fn, [], "Python"), /\nNo tests that call it were found\.$/);
    assert.match(CHECK_SYSTEM, /\*\*They fit\.\*\* or \*\*They don't fit\.\*\*/);
  });

  it("shows a fill the function as it is, and its tests numbered", () => {
    const request = fillRequest(fn, tests, "Python", "4 spaces");
    assert.match(request, /^The function to fill in, in Python, indenting with 4 spaces:\n<code path="stats.py" lines="3-5">\ndef average\(numbers\):\n/);
    assert.match(request, /\n 9\tdef test_average\(\):/);
  });
});

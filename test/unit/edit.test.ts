import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replaceText, withoutLineNumbers } from "../../src/core/edit";

const file = ["def total(items):", "    return sum(items)", "", "def mean(items):", "    return total(items) / len(items)", ""].join("\n");

describe("replacing text in a file", () => {
  it("replaces the one place old_string occurs, and says which lines it now covers", () => {
    const result = replaceText(file, "    return sum(items)\n", "    # Add them up.\n    return sum(items)\n", false);
    assert.ok(result.ok);
    assert.equal(result.text, file.replace("    return sum(items)\n", "    # Add them up.\n    return sum(items)\n"));
    assert.deepEqual([result.firstLine, result.lastLine, result.count], [2, 3, 1]);
  });

  it("refuses an ambiguous old_string unless replace_all is set", () => {
    const ambiguous = replaceText(file, "(items)", "(xs)", false);
    assert.equal(ambiguous.ok, false);
    assert.match(!ambiguous.ok ? ambiguous.error : "", /occurs 5 times \(at lines 1, 2, 4, 5\)/);
    const all = replaceText(file, "(items)", "(xs)", true);
    assert.ok(all.ok);
    assert.equal(all.count, 5);
    assert.equal(all.text.includes("items)"), false);
    assert.deepEqual([all.firstLine, all.lastLine], [1, 5]);
  });

  it("points at a passage that matches apart from whitespace", () => {
    const result = replaceText(file, "def mean(items):\n  return total(items) / len(items)", "x", false);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /Lines 4-5 match it apart from whitespace/);
    const nothing = replaceText(file, "def median(", "x", false);
    assert.match(!nothing.ok ? nothing.error : "", /Read the file again/);
  });

  it("keeps a file's \\r\\n line endings", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    const result = replaceText(crlf, "def mean(items):\n    return", "def average(items):\n    return", false);
    assert.ok(result.ok);
    assert.equal(result.text, crlf.replace("def mean", "def average"));
  });

  it("refuses an empty or unchanged replacement", () => {
    assert.equal(replaceText(file, "", "x", false).ok, false);
    assert.equal(replaceText(file, "total", "total", false).ok, false);
  });

  it("reports a deletion where it happened", () => {
    const result = replaceText(file, "def mean(items):\n    return total(items) / len(items)\n", "", false);
    assert.ok(result.ok);
    assert.deepEqual([result.firstLine, result.lastLine], [4, 4]);
  });
});

describe("text copied with its line numbers", () => {
  it("loses them when every line has one", () => {
    assert.equal(withoutLineNumbers("  4\tdef mean(items):\n  5\t    return 1"), "def mean(items):\n    return 1");
    assert.equal(withoutLineNumbers("12\tx = 1\n\n13\ty = 2"), "x = 1\n\ny = 2");
  });

  it("is left alone otherwise", () => {
    assert.equal(withoutLineNumbers("def mean(items):\n  5\tx"), undefined);
    assert.equal(withoutLineNumbers(""), undefined);
  });
});

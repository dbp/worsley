import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldersOf, formatHref, labelRef, mayBePath, parseCodeRef, PATH_WITH_LINE, resolvePath } from "../../src/core/links";

describe("links to code", () => {
  it("reads the forms models write", () => {
    assert.deepEqual(parseCodeRef("src/cli.py#L10-L32"), { path: "src/cli.py", start: 10, end: 32 });
    assert.deepEqual(parseCodeRef("src/cli.py#L10"), { path: "src/cli.py", start: 10, end: 10 });
    assert.deepEqual(parseCodeRef("src/cli.py#L10-32"), { path: "src/cli.py", start: 10, end: 32 });
    assert.deepEqual(parseCodeRef("src/cli.py:10-32"), { path: "src/cli.py", start: 10, end: 32 });
    assert.deepEqual(parseCodeRef("cli.py:7"), { path: "cli.py", start: 7, end: 7 });
    assert.deepEqual(parseCodeRef("cli.py:7:12"), { path: "cli.py", start: 7, end: 7 });
    assert.deepEqual(parseCodeRef("src/cli.py#L32-L10"), { path: "src/cli.py", start: 10, end: 32 });
    assert.deepEqual(parseCodeRef("setup.cfg"), { path: "setup.cfg" });
    assert.deepEqual(parseCodeRef("my%20file.py#L3"), { path: "my file.py", start: 3, end: 3 });
    assert.deepEqual(parseCodeRef("file:///home/u/p/a.py#L2"), { path: "/home/u/p/a.py", start: 2, end: 2 });
  });

  it("leaves web links and anchors alone", () => {
    assert.equal(parseCodeRef("https://example.com/a.py#L3"), undefined);
    assert.equal(parseCodeRef("mailto:a@b.c"), undefined);
    assert.equal(parseCodeRef("#section"), undefined);
    assert.equal(parseCodeRef("javascript:alert(1)"), undefined);
  });

  it("writes and labels references", () => {
    assert.equal(formatHref({ path: "a.py", start: 3, end: 9 }), "a.py#L3-L9");
    assert.equal(formatHref({ path: "a.py", start: 3, end: 3 }), "a.py#L3");
    assert.equal(formatHref({ path: "a.py" }), "a.py");
    assert.equal(labelRef({ path: "a.py", start: 3, end: 9 }), "a.py:3–9");
  });

  it("finds paths with lines in prose", () => {
    const text = "See src/a.py:12 and b.ts:3-9, but not http://x.io/c.py:5 or a.py:12x.";
    const found = [...text.matchAll(PATH_WITH_LINE)].map((m) => m[0]);
    assert.deepEqual(found, ["src/a.py:12", "b.ts:3-9"]);
  });

  it("knows which code spans may name a file or folder", () => {
    for (const text of ["src/a.py", "a.py:12", "src/a.py#L3-L9", "./setup.cfg", "Makefile.am", "src/core/", "tests/", "./src", "src/core"]) {
      assert.equal(mayBePath(text), true, text);
    }
    for (const text of ["total(items)", "x = 1", "a b.py", "README", "--flag", "/usr/bin", "src//x", "a b/c"]) {
      assert.equal(mayBePath(text), false, text);
    }
  });

  it("finds the folders that hold the files", () => {
    assert.deepEqual([...foldersOf(["README.md", "src/core/a.ts", "src/core/b.ts", "src/editor/c.ts", "test/unit/d.ts"])].sort(), [
      "src",
      "src/core",
      "src/editor",
      "test",
      "test/unit",
    ]);
  });

  it("takes the one folder a shortened path ends, as for files", () => {
    const folders = foldersOf(["src/core/a.ts", "src/editor/b.ts", "test/unit/c.ts", "test/core/d.ts"]);
    assert.equal(resolvePath("src/editor", "src/editor", folders), "src/editor");
    assert.equal(resolvePath("editor", "editor", folders), "src/editor");
    assert.equal(resolvePath("unit", "unit", folders), "test/unit");
    assert.equal(resolvePath("core", "core", folders), undefined, "two folders end in core");
  });

  it("takes the one file a shortened path ends", () => {
    const files = new Set(["src/app/parser.py", "src/app/cli.py", "tests/cli.py"]);
    assert.equal(resolvePath("src/app/parser.py", "src/app/parser.py", files), "src/app/parser.py");
    assert.equal(resolvePath("parser.py", "parser.py", files), "src/app/parser.py");
    assert.equal(resolvePath("app/parser.py", "app/parser.py", files), "src/app/parser.py");
    assert.equal(resolvePath("cli.py", "cli.py", files), undefined, "two files end in cli.py");
    assert.equal(resolvePath("arser.py", "arser.py", files), undefined, "only whole names count");
  });
});

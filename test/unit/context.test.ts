import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextChips, formatContext, type EditorFile } from "../../src/core/context";

const lines = (n: number, prefix = "line"): string => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

function file(fields: Partial<EditorFile> & { path: string }): EditorFile {
  return { text: lines(10), active: false, dirty: false, visible: [{ start: 1, end: 10 }], selections: [], ...fields };
}

describe("the editor context", () => {
  it("sends selections first, a short file whole, and a long one around what is on screen", () => {
    const active = file({
      path: "src/big.py",
      text: lines(1000),
      active: true,
      visible: [{ start: 500, end: 520 }],
      selections: [{ start: 505, end: 506, text: "line 505\nline 506" }],
    });
    const small = file({ path: "src/small.py", dirty: true });
    const text = formatContext([small, active], { maxFileLines: 100, excluded: new Set(), sent: new Map() }) ?? "";
    assert.match(text, /^<editor_context>\n/);
    const selection = text.indexOf('<selection path="src/big.py" lines="505-506">\n505\tline 505\n506\tline 506\n</selection>');
    const big = text.indexOf('<file path="src/big.py" visible="500-520" total_lines="1000" active="true" shown="460-560">\n460\tline 460\n');
    const short = text.indexOf('<file path="src/small.py" visible="1-10" total_lines="10" unsaved="true" shown="1-10">\n 1\tline 1\n');
    assert.ok(selection >= 0 && big > selection && short > big, text);
    assert.equal(text.includes("459\t"), false);
    assert.equal(text.includes("561\t"), false);
  });

  it("gives the exact text of a selection within one line", () => {
    const f = file({ path: "a.py", text: "total = sum(items)\n", selections: [{ start: 1, end: 1, text: "sum" }] });
    const text = formatContext([f], { maxFileLines: 100, excluded: new Set(), sent: new Map() }) ?? "";
    assert.match(text, /1\ttotal = sum\(items\)\nSelected text: "sum"\n<\/selection>/);
  });

  it("doesn't repeat a file the thread has already been sent", () => {
    const sent = new Map<string, string>();
    const f = file({ path: "a.py" });
    formatContext([f], { maxFileLines: 100, excluded: new Set(), sent });
    const again = formatContext([f], { maxFileLines: 100, excluded: new Set(), sent }) ?? "";
    assert.match(again, /<file path="a.py" [^>]*>\(unchanged since an earlier message, so not repeated\)<\/file>/);
    const changed = formatContext([{ ...f, text: lines(10, "edited") }], { maxFileLines: 100, excluded: new Set(), sent }) ?? "";
    assert.match(changed, / 1\tedited 1/);
  });

  it("leaves out what the user clicked away, and says nothing when nothing is left", () => {
    const f = file({ path: "a.py", selections: [{ start: 2, end: 3, text: "line 2\nline 3" }] });
    const chips = contextChips([f], { maxFileLines: 100, excluded: new Set(["file:a.py"]) });
    assert.deepEqual(
      chips.map((c) => [c.key, c.label, c.excluded]),
      [
        ["sel:a.py:2-3", "a.py:2-3", false],
        ["file:a.py", "a.py", true],
      ],
    );
    const onlySelection = formatContext([f], { maxFileLines: 100, excluded: new Set(["file:a.py"]), sent: new Map() }) ?? "";
    assert.match(onlySelection, /<selection/);
    assert.equal(onlySelection.includes("<file"), false);
    assert.equal(formatContext([f], { maxFileLines: 100, excluded: new Set(["file:a.py", "sel:a.py:2-3"]), sent: new Map() }), undefined);
  });

  it("stops sending whole files once the budget is spent", () => {
    const files = ["a", "b", "c"].map((name) => file({ path: `${name}.py`, text: lines(80), visible: [{ start: 1, end: 20 }] }));
    const text = formatContext(files, { maxFileLines: 100, excluded: new Set(), sent: new Map() }) ?? "";
    assert.match(text, /path="a.py"[^>]*shown="1-80"/);
    assert.match(text, /path="b.py"[^>]*shown="1-80"/);
    assert.match(text, /path="c.py"[^>]*shown="1-60"/);
  });
});

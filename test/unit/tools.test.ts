import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { TOOLS, type Args, type ToolContext, type ToolOutcome } from "../../src/core/tools";
import { DiskWorkspace, RecordingUi, tempFolder, toolContext } from "./helpers";

const project = {
  "src/shop/cart.py": [
    "from dataclasses import dataclass",
    "",
    "",
    "@dataclass",
    "class Item:",
    "    name: str",
    "    price: float",
    "",
    "",
    "def total(items):",
    "    return sum(i.price for i in items)",
    "",
  ].join("\n"),
  "tests/test_cart.py": "from src.shop.cart import Item, total\n\n\ndef test_total():\n    assert total([Item('a', 1.5)]) == 1.5\n",
  "README.md": "# Shop\n",
};

function tool(name: string): (args: Args, ctx: ToolContext) => Promise<ToolOutcome> {
  const found = TOOLS.find((t) => t.spec.function.name === name);
  assert.ok(found, name);
  return (args, ctx) => found.run(args, ctx);
}

describe("the tools", () => {
  it("are described so a model can call them", () => {
    const names = TOOLS.map((t) => t.spec.function.name);
    assert.deepEqual(names, ["list_files", "search", "read_file", "outline", "find_references", "find_definition", "show_locations", "present_tour", "edit_file", "write_file", "run_command"]);
    for (const t of TOOLS) {
      const parameters = t.spec.function.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
      assert.equal(parameters.type, "object");
      for (const key of parameters.required) {
        assert.ok(key in parameters.properties, `${t.spec.function.name}.${key}`);
      }
      assert.ok(t.spec.function.description.length > 40);
    }
  });

  it("list files, filtered by a glob", async () => {
    const ctx = toolContext(new DiskWorkspace(tempFolder(project)));
    const all = await tool("list_files")({}, ctx);
    assert.equal(all.content, "README.md\nsrc/shop/cart.py\ntests/test_cart.py");
    const py = await tool("list_files")({ glob: "*.py" }, ctx);
    assert.equal(py.content, "src/shop/cart.py\ntests/test_cart.py");
    assert.equal(py.display.summary, "Listed 2 files matching *.py");
    assert.equal((await tool("list_files")({ glob: "*.rs" }, ctx)).content, "No files match *.rs.");
  });

  it("read files with line numbers, a range at a time, finding a file from the end of its path", async () => {
    const ctx = toolContext(new DiskWorkspace(tempFolder(project)));
    const whole = await tool("read_file")({ path: "cart.py" }, ctx);
    assert.match(whole.content, /^src\/shop\/cart.py, lines 1-11 of 11:\n 1\tfrom dataclasses import dataclass\n/);
    assert.equal(whole.display.href, "src/shop/cart.py#L1-L11");
    assert.ok(ctx.seen.has("src/shop/cart.py"));
    const part = await tool("read_file")({ path: "src/shop/cart.py", start_line: "10", end_line: 11 }, ctx);
    assert.equal(part.content, "src/shop/cart.py, lines 10-11 of 11:\n10\tdef total(items):\n11\t    return sum(i.price for i in items)");
    await assert.rejects(tool("read_file")({ path: "src/shop" }, ctx), /is a folder/);
    await assert.rejects(tool("read_file")({ path: "nope.py" }, ctx), /There is no file nope.py/);
    await assert.rejects(tool("read_file")({ path: "../outside.py" }, ctx), /isn't a path inside the workspace/);
  });

  it("search, and say how much they found", async () => {
    const ctx = toolContext(new DiskWorkspace(tempFolder(project)));
    const found = await tool("search")({ pattern: "total" }, ctx);
    assert.equal(found.content, "src/shop/cart.py:10: def total(items):\ntests/test_cart.py:1: from src.shop.cart import Item, total\ntests/test_cart.py:4: def test_total():\ntests/test_cart.py:5: assert total([Item('a', 1.5)]) == 1.5");
    assert.equal(found.display.summary, "Searched for “total”: 4 matches in 2 files");
    await assert.rejects(tool("search")({ pattern: "total(" }, ctx), /escape it or set literal/);
  });

  it("edit a file in place, showing the lines around the change", async () => {
    const root = tempFolder(project);
    const ctx = toolContext(new DiskWorkspace(root));
    const outcome = await tool("edit_file")(
      { path: "src/shop/cart.py", old_string: "def total(items):\n    return sum(i.price for i in items)", new_string: "def total(items, discount=0.0):\n    return sum(i.price for i in items) * (1 - discount)" },
      ctx,
    );
    assert.match(outcome.content, /^Edited src\/shop\/cart.py. Lines 8-11 now read:\n 8\t\n 9\t\n10\tdef total\(items, discount=0.0\):\n/);
    assert.deepEqual(outcome.display.changed, { path: "src/shop/cart.py", created: false });
    assert.equal(outcome.display.href, "src/shop/cart.py#L10-L11");
    assert.match(fs.readFileSync(path.join(root, "src/shop/cart.py"), "utf8"), /\* \(1 - discount\)\n$/);
  });

  it("edit text that was copied with its line numbers", async () => {
    const root = tempFolder(project);
    const ctx = toolContext(new DiskWorkspace(root));
    await tool("edit_file")({ path: "src/shop/cart.py", old_string: "6\t    name: str\n7\t    price: float", new_string: "6\t    name: str\n7\t    price: float\n8\t    quantity: int = 1" }, ctx);
    assert.match(fs.readFileSync(path.join(root, "src/shop/cart.py"), "utf8"), /    price: float\n    quantity: int = 1\n/);
  });

  it("create files, but replace one only after reading it", async () => {
    const root = tempFolder(project);
    const ctx = toolContext(new DiskWorkspace(root));
    const created = await tool("write_file")({ path: "tests/unit/test_new.py", content: "def test_x():\n    pass\n" }, ctx);
    assert.deepEqual(created.display.changed, { path: "tests/unit/test_new.py", created: true });
    assert.equal(fs.readFileSync(path.join(root, "tests/unit/test_new.py"), "utf8"), "def test_x():\n    pass\n");
    await assert.rejects(tool("write_file")({ path: "README.md", content: "gone" }, ctx), /Read it first/);
    await tool("read_file")({ path: "README.md" }, ctx);
    const replaced = await tool("write_file")({ path: "README.md", content: "# Shop\n\nNew.\n" }, ctx);
    assert.equal(replaced.display.summary, "Rewrote README.md");
  });

  it("run a preapproved command at once, and ask about any other", async () => {
    const root = tempFolder(project);
    const ui = new RecordingUi("deny");
    const ctx = toolContext(new DiskWorkspace(root), { ui, preapproved: (c) => c === "echo tests ok" });
    const ran = await tool("run_command")({ command: "echo tests ok" }, ctx);
    assert.match(ran.content, /^Exit code 0 after \d+\.\ds\.\n<output>\ntests ok\n<\/output>$/);
    assert.equal(ran.display.failed, false);
    assert.deepEqual(ui.asked, []);

    const denied = await tool("run_command")({ command: "rm -rf src" }, ctx);
    assert.match(denied.content, /declined/);
    assert.deepEqual(ui.asked, ["rm -rf src"]);
    assert.ok(fs.existsSync(path.join(root, "src")));

    // What "always" covers is the panel's to remember; the command runs either way.
    const always = toolContext(new DiskWorkspace(root), { ui: new RecordingUi("always") });
    const failed = await tool("run_command")({ command: "exit 2" }, always);
    assert.match(failed.content, /^Exit code 2/);
    assert.equal(failed.display.failed, true);
  });

  it("show locations that exist, and say which didn't", async () => {
    const ui = new RecordingUi();
    const ctx = toolContext(new DiskWorkspace(tempFolder(project)), { ui });
    const outcome = await tool("show_locations")(
      {
        title: "Where totals are computed",
        locations: [
          { path: "src/shop/cart.py", start_line: 10, end_line: 99, note: "the sum" },
          { path: "tests/test_cart.py", start_line: 4, end_line: 5, note: "its test" },
          { path: "src/missing.py", start_line: 1, end_line: 2, note: "?" },
          { path: "README.md", start_line: 40, end_line: 41, note: "?" },
        ],
      },
      ctx,
    );
    assert.deepEqual(ui.locations, [
      {
        title: "Where totals are computed",
        places: [
          { path: "src/shop/cart.py", start: 10, end: 11, note: "the sum" },
          { path: "tests/test_cart.py", start: 4, end: 5, note: "its test" },
        ],
      },
    ]);
    assert.match(outcome.content, /^Shown to the user: 2 locations. These were left out:\nlocations\[2\]: There is no file src\/missing.py.*\nlocations\[3\]: README.md has 1 line, so start_line 40 isn't in it.$/);
    assert.equal(outcome.display.hidden, true);
  });

  it("present a tour only when every step is right", async () => {
    const ui = new RecordingUi();
    const ctx = toolContext(new DiskWorkspace(tempFolder(project)), { ui, mode: "ask" });
    const step = (p: string, start: number, end: number, title: string): Args => ({ path: p, start_line: start, end_line: end, title, summary: `About ${title}.` });
    await assert.rejects(
      tool("present_tour")({ title: "The shop", steps: [step("src/shop/cart.py", 4, 7, "Items"), step("src/shop/basket.py", 1, 2, "Baskets")] }, ctx),
      /The tour wasn't shown, because some steps are wrong:\nsteps\[1\]: There is no file src\/shop\/basket.py/,
    );
    assert.deepEqual(ui.tours, []);
    const outcome = await tool("present_tour")({ title: "The shop", steps: [step("src/shop/cart.py", 4, 7, "Items"), step("tests/test_cart.py", 4, 5, "Testing totals")] }, ctx);
    assert.deepEqual(ui.tours, [
      {
        title: "The shop",
        steps: [
          { path: "src/shop/cart.py", start: 4, end: 7, title: "Items", summary: "About Items." },
          { path: "tests/test_cart.py", start: 4, end: 5, title: "Testing totals", summary: "About Testing totals." },
        ],
      },
    ]);
    assert.match(outcome.content, /don't explain the steps now/);
  });

  it("say when there is no language support", async () => {
    const ctx = toolContext(new DiskWorkspace(tempFolder(project)));
    const refs = await tool("find_references")({ path: "src/shop/cart.py", line: 10, symbol: "total" }, ctx);
    assert.match(refs.content, /no language support .* search for "total" instead/);
    await assert.rejects(tool("find_references")({ path: "src/shop/cart.py", line: 1, symbol: "total" }, ctx), /doesn't appear on line 1/);
    const outline = await tool("outline")({ path: "src/shop/cart.py" }, ctx);
    assert.match(outline.content, /^No outline for src\/shop\/cart.py/);
  });

  it("use language support when there is some", async () => {
    const root = tempFolder(project);
    const workspace = new DiskWorkspace(root);
    let asked: [string, number, number] | undefined;
    Object.assign(workspace, {
      references: async (p: string, line: number, character: number) => {
        asked = [p, line, character];
        return [
          { path: "tests/test_cart.py", start: 5, end: 5 },
          { path: "src/shop/cart.py", start: 10, end: 10 },
          { path: "/usr/lib/python3/typing.py", start: 3, end: 3 },
        ];
      },
    });
    const refs = await tool("find_references")({ path: "src/shop/cart.py", line: 11, symbol: "shop.cart.total" }, toolContext(workspace));
    assert.deepEqual(asked, ["src/shop/cart.py", 10, 4], "the symbol was found on the line before");
    assert.equal(refs.content, "3 references to shop.cart.total:\n/usr/lib/python3/typing.py:3 (outside the workspace)\nsrc/shop/cart.py:10: def total(items):\ntests/test_cart.py:5: assert total([Item('a', 1.5)]) == 1.5");
  });
});

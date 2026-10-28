import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listFiles, numberLines, splitLines, summarizeFiles } from "../../src/core/files";
import { uncommittedFiles } from "../../src/core/git";
import { compileGlob } from "../../src/core/glob";
import { workspacePath } from "../../src/core/paths";
import { search } from "../../src/core/search";
import { installedRipgrep, tempFolder } from "./helpers";

function gitInit(root: string): void {
  const run = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  run("init", "-q");
  run("-c", "user.email=t@example.com", "-c", "user.name=Test", "add", ".");
  run("-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "start");
}

const project = {
  ".gitignore": "build/\n*.log\n",
  "src/app.py": "def main():\n    print('Hello')\n\n\ndef helper():\n    return main()\n",
  "src/util/strings.py": "def shout(s):\n    return s.upper()\n",
  "tests/test_app.py": "from src.app import main\n\ndef test_main():\n    main()\n",
  "README.md": "# Hello\nRun main.\n",
  "build/out.txt": "main main main\n",
  "debug.log": "main\n",
};

describe("the workspace's files", () => {
  it("are what git knows of or would add, in a repository", async () => {
    const root = tempFolder(project);
    gitInit(root);
    fs.writeFileSync(path.join(root, "new.py"), "x = 1\n");
    fs.rmSync(path.join(root, "README.md"));
    assert.deepEqual(await listFiles(root), [".gitignore", "new.py", "src/app.py", "src/util/strings.py", "tests/test_app.py"]);
    assert.deepEqual(await listFiles(path.join(root, "src")), ["app.py", "util/strings.py"]);
  });

  it("are everything but the usual build folders, elsewhere", async () => {
    const root = tempFolder({ ...project, "node_modules/x/index.js": "", ".venv/lib.py": "" });
    assert.deepEqual(await listFiles(root), [".gitignore", "README.md", "debug.log", "src/app.py", "src/util/strings.py", "tests/test_app.py"]);
  });

  it("are summarized by folder when there are too many to list", () => {
    const paths = [...Array.from({ length: 30 }, (_, i) => `src/a/f${i}.py`), ...Array.from({ length: 5 }, (_, i) => `docs/d${i}.md`), "setup.py"];
    assert.equal(summarizeFiles(paths, 100), paths.join("\n"));
    const summary = summarizeFiles(paths, 10);
    assert.equal(summary, "src/a/ (30 files)\ndocs/d0.md\ndocs/d1.md\ndocs/d2.md\ndocs/d3.md\ndocs/d4.md\nsetup.py\n(36 files in all; folders show how many files are inside.)");
    assert.match(summarizeFiles(paths, 3), /^src\/ \(30 files\)\ndocs\/ \(5 files\)\nsetup.py\n/);
  });

  it("are numbered and split as the model reads them", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
    assert.deepEqual(splitLines(""), [""]);
    assert.equal(numberLines(["a", "b", "c"], 2, 3), "2\tb\n3\tc");
    assert.equal(numberLines(Array.from({ length: 12 }, (_, i) => `${i}`), 9, 10), " 9\t8\n10\t9");
    assert.match(numberLines(["x".repeat(600)], 1, 1), /^1\tx{500}… \[100 more characters\]$/);
  });
});

describe("paths from the model", () => {
  it("stay inside the workspace", () => {
    assert.equal(workspacePath("/w", "src/a.py"), "src/a.py");
    assert.equal(workspacePath("/w", "./src//a.py"), "src/a.py");
    assert.equal(workspacePath("/w", "/w/src/a.py"), "src/a.py");
    assert.equal(workspacePath("/w", "../etc/passwd"), undefined);
    assert.equal(workspacePath("/w", "/etc/passwd"), undefined);
    assert.equal(workspacePath("/w", "src/../../x"), undefined);
    assert.equal(workspacePath("/w", "..foo/a.py"), "..foo/a.py");
    assert.equal(workspacePath("/w", "."), undefined);
    assert.equal(workspacePath("/w", " "), undefined);
  });
});

describe("globs", () => {
  it("match names anywhere without a slash, and paths from the top with one", () => {
    const py = compileGlob("*.py");
    assert.equal(py.test("a.py"), true);
    assert.equal(py.test("src/deep/a.py"), true);
    assert.equal(py.test("a.pyc"), false);
    const src = compileGlob("src/**/*.{py,pyi}");
    assert.equal(src.test("src/a.py"), true);
    assert.equal(src.test("src/x/y/a.pyi"), true);
    assert.equal(src.test("lib/src/a.py"), false);
    assert.equal(compileGlob("tests/**").test("tests/unit/a.py"), true);
    assert.equal(compileGlob("./src/*.py").test("src/a.py"), true);
  });
});

describe("searching", () => {
  const engines: [string, string | undefined][] = [["in process", undefined]];
  const rg = installedRipgrep();
  if (rg !== undefined) {
    engines.push(["with ripgrep", rg]);
  }
  for (const [name, ripgrep] of engines) {
    it(`finds matching lines ${name}`, async () => {
      const root = tempFolder(project);
      gitInit(root);
      const files = (): Promise<string[]> => listFiles(root);
      const signal = new AbortController().signal;
      const find = async (pattern: string, extra: { literal?: boolean; glob?: string; limit?: number } = {}): Promise<string[]> => {
        const result = await search(root, { pattern, literal: extra.literal ?? false, glob: extra.glob, limit: extra.limit ?? 50 }, files, ripgrep, signal);
        return result.matches.map((m) => `${m.path}:${m.line}:${m.text}`);
      };
      assert.deepEqual(await find("def \\w+\\("), ["src/app.py:1:def main():", "src/app.py:5:def helper():", "src/util/strings.py:1:def shout(s):", "tests/test_app.py:3:def test_main():"]);
      assert.deepEqual(await find("main()", { literal: true, glob: "tests/**" }), ["tests/test_app.py:3:def test_main():", "tests/test_app.py:4:    main()"]);
      assert.deepEqual(await find("HELLO"), [], "a capital letter makes it case-sensitive");
      assert.deepEqual(await find("hello", { glob: "*.py" }), ["src/app.py:2:    print('Hello')"]);
      assert.equal((await find("main")).some((m) => m.startsWith("build/") || m.startsWith("debug.log")), false, "ignored files aren't searched");
      const limited = await search(root, { pattern: "main", literal: true, limit: 2 }, files, ripgrep, signal);
      assert.equal(limited.matches.length, 2);
      assert.equal(limited.truncated, true);
    });
  }
});

describe("uncommitted files", () => {
  it("are relative to the workspace folder, even inside a bigger repository", async () => {
    const root = tempFolder(project);
    gitInit(root);
    fs.appendFileSync(path.join(root, "src/app.py"), "# changed\n");
    fs.writeFileSync(path.join(root, "src/util/new.py"), "");
    fs.writeFileSync(path.join(root, "README.md"), "changed\n");
    assert.deepEqual((await uncommittedFiles(root))?.sort(), ["README.md", "src/app.py", "src/util/new.py"]);
    assert.deepEqual((await uncommittedFiles(path.join(root, "src")))?.sort(), ["app.py", "util/new.py"]);
    assert.equal(await uncommittedFiles(tempFolder({ "a.txt": "" })), undefined);
  });
});

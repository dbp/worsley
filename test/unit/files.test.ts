import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listFiles, numberLines, splitLines, summarizeFiles } from "../../src/core/files";
import { uncommittedChanges, uncommittedDiff } from "../../src/core/git";
import { compileGlob } from "../../src/core/glob";
import { workspacePath } from "../../src/core/paths";
import { search } from "../../src/core/search";
import type { FileChange } from "../../src/protocol";
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

describe("uncommitted changes", () => {
  const sorted = (changes: FileChange[] | undefined): FileChange[] | undefined => changes?.sort((a, b) => a.path.localeCompare(b.path));

  it("count each file's lines, relative to the workspace folder, even inside a bigger repository", async () => {
    const root = tempFolder(project);
    fs.writeFileSync(path.join(root, "src/icon.bin"), Buffer.from([0, 1, 2]));
    gitInit(root);
    fs.appendFileSync(path.join(root, "src/app.py"), "# changed\n");
    fs.writeFileSync(path.join(root, "README.md"), "changed\n");
    fs.rmSync(path.join(root, "src/util/strings.py"));
    fs.writeFileSync(path.join(root, "src/icon.bin"), Buffer.from([0, 1, 3]));
    fs.writeFileSync(path.join(root, "src/util/new.py"), "a = 1\nb = 2");
    fs.writeFileSync(path.join(root, "src/logo.png"), Buffer.from([0x89, 0x50, 0, 1]));
    fs.writeFileSync(path.join(root, "debug2.log"), "ignored\n");
    assert.deepEqual(sorted(await uncommittedChanges(root)), [
      { path: "README.md", untracked: false, lines: { added: 1, removed: 2 } },
      { path: "src/app.py", untracked: false, lines: { added: 1, removed: 0 } },
      { path: "src/icon.bin", untracked: false, lines: undefined },
      { path: "src/logo.png", untracked: true, lines: undefined },
      { path: "src/util/new.py", untracked: true, lines: { added: 2, removed: 0 } },
      { path: "src/util/strings.py", untracked: false, lines: { added: 0, removed: 2 } },
    ]);
    assert.deepEqual(
      sorted(await uncommittedChanges(path.join(root, "src")))?.map((change) => change.path),
      ["app.py", "icon.bin", "logo.png", "util/new.py", "util/strings.py"],
    );
    assert.equal(await uncommittedChanges(tempFolder({ "a.txt": "" })), undefined);
  });

  it("count both what is staged and what isn't before the first commit", async () => {
    const root = tempFolder({ "f.txt": "x\n" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "f.txt"], { cwd: root });
    fs.writeFileSync(path.join(root, "f.txt"), "x\ny\n");
    assert.deepEqual(await uncommittedChanges(root), [{ path: "f.txt", untracked: false, lines: { added: 2, removed: 0 } }]);
  });
});

describe("the uncommitted diff", () => {
  it("shows changes since the last commit and new files whole, for the workspace or one file", async () => {
    const root = tempFolder(project);
    gitInit(root);
    fs.appendFileSync(path.join(root, "src/app.py"), "# changed\n");
    fs.writeFileSync(path.join(root, "src/util/new.py"), "a = 1\n");
    fs.writeFileSync(path.join(root, "debug2.log"), "ignored\n");
    const all = (await uncommittedDiff(root)) ?? "";
    assert.match(all, /^diff --git a\/src\/app\.py b\/src\/app\.py\n[\s\S]*\n\+# changed\n/);
    assert.match(all, /diff --git a\/src\/util\/new\.py b\/src\/util\/new\.py\nnew file mode[\s\S]*\n\+a = 1\n/);
    assert.doesNotMatch(all, /debug2\.log/, "ignored files stay out");
    const one = (await uncommittedDiff(root, "src/util/new.py")) ?? "";
    assert.match(one, /\+a = 1/);
    assert.doesNotMatch(one, /app\.py/);
    assert.match((await uncommittedDiff(path.join(root, "src"), "app.py")) ?? "", /a\/app\.py b\/app\.py/, "paths are relative to the folder");
    assert.equal(await uncommittedDiff(root, "README.md"), "");
    assert.equal(await uncommittedDiff(tempFolder({ "a.txt": "" })), undefined);
    assert.equal(execFileSync("git", ["status", "--porcelain", "--", "src/util/new.py"], { cwd: root, encoding: "utf8" }), "?? src/util/new.py\n", "the new file is still untracked");
  });
});

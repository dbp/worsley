import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

/** @type {esbuild.BuildOptions} */
const baseOptions = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
  legalComments: "none",
};

/**
 * The extension: desktop VS Code only, since it runs commands and reads the
 * workspace from disk. The extension host is Node 22 from VS Code 1.101,
 * which `engines.vscode` requires.
 */
/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  ...baseOptions,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: ["node22"],
  external: ["vscode"],
};

/** The panel's script, with markdown-it bundled in. */
/** @type {esbuild.BuildOptions} */
const webviewOptions = {
  ...baseOptions,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: ["es2022"],
};

function testEntries(dir, suffix) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name));
}

/**
 * The tests, compiled for `node --test`, for the VS Code test host, and for
 * the live run against a real model. Their packages stay in node_modules
 * rather than being bundled.
 */
/** @type {esbuild.BuildOptions[]} */
const testOptions = [
  {
    ...baseOptions,
    entryPoints: testEntries("test/unit", ".test.ts"),
    outdir: "out/test/unit",
    platform: "node",
    format: "cjs",
    target: ["node22"],
    packages: "external",
  },
  {
    ...baseOptions,
    entryPoints: ["test/integration/run.ts", "test/integration/suite.ts"],
    outdir: "out/test/integration",
    platform: "node",
    format: "cjs",
    target: ["node22"],
    packages: "external",
  },
  {
    ...baseOptions,
    entryPoints: ["test/live/run.ts", "test/live/suite.ts", "test/live/translations.ts", "test/live/functions.ts"],
    outdir: "out/test/live",
    platform: "node",
    format: "cjs",
    target: ["node22"],
    packages: "external",
  },
];

const allConfigs = tests ? testOptions : [extensionOptions, webviewOptions];

if (tests) {
  // A test file deleted from test/ mustn't go on running from here.
  fs.rmSync("out/test", { recursive: true, force: true });
}

if (watch) {
  const contexts = await Promise.all(allConfigs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("[esbuild] watching...");
} else {
  await Promise.all(allConfigs.map((c) => esbuild.build(c)));
  console.log("[esbuild] build complete");
}

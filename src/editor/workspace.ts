import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { listFiles } from "../core/files";
import { absolutePath, workspacePath } from "../core/paths";
import type { CodeLocation, OutlineEntry, Workspace } from "../core/tools";

/** How long a listing of the workspace's files is reused: one request lists them many times. */
const LISTING_MS = 5000;

/**
 * The workspace folder as the tools see it in VS Code: reads include
 * unsaved changes, writes go to disk (so git sees them, and format-on-save
 * doesn't rewrite them behind the model's back), and outlines and references
 * come from the language servers.
 */
export class EditorWorkspace implements Workspace {
  readonly ripgrep = findRipgrep();
  private listing: Promise<string[]> | undefined;
  private listedAt = 0;

  constructor(readonly root: string) {}

  uri(relative: string): vscode.Uri {
    return vscode.Uri.file(absolutePath(this.root, relative));
  }

  /** A file's path relative to the folder, or its absolute path when outside. */
  relative(uri: vscode.Uri): string {
    return workspacePath(this.root, uri.fsPath) ?? uri.fsPath;
  }

  listFiles(): Promise<string[]> {
    if (this.listing === undefined || Date.now() - this.listedAt > LISTING_MS) {
      this.listing = listFiles(this.root);
      this.listedAt = Date.now();
    }
    return this.listing;
  }

  async exists(relative: string): Promise<"file" | "folder" | undefined> {
    try {
      const stat = await fsp.stat(absolutePath(this.root, relative));
      return stat.isDirectory() ? "folder" : stat.isFile() ? "file" : undefined;
    } catch {
      return undefined;
    }
  }

  private openDocument(relative: string): vscode.TextDocument | undefined {
    const full = absolutePath(this.root, relative);
    return vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && doc.uri.fsPath === full);
  }

  async readText(relative: string): Promise<string> {
    const doc = this.openDocument(relative);
    if (doc?.isDirty) {
      return doc.getText();
    }
    return fsp.readFile(absolutePath(this.root, relative), "utf8");
  }

  async writeText(relative: string, text: string): Promise<void> {
    const doc = this.openDocument(relative);
    if (doc?.isDirty) {
      // The user typed while the model worked: the model's text was made from
      // the editor's, so it replaces that, and saving keeps both.
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      return;
    }
    const full = absolutePath(this.root, relative);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, text, "utf8");
    this.listing = undefined;
  }

  async outline(relative: string): Promise<OutlineEntry[] | undefined> {
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
      "vscode.executeDocumentSymbolProvider",
      this.uri(relative),
    );
    if (symbols === undefined || symbols.length === 0) {
      return undefined;
    }
    const toEntry = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation): OutlineEntry => {
      const range = "range" in symbol ? symbol.range : symbol.location.range;
      return {
        name: symbol.name,
        kind: vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? "symbol",
        start: range.start.line + 1,
        end: range.end.line + 1,
        children: "children" in symbol ? symbol.children.map(toEntry) : [],
      };
    };
    return symbols.map(toEntry).sort((a, b) => a.start - b.start);
  }

  async references(relative: string, line: number, character: number): Promise<CodeLocation[]> {
    const locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
      "vscode.executeReferenceProvider",
      this.uri(relative),
      new vscode.Position(line - 1, character),
    );
    return (locations ?? []).map((l) => this.location(l.uri, l.range));
  }

  async definitions(relative: string, line: number, character: number): Promise<CodeLocation[]> {
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
      "vscode.executeDefinitionProvider",
      this.uri(relative),
      new vscode.Position(line - 1, character),
    );
    return (found ?? []).map((l) => ("targetUri" in l ? this.location(l.targetUri, l.targetSelectionRange ?? l.targetRange) : this.location(l.uri, l.range)));
  }

  private location(uri: vscode.Uri, range: vscode.Range): CodeLocation {
    return { path: this.relative(uri), start: range.start.line + 1, end: range.end.line + 1 };
  }
}

/** The ripgrep VS Code ships with, wherever this version keeps it. */
function findRipgrep(): string | undefined {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const platform = `${process.platform}-${process.arch}`;
  const candidates: string[] = [];
  for (const modules of ["node_modules", "node_modules.asar.unpacked"]) {
    candidates.push(
      path.join(vscode.env.appRoot, modules, "@vscode", "ripgrep", "bin", exe),
      path.join(vscode.env.appRoot, modules, "@vscode", "ripgrep-universal", "bin", platform, exe),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

import * as vscode from "vscode";
import type { EditorFile } from "../core/context";
import { workspacePath } from "../core/paths";

/** How long the editor has to settle before the panel's chips are redrawn. */
const SETTLE_MS = 150;

/**
 * What the editor shows: each visible file in the workspace folder, the
 * lines on screen, and what is selected. The panel shows it as chips, and
 * each message carries it to the model.
 */
export class EditorTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly root: () => string | undefined) {
    const changed = (): void => this.schedule();
    this.subscriptions = [
      this.emitter,
      vscode.window.onDidChangeVisibleTextEditors(changed),
      vscode.window.onDidChangeActiveTextEditor(changed),
      vscode.window.onDidChangeTextEditorSelection(changed),
      vscode.window.onDidChangeTextEditorVisibleRanges(changed),
      vscode.workspace.onDidSaveTextDocument(changed),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((editor) => editor.document === e.document)) {
          changed();
        }
      }),
    ];
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), SETTLE_MS);
  }

  snapshot(): EditorFile[] {
    const root = this.root();
    if (root === undefined) {
      return [];
    }
    const active = vscode.window.activeTextEditor;
    const byPath = new Map<string, EditorFile>();
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (doc.uri.scheme !== "file") {
        continue;
      }
      const path = workspacePath(root, doc.uri.fsPath);
      if (path === undefined) {
        continue;
      }
      const visible = editor.visibleRanges.map((r) => ({ start: r.start.line + 1, end: r.end.line + 1 }));
      const selections = editor.selections
        .filter((s) => !s.isEmpty)
        .map((s) => ({
          start: s.start.line + 1,
          // A selection that ends at the start of a line doesn't take in that line.
          end: s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1,
          text: doc.getText(s),
        }));
      const existing = byPath.get(path);
      if (existing !== undefined) {
        // The same file in two editors, side by side.
        existing.visible.push(...visible);
        existing.selections.push(...selections);
        existing.active ||= editor === active;
        continue;
      }
      byPath.set(path, { path, text: doc.getText(), active: editor === active, dirty: doc.isDirty, visible, selections });
    }
    return [...byPath.values()];
  }
}

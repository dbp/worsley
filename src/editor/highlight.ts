import * as vscode from "vscode";

/** Ranges longer than this are revealed from their first line rather than centred. */
const TALL_RANGE = 20;

/**
 * How long after a file is shown a reload of it from disk puts the cursor
 * back. VS Code may reload a file Worsley changed only once it is shown
 * again, which moves the cursor away from the lines just pointed at.
 */
const RELOAD_MS = 3000;

export interface Highlight {
  uri: vscode.Uri;
  /** 1-based and inclusive. */
  start: number;
  end: number;
}

/**
 * The lines Worsley is pointing at: the link last clicked, the tour's current
 * step, or every place in a list of locations. They stay highlighted in any
 * editor that shows them until something else is pointed at.
 */
export class Highlighter implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("worsley.highlightBackground"),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("worsley.highlightBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  private byFile = new Map<string, vscode.Range[]>();
  private shown: { uri: string; until: number; place(): void } | undefined;
  private readonly subscriptions = [
    vscode.window.onDidChangeVisibleTextEditors(() => this.apply()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // A reload from disk leaves the file clean; the user's typing doesn't.
      const reloaded = e.contentChanges.length > 0 && e.reason === undefined && !e.document.isDirty;
      const key = e.document.uri.toString();
      if (!reloaded || !this.byFile.has(key)) {
        return;
      }
      this.apply();
      if (this.shown?.uri === key && Date.now() < this.shown.until) {
        this.shown.place();
      }
    }),
  ];

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.decoration.dispose();
  }

  /** Opens the file with the range in view and highlighted (alone, or with `also`). */
  async show(target: Highlight, also: Highlight[] = []): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    const place = (): void => {
      const range = toRange(editor.document, target);
      // Set here rather than with showTextDocument's `selection`, which an
      // editor that is already open may not take.
      editor.selection = new vscode.Selection(range.start, range.start);
      const tall = target.end - target.start + 1 > TALL_RANGE;
      editor.revealRange(range, tall ? vscode.TextEditorRevealType.AtTop : vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    };
    place();
    this.shown = { uri: doc.uri.toString(), until: Date.now() + RELOAD_MS, place };
    this.set([target, ...also]);
  }

  /** Opens a file at its top, highlighting nothing. */
  async open(uri: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    this.clear();
  }

  set(highlights: Highlight[]): void {
    this.byFile = new Map();
    for (const h of highlights) {
      const key = h.uri.toString();
      const ranges = this.byFile.get(key) ?? [];
      ranges.push(new vscode.Range(h.start - 1, 0, Math.max(h.start, h.end) - 1, 0));
      this.byFile.set(key, ranges);
    }
    this.apply();
  }

  clear(): void {
    this.shown = undefined;
    this.set([]);
  }

  private apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, this.byFile.get(editor.document.uri.toString()) ?? []);
    }
    void vscode.commands.executeCommand("setContext", "worsley.highlighting", this.byFile.size > 0);
  }
}

function toRange(doc: vscode.TextDocument, h: Highlight): vscode.Range {
  const last = Math.max(0, doc.lineCount - 1);
  const start = Math.min(Math.max(0, h.start - 1), last);
  const end = Math.min(Math.max(start, h.end - 1), last);
  return new vscode.Range(start, 0, end, doc.lineAt(end).range.end.character);
}

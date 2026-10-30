import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerCommands, pickBackend } from "./editor/commands";
import { EditorTracker } from "./editor/editorTracker";
import { Highlighter } from "./editor/highlight";
import { PanelProvider } from "./editor/panel";
import { Session, type ThreadStore } from "./editor/session";
import { WorsleyStatusBar } from "./editor/statusBar";

/** What `activate` returns, for the integration test. */
export interface WorsleyApi {
  session: Session;
  panel: PanelProvider;
  /** Where the thread is kept between windows. */
  threadFile: string | undefined;
}

/**
 * A file in VS Code's storage for the workspace. It is written at once,
 * since the last write comes as the window closes, and by way of a second
 * file, so that a write cut short leaves the one before.
 */
function threadStore(file: string): ThreadStore {
  return {
    load: () => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    save: (text) => {
      if (text === undefined) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.new`, text);
      fs.renameSync(`${file}.new`, file);
    },
  };
}

export function activate(context: vscode.ExtensionContext): WorsleyApi {
  // Worsley works in the workspace's first folder, on disk.
  const root = (): string | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
  };
  const tracker = new EditorTracker(root);
  const highlighter = new Highlighter();
  const threadFile = context.storageUri?.scheme === "file" ? path.join(context.storageUri.fsPath, "thread.json") : undefined;
  const store = threadFile === undefined ? undefined : threadStore(threadFile);
  const session = new Session({ root, tracker, highlighter, secrets: context.secrets, state: context.workspaceState, store });
  const panel = new PanelProvider(context.extensionUri, session, { pickBackend: () => pickBackend(context.secrets) });
  context.subscriptions.push(
    tracker,
    highlighter,
    session,
    panel,
    vscode.window.registerWebviewViewProvider(PanelProvider.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    new WorsleyStatusBar(session),
  );
  registerCommands(context, { session, panel, highlighter });
  return { session, panel, threadFile };
}

export function deactivate(): void {}

import * as vscode from "vscode";
import { registerCommands, pickBackend } from "./editor/commands";
import { EditorTracker } from "./editor/editorTracker";
import { Highlighter } from "./editor/highlight";
import { PanelProvider } from "./editor/panel";
import { Session } from "./editor/session";
import { WorsleyStatusBar } from "./editor/statusBar";

/** What `activate` returns, for the integration test. */
export interface WorsleyApi {
  session: Session;
  panel: PanelProvider;
}

export function activate(context: vscode.ExtensionContext): WorsleyApi {
  // Worsley works in the workspace's first folder, on disk.
  const root = (): string | undefined => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : undefined;
  };
  const tracker = new EditorTracker(root);
  const highlighter = new Highlighter();
  const session = new Session({ root, tracker, highlighter, secrets: context.secrets, state: context.workspaceState });
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
  return { session, panel };
}

export function deactivate(): void {}

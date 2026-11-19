import * as vscode from "vscode";
import type { HostMessage, Mode, PanelMessage } from "../protocol";
import type { Session } from "./session";

/**
 * The Worsley view: a webview that draws the session's thread and sends back
 * what the user does. Messages for a view that isn't open yet wait until it
 * says it is ready.
 */
export class PanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "worsley.panel";
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private focusRequest: HostMessage | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly commands: { pickBackend(): Promise<void> },
  ) {
    this.subscription = session.onDidPost((message) => this.post(message));
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /** The panel's script is running and has asked for the thread. */
  get isReady(): boolean {
    return this.view !== undefined && this.ready;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    view.webview.html = html(view.webview, dist, media);
    view.webview.onDidReceiveMessage((message: PanelMessage) => this.receive(message));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  /** Shows the panel, leaving the focus where it is when the panel is open already. */
  async reveal(): Promise<void> {
    if (this.view !== undefined) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
  }

  /** Shows the panel and puts the cursor in its message box, in `mode`. */
  async focus(mode?: Mode, text?: string): Promise<void> {
    this.focusRequest = { type: "focus", mode, text };
    await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
    if (this.ready) {
      this.post(this.focusRequest);
      this.focusRequest = undefined;
    }
  }

  private post(message: HostMessage): void {
    if (this.view !== undefined && this.ready) {
      void this.view.webview.postMessage(message);
    }
  }

  private receive(message: PanelMessage): void {
    const session = this.session;
    switch (message.type) {
      case "ready":
        this.ready = true;
        session.resync();
        if (this.focusRequest !== undefined) {
          this.post(this.focusRequest);
          this.focusRequest = undefined;
        }
        return;
      case "send":
        void session.send(message.text, message.mode);
        return;
      case "stop":
        session.stop();
        return;
      case "newThread":
        void session.reset();
        return;
      case "open":
        void session.openHref(message.href);
        return;
      case "openExternal":
        if (/^https?:\/\//i.test(message.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        return;
      case "diff":
        void session.openDiff(message.path);
        return;
      case "approve":
        session.approve(message.id, message.decision, message.scope);
        return;
      case "toggleChip":
        session.toggleChip(message.key);
        return;
      case "tourGo":
        void session.tourGo(message.index);
        return;
      case "tourEnd":
        session.tourEnd();
        return;
      case "peek":
        void session.peek(message.id);
        return;
      case "walkChanges":
        void session.walkChanges();
        return;
      case "checkLinks":
        void session.checkLinks(message.id, message.hrefs);
        return;
      case "copy":
        void vscode.env.clipboard.writeText(message.text);
        return;
      case "startTour":
        void vscode.commands.executeCommand("worsley.tour");
        return;
      case "standalone":
        void (message.request === "explain" ? session.explainLine() : session.translate());
        return;
      case "pickBackend":
        void this.commands.pickBackend();
        return;
    }
  }
}

function html(webview: vscode.Webview, dist: vscode.Uri, media: vscode.Uri): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
  // No remote images: a reply could otherwise send what it read to any
  // server, in an image's URL, just by being shown.
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Worsley</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

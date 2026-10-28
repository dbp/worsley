import * as vscode from "vscode";
import type { Session } from "./session";
import { activeBackend } from "./settings";

/**
 * The model in use, in the status bar, spinning while a request runs.
 * Clicking it chooses another.
 */
export class WorsleyStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("worsley.status", vscode.StatusBarAlignment.Right, 100);
  private readonly subscriptions: vscode.Disposable[];
  private busy = false;
  private status = "";

  constructor(session: Session) {
    this.item.name = "Worsley";
    this.item.command = "worsley.pickBackend";
    this.subscriptions = [
      session.onDidPost((message) => {
        if (message.type === "busy") {
          this.busy = message.busy;
          this.status = message.status;
          this.render();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("worsley")) {
          this.render();
        }
      }),
    ];
    this.render();
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.item.dispose();
  }

  private render(): void {
    const backend = activeBackend();
    if (backend === undefined) {
      this.item.text = "$(book) Worsley: no model";
      this.item.tooltip = "Add a backend to worsley.backends in your settings.";
      return;
    }
    const model = backend.model.split("/").pop() ?? backend.model;
    this.item.text = `${this.busy ? "$(loading~spin)" : "$(book)"} ${model}`;
    const doing = this.busy && this.status !== "" ? `\n\n${this.status}` : "";
    this.item.tooltip = `Worsley: ${backend.model} on ${backend.name} (${backend.baseUrl})${doing}\n\nClick to choose another model.`;
  }
}

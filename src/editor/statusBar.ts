import * as vscode from "vscode";
import { spendOf, type Spend } from "../core/chat";
import type { Session } from "./session";
import { activeBackend, endpointFor, type Backend } from "./settings";

/** How long after a request to ask what it cost: a server's accounting can lag. */
const AFTER_REQUEST_MS = 3_000;
/** How often to ask anyway, for what the key spends elsewhere and for the new day. */
const EVERY_MS = 5 * 60_000;

/**
 * The model in use, in the status bar, spinning while a request runs, with
 * what its key has spent today when the server says, as OpenRouter does.
 * Clicking it chooses another.
 */
export class WorsleyStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("worsley.status", vscode.StatusBarAlignment.Right, 100);
  private readonly subscriptions: vscode.Disposable[];
  private busy = false;
  private status = "";
  /** What the backend in use has spent, and which backend that was for. */
  private spend: { backend: Backend; spend: Spend } | undefined;
  private afterRequest: NodeJS.Timeout | undefined;
  private readonly every: NodeJS.Timeout;

  constructor(
    session: Session,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.item.name = "Worsley";
    this.item.command = "worsley.pickBackend";
    this.subscriptions = [
      session.onDidPost((message) => {
        if (message.type === "busy") {
          if (this.busy && !message.busy) {
            clearTimeout(this.afterRequest);
            this.afterRequest = setTimeout(() => void this.refreshSpend(), AFTER_REQUEST_MS);
          }
          this.busy = message.busy;
          this.status = message.status;
          this.render();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("worsley")) {
          this.render();
          void this.refreshSpend();
        }
      }),
    ];
    this.every = setInterval(() => void this.refreshSpend(), EVERY_MS);
    this.render();
    this.item.show();
    void this.refreshSpend();
  }

  dispose(): void {
    clearTimeout(this.afterRequest);
    clearInterval(this.every);
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.item.dispose();
  }

  /** Asks the server what the key has spent; one without a key isn't asked. */
  private async refreshSpend(): Promise<void> {
    const backend = activeBackend();
    let spend: Spend | undefined;
    if (backend !== undefined) {
      const endpoint = await endpointFor(backend, this.secrets);
      spend = endpoint.apiKey !== undefined ? await spendOf(endpoint, AbortSignal.timeout(10_000)) : undefined;
    }
    this.spend = backend !== undefined && spend !== undefined ? { backend, spend } : undefined;
    this.render();
  }

  private render(): void {
    const backend = activeBackend();
    if (backend === undefined) {
      this.item.text = "$(worsley-sextant) Worsley: no model";
      this.item.tooltip = "Add a backend to worsley.backends in your settings.";
      return;
    }
    const model = backend.model.split("/").pop() ?? backend.model;
    // Only for the backend it was asked of, so a switch doesn't show the last one's.
    const spent = this.spend !== undefined && this.spend.backend.name === backend.name && this.spend.backend.baseUrl === backend.baseUrl ? this.spend.spend : undefined;
    this.item.text = `${this.busy ? "$(loading~spin)" : "$(worsley-sextant)"} ${model}${spent !== undefined ? ` · ${dollars(spent.today)} today` : ""}`;
    const doing = this.busy && this.status !== "" ? `\n\n${this.status}` : "";
    const spending =
      spent !== undefined
        ? `\n\nSpent with this key since ${dayStart()}: ${dollars(spent.today)}. This week: ${dollars(spent.week)}; this month: ${dollars(spent.month)}.`
        : "";
    this.item.tooltip = `Worsley: ${backend.model} on ${backend.name} (${backend.baseUrl})${spending}${doing}\n\nClick to choose another model.`;
  }
}

function dollars(amount: number): string {
  return amount > 0 && amount < 0.005 ? "under $0.01" : `$${amount.toFixed(2)}`;
}

/** When the UTC day began, in local time, as the server's "today" counts from it. */
function dayStart(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const time = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return start.getDate() === now.getDate() ? `${time} (midnight UTC)` : `${time} yesterday (midnight UTC)`;
}

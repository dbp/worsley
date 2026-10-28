import * as vscode from "vscode";
import { listModels } from "../core/chat";
import { quoteWords } from "../core/commandLine";
import { errorText } from "../core/errorText";
import { TOUR_REQUEST } from "../core/prompts";
import type { Highlighter } from "./highlight";
import type { PanelProvider } from "./panel";
import type { Session } from "./session";
import * as settings from "./settings";

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: { session: Session; panel: PanelProvider; highlighter: Highlighter },
): void {
  const { session, panel } = deps;
  const register = (id: string, run: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, run));
  };
  // With a string argument (from a keybinding's `args`, or a test), the
  // request is sent at once; from a menu the argument is the file's URI.
  register("worsley.ask", async (question?: unknown) => {
    if (typeof question === "string") {
      await session.send(question, "ask");
    } else {
      await panel.focus("ask");
    }
  });
  register("worsley.change", async (instruction?: unknown) => {
    if (typeof instruction === "string") {
      await session.send(instruction, "change");
    } else {
      await panel.focus("change");
    }
  });
  register("worsley.tour", async () => {
    await panel.focus("ask");
    await session.send(TOUR_REQUEST, "ask");
  });
  register("worsley.newThread", () => session.reset());
  register("worsley.stop", () => session.stop());
  register("worsley.pickBackend", () => pickBackend(context.secrets));
  register("worsley.setApiKey", () => setApiKey(context.secrets));
  register("worsley.allowedCommands", () => reviewAllowed(session));
  register("worsley.clearHighlights", () => deps.highlighter.clear());
}

/** Everything that runs without asking in this workspace; unticking one makes Worsley ask again. */
async function reviewAllowed(session: Session): Promise<void> {
  const rules = session.allowedCommands;
  const test = settings.testCommand();
  type Entry = vscode.QuickPickItem & { prefix?: string[]; exact?: string };
  const entries: Entry[] = [
    ...rules.prefixes.map((prefix) => ({ label: `${quoteWords(prefix)} …`, description: "with any arguments", picked: true, prefix })),
    ...rules.exact.map((exact) => ({ label: exact, description: "exactly", picked: true, exact })),
  ];
  const testNote = test !== "" ? ` The test command, ${test}, runs without asking too (worsley.testCommand).` : "";
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`Worsley asks before running any command in this workspace.${testNote}`);
    return;
  }
  const kept = await vscode.window.showQuickPick(entries, {
    canPickMany: true,
    title: "Worsley: Commands That Run Without Asking",
    placeHolder: `Untick any that should ask first again.${testNote}`,
  });
  if (kept === undefined) {
    return;
  }
  await session.setAllowedCommands({
    exact: kept.flatMap((e) => (e.exact !== undefined ? [e.exact] : [])),
    prefixes: kept.flatMap((e) => (e.prefix !== undefined ? [e.prefix] : [])),
  });
}

interface BackendItem extends vscode.QuickPickItem {
  backend: settings.Backend;
}

async function chooseFrom(backends: settings.Backend[], title: string): Promise<settings.Backend | undefined> {
  if (backends.length <= 1) {
    return backends[0];
  }
  const active = settings.activeBackend();
  const items: BackendItem[] = backends.map((b) => ({
    label: b.name,
    description: b === active ? `${b.model} · in use` : b.model,
    detail: b.baseUrl,
    backend: b,
  }));
  return (await vscode.window.showQuickPick(items, { title }))?.backend;
}

/** A backend, then one of the models its server lists (or any model id typed in). */
export async function pickBackend(secrets: vscode.SecretStorage): Promise<void> {
  const all = settings.backends();
  if (all.length === 0) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "worsley.backends");
    return;
  }
  const backend = await chooseFrom(all, "Worsley: Choose a Backend");
  if (backend === undefined) {
    return;
  }
  const model = await pickModel(backend, secrets);
  if (model !== undefined) {
    await settings.chooseBackend(backend.name, model);
  }
}

function pickModel(backend: settings.Backend, secrets: vscode.SecretStorage): Promise<string | undefined> {
  const quickPick = vscode.window.createQuickPick();
  quickPick.title = `Worsley: Choose a Model on ${backend.name}`;
  quickPick.placeholder = `Filter the list, or type a model's id (now ${backend.model})`;
  quickPick.matchOnDescription = true;
  quickPick.busy = true;
  const current: vscode.QuickPickItem = { label: backend.model, description: "in use" };
  let listed: vscode.QuickPickItem[] = [];
  const refresh = (): void => {
    const typed = quickPick.value.trim();
    const known = typed === backend.model || listed.some((item) => item.label === typed);
    const custom = typed !== "" && !known ? [{ label: typed, description: "use this id" }] : [];
    quickPick.items = [...custom, current, ...listed.filter((item) => item.label !== backend.model)];
  };
  refresh();
  quickPick.onDidChangeValue(refresh);
  quickPick.show();

  const controller = new AbortController();
  void settings
    .endpointFor(backend, secrets)
    .then((endpoint) => listModels(endpoint, controller.signal))
    .then(
      (models) => {
        listed = models.map((m) => ({ label: m.id, description: m.detail }));
        refresh();
      },
      (err: unknown) => {
        if (!controller.signal.aborted) {
          quickPick.placeholder = `Couldn't list the models (${errorText(err)}). Type a model's id.`;
        }
      },
    )
    .finally(() => {
      quickPick.busy = false;
    });

  return new Promise((resolve) => {
    quickPick.onDidAccept(() => {
      const chosen = quickPick.selectedItems[0]?.label ?? quickPick.value.trim();
      resolve(chosen === "" ? undefined : chosen);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      controller.abort();
      resolve(undefined);
      quickPick.dispose();
    });
  });
}

async function setApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const remote = settings.backends().filter((b) => !settings.isLocal(b));
  const backend = await chooseFrom(remote.length > 0 ? remote : settings.backends(), "Worsley: Set the API Key for…");
  if (backend === undefined) {
    return;
  }
  const fallback = backend.apiKeyEnv !== undefined ? ` and use ${backend.apiKeyEnv} instead` : "";
  const key = await vscode.window.showInputBox({
    title: `Worsley: API Key for ${backend.name}`,
    prompt: `Kept in VS Code's secret storage. Leave it empty to remove the stored key${fallback}.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  await settings.storeApiKey(backend, key.trim(), secrets);
  void vscode.window.showInformationMessage(key.trim() !== "" ? `Worsley: saved the key for ${backend.name}.` : `Worsley: removed the key for ${backend.name}.`);
}

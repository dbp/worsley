import * as vscode from "vscode";
import { listModels, refusedKey } from "../core/chat";
import { quoteWords } from "../core/commandLine";
import { errorText } from "../core/errorText";
import { TOUR_REQUEST } from "../core/prompts";
import { remember, type ModelChoice } from "../core/recent";
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
  // Menus and keybindings offer only what Worsley's level does (the
  // `worsley.feature.*` context keys); a command run some other way says
  // in the panel when its level doesn't offer it.
  register("worsley.ask", async (question?: unknown) => {
    if (typeof question === "string") {
      await session.send(question, "ask");
    } else if (session.offers("ask")) {
      await panel.focus("ask");
    }
  });
  register("worsley.change", async (instruction?: unknown) => {
    if (typeof instruction === "string") {
      await session.send(instruction, "change");
    } else if (session.offers("change")) {
      await panel.focus("change");
    }
  });
  register("worsley.explainLine", async () => {
    await panel.reveal();
    await session.explainLine();
  });
  register("worsley.translate", async () => {
    await panel.reveal();
    await session.translate();
  });
  register("worsley.tour", async () => {
    await panel.focus("ask");
    await session.send(TOUR_REQUEST, "ask", undefined, "tour");
  });
  register("worsley.reviewFile", async () => {
    await panel.focus("ask");
    await session.reviewChanges("file");
  });
  register("worsley.reviewAll", async () => {
    await panel.focus("ask");
    await session.reviewChanges("all");
  });
  register("worsley.newThread", () => session.reset());
  register("worsley.stop", () => session.stop());
  register("worsley.pickBackend", () => pickBackend(context.secrets, context.globalState));
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

/** The models chosen lately, latest first, kept for the user rather than the workspace. */
const RECENT_KEY = "worsley.recentModels";

/**
 * A model chosen lately, which switches at once; or a backend, or a server
 * to add as one, then one of the models its server lists (or any model id
 * typed in).
 */
export async function pickBackend(secrets: vscode.SecretStorage, state: vscode.Memento): Promise<void> {
  const all = settings.backends();
  const active = settings.activeBackend();
  const saved = state.get<ModelChoice[]>(RECENT_KEY) ?? [];
  // The model in use comes first, even when it was set by hand.
  const recent = (active !== undefined ? remember(saved, { backend: active.name, model: active.model }) : saved).filter((c) =>
    all.some((b) => b.name === c.backend),
  );
  type Item = vscode.QuickPickItem & { backend?: settings.Backend; choice?: ModelChoice };
  const items: Item[] = [
    { label: "Recent", kind: vscode.QuickPickItemKind.Separator },
    ...recent.map((choice, i) => ({ label: choice.model, description: i === 0 && active !== undefined ? `${choice.backend} · in use` : choice.backend, choice })),
    { label: "Another model", kind: vscode.QuickPickItemKind.Separator },
    ...all.map((b) => ({ label: b.name, description: "choose a model", detail: b.baseUrl, backend: b })),
    { label: "$(add) Add a server…", detail: "Any OpenAI-compatible endpoint with tool calls, such as llama.cpp or vLLM on another machine" },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: "Worsley: Choose a Model", matchOnDescription: true });
  if (picked === undefined) {
    return;
  }
  let chosen: ModelChoice;
  if (picked.choice !== undefined) {
    chosen = picked.choice;
    await settings.chooseBackend(chosen.backend, chosen.model);
  } else {
    const backend = picked.backend ?? (await newServer());
    if (backend === undefined) {
      return;
    }
    await askForKeyIfRefused(backend, secrets);
    const model = await pickModel(backend, secrets);
    if (model === undefined) {
      return;
    }
    if (picked.backend !== undefined) {
      await settings.chooseBackend(backend.name, model);
    } else {
      await settings.addBackend({ ...backend, model });
    }
    chosen = { backend: backend.name, model };
  }
  await state.update(RECENT_KEY, remember(recent, chosen));
}

/**
 * Whether `backend`'s server takes Worsley as it is, with the key it has or
 * with none. If it turns Worsley away, the user is asked for a key before
 * the models are listed.
 */
async function askForKeyIfRefused(backend: settings.Backend, secrets: vscode.SecretStorage): Promise<void> {
  const endpoint = await settings.endpointFor(backend, secrets);
  const refused = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Worsley: checking ${backend.name}` }, () =>
    listModels(endpoint, AbortSignal.timeout(10_000)).then(
      () => false,
      (err: unknown) => refusedKey(err),
    ),
  );
  if (refused) {
    const why = endpoint.apiKey === undefined ? "without a key, so it needs one" : "with the key stored for it, so it needs another";
    await settings.askForKey(backend, secrets, `${backend.name} turned Worsley away ${why}. `);
  }
}

/** A server to add: its address and a name for it, with the model still to choose. */
async function newServer(): Promise<settings.Backend | undefined> {
  const address = await vscode.window.showInputBox({
    title: "Worsley: Add a Server (1/2)",
    prompt: "Its OpenAI-compatible address, up to and including the /v1",
    placeHolder: "http://gpu-box:8080/v1",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const url = value.trim();
      if (!/^https?:\/\/[^\s/]+/i.test(url)) {
        return "An http:// or https:// address, such as http://gpu-box:8080/v1";
      }
      return /\/v\d+\/?$/.test(url) ? undefined : { message: "Most servers' addresses end in /v1.", severity: vscode.InputBoxValidationSeverity.Warning };
    },
  });
  if (address === undefined) {
    return undefined;
  }
  const baseUrl = address.trim().replace(/\/+$/, "");
  const taken = new Set(settings.backends().map((b) => b.name));
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = "server";
  }
  let suggested = host;
  for (let n = 2; taken.has(suggested); n++) {
    suggested = `${host} ${n}`;
  }
  const name = await vscode.window.showInputBox({
    title: "Worsley: Add a Server (2/2)",
    prompt: "A name for it, as Worsley shows it",
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      return trimmed === "" ? "A name, such as the machine's" : taken.has(trimmed) ? `There is a backend called ${trimmed} already.` : undefined;
    },
  });
  if (name === undefined) {
    return undefined;
  }
  return { name: name.trim(), baseUrl, model: "" };
}

function pickModel(backend: settings.Backend, secrets: vscode.SecretStorage): Promise<string | undefined> {
  const quickPick = vscode.window.createQuickPick();
  quickPick.title = `Worsley: Choose a Model on ${backend.name}`;
  quickPick.placeholder = backend.model !== "" ? `Filter the list, or type a model's id (now ${backend.model})` : "Filter the list, or type a model's id";
  quickPick.matchOnDescription = true;
  quickPick.busy = true;
  // A server just added has no model yet.
  const current: vscode.QuickPickItem[] = backend.model !== "" ? [{ label: backend.model, description: "in use" }] : [];
  let listed: vscode.QuickPickItem[] = [];
  const refresh = (): void => {
    const typed = quickPick.value.trim();
    const known = typed === backend.model || listed.some((item) => item.label === typed);
    const custom = typed !== "" && !known ? [{ label: typed, description: "use this id" }] : [];
    quickPick.items = [...custom, ...current, ...listed.filter((item) => item.label !== backend.model)];
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
  const backend = await chooseFrom(settings.backends(), "Worsley: Set the API Key for…");
  if (backend === undefined) {
    return;
  }
  const key = await settings.askForKey(backend, secrets);
  if (key !== undefined) {
    void vscode.window.showInformationMessage(key !== "" ? `Worsley: saved the key for ${backend.name}.` : `Worsley: removed the key for ${backend.name}.`);
  }
}

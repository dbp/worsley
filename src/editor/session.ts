import * as path from "node:path";
import * as vscode from "vscode";
import { runAgent, type AgentEnd, type AgentHooks } from "../core/agent";
import { chatTurn, contextWindowOf, type ChatMessage, type ToolCall, type Usage } from "../core/chat";
import { allowedBy, scopesFor, withRules, type CommandRules } from "../core/commandLine";
import { TokenGauge, withRoom, type Compaction } from "../core/compact";
import { contextChips, formatContext } from "../core/context";
import { errorText } from "../core/errorText";
import { numberLines, splitLines, summarizeFiles } from "../core/files";
import { isGitRepo, uncommittedFiles } from "../core/git";
import { foldersOf, formatHref, labelRef, parseCodeRef, resolvePath, type CodeRef } from "../core/links";
import { workspacePath } from "../core/paths";
import { systemPrompt, tourStepRequest, userRequest, WALK_CHANGES } from "../core/prompts";
import { TOOLS, type Place, type ToolContext, type ToolUi, type TourPlan } from "../core/tools";
import type { Approval, ChangedFile, HostMessage, Item, LinkStatus, LocationView, Mode, TourView } from "../protocol";
import type { EditorTracker } from "./editorTracker";
import type { Highlighter } from "./highlight";
import * as settings from "./settings";
import { EditorWorkspace } from "./workspace";

type ItemOf<K extends Item["kind"]> = Extract<Item, { kind: K }>;
type NewItem<K extends Item["kind"]> = Omit<ItemOf<K>, "id">;

/** What the user said to always allow, per workspace: exact lines, and word prefixes for classes of commands. */
const ALLOWED_KEY = "worsley.allowedCommands";
const PREFIXES_KEY = "worsley.allowedPrefixes";
/** Streaming text reaches the panel at most this often. */
const UPDATE_MS = 60;

interface Listing {
  files: ReadonlySet<string>;
  folders(): ReadonlySet<string>;
}

interface TourState {
  plan: TourPlan;
  current: number;
  /** The thread item that heads each explained step. */
  explained: Map<number, string>;
}

export interface SessionDeps {
  root(): string | undefined;
  tracker: EditorTracker;
  highlighter: Highlighter;
  secrets: vscode.SecretStorage;
  state: vscode.Memento;
}

/**
 * The thread: what the panel shows, the messages the model has seen, and the
 * tour. One request runs at a time. Everything the panel shows goes out
 * through `onDidPost`.
 */
export class Session implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HostMessage>();
  readonly onDidPost = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];

  private items: Item[] = [];
  private messages: ChatMessage[] = [];
  private tour: TourState | undefined;
  /** present_tour was called: the first step opens once the request ends. */
  private tourToStart = false;
  /** Files read or written, for write_file's check; what of each visible file was sent. */
  private seen = new Set<string>();
  private sent = new Map<string, string>();
  /** How the current request's message is written, to write it again once what it refers back to is gone. */
  private recompose: (() => string) | undefined;
  private gauge = new TokenGauge();
  /** Each model's context window, by server and model, once found. */
  private readonly windows = new Map<string, number>();
  private excluded = new Set<string>();
  private changedInThread = new Set<string>();
  private lastChanges: ChangedFile[] = [];
  private warnedGit = false;
  private readonly locations = new Map<string, Place[]>();
  private readonly approvals = new Map<string, (decision: Approval, scope?: number) => void>();

  private busy = false;
  private status = "";
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Item>();
  private flushTimer: NodeJS.Timeout | undefined;
  private workspace: EditorWorkspace | undefined;

  constructor(private readonly deps: SessionDeps) {
    this.subscriptions = [
      this.emitter,
      deps.tracker.onDidChange(() => this.postContext()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("worsley")) {
          this.postBackend();
          this.postContext();
        }
      }),
    ];
  }

  dispose(): void {
    this.controller?.abort();
    clearTimeout(this.flushTimer);
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** For the integration test: what the panel would show, and what the model has seen. */
  get snapshot(): { items: readonly Item[]; tour: TourView | undefined; messages: readonly ChatMessage[]; busy: boolean } {
    return { items: this.items, tour: this.tourView(), messages: this.messages, busy: this.busy };
  }

  /** Everything, for a panel that has just loaded. */
  resync(): void {
    this.flush();
    this.post({ type: "reset", items: this.items, tour: this.tourView(), busy: this.busy, status: this.status });
    this.postContext();
    this.postBackend();
  }

  private currentWorkspace(): EditorWorkspace | undefined {
    const root = this.deps.root();
    if (root === undefined) {
      return undefined;
    }
    if (this.workspace?.root !== root) {
      this.workspace = new EditorWorkspace(root);
    }
    return this.workspace;
  }

  async send(text: string, mode: Mode): Promise<void> {
    const request = text.trim();
    if (request === "") {
      return;
    }
    if (this.busy) {
      void vscode.window.showInformationMessage("Worsley is still working on the last request. Wait for it, or stop it.");
      return;
    }
    const ws = this.currentWorkspace();
    if (ws === undefined) {
      this.add<"notice">({ kind: "notice", level: "error", text: "Open a folder first: Worsley works on the files in the workspace's first folder." });
      return;
    }
    await this.whileBusy(async () => {
      if (this.messages.length === 0) {
        this.messages.push({ role: "system", content: await this.systemPrompt(ws) });
      }
      const files = this.deps.tracker.snapshot();
      const maxFileLines = settings.maxFileLines();
      const included = contextChips(files, { maxFileLines, excluded: this.excluded })
        .filter((chip) => !chip.excluded)
        .map((chip) => chip.label);
      this.add<"user">({ kind: "user", mode, text: request, context: included });
      if (mode === "change") {
        await this.prepareChange(ws);
      }
      const position = this.tour !== undefined && this.tour.current >= 0 ? { plan: this.tour.plan, index: this.tour.current } : undefined;
      this.recompose = () => userRequest(mode, request, formatContext(files, { maxFileLines, excluded: this.excluded, sent: this.sent }), position);
      this.messages.push({ role: "user", content: this.recompose() });
      await this.run(ws, mode);
    });
    if (this.tourToStart) {
      this.tourToStart = false;
      await this.tourGo(0);
    }
  }

  stop(): void {
    this.controller?.abort();
  }

  async reset(): Promise<void> {
    // Before waiting, so that a request ending now doesn't open a tour step.
    this.tour = undefined;
    this.tourToStart = false;
    this.stop();
    await this.running;
    this.items = [];
    this.messages = [];
    this.seen = new Set();
    this.sent = new Map();
    this.recompose = undefined;
    this.gauge = new TokenGauge();
    this.excluded = new Set();
    this.changedInThread = new Set();
    this.lastChanges = [];
    this.warnedGit = false;
    this.locations.clear();
    this.pending.clear();
    this.deps.highlighter.clear();
    this.resync();
  }

  toggleChip(key: string): void {
    if (!this.excluded.delete(key)) {
      this.excluded.add(key);
    }
    this.postContext();
  }

  /** `scope`, with "always", indexes the approval's scopes; the suggested one otherwise. */
  approve(id: string, decision: Approval, scope?: number): void {
    this.approvals.get(id)?.(decision, scope);
  }

  async walkChanges(): Promise<void> {
    if (this.lastChanges.length > 0) {
      await this.send(WALK_CHANGES, "ask");
    }
  }

  // ---- Links, locations and diffs

  /** The workspace's files, and the folders that hold them once they're needed, for a batch of links. */
  private async listing(ws: EditorWorkspace): Promise<Listing> {
    const files = new Set(await ws.listFiles());
    let folders: Set<string> | undefined;
    return { files, folders: () => (folders ??= foldersOf(files)) };
  }

  /**
   * Where a link from a reply leads: a file, with its lines, or a folder.
   * The path as written comes first, a file before a folder; then the one
   * file, or else the one folder, whose path ends with it.
   */
  private async resolveHref(ws: EditorWorkspace, href: string, listing?: Listing): Promise<(CodeRef & { folder: boolean }) | undefined> {
    const ref = parseCodeRef(href);
    if (ref === undefined) {
      return undefined;
    }
    const known = listing ?? (await this.listing(ws));
    const relative = workspacePath(ws.root, ref.path);
    const kind = relative !== undefined ? await ws.exists(relative) : undefined;
    // An ignored file that exists is still worth opening.
    let found = kind === "file" ? relative : undefined;
    if (found === undefined && kind === "folder" && relative !== undefined) {
      return { path: relative, folder: true };
    }
    found ??= resolvePath(relative, ref.path, known.files);
    if (found === undefined) {
      const folder = resolvePath(relative, ref.path.replace(/\/+$/, ""), known.folders());
      return folder === undefined ? undefined : { path: folder, folder: true };
    }
    if (ref.start !== undefined) {
      const lines = await ws.readText(found).then((t) => splitLines(t).length, () => 0);
      if (ref.start > lines) {
        return undefined;
      }
    }
    return { ...ref, path: found, folder: false };
  }

  async openHref(href: string): Promise<void> {
    const ws = this.currentWorkspace();
    if (ws === undefined) {
      return;
    }
    const ref = await this.resolveHref(ws, href);
    if (ref === undefined) {
      void vscode.window.showWarningMessage(`Worsley: there is no ${href} in this workspace.`);
      return;
    }
    if (ref.folder) {
      // As VS Code's own links to folders do.
      await vscode.commands.executeCommand("revealInExplorer", ws.uri(ref.path));
    } else if (ref.start === undefined) {
      await this.deps.highlighter.open(ws.uri(ref.path));
    } else {
      await this.deps.highlighter.show({ uri: ws.uri(ref.path), start: ref.start, end: ref.end ?? ref.start });
    }
  }

  async checkLinks(id: string, hrefs: string[]): Promise<void> {
    const ws = this.currentWorkspace();
    if (ws === undefined) {
      return;
    }
    const listing = await this.listing(ws);
    const statuses: Record<string, LinkStatus> = {};
    for (const href of hrefs.slice(0, 500)) {
      statuses[href] = (await this.resolveHref(ws, href, listing)) !== undefined ? "ok" : "missing";
    }
    this.post({ type: "links", id, statuses });
  }

  /** The file's changes since the last commit, in the git extension's diff editor. */
  async openDiff(relative: string): Promise<void> {
    const ws = this.currentWorkspace();
    if (ws === undefined) {
      return;
    }
    const uri = ws.uri(relative);
    try {
      await vscode.commands.executeCommand("git.openChange", uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  /** Every place in a list of locations, in the editor's peek view. */
  async peek(id: string): Promise<void> {
    const ws = this.currentWorkspace();
    const places = this.locations.get(id);
    const first = places?.[0];
    if (ws === undefined || places === undefined || first === undefined) {
      return;
    }
    const highlights = places.map((p) => ({ uri: ws.uri(p.path), start: p.start, end: p.end }));
    await this.deps.highlighter.show(highlights[0]!, highlights.slice(1));
    const locations = places.map((p) => new vscode.Location(ws.uri(p.path), new vscode.Range(p.start - 1, 0, p.end - 1, 0)));
    await vscode.commands.executeCommand("editor.action.peekLocations", ws.uri(first.path), new vscode.Position(first.start - 1, 0), locations, "peek");
  }

  // ---- The tour

  /** Opens step `index` in the editor, asking the model to explain it the first time. */
  async tourGo(index: number): Promise<void> {
    const tour = this.tour;
    const ws = this.currentWorkspace();
    const step = tour?.plan.steps[index];
    if (tour === undefined || ws === undefined || step === undefined) {
      return;
    }
    const explained = tour.explained.has(index);
    if (!explained && this.busy) {
      return;
    }
    tour.current = index;
    this.postTour();
    try {
      await this.deps.highlighter.show({ uri: ws.uri(step.path), start: step.start, end: step.end });
    } catch (err) {
      this.add<"notice">({ kind: "notice", level: "error", text: `Couldn't open ${step.path}: ${errorText(err)}` });
      return;
    }
    if (explained) {
      return;
    }
    const header = this.add<"step">({ kind: "step", index, total: tour.plan.steps.length, title: step.title, href: formatHref(step) });
    tour.explained.set(index, header.id);
    this.postTour();
    let replied = false;
    await this.whileBusy(async () => {
      const lines = splitLines(await ws.readText(step.path));
      this.recompose = undefined;
      this.messages.push({ role: "user", content: tourStepRequest(tour.plan, index, numberLines(lines, step.start, step.end)) });
      replied = await this.run(ws, "ask");
    });
    if (!replied && this.tour === tour) {
      // Going back to the step tries again.
      tour.explained.delete(index);
      this.postTour();
    }
    if (this.tourToStart) {
      this.tourToStart = false;
      await this.tourGo(0);
    }
  }

  tourEnd(): void {
    this.tour = undefined;
    this.deps.highlighter.clear();
    this.postTour();
  }

  private tourView(): TourView | undefined {
    const tour = this.tour;
    if (tour === undefined) {
      return undefined;
    }
    return {
      title: tour.plan.title,
      current: tour.current,
      steps: tour.plan.steps.map((step, i) => ({ title: step.title, href: formatHref(step), itemId: tour.explained.get(i) })),
    };
  }

  // ---- Running a request

  private async whileBusy(work: () => Promise<void>): Promise<void> {
    this.setBusy(true, "Starting…");
    const running = work().catch((err: unknown) => {
      this.add<"notice">({ kind: "notice", level: "error", text: errorText(err) });
    });
    this.running = running;
    try {
      await running;
    } finally {
      this.running = undefined;
      this.setBusy(false, "");
    }
  }

  private async systemPrompt(ws: EditorWorkspace): Promise<string> {
    const files = await ws.listFiles();
    return systemPrompt({
      folderName: path.basename(ws.root),
      isGit: await isGitRepo(ws.root),
      testCommand: settings.testCommand(),
      fileCount: files.length,
      files: summarizeFiles(files),
    });
  }

  /** Saves what the tests should see, and says what git will show. */
  private async prepareChange(ws: EditorWorkspace): Promise<void> {
    const dirty = vscode.workspace.textDocuments.filter(
      (doc) => doc.isDirty && doc.uri.scheme === "file" && workspacePath(ws.root, doc.uri.fsPath) !== undefined,
    );
    if (dirty.length > 0) {
      await Promise.all(dirty.map((doc) => doc.save()));
      this.add<"notice">({ kind: "notice", level: "info", text: `Saved ${plural(dirty.length, "file")} with unsaved changes first, so that the tests run on what you see.` });
    }
    if (this.warnedGit) {
      return;
    }
    const uncommitted = await uncommittedFiles(ws.root);
    if (uncommitted === undefined) {
      this.warnedGit = true;
      this.add<"notice">({ kind: "notice", level: "warning", text: "This folder isn't in a git repository, so you can't review or undo Worsley's changes with git." });
      return;
    }
    const others = uncommitted.filter((file) => !this.changedInThread.has(file));
    if (others.length > 0) {
      this.warnedGit = true;
      this.add<"notice">({
        kind: "notice",
        level: "info",
        text: `${plural(others.length, "file")} already had uncommitted changes, so git will show Worsley's changes mixed in with them.`,
      });
    }
  }

  /** Runs the model on the thread until it answers. Whether it said anything. */
  private async run(ws: EditorWorkspace, mode: Mode): Promise<boolean> {
    const backend = settings.activeBackend();
    if (backend === undefined) {
      this.add<"notice">({ kind: "notice", level: "error", text: "No backend is set up: add one to worsley.backends in your settings." });
      return false;
    }
    const endpoint = await settings.endpointFor(backend, this.deps.secrets, mode);
    // The window is asked for once per server and model; an overflow error can say it too.
    const windowKey = `${backend.baseUrl}\n${backend.model}`;
    if (backend.contextTokens === undefined && !this.windows.has(windowKey)) {
      const found = await contextWindowOf(endpoint, AbortSignal.timeout(10_000));
      if (found !== undefined) {
        this.windows.set(windowKey, found);
      }
    }
    const window = (): number | undefined => backend.contextTokens ?? this.windows.get(windowKey);
    if (endpoint.apiKey === undefined && !settings.isLocal(backend)) {
      const where = backend.apiKeyEnv !== undefined ? `, or set ${backend.apiKeyEnv} in the environment VS Code starts from` : "";
      this.add<"notice">({ kind: "notice", level: "error", text: `${backend.name} needs an API key: run “Worsley: Set API Key…”${where}.` });
      return false;
    }

    const controller = new AbortController();
    this.controller = controller;
    const started = Date.now();
    const totals: Totals = { rounds: 0, generated: 0, cost: 0 };
    const changed = new Map<string, ChangedFile>();
    // By the call itself: servers may reuse ids from one turn to the next.
    const toolItems = new Map<ToolCall, ItemOf<"tool">>();
    let reply: ItemOf<"assistant"> | undefined;
    let lastReply: ItemOf<"assistant"> | undefined;
    const newReply = (): ItemOf<"assistant"> => this.add<"assistant">({ kind: "assistant", text: "", reasoning: "", streaming: true });

    const hooks: AgentHooks = {
      turnStarted: () => {
        reply = undefined;
        this.setStatus(`Waiting for ${backend.model}…`);
      },
      content: (delta) => {
        reply ??= newReply();
        reply.text += delta;
        this.update(reply);
        this.setStatus("Writing…");
      },
      reasoning: (delta) => {
        reply ??= newReply();
        reply.reasoning += delta;
        this.update(reply);
        this.setStatus("Thinking…");
      },
      status: (text) => this.setStatus(text),
      turnFinished: (turn) => {
        totals.rounds++;
        addUsage(totals, turn.usage);
        if (reply !== undefined) {
          reply.streaming = false;
          this.update(reply, true);
          if (reply.text.trim() !== "") {
            lastReply = reply;
          }
        }
      },
      toolStarted: (call, display) => {
        if (display.hidden) {
          return;
        }
        const item = this.add<"tool">({ kind: "tool", icon: display.icon, summary: display.summary, href: display.href, status: "running" });
        toolItems.set(call, item);
        this.setStatus(`${display.summary}…`);
      },
      toolFinished: (call, outcome) => {
        const d = outcome.display;
        if (d.changed !== undefined) {
          changed.set(d.changed.path, { path: d.changed.path, created: d.changed.created || changed.get(d.changed.path)?.created === true });
        }
        const fields = { icon: d.icon, summary: d.summary, href: d.href, detail: d.detail, diffPath: d.diffPath, status: d.failed === true ? ("failed" as const) : ("done" as const) };
        const item = toolItems.get(call);
        if (item !== undefined) {
          Object.assign(item, fields);
          this.update(item, true);
        } else if (d.hidden !== true) {
          // A call meant to show some other way, such as a tour, that failed.
          this.add<"tool">({ kind: "tool", ...fields });
        }
      },
    };

    const end = await runAgent({
      chat: withRoom((messages, tools, handlers, signal) => chatTurn(endpoint, messages, tools, handlers, signal), {
        window,
        learnWindow: (tokens) => this.windows.set(windowKey, tokens),
        gauge: this.gauge,
        made: (compaction) => this.madeRoom(compaction),
        status: (text) => this.setStatus(text),
      }),
      messages: this.messages,
      tools: TOOLS,
      maxRounds: settings.maxToolRounds(),
      context: this.toolContext(ws, mode, controller.signal),
      hooks,
    });
    this.controller = undefined;
    const unfinished = reply as ItemOf<"assistant"> | undefined;
    if (unfinished?.streaming === true) {
      unfinished.streaming = false;
      this.update(unfinished, true);
    }
    if (lastReply !== undefined) {
      lastReply.stats = formatStats(totals, Date.now() - started, window());
      this.update(lastReply, true);
    }
    if (changed.size > 0) {
      for (const file of changed.keys()) {
        this.changedInThread.add(file);
      }
      this.lastChanges = [...changed.values()];
      this.add<"changes">({ kind: "changes", files: this.lastChanges });
    }
    this.report(end, backend, lastReply !== undefined || toolItems.size > 0);
    return lastReply !== undefined;
  }

  private report(end: AgentEnd, backend: settings.Backend, saidSomething: boolean): void {
    const notice = (level: "info" | "warning" | "error", text: string): void => {
      this.add<"notice">({ kind: "notice", level, text });
    };
    switch (end.reason) {
      case "done":
        if (end.finish === "length") {
          notice("warning", "The reply was cut off: the model reached its limit on output.");
        } else if (!saidSomething) {
          notice("warning", "The model sent back an empty reply.");
        }
        return;
      case "aborted":
        notice("info", "Stopped.");
        return;
      case "rounds":
        notice("warning", `Stopped after ${settings.maxToolRounds()} rounds of tool calls (worsley.maxToolRounds). Say “go on” to let it continue.`);
        return;
      case "error": {
        let hint = "";
        if (/Couldn't connect/.test(end.message) && settings.isLocal(backend)) {
          hint = " Is the llama.cpp server running?";
        } else if (/\b401\b/.test(end.message)) {
          hint = " Check the API key with “Worsley: Set API Key…”.";
        } else if (/context|too (?:long|many)|exceed/i.test(end.message)) {
          hint = " The thread may be too long for the model: start a new one.";
        }
        notice("error", `${end.message}${hint}`);
        return;
      }
    }
  }

  /**
   * Room was made for the model. A summary took away what the current
   * request may say is "unchanged since an earlier message", so that is
   * sent again in full, and so is everything after.
   */
  private madeRoom(compaction: Compaction): void {
    const what = [
      compaction.cleared > 0 && `cleared ${plural(compaction.cleared, "earlier tool result")}`,
      compaction.summarized && "replaced the conversation before this request with a summary",
    ].filter(Boolean);
    if (compaction.summarized) {
      this.sent.clear();
      const last = this.messages.map((m) => m.role).lastIndexOf("user");
      const message = this.messages[last];
      if (this.recompose !== undefined && message?.role === "user") {
        message.content = this.recompose();
      }
    }
    if (what.length > 0) {
      this.add<"notice">({
        kind: "notice",
        level: "info",
        text: `Made room in the conversation for the model (about ${kilo(compaction.before)} → ${kilo(compaction.after)} tokens): ${what.join(", and ")}. It can read again whatever it needs.`,
      });
    }
  }

  private toolContext(ws: EditorWorkspace, mode: Mode, signal: AbortSignal): ToolContext {
    return {
      workspace: ws,
      ui: this.toolUi(ws),
      mode,
      signal,
      commandTimeoutMs: settings.commandTimeoutMs(),
      preapproved: (command) => command === settings.testCommand() || allowedBy(this.allowedCommands, command),
      seen: this.seen,
    };
  }

  /** What runs without asking in this workspace, besides the test command. */
  get allowedCommands(): CommandRules {
    return {
      exact: this.deps.state.get<string[]>(ALLOWED_KEY) ?? [],
      prefixes: this.deps.state.get<string[][]>(PREFIXES_KEY) ?? [],
    };
  }

  async setAllowedCommands(rules: CommandRules): Promise<void> {
    await this.deps.state.update(ALLOWED_KEY, rules.exact);
    await this.deps.state.update(PREFIXES_KEY, rules.prefixes);
  }

  private toolUi(ws: EditorWorkspace): ToolUi {
    return {
      showLocations: async (title, places) => {
        const item = this.add<"locations">({ kind: "locations", title, locations: await locationViews(ws, places) });
        this.locations.set(item.id, places);
        this.deps.highlighter.set(places.map((p) => ({ uri: ws.uri(p.path), start: p.start, end: p.end })));
      },
      presentTour: (plan) => {
        this.tour = { plan, current: -1, explained: new Map() };
        this.tourToStart = true;
        this.postTour();
      },
      approveCommand: (command, signal) => this.askApproval(command, signal),
    };
  }

  private askApproval(command: string, signal: AbortSignal): Promise<Approval> {
    const { scopes, suggested } = scopesFor(command, this.allowedCommands);
    const item = this.add<"approval">({ kind: "approval", command, status: "pending", scopes: scopes.map((s) => s.label), scope: suggested });
    // "Running …", which is true again once the command is allowed.
    const running = this.status;
    this.setStatus("Waiting for you to approve a command…");
    return new Promise((resolve) => {
      const settle = (decision: Approval, scope?: number): void => {
        this.approvals.delete(item.id);
        signal.removeEventListener("abort", onAbort);
        item.status = decision === "deny" ? "denied" : "approved";
        if (decision !== "deny") {
          this.setStatus(running);
        }
        const chosen = decision === "always" ? (scopes[scope ?? suggested] ?? scopes[suggested]) : undefined;
        if (chosen === undefined) {
          this.update(item, true);
          resolve(decision);
          return;
        }
        item.allowed = chosen.label;
        this.update(item, true);
        // Stored before the command runs, so the model's next call finds it.
        const stored = this.setAllowedCommands(withRules(this.allowedCommands, chosen.rules));
        void stored.then(
          () => resolve(decision),
          () => resolve(decision),
        );
      };
      const onAbort = (): void => settle("deny");
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(item.id, settle);
    });
  }

  // ---- Posting to the panel

  private post(message: HostMessage): void {
    this.emitter.fire(message);
  }

  private add<K extends Item["kind"]>(fields: NewItem<K>): ItemOf<K> {
    const item = { ...fields, id: `i${this.nextId++}` } as unknown as ItemOf<K>;
    this.items.push(item);
    this.flush();
    this.post({ type: "item", item: { ...item } });
    return item;
  }

  private update(item: Item, now = false): void {
    this.pending.set(item.id, item);
    if (now) {
      this.flush();
    } else {
      this.flushTimer ??= setTimeout(() => this.flush(), UPDATE_MS);
    }
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const item of this.pending.values()) {
      this.post({ type: "item", item: { ...item } });
    }
    this.pending.clear();
  }

  private setBusy(busy: boolean, status: string): void {
    this.busy = busy;
    this.status = status;
    void vscode.commands.executeCommand("setContext", "worsley.busy", busy);
    this.post({ type: "busy", busy, status });
  }

  private setStatus(status: string): void {
    if (this.busy && status !== this.status) {
      this.status = status;
      this.post({ type: "busy", busy: true, status });
    }
  }

  private postTour(): void {
    this.post({ type: "tour", tour: this.tourView() });
  }

  private postContext(): void {
    const chips = contextChips(this.deps.tracker.snapshot(), { maxFileLines: settings.maxFileLines(), excluded: this.excluded });
    this.post({ type: "context", chips });
  }

  private postBackend(): void {
    const backend = settings.activeBackend();
    if (backend === undefined) {
      this.post({ type: "backend", label: "No model set up", tooltip: "Add a backend to worsley.backends" });
      return;
    }
    this.post({ type: "backend", label: `${backend.model} · ${backend.name}`, tooltip: `${backend.baseUrl}\nClick to choose another model.` });
  }
}

interface Totals {
  rounds: number;
  /** The context the last turn used, prompt and reply together. */
  context?: number;
  cached?: number;
  generated: number;
  speed?: number;
  cost: number;
}

function addUsage(totals: Totals, usage: Usage | undefined): void {
  if (usage === undefined) {
    return;
  }
  if (usage.promptTokens !== undefined) {
    totals.context = usage.promptTokens + (usage.completionTokens ?? 0);
  }
  totals.generated += usage.completionTokens ?? 0;
  if (usage.tokensPerSecond !== undefined) {
    totals.speed = usage.tokensPerSecond;
  }
  totals.cost += usage.cost ?? 0;
}

function formatStats(totals: Totals, ms: number, window: number | undefined): string {
  const parts = [ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`];
  if (totals.rounds > 1) {
    parts.push(`${totals.rounds} rounds`);
  }
  if (totals.context !== undefined) {
    parts.push(window !== undefined ? `${kilo(totals.context)} of ${kilo(window)} context` : `${kilo(totals.context)} context`);
  }
  if (totals.generated > 0) {
    parts.push(`${kilo(totals.generated)} generated`);
  }
  if (totals.speed !== undefined) {
    parts.push(`${totals.speed.toFixed(1)} tok/s`);
  }
  if (totals.cost > 0) {
    parts.push(`$${totals.cost < 0.01 ? totals.cost.toFixed(4) : totals.cost.toFixed(2)}`);
  }
  return parts.join(" · ");
}

function kilo(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Each place with the first few lines of its range, indentation trimmed. */
async function locationViews(ws: EditorWorkspace, places: readonly Place[]): Promise<LocationView[]> {
  const files = new Map<string, string[]>();
  const views: LocationView[] = [];
  for (const place of places) {
    let lines = files.get(place.path);
    if (lines === undefined) {
      lines = splitLines(await ws.readText(place.path).catch(() => ""));
      files.set(place.path, lines);
    }
    const shown = lines.slice(place.start - 1, Math.min(place.end, place.start + 2));
    const indent = Math.min(...shown.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)?.[0].length ?? 0));
    views.push({
      href: formatHref(place),
      label: labelRef(place),
      note: place.note,
      preview: shown.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n"),
    });
  }
  return views;
}

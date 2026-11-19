import * as path from "node:path";
import * as vscode from "vscode";
import { runAgent, type AgentEnd, type AgentHooks } from "../core/agent";
import { chatTurn, contextWindowOf, type ChatMessage, type Endpoint, type ToolCall, type Turn, type Usage } from "../core/chat";
import { allowedBy, scopesFor, withRules, type CommandRules } from "../core/commandLine";
import { TokenGauge, withRoom, type Compaction } from "../core/compact";
import { contextChips, formatContext, rangeText } from "../core/context";
import { errorText } from "../core/errorText";
import { numberLines, splitLines, summarizeFiles } from "../core/files";
import {
  docStart,
  excerptEnd,
  functionAt,
  functionName,
  hasBody,
  keepsLines,
  mergeRanges,
  pythonFunctionAt,
  testAround,
  type Excerpt,
  type LineRange,
} from "../core/functions";
import { isGitRepo, uncommittedChanges, uncommittedDiff } from "../core/git";
import { ALL_FEATURES, notAtLevel, sectionsAt } from "../core/levels";
import { foldersOf, formatHref, labelRef, parseCodeRef, resolvePath, type CodeRef } from "../core/links";
import { workspacePath } from "../core/paths";
import { reviewRequest, reviewTitle, systemPrompt, tourStepRequest, userRequest, WALK_CHANGES } from "../core/prompts";
import { interrupted, parseSaved, type SavedThread } from "../core/saved";
import { search } from "../core/search";
import {
  CHECK_SYSTEM,
  checkRequest,
  codeIn,
  dedent,
  EXPLAIN_SYSTEM,
  explainRequest,
  FILL_SYSTEM,
  fillRequest,
  indentUnit,
  languageName,
  reindent,
  selectedLines,
  TRANSLATE_SYSTEM,
  translateRequest,
  type LineSpan,
} from "../core/standalone";
import { TOOLS, type OutlineEntry, type Place, type ToolContext, type ToolUi, type TourPlan } from "../core/tools";
import type { Approval, ChangedFile, Feature, HostMessage, Item, LinkStatus, LocationView, Mode, Standalone, TourView } from "../protocol";
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
/** The thread is kept this long after it last changed, so that a burst of changes is written once. */
const SAVE_MS = 500;
/** The most lines of tests that go with a function to check or fill in. */
const MAX_TEST_LINES = 300;

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
  /** Where the thread is kept between windows; none without a workspace. */
  store: ThreadStore | undefined;
}

/** Holds a thread as text; saving undefined clears it. */
export interface ThreadStore {
  load(): string | undefined;
  save(text: string | undefined): void;
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
  private saveTimer: NodeJS.Timeout | undefined;
  private warnedSave = false;
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
        if (e.affectsConfiguration("worsley.level")) {
          this.postLevel();
          this.postTour();
        }
      }),
    ];
    this.postLevel();
    const saved = deps.store?.load();
    const thread = saved === undefined ? undefined : parseSaved(saved);
    if (thread !== undefined) {
      this.restore(thread);
    }
  }

  dispose(): void {
    // Before the request stops, so that the next window has it as it is now.
    this.save();
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
    this.postLevel();
  }

  /** Whether Worsley's level offers `feature`. If not, a notice in the thread says so. */
  offers(feature: Feature): boolean {
    if (settings.features().has(feature)) {
      return true;
    }
    this.add<"notice">({ kind: "notice", level: "info", text: notAtLevel(feature, settings.level()) });
    return false;
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

  /**
   * `prompt`, when given, is what the model is asked, in place of `text`,
   * which the panel shows. `feature` is what the level must offer: the mode,
   * unless the request is for a tour or a review.
   */
  async send(text: string, mode: Mode, prompt?: string, feature: Feature = mode): Promise<void> {
    const request = text.trim();
    if (request === "" || !this.offers(feature)) {
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
      // As the request is made, whatever the user looks at while it waits.
      const files = this.deps.tracker.snapshot();
      if (mode === "change" && !(await this.confirmUncommitted(ws))) {
        this.post({ type: "focus", mode, text: request });
        return;
      }
      if (this.messages.length === 0) {
        this.messages.push({ role: "system", content: await this.systemPrompt(ws) });
      }
      const maxFileLines = settings.maxFileLines();
      const included = contextChips(files, { maxFileLines, excluded: this.excluded })
        .filter((chip) => !chip.excluded)
        .map((chip) => chip.label);
      this.add<"user">({ kind: "user", mode, text: request, context: included });
      if (mode === "change") {
        await this.prepareChange(ws);
      }
      const position = this.tour !== undefined && this.tour.current >= 0 ? { plan: this.tour.plan, index: this.tour.current } : undefined;
      this.recompose = () => userRequest(mode, prompt ?? request, formatContext(files, { maxFileLines, excluded: this.excluded, sent: this.sent }), position);
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
    this.lastChanges = [];
    this.warnedGit = false;
    this.locations.clear();
    this.pending.clear();
    this.deps.highlighter.clear();
    this.save();
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

  /**
   * An Ask request for a light review of the user's uncommitted changes, to
   * the file in the editor or to all the workspace's files: whether they
   * call for other changes, or have implications worth knowing.
   */
  async reviewChanges(scope: "file" | "all"): Promise<void> {
    const feature = scope === "file" ? "reviewFile" : "reviewAll";
    if (!this.offers(feature)) {
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
    let file: string | undefined;
    if (scope === "file") {
      const uri = vscode.window.activeTextEditor?.document.uri;
      file = uri?.scheme === "file" ? workspacePath(ws.root, uri.fsPath) : undefined;
      if (file === undefined) {
        this.add<"notice">({ kind: "notice", level: "info", text: "Open the file whose changes to review in the editor first." });
        return;
      }
    }
    const diff = await uncommittedDiff(ws.root, file);
    if (diff === undefined) {
      this.add<"notice">({
        kind: "notice",
        level: "info",
        text: "This folder isn't in a git repository, so Worsley can't tell what you have changed: a review looks at what has changed since the last commit.",
      });
      return;
    }
    if (diff.trim() === "") {
      this.add<"notice">({ kind: "notice", level: "info", text: file !== undefined ? `There are no uncommitted changes to ${file}.` : "There are no uncommitted changes in this workspace." });
      return;
    }
    const unsaved = this.unsavedDocuments(ws)
      .map((doc) => workspacePath(ws.root, doc.uri.fsPath) ?? doc.uri.fsPath)
      .filter((path) => file === undefined || path === file);
    if (unsaved.length > 0) {
      this.add<"notice">({ kind: "notice", level: "info", text: `Not saved, so not in the review: ${unsaved.join(", ")}.` });
    }
    await this.send(reviewTitle(file), "ask", reviewRequest(file, diff), feature);
  }

  async walkChanges(): Promise<void> {
    if (this.lastChanges.length > 0) {
      await this.send(WALK_CHANGES, "ask", undefined, "tour");
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
    if (!explained && (this.busy || !this.offers("tour"))) {
      return;
    }
    tour.current = index;
    this.postTour();
    this.scheduleSave();
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
    this.scheduleSave();
  }

  /** The tour as the panel shows it; none at a level without tours, though it is kept for one with them. */
  private tourView(): TourView | undefined {
    const tour = this.tour;
    if (tour === undefined || !settings.features().has("tour")) {
      return undefined;
    }
    return {
      title: tour.plan.title,
      current: tour.current,
      steps: tour.plan.steps.map((step, i) => ({ title: step.title, href: formatHref(step), itemId: tour.explained.get(i) })),
    };
  }

  // ---- Requests that stand alone

  /**
   * Explains the line the cursor is on, or that the selection is part of,
   * on its own: the model sees that line and its language, and nothing else.
   */
  async explainLine(): Promise<void> {
    const editor = this.standaloneEditor("explain");
    if (editor === undefined) {
      return;
    }
    const doc = editor.document;
    const span = selectedLines(editor.selection.start, editor.selection.end);
    if (span.last !== span.first) {
      this.add<"notice">({ kind: "notice", level: "info", text: "Explain Line explains one line at a time. Put the cursor on the line to explain, or select part of it." });
      return;
    }
    const line = doc.lineAt(span.first).text.trim();
    if (line === "") {
      this.add<"notice">({ kind: "notice", level: "info", text: "That line is empty. Put the cursor on a line of code to explain it." });
      return;
    }
    const selected = editor.selection.isEmpty ? "" : doc.getText(editor.selection).trim();
    const part = selected !== "" && selected !== line ? selected : undefined;
    await this.whileBusy(async () => {
      await this.standalone("explain", {
        text: line,
        context: [`${fileName(doc)}:${span.first + 1}`],
        system: EXPLAIN_SYSTEM,
        prompt: explainRequest(line, languageName(doc.languageId), part),
      });
    });
  }

  /**
   * Translates the selected lines, or the cursor's line, from the student's
   * pseudocode into the language of the file, and puts the translation in
   * their place. The model sees those lines and nothing else, so it has
   * nothing to add to them from.
   */
  async translate(): Promise<void> {
    const editor = this.standaloneEditor("translate");
    if (editor === undefined) {
      return;
    }
    const doc = editor.document;
    const language = languageName(doc.languageId);
    if (language === undefined) {
      this.add<"notice">({
        kind: "notice",
        level: "info",
        text: `Translate writes code in the language of the file the lines are in, and ${fileName(doc)} isn't in a programming language. Write them in a file of the language to translate into, such as a .py file.`,
      });
      return;
    }
    const span = selectedLines(editor.selection.start, editor.selection.end);
    const lines: string[] = [];
    for (let n = span.first; n <= span.last; n++) {
      lines.push(doc.lineAt(n).text);
    }
    if (lines.every((line) => line.trim() === "")) {
      this.add<"notice">({ kind: "notice", level: "info", text: "There is nothing there to translate. Select the lines to translate." });
      return;
    }
    // Sent without the indentation they share, which the translation gets back.
    const { lines: bare, indent } = dedent(lines);
    const block = bare.join("\n");
    const version = doc.version;
    await this.whileBusy(async () => {
      const reply = await this.standalone("translate", {
        text: block,
        context: [`${fileName(doc)}:${rangeText({ start: span.first + 1, end: span.last + 1 })}`],
        system: TRANSLATE_SYSTEM,
        prompt: translateRequest(block, language, indentOf(editor)),
      });
      if (reply === undefined) {
        return;
      }
      await this.putCode(doc, { span, version, lines, indent }, reply, {
        none: "The reply has no code to put in the editor, so your lines are as you wrote them.",
        same: "The translation is what you wrote already, so the editor is unchanged.",
        what: "the translation",
        done: (where) => `Put the translation in ${where}, in place of your lines. Undo in the editor brings them back.`,
      });
    });
  }

  /**
   * Checks the function the cursor is in against its documentation and the
   * tests that call it: whether they fit together, or the code contradicts
   * them, or does what neither mentions. The model sees the function and
   * its tests, and nothing else.
   */
  async checkFunction(): Promise<void> {
    const editor = this.standaloneEditor("check");
    if (editor === undefined) {
      return;
    }
    await this.whileBusy(async () => {
      const found = await this.functionAndTests(editor);
      if (found === undefined) {
        return;
      }
      const { fn, tests, header, language } = found;
      await this.standalone("check", {
        text: header,
        context: [fn, ...tests].map(excerptLabel),
        system: CHECK_SYSTEM,
        prompt: checkRequest(fn, tests, language),
      });
    });
  }

  /**
   * Writes the body of the function the cursor is in from its documentation
   * and the tests that call it, and puts it in place of the placeholder
   * there. The model sees the function and its tests, and nothing else; the
   * header, the documentation and any other line of the function must come
   * back as they were, or the function is left alone.
   */
  async fillFunction(): Promise<void> {
    const editor = this.standaloneEditor("fill");
    if (editor === undefined) {
      return;
    }
    const doc = editor.document;
    const version = doc.version;
    await this.whileBusy(async () => {
      const found = await this.functionAndTests(editor, (fn, name) =>
        hasBody(fn.lines)
          ? `${name} has a body already. Fill In writes the body of a function that has only its header, its documentation and tests, and perhaps a placeholder such as pass.`
          : undefined,
      );
      if (found === undefined) {
        return;
      }
      const { fn, name, tests, header, language } = found;
      if (tests.length === 0) {
        this.add<"notice">({
          kind: "notice",
          level: "info",
          text: `No tests that call ${name} were found, and Fill In writes a body from its documentation and its tests. Write some tests that call it first: Translate can turn tests written in pseudocode into code.`,
        });
        return;
      }
      const { lines: bare, indent } = dedent(fn.lines);
      const reply = await this.standalone("fill", {
        text: header,
        context: [fn, ...tests].map(excerptLabel),
        system: FILL_SYSTEM,
        prompt: fillRequest({ ...fn, lines: bare }, tests, language, indentOf(editor)),
      });
      if (reply === undefined) {
        return;
      }
      const span = { first: fn.start - 1, last: excerptEnd(fn) - 1 };
      await this.putCode(doc, { span, version, lines: fn.lines, indent }, reply, {
        none: `Nothing was filled in, so ${name} is as it was.`,
        same: `Nothing was filled in, so ${name} is as it was.`,
        what: `the body of ${name}`,
        check: (written) => (keepsLines(fn.lines, written) ? undefined : `The reply changes ${name}'s header or documentation, so it isn't in the editor. Copy the body from here instead.`),
        done: (where) => `Filled in ${name} in ${where}. Undo in the editor brings back what was there.`,
      });
    });
  }

  /**
   * The editor a request that stands alone is about. Undefined, with a
   * notice saying why, when the request can't be made now.
   */
  private standaloneEditor(request: Standalone): vscode.TextEditor | undefined {
    if (!this.offers(request)) {
      return undefined;
    }
    if (this.busy) {
      void vscode.window.showInformationMessage("Worsley is still working on the last request. Wait for it, or stop it.");
      return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || (editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "untitled")) {
      const what: Record<Standalone, string> = {
        explain: "put the cursor on the line to explain",
        translate: "select the lines to translate",
        check: "put the cursor in the function to check",
        fill: "put the cursor in the function to fill in",
      };
      this.add<"notice">({ kind: "notice", level: "info", text: `In the editor, ${what[request]} first.` });
      return undefined;
    }
    return editor;
  }

  /**
   * The function the cursor is in, or that is selected, with the comments
   * and decorators above it, and the tests that call it. `refuse` says why
   * the request can't go ahead with this function, if it can't. Undefined,
   * with a notice saying why, when there is no function there, or it was
   * refused.
   */
  private async functionAndTests(
    editor: vscode.TextEditor,
    refuse?: (fn: Excerpt, name: string) => string | undefined,
  ): Promise<{ fn: Excerpt; name: string; header: string; tests: Excerpt[]; language: string } | undefined> {
    const notice = (text: string): undefined => {
      this.add<"notice">({ kind: "notice", level: "info", text });
      return undefined;
    };
    const doc = editor.document;
    const ws = this.currentWorkspace();
    const path = ws !== undefined && doc.uri.scheme === "file" ? workspacePath(ws.root, doc.uri.fsPath) : undefined;
    if (ws === undefined || path === undefined) {
      return notice("This works on a function in a file of the workspace folder, where Worsley can find its tests. Open the folder, or save the file in it.");
    }
    const language = languageName(doc.languageId);
    if (language === undefined) {
      return notice(`${fileName(doc)} isn't in a programming language, so it has no functions to work on.`);
    }
    this.setStatus("Finding the function…");
    const lines = splitLines(doc.getText());
    const span = selectedLines(editor.selection.start, editor.selection.end);
    let found: { start: number; end: number; name?: string } | undefined;
    if (span.last > span.first) {
      found = { start: span.first + 1, end: span.last + 1 };
    } else {
      const outline = await ws.outline(path).catch(() => undefined);
      found = (outline !== undefined ? functionAt(outline, editor.selection.active.line + 1) : undefined) ?? pythonFunctionAt(lines, editor.selection.active.line + 1);
    }
    if (found === undefined) {
      return notice("Put the cursor in a function, or select the whole of one, and try again.");
    }
    const start = docStart(lines, found.start);
    const fn: Excerpt = { path, start, lines: lines.slice(start - 1, found.end) };
    // The header: the first line of the function that isn't a comment or a decorator.
    const headerLine = lines.findIndex((line, i) => i >= found.start - 1 && i < found.end && line.trim() !== "" && !/^(?:#|\/\/|\/\*|\*|--|;|@)/.test(line.trim())) + 1;
    const header = (lines[headerLine - 1] ?? "").trim();
    const name = found.name !== undefined && /^[A-Za-z_$][\w$]*$/.test(found.name) ? found.name : functionName(header);
    if (name === undefined) {
      return notice("Worsley couldn't tell that function's name, which it needs to find the tests that call it.");
    }
    const refused = refuse?.(fn, name);
    if (refused !== undefined) {
      return notice(refused);
    }
    this.setStatus(`Finding the tests that call ${name}…`);
    const column = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).exec(lines[headerLine - 1] ?? "")?.index;
    const tests = await this.testsOf(ws, { path, start, end: found.end }, name, column === undefined ? undefined : { line: headerLine, character: column });
    return { fn, name, header, tests, language };
  }

  /**
   * The tests that call a function: each test function, or line of tests,
   * that the language server's references or a search for calls by name
   * find, in a test file or a test function. At most MAX_TEST_LINES of them.
   */
  private async testsOf(ws: EditorWorkspace, fn: LineRange, name: string, at: { line: number; character: number } | undefined): Promise<Excerpt[]> {
    const places = at === undefined ? [] : await ws.references(fn.path, at.line, at.character).catch(() => []);
    // ripgrep's regular expressions have no lookbehind, so a word boundary marks where the name starts.
    const pattern = `${/^\w/.test(name) ? "\\b" : ""}${escapeRegExp(name)}\\s*\\(`;
    const calls = await search(ws.root, { pattern, literal: false, caseSensitive: true, limit: 300 }, () => ws.listFiles(), ws.ripgrep, AbortSignal.timeout(20_000)).catch(() => ({ matches: [] }));
    places.push(...calls.matches.map((m) => ({ path: m.path, start: m.line, end: m.line })));
    const files = new Map<string, { lines: string[]; outline: OutlineEntry[] | undefined } | undefined>();
    const ranges: LineRange[] = [];
    for (const place of places) {
      if (place.path.startsWith("/") || (place.path === fn.path && place.start >= fn.start && place.start <= fn.end)) {
        continue;
      }
      if (!files.has(place.path)) {
        const text = await ws.readText(place.path).catch(() => undefined);
        files.set(place.path, text === undefined ? undefined : { lines: splitLines(text), outline: await ws.outline(place.path).catch(() => undefined) });
      }
      const file = files.get(place.path);
      const range = file === undefined ? undefined : testAround(file.lines, file.outline, place.path, place.start);
      if (range !== undefined) {
        ranges.push(range);
      }
    }
    const tests: Excerpt[] = [];
    let total = 0;
    for (const range of mergeRanges(ranges)) {
      const lines = files.get(range.path)?.lines.slice(range.start - 1, range.end) ?? [];
      if (total + lines.length > MAX_TEST_LINES) {
        break;
      }
      total += lines.length;
      tests.push({ path: range.path, start: range.start, lines });
    }
    return tests;
  }

  /**
   * Asks a request that stands alone: its own system prompt and one message,
   * for one reply. The thread the model sees for Ask and Change is left as it
   * is, so nothing in it reaches the model, and nothing from here joins it.
   * `context` is where the code the request is about comes from, as the
   * panel shows it. The reply, once it is complete; undefined when there is
   * none.
   */
  private async standalone(request: Standalone, ask: { text: string; context: string[]; system: string; prompt: string }): Promise<string | undefined> {
    this.add<"user">({ kind: "user", mode: request, text: ask.text, context: ask.context });
    const connection = await this.connect("ask");
    if (connection === undefined) {
      return undefined;
    }
    const { backend, endpoint, window } = connection;
    const controller = new AbortController();
    this.controller = controller;
    const started = Date.now();
    let reply: ItemOf<"assistant"> | undefined;
    const item = (): ItemOf<"assistant"> => (reply ??= this.add<"assistant">({ kind: "assistant", text: "", reasoning: "", streaming: true }));
    this.setStatus(`Waiting for ${backend.model}…`);
    let turn: Turn | undefined;
    let end: AgentEnd;
    try {
      turn = await chatTurn(
        endpoint,
        [
          { role: "system", content: ask.system },
          { role: "user", content: ask.prompt },
        ],
        [],
        {
          content: (delta) => {
            const r = item();
            r.text += delta;
            this.update(r);
            this.setStatus("Writing…");
          },
          reasoning: (delta) => {
            const r = item();
            r.reasoning += delta;
            this.update(r);
            this.setStatus("Thinking…");
          },
          status: (text) => this.setStatus(text),
        },
        controller.signal,
      );
      end = { reason: "done", finish: turn.finishReason };
    } catch (err) {
      end = controller.signal.aborted ? { reason: "aborted" } : { reason: "error", message: errorText(err) };
    } finally {
      this.controller = undefined;
    }
    const written = reply as ItemOf<"assistant"> | undefined;
    if (written !== undefined) {
      written.streaming = false;
      if (turn !== undefined) {
        const totals: Totals = { rounds: 1, generated: 0, cost: 0 };
        addUsage(totals, turn.usage);
        written.stats = formatStats(totals, Date.now() - started, window());
      }
      this.update(written, true);
    }
    this.report(end, backend, turn !== undefined && turn.content.trim() !== "");
    return end.reason === "done" ? turn?.content : undefined;
  }

  /**
   * Puts the code in a reply in place of the lines it was made from, if they
   * are still as they were and `says.check` finds nothing wrong with it. Undo
   * in the editor brings the lines back. A notice says what happened, in the
   * words `says` gives.
   */
  private async putCode(
    doc: vscode.TextDocument,
    from: { span: LineSpan; version: number; lines: string[]; indent: string },
    reply: string,
    says: { none: string; same: string; what: string; done(where: string): string; check?(written: string[]): string | undefined },
  ): Promise<void> {
    const notice = (level: "info" | "warning", text: string): void => {
      this.add<"notice">({ kind: "notice", level, text });
    };
    const code = codeIn(reply);
    const written = code === undefined ? [] : reindent(code, from.indent);
    if (written.every((line) => line === "")) {
      notice("info", says.none);
      return;
    }
    if (written.join("\n") === from.lines.map((line) => line.replace(/[ \t]+$/, "")).join("\n")) {
      notice("info", says.same);
      return;
    }
    const wrong = says.check?.(written);
    if (wrong !== undefined) {
      notice("warning", wrong);
      return;
    }
    if (doc.isClosed || doc.version !== from.version) {
      notice("warning", `${fileName(doc)} changed while Worsley was working, so ${says.what} isn't in it. Copy it from here instead.`);
      return;
    }
    const { first, last } = from.span;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(first, 0, last, doc.lineAt(last).text.length), written.join(doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
    if (!(await vscode.workspace.applyEdit(edit))) {
      notice("warning", `Couldn't put ${says.what} in ${fileName(doc)}. Copy it from here instead.`);
      return;
    }
    const lines = { start: first + 1, end: first + written.length };
    this.deps.highlighter.set([{ uri: doc.uri, ...lines }]);
    notice("info", says.done(`${fileName(doc)}, at ${lines.start === lines.end ? `line ${lines.start}` : `lines ${rangeText(lines)}`}`));
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
      this.scheduleSave();
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

  /** Files in the workspace with edits that aren't saved. */
  private unsavedDocuments(ws: EditorWorkspace): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter((doc) => doc.isDirty && doc.uri.scheme === "file" && workspacePath(ws.root, doc.uri.fsPath) !== undefined);
  }

  /**
   * Whether a Change request goes ahead. When something isn't committed,
   * git would show it mixed in with this change, so the user decides.
   */
  private async confirmUncommitted(ws: EditorWorkspace): Promise<boolean> {
    const files = await uncommittedChanges(ws.root);
    const unsaved = this.unsavedDocuments(ws).map((doc) => workspacePath(ws.root, doc.uri.fsPath) ?? doc.uri.fsPath);
    if (files === undefined || (files.length === 0 && unsaved.length === 0)) {
      return true;
    }
    const item = this.add<"uncommitted">({ kind: "uncommitted", files, unsaved, status: "pending" });
    this.setStatus("Waiting for you to confirm…");
    const controller = new AbortController();
    this.controller = controller;
    const send = await new Promise<boolean>((resolve) => {
      const settle = (decision: Approval): void => {
        this.approvals.delete(item.id);
        resolve(decision !== "deny");
      };
      controller.signal.addEventListener("abort", () => settle("deny"), { once: true });
      this.approvals.set(item.id, settle);
    });
    this.controller = undefined;
    item.status = send ? "sent" : "cancelled";
    this.update(item, true);
    return send;
  }

  /** Saves what the tests should see, and says when git can't show the change. */
  private async prepareChange(ws: EditorWorkspace): Promise<void> {
    const dirty = this.unsavedDocuments(ws);
    if (dirty.length > 0) {
      await Promise.all(dirty.map((doc) => doc.save()));
      this.add<"notice">({ kind: "notice", level: "info", text: `Saved ${plural(dirty.length, "file")} with unsaved changes first, so that the tests run on what you see.` });
    }
    if (!this.warnedGit && !(await isGitRepo(ws.root))) {
      this.warnedGit = true;
      this.add<"notice">({ kind: "notice", level: "warning", text: "This folder isn't in a git repository, so you can't review or undo Worsley's changes with git." });
    }
  }

  /**
   * The backend in use, ready for a request in `mode`, with its model's
   * context window once known. Undefined, with a notice saying why, when it
   * can't be used.
   */
  private async connect(mode: Mode): Promise<Connection | undefined> {
    const backend = settings.activeBackend();
    if (backend === undefined) {
      this.add<"notice">({ kind: "notice", level: "error", text: "No backend is set up: add one to worsley.backends in your settings." });
      return undefined;
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
    if (endpoint.apiKey === undefined && settings.needsKey(backend)) {
      const where = backend.apiKeyEnv !== undefined ? `, or set ${backend.apiKeyEnv} in the environment VS Code starts from` : "";
      this.add<"notice">({ kind: "notice", level: "error", text: `${backend.name} needs an API key: run “Worsley: Set API Key…”${where}.` });
      return undefined;
    }
    return { backend, endpoint, windowKey, window: () => backend.contextTokens ?? this.windows.get(windowKey) };
  }

  /** Runs the model on the thread until it answers. Whether it said anything. */
  private async run(ws: EditorWorkspace, mode: Mode): Promise<boolean> {
    const connection = await this.connect(mode);
    if (connection === undefined) {
      return false;
    }
    const { backend, endpoint, windowKey, window } = connection;

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
        if (/Couldn't connect/.test(end.message)) {
          hint = settings.isLocal(backend)
            ? " Is the llama.cpp server running?"
            : ` Is ${backend.name} up, and reachable from here? “Worsley: Choose Model…” switches to another backend.`;
        } else if (/\b40[13]\b/.test(end.message)) {
          hint = " Check the API key with “Worsley: Set API Key…”.";
          void vscode.window.showErrorMessage(`Worsley: ${backend.name} turned the request away. It may need an API key, or another one.`, "Set API Key…").then((choice) => {
            if (choice !== undefined) {
              void settings.askForKey(backend, this.deps.secrets);
            }
          });
        } else if (/context|too (?:long|many)|exceed/i.test(end.message)) {
          hint = " The thread may be too long for the model: start a new one.";
        }
        // The server's own message may not end a sentence.
        const message = /[.!?)]$/.test(end.message.trim()) ? end.message.trim() : `${end.message.trim()}.`;
        notice("error", `${message}${hint}`);
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

  // ---- Keeping the thread between windows

  /** The thread as it is kept; in the middle of a request, as a stop would leave it. */
  private saved(): SavedThread {
    const tour = this.tour;
    const thread: SavedThread = {
      version: 1,
      items: this.items,
      messages: this.messages,
      tour: tour === undefined ? undefined : { plan: tour.plan, current: tour.current, explained: [...tour.explained] },
      seen: [...this.seen],
      sent: [...this.sent],
      lastChanges: this.lastChanges,
      warnedGit: this.warnedGit,
      locations: [...this.locations],
      nextId: this.nextId,
    };
    return this.busy ? interrupted(thread) : thread;
  }

  private restore(thread: SavedThread): void {
    this.items = thread.items;
    this.messages = thread.messages;
    this.tour = thread.tour === undefined ? undefined : { plan: thread.tour.plan, current: thread.tour.current, explained: new Map(thread.tour.explained) };
    this.seen = new Set(thread.seen);
    this.sent = new Map(thread.sent);
    this.lastChanges = thread.lastChanges;
    this.warnedGit = thread.warnedGit;
    for (const [id, places] of thread.locations) {
      this.locations.set(id, places);
    }
    this.nextId = thread.nextId;
  }

  /** Once the thread has been still for a moment, unless a request is running. */
  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (!this.busy) {
        this.save();
      }
    }, SAVE_MS);
  }

  /** An empty thread leaves nothing behind. */
  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const store = this.deps.store;
    if (store === undefined) {
      return;
    }
    try {
      store.save(this.items.length === 0 && this.messages.length === 0 ? undefined : JSON.stringify(this.saved()));
    } catch (err) {
      if (!this.warnedSave) {
        this.warnedSave = true;
        void vscode.window.showWarningMessage(`Worsley couldn't keep the thread for the next window: ${errorText(err)}`);
      }
    }
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

  /** The level, to the panel, and to the `worsley.feature.*` context keys that menus and keybindings depend on. */
  private postLevel(): void {
    const offered = settings.features();
    for (const feature of ALL_FEATURES) {
      void vscode.commands.executeCommand("setContext", `worsley.feature.${feature}`, offered.has(feature));
    }
    const level = settings.level();
    this.post({ type: "level", level, features: [...offered], sections: sectionsAt(level) });
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

/** The backend a request goes to, and its model's context window, once known. */
interface Connection {
  backend: settings.Backend;
  endpoint: Endpoint;
  /** The server and model, which the window is known by. */
  windowKey: string;
  window(): number | undefined;
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

/** A document's file name, as the panel shows it: `cart.py`, or `Untitled-1`. */
function fileName(doc: vscode.TextDocument): string {
  return path.basename(doc.uri.path);
}

/** Lines of a file as the panel shows them: `cart.py:3-9`. */
function excerptLabel(excerpt: Excerpt): string {
  return `${path.basename(excerpt.path)}:${rangeText({ start: excerpt.start, end: excerptEnd(excerpt) })}`;
}

/** How the editor indents, as code written for it should. */
function indentOf(editor: vscode.TextEditor): string {
  return indentUnit(editor.options.insertSpaces !== false, typeof editor.options.tabSize === "number" ? editor.options.tabSize : 4);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

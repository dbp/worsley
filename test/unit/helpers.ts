import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listFiles } from "../../src/core/files";
import { absolutePath } from "../../src/core/paths";
import type { Approval } from "../../src/protocol";
import type { Place, ToolContext, ToolUi, TourPlan, Workspace } from "../../src/core/tools";

/** A fresh folder holding `files`, removed when the process exits. */
export function tempFolder(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worsley-test-"));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The workspace as the tools see it, straight from the disk, with no language support. */
export class DiskWorkspace implements Workspace {
  readonly ripgrep: string | undefined;

  constructor(
    readonly root: string,
    ripgrep?: string,
  ) {
    this.ripgrep = ripgrep;
  }

  listFiles(): Promise<string[]> {
    return listFiles(this.root);
  }

  async exists(relative: string): Promise<"file" | "folder" | undefined> {
    try {
      const stat = await fsp.stat(absolutePath(this.root, relative));
      return stat.isDirectory() ? "folder" : "file";
    } catch {
      return undefined;
    }
  }

  readText(relative: string): Promise<string> {
    return fsp.readFile(absolutePath(this.root, relative), "utf8");
  }

  async writeText(relative: string, text: string): Promise<void> {
    const full = absolutePath(this.root, relative);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, text);
  }
}

/** A panel that records what the tools showed it and answers approvals as told. */
export class RecordingUi implements ToolUi {
  locations: { title: string; places: Place[] }[] = [];
  tours: TourPlan[] = [];
  asked: string[] = [];

  constructor(private readonly answer: Approval = "once") {}

  async showLocations(title: string, places: Place[]): Promise<void> {
    this.locations.push({ title, places });
  }

  presentTour(plan: TourPlan): void {
    this.tours.push(plan);
  }

  async approveCommand(command: string): Promise<Approval> {
    this.asked.push(command);
    return this.answer;
  }
}

export function toolContext(workspace: Workspace, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace,
    ui: new RecordingUi(),
    mode: "change",
    signal: new AbortController().signal,
    commandTimeoutMs: 20_000,
    preapproved: () => false,
    seen: new Set(),
    ...overrides,
  };
}

/** VS Code's own ripgrep, when VS Code is installed where Debian puts it. */
export function installedRipgrep(): string | undefined {
  const candidates = [
    "/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/linux-x64/rg",
    "/usr/share/code/resources/app/node_modules/@vscode/ripgrep/bin/rg",
    "/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

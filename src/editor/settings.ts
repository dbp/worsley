import * as vscode from "vscode";
import { mergeBodies, type Endpoint } from "../core/chat";
import type { Mode } from "../protocol";

/** An entry of `worsley.backends`: one OpenAI-compatible endpoint and the model to use there. */
export interface Backend {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Merged over `extraBody` for Change requests, such as to turn thinking on for them. */
  changeExtraBody?: Record<string, unknown>;
  /** The model's context window in tokens, for a server that doesn't say. */
  contextTokens?: number;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("worsley");
}

function isBackend(value: unknown): value is Backend {
  const b = value as Partial<Backend> | null;
  return typeof b === "object" && b !== null && typeof b.name === "string" && typeof b.baseUrl === "string" && typeof b.model === "string";
}

export function backends(): Backend[] {
  const raw = config().get<unknown[]>("backends");
  return Array.isArray(raw) ? raw.filter(isBackend) : [];
}

/** The backend `worsley.backend` names, or the first if it names none. */
export function activeBackend(): Backend | undefined {
  const name = config().get<string>("backend");
  const all = backends();
  return all.find((b) => b.name === name) ?? all[0];
}

function secretKey(backend: Backend): string {
  return `worsley.apiKey.${backend.name}`;
}

/** The key for a backend: the one stored with Set API Key, or else its `apiKeyEnv` variable's. */
export async function apiKeyFor(backend: Backend, secrets: vscode.SecretStorage): Promise<string | undefined> {
  const stored = await secrets.get(secretKey(backend));
  if (stored !== undefined && stored !== "") {
    return stored;
  }
  const fromEnv = backend.apiKeyEnv !== undefined ? process.env[backend.apiKeyEnv] : undefined;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
}

export async function storeApiKey(backend: Backend, key: string, secrets: vscode.SecretStorage): Promise<void> {
  if (key === "") {
    await secrets.delete(secretKey(backend));
  } else {
    await secrets.store(secretKey(backend), key);
  }
}

export async function endpointFor(backend: Backend, secrets: vscode.SecretStorage, mode: Mode = "ask"): Promise<Endpoint> {
  return {
    baseUrl: backend.baseUrl,
    model: backend.model,
    apiKey: await apiKeyFor(backend, secrets),
    headers: backend.headers,
    extraBody: mode === "change" ? mergeBodies(backend.extraBody, backend.changeExtraBody) : backend.extraBody,
  };
}

/** A server on this machine, which needs no key. */
export function isLocal(backend: Backend): boolean {
  return /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:\/|$)/i.test(backend.baseUrl);
}

/**
 * Makes `name` the backend in use, with `model`. `worsley.backends` can only
 * be in user settings, so that is where the change goes; a list still at
 * its default is copied there first.
 */
export async function chooseBackend(name: string, model: string): Promise<void> {
  const inspected = config().inspect<unknown[]>("backends");
  const list = (inspected?.globalValue ?? inspected?.defaultValue ?? []).filter(isBackend);
  const updated = list.map((b) => (b.name === name ? { ...b, model } : b));
  await config().update("backends", updated, vscode.ConfigurationTarget.Global);
  await config().update("backend", name, vscode.ConfigurationTarget.Global);
}

export function testCommand(): string {
  return (config().get<string>("testCommand") ?? "").trim();
}

export function commandTimeoutMs(): number {
  return Math.max(5, config().get<number>("commandTimeoutSeconds") ?? 600) * 1000;
}

export function maxFileLines(): number {
  return Math.max(0, config().get<number>("context.maxFileLines") ?? 600);
}

export function maxToolRounds(): number {
  return Math.max(1, config().get<number>("maxToolRounds") ?? 60);
}

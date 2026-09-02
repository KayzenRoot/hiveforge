import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { CodexAdapter, CodexLifecycleEvent } from "../core/types";

// Compatibility types mirror the generated protocol from codex-cli 0.152.0.
// Regenerate with:
//   codex app-server generate-ts --out <dir>
//   codex app-server generate-json-schema --out <dir>
interface WireMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CodexProbe {
  available: boolean;
  version: string | null;
  appServer: boolean;
  authentication: string;
  reason?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class CodexAppServerAdapter implements CodexAdapter {
  readonly provider = "codex-app-server" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private requestId = 1;
  private initialized = false;
  private authentication = "UNKNOWN";
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly terminalTurns = new Set<string>();
  private eventHandler: (event: CodexLifecycleEvent) => void = () => undefined;

  constructor(onEvent?: (event: CodexLifecycleEvent) => void) {
    if (onEvent) this.eventHandler = onEvent;
  }

  setEventHandler(handler: (event: CodexLifecycleEvent) => void): void {
    this.eventHandler = handler;
  }

  probe(): CodexProbe {
    try {
      const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
      execFileSync("codex", ["app-server", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      let authentication = this.authentication;
      try {
        const loginResult = spawnSync("codex", ["login", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const loginStatus = (String(loginResult.stdout ?? "") + "\n" + String(loginResult.stderr ?? "")).trim().toLowerCase();
        if (loginStatus.includes("not logged") || loginStatus.includes("not authenticated")) authentication = "NOT_AUTHENTICATED";
        else if (loginStatus.includes("logged in")) authentication = loginStatus.includes("chatgpt") ? "CHATGPT" : "AUTHENTICATED";
      } catch {
        authentication = "NOT_AUTHENTICATED";
      }
      return { available: true, version, appServer: true, authentication };
    } catch (error) {
      return { available: false, version: null, appServer: false, authentication: "UNKNOWN", reason: errorText(error) };
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.initialized) return;
    const probe = this.probe();
    if (!probe.available) throw new Error("Codex App Server is not configured");

    // The installed server defaults to stdio. Keep the invocation aligned with
    // the official CLI lifecycle instead of relying on an undocumented flag.
    this.child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("exit", (code, signal) => {
      this.initialized = false;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.failPending(new Error("Codex App Server exited (" + (code ?? "unknown") + "/" + (signal ?? "no signal") + ")"));
    });

    await this.request("initialize", {
      clientInfo: { name: "hiveforge", title: "HiveForge", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.send({ method: "initialized" });
    this.initialized = true;

    try {
      // account/read is the documented account/auth lifecycle method in the
      // generated protocol. Do not probe the legacy getAuthStatus method.
      const auth = await this.request("account/read", { refreshToken: false });
      const account = asRecord(auth.account);
      if (Object.keys(account).length > 0) {
        this.authentication = String(account.type ?? account.email ?? "AUTHENTICATED").toUpperCase();
      } else {
        this.authentication = auth.requiresOpenaiAuth === true ? "NOT_AUTHENTICATED" : "UNKNOWN";
      }
    } catch {
      this.authentication = "UNKNOWN";
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: WireMessage;
    try {
      message = JSON.parse(line) as WireMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex App Server request failed"));
      else pending.resolve(asRecord(message.result));
      return;
    }

    const params = message.params ?? {};
    if (message.method === "turn/completed") {
      const turn = asRecord(params.turn);
      const threadId = typeof params.threadId === "string" ? params.threadId : "";
      const turnId = typeof turn.id === "string" ? turn.id : "";
      const status = turn.status;
      if (threadId && turnId && (status === "completed" || status === "failed" || status === "interrupted") && !this.terminalTurns.has(turnId)) {
        this.terminalTurns.add(turnId);
        this.eventHandler({
          kind: "turn",
          threadId,
          turnId,
          status,
          error: turn.error ? errorText(turn.error) : undefined,
          payload: params
        });
      }
    }
    this.eventHandler({
      kind: "notification",
      method: message.method ?? "unknown",
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      payload: params
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server stdin is not writable");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex App Server timeout: " + method));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async startThread(input: { cwd: string; projectId?: string }): Promise<{ threadId: string }> {
    await this.ensureStarted();
    const result = await this.request("thread/start", { cwd: input.cwd, ephemeral: false });
    const thread = asRecord(result.thread);
    if (typeof thread.id !== "string" || thread.id.length === 0) throw new Error("Codex App Server did not return a thread id");
    return { threadId: thread.id };
  }

  async sendPrompt(input: { threadId: string; prompt: string; cwd: string }): Promise<{ turnId: string | null }> {
    await this.ensureStarted();
    const result = await this.request("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd
    });
    const turn = asRecord(result.turn);
    return { turnId: typeof turn.id === "string" ? turn.id : null };
  }

  async close(): Promise<void> {
    this.lines?.close();
    this.child?.kill();
    this.failPending(new Error("Codex App Server adapter closed"));
    this.child = null;
    this.lines = null;
    this.initialized = false;
    this.authentication = "UNKNOWN";
    this.terminalTurns.clear();
  }
}

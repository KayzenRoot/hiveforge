import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { CodexAdapter } from "../core/types";

interface WireMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
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

export class CodexAppServerAdapter implements CodexAdapter {
  readonly provider = "codex-app-server" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private requestId = 1;
  private initialized = false;
  private authentication = "UNKNOWN";
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly onNotification?: (message: WireMessage) => void;

  constructor(onNotification?: (message: WireMessage) => void) {
    this.onNotification = onNotification;
  }

  probe(): CodexProbe {
    try {
      const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
      execFileSync("codex", ["app-server", "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      let authentication = this.authentication;
      try {
        const loginResult = spawnSync("codex", ["login", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const loginStatus = `${loginResult.stdout ?? ""}\n${loginResult.stderr ?? ""}`.trim().toLowerCase();
        if (loginStatus.includes("not logged") || loginStatus.includes("not authenticated")) authentication = "NOT_AUTHENTICATED";
        else if (loginStatus.includes("logged in")) authentication = loginStatus.includes("chatgpt") ? "CHATGPT" : "AUTHENTICATED";
      } catch {
        authentication = "NOT_AUTHENTICATED";
      }
      return { available: true, version, appServer: true, authentication };
    } catch (error) {
      return { available: false, version: null, appServer: false, authentication: "UNKNOWN", reason: error instanceof Error ? error.message : "codex unavailable" };
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.initialized) return;
    const probe = this.probe();
    if (!probe.available) throw new Error("Codex App Server is not configured");
    this.child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", () => undefined);
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("exit", (code, signal) => {
      this.initialized = false;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.failPending(new Error(`Codex App Server exited (${code ?? "unknown"}/${signal ?? "no signal"})`));
    });

    await this.request("initialize", {
      clientInfo: { name: "hiveforge", title: "HiveForge", version: "0.1.0" },
      capabilities: null
    });
    this.send({ method: "initialized" });
    this.initialized = true;
    try {
      const auth = await this.request("getAuthStatus", { includeToken: false, refreshToken: false });
      this.authentication = typeof auth.authMethod === "string" ? auth.authMethod : "NOT_AUTHENTICATED";
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
    if (message.id !== undefined && (message.result || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex App Server request failed"));
      else pending.resolve(message.result ?? {});
      return;
    }
    this.onNotification?.(message);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server timeout: ${method}`));
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
    const result = await this.request("thread/start", { cwd: input.cwd, projectId: input.projectId ?? null, ephemeral: false });
    const thread = result.thread as { id?: string } | undefined;
    if (!thread?.id) throw new Error("Codex App Server did not return a thread id");
    return { threadId: thread.id };
  }

  async sendPrompt(input: { threadId: string; prompt: string; cwd: string }): Promise<{ turnId: string | null }> {
    await this.ensureStarted();
    const result = await this.request("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd
    });
    const turn = result.turn as { id?: string } | undefined;
    return { turnId: turn?.id ?? null };
  }

  async close(): Promise<void> {
    this.lines?.close();
    this.child?.kill();
    this.failPending(new Error("Codex App Server adapter closed"));
    this.child = null;
    this.lines = null;
    this.initialized = false;
    this.authentication = "UNKNOWN";
  }
}

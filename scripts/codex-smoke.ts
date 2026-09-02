import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "hiveforge-codex-smoke-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "smoke@hiveforge.local"]);
  git(cwd, ["config", "user.name", "HiveForge Smoke"]);
  writeFileSync(join(cwd, "README.md"), "Codex App Server smoke fixture.\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "smoke fixture"]);

  const adapter = new CodexAppServerAdapter();
  const completed = new Promise<{ turnId: string; status: string; error?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("turn/completed smoke timeout")), 90_000);
    adapter.setEventHandler((event) => {
      if (event.kind !== "turn") return;
      clearTimeout(timeout);
      resolve({ turnId: event.turnId, status: event.status, error: event.error });
    });
  });
  try {
    const thread = await adapter.startThread({ cwd });
    const turn = await adapter.sendPrompt({ threadId: thread.threadId, cwd, prompt: "Reply with exactly HIVEFORGE_SMOKE_OK. Do not modify files, run commands, or create commits." });
    if (!turn.turnId) throw new Error("Codex App Server returned no turn id");
    const result = await completed;
    if (result.status !== "completed") throw new Error("Codex smoke ended with " + result.status + (result.error ? ": " + result.error : ""));
    console.log("CODEX APP SERVER SMOKE PASS: " + result.turnId);
  } finally {
    await adapter.close();
  }
}

void main().catch((error) => { console.error("CODEX APP SERVER SMOKE BLOCKED: " + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; });

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Project, ValidationKind, ValidationResult, ValidationStatus } from "../core/types";
import { Database } from "../db/database";

const execAsync = promisify(exec);
const validationKinds: ValidationKind[] = ["test", "lint", "typecheck", "build"];

function statusFor(exitCode: number | null, error: unknown): ValidationStatus {
  if (error && exitCode === null) return "ERROR";
  return exitCode === 0 ? "PASS" : "FAIL";
}

export class ValidationRunner {
  constructor(private readonly db: Database) {}

  async run(project: Project, runId: string, turnId: string): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    for (const kind of validationKinds) {
      const command = project[kind + "Command" as "testCommand" | "lintCommand" | "typecheckCommand" | "buildCommand"] as string | undefined;
      if (!command?.trim()) {
        const timestamp = new Date().toISOString();
        results.push(this.db.saveValidationResult({
          runId, turnId, kind, command: null, startedAt: timestamp, finishedAt: timestamp,
          exitCode: null, stdout: "", stderr: "", status: "NOT_CONFIGURED"
        }));
        continue;
      }

      const startedAt = new Date().toISOString();
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let error: unknown = null;
      try {
        const result = await execAsync(command, {
          cwd: project.localPath,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
        });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = 0;
      } catch (caught: unknown) {
        error = caught;
        const failure = caught as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        stdout = String(failure.stdout ?? "");
        stderr = String(failure.stderr ?? failure.message ?? caught);
        exitCode = typeof failure.code === "number"
          ? failure.code
          : typeof failure.code === "string" && /^-?\d+$/.test(failure.code)
            ? Number(failure.code)
            : null;
      }
      const finishedAt = new Date().toISOString();
      results.push(this.db.saveValidationResult({
        runId, turnId, kind, command, startedAt, finishedAt, exitCode, stdout, stderr,
        status: statusFor(exitCode, error)
      }));
    }
    return results;
  }
}

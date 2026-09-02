import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { GitEvidence } from "../core/types";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface GitSnapshot {
  baseSha: string;
  headSha: string;
  branch: string;
  status: string;
  changedFiles: string[];
  diffSummary: string;
  isClean: boolean;
}

export class GitAdapter {
  isRepository(localPath: string): boolean {
    if (!existsSync(localPath) || !statSync(localPath).isDirectory()) return false;
    try {
      return git(localPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
      return false;
    }
  }

  assertRepository(localPath: string): void {
    if (!this.isRepository(localPath)) throw new Error("Not a Git repository: " + localPath);
  }

  snapshot(localPath: string, capturedBaseSha?: string): GitSnapshot {
    this.assertRepository(localPath);
    const headSha = git(localPath, ["rev-parse", "HEAD"]);
    const baseSha = capturedBaseSha ?? headSha;
    const branch = git(localPath, ["branch", "--show-current"]) || "DETACHED";
    const statusOutput = git(localPath, ["status", "--short"]);
    const isClean = statusOutput.length === 0;
    const status = isClean ? "clean" : statusOutput;
    const changedFiles = git(localPath, ["diff", "--name-only", baseSha + ".." + headSha]).split(/\r?\n/).filter(Boolean);
    const diffSummary = git(localPath, ["diff", "--stat", baseSha + ".." + headSha]) || "No committed changes";
    return { baseSha, headSha, branch, status, changedFiles, diffSummary, isClean };
  }

  capture(runId: string, localPath: string, capturedBaseSha?: string): Omit<GitEvidence, "id" | "capturedAt"> {
    return { runId, ...this.snapshot(localPath, capturedBaseSha) };
  }
}

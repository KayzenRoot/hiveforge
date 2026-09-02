import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrations } from "./migrations";
import type { AutonomyMode, CodexThread, GitEvidence, Project, ProjectInput, ReviewContract, ReviewStatus, Run, RunEvent, RunState } from "../core/types";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function mapProject(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    localPath: String(row.local_path),
    remoteUrl: row.remote_url ? String(row.remote_url) : undefined,
    defaultBranch: String(row.default_branch),
    workingBranch: String(row.working_branch),
    testCommand: String(row.test_command),
    lintCommand: row.lint_command ? String(row.lint_command) : undefined,
    typecheckCommand: row.typecheck_command ? String(row.typecheck_command) : undefined,
    buildCommand: row.build_command ? String(row.build_command) : undefined,
    autonomyMode: row.autonomy_mode as AutonomyMode,
    reviewMailboxPath: String(row.review_mailbox_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapRun(row: Row): Run {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workOrderId: String(row.work_order_id),
    state: row.state as RunState,
    autonomyMode: row.autonomy_mode as AutonomyMode,
    maxIterations: Number(row.max_iterations),
    maxCorrectionCycles: Number(row.max_correction_cycles),
    repeatedFindingThreshold: Number(row.repeated_finding_threshold),
    iterationCount: Number(row.iteration_count),
    correctionCycles: Number(row.correction_cycles),
    repeatedFindings: JSON.parse(String(row.repeated_findings_json)) as Record<string, number>,
    currentPrompt: row.current_prompt ? String(row.current_prompt) : null,
    expectedBaseSha: row.expected_base_sha ? String(row.expected_base_sha) : null,
    expectedHeadSha: row.expected_head_sha ? String(row.expected_head_sha) : null,
    lastReviewId: row.last_review_id ? String(row.last_review_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class Database {
  readonly filePath: string;
  private readonly db: DatabaseSync;

  constructor(filePath = process.env.HIVEFORGE_DB_PATH ?? join(process.cwd(), "data", "hiveforge.sqlite")) {
    this.filePath = filePath;
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const migration of migrations) {
      const applied = this.get<{ version: number }>("SELECT version FROM schema_migrations WHERE version = ?", migration.version);
      if (!applied) {
        this.db.exec("BEGIN");
        try {
          this.db.exec(migration.sql);
          this.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", migration.version, now());
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params) as { changes: number; lastInsertRowid: number | bigint };
  }

  get<T extends Row = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Row = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.db.close();
  }

  createProject(input: ProjectInput): Project {
    const id = randomUUID();
    const timestamp = now();
    this.run(
      `INSERT INTO projects(id, name, local_path, remote_url, default_branch, working_branch, test_command, lint_command, typecheck_command, build_command, autonomy_mode, review_mailbox_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.name, input.localPath, input.remoteUrl ?? null, input.defaultBranch, input.workingBranch, input.testCommand,
      input.lintCommand ?? null, input.typecheckCommand ?? null, input.buildCommand ?? null, input.autonomyMode, input.reviewMailboxPath, timestamp, timestamp
    );
    return this.getProject(id)!;
  }

  getProject(id: string): Project | undefined {
    const row = this.get("SELECT * FROM projects WHERE id = ?", id);
    return row ? mapProject(row) : undefined;
  }

  listProjects(): Project[] {
    return this.all("SELECT * FROM projects ORDER BY updated_at DESC").map(mapProject);
  }

  createRun(input: { projectId: string; autonomyMode: AutonomyMode; maxIterations?: number; maxCorrectionCycles?: number; repeatedFindingThreshold?: number }): Run {
    const id = randomUUID();
    const workOrderId = `WO-${id.slice(0, 8).toUpperCase()}`;
    const timestamp = now();
    this.run(
      `INSERT INTO runs(id, project_id, work_order_id, state, autonomy_mode, max_iterations, max_correction_cycles, repeated_finding_threshold, created_at, updated_at)
       VALUES (?, ?, ?, 'IDLE', ?, ?, ?, ?, ?, ?)`,
      id, input.projectId, workOrderId, input.autonomyMode, input.maxIterations ?? 12, input.maxCorrectionCycles ?? 4, input.repeatedFindingThreshold ?? 3, timestamp, timestamp
    );
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const row = this.get("SELECT * FROM runs WHERE id = ?", id);
    return row ? mapRun(row) : undefined;
  }

  listNonTerminalRuns(): Run[] {
    return this.all("SELECT * FROM runs WHERE state NOT IN ('COMPLETE', 'FAILED') ORDER BY updated_at ASC").map(mapRun);
  }

  getLatestRun(projectId: string): Run | undefined {
    const row = this.get("SELECT * FROM runs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1", projectId);
    return row ? mapRun(row) : undefined;
  }

  updateRun(run: Run): Run {
    const timestamp = now();
    this.run(
      `UPDATE runs SET state = ?, iteration_count = ?, correction_cycles = ?, repeated_findings_json = ?, current_prompt = ?, expected_base_sha = ?, expected_head_sha = ?, last_review_id = ?, updated_at = ? WHERE id = ?`,
      run.state, run.iterationCount, run.correctionCycles, JSON.stringify(run.repeatedFindings), run.currentPrompt, run.expectedBaseSha, run.expectedHeadSha, run.lastReviewId, timestamp, run.id
    );
    return this.getRun(run.id)!;
  }

  appendEvent(runId: string, type: string, message: string, state: RunState | null, payload: Record<string, unknown> = {}): RunEvent {
    const event: RunEvent = { id: randomUUID(), runId, type, state, message, payload, createdAt: now() };
    this.run("INSERT INTO run_events(id, run_id, type, state, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", event.id, runId, type, state, message, JSON.stringify(payload), event.createdAt);
    return event;
  }

  appendMailboxEvent(filePath: string, kind: string, message: string): void {
    this.run("INSERT INTO mailbox_events(id, file_path, kind, message, created_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), filePath, kind, message, now());
  }

  listEvents(runId: string, limit = 100): RunEvent[] {
    return this.all("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC LIMIT ?", runId, limit).map((row) => ({
      id: String(row.id), runId: String(row.run_id), type: String(row.type), state: row.state ? row.state as RunState : null, message: String(row.message), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at)
    }));
  }

  saveThread(input: { runId: string; provider: CodexThread["provider"]; threadId: string; status: string }): CodexThread {
    const id = randomUUID();
    const timestamp = now();
    this.run("INSERT INTO codex_threads(id, run_id, provider, thread_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, input.runId, input.provider, input.threadId, input.status, timestamp, timestamp);
    return { id, runId: input.runId, provider: input.provider, threadId: input.threadId, status: input.status, createdAt: timestamp, updatedAt: timestamp };
  }

  saveGitEvidence(input: Omit<GitEvidence, "id" | "capturedAt">): GitEvidence {
    const evidence: GitEvidence = { ...input, id: randomUUID(), capturedAt: now() };
    this.run("INSERT INTO git_evidence(id, run_id, base_sha, head_sha, branch, status, changed_files_json, diff_summary, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", evidence.id, evidence.runId, evidence.baseSha, evidence.headSha, evidence.branch, evidence.status, JSON.stringify(evidence.changedFiles), evidence.diffSummary, evidence.capturedAt);
    return evidence;
  }

  getLatestGitEvidence(runId: string): GitEvidence | undefined {
    const row = this.get("SELECT * FROM git_evidence WHERE run_id = ? ORDER BY captured_at DESC LIMIT 1", runId);
    if (!row) return undefined;
    return { id: String(row.id), runId: String(row.run_id), baseSha: String(row.base_sha), headSha: String(row.head_sha), branch: String(row.branch), status: String(row.status), changedFiles: JSON.parse(String(row.changed_files_json)) as string[], diffSummary: String(row.diff_summary), capturedAt: String(row.captured_at) };
  }

  saveReview(review: ReviewContract, status: ReviewStatus): boolean {
    try {
      this.run("INSERT INTO reviews(id, run_id, project_id, work_order_id, decision, action, head_sha, base_sha, status, payload_json, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", review.review_id, review.run_id, review.project_id, review.work_order_id, review.decision, review.action, review.head_sha, review.base_sha, status, JSON.stringify(review), now());
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) return false;
      throw error;
    }
  }

  getReview(reviewId: string): { review: ReviewContract; status: ReviewStatus } | undefined {
    const row = this.get("SELECT payload_json, status FROM reviews WHERE id = ?", reviewId);
    if (!row) return undefined;
    return { review: JSON.parse(String(row.payload_json)) as ReviewContract, status: row.status as ReviewStatus };
  }

  createApproval(reviewId: string): void {
    this.run("INSERT OR IGNORE INTO approvals(id, review_id, status, requested_at) VALUES (?, ?, 'PENDING', ?)", randomUUID(), reviewId, now());
  }

  approveReview(reviewId: string): boolean {
    const result = this.run("UPDATE approvals SET status = 'APPROVED', approved_at = ? WHERE review_id = ? AND status = 'PENDING'", now(), reviewId);
    return result.changes > 0;
  }

  hasDispatch(runId: string, dispatchKey: string): boolean {
    return Boolean(this.get("SELECT id FROM dispatches WHERE run_id = ? AND dispatch_key = ?", runId, dispatchKey));
  }

  recordDispatch(runId: string, reviewId: string | null, dispatchKey: string, prompt: string): boolean {
    try {
      this.run("INSERT INTO dispatches(id, run_id, review_id, dispatch_key, prompt, status, sent_at) VALUES (?, ?, ?, ?, ?, 'SENT', ?)", randomUUID(), runId, reviewId, dispatchKey, prompt, now());
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) return false;
      throw error;
    }
  }
}

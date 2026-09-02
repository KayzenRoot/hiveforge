import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrations } from "./migrations";
import type { AutonomyMode, CodexThread, CodexTurn, CodexTurnStatus, GitEvidence, Project, ProjectInput, ReviewContract, ReviewSnapshot, ReviewStatus, Run, RunEvent, RunOverview, RunState, ValidationKind, ValidationResult, ValidationStatus } from "../core/types";
import { serializeReviewContract, validateReviewContract } from "../core/rcp";

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

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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
    repeatedFindings: parseJson<Record<string, number>>(row.repeated_findings_json, {}),
    currentPrompt: row.current_prompt ? String(row.current_prompt) : null,
    runBaseSha: row.run_base_sha ? String(row.run_base_sha) : null,
    runBaseBranch: row.run_base_branch ? String(row.run_base_branch) : null,
    expectedBaseSha: row.expected_base_sha ? String(row.expected_base_sha) : null,
    expectedHeadSha: row.expected_head_sha ? String(row.expected_head_sha) : null,
    lastReviewId: row.last_review_id ? String(row.last_review_id) : null,
    lastReviewStatus: row.last_review_status ? row.last_review_status as ReviewStatus : null,
    lastReviewVerdict: row.last_review_verdict ? String(row.last_review_verdict) as Run["lastReviewVerdict"] : null,
    lastReviewSummary: row.last_review_summary ? String(row.last_review_summary) : null,
    lastCheckpointNote: row.last_checkpoint_note ? String(row.last_checkpoint_note) : null,
    progressPercent: Number(row.progress_percent ?? 0),
    currentBlocker: row.current_blocker ? String(row.current_blocker) : null,
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

  getRunByWorkOrderId(workOrderId: string): Run | undefined {
    const row = this.get("SELECT * FROM runs WHERE work_order_id = ?", workOrderId);
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
      `UPDATE runs SET state = ?, iteration_count = ?, correction_cycles = ?, repeated_findings_json = ?, current_prompt = ?, run_base_sha = ?, run_base_branch = ?, expected_base_sha = ?, expected_head_sha = ?, last_review_id = ?, last_review_status = ?, last_review_verdict = ?, last_review_summary = ?, last_checkpoint_note = ?, progress_percent = ?, current_blocker = ?, updated_at = ? WHERE id = ?`,
      run.state, run.iterationCount, run.correctionCycles, JSON.stringify(run.repeatedFindings), run.currentPrompt, run.runBaseSha, run.runBaseBranch, run.expectedBaseSha, run.expectedHeadSha, run.lastReviewId, run.lastReviewStatus, run.lastReviewVerdict, run.lastReviewSummary, run.lastCheckpointNote, run.progressPercent, run.currentBlocker, timestamp, run.id
    );
    return this.getRun(run.id)!;
  }

  setRunBase(runId: string, baseSha: string, branch: string): Run {
    this.run("UPDATE runs SET run_base_sha = ?, run_base_branch = ?, updated_at = ? WHERE id = ?", baseSha, branch, now(), runId);
    return this.getRun(runId)!;
  }

  appendEvent(runId: string, type: string, message: string, state: RunState | null, payload: Record<string, unknown> = {}): RunEvent {
    const event: RunEvent = { id: randomUUID(), runId, type, state, message, payload, createdAt: now() };
    this.run("INSERT INTO run_events(id, run_id, type, state, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", event.id, runId, type, state, message, JSON.stringify(payload), event.createdAt);
    return event;
  }

  hasEvent(runId: string, type: string): boolean {
    return Boolean(this.get("SELECT id FROM run_events WHERE run_id = ? AND type = ? LIMIT 1", runId, type));
  }

  appendMailboxEvent(filePath: string, kind: string, message: string): void {
    this.run("INSERT INTO mailbox_events(id, file_path, kind, message, created_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), filePath, kind, message, now());
  }

  listEvents(runId: string, limit = 100): RunEvent[] {
    return this.all("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC LIMIT ?", runId, limit).map((row) => ({
      id: String(row.id), runId: String(row.run_id), type: String(row.type), state: row.state ? row.state as RunState : null, message: String(row.message), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at)
    }));
  }

  listEventsAfter(runId: string, createdAt: string, eventId: string, limit = 100): RunEvent[] {
    return this.all("SELECT * FROM run_events WHERE run_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?", runId, createdAt, createdAt, eventId, limit).map((row) => ({
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
    this.run("INSERT INTO git_evidence(id, run_id, base_sha, head_sha, branch, status, changed_files_json, diff_summary, is_clean, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", evidence.id, evidence.runId, evidence.baseSha, evidence.headSha, evidence.branch, evidence.status, JSON.stringify(evidence.changedFiles), evidence.diffSummary, evidence.isClean ? 1 : 0, evidence.capturedAt);
    return evidence;
  }

  getLatestGitEvidence(runId: string): GitEvidence | undefined {
    const row = this.get("SELECT * FROM git_evidence WHERE run_id = ? ORDER BY captured_at DESC LIMIT 1", runId);
    if (!row) return undefined;
    return { id: String(row.id), runId: String(row.run_id), baseSha: String(row.base_sha), headSha: String(row.head_sha), branch: String(row.branch), status: String(row.status), changedFiles: parseJson<string[]>(row.changed_files_json, []), diffSummary: String(row.diff_summary), isClean: Number(row.is_clean ?? 1) === 1, capturedAt: String(row.captured_at) };
  }

  saveReview(review: ReviewContract, status: ReviewStatus): boolean {
    try {
      this.run("INSERT INTO reviews(id, run_id, project_id, work_order_id, decision, action, head_sha, base_sha, status, payload_json, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", review.reviewId, this.getRunByWorkOrderId(review.workOrderId)?.id ?? null, review.projectId, review.workOrderId, review.verdict, review.nextAction, review.headSha, review.baseSha, status, JSON.stringify(serializeReviewContract(review)), now());
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) return false;
      throw error;
    }
  }

  getReview(reviewId: string): { review: ReviewContract; status: ReviewStatus } | undefined {
    const row = this.get("SELECT payload_json, status FROM reviews WHERE id = ?", reviewId);
    if (!row) return undefined;
    const parsed = validateReviewContract(parseJson<unknown>(row.payload_json, null));
    if (!parsed.valid || !parsed.value) throw new Error(`Stored review ${reviewId} is not canonical: ${parsed.errors.join(", ")}`);
    return { review: parsed.value, status: row.status as ReviewStatus };
  }

  getLatestReview(runId: string): ReviewSnapshot | null {
    const row = this.get("SELECT id, payload_json, status FROM reviews WHERE run_id = ? ORDER BY processed_at DESC LIMIT 1", runId);
    if (!row) return null;
    const parsed = validateReviewContract(parseJson<unknown>(row.payload_json, null));
    if (!parsed.valid || !parsed.value) return null;
    return { review: parsed.value, status: row.status as ReviewStatus };
  }

  updateReviewStatus(reviewId: string, status: ReviewStatus): void {
    this.run("UPDATE reviews SET status = ? WHERE id = ?", status, reviewId);
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

  getDispatch(runId: string, dispatchKey: string): { id: string; status: string; threadId: string | null; turnId: string | null; reviewId: string | null; prompt: string } | undefined {
    const row = this.get("SELECT * FROM dispatches WHERE run_id = ? AND dispatch_key = ?", runId, dispatchKey);
    if (!row) return undefined;
    return {
      id: String(row.id), status: String(row.status), threadId: row.thread_id ? String(row.thread_id) : null,
      turnId: row.turn_id ? String(row.turn_id) : null, reviewId: row.review_id ? String(row.review_id) : null, prompt: String(row.prompt)
    };
  }

  getThreadForRun(runId: string): CodexThread | undefined {
    const row = this.get("SELECT * FROM codex_threads WHERE run_id = ? ORDER BY created_at ASC LIMIT 1", runId);
    if (!row) return undefined;
    return {
      id: String(row.id), runId: String(row.run_id), provider: row.provider as CodexThread["provider"], threadId: String(row.thread_id),
      status: String(row.status), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
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

  prepareDispatch(runId: string, reviewId: string | null, dispatchKey: string, prompt: string, threadId: string): boolean {
    try {
      this.run("INSERT INTO dispatches(id, run_id, review_id, dispatch_key, prompt, status, sent_at, thread_id) VALUES (?, ?, ?, ?, ?, 'PREPARED', ?, ?)", randomUUID(), runId, reviewId, dispatchKey, prompt, now(), threadId);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) return false;
      throw error;
    }
  }

  markDispatchSent(runId: string, dispatchKey: string, turnId: string): boolean {
    const result = this.run("UPDATE dispatches SET status = 'SENT', turn_id = ?, sent_at = ? WHERE run_id = ? AND dispatch_key = ? AND status = 'PREPARED'", turnId, now(), runId, dispatchKey);
    return result.changes > 0;
  }

  markDispatchFailed(runId: string, dispatchKey: string, message: string): boolean {
    const result = this.run("UPDATE dispatches SET status = 'FAILED', prompt = prompt || ? WHERE run_id = ? AND dispatch_key = ? AND status = 'PREPARED'", `\n[dispatch-error] ${message}`, runId, dispatchKey);
    return result.changes > 0;
  }

  createCodexTurn(input: { runId: string; threadId: string; turnId: string; dispatchKey: string; prompt: string; status?: CodexTurnStatus }): CodexTurn {
    const id = randomUUID();
    const timestamp = now();
    const status = input.status ?? "IN_PROGRESS";
    this.run("INSERT INTO codex_turns(id, run_id, thread_id, turn_id, dispatch_key, prompt, status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, input.runId, input.threadId, input.turnId, input.dispatchKey, input.prompt, status, timestamp, timestamp, timestamp);
    return this.getCodexTurn(input.turnId)!;
  }

  getCodexTurn(turnId: string): CodexTurn | undefined {
    const row = this.get("SELECT * FROM codex_turns WHERE turn_id = ?", turnId);
    return row ? this.mapCodexTurn(row) : undefined;
  }

  getCodexTurnByIdentity(threadId: string, turnId: string): CodexTurn | undefined {
    const row = this.get("SELECT * FROM codex_turns WHERE thread_id = ? AND turn_id = ?", threadId, turnId);
    return row ? this.mapCodexTurn(row) : undefined;
  }

  getActiveCodexTurn(runId: string): CodexTurn | undefined {
    const row = this.get("SELECT * FROM codex_turns WHERE run_id = ? AND status IN ('PREPARED', 'IN_PROGRESS') ORDER BY started_at DESC LIMIT 1", runId);
    return row ? this.mapCodexTurn(row) : undefined;
  }

  updateCodexTurnStatus(turnId: string, status: CodexTurnStatus, error: string | null = null): CodexTurn | undefined {
    const finishedAt = ["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED", "ORPHANED"].includes(status) ? now() : null;
    this.run("UPDATE codex_turns SET status = ?, error = ?, finished_at = COALESCE(?, finished_at), updated_at = ? WHERE turn_id = ?", status, error, finishedAt, now(), turnId);
    return this.getCodexTurn(turnId);
  }

  beginTurnValidation(turnId: string): boolean {
    const result = this.run("UPDATE codex_turns SET validation_started_at = ?, updated_at = ? WHERE turn_id = ? AND validation_started_at IS NULL", now(), now(), turnId);
    return result.changes > 0;
  }

  saveValidationResult(input: Omit<ValidationResult, "id">): ValidationResult {
    const result: ValidationResult = { ...input, id: randomUUID() };
    this.run("INSERT INTO validation_results(id, run_id, turn_id, kind, command, started_at, finished_at, exit_code, stdout, stderr, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", result.id, result.runId, result.turnId, result.kind, result.command, result.startedAt, result.finishedAt, result.exitCode, result.stdout, result.stderr, result.status);
    return result;
  }

  getValidationResults(runId: string, turnId?: string): ValidationResult[] {
    const rows = turnId
      ? this.all("SELECT * FROM validation_results WHERE run_id = ? AND turn_id = ? ORDER BY finished_at ASC", runId, turnId)
      : this.all("SELECT * FROM validation_results WHERE run_id = ? ORDER BY finished_at ASC", runId);
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), turnId: String(row.turn_id), kind: row.kind as ValidationKind,
      command: row.command ? String(row.command) : null, startedAt: String(row.started_at), finishedAt: String(row.finished_at),
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code), stdout: String(row.stdout ?? ""), stderr: String(row.stderr ?? ""), status: row.status as ValidationStatus
    }));
  }

  getRunOverview(runId: string): RunOverview | undefined {
    const run = this.getRun(runId);
    if (!run) return undefined;
    return { run, gitEvidence: this.getLatestGitEvidence(runId) ?? null, validations: this.getValidationResults(runId), review: this.getLatestReview(runId), events: this.listEvents(runId, 250) };
  }

  private mapCodexTurn(row: Row): CodexTurn {
    return {
      id: String(row.id), runId: String(row.run_id), threadId: String(row.thread_id), turnId: String(row.turn_id), dispatchKey: String(row.dispatch_key), prompt: String(row.prompt),
      status: row.status as CodexTurnStatus, startedAt: String(row.started_at), finishedAt: row.finished_at ? String(row.finished_at) : null, error: row.error ? String(row.error) : null,
      validationStartedAt: row.validation_started_at ? String(row.validation_started_at) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }
}

import type { CodexAdapter, CodexLifecycleEvent, CodexTurn, ReviewContract, Run, RunEvent } from "../core/types";
import { evaluateLoopGuard } from "../core/loop-guard";
import { serializeReviewContract, validateReviewContract } from "../core/rcp";
import { verifyEvidenceLock } from "../core/evidence-lock";
import { transition } from "../core/state-machine";
import { Database } from "../db/database";
import { GitAdapter } from "../adapters/git";
import { EventBus } from "../core/event-bus";
import { ValidationRunner } from "./validation";

const terminalTurnStatuses = new Set(["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED", "ORPHANED"]);

export class WorkflowEngine {
  private readonly validation: ValidationRunner;

  constructor(
    private readonly db: Database,
    private readonly git: GitAdapter,
    private readonly events: EventBus,
    private readonly adapter: CodexAdapter,
    validation = new ValidationRunner(db)
  ) {
    this.validation = validation;
    this.adapter.setEventHandler((event) => this.handleAdapterEvent(event));
  }

  private event(runId: string, type: string, message: string, state: Run["state"] | null, payload: Record<string, unknown> = {}): RunEvent {
    const event = this.db.appendEvent(runId, type, message, state, payload);
    this.events.publish(event);
    return event;
  }

  private move(run: Run, next: Run["state"], message: string, type = "STATE_CHANGED"): Run {
    if (run.state === next) return run;
    run.state = transition(run.state, next);
    const updated = this.db.updateRun(run);
    this.event(run.id, type, message, next);
    return updated;
  }

  private block(run: Run, message: string, type = "RUN_BLOCKED"): Run {
    run.currentBlocker = message;
    run = this.db.updateRun(run);
    if (run.state !== "BLOCKED" && run.state !== "COMPLETE" && run.state !== "FAILED") {
      run = this.move(run, "BLOCKED", message, type);
    } else {
      this.event(run.id, type, message, run.state);
    }
    return run;
  }

  async start(runId: string, prompt: string): Promise<Run> {
    let run = this.requireRun(runId);
    const project = this.requireProject(run.projectId);
    if (run.state !== "IDLE" && run.state !== "PAUSED" && run.state !== "BLOCKED") throw new Error("Run cannot start from " + run.state);

    const snapshot = this.git.snapshot(project.localPath, run.runBaseSha ?? undefined);
    if (!snapshot.isClean) throw new Error("Run must start from a clean committed Git state");
    if (!run.runBaseSha) {
      run = this.db.setRunBase(run.id, snapshot.headSha, snapshot.branch);
      this.event(run.id, "RUN_BASE_CAPTURED", "Captured immutable Git base at work-order start", run.state, { baseSha: snapshot.headSha, branch: snapshot.branch });
    }

    run = this.move(run, "QUEUED", "Run queued");
    run = this.move(run, "CODEX_RUNNING", "Codex turn started");
    const storedThread = this.db.getThreadForRun(run.id);
    const thread = storedThread ?? await this.adapter.startThread({ cwd: project.localPath });
    if (!storedThread) this.db.saveThread({ runId: run.id, provider: this.adapter.provider, threadId: thread.threadId, status: "ACTIVE" });

    const dispatchKey = run.iterationCount === 0 ? "initial" : "iteration-" + (run.iterationCount + 1);
    const existing = this.db.getDispatch(run.id, dispatchKey);
    if (existing) {
      if (existing.status === "SENT" && existing.turnId) return run;
      return this.block(run, "An ambiguous prepared dispatch exists; recovery will not resend it", "DISPATCH_AMBIGUOUS");
    }

    if (!this.db.prepareDispatch(run.id, null, dispatchKey, prompt, thread.threadId)) {
      return this.block(run, "Dispatch intent already exists; recovery will not resend it", "DISPATCH_AMBIGUOUS");
    }

    try {
      const response = await this.adapter.sendPrompt({ threadId: thread.threadId, prompt, cwd: project.localPath });
      if (!response.turnId) throw new Error("Codex App Server did not return a turn id");
      this.db.createCodexTurn({ runId: run.id, threadId: thread.threadId, turnId: response.turnId, dispatchKey, prompt });
      this.db.markDispatchSent(run.id, dispatchKey, response.turnId);
      run.currentPrompt = prompt;
      run.iterationCount += 1;
      run.currentBlocker = null;
      run = this.db.updateRun(run);
      this.event(run.id, "DISPATCH_SENT", "Prompt dispatched to Codex", run.state, { dispatchKey, provider: this.adapter.provider, threadId: thread.threadId, turnId: response.turnId });
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.markDispatchFailed(run.id, dispatchKey, message);
      return this.block(run, "Initial Codex dispatch failed: " + message, "DISPATCH_FAILED");
    }
  }

  /**
   * Compatibility entry point retained for callers migrating from 001A.
   * Production completion is driven by the adapter's turn/completed event.
   */
  async markValidation(runId: string): Promise<Run> {
    const run = this.requireRun(runId);
    const turn = this.db.getActiveCodexTurn(run.id);
    if (!turn) throw new Error("No active durable Codex turn; manual validation is not a valid completion path");
    await this.handleCodexTurn({ kind: "turn", threadId: turn.threadId, turnId: turn.turnId, status: "completed", payload: {} });
    return this.requireRun(runId);
  }

  private handleAdapterEvent(event: CodexLifecycleEvent): void {
    if (event.kind === "turn") {
      void this.handleCodexTurn(event).catch((error: unknown) => {
        const turn = this.db.getCodexTurnByIdentity(event.threadId, event.turnId);
        if (turn) this.failRun(turn.runId, "Codex turn handler failed: " + (error instanceof Error ? error.message : String(error)));
      });
      return;
    }
    const runId = event.threadId ? this.db.get<{ run_id: string }>("SELECT run_id FROM codex_threads WHERE thread_id = ?", event.threadId)?.run_id : undefined;
    if (runId) this.event(runId, "CODEX_" + event.method.replace(/[^A-Z0-9]+/gi, "_").toUpperCase(), "Codex event: " + event.method, this.db.getRun(runId)?.state ?? null, event.payload);
  }

  async handleCodexTurn(event: { kind: "turn"; threadId: string; turnId: string; status: "completed" | "failed" | "interrupted"; error?: string; payload: Record<string, unknown> }): Promise<void> {
    const turn = this.db.getCodexTurnByIdentity(event.threadId, event.turnId);
    if (!turn) return;
    if (terminalTurnStatuses.has(turn.status)) return;

    const nextStatus = event.status === "completed" ? "COMPLETED" : event.status === "failed" ? "FAILED" : "INTERRUPTED";
    this.db.updateCodexTurnStatus(event.turnId, nextStatus, event.error ?? null);
    const run = this.requireRun(turn.runId);
    if (event.status !== "completed") {
      this.failRun(run.id, "Codex turn " + event.status + (event.error ? ": " + event.error : ""));
      this.event(run.id, "CODEX_TURN_TERMINAL", "Codex turn ended without a completed result", this.db.getRun(run.id)?.state ?? null, { turnId: event.turnId, status: event.status, error: event.error ?? null });
      return;
    }

    this.event(run.id, "CODEX_TURN_COMPLETED", "Codex turn completed; deterministic validation started", run.state, { threadId: event.threadId, turnId: event.turnId });
    await this.completeCodexTurn(turn);
  }

  private async completeCodexTurn(turn: CodexTurn): Promise<void> {
    if (!this.db.beginTurnValidation(turn.turnId)) return;
    let run = this.requireRun(turn.runId);
    const project = this.requireProject(run.projectId);
    if (run.state !== "CODEX_RUNNING") {
      this.block(run, "Completed Codex turn arrived while run was in " + run.state, "TURN_STATE_MISMATCH");
      return;
    }

    try {
      run = this.move(run, "VALIDATING", "Codex turn completed; validation started");
      const validations = await this.validation.run(project, run.id, turn.turnId);
      this.event(run.id, "VALIDATION_COMPLETED", "Configured validation commands completed", run.state, {
        turnId: turn.turnId,
        results: validations.map((result) => ({ kind: result.kind, status: result.status, exitCode: result.exitCode }))
      });
      run = this.move(run, "GIT_SYNC", "Capturing deterministic Git evidence");
      const evidence = this.db.saveGitEvidence(this.git.capture(run.id, project.localPath, run.runBaseSha ?? undefined));
      run.expectedBaseSha = evidence.baseSha;
      run.expectedHeadSha = evidence.headSha;
      run.currentBlocker = null;
      run = this.db.updateRun(run);
      this.event(run.id, "GIT_EVIDENCE_CAPTURED", "Git evidence captured from immutable work-order base", run.state, {
        headSha: evidence.headSha, baseSha: evidence.baseSha, branch: evidence.branch, isClean: evidence.isClean
      });

      const test = validations.find((result) => result.kind === "test");
      const failed = validations.filter((result) => result.status === "FAIL" || result.status === "ERROR");
      const testMissing = !test || test.status === "NOT_CONFIGURED";
      if (!evidence.isClean || testMissing || failed.length > 0) {
        const blocker = !evidence.isClean
          ? "Working tree is dirty; review evidence is fail-closed"
          : testMissing
            ? "Required test command is not configured"
            : "Validation failed: " + failed.map((result) => result.kind + "=" + result.status).join(", ");
        this.block(run, blocker, "VALIDATION_BLOCKED");
        return;
      }
      run = this.db.updateRun(run);
      this.move(run, "WAITING_REVIEW", "Waiting for a canonical review contract");
    } catch (error) {
      this.failRun(run.id, "Validation/evidence pipeline failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  pause(runId: string): Run {
    const run = this.requireRun(runId);
    if (!["QUEUED", "CODEX_RUNNING", "WAITING_REVIEW", "WAITING_APPROVAL"].includes(run.state)) throw new Error("Run cannot pause from " + run.state);
    return this.move(run, "PAUSED", "Run paused by operator", "RUN_PAUSED");
  }

  async resume(runId: string): Promise<Run> {
    const run = this.requireRun(runId);
    if (run.state !== "PAUSED") throw new Error("Run cannot resume from " + run.state);
    return this.start(run.id, run.currentPrompt ?? "Resume the current work order and report evidence.");
  }

  stop(runId: string): Run {
    const run = this.requireRun(runId);
    if (run.state === "COMPLETE" || run.state === "FAILED") throw new Error("Run cannot stop from " + run.state);
    return this.move(run, "FAILED", "Run stopped by operator", "RUN_STOPPED");
  }

  async processReview(input: unknown): Promise<{ accepted: boolean; run: Run | null; errors: string[] }> {
    const internalInput = typeof input === "object" && input !== null && !Array.isArray(input) && "schemaVersion" in input;
    const boundaryInput = internalInput ? serializeReviewContract(input as ReviewContract) : input;
    const parsed = validateReviewContract(boundaryInput);
    const candidateWorkOrderId = typeof boundaryInput === "object" && boundaryInput !== null && !Array.isArray(boundaryInput) ? (boundaryInput as Record<string, unknown>).work_order_id : undefined;
    const candidateRun = typeof candidateWorkOrderId === "string" ? this.db.getRunByWorkOrderId(candidateWorkOrderId) ?? null : null;
    if (!parsed.valid || !parsed.value) {
      if (candidateRun) this.event(candidateRun.id, "REVIEW_REJECTED", "Invalid canonical review contract", candidateRun.state, { errors: parsed.errors });
      return { accepted: false, run: candidateRun, errors: parsed.errors };
    }
    const review = parsed.value;
    const run = this.db.getRunByWorkOrderId(review.workOrderId) ?? null;
    if (!run) return { accepted: false, run: null, errors: ["work_order_id does not resolve to an active work order"] };
    const project = this.requireProject(run.projectId);
    if (run.state !== "WAITING_REVIEW") return { accepted: false, run, errors: ["run is not waiting for review (" + run.state + ")"] };
    if (!this.db.saveReview(review, "RECEIVED")) {
      this.event(run.id, "REVIEW_DUPLICATE", "Review id was already consumed", run.state, { reviewId: review.reviewId });
      return { accepted: false, run, errors: ["review id already consumed"] };
    }
    const evidence = this.db.getLatestGitEvidence(run.id);
    if (!evidence) return this.rejectReview(run, review.reviewId, "Git evidence is missing");
    const lock = verifyEvidenceLock(review, project, run, evidence);
    if (!lock.locked) return this.rejectReview(run, review.reviewId, "Evidence Lock rejected: " + lock.errors.join(", "), { errors: lock.errors });

    this.db.updateReviewStatus(review.reviewId, "ACCEPTED");
    let current = this.move(run, "REVIEW_RECEIVED", "Valid canonical review received", "REVIEW_ACCEPTED");
    current.lastReviewId = review.reviewId;
    current.lastReviewStatus = "ACCEPTED";
    current.lastReviewVerdict = review.verdict;
    current.lastReviewSummary = review.summary;
    current.lastCheckpointNote = review.checkpointNote;
    current.progressPercent = review.progressPercent;
    current.currentBlocker = review.verdict === "BLOCKED" ? review.summary : null;
    current = this.db.updateRun(current);
    this.event(current.id, "EVIDENCE_LOCKED", "Review matches project, work order and Git evidence", current.state, { reviewId: review.reviewId, headSha: review.headSha, baseSha: review.baseSha });

    if (review.nextAction === "WAIT") return { accepted: true, run: this.block(current, review.summary, "REVIEW_BLOCKED"), errors: [] };
    if (review.nextAction === "STOP") return { accepted: true, run: this.move(current, "COMPLETE", "Review completed the workflow", "RUN_COMPLETE"), errors: [] };

    const guard = evaluateLoopGuard(current, review);
    if (!guard.allowed) {
      current.iterationCount = guard.nextIterationCount;
      current.correctionCycles = guard.nextCorrectionCycles;
      current.repeatedFindings = guard.nextRepeatedFindings;
      current = this.db.updateRun(current);
      return { accepted: true, run: this.block(current, guard.reason ?? "Loop guard blocked dispatch", "LOOP_GUARD_BLOCKED"), errors: [] };
    }
    current.iterationCount = guard.nextIterationCount;
    current.correctionCycles = guard.nextCorrectionCycles;
    current.repeatedFindings = guard.nextRepeatedFindings;
    current = this.db.updateRun(current);
    if (current.autonomyMode !== "AUTONOMOUS") {
      this.db.createApproval(review.reviewId);
      this.event(current.id, "APPROVAL_REQUIRED", current.autonomyMode + " requires approval before dispatch", current.state, { reviewId: review.reviewId });
      return { accepted: true, run: this.move(current, "WAITING_APPROVAL", "Waiting for human approval"), errors: [] };
    }
    return { accepted: true, run: await this.dispatchAcceptedReview(current, review), errors: [] };
  }

  async approveReview(reviewId: string): Promise<Run> {
    const stored = this.db.getReview(reviewId);
    if (!stored) throw new Error("Review not found");
    if (!this.db.approveReview(reviewId)) throw new Error("Review is not awaiting approval");
    const run = this.db.getRunByWorkOrderId(stored.review.workOrderId);
    if (!run) throw new Error("Review work order not found");
    if (run.state !== "WAITING_APPROVAL") throw new Error("Run is not waiting for approval (" + run.state + ")");
    this.event(run.id, "APPROVAL_GRANTED", "Human approval granted", run.state, { reviewId });
    return this.dispatchAcceptedReview(run, stored.review);
  }

  recover(): Run[] {
    const runs = this.db.listNonTerminalRuns();
    for (const run of runs) {
      if (run.state === "CODEX_RUNNING" || run.state === "DISPATCHING_NEXT") {
        const turn = this.db.getActiveCodexTurn(run.id);
        if (turn) {
          if (!this.db.hasEvent(run.id, "RECOVERY_ORPHANED")) {
            this.db.updateCodexTurnStatus(turn.turnId, "ORPHANED", "Turn ownership could not be proven after process recovery");
            this.block(run, "Active Codex turn became orphaned during recovery", "RECOVERY_ORPHANED");
          }
        } else if (!this.db.hasEvent(run.id, "RECOVERY_NO_DURABLE_TURN")) {
          this.block(run, "Run was active without a durable Codex turn; recovery will not resend", "RECOVERY_NO_DURABLE_TURN");
        }
      } else if (!this.db.hasEvent(run.id, "RECOVERY_RECONCILED")) {
        this.event(run.id, "RECOVERY_RECONCILED", "Run recovery checked without dispatch", run.state);
      }
    }
    return runs.map((run) => this.db.getRun(run.id)!).filter(Boolean);
  }

  private async dispatchAcceptedReview(run: Run, review: ReviewContract): Promise<Run> {
    const project = this.requireProject(run.projectId);
    let current = this.move(run, "DISPATCHING_NEXT", "Preparing next durable dispatch");
    const dispatchKey = "review-" + review.reviewId;
    const existing = this.db.getDispatch(current.id, dispatchKey);
    if (existing) {
      if (existing.status === "SENT" && existing.turnId) {
        current.currentPrompt = review.executorPrompt;
        current = this.db.updateRun(current);
        return this.move(current, "CODEX_RUNNING", "Existing dispatch reused after recovery");
      }
      return this.block(current, "An ambiguous review dispatch exists; recovery will not resend it", "DISPATCH_AMBIGUOUS");
    }
    const thread = this.db.getThreadForRun(current.id);
    if (!thread) return this.block(current, "Codex thread missing for next dispatch", "DISPATCH_FAILED");
    if (!this.db.prepareDispatch(current.id, review.reviewId, dispatchKey, review.executorPrompt, thread.threadId)) {
      return this.block(current, "Dispatch intent already exists; recovery will not resend it", "DISPATCH_AMBIGUOUS");
    }
    try {
      const response = await this.adapter.sendPrompt({ threadId: thread.threadId, prompt: review.executorPrompt, cwd: project.localPath });
      if (!response.turnId) throw new Error("Codex App Server did not return a turn id");
      this.db.createCodexTurn({ runId: current.id, threadId: thread.threadId, turnId: response.turnId, dispatchKey, prompt: review.executorPrompt });
      this.db.markDispatchSent(current.id, dispatchKey, response.turnId);
      current.currentPrompt = review.executorPrompt;
      current.currentBlocker = null;
      current = this.db.updateRun(current);
      this.event(current.id, "DISPATCH_SENT", "Next prompt dispatched to Codex", "DISPATCHING_NEXT", { dispatchKey, reviewId: review.reviewId, turnId: response.turnId });
      return this.move(current, "CODEX_RUNNING", "Codex is running the next prompt");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.markDispatchFailed(current.id, dispatchKey, message);
      return this.block(current, "Next Codex dispatch failed: " + message, "DISPATCH_FAILED");
    }
  }

  private failRun(runId: string, message: string): Run {
    let run = this.requireRun(runId);
    run.currentBlocker = message;
    run = this.db.updateRun(run);
    if (run.state === "CODEX_RUNNING" || run.state === "VALIDATING" || run.state === "GIT_SYNC" || run.state === "DISPATCHING_NEXT") {
      return this.block(run, message, "RUN_FAILED_SAFE");
    }
    this.event(run.id, "RUN_FAILED_SAFE", message, run.state);
    return run;
  }

  private rejectReview(run: Run, reviewId: string, message: string, payload: Record<string, unknown> = {}): { accepted: false; run: Run; errors: string[] } {
    this.db.updateReviewStatus(reviewId, "REJECTED");
    this.event(run.id, "REVIEW_REJECTED", message, run.state, payload);
    return { accepted: false, run, errors: [message] };
  }

  private requireRun(id: string): Run {
    const run = this.db.getRun(id);
    if (!run) throw new Error("Run not found: " + id);
    return run;
  }

  private requireProject(id: string) {
    const project = this.db.getProject(id);
    if (!project) throw new Error("Project not found: " + id);
    return project;
  }
}

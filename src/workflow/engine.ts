import type { CodexAdapter } from "../core/types";
import { evaluateLoopGuard } from "../core/loop-guard";
import { validateReviewContract } from "../core/rcp";
import { transition } from "../core/state-machine";
import type { ReviewContract, Run, RunEvent } from "../core/types";
import { Database } from "../db/database";
import { GitAdapter } from "../adapters/git";
import { EventBus } from "../core/event-bus";

export class WorkflowEngine {
  constructor(
    private readonly db: Database,
    private readonly git: GitAdapter,
    private readonly events: EventBus,
    private readonly adapter: CodexAdapter
  ) {}

  private event(runId: string, type: string, message: string, state: Run["state"] | null, payload: Record<string, unknown> = {}): RunEvent {
    const event = this.db.appendEvent(runId, type, message, state, payload);
    this.events.publish(event);
    return event;
  }

  private move(run: Run, next: Run["state"], message: string, type = "STATE_CHANGED"): Run {
    run.state = transition(run.state, next);
    const updated = this.db.updateRun(run);
    this.event(run.id, type, message, next);
    return updated;
  }

  async start(runId: string, prompt: string): Promise<Run> {
    let run = this.requireRun(runId);
    const project = this.requireProject(run.projectId);
    if (run.state !== "IDLE" && run.state !== "PAUSED" && run.state !== "BLOCKED") throw new Error(`Run cannot start from ${run.state}`);
    run = this.move(run, "QUEUED", "Run queued");
    run = this.move(run, "CODEX_RUNNING", "Codex turn started");
    const existingThread = this.db.get<{ thread_id: string }>("SELECT thread_id FROM codex_threads WHERE run_id = ? ORDER BY created_at ASC LIMIT 1", run.id);
    const thread = existingThread ? { threadId: existingThread.thread_id } : await this.adapter.startThread({ cwd: project.localPath, projectId: project.id });
    if (!existingThread) this.db.saveThread({ runId: run.id, provider: this.adapter.provider, threadId: thread.threadId, status: "ACTIVE" });
    const dispatchKey = run.iterationCount === 0 ? "initial" : `iteration-${run.iterationCount + 1}`;
    if (!this.db.hasDispatch(run.id, dispatchKey)) {
      await this.adapter.sendPrompt({ threadId: thread.threadId, prompt, cwd: project.localPath });
      this.db.recordDispatch(run.id, null, dispatchKey, prompt);
      this.event(run.id, "DISPATCH_SENT", "Prompt dispatched to Codex", run.state, { dispatchKey, provider: this.adapter.provider });
    }
    run.currentPrompt = prompt;
    run.iterationCount += 1;
    run = this.db.updateRun(run);
    return run;
  }

  async markValidation(runId: string): Promise<Run> {
    let run = this.requireRun(runId);
    const project = this.requireProject(run.projectId);
    run = this.move(run, "VALIDATING", "Codex turn completed; validation started");
    run = this.move(run, "GIT_SYNC", "Capturing deterministic Git evidence");
    const evidence = this.db.saveGitEvidence(this.git.capture(run.id, project.localPath));
    run.expectedBaseSha = evidence.baseSha;
    run.expectedHeadSha = evidence.headSha;
    run = this.db.updateRun(run);
    this.event(run.id, "GIT_EVIDENCE_CAPTURED", "Git evidence locked for review", run.state, { headSha: evidence.headSha, baseSha: evidence.baseSha, branch: evidence.branch });
    return this.move(run, "WAITING_REVIEW", "Waiting for a review contract");
  }

  pause(runId: string): Run {
    const run = this.requireRun(runId);
    if (!["QUEUED", "CODEX_RUNNING", "WAITING_REVIEW", "WAITING_APPROVAL"].includes(run.state)) throw new Error(`Run cannot pause from ${run.state}`);
    return this.move(run, "PAUSED", "Run paused by operator", "RUN_PAUSED");
  }

  async resume(runId: string): Promise<Run> {
    const run = this.requireRun(runId);
    if (run.state !== "PAUSED") throw new Error(`Run cannot resume from ${run.state}`);
    return this.start(run.id, run.currentPrompt ?? "Resume the current work order and report evidence.");
  }

  stop(runId: string): Run {
    const run = this.requireRun(runId);
    if (run.state === "COMPLETE" || run.state === "FAILED") throw new Error(`Run cannot stop from ${run.state}`);
    return this.move(run, "FAILED", "Run stopped by operator", "RUN_STOPPED");
  }

  async processReview(input: unknown): Promise<{ accepted: boolean; run: Run | null; errors: string[] }> {
    const parsed = validateReviewContract(input);
    if (!parsed.valid || !parsed.value) {
      const candidateRunId = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).run_id : undefined;
      const run = typeof candidateRunId === "string" ? this.db.getRun(candidateRunId) ?? null : null;
      if (run) this.event(run.id, "REVIEW_REJECTED", "Invalid review contract", run.state, { errors: parsed.errors });
      return { accepted: false, run, errors: parsed.errors };
    }
    const review = parsed.value;
    const run = this.requireRun(review.run_id);
    const project = this.requireProject(run.projectId);
    if (run.state !== "WAITING_REVIEW") return { accepted: false, run, errors: [`run is not waiting for review (${run.state})`] };
    if (!this.db.saveReview(review, "RECEIVED")) {
      this.event(run.id, "REVIEW_DUPLICATE", "Review id was already consumed", run.state, { reviewId: review.review_id });
      return { accepted: false, run, errors: ["review id already consumed"] };
    }
    const evidence = this.db.getLatestGitEvidence(run.id);
    if (!evidence) return this.rejectReview(run, review.review_id, "Git evidence is missing");
    const lockErrors: string[] = [];
    if (review.project_id !== project.id) lockErrors.push("project_id mismatch");
    if (review.run_id !== run.id) lockErrors.push("run_id mismatch");
    if (review.work_order_id !== run.workOrderId) lockErrors.push("work_order_id mismatch");
    if (review.head_sha !== evidence.headSha) lockErrors.push("head_sha does not match captured Git evidence");
    if (review.base_sha !== evidence.baseSha) lockErrors.push("base_sha does not match captured Git evidence");
    if (lockErrors.length > 0) return this.rejectReview(run, review.review_id, `Evidence Lock rejected: ${lockErrors.join(", ")}`, { errors: lockErrors });

    this.db.run("UPDATE reviews SET status = 'ACCEPTED' WHERE id = ?", review.review_id);
    let current = this.move(run, "REVIEW_RECEIVED", "Valid review received", "REVIEW_ACCEPTED");
    current.lastReviewId = review.review_id;
    current = this.db.updateRun(current);
    this.event(current.id, "EVIDENCE_LOCKED", "Review matches project, work order and Git SHA", current.state, { reviewId: review.review_id });

    if (review.action === "BLOCKED") return { accepted: true, run: this.move(current, "BLOCKED", "Review blocked the workflow"), errors: [] };
    if (review.action === "COMPLETE") return { accepted: true, run: this.move(current, "COMPLETE", "Review completed the workflow"), errors: [] };

    const guard = evaluateLoopGuard(current, review);
    if (!guard.allowed) {
      current.iterationCount = guard.nextIterationCount;
      current.correctionCycles = guard.nextCorrectionCycles;
      current.repeatedFindings = guard.nextRepeatedFindings;
      current = this.db.updateRun(current);
      this.event(current.id, "LOOP_GUARD_BLOCKED", guard.reason ?? "Loop guard blocked dispatch", current.state);
      return { accepted: true, run: this.move(current, "BLOCKED", guard.reason ?? "Loop guard blocked dispatch"), errors: [] };
    }
    current.iterationCount = guard.nextIterationCount;
    current.correctionCycles = guard.nextCorrectionCycles;
    current.repeatedFindings = guard.nextRepeatedFindings;
    current = this.db.updateRun(current);
    if (current.autonomyMode !== "AUTONOMOUS") {
      this.db.createApproval(review.review_id);
      this.event(current.id, "APPROVAL_REQUIRED", `${current.autonomyMode} requires approval before dispatch`, current.state, { reviewId: review.review_id });
      return { accepted: true, run: this.move(current, "WAITING_APPROVAL", "Waiting for human approval") , errors: [] };
    }
    return { accepted: true, run: await this.dispatchAcceptedReview(current, review), errors: [] };
  }

  async approveReview(reviewId: string): Promise<Run> {
    const stored = this.db.getReview(reviewId);
    if (!stored) throw new Error("Review not found");
    if (!this.db.approveReview(reviewId)) throw new Error("Review is not awaiting approval");
    const run = this.requireRun(stored.review.run_id);
    if (run.state !== "WAITING_APPROVAL") throw new Error(`Run is not waiting for approval (${run.state})`);
    this.event(run.id, "APPROVAL_GRANTED", "Human approval granted", run.state, { reviewId });
    return this.dispatchAcceptedReview(run, stored.review);
  }

  recover(): Run[] {
    const runs = this.db.listNonTerminalRuns();
    for (const run of runs) this.event(run.id, "RECOVERY_CHECKED", `Recovered run in ${run.state}; no duplicate dispatch issued`, run.state);
    return runs;
  }

  private async dispatchAcceptedReview(run: Run, review: ReviewContract): Promise<Run> {
    const project = this.requireProject(run.projectId);
    let current = this.move(run, "DISPATCHING_NEXT", "Preparing next dispatch");
    const dispatchKey = `review-${review.review_id}`;
    if (this.db.hasDispatch(current.id, dispatchKey)) return this.move(current, "CODEX_RUNNING", "Existing dispatch reused after recovery");
    const threadRow = this.db.get<{ thread_id: string }>("SELECT thread_id FROM codex_threads WHERE run_id = ? ORDER BY created_at ASC LIMIT 1", current.id);
    if (!threadRow) throw new Error("Codex thread missing for next dispatch");
    try {
      await this.adapter.sendPrompt({ threadId: threadRow.thread_id, prompt: review.executor_prompt, cwd: project.localPath });
      this.db.recordDispatch(current.id, review.review_id, dispatchKey, review.executor_prompt);
      this.event(current.id, "DISPATCH_SENT", "Next prompt dispatched automatically", "CODEX_RUNNING", { dispatchKey, reviewId: review.review_id });
    } catch (error: unknown) {
      this.event(current.id, "DISPATCH_FAILED", error instanceof Error ? error.message : String(error), "FAILED");
      current = this.move(current, "FAILED", "Next dispatch failed", "DISPATCH_FAILED");
      return current;
    }
    current.currentPrompt = review.executor_prompt;
    return this.move(current, "CODEX_RUNNING", "Codex is running the next prompt");
  }

  private rejectReview(run: Run, reviewId: string, message: string, payload: Record<string, unknown> = {}): { accepted: false; run: Run; errors: string[] } {
    this.db.run("UPDATE reviews SET status = 'REJECTED' WHERE id = ?", reviewId);
    this.event(run.id, "REVIEW_REJECTED", message, run.state, payload);
    return { accepted: false, run, errors: [message] };
  }

  private requireRun(id: string): Run {
    const run = this.db.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  private requireProject(id: string) {
    const project = this.db.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  }
}

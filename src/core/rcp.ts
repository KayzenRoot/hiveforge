import type { ReviewContract, ReviewFinding, ReviewNextAction, ReviewVerdict } from "./types";

const verdicts = new Set<ReviewVerdict>(["APPROVED", "CORRECTION_REQUIRED", "BLOCKED", "COMPLETE"]);
const actions = new Set<ReviewNextAction>(["CONTINUE", "EXECUTE_CORRECTION", "WAIT", "STOP"]);
const severities = new Set<ReviewFinding["severity"]>(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const actionByVerdict: Record<ReviewVerdict, ReviewNextAction> = {
  APPROVED: "CONTINUE",
  CORRECTION_REQUIRED: "EXECUTE_CORRECTION",
  BLOCKED: "WAIT",
  COMPLETE: "STOP"
};

export interface RcpValidation {
  valid: boolean;
  value?: ReviewContract;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(data: Record<string, unknown>, field: string, errors: string[]): string {
  const value = data[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(field + " must be a non-empty string");
    return "";
  }
  return value;
}

function requiredSha(data: Record<string, unknown>, field: string, errors: string[]): string {
  const value = requiredString(data, field, errors);
  if (value && !shaPattern.test(value)) errors.push(field + " must be a full 40 or 64 character Git SHA");
  return value;
}

export function validateReviewContract(input: unknown): RcpValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ["RCP must be a JSON object"] };

  for (const legacyField of ["protocol", "version", "run_id", "decision", "action"]) {
    if (legacyField in input) errors.push(legacyField + " is not part of canonical RCP v0.1");
  }

  if (input.schema_version !== "0.1") errors.push("schema_version must be 0.1");
  const reviewId = requiredString(input, "review_id", errors);
  const projectId = requiredString(input, "project_id", errors);
  const workOrderId = requiredString(input, "work_order_id", errors);
  const baseSha = requiredSha(input, "base_sha", errors);
  const headSha = requiredSha(input, "head_sha", errors);
  const summary = requiredString(input, "summary", errors);
  const executorPrompt = requiredString(input, "executor_prompt", errors);
  const checkpointNote = requiredString(input, "checkpoint_note", errors);

  const progressPercent = input.progress_percent;
  if (typeof progressPercent !== "number" || !Number.isFinite(progressPercent) || !Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) {
    errors.push("progress_percent must be an integer between 0 and 100");
  }

  const verdict = input.verdict;
  const nextAction = input.next_action;
  if (!verdicts.has(verdict as ReviewVerdict)) errors.push("verdict is not supported");
  if (!actions.has(nextAction as ReviewNextAction)) errors.push("next_action is not supported");
  if (verdicts.has(verdict as ReviewVerdict) && actions.has(nextAction as ReviewNextAction) && actionByVerdict[verdict as ReviewVerdict] !== nextAction) {
    errors.push(String(verdict) + " requires next_action " + actionByVerdict[verdict as ReviewVerdict]);
  }

  const rawFindings = input.findings;
  const findings: ReviewFinding[] = [];
  if (!Array.isArray(rawFindings)) {
    errors.push("findings must be an array");
  } else {
    rawFindings.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push("findings[" + index + "] must be an object");
        return;
      }
      const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : "";
      const title = typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title : "";
      const details = typeof raw.details === "string" && raw.details.trim().length > 0 ? raw.details : "";
      if (!id) errors.push("findings[" + index + "].id must be a non-empty string");
      if (!title) errors.push("findings[" + index + "].title must be a non-empty string");
      if (!details) errors.push("findings[" + index + "].details must be a non-empty string");
      const severity = raw.severity;
      if (!severities.has(severity as ReviewFinding["severity"])) errors.push("findings[" + index + "].severity is not supported");
      findings.push({ id, title, details, severity: severity as ReviewFinding["severity"] });
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    value: {
      schemaVersion: "0.1",
      reviewId,
      projectId,
      workOrderId,
      baseSha,
      headSha,
      verdict: verdict as ReviewVerdict,
      progressPercent: progressPercent as number,
      summary,
      findings,
      nextAction: nextAction as ReviewNextAction,
      executorPrompt,
      checkpointNote
    }
  };
}

export function serializeReviewContract(review: ReviewContract): Record<string, unknown> {
  return {
    schema_version: review.schemaVersion,
    review_id: review.reviewId,
    project_id: review.projectId,
    work_order_id: review.workOrderId,
    base_sha: review.baseSha,
    head_sha: review.headSha,
    verdict: review.verdict,
    progress_percent: review.progressPercent,
    summary: review.summary,
    findings: review.findings.map((finding) => ({ id: finding.id, severity: finding.severity, title: finding.title, details: finding.details })),
    next_action: review.nextAction,
    executor_prompt: review.executorPrompt,
    checkpoint_note: review.checkpointNote
  };
}

export function reviewSemantics(): Record<ReviewVerdict, string> {
  return {
    APPROVED: "The reviewed increment is acceptable; CONTINUE may dispatch the executor subject to autonomy policy.",
    CORRECTION_REQUIRED: "The reviewed increment needs correction; EXECUTE_CORRECTION may dispatch the supplied executor prompt subject to autonomy policy.",
    BLOCKED: "The workflow is blocked and remains safe; WAIT records the blocker without autonomous dispatch.",
    COMPLETE: "The work order is complete; STOP closes the run without dispatch."
  };
}

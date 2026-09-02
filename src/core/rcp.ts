import type { ReviewAction, ReviewContract, ReviewDecision, ReviewFinding } from "./types";

const decisions = new Set<ReviewDecision>(["APPROVED", "CORRECTION_REQUIRED", "BLOCKED", "COMPLETE"]);
const actions = new Set<ReviewAction>(["CONTINUE", "EXECUTE_CORRECTION", "BLOCKED", "COMPLETE"]);
const severities = new Set<ReviewFinding["severity"]>(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

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
    errors.push(`${field} must be a non-empty string`);
    return "";
  }
  return value;
}

export function validateReviewContract(input: unknown): RcpValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ["RCP must be a JSON object"] };

  const protocol = input.protocol;
  const version = input.version;
  if (protocol !== "RCP") errors.push("protocol must be RCP");
  if (version !== "0.1") errors.push("version must be 0.1");

  const review_id = requiredString(input, "review_id", errors);
  const project_id = requiredString(input, "project_id", errors);
  const run_id = requiredString(input, "run_id", errors);
  const work_order_id = requiredString(input, "work_order_id", errors);
  const head_sha = requiredString(input, "head_sha", errors);
  const base_sha = requiredString(input, "base_sha", errors);
  const executor_prompt = requiredString(input, "executor_prompt", errors);
  const created_at = requiredString(input, "created_at", errors);

  const decision = input.decision;
  const action = input.action;
  if (!decisions.has(decision as ReviewDecision)) errors.push("decision is not supported");
  if (!actions.has(action as ReviewAction)) errors.push("action is not supported");
  if (decision === "APPROVED" && action !== "CONTINUE") errors.push("APPROVED requires CONTINUE");
  if (decision === "CORRECTION_REQUIRED" && action !== "EXECUTE_CORRECTION") errors.push("CORRECTION_REQUIRED requires EXECUTE_CORRECTION");
  if (decision === "BLOCKED" && action !== "BLOCKED") errors.push("BLOCKED requires BLOCKED");
  if (decision === "COMPLETE" && action !== "COMPLETE") errors.push("COMPLETE requires COMPLETE");

  const rawFindings = input.findings;
  const findings: ReviewFinding[] = [];
  if (!Array.isArray(rawFindings)) {
    errors.push("findings must be an array");
  } else {
    rawFindings.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      const id = requiredString(raw, "id", errors);
      const summary = requiredString(raw, "summary", errors);
      const severity = raw.severity;
      if (!severities.has(severity as ReviewFinding["severity"])) errors.push(`findings[${index}].severity is not supported`);
      findings.push({ id, summary, severity: severity as ReviewFinding["severity"] });
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    value: {
      protocol: "RCP",
      version: "0.1",
      review_id,
      project_id,
      run_id,
      work_order_id,
      decision: decision as ReviewDecision,
      action: action as ReviewAction,
      head_sha,
      base_sha,
      findings,
      executor_prompt,
      created_at
    }
  };
}

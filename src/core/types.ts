export const AUTONOMY_MODES = ["AUTONOMOUS", "GUARDED", "CONTROLLED"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const RUN_STATES = [
  "IDLE",
  "QUEUED",
  "CODEX_RUNNING",
  "VALIDATING",
  "GIT_SYNC",
  "WAITING_REVIEW",
  "REVIEW_RECEIVED",
  "WAITING_APPROVAL",
  "DISPATCHING_NEXT",
  "PAUSED",
  "BLOCKED",
  "COMPLETE",
  "FAILED"
] as const;
export type RunState = (typeof RUN_STATES)[number];

export type ReviewDecision = "APPROVED" | "CORRECTION_REQUIRED" | "BLOCKED" | "COMPLETE";
export type ReviewAction = "CONTINUE" | "EXECUTE_CORRECTION" | "BLOCKED" | "COMPLETE";
export type ReviewStatus = "RECEIVED" | "ACCEPTED" | "REJECTED" | "CONSUMED";

export interface ProjectInput {
  name: string;
  localPath: string;
  remoteUrl?: string;
  defaultBranch: string;
  workingBranch: string;
  testCommand: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
  autonomyMode: AutonomyMode;
  reviewMailboxPath: string;
}

export interface Project extends ProjectInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  workOrderId: string;
  state: RunState;
  autonomyMode: AutonomyMode;
  maxIterations: number;
  maxCorrectionCycles: number;
  repeatedFindingThreshold: number;
  iterationCount: number;
  correctionCycles: number;
  repeatedFindings: Record<string, number>;
  currentPrompt: string | null;
  expectedBaseSha: string | null;
  expectedHeadSha: string | null;
  lastReviewId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  type: string;
  state: RunState | null;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GitEvidence {
  id: string;
  runId: string;
  baseSha: string;
  headSha: string;
  branch: string;
  status: string;
  changedFiles: string[];
  diffSummary: string;
  capturedAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  summary: string;
}

export interface ReviewContract {
  protocol: "RCP";
  version: "0.1";
  review_id: string;
  project_id: string;
  run_id: string;
  work_order_id: string;
  decision: ReviewDecision;
  action: ReviewAction;
  head_sha: string;
  base_sha: string;
  findings: ReviewFinding[];
  executor_prompt: string;
  created_at: string;
}

export interface CodexThread {
  id: string;
  runId: string;
  provider: "codex-app-server" | "fake";
  threadId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexAdapter {
  readonly provider: "codex-app-server" | "fake";
  startThread(input: { cwd: string; projectId?: string }): Promise<{ threadId: string }>;
  sendPrompt(input: { threadId: string; prompt: string; cwd: string }): Promise<{ turnId: string | null }>;
  close?(): Promise<void>;
}

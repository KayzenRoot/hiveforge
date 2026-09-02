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

export type ReviewVerdict = "APPROVED" | "CORRECTION_REQUIRED" | "BLOCKED" | "COMPLETE";
export type ReviewNextAction = "CONTINUE" | "EXECUTE_CORRECTION" | "WAIT" | "STOP";
export type ReviewStatus = "RECEIVED" | "ACCEPTED" | "REJECTED" | "CONSUMED";
export type ValidationKind = "test" | "lint" | "typecheck" | "build";
export type ValidationStatus = "PASS" | "FAIL" | "NOT_CONFIGURED" | "ERROR";
export type CodexTurnStatus = "PREPARED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "CANCELLED" | "ORPHANED";

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
  runBaseSha: string | null;
  runBaseBranch: string | null;
  expectedBaseSha: string | null;
  expectedHeadSha: string | null;
  lastReviewId: string | null;
  lastReviewStatus: ReviewStatus | null;
  lastReviewVerdict: ReviewVerdict | null;
  lastReviewSummary: string | null;
  lastCheckpointNote: string | null;
  progressPercent: number;
  currentBlocker: string | null;
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
  isClean: boolean;
  capturedAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  details: string;
}

export interface ReviewContract {
  schemaVersion: "0.1";
  reviewId: string;
  projectId: string;
  workOrderId: string;
  baseSha: string;
  headSha: string;
  verdict: ReviewVerdict;
  progressPercent: number;
  summary: string;
  findings: ReviewFinding[];
  nextAction: ReviewNextAction;
  executorPrompt: string;
  checkpointNote: string;
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

export interface CodexTurn {
  id: string;
  runId: string;
  threadId: string;
  turnId: string;
  dispatchKey: string;
  prompt: string;
  status: CodexTurnStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  validationStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResult {
  id: string;
  runId: string;
  turnId: string;
  kind: ValidationKind;
  command: string | null;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: ValidationStatus;
}

export interface ReviewSnapshot {
  status: ReviewStatus;
  review: ReviewContract;
}

export interface CodexTurnLifecycleEvent {
  kind: "turn";
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  error?: string;
  payload: Record<string, unknown>;
}

export interface CodexNotificationEvent {
  kind: "notification";
  method: string;
  threadId?: string;
  payload: Record<string, unknown>;
}

export type CodexLifecycleEvent = CodexTurnLifecycleEvent | CodexNotificationEvent;

export interface RunOverview {
  run: Run;
  gitEvidence: GitEvidence | null;
  validations: ValidationResult[];
  review: ReviewSnapshot | null;
  events: RunEvent[];
}

export interface CodexAdapter {
  readonly provider: "codex-app-server" | "fake";
  setEventHandler(handler: (event: CodexLifecycleEvent) => void): void;
  startThread(input: { cwd: string; projectId?: string }): Promise<{ threadId: string }>;
  sendPrompt(input: { threadId: string; prompt: string; cwd: string }): Promise<{ turnId: string | null }>;
  close?(): Promise<void>;
}

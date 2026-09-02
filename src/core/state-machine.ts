import type { RunState } from "./types";

const transitions: Record<RunState, readonly RunState[]> = {
  IDLE: ["QUEUED", "FAILED"],
  QUEUED: ["CODEX_RUNNING", "PAUSED", "FAILED"],
  CODEX_RUNNING: ["VALIDATING", "PAUSED", "BLOCKED", "FAILED"],
  VALIDATING: ["GIT_SYNC", "BLOCKED", "FAILED"],
  GIT_SYNC: ["WAITING_REVIEW", "BLOCKED", "FAILED"],
  WAITING_REVIEW: ["REVIEW_RECEIVED", "PAUSED", "BLOCKED", "FAILED"],
  REVIEW_RECEIVED: ["WAITING_APPROVAL", "DISPATCHING_NEXT", "BLOCKED", "COMPLETE", "FAILED"],
  WAITING_APPROVAL: ["DISPATCHING_NEXT", "PAUSED", "BLOCKED", "FAILED"],
  DISPATCHING_NEXT: ["CODEX_RUNNING", "BLOCKED", "FAILED"],
  PAUSED: ["QUEUED", "CODEX_RUNNING", "FAILED"],
  BLOCKED: ["QUEUED", "FAILED"],
  COMPLETE: [],
  FAILED: []
};

export function canTransition(from: RunState, to: RunState): boolean {
  return transitions[from].includes(to);
}

export function transition(from: RunState, to: RunState): RunState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
  return to;
}

export function allowedTransitions(from: RunState): readonly RunState[] {
  return transitions[from];
}

export function isTerminalState(state: RunState): boolean {
  return state === "COMPLETE" || state === "FAILED";
}

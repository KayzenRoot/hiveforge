import type { RunEvent } from "./types";

type Listener = (event: RunEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  publish(event: RunEvent): void {
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }
}

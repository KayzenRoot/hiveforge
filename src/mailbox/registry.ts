import { ReviewMailboxWatcher, type MailboxCallbacks } from "./watcher";
import type { Project } from "../core/types";

interface RegisteredWatcher {
  mailboxPath: string;
  watcher: ReviewMailboxWatcher;
}

export class MailboxWatcherRegistry {
  private readonly watchers = new Map<string, RegisteredWatcher>();

  constructor(private readonly callbacksFor: (project: Project) => MailboxCallbacks) {}

  async reconcile(projects: Project[]): Promise<void> {
    const wanted = new Map(projects.map((project) => [project.id, project]));
    for (const [projectId, registered] of this.watchers) {
      const project = wanted.get(projectId);
      if (!project || project.reviewMailboxPath !== registered.mailboxPath) {
        registered.watcher.stop();
        this.watchers.delete(projectId);
      }
    }
    for (const project of projects) {
      if (this.watchers.has(project.id)) continue;
      const watcher = new ReviewMailboxWatcher(project.reviewMailboxPath, this.callbacksFor(project));
      await watcher.start();
      this.watchers.set(project.id, { mailboxPath: project.reviewMailboxPath, watcher });
    }
  }

  async scanAll(): Promise<void> {
    await Promise.all([...this.watchers.values()].map(({ watcher }) => watcher.scan()));
  }

  stopAll(): void {
    for (const { watcher } of this.watchers.values()) watcher.stop();
    this.watchers.clear();
  }

  get size(): number {
    return this.watchers.size;
  }
}

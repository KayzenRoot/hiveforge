import { ReviewMailboxWatcher } from "./mailbox/watcher";
import { getRuntime } from "./server/runtime";

async function main() {
  const runtime = getRuntime();
  const watchers: ReviewMailboxWatcher[] = [];
  for (const project of runtime.db.listProjects()) {
    const watcher = new ReviewMailboxWatcher(project.reviewMailboxPath, {
      onReview: async (review) => {
        const result = await runtime.engine.processReview(review);
        if (!result.accepted && result.run) {
          const event = runtime.db.appendEvent(result.run.id, "REVIEW_REJECTED", result.errors.join("; "), result.run.state);
          runtime.events.publish(event);
        }
      },
      onRejected: async (input) => {
        runtime.db.appendMailboxEvent(input.file, "REJECTED", input.errors.join("; "));
        console.warn(`[hiveforge] mailbox rejected ${input.file}: ${input.errors.join("; ")}`);
      }
    });
    await watcher.start();
    watchers.push(watcher);
  }
  process.on("SIGINT", () => { watchers.forEach((watcher) => watcher.stop()); process.exit(0); });
  process.on("SIGTERM", () => { watchers.forEach((watcher) => watcher.stop()); process.exit(0); });
  console.log(`HiveForge worker watching ${watchers.length} mailbox(es)`);
  setInterval(() => { for (const watcher of watchers) void watcher.scan(); }, 5_000);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

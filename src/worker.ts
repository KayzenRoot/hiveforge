import { MailboxWatcherRegistry } from "./mailbox/registry";
import { getRuntime } from "./server/runtime";

async function main() {
  const runtime = getRuntime();
  const registry = new MailboxWatcherRegistry(() => ({
    onReview: async (review) => {
      const result = await runtime.engine.processReview(review);
      if (!result.accepted && result.run) {
        const event = runtime.db.appendEvent(result.run.id, "REVIEW_REJECTED", result.errors.join("; "), result.run.state);
        runtime.events.publish(event);
      }
    },
    onRejected: async (input) => {
      runtime.db.appendMailboxEvent(input.file, "REJECTED", input.errors.join("; "));
      console.warn("[hiveforge] mailbox rejected " + input.file + ": " + input.errors.join("; "));
    }
  }));

  const reconcile = async () => {
    try {
      await registry.reconcile(runtime.db.listProjects());
    } catch (error) {
      console.error("[hiveforge] mailbox reconciliation failed", error);
    }
  };
  await reconcile();
  const interval = setInterval(() => { void reconcile(); void registry.scanAll(); }, 5_000);
  const shutdown = () => {
    clearInterval(interval);
    registry.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log("HiveForge worker watching " + registry.size + " mailbox(es); dynamic reconciliation enabled");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

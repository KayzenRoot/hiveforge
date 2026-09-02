import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { validateReviewContract } from "../core/rcp";
import type { ReviewContract } from "../core/types";

export interface MailboxCallbacks {
  onReview: (review: ReviewContract) => Promise<void> | void;
  onRejected: (input: { file: string; errors: string[] }) => Promise<void> | void;
}

export class ReviewMailboxWatcher {
  private watcher: ReturnType<typeof import("node:fs").watch> | null = null;
  private processing = new Set<string>();

  constructor(private readonly mailboxPath: string, private readonly callbacks: MailboxCallbacks) {}

  async start(): Promise<void> {
    await mkdir(this.mailboxPath, { recursive: true });
    await this.scan();
    const { watch } = await import("node:fs");
    this.watcher = watch(this.mailboxPath, () => {
      void this.scan();
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  async scan(): Promise<void> {
    await mkdir(this.mailboxPath, { recursive: true });
    const entries = await readdir(this.mailboxPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      await this.processFile(join(this.mailboxPath, entry.name));
    }
  }

  private async processFile(filePath: string): Promise<void> {
    if (this.processing.has(filePath)) return;
    this.processing.add(filePath);
    try {
      let input: unknown;
      try {
        input = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid JSON";
        await this.callbacks.onRejected({ file: filePath, errors: [message] });
        await this.moveTo(filePath, "rejected");
        return;
      }
      const parsed = validateReviewContract(input);
      if (!parsed.valid || !parsed.value) {
        await this.callbacks.onRejected({ file: filePath, errors: parsed.errors });
        await this.moveTo(filePath, "rejected");
        return;
      }
      try {
        await this.callbacks.onReview(parsed.value);
        await this.moveTo(filePath, "processed");
      } catch (error) {
        await this.callbacks.onRejected({ file: filePath, errors: [error instanceof Error ? error.message : String(error)] });
        await this.moveTo(filePath, "failed");
      }
    } finally {
      this.processing.delete(filePath);
    }
  }

  private async moveTo(filePath: string, bucket: "processed" | "rejected" | "failed"): Promise<void> {
    const directory = join(this.mailboxPath, `.${bucket}`);
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${Date.now()}-${filePath.split(/[\\/]/).pop() ?? "review.json"}`);
    await rename(filePath, target);
  }
}

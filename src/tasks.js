// Create a YouCam task and poll it until it finishes, retrying 429s with backoff.
import { YouCamError } from "./providers/errors.js";

// The first interval is provisional until the live API's latency is measured; the docs suggest polling
// about every 10 seconds, so the interval grows to that.
export const POLL = Object.freeze({ firstMs: 2000, factor: 1.5, maxMs: 10000 });
export const RATE_LIMIT_RETRY = Object.freeze({ firstMs: 1000, factor: 2, tries: 5 });

export async function retryRateLimited(fn, wait) {
  let delay = RATE_LIMIT_RETRY.firstMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof YouCamError) || e.code !== "RateLimited" || attempt >= RATE_LIMIT_RETRY.tries) throw e;
      await wait(delay);
      delay *= RATE_LIMIT_RETRY.factor;
    }
  }
}

// The shopper stopped waiting for a task that was still running. The task is not abandoned:
// closing the check hands it to the background finisher, which deletes it when it ends.
export class StoppedWaiting extends Error {
  constructor(feature, taskId) {
    super(`stopped waiting for ${feature} task ${taskId}`);
    this.feature = feature;
    this.taskId = taskId;
  }
}

// onCreated runs as soon as the task exists, so a check records every task it must delete
// even when polling later fails. stopped() is asked after every poll that is still running.
export async function runTaskToEnd(provider, feature, body, { wait, onCreated, stopped = () => false }) {
  const { taskId } = await retryRateLimited(() => provider.runTask(feature, body), wait);
  onCreated(taskId);
  let delay = POLL.firstMs;
  for (;;) {
    const r = await retryRateLimited(() => provider.pollTask(feature, taskId), wait);
    if (r.status !== "running") return { taskId, ...r };
    if (stopped()) throw new StoppedWaiting(feature, taskId);
    await wait(delay);
    delay = Math.min(delay * POLL.factor, POLL.maxMs);
  }
}

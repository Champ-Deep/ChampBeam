/**
 * FastAPI `BackgroundTasks.add_task(...)` -> `background(c, () => work())`.
 *
 * Runs after the response is sent via ExecutionContext.waitUntil; errors are
 * logged, never surfaced (same as Starlette background tasks).
 */
import type { Context } from "hono";

export function background(c: Context, task: () => Promise<unknown>, label = "background task"): void {
  const p = (async () => {
    try {
      await task();
    } catch (err) {
      console.error(`${label} failed`, err);
    }
  })();
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No ExecutionContext (e.g. direct app.request in a unit test): the promise
    // still runs; nothing to attach it to.
  }
}

/** Worker entry: HTTP via the Hono app, cron via runScheduled. */
import { app } from "./app";
import type { Env } from "./env";
import { runScheduled } from "./cron";

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;

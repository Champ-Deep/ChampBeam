/** Worker entry: HTTP via the Hono app, cron via runScheduled. */
import { app } from "./app";
import type { Env } from "./env";
import { runScheduled } from "./cron";
import { withObservability } from "./lib/observability";

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => withObservability(env, ctx, () => app.fetch(req, env, ctx)),
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(withObservability(env, ctx, () => runScheduled(controller.cron, env)));
  },
} satisfies ExportedHandler<Env>;

/**
 * Forward alerts API, mounted at /api/v1/alerts. Owner only: every query is scoped to the caller's
 * user_id, so another user's alert id answers 404. Drafts are copy-only: nothing here sends mail.
 *
 * - GET  /forwards?status=open|all&limit=20 -> {alerts, unread}
 * - POST /forwards/:id/seen, /forwards/:id/dismiss -> 204 (idempotent)
 * - POST /forwards/:id/draft (signed-in session only) -> {draft, sender_notes}
 */
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireSessionAuth } from "../auth/security";
import type { AppEnv, Ctx } from "../env";
import { httpError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { parseQuery } from "../lib/validate";
import { completeJob } from "../services/agentJobs";
import { AssistantError } from "../services/assistant";
import {
  PRIVACY_REJECT, alertAsset, alertCities, alertTopics, alertVisitors, checkDraft, followupContext, followupMessages, senderNotes,
} from "../services/forwardAlerts";
import { normUuid } from "./_utmHelpers";

export const router = new Hono<AppEnv>({ strict: false });

type Row = Record<string, any>;
const DRAFTS_PER_MINUTE = 6;

/** The caller's alert or 404. */
async function ownAlert(c: Ctx, userId: string): Promise<Row> {
  const id = normUuid(c.req.param("id"));
  const row = id ? await c.env.DB.prepare("SELECT * FROM forward_alerts WHERE id = ? AND user_id = ?").bind(id, userId).first<Row>() : null;
  if (!row) httpError(404, "Alert not found");
  return row!;
}

const draftOf = (a: Row) =>
  a.draft_body ? { subject: a.draft_subject, body: a.draft_body, model: a.draft_model, created_at: a.draft_created_at } : null;

async function present(c: Ctx, a: Row) {
  const [asset, topics] = await Promise.all([alertAsset(c, a), alertTopics(c.env.DB, a)]);
  return {
    id: a.id, asset, reason: a.reason, cities: alertCities(a), visitors: alertVisitors(a).length, company_name: a.company_name ?? null,
    detected_at: a.detected_at, seen_at: a.seen_at ?? null, dismissed_at: a.dismissed_at ?? null, draft: draftOf(a),
    sender_notes: senderNotes(a, topics),
  };
}

router.get("/forwards", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(c, z.object({ status: z.enum(["open", "all"]).default("open"), limit: z.coerce.number().int().min(1).max(100).default(20) }));
  const open = q.status === "open" ? "AND dismissed_at IS NULL" : "";
  const [rows, unread] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM forward_alerts WHERE user_id = ? ${open} ORDER BY detected_at DESC, id DESC LIMIT ?`).bind(user.userId, q.limit).all<Row>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM forward_alerts WHERE user_id = ? AND dismissed_at IS NULL AND seen_at IS NULL").bind(user.userId).first<Row>(),
  ]);
  return c.json({ alerts: await Promise.all((rows.results ?? []).map((a) => present(c, a))), unread: Number(unread?.n ?? 0) });
});

for (const [path, col] of [["seen", "seen_at"], ["dismiss", "dismissed_at"]] as const) {
  router.post(`/forwards/:id/${path}`, async (c) => {
    const user = await requireAuth(c);
    const a = await ownAlert(c, user.userId);
    await c.env.DB.prepare(`UPDATE forward_alerts SET ${col} = COALESCE(${col}, ?) WHERE id = ? AND user_id = ?`)
      .bind(new Date().toISOString(), a.id, user.userId)
      .run();
    return c.body(null, 204);
  });
}

router.post("/forwards/:id/draft", async (c) => {
  const user = await requireSessionAuth(c);
  const a = await ownAlert(c, user.userId);
  await enforceLimit(c.env.DB, `agent:draft:${user.userId}`, DRAFTS_PER_MINUTE, 60, "Too many drafts. Wait a minute and try again.");
  const ctx = await followupContext(c, a);
  let out: Awaited<ReturnType<typeof completeJob>>;
  try {
    out = await completeJob(c, user.userId, "forward_followup", followupMessages(ctx));
  } catch (err) {
    if (err instanceof AssistantError) httpError(err.status, err.detail);
    throw err;
  }
  const draft = checkDraft(out.reply, alertCities(a));
  if (!draft) httpError(502, PRIVACY_REJECT);
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE forward_alerts SET draft_subject = ?, draft_body = ?, draft_model = ?, draft_created_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(draft!.subject, draft!.body, out.model, createdAt, a.id, user.userId)
    .run();
  return c.json({ draft: { ...draft!, model: out.model, created_at: createdAt }, sender_notes: ctx.sender_notes });
});

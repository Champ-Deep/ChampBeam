/**
 * Project management API. Port of backend/app/api/v1/projects.py — mounted at
 * /api/v1/projects.
 */
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/security";
import type { AppEnv } from "../env";
import { httpError } from "../lib/errors";
import { isoNaive } from "../lib/time";
import { parseJson } from "../lib/validate";
import {
  type Project,
  createProject,
  deleteProject,
  getProject,
  getProjectStats,
  listProjects,
  updateProject,
} from "../services/project";

export const router = new Hono<AppEnv>({ strict: false });

const ProjectCreate = z.object({
  name: z.string(),
  description: z.string().nullish(),
});

const ProjectUpdate = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
});

/** ProjectResponse (created_at is `datetime.isoformat()` of the naive UTC value). */
function projectOut(p: Project, stats: { link_count: number; total_clicks: number } = { link_count: 0, total_clicks: 0 }) {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    link_count: stats.link_count,
    total_clicks: stats.total_clicks,
    created_at: p.createdAt ? (isoNaive(p.createdAt) ?? "") : "",
  };
}

/** List all projects for the authenticated user. */
router.get("/", async (c) => {
  const user = await requireAuth(c);
  const db = c.var.db;
  const out = [];
  for (const p of await listProjects(db, user.userId)) {
    out.push(projectOut(p, await getProjectStats(db, p.id)));
  }
  return c.json(out);
});

/** Create a new project. */
router.post("/", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, ProjectCreate);
  const project = await createProject(c.var.db, user.userId, data.name, data.description ?? null);
  return c.json(projectOut(project), 201);
});

/** Update an existing project. */
router.put("/:project_id", async (c) => {
  const user = await requireAuth(c);
  const data = await parseJson(c, ProjectUpdate);
  const db = c.var.db;
  const found = await getProject(db, c.req.param("project_id").toLowerCase(), user.userId);
  if (!found) httpError(404, "Project not found");
  const project = await updateProject(db, found!, data.name, data.description);
  return c.json(projectOut(project, await getProjectStats(db, project.id)));
});

/** Delete a project. Links in this project are preserved (project_id set to NULL). */
router.delete("/:project_id", async (c) => {
  const user = await requireAuth(c);
  const db = c.var.db;
  const project = await getProject(db, c.req.param("project_id").toLowerCase(), user.userId);
  if (!project) httpError(404, "Project not found");
  await deleteProject(db, project!);
  return new Response(null, { status: 204 });
});

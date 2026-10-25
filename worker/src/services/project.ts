/**
 * Project CRUD. Port of backend/app/services/project_service.py.
 *
 * Exports:
 *   type Project
 *   createProject(db: Db, userId: string, name: string, description: string | null): Promise<Project>
 *   listProjects(db: Db, userId: string): Promise<Project[]>                 (newest first)
 *   getProject(db: Db, projectId: string, userId: string): Promise<Project | null>
 *   updateProject(db: Db, project: Project, name: string | null | undefined, description: string | null | undefined): Promise<Project>
 *   deleteProject(db: Db, project: Project): Promise<void>                   (links/files keep existing, project_id -> NULL)
 *   getProjectStats(db: Db, projectId: string): Promise<{ link_count: number; total_clicks: number }>
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { linkClicks, projects } from "../db/schema";
import { nowIso } from "../lib/time";

export type Project = typeof projects.$inferSelect;

export async function createProject(db: Db, userId: string, name: string, description: string | null): Promise<Project> {
  const now = nowIso();
  return (await db
    .insert(projects)
    .values({ id: crypto.randomUUID(), userId, name, description, createdAt: now, updatedAt: now })
    .returning()
    .get()) as Project;
}

export async function listProjects(db: Db, userId: string): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.createdAt)).all();
}

export async function getProject(db: Db, projectId: string, userId: string): Promise<Project | null> {
  const row = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .get();
  return row ?? null;
}

/** Apply non-null fields and bump updated_at (the passed object is updated in place too). */
export async function updateProject(
  db: Db,
  project: Project,
  name: string | null | undefined,
  description: string | null | undefined,
): Promise<Project> {
  const set: Partial<typeof projects.$inferInsert> = { updatedAt: nowIso() };
  if (name != null) set.name = name;
  if (description != null) set.description = description;
  await db.update(projects).set(set).where(eq(projects.id, project.id)).run();
  Object.assign(project, set);
  return project;
}

/** Delete a project; its links are detached (SQLAlchemy nulled LinkClick.project_id). */
export async function deleteProject(db: Db, project: Project): Promise<void> {
  await db.batch([
    db.update(linkClicks).set({ projectId: null }).where(eq(linkClicks.projectId, project.id)),
    db.delete(projects).where(eq(projects.id, project.id)),
  ]);
}

/** Link count and total clicks for a project. */
export async function getProjectStats(db: Db, projectId: string): Promise<{ link_count: number; total_clicks: number }> {
  const row = await db
    .select({
      linkCount: sql<number>`COUNT(${linkClicks.id})`,
      totalClicks: sql<number>`COALESCE(SUM(${linkClicks.clickCount}), 0)`,
    })
    .from(linkClicks)
    .where(eq(linkClicks.projectId, projectId))
    .get();
  return { link_count: Number(row?.linkCount ?? 0), total_clicks: Number(row?.totalClicks ?? 0) };
}

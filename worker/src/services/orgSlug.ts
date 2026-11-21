/** Org slug rules shared by Better Auth's create/update hooks and the super-admin create route. */
export const RESERVED_SLUGS = new Set(["admin", "api", "www", "app", "champbeam"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A human reason the slug is refused, or null when it is acceptable. Uniqueness is the DB's job. */
export function slugProblem(slug: unknown): string | null {
  if (typeof slug !== "string" || !slug) return "Organization slug is required.";
  if (!SLUG_RE.test(slug)) return "Slug must be lowercase letters, digits and hyphens, 1 to 40 characters.";
  if (RESERVED_SLUGS.has(slug)) return `The slug "${slug}" is reserved.`;
  return null;
}

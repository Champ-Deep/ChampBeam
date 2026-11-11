/** Pure rules behind the self-serve org screens, kept out of component files so they test alone. */

export interface MemberRow { memberId: string | null; userId: string; name: string; email: string; image: string | null; role: string; joinedAt: string | null }

export const isAdminRole = (role: string) => role === 'admin' || role === 'owner';

/**
 * Why an action on this row is refused, or null when it may run. Stated next to the control instead of failing
 * on submit. The server enforces the same rules (Better Auth's last-owner checks).
 */
export function refusal(row: MemberRow, action: 'remove' | 'role', ctx: { me: string | null; adminCount: number; nextRole?: string }): string | null {
  if (!row.memberId) return 'You are viewing this organization as super admin. Add yourself as a member to change roles.';
  if (action === 'remove' && row.userId === ctx.me) return 'You cannot remove yourself. Another admin can.';
  const losesAdmin = action === 'remove' || (ctx.nextRole !== undefined && !isAdminRole(ctx.nextRole));
  if (isAdminRole(row.role) && losesAdmin && ctx.adminCount <= 1) return 'The last admin cannot be removed or demoted. Make someone else an admin first.';
  return null;
}

/** "Copy all" text for invite links: one line per invite, address then link. */
export function linksBlock(results: { email: string; url: string }[]): string {
  return results.map((r) => `${r.email}: ${r.url}`).join('\n');
}

export interface DnsRecord { type: 'CNAME' | 'TXT'; name: string; value: string }

/**
 * The records a domain needs. shortcut: CNAME only, because the domain API does not return Cloudflare's TXT
 * ownership and certificate records yet; add them here when it does (follow-up card).
 */
export function dnsRecordsFor(hostname: string, cnameTarget: string): DnsRecord[] {
  return [{ type: 'CNAME', name: hostname, value: cnameTarget }];
}

/** One plain-text block an IT team can paste into a ticket. */
export function recordsForIt(hostname: string, records: DnsRecord[]): string {
  return [`DNS records for ${hostname}`, '', ...records.flatMap((r) => [`Type: ${r.type}`, `Name: ${r.name}`, `Value: ${r.value}`, ''])].join('\n').trimEnd();
}

/** Where to go after sign-in: a same-site path from ?next (an invitation, say), never another origin. */
export function nextPath(params: URLSearchParams): string {
  const next = params.get('next') ?? '';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

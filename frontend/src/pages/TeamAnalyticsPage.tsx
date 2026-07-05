import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BarChart3, ChevronDown, ChevronRight, Crown, Shield, Users } from 'lucide-react';
import { Badge, Card, CardHeader, CardTitle, EmptyState, LoadingSpinner } from '../components/ui';
import {
  orgApi,
  type ContentBreakdown,
  type ContentPerformanceReport,
  type MemberStats,
  type OrgContext,
} from '../api/org';
import { useOrgContext } from '../hooks/useOrgContext';

function isAdminRole(role: string) {
  return role.toLowerCase().endsWith('admin');
}
function isLeaderRole(role: string) {
  return role.toLowerCase() === 'leader';
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="flex-1">
      <div className="p-1">
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
      </div>
    </Card>
  );
}

export function TeamAnalyticsPage() {
  const { isAdmin } = useOrgContext();
  const { data: context } = useQuery<OrgContext>({
    queryKey: ['org-context'],
    queryFn: () => orgApi.getContext(),
  });

  const { data: report, isLoading } = useQuery<ContentPerformanceReport>({
    queryKey: ['org-content-performance'],
    queryFn: () => orgApi.contentPerformance(),
  });

  const { data: members = [] } = useQuery<MemberStats[]>({
    queryKey: ['org-members'],
    queryFn: () => orgApi.listMembers(),
  });

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Team Analytics</h1>
        <p className="text-slate-600 mt-1">
          Consolidated content performance across {context?.name ?? 'your team'} — the same content
          shared by different members rolls up to one item.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <StatTile label="Members" value={context?.member_count ?? '—'} />
        <StatTile label="Content items" value={report?.total_content ?? '—'} />
        <StatTile label="Total shares" value={report?.total_shares ?? '—'} />
        <StatTile label="Total opens" value={report?.total_opens ?? '—'} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-brand-purple" />
            Best-performing content
          </CardTitle>
        </CardHeader>
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <LoadingSpinner />
          </div>
        ) : !report || report.items.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No engagement yet"
            description="Once members share content and clients open it, performance shows up here."
          />
        ) : (
          <div className="divide-y divide-slate-100 -mx-6 -mb-6">
            {report.items.map((item, idx) => (
              <ContentPerformanceRow key={item.content_id} rank={idx + 1} item={item} />
            ))}
          </div>
        )}
      </Card>

      <MembersCard members={members} canAssignLeaders={isAdmin} />
    </div>
  );
}

function MembersCard({ members, canAssignLeaders }: { members: MemberStats[]; canAssignLeaders: boolean }) {
  const queryClient = useQueryClient();

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.user_id, m.full_name || m.email || m.user_id.slice(0, 8));
    return map;
  }, [members]);

  // Candidate leaders a rep can report to (leaders + admins).
  const leaders = useMemo(
    () => members.filter((m) => isLeaderRole(m.role) || isAdminRole(m.role)),
    [members],
  );

  const assign = useMutation({
    mutationFn: ({ userId, leaderId }: { userId: string; leaderId: string | null }) =>
      orgApi.assignMemberLeader(userId, leaderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-members'] });
      toast.success('Team updated.');
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
          'Could not update the team.',
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-brand-purple" />
          Team members
        </CardTitle>
      </CardHeader>
      {members.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No members yet.</p>
      ) : (
        <div className="overflow-x-auto -mx-6 -mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-6 py-3 font-medium">Member</th>
                <th className="px-6 py-3 font-medium">Role</th>
                <th className="px-6 py-3 font-medium">Reports to</th>
                <th className="px-6 py-3 font-medium text-right">Shares</th>
                <th className="px-6 py-3 font-medium text-right">Opens</th>
                <th className="px-6 py-3 font-medium text-right">Unique</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const admin = isAdminRole(m.role);
                const leader = isLeaderRole(m.role);
                // Only plain members report to a leader.
                const assignable = canAssignLeaders && !admin && !leader;
                return (
                  <tr key={m.user_id} className="border-b border-slate-50">
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        {admin && <Crown className="h-3.5 w-3.5 text-amber-500" />}
                        {leader && <Shield className="h-3.5 w-3.5 text-brand-purple" />}
                        <span className="text-slate-900">{m.full_name || m.email || 'Unknown'}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant={admin ? 'info' : leader ? 'default' : 'default'} size="sm">
                        {m.role}
                      </Badge>
                    </td>
                    <td className="px-6 py-3">
                      {assignable ? (
                        <select
                          value={m.leader_user_id ?? ''}
                          onChange={(e) => assign.mutate({ userId: m.user_id, leaderId: e.target.value || null })}
                          disabled={assign.isPending}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        >
                          <option value="">Unassigned</option>
                          {leaders.map((l) => (
                            <option key={l.user_id} value={l.user_id}>
                              {l.full_name || l.email || l.user_id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-400">
                          {m.leader_user_id ? nameById.get(m.leader_user_id) ?? '—' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-700">{m.shares}</td>
                    <td className="px-6 py-3 text-right text-slate-700">{m.opens}</td>
                    <td className="px-6 py-3 text-right text-slate-700">{m.unique_opens}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ContentPerformanceRow({
  rank,
  item,
}: {
  rank: number;
  item: ContentPerformanceReport['items'][number];
}) {
  const [open, setOpen] = useState(false);
  const { data: breakdown, isLoading } = useQuery<ContentBreakdown>({
    queryKey: ['org-content-breakdown', item.content_id],
    queryFn: () => orgApi.contentBreakdown(item.content_id),
    enabled: open,
  });

  return (
    <div className="px-6 py-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-4 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-slate-400 w-5 text-sm">{rank}</span>
          {open ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-900 truncate">{item.title}</span>
              <Badge variant="default" size="sm">
                {item.kind}
              </Badge>
              {item.is_archived && (
                <Badge variant="warning" size="sm">
                  Archived
                </Badge>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {item.shares} share{item.shares === 1 ? '' : 's'} · {item.sharing_members} member
              {item.sharing_members === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-lg font-semibold text-slate-900">{item.opens}</p>
          <p className="text-xs text-slate-400">{item.unique_opens} unique</p>
        </div>
      </button>

      {open && (
        <div className="mt-3 ml-12 rounded-lg bg-slate-50 border border-slate-200 p-3">
          {isLoading ? (
            <div className="py-3 flex justify-center">
              <LoadingSpinner />
            </div>
          ) : !breakdown || breakdown.members.length === 0 ? (
            <p className="text-sm text-slate-500">No opens recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 font-medium">Shared by</th>
                  <th className="py-1 font-medium text-right">Opens</th>
                  <th className="py-1 font-medium text-right">Unique</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.members.map((m) => (
                  <tr key={m.user_id}>
                    <td className="py-1 text-slate-700">{m.full_name || m.email || 'Unknown'}</td>
                    <td className="py-1 text-right text-slate-700">{m.opens}</td>
                    <td className="py-1 text-right text-slate-700">{m.unique_opens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

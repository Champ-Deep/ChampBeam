import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { intranetApi, type Transfer } from '../api';
import { PageHeader, QueryState } from '../components';
import { TRANSFER_KEYS, errorText, intakeFailures, personName, useMe, useMembers } from '../shared';

interface FileResult {
  name: string;
  status: 'waiting' | 'uploading' | 'done' | 'failed';
  progress: number;
  message?: string;
  transfer?: Transfer;
}

function blockedReason(file: File, blocked: string[], maxBytes: number): string | null {
  if (file.size <= 0) return 'File is empty.';
  if (file.size > maxBytes) return `File exceeds the ${formatBytes(maxBytes)} limit.`;
  const parts = file.name.toLowerCase().replace(/[. ]+$/, '').split('.').slice(1);
  const hits = parts.filter((p) => blocked.includes(p));
  return hits.length ? `Blocked file type: .${hits.join(', .')}` : null;
}

export function SubmitPage() {
  const me = useMe();
  const members = useMembers();
  const client = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [recipient, setRecipient] = useState('');
  const [purpose, setPurpose] = useState('');
  const [days, setDays] = useState('');
  const [oneTime, setOneTime] = useState(false);
  const [results, setResults] = useState<FileResult[]>([]);
  const [busy, setBusy] = useState(false);

  const limits = me.data?.limits;
  const recipients = (members.data ?? []).filter((m) => m.active && m.user_id !== me.data?.user.user_id);
  const defaultDays = me.data?.settings.default_expiry_days ?? 7;
  const precheck = limits ? files.map((f) => blockedReason(f, limits.blocked_extensions, limits.max_file_bytes)) : [];
  const anyBlocked = precheck.some(Boolean);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!files.length || !recipient || !purpose.trim() || anyBlocked) return;
    setBusy(true);
    const initial: FileResult[] = files.map((f) => ({ name: f.name, status: 'waiting', progress: 0 }));
    setResults(initial);
    const update = (i: number, patch: Partial<FileResult>) =>
      setResults((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    for (const [i, file] of files.entries()) {
      update(i, { status: 'uploading' });
      try {
        const transfer = await intranetApi.submit(
          {
            file,
            recipient_user_id: recipient,
            purpose: purpose.trim(),
            requested_expires_in_days: days ? Number(days) : null,
            requested_one_time: oneTime,
          },
          (pct) => update(i, { progress: pct }),
        );
        update(i, { status: 'done', progress: 100, transfer });
      } catch (err) {
        const failures = intakeFailures(err);
        update(i, { status: 'failed', message: failures.length ? failures.join(' ') : errorText(err, 'Upload failed.') });
      }
    }
    await Promise.all(TRANSFER_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
    setBusy(false);
    setFiles([]);
  }

  return (
    <div className="cb-workspace">
      <PageHeader title="Submit a file">
        <p>Files go to one central intake. IT reviews each one, and only approved files reach the recipient, inside this platform. Nothing is sent by email.</p>
      </PageHeader>
      <QueryState isLoading={me.isLoading || members.isLoading} error={me.error ?? members.error} label="intake settings" />
      {me.data && !me.data.malware_scan && (
        <p role="note" className="cb-panel">Malware scanning is not enabled on this deployment yet. Reviewers check files by hand before release.</p>
      )}
      {limits && (
        <form className="cb-panel" onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy}>
            <label className="cb-file-picker">
              <span>{files.length ? `${files.length} file${files.length > 1 ? 's' : ''} selected` : 'Choose files'}</span>
              <input type="file" multiple aria-label="Files to submit" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
            </label>
            <p className="cb-help">
              Up to {formatBytes(limits.max_file_bytes)} per file and {formatBytes(limits.max_bytes_per_user)} stored per person. Executable and script files are refused.
            </p>
            {files.length > 0 && (
              <ul>
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    {f.name} ({formatBytes(f.size)}){precheck[i] && <span role="alert"> {precheck[i]}</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className="cb-form-grid">
              <label>
                Recipient
                <select required value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                  <option value="">Choose a member</option>
                  {recipients.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{personName(m)}{m.email && m.full_name ? ` (${m.email})` : ''}</option>
                  ))}
                </select>
              </label>
              <label>
                Access ends after (days)
                <input
                  type="number"
                  min={1}
                  max={limits.max_expiry_days}
                  placeholder={`${defaultDays} (org default)`}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </label>
            </div>
            <label>
              Purpose
              <textarea
                required
                maxLength={500}
                rows={3}
                className="block w-full rounded-md border p-2"
                style={{ borderColor: 'var(--cb-border-strong)' }}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="What is this file and why does the recipient need it?"
              />
            </label>
            <label className="mt-4 flex items-center gap-2">
              <input type="checkbox" checked={oneTime} onChange={(e) => setOneTime(e.target.checked)} />
              One-time: the file can be downloaded once, then it is deleted
            </label>
            <p className="cb-help">A Reviewer can tighten these limits but never loosen them.</p>
            <div className="cb-actions">
              <Button type="submit" isLoading={busy} disabled={!files.length || !recipient || !purpose.trim() || anyBlocked}>
                Submit for review
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {results.length > 0 && (
        <section className="cb-panel" aria-live="polite">
          <h2>Submission results</h2>
          <ul>
            {results.map((r, i) => (
              <li key={`${r.name}-${i}`}>
                <strong>{r.name}</strong>:{' '}
                {r.status === 'uploading' && `uploading ${r.progress}%`}
                {r.status === 'waiting' && 'waiting'}
                {r.status === 'done' && 'submitted, waiting for review'}
                {r.status === 'failed' && <span role="alert">{r.message}</span>}
              </li>
            ))}
          </ul>
          <Link to="/submissions">See my submissions</Link>
        </section>
      )}
    </div>
  );
}

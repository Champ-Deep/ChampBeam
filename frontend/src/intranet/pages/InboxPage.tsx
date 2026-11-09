import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, useConfirm } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { intranetApi, type Transfer } from '../api';
import { PageHeader, QueryState } from '../components';
import { ACCESS_CODE_PATTERN, TRANSFER_KEYS, errorText, fileLine, limitsLine, personName, receiptLabel, stateTone } from '../shared';

export function InboxPage() {
  const client = useQueryClient();
  const confirm = useConfirm();
  const inbox = useQuery({ queryKey: ['intranet-inbox'], queryFn: () => intranetApi.inbox(), refetchInterval: 30_000 });
  const [error, setError] = useState('');
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function download(t: Transfer, accessCode?: string) {
    setError('');
    if (t.access_code_required && !accessCode) {
      setCodeFor(t.id);
      setCode('');
      return;
    }
    if (t.one_time && !(await confirm({ message: 'This file can be downloaded once. After the download completes it is deleted. Continue?', confirmLabel: 'Download' }))) return;
    try {
      await intranetApi.download(t.id, 'transfer', accessCode);
      setCodeFor(null);
      window.setTimeout(() => {
        void Promise.all(TRANSFER_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
      }, 3000);
    } catch (err) {
      setError(errorText(err, 'Download failed.'));
    }
  }

  return (
    <div className="cb-workspace">
      <PageHeader title="Inbox">
        <p>Files that IT approved for you. They are only available here, and only until their access ends.</p>
      </PageHeader>
      <QueryState isLoading={inbox.isLoading} error={inbox.error} label="your inbox" />
      {error && <p role="alert">{error}</p>}
      {inbox.data && inbox.data.length === 0 && <p>No files have been released to you.</p>}
      {inbox.data && inbox.data.length > 0 && (
        <div className="cb-table-scroll">
          <table>
            <thead>
              <tr><th>File</th><th>From</th><th>Released</th><th>Access</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {inbox.data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{fileLine(t)}<small>{t.purpose}</small>{t.sha256 && <small title={t.sha256}>SHA-256 {t.sha256.slice(0, 16)}…</small>}</th>
                  <td>{personName(t.submitter)}</td>
                  <td>{formatRelative(t.released_at)}</td>
                  <td>{limitsLine(t)}</td>
                  <td style={{ color: stateTone(t) }}>{t.state === 'consumed' ? 'Downloaded' : receiptLabel(t)}</td>
                  <td>
                    {t.state === 'released' && codeFor !== t.id && (
                      <Button size="sm" onClick={() => void download(t)}>Download</Button>
                    )}
                    {t.state === 'released' && codeFor === t.id && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void download(t, code);
                        }}
                      >
                        <label>
                          Access code from the Reviewer
                          <input
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern={ACCESS_CODE_PATTERN}
                            maxLength={8}
                            required
                            autoFocus
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                          />
                        </label>
                        <div className="cb-actions">
                          <Button size="sm" type="submit">Download</Button>
                          <Button size="sm" type="button" variant="outline" onClick={() => setCodeFor(null)}>Cancel</Button>
                        </div>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

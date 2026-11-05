import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, useConfirm } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { intranetApi } from '../api';
import { PageHeader, QueryState } from '../components';
import { TRANSFER_KEYS, errorText, fileLine, limitsLine, personName, receiptLabel, stateTone } from '../shared';

const WITHDRAWABLE = new Set(['scanning', 'submitted', 'in_review']);
const DOWNLOADABLE = new Set(['submitted', 'in_review', 'released']);

export function SubmissionsPage() {
  const client = useQueryClient();
  const confirm = useConfirm();
  const mine = useQuery({ queryKey: ['intranet-mine'], queryFn: () => intranetApi.mine(), refetchInterval: 30_000 });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function act(action: () => Promise<unknown>, message: string) {
    setError('');
    setNotice('');
    try {
      await action();
      await Promise.all(TRANSFER_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
      setNotice(message);
    } catch (err) {
      setError(errorText(err, 'That action failed.'));
    }
  }

  async function revoke(id: string) {
    if (!(await confirm({ message: 'Revoke this file? The recipient loses access at once and the file is deleted.', confirmLabel: 'Revoke' }))) return;
    await act(() => intranetApi.revoke(id), 'File revoked.');
  }

  async function withdraw(id: string) {
    if (!(await confirm({ message: 'Withdraw this submission? It leaves the review queue and the file is deleted.', confirmLabel: 'Withdraw' }))) return;
    await act(() => intranetApi.withdraw(id), 'Submission withdrawn.');
  }

  return (
    <div className="cb-workspace">
      <PageHeader title="My submissions">
        <p>Every file you submitted, with its review status and whether the recipient has opened it. <Link to="/submit">Submit a file</Link></p>
      </PageHeader>
      <QueryState isLoading={mine.isLoading} error={mine.error} label="submissions" />
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {mine.data && mine.data.length === 0 && <p>You have not submitted any files yet.</p>}
      {mine.data && mine.data.length > 0 && (
        <div className="cb-table-scroll">
          <table>
            <thead>
              <tr><th>File</th><th>Recipient</th><th>Submitted</th><th>Status</th><th>Access</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {mine.data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{fileLine(t)}<small>{t.purpose}</small></th>
                  <td>{personName(t.recipient)}</td>
                  <td>{formatRelative(t.submitted_at)}</td>
                  <td style={{ color: stateTone(t) }}>
                    {receiptLabel(t)}
                    {t.reject_reason && <small>Reason: {t.reject_reason}</small>}
                    {t.state === 'check_failed' && t.scan_status === 'infected' && <small>Malware was detected. The file was deleted.</small>}
                    {t.decided_by_type === 'agent' && <small>Approved by the review agent</small>}
                  </td>
                  <td>{limitsLine(t)}</td>
                  <td>
                    <div className="cb-actions">
                      {DOWNLOADABLE.has(t.state) && (
                        <Button size="sm" variant="outline" onClick={() => void act(() => intranetApi.download(t.id), 'Download started.')}>Download</Button>
                      )}
                      {WITHDRAWABLE.has(t.state) && (
                        <Button size="sm" variant="outline" onClick={() => void withdraw(t.id)}>Withdraw</Button>
                      )}
                      {t.state === 'released' && (
                        <Button size="sm" variant="danger" onClick={() => void revoke(t.id)}>Revoke</Button>
                      )}
                    </div>
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

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../components/ui';
import { intranetApi, type Me, type Member, type Transfer } from './api';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { SubmitPage } from './pages/SubmitPage';

vi.mock('./api', () => ({
  intranetApi: {
    me: vi.fn(),
    members: vi.fn(),
    submit: vi.fn(),
    mine: vi.fn(),
    queue: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    revoke: vi.fn(),
    download: vi.fn(),
  },
}));

const me: Me = {
  user: { user_id: 'u-alice', email: 'alice@champions.test', full_name: 'Alice' },
  organization: { id: 'org-1', name: 'Champions', slug: 'champions' },
  is_admin: false,
  is_reviewer: true,
  settings: {
    agent_mode: 'off',
    agent_window_hours: 24,
    agent_threshold: 0.95,
    agent_input_mode: 'metadata_only',
    default_expiry_days: 7,
    hard_expiry_days: 7,
    reminder_hours: 12,
  },
  limits: { max_file_bytes: 1024, max_bytes_per_user: 4096, max_expiry_days: 90, blocked_extensions: ['exe', 'bat'] },
  malware_scan: false,
};

const members: Member[] = [
  { user_id: 'u-alice', email: 'alice@champions.test', full_name: 'Alice', role: 'member', is_admin: false, is_reviewer: true, active: true },
  { user_id: 'u-bob', email: 'bob@champions.test', full_name: 'Bob', role: 'member', is_admin: false, is_reviewer: false, active: true },
  { user_id: 'u-gone', email: 'gone@champions.test', full_name: 'Gone', role: 'member', is_admin: false, is_reviewer: false, active: false },
];

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 't-1',
    state: 'submitted',
    receipt: 'pending',
    filename: 'export.csv',
    size_bytes: 10,
    mime_type: 'text/csv',
    sha256: null,
    purpose: 'Monthly export',
    submitter: { user_id: 'u-bob', email: 'bob@champions.test', full_name: 'Bob' },
    recipient: { user_id: 'u-alice', email: 'alice@champions.test', full_name: 'Alice' },
    requested_expires_in_days: 3,
    requested_one_time: false,
    one_time: false,
    expires_at: null,
    submitted_at: new Date().toISOString(),
    agent_window_ends_at: null,
    hard_expires_at: null,
    decided_at: null,
    decided_by_type: null,
    reject_reason: null,
    released_at: null,
    first_opened_at: null,
    consumed_at: null,
    expired_at: null,
    revoked_at: null,
    age_seconds: 3600,
    ...overrides,
  };
}

function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(intranetApi.me).mockResolvedValue(me);
  vi.mocked(intranetApi.members).mockResolvedValue(members);
});
afterEach(cleanup);

describe('submit page', () => {
  it('lists only other active members and warns that scanning is off', async () => {
    mount(<SubmitPage />);
    const select = await screen.findByLabelText('Recipient');
    const labels = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels.some((l) => l?.startsWith('Bob'))).toBe(true);
    expect(labels.some((l) => l?.startsWith('Alice'))).toBe(false);
    expect(labels.some((l) => l?.startsWith('Gone'))).toBe(false);
    expect(screen.getByText(/Malware scanning is not enabled/)).toBeInTheDocument();
  });

  it('blocks executables before upload', async () => {
    mount(<SubmitPage />);
    fireEvent.change(await screen.findByLabelText('Files to submit'), {
      target: { files: [new File(['x'], 'setup.exe', { type: 'application/octet-stream' })] },
    });
    expect(await screen.findByText(/Blocked file type: .exe/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
  });

  it('submits each file with the requested limits', async () => {
    vi.mocked(intranetApi.submit).mockResolvedValue(transfer());
    mount(<SubmitPage />);
    fireEvent.change(await screen.findByLabelText('Files to submit'), {
      target: { files: [new File(['a'], 'a.csv', { type: 'text/csv' }), new File(['b'], 'b.csv', { type: 'text/csv' })] },
    });
    fireEvent.change(screen.getByLabelText('Recipient'), { target: { value: 'u-bob' } });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Quarterly data' } });
    fireEvent.change(screen.getByLabelText('Access ends after (days)'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText(/One-time/));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(intranetApi.submit).toHaveBeenCalledTimes(2));
    expect(intranetApi.submit).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_user_id: 'u-bob', purpose: 'Quarterly data', requested_expires_in_days: 2, requested_one_time: true }),
      expect.any(Function),
    );
    expect(await screen.findAllByText(/submitted, waiting for review/)).toHaveLength(2);
  });
});

describe('review queue', () => {
  it('hides decisions on the reviewer\'s own submission', async () => {
    vi.mocked(intranetApi.queue).mockResolvedValue([
      transfer({ id: 't-own', submitter: { user_id: 'u-alice', email: null, full_name: 'Alice' }, filename: 'mine.csv' }),
    ]);
    mount(<ReviewQueuePage />);
    expect(await screen.findByText(/another Reviewer must decide it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and release' })).not.toBeInTheDocument();
  });

  it('requires a reason to reject and approves within the requested limit', async () => {
    vi.mocked(intranetApi.queue).mockResolvedValue([transfer()]);
    vi.mocked(intranetApi.approve).mockResolvedValue(transfer({ state: 'released' }));
    vi.mocked(intranetApi.reject).mockResolvedValue(transfer({ state: 'rejected' }));
    mount(<ReviewQueuePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const rejectButton = screen.getByRole('button', { name: 'Reject' });
    expect(rejectButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Contains PII' } });
    fireEvent.click(rejectButton);
    await waitFor(() => expect(intranetApi.reject).toHaveBeenCalledWith('t-1', 'Contains PII'));

    cleanup();
    mount(<ReviewQueuePage />);
    const days = await screen.findByLabelText('Access ends after (days)');
    expect(days).toHaveValue(3);
    expect(days).toHaveAttribute('max', '3');
    fireEvent.click(screen.getByRole('button', { name: 'Approve and release' }));
    await waitFor(() => expect(intranetApi.approve).toHaveBeenCalledWith('t-1', { expires_in_days: 3, one_time: false }));
  });
});

describe('my submissions', () => {
  it('shows delivery receipts and rejection reasons', async () => {
    vi.mocked(intranetApi.mine).mockResolvedValue([
      transfer({ id: 'a', state: 'released', receipt: 'not_opened', filename: 'waiting.csv' }),
      transfer({ id: 'b', state: 'released', receipt: 'opened', first_opened_at: new Date().toISOString(), filename: 'seen.csv' }),
      transfer({ id: 'c', state: 'rejected', receipt: 'rejected', reject_reason: 'Wrong recipient', filename: 'no.csv' }),
    ]);
    mount(<SubmissionsPage />);
    expect(await screen.findByText('Not opened')).toBeInTheDocument();
    expect(screen.getByText(/^Opened less than a minute ago/)).toBeInTheDocument();
    expect(screen.getByText('Reason: Wrong recipient')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
  });
});

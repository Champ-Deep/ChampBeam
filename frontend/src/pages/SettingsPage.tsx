import { useState } from 'react';
import { AxiosError } from 'axios';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';
import { authApi } from '../api/auth';

export function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Choose a new password that is different from your current one.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword);
      // Replace the stale JWT with the freshly issued one so we don't get
      // booted by our own iat-invalidation rule on the next request.
      localStorage.setItem('access_token', res.access_token);
      toast.success('Password updated.');
      reset();
    } catch (err) {
      const axiosErr = err as AxiosError<{ detail?: string }>;
      const detail = axiosErr.response?.data?.detail;
      setError(detail ?? 'Could not update password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <h1 className="text-2xl font-bold text-slate-900 mb-6">Settings</h1>

      <Card>
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-slate-900">Change password</h2>
          <p className="text-sm text-slate-600 mt-1">
            Rotate the password on your account. Any other devices signed in
            with the previous password will need to sign in again.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Current password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Your current password"
            required
            autoComplete="current-password"
          />
          <Input
            label="New password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            autoComplete="new-password"
            minLength={8}
          />
          <Input
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Re-enter the new password"
            required
            autoComplete="new-password"
            minLength={8}
          />
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={reset} disabled={isLoading}>
              Reset form
            </Button>
            <Button type="submit" isLoading={isLoading}>
              Update password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';
import { authApi } from '../api/auth';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      // Always treat as success — backend returns the generic message
      // whether or not the email is registered to prevent user enumeration.
      await authApi.forgotPassword(email);
      setSubmitted(true);
    } catch {
      // Even a transport failure should not reveal account existence.
      toast.error('Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-4">
            <Link2 className="h-8 w-8 text-brand-purple" />
            <span className="text-2xl font-bold text-slate-900">
              Champ<span className="text-brand-purple">UTM</span>
            </span>
          </Link>
          <h1 className="text-xl font-semibold text-slate-900">Reset your password</h1>
          <p className="text-slate-600 mt-2">
            Enter the email associated with your account and we'll send you a reset link.
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800">
              If this email is in our system, you will receive a reset link shortly.
              The link expires in 30 minutes.
            </div>
            <Link
              to="/login"
              className="block text-center text-sm text-brand-purple font-medium hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
            <Button type="submit" className="w-full" isLoading={isLoading}>
              Send reset link
            </Button>
            <p className="text-center text-sm text-slate-600">
              Remembered it?{' '}
              <Link to="/login" className="text-brand-purple font-medium hover:underline">
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </Card>
    </div>
  );
}

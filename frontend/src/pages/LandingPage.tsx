import { Link } from 'react-router-dom';
import { SignUpButton, useAuth } from '@clerk/react';
import {
  ArrowRight,
  BarChart3,
  Eye,
  FileText,
  Globe,
  Link2,
  MousePointerClick,
  Send,
  ShieldCheck,
  Upload,
  Zap,
} from 'lucide-react';
import { Button, Card } from '../components/ui';

const VALUE_PROPS = [
  {
    icon: Send,
    title: 'Send anything',
    body: 'Links and files — PDFs, video, images, HTML — become one clean, short link. No account needed to start.',
  },
  {
    icon: Eye,
    title: 'Know it landed',
    body: 'Real-time read receipts. See the moment your link or file is opened, with live open and click counts.',
  },
  {
    icon: BarChart3,
    title: 'Understand the audience',
    body: 'Every open is enriched with location, device, browser, and UTM campaign attribution — automatically.',
  },
];

const STEPS = [
  { icon: Upload, title: 'Paste a URL or drop a file', body: 'Start from the generator — no signup required.' },
  { icon: Link2, title: 'Get a short, trackable link', body: 'One link to share anywhere — email, chat, or social.' },
  { icon: MousePointerClick, title: 'Watch opens roll in', body: 'See who opened it, when, from where, and on what device.' },
];

const USE_CASES = [
  'Sales collateral & proposals',
  'Candidate & recruiter outreach',
  'Investor updates',
  'Newsletters & launches',
  'Ad & social campaigns',
  'Contracts & one-off file sends',
];

export function LandingPage() {
  const { isSignedIn } = useAuth();

  return (
    <div className="bg-white">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-purple/10 via-white to-brand-teal/10" />
        <div className="relative max-w-5xl mx-auto px-4 pt-20 pb-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-purple/10 px-3 py-1 text-sm font-medium text-brand-purple mb-6">
            <Zap className="h-4 w-4" />
            Links + files, with read receipts
          </span>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-slate-900">
            Send it.{' '}
            <span className="bg-gradient-to-r from-brand-purple to-brand-teal bg-clip-text text-transparent">
              Know they saw it.
            </span>
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto">
            ChampUTM turns any link or file into one short, trackable link with read
            receipts — see exactly when, where, and on what device it was opened.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/">
              <Button size="lg" rightIcon={<ArrowRight className="h-4 w-4" />}>
                Start sharing free
              </Button>
            </Link>
            {isSignedIn ? (
              <Link to="/analytics">
                <Button size="lg" variant="outline">
                  Go to dashboard
                </Button>
              </Link>
            ) : (
              <SignUpButton>
                <Button size="lg" variant="outline">
                  Sign up free
                </Button>
              </SignUpButton>
            )}
          </div>
          <p className="mt-4 text-sm text-slate-500">
            No credit card. Share your first file or link in seconds.
          </p>
        </div>
      </section>

      {/* Value props */}
      <section className="max-w-6xl mx-auto px-4 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {VALUE_PROPS.map((p) => {
            const Icon = p.icon;
            return (
              <Card key={p.title} className="h-full">
                <div className="h-12 w-12 rounded-lg bg-brand-purple/10 flex items-center justify-center mb-4">
                  <Icon className="h-6 w-6 text-brand-purple" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">{p.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{p.body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-slate-50 border-y border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-16">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900">How it works</h2>
            <p className="mt-2 text-slate-600">From share to read receipt in three steps.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className="relative">
                  <Card className="h-full">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-purple text-white text-sm font-bold">
                        {i + 1}
                      </span>
                      <Icon className="h-5 w-5 text-brand-teal" />
                    </div>
                    <h3 className="text-base font-semibold text-slate-900">{s.title}</h3>
                    <p className="mt-1 text-sm text-slate-600">{s.body}</p>
                  </Card>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Files + read receipts highlight */}
      <section className="max-w-6xl mx-auto px-4 py-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div>
            <h2 className="text-3xl font-bold text-slate-900">
              Stop wondering if it was opened
            </h2>
            <p className="mt-4 text-slate-600">
              Email attachments disappear into inboxes. ChampUTM links don’t. Share a
              proposal, a deck, or a contract and get a live signal the second it’s viewed —
              then dig into the geography, device, and campaign behind every open.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                { icon: FileText, text: 'Host PDFs, video, images, and HTML behind one link' },
                { icon: Eye, text: '“Seen ✓ / Not opened yet” read receipts in real time' },
                { icon: Globe, text: 'Country, region, and city for every open' },
                { icon: ShieldCheck, text: 'VPN detection and per-link, on-your-domain hosting' },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.text} className="flex items-start gap-3">
                    <div className="h-6 w-6 rounded-md bg-brand-teal/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon className="h-3.5 w-3.5 text-brand-teal" />
                    </div>
                    <span className="text-sm text-slate-700">{item.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <Card className="bg-gradient-to-br from-brand-purple/5 to-brand-teal/5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
              Built for
            </p>
            <div className="flex flex-wrap gap-2">
              {USE_CASES.map((u) => (
                <span
                  key={u}
                  className="rounded-full bg-white border border-slate-200 px-3 py-1.5 text-sm text-slate-700"
                >
                  {u}
                </span>
              ))}
            </div>
          </Card>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="bg-brand-navy">
        <div className="max-w-4xl mx-auto px-4 py-16 text-center">
          <h2 className="text-3xl font-bold text-white">Share something. See who opens it.</h2>
          <p className="mt-3 text-white/70">
            The free UTM generator you already trust — now for files too.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/">
              <Button size="lg" rightIcon={<ArrowRight className="h-4 w-4" />}>
                Start sharing free
              </Button>
            </Link>
            {!isSignedIn && (
              <SignUpButton>
                <Button size="lg" variant="secondary">
                  Create an account
                </Button>
              </SignUpButton>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
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
import type { LucideIcon } from 'lucide-react';
import { Card } from '../components/ui/Card';

// Marketing content for signed-out visitors. Layout and voice follow the
// September 2026 landing. Anonymous "start below" is gone: sharing needs an account.
const VALUE_PROPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Send,
    title: 'Send anything',
    body: 'A link, a file, or a hosted page. Each becomes one clean short link and QR code.',
  },
  {
    icon: Eye,
    title: 'Know it landed',
    body: 'Read receipts, live. The instant it is opened you see it, with running open and click counts.',
  },
  {
    icon: BarChart3,
    title: 'Understand the audience',
    body: 'Every open carries location, device, browser, and full UTM attribution, captured automatically.',
  },
];

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Upload, title: 'Paste a URL or drop a file', body: 'Sign in, then start from the share screen.' },
  { icon: Link2, title: 'Get a short, trackable link', body: 'One link to share anywhere: email, chat, or social.' },
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

const HIGHLIGHTS: { icon: LucideIcon; text: string }[] = [
  { icon: FileText, text: 'Host PDFs, video, images, and HTML behind one link' },
  { icon: Eye, text: 'Seen / Not opened yet read receipts in real time' },
  { icon: Globe, text: 'Country, region, and city for every open' },
  { icon: ShieldCheck, text: 'VPN detection and per-link, on-your-domain hosting' },
  { icon: BarChart3, text: 'ChampUTM inside: UTM links, presets, bulk CSV, and campaign analytics' },
];

function Cta({ to, tone, children }: { to: string; tone: 'ink' | 'outline' | 'light' | 'on-dark'; children: ReactNode }) {
  const tones = {
    ink: 'bg-cb-ink text-surface shadow-sm hover:bg-cb-text focus-visible:ring-cb-accent/50',
    outline: 'border border-cb-icon/60 bg-surface text-cb-ink hover:bg-slate-50 focus-visible:ring-cb-accent/40',
    light: 'bg-surface text-cb-ink shadow-sm hover:bg-cb-bg focus-visible:ring-white/80 focus-visible:ring-offset-brand-navy',
    'on-dark': 'border border-white/55 text-white hover:bg-white/10 focus-visible:ring-white/80 focus-visible:ring-offset-brand-navy',
  };
  return (
    <Link
      to={to}
      className={clsx(
        'inline-flex h-12 min-w-40 items-center justify-center gap-2 rounded-[10px] px-6 text-base font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        tones[tone],
      )}
    >
      {children}
    </Link>
  );
}

/** Marketing page for signed-out visitors at /. */
export function LandingPage() {
  return (
    <div className="cb-landing mx-auto max-w-[1120px] px-4 py-8 sm:px-6">
      <section className="relative mb-10 overflow-hidden rounded-2xl border border-slate-200">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-purple/10 via-white to-brand-teal/10" aria-hidden="true" />
        <div className="relative mx-auto max-w-4xl px-4 pt-14 pb-12 text-center">
          <span className="mb-6 inline-flex items-center gap-1.5 rounded-full bg-cb-accent-soft px-3 py-1 text-sm font-medium text-cb-accent">
            <Zap className="h-4 w-4" aria-hidden="true" />
            Links, files, and pages, with read receipts
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            Send it. <span className="text-cb-accent">Know they saw it.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            Turn any link, file, or hosted page into one short link and QR code that tells you the moment it is
            opened, from where, and on what device.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta to="/sign-up" tone="ink">
              Sign up free
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Cta>
            <Cta to="/sign-in" tone="outline">Sign in</Cta>
          </div>
          <p className="mt-4 text-sm text-slate-500">No credit card, no setup.</p>
        </div>
      </section>

      <section aria-label="What you can do" className="mb-12">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {VALUE_PROPS.map((prop) => {
            const Icon = prop.icon;
            return (
              <Card key={prop.title} className="h-full">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-cb-accent-soft">
                  <Icon className="h-6 w-6 text-cb-accent" aria-hidden="true" />
                </div>
                <h2 className="text-lg font-semibold text-slate-900">{prop.title}</h2>
                <p className="mt-2 text-sm text-slate-600">{prop.body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="mt-16" aria-labelledby="how-heading">
        <div className="mb-10 text-center">
          <h2 id="how-heading" className="text-3xl font-bold text-slate-900">How it works</h2>
          <p className="mt-2 text-slate-600">From share to read receipt in three steps.</p>
        </div>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <Card key={step.title} className="h-full">
                <div className="mb-3 flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-purple text-sm font-bold text-white">
                    {index + 1}
                  </span>
                  <Icon className="h-5 w-5 text-brand-teal" aria-hidden="true" />
                </div>
                <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{step.body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="mt-16" aria-labelledby="receipts-heading">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
          <div>
            <h2 id="receipts-heading" className="text-3xl font-bold text-slate-900">Stop wondering if it was opened</h2>
            <p className="mt-4 text-slate-600">
              Email attachments disappear into inboxes. Champbeam links do not. Share a
              proposal, a deck, or a contract and get a live signal the second it is viewed,
              then dig into the geography, device, and campaign behind every open.
            </p>
            <ul className="mt-6 space-y-3">
              {HIGHLIGHTS.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.text} className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-teal/10">
                      <Icon className="h-3.5 w-3.5 text-brand-teal" aria-hidden="true" />
                    </div>
                    <span className="text-sm text-slate-700">{item.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <Card className="bg-gradient-to-br from-brand-purple/5 to-brand-teal/5">
            <p className="mb-3 text-xs font-semibold tracking-wider text-slate-500 uppercase">Built for</p>
            <div className="flex flex-wrap gap-2">
              {USE_CASES.map((useCase) => (
                <span key={useCase} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700">
                  {useCase}
                </span>
              ))}
            </div>
          </Card>
        </div>
      </section>

      <section className="mt-16 rounded-2xl bg-brand-navy" aria-labelledby="close-heading">
        <div className="mx-auto max-w-3xl px-4 py-14 text-center">
          <h2 id="close-heading" className="text-3xl font-bold text-white">Share something. See who opens it.</h2>
          <p className="mt-3 text-[var(--cb-side-text)]">
            Smart links, QR codes, file tracking, and hosted pages. ChampUTM is included: UTM links, presets, bulk CSV, and campaign analytics.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Cta to="/sign-up" tone="light">
              Create an account
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Cta>
            <Cta to="/sign-in" tone="on-dark">Sign in</Cta>
          </div>
        </div>
      </section>
    </div>
  );
}

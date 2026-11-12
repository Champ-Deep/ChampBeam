# PRD: ChampBeam agents A1 (forward alert + follow-up draft) and A2 (page from a brief)

Status: planned, nothing built. Planner card t_ea4ebc57, ruling t_87ec0555 (Deep, 6 Nov 2026: plan A1 and A2; A3, A4, J1, J2, J3 deferred).
Probed against `origin/main` at `20018c6` (merge of PR #58, the Cloudflare cutover release). Every `file:line` below is on that commit.

## 1. Goal

Two OpenRouter-backed agents inside the ChampBeam Worker, on top of the Assistant that PR #56 already ported:

- **A1 Forward alert + follow-up draft.** When a shared link or file shows it was forwarded, the sender sees an alert in the app. On request, the agent drafts a follow-up email that steers to the Pages the readers spent time on. The sender copies it and sends it from their own mail. ChampBeam never sends it.
- **A2 Page from a brief.** "One-pager for Acme, their pain is X" becomes a branded HTML page, previewed first, then published as a normal tracked ChampBeam Page through the existing publish path, and the link comes back.

## 2. Non-goals

- A3 (ask your analytics), A4 (Monday digest), J1, J2, J3. Only the J1 seam is named (section 6.4).
- Any outbound send. No email, no webhook, no Slack from either agent. Alerts are in-app only in v1 (decision D2 can add email to the sender later).
- Team or leader views of alerts. An alert belongs to the asset owner only.
- Model-authored raw HTML on the share host (section 7.2 explains why the model writes copy and the Worker writes the HTML).
- Deploys, secrets, keys, spend. Those are Deep's actions (decision D1) and the final smoke card.

## 3. What exists today (probed)

| Seam | Where | What it gives us |
|---|---|---|
| Assistant routes | `worker/src/routes/assistant.ts:64-107` | GET/PUT `/api/v1/assistant/config`, POST `/chat`; PUT is org-admin only (`:71`), chat is per-user limited 20/min (`:32`, `:85`) and capped at 32 000 chars (`:34`, `:87`). Session auth only (`requireSessionAuth`, `:65`, `:84`). |
| Assistant service | `worker/src/services/assistant.ts:13-15` providers `mock`, `openrouter`, `vercel`; `:91-96` `providerConfigured`; `:99-106` `configRow` singleton id 1; `:122-172` `complete(s, provider, messages, model, maxTokens)`; `:108-114` fixed error strings, never a provider body or key | The one place that talks to a model. |
| Assistant config table | `worker/migrations/0008_assistant_config.sql:5-11`; Drizzle `worker/src/db/schema.ts:553` | One global row: provider, model, enabled. No per-job model yet. |
| Assistant settings | `worker/src/env.ts:173-182` (`ASSISTANT_PROVIDER` default `openrouter`, `ASSISTANT_MODEL`, `ASSISTANT_OPENROUTER_API_KEY` secret, timeout 60 s, max tokens 700) | Key is a Worker secret, absent today, so chat answers 503. |
| Rate counters | `worker/src/lib/ratelimit.ts:36-45` `enforceLimit(db, key, limit, windowSeconds, detail)` | Fixed windows on D1, fails open. Reused for every agent cap. |
| Journeys | `worker/src/routes/journeys.ts:49-133` `buildJourneys`; per-visitor `cities` and `forwarded: cities >= 2` at `:121` and `:129`; company pick excludes isp/hosting/vpn at `:122`; scope rules `:33-44` | Per visitor, not per asset. A1 needs per asset (section 6.1). |
| Real-click predicate | `worker/src/routes/_utmHelpers.ts:14` `REAL_CLICK = COALESCE(ce.device_type,'') != 'bot'` | The single human filter. Comment at `:12` says do not write a second one. |
| Hosting ASN test | `worker/src/services/geoip.ts:82` `isHostingAsn`; used as `likely_scanner` in `worker/src/services/openWebhook.ts:50` | Mail scanners click from datacenters. |
| Click events | `worker/src/db/schema.ts:285-312` (`visitor_id`, `city`, `country_code`, `is_vpn`, `asn_org`, `company_name`, `company_domain`, `company_type`, `clicked_at`) | Forward evidence. |
| Dwell | `worker/src/db/schema.ts:488-498` `page_engagements(file_id, session_id, visitor_id, page, dwell_ms, created_at)`; written only by `POST /f/:short_code/page-events`, `worker/src/routes/filesServe.ts:410-440` (60 s cap per report `:386`) | The only beacon is the Beam Pages snippet, injected for `kind = html` at `filesServe.ts:296-304`, and it always reports `page: 0` (`worker/src/services/pages.ts:315`). So "pages the recipient lingered on" means which ChampBeam Pages (HTML assets) they spent time on, summed per asset. The `page` column carries no section index on the Worker. |
| Page publish | `worker/src/routes/pages.ts:208` `publish(c, opts)`; `:302-316` POST `/api/v1/pages` (JSON `html`); `:319-354` POST `/api/v1/pages/upload` (multipart); `:173` `pageResponse` | A2 calls `publish()` in-process, the same function both routes use. Size cap `PAGES_MAX_BYTES` 2 MB (`env.ts:137`). Tracking snippet is injected at serve time, so an A2 page is tracked like any other. |
| Cron | `worker/src/cron.ts:16-22`; schedules `*/15` and `*/5` in `worker/wrangler.jsonc:56-59` | A1 detection rides the `*/15` branch. |
| App mounts | `worker/src/app.ts:92` journeys, `:105` pages, `:107` assistant | New `alerts` router mounts next to `:107`. |
| Frontend | `frontend/src/api/assistant.ts`, `frontend/src/components/AssistantSettings.tsx`, `frontend/src/components/layout/Navigation.tsx:73` (sticky top `<nav>`), `frontend/src/pages/PagesPage.tsx:146-162` (title, ShareComposer, Advanced HTML publishing), `frontend/src/components/kokonutui/ai-prompt.tsx` (a 21st.dev prompt box already in the repo), `frontend/src/components/ui/index.ts` (Button, Card, Badge, EmptyState, QrButton, ConfirmDialog) | UI seams. |

Open PRs that touch the same ground (none merged): #63 adds `click_events.is_scanner` and `visitor_type` (the J1 data); #62 is the journeys map UI; #64/#61/#60 each take migration numbers 0008 or 0009.

## 4. Holes found, and how this plan closes them

1. **"2 or more cities" on one visitor is not a forward.** `journeys.ts:129` flags one person who travels or whose mobile IP geolocates elsewhere. Rule here: 2+ distinct cities AND 2+ distinct visitors on the same asset.
2. **The sender's own preview counts as a city.** Exclude clicks whose `company_domain` equals the sender's email domain (skipped for free-mail domains). There is no link from a visitor id to a signed-in user, so this is the only cheap exclusion; residual noise is accepted and named.
3. **Scanners.** Datacenter ASN clicks would create both a "city" and a "company". Excluded via `isHostingAsn` plus `REAL_CLICK` plus `is_vpn = 0`, in one function (the J1 seam).
4. **A draft that says "I saw you read page 4" is creepy and leaks tracking.** The model never receives dwell numbers, cities or the fact of forwarding as something to mention. Dwell facts are shown to the sender only as deterministic `sender_notes` built by code. A server-side word check rejects drafts that mention tracking.
5. **Model spend.** Drafts are generated only when the sender asks, never at detection. Per-user daily caps per job. Key-level cap set by Deep on a separate key (D1).
6. **Model-written HTML on a public share host** can carry script, off-brand styling and invented numbers. The model returns copy as JSON; the Worker renders one fixed branded template, escapes every string, and rejects any figure that is not in the brief.
7. **Migration number collisions.** 0008 is taken on main and 0009 twice on open branches. This plan uses `0012` and `0013`; renumber at merge if a lower free number is wanted.
8. **Tests that leak to the real provider** (the round-1 failure on PR #56). `vitest.config.ts` already pins `ASSISTANT_PROVIDER=mock`; every new test must pass alone with `-t`.

## 5. Foundation F: per-job model and one seam for agent calls

### 5.1 Data

New migration `worker/migrations/0012_assistant_job_models.sql`:

```sql
-- Per-job model override for agent jobs. No row = use assistant_config.model. Provider stays global.
CREATE TABLE IF NOT EXISTS assistant_job_models (
  job TEXT PRIMARY KEY NOT NULL CHECK (job IN ('forward_followup', 'page_from_brief')),
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

A new table rather than columns on `assistant_config`: SQLite has no `ADD COLUMN IF NOT EXISTS`, and the Railway export (`assistant_config` in TABLE_ORDER) stays untouched.

### 5.2 Service

New `worker/src/services/agentJobs.ts`:

```ts
export const AGENT_JOBS = ["forward_followup", "page_from_brief"] as const;
export type AgentJob = (typeof AGENT_JOBS)[number];
export const JOB_DAILY_LIMIT: Record<AgentJob, number> = { forward_followup: 30, page_from_brief: 10 };
export const JOB_MAX_TOKENS: Record<AgentJob, number> = { forward_followup: 600, page_from_brief: 1800 };
export async function jobModel(db: Db, s: Settings, job: AgentJob): Promise<string>; // row ?? configRow().model
export async function completeJob(c: Ctx, userId: string, job: AgentJob, messages: ChatMessage[]):
  Promise<{ reply: string; model: string; provider: string; usage: Completion["usage"] }>;
```

`completeJob` order, each step a fixed error:
1. `configRow`; if `!settings.assistantEnabled || !row.enabled` then 503 `The assistant is disabled.`
2. `providerConfigured(s, row.provider)` false then 503 `The <provider> provider has no API key configured.`
3. `enforceLimit(c.env.DB, \`agent:${job}:${userId}\`, JOB_DAILY_LIMIT[job], 86400, "Daily limit reached for this agent. Try again tomorrow.")`
4. `complete(s, row.provider, messages, model, JOB_MAX_TOKENS[job], { json: true, job })`

`complete()` in `services/assistant.ts:122` gains one optional last argument `opts?: { json?: boolean; job?: AgentJob }`:
- `json` adds `response_format: { type: "json_object" }` to the body, and for `openrouter` also `reasoning: { enabled: false }` (reasoning models otherwise spend the output budget and return truncated JSON).
- `mock` with `job` set returns the fixture below verbatim; without `job` the existing chat mock is unchanged.

Mock fixtures (exact strings; A1 and A2 tests assert on them):

```json
{"forward_followup": {"subject": "[mock] Quick follow-up", "body": "Hi {first_name},\n\n[mock] Happy to walk you and anyone on your team through this. Would 15 minutes this week help?"},
 "page_from_brief": {"headline": "[mock] A clearer path for your team", "subhead": "[mock] One page, three steps.", "pains": ["[mock] pain one", "[mock] pain two"], "how_we_help": [{"title": "[mock] Step one", "body": "[mock] What we do first."}, {"title": "[mock] Step two", "body": "[mock] What we do next."}], "proof": [], "cta_label": "[mock] Book a call"}}
```

### 5.3 API (additive, chat shapes unchanged)

- `GET /api/v1/assistant/config` adds `job_models: { forward_followup: string | null, page_from_brief: string | null }` (null = falls back to `model`).
- `PUT /api/v1/assistant/config` accepts optional `job_models` with the same keys; each value `string` 1..160 chars (upsert) or `null` (delete row). Same org-admin gate (`assistant.ts:71`), checked before any write.

## 6. A1 Forward alert + follow-up draft

### 6.1 Detection rule (exact)

Eligible click (function `isForwardEligible(e)` in `worker/src/services/forwardAlerts.ts`, the only place this is decided):
`device_type != 'bot'` (same as `REAL_CLICK`) AND `is_vpn = 0` AND `!isHostingAsn(asn_org)` AND `visitor_id` not empty.

Per asset (a link or a file), over eligible clicks in the last 30 days, ordered by `clicked_at`:
- **reason `cities`**: distinct `city|country_code` (city not empty) >= 2 AND distinct `visitor_id` >= 2. Fires once per asset. `dedupe_key = 'cities'`.
- **reason `new_company`**: company clicks are those with `company_domain` set, `lower(company_type)` not in `isp, hosting, vpn` (same exclusion as `journeys.ts:122`), and `company_domain` != the owner's email domain (unless that domain is a free-mail domain: gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com, proton.me). The first company domain seen is the original recipient. Every later distinct domain fires once. `dedupe_key = 'company:' || company_domain`.
- At most 5 alerts per asset, ever. Deleted files and assets with no owner are skipped.

Pure function `detectForwards(events, ownerDomain): Candidate[]` holds this logic and is unit-tested without D1.

### 6.2 When it runs

`scanForwards(env, db, now)` runs in the `*/15` cron branch (`worker/src/cron.ts:19-22`, add `["forward alert scan", ...]`). It takes assets with an eligible click in the last 20 minutes (5 minutes of overlap), at most 200 assets per run, re-evaluates each over its 30-day window (at most 2000 events), and inserts with `INSERT ... ON CONFLICT DO NOTHING` on the unique key. No watermark table.
`shortcut: a cron outage over 20 minutes misses those forwards, upgrade to a stored watermark if alerts go missing.`

### 6.3 Data

`worker/migrations/0013_forward_alerts.sql`:

```sql
CREATE TABLE IF NOT EXISTS forward_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('link', 'file')),
  asset_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('cities', 'new_company')),
  dedupe_key TEXT NOT NULL,
  cities TEXT NOT NULL DEFAULT '[]',          -- JSON array of "City, CC" at detection
  visitor_ids TEXT NOT NULL DEFAULT '[]',     -- JSON array, the visitors that make the forward
  company_name TEXT,
  company_domain TEXT,
  evidence_event_id TEXT,                     -- click_events.id that tipped the rule
  detected_at TEXT NOT NULL,
  seen_at TEXT,
  dismissed_at TEXT,
  draft_subject TEXT,
  draft_body TEXT,
  draft_model TEXT,
  draft_created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_forward_alerts_asset_key ON forward_alerts (asset_type, asset_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_forward_alerts_user_open ON forward_alerts (user_id, dismissed_at, detected_at DESC);
```

No raw IP, user agent or email is stored. `visitor_ids` are the existing random cookie ids.

### 6.4 J1 seam (deferred, named only)

J1 (human vs scanner click) feeds A1 through `isForwardEligible` alone. When PR #63 lands `click_events.is_scanner`, the change is one clause there (`&& !e.is_scanner`) plus selecting the column in `scanForwards`. A later J1 that scores humans can replace the whole predicate; nothing else in A1 reads raw clicks. `REAL_CLICK` stays the shared SQL predicate.

### 6.5 Draft context and prompt

Context built by code (`followupContext(db, alert)`), owner-scoped:
- `asset`: title (link `anchor_text || original_url`, file `filename`) and share URL, as `journeys.ts:93-95` builds them.
- `topics`: HTML Pages (`file_assets.kind = 'html'`, owned by `alert.user_id`, not deleted) where the alert's visitors have summed `dwell_ms >= 10000` in the 30-day window, top 3 by dwell. Each topic carries the page title and a 600-character plain-text excerpt of the current version from R2 (tags stripped). Dwell values are NOT sent to the model.
- `sender_notes` (code, never model): e.g. `Opened by 2 visitors in Mumbai, IN and Pune, IN`, `New company: Acme Corp (acme.com)`, `2m 10s on "Acme pricing" (page)`. Durations formatted `Xm Ys`.

System prompt (fixed string in `forwardAlerts.ts`):
> You draft a short follow-up email from the sender to the person they shared "{asset_title}" with. Write as the sender, plain text. Start with exactly "Hi {first_name},". Under 120 words. Offer to walk them and any colleagues through it, and end with one clear question. You may steer toward the TOPICS given, but never say or imply that you know what they read, opened, viewed, forwarded, how long they spent, where they are, or who else saw it. Do not invent names, numbers, dates, or claims. Return JSON: {"subject": string, "body": string}.

Output gate (deterministic, before saving): zod `{subject: 3..120 chars, body: 20..1200 chars}`; body must start with `Hi {first_name},`; reject when it matches `/\b(track|tracked|tracking|viewed|opened|forward|forwarded|dwell|read receipt|i (saw|noticed|see))\b/i` or contains any city name from the alert. Reject = 502 `The draft broke a privacy rule. Try again.`, nothing saved.

### 6.6 API

Router `worker/src/routes/alerts.ts`, mounted `app.route(\`${v1}/alerts\`, alerts)` after `app.ts:107`. Owner only: every query filters `user_id = caller`; another user's id answers 404.

| Method, path | Auth | Request | Response |
|---|---|---|---|
| GET `/api/v1/alerts/forwards?status=open\|all&limit=20` (limit 1..100) | `requireAuth` | | `200 {alerts: ForwardAlert[], unread: number}`; open = `dismissed_at IS NULL`; unread = open and `seen_at IS NULL` |
| POST `/api/v1/alerts/forwards/:id/seen` | `requireAuth` | | `204` |
| POST `/api/v1/alerts/forwards/:id/dismiss` | `requireAuth` | | `204` |
| POST `/api/v1/alerts/forwards/:id/draft` | `requireSessionAuth` (spends money, like `/assistant/chat`) | | `200 {draft: {subject, body, model, created_at}, sender_notes: string[]}`; 503 disabled or no key; 429 daily cap (30) or 6 per minute per user; 502 privacy gate; 404 not owner |

```ts
interface ForwardAlert {
  id: string;
  asset: { type: "link" | "file"; id: string; title: string; url: string };
  reason: "cities" | "new_company";
  cities: string[];               // "Mumbai, IN"
  visitors: number;
  company_name: string | null;
  detected_at: string;            // ISO UTC
  seen_at: string | null;
  dismissed_at: string | null;
  draft: { subject: string; body: string; model: string; created_at: string } | null;
  sender_notes: string[];
}
```

Draft only: no endpoint sends anything. The UI offers Copy, never Send or mailto.

## 7. A2 Page from a brief

### 7.1 API

`POST /api/v1/assistant/pages` in `worker/src/routes/assistant.ts` (same router, `requireSessionAuth`, `assertCanShare` like the pages routes).

Request (zod):
```ts
{ company: string 1..120, brief: string 20..2000, brand: "champions-group",
  cta_url?: https URL <= 500, title?: string 1..120, slug?: string, domain_id?: string, dry_run?: boolean (default true) }
```
`dry_run` defaults to TRUE so a forgotten flag never publishes.

Responses:
- dry run: `200 {html, content, model, usage, checks: {figures_ok: true, bytes: number}}`
- publish: `201 {page: <pageResponse(...) as POST /api/v1/pages returns>, url, model, usage}`
- `422 {detail: "The draft contained figures not in the brief: 40%, 3x. Edit the brief or try again."}` when the figure gate fails
- 503 disabled or no key; 429 daily cap 10 per user or 4 per minute; 409 slug taken (from `publish()`)

Flow: `completeJob(..., "page_from_brief", messages)` then parse content JSON, then figure gate, then `renderPage(brand, content, {company, ctaUrl})`, then if not dry run `publish(c, {user, payload: utf8(html), title: title ?? \`${company}: ${headline}\`.slice(0,120), slug, domainId, filename: null, contentType: "text/html"})` (`pages.ts:208`). `publish` must be exported from `routes/pages.ts` (or moved to `services/pages.ts`) without changing its behaviour.

### 7.2 Why copy JSON plus a template, not model HTML

The card says "the agent writes the HTML". The agent writes the page's words; the Worker writes the markup. Reasons: brand rules become a property of one template instead of a hope per generation; no model-authored `<script>`, `<iframe>` or external URL reaches a public share host; output is small and stable, so render tests are meaningful. Content schema:

```ts
{ headline: 8..90, subhead: 0..200, pains: string[2..4] each 4..160,
  how_we_help: {title: 2..60, body: 10..280}[2..4], proof: string[0..3] each <= 160, cta_label: 2..40 }
```

Figure gate: every match of `/\d[\d,.]*\s*(%|x|k|m|bn|million|billion)?/gi` in any content string must appear (case-insensitive, whitespace-normalised) in `brief` or `company`. Otherwise 422 and nothing publishes.

System prompt (fixed): "You write the copy for a one-page sales leave-behind from Champions Group to {company}. Use only facts in the BRIEF. No numbers, client names, quotes or claims that are not in the brief. Plain words, short sentences, no hype words (revolutionary, cutting-edge, game-changing, synergy). Return JSON matching the schema."

### 7.3 Template and brand (v1: Champions Group only)

`worker/src/services/pageTemplates/championsGroup.ts` exports `renderChampionsGroup(content, {company, ctaUrl}): string`. One self-contained HTML document, inline `<style>`, no `<script>`, no external requests (no webfonts, no images), every string HTML-escaped. Tokens from the `champions-group-brand` skill (`~/champ-skills/design/brand-guidelines/champions-group-brand/SKILL.md:37-84,142-144`):
- Orange `#F26722` for the headline accent rule, section numbers and the primary CTA (white text, hover `#D94F0A`, radius 8px)
- Ink `#1A1A1A` body and headings, Warm Gray `#6B6B6B` meta, Soft Peach `#FFF4EC` section band, Border Gray `#E5E7EB`
- Font stack `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif`; body 16px; h1 32 to 40px bold
- Name written "Champions Group" in text only. No drawn or substitute logo mark (brand rule at SKILL.md:109). Logo file placement is part of decision D3.
- Layout: header line "Champions Group for {company}", h1 headline, subhead, "What we heard" (pains), "How we help" (numbered steps), optional proof list, CTA button only when `cta_url` is set, footer meta line.
- Responsive: single column below 640px, max width 760px.

### 7.4 Proof by rendering

Render the dry-run HTML (mock content and one realistic hand-written content fixture) with Playwright at 1440x900 and 375x812 and assert: `document.documentElement.scrollWidth <= innerWidth` at 375; h1 computed color is `rgb(26, 26, 26)` or `rgb(242, 103, 34)`; CTA background `rgb(242, 103, 34)`; computed `font-family` starts with `Inter`; zero `<script>` and zero `<img>` in the HTML; zero requests other than the document; none of `[mock]`, `{first_name}`, `Champbeam`, `lorem`, `undefined`, `null` in the realistic fixture's text. Screenshots and the JSON of asserts go to `docs/agents-evidence/`. The `visual-verify` skill is the closing gate.

## 8. UI

Component picks (21st.dev, ids read from the component pages; install via shadcn CLI as the repo does for `kokonutui/ai-prompt.tsx`):

| Region | Component | 21st id / demo id | Install address | Role and visual contract |
|---|---|---|---|---|
| Alert bell + list | Origin UI Popover, "notifications" demo (`/@originui/components/popover/notifications`) | 1174 / 399 | `@21st/originui/popover` | Bell in `Navigation.tsx` nav bar; count badge = `unread`; list rows with unread dot = `seen_at null`; "Mark all as read" calls `/seen` per open unread alert. Tokenised shadcn (0 CSS-module classes, 4 hex literals in preview). |
| Copy draft | ncdai Copy Button (`/@ncdai/components/copy-button`) | 14851 / 28469 | `@21st/ncdai/copy-button` | Copies `subject + "\n\n" + body`; check icon for 2 s after copy. No send control anywhere. |
| Brief input | existing `frontend/src/components/kokonutui/ai-prompt.tsx` | in repo | none | The brief textarea for A2. |
| Preview frame | plain `<iframe sandbox="" srcdoc>` inside the repo `Card` | none | none | Rejected `@dillionverma/safari` (56 hex literals in preview, a full tokenising pass for a frame). |
| Chips, buttons, empty, confirm, QR | repo `ui/` (`Badge`, `Button`, `EmptyState`, `ConfirmDialog`, `QrButton`) | in repo | none | Reason chip (`cities` = "Forwarded: 2 cities", `new_company` = "New company: Acme"), city chips, confirm before publish, QR on the result. |

## 9. Decisions

Settled by the planner (written into every child card): detection thresholds (6.1), 30-day window, 5 alerts per asset cap, owner-only scope, drafts on demand only, privacy gate words, per-job caps (30 and 10 per day), JSON-plus-template for A2, `dry_run` default true, migration numbers 0012 and 0013, Champions Group template first.

Open for Deep (needs_input cards, recommendation first):
- **D1 OpenRouter key for ChampBeam.** A: a separate key with its own credit limit, set as `ASSISTANT_OPENROUTER_API_KEY` on staging then production (recommended: product traffic cannot drain the weekly cap the Hermes lanes share). B: reuse the shared Hermes key. C: hold; everything ships on `mock` and returns 503 on real calls.
- **D2 Alert channel.** A: in-app only for v1 (recommended, built as such). B: also email the sender through the Cloudflare Email binding once PR #65 lands. C: also POST the existing signed open webhook.
- **D3 Brands for A2.** A: Champions Group now, LakeB2B template next (recommended). B: Champions Group only. C: per-org brand kit later. Plus: may the template carry the real logo file from the brand skill.

## 10. Build order and cards

1. F foundation (default) → 2. A1 backend (default) and A2 backend (default), parallel → 3. A1 UI (frontend) after A1 backend; A2 UI (frontend) after A2 backend → 4. staging smoke (default) after D1 and both UIs. D2 and D3 are decision cards. Every build card ends with `kanban_request_review(reviewer="reviewer")`.

Branches and PR bases (stacked, Deep merges):
- `feat/agent-foundation` from `origin/main`, PR into `main`
- `feat/agent-forward-alerts` and `feat/agent-page-from-brief` from `feat/agent-foundation`, PR into it
- `feat/agent-forward-alerts-ui` from `feat/agent-forward-alerts`; `feat/agent-page-from-brief-ui` from `feat/agent-page-from-brief`

## 11. Gates for every backend card

`cd worker && npm ci && npm run typecheck && npx vitest run` (full suite green, every new test passes alone with `-t`), `python3 ~/champ-skills/security/ultimate-security/scripts/deploy_gate.py check .`, `docs/API.md` updated in the same PR, PR body via `--body-file`. No deploy, no secret, no real model call.

## 12. Not verified by this plan

- Real OpenRouter behaviour with any chosen model (needs D1). Model ids are picked by the admin per job; none is fixed here.
- Volume: how many alerts real traffic produces under the 6.1 rule. Measure on staging data in the smoke card before turning the bell on for everyone.
- Whether legacy Railway `page_engagements` rows carry `page > 0`; the plan sums per asset and ignores `page`.

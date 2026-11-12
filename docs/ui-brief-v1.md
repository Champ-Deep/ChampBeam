# ChampBeam UI brief v1: rebuild the app surfaces on 21st.dev components

Status: PROPOSED (planner card t_7d709e07, 11 Nov 2026). Executes in one frontend card on branch `feat/ui-redo-21st`.
Probed against `origin/main` at `20018c6`. Every file:line below is from that commit.

## 0. Why, and what done looks like

Deep's verdict on https://champbeam.com: the UI looks bad. He has asked twice for it to be rebuilt on 21st.dev components.
Done means: the shell, auth screens, Files, Links, Pages, Settings (Domains first) and Home render through the 21st.dev
components named in section 4, on one token set, with every state (loading, empty, error, populated) shown as chips,
badges, meters and layout, and the gates in section 7 pass with their numbers reported.

Presentation only. No API, route, query key, auth flow or data change. The one code exception is the session latch in 3.4,
which is an existing commit being carried over, not new auth logic.

### Precedence with the sibling card t_dde30d1f (self-serve orgs UI)

t_dde30d1f runs first and edits the same frontend. It owns behaviour and component choice for: the org switcher, create org,
members table, invite sheet, accept invitation, the Domains DNS records card (copy buttons, "Copy all for IT", status, Recheck),
and the super admin screens. This brief owns layout, tokens and restyling. Where both touch a surface, this brief
**re-skins what t_dde30d1f shipped and never swaps its component or changes its behaviour**. The ids for those slots below are
copied from t_dde30d1f so the two cards agree.

### Deferred scope (not this round)

- Analytics pages (`AnalyticsPage`, `LinkAnalyticsPage`, `FileAnalyticsPage`, `PageAnalyticsPage`, `TeamAnalyticsPage`,
  `Campaign*`, `PerformancePage`): token restyle only. They inherit the shadcn bridge in 3.2 and the shell; no layout or
  component changes. `GeoChart` and recharts colours stay.
- `VaultPage`, `ContentLibraryPage`, `ProjectsPage`, `ProjectDetailPage`, `LinkGenerator`, `PresetsManager`: token restyle
  only, inside the new shell and page header.
- Signed-out marketing nav (`components/layout/Navigation.tsx`): token restyle only.
- A Cmd+K command palette. Searched (Command Menu with Global Search, ephraimduncan, id 13877, demo 27378) but nobody asked
  for it and it adds `cmdk`. List search lives in the page header instead.
- A true dark mode. See ruling R2.

## 1. Reuse inventory (read before you build)

Port exactly (logic is correct, restyle the markup around it only):

| Path | What it holds | Rule |
|---|---|---|
| `frontend/src/api/*.ts`, `api/_shared.ts` | every request, error helpers (`apiErrorStatus`, `apiErrorDetail`) | do not edit |
| `frontend/src/lib/format.ts` | `formatBytes`, `formatDwell`, `formatRelative`, `downloadLink` | use for every size, time, URL |
| `frontend/src/hooks/useShareLists.ts` | Files, Pages, Links queries shared by sidebar counts and Home | keep query keys |
| `frontend/src/hooks/useOrgContext.ts` | `inOrg`, `canReport`, permissions, role | nav gating stays as `Sidebar.tsx:93-110` |
| `frontend/src/hooks/useTheme.ts` | 5 palettes stamped as `data-cb-theme` on `<html>` | keep; Appearance picker keeps working |
| `frontend/src/lib/authClient.ts` | `useAuth()` | only the latch change in 3.4 |
| `frontend/src/pages/AuthPages.tsx:13-28,66-131` | email regex, Better Auth error code to field mapping, submit handlers, Google flow | port exactly, restyle `AuthShell`, `GoogleButton`, `FormAlert` only |
| `frontend/src/components/layout/Sidebar.tsx:53-110` | click notifications, vault gate, counts, nav items, visibility rules | port exactly into the new rail |
| `frontend/src/components/AccountFooter.tsx:11-27` | name, initials, image fallback, sign out with error | port exactly into the new account menu |
| `frontend/src/components/OrgSwitcher.tsx` (or what t_dde30d1f replaced it with) | org switching | re-skin only |
| `frontend/src/pages/FilesPage.tsx:140-193` | selection limited to visible rows, bulk move | keep; Files is the only list with selection |
| `frontend/src/pages/FilesPage.tsx:95,346-378`, `api/files.ts:135` | real upload percent via `onUploadProgress` | feed the meter in 4.3 |
| `frontend/src/pages/LinksPage.tsx:66-121` | folder filter plus text search over links | keep the filter; move the input into the header |
| `frontend/src/pages/SettingsPage.tsx:28-40` | domain status labels and badge variants | keep as the chip mapping |
| `frontend/src/components/ShareComposer.tsx`, `ComposerControls.tsx` | composer on 21st `ephraimduncan/file-upload` plus kokonutui `ai-prompt` and `smooth-tab` | Home keeps it; re-skin only |
| `frontend/src/components/ui/*` house set | Button, Input, Card, Badge, ConfirmDialog, FolderChips, QrCode, DateRangePicker, ExportButton, dropdown-menu, textarea | keep their props; restyle internals to tokens |
| `frontend/src/components/ui/EmptyState.tsx`, `LoadingSpinner.tsx` | used across pages | keep the export names and props; change internals (4.3) so call sites do not move |

## 2. Deliverable format

A React SPA served by the Cloudflare Worker `worker/` (same origin as `/api/auth`). Build with
`env -u VITE_API_URL npm run build` in `frontend/`. Preview on the staging worker only: `wrangler deploy --env staging`
from `worker/`, which serves https://champbeam-staging.deep-ae0.workers.dev (`worker/wrangler.jsonc:102-110`). The staging
worker is shared with t_dde30d1f; the last deploy wins, so report your deployment id.
Never deploy the production `champbeam` worker (`worker/wrangler.jsonc:24`) and never attach a domain or route.

## 3. Design tokens

### R1. Ruling: the `--cb-*` set stays

The `--cb-*` tokens in `frontend/src/index.css:10-66` (mapped to Tailwind at `:70-87`) stay the single source of colour. The identity (Paper: cream canvas,
ink, terracotta; Space Grotesk headings, Hanken Grotesk body, JetBrains Mono for data) is what `DESIGN.md` locks, and the
"looks bad" problem is not the palette. It is three measured defects:

1. **No shadcn semantic variables exist.** `index.css` defines no `--background`, `--foreground`, `--muted-foreground`,
   `--primary`, `--ring` and so on, yet the code already uses them: `grep` counts 13 `text-muted-foreground`, 8 `bg-accent`,
   6 `bg-background`, 5 `text-foreground`, 4 `ring-ring`, 4 `border-input`, 4 `bg-popover`, 4 `bg-muted`, 3 `bg-primary`.
   Every installed shadcn or 21st.dev component therefore renders unthemed. Fix: the bridge in 3.2.
2. **Hardcoded colour bypasses the themes.** 109 hex literals across 14 `.tsx` files and 820 raw palette utilities
   (`text-slate-*`, `bg-gray-*`, `bg-green-100` and so on, e.g. `ui/Badge.tsx:12-16`, `ui/EmptyState.tsx:13-17`,
   `Sidebar.tsx:39`). Fix: tokens only in every file this card touches.
3. **Contrast failures** (measured, 3.3).

### 3.1 Token value changes (the only new values)

Change one value and add six shared tokens. Everything else keeps its current value.

```css
/* Paper only: was #F8ECE5, accent text on it measured 4.41:1. New value measures 4.59:1. */
:root, :root[data-cb-theme="paper"] { --cb-accent-soft:#FAF1EC; }

/* Shared by all five palettes (put in the plain :root block). */
:root {
  --cb-surface:#FFFFFF;       /* cards, popovers, inputs. Replaces bg-white and #fff in components */
  --cb-side-text:#DAC8BF;     /* sidebar body text. Already forced by workspace.css:10, now a token */
  --cb-success:#166534; --cb-success-soft:#ECFDF3;   /* 6.76:1 on soft, 7.13:1 on surface */
  --cb-warning:#92400E; --cb-warning-soft:#FFF7E6;   /* 6.65:1 on soft, 7.09:1 on surface */
  --cb-danger:#991B1B;  --cb-danger-soft:#FFF4F2;    /* 7.71:1 on soft, 8.31:1 on surface */
}
```

Usage rules that fix the remaining failures without new values:
- Hairline dividers keep `--cb-border` / `--cb-divider` (decorative, no ratio needed).
- **Form control borders** (inputs, selects, the upload dropzone edge, checkbox outline) use `--cb-icon`: measured 3.26 to
  3.64:1 against `--cb-input` and 3.54 to 3.98:1 against `--cb-surface` on all five palettes. `--cb-border-strong` measured
  1.26 to 1.44:1 and must not be a control's only boundary.
- `--cb-icon-muted` (2.08 to 2.27:1) and `--cb-faint` (1.69 to 1.84:1) are decorative only: never text, never an icon that
  carries meaning. Meaningful icons use `--cb-icon` (3.39 to 3.79:1 on `--cb-bg`) or `--cb-muted`.
- Primary buttons: `--cb-ink` fill with `--cb-surface` text (DESIGN.md section 2).

### 3.2 shadcn bridge (add to `index.css`, below the theme blocks)

```css
:root {
  --background: var(--cb-bg);          --foreground: var(--cb-ink);
  --card: var(--cb-surface);           --card-foreground: var(--cb-ink);
  --popover: var(--cb-surface);        --popover-foreground: var(--cb-ink);
  --primary: var(--cb-ink);            --primary-foreground: var(--cb-surface);
  --secondary: var(--cb-chip);         --secondary-foreground: var(--cb-ink);
  --muted: var(--cb-chip);             --muted-foreground: var(--cb-muted);
  --accent: var(--cb-bg-hover);        --accent-foreground: var(--cb-ink);
  --destructive: var(--cb-danger);
  --border: var(--cb-border);          --input: var(--cb-icon);          --ring: var(--cb-accent);
  --radius: 0.625rem;
  --sidebar: var(--cb-side1);          --sidebar-foreground: var(--cb-side-text);
  --sidebar-primary: var(--cb-accent-light); --sidebar-primary-foreground: var(--cb-side1);
  --sidebar-accent: var(--cb-side3);   --sidebar-accent-foreground: var(--cb-surface);
  --sidebar-border: color-mix(in srgb, var(--cb-surface) 10%, transparent);
  --sidebar-ring: var(--cb-accent-light);
}
@theme inline {
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring);
  --color-sidebar: var(--sidebar); --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary); --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent); --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border); --color-sidebar-ring: var(--sidebar-ring);
  --color-success: var(--cb-success); --color-success-soft: var(--cb-success-soft);
  --color-warning: var(--cb-warning); --color-warning-soft: var(--cb-warning-soft);
  --color-danger: var(--cb-danger);   --color-danger-soft: var(--cb-danger-soft);
  --color-surface: var(--cb-surface);
  --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px);
}
```

When the shadcn CLI writes its own `:root` / `.dark` blocks into `index.css` during install, delete them and keep this
bridge. The CLI must not add oklch neutrals.

### 3.3 Contrast, measured (WCAG relative luminance, run in the planner session on `index.css` at 20018c6)

Pass on all five palettes: ink/bg 15.83 to 16.80, text/bg 9.32 to 11.34, text-mid/bg 5.74 to 7.00, muted/bg 5.07 to 5.17,
muted/surface 5.37 to 5.40, muted/chip 4.61 to 4.84, accent/bg 4.83 (Paper) to 12.06, surface on accent 5.12 to 12.60,
white on side1 17.07 to 18.44, side-text on side1 10.56 to 11.41, side-text on side3 8.53 to 10.43, accent-light on side1
7.63 to 9.11, white on side3 13.78 to 16.85.
Failed and fixed above: Paper accent on accent-soft 4.41 (new value 4.59), border-strong as a control edge (rule moved to
`--cb-icon`), icon-muted and faint (declared decorative).
Paper is the tightest palette: accent on bg is 4.83, so terracotta text is allowed for links and active labels but not
below 14px.

### R2. Ruling: "light and dark" means Paper and Graphite

ChampBeam has no dark mode. `DESIGN.md` section 2 says the four alternates are light workspace palettes with dark
sidebars, and `useTheme.ts:6` ships `paper, graphite, lagoon, merlot, slate`. Building a dark content mode is a feature, not
a restyle, so it is out of this round. The screenshot matrix in 7.3 uses Paper (default, warmest) and Graphite (most
neutral, highest-contrast ink) as the two themes, and the contrast test in 7.2 covers all five. Deep can overturn this; a
dark mode would be its own card with its own token set.

### 3.4 Type and data

- Display: Space Grotesk; body: Hanken Grotesk; mono: JetBrains Mono (`index.css:84-86`). Locked.
- Sizes from `DESIGN.md` section 3: page title 28/1.2 bold, section 20/1.3 semibold, body 16/1.5, metadata 14/1.5.
- Every URL, slug, hostname, short code, DNS name and DNS value renders in `font-mono` (`--font-mono`). No exceptions.
- Numbers in tables use `tabular-nums`.
- No em dashes or en dashes in any copy, label, toast, aria-label or placeholder. Replace existing ones you touch
  (e.g. ellipsis loading strings stay, dash separators become a period or comma).

### 3.5 Session latch (carry over, do not reinvent)

`origin/main` does not have it: `lib/authClient.ts:12-14` returns `isLoaded: !isPending`, and Better Auth 1.7.18 flips
`isPending` back to true on focus refetch, so `ProtectedRoute` (`App.tsx:27-31`) returns `null` and unmounts the tree,
wiping half-typed forms. The fix exists as commit `cf34de1` on `origin/feat/better-auth-ui` (6 files, adds
`SessionScope.test.tsx`), and it cherry-picks cleanly onto `20018c6` (checked with `git cherry-pick --no-commit`).
After merging `origin/main`, if `git merge-base --is-ancestor cf34de1 HEAD` fails, `git cherry-pick cf34de1` first.
Then: no component may render a whole-app spinner or `null` on `isPending` after first load. The shell, sign-in and
sign-up keep their DOM across a tab refocus (gate 7.4).

## 4. Section-by-section spec

### 4.0 Component table

Ids are 21st.dev's component id and demo id, read from each component page's data. Install address is what the shadcn CLI
takes (`components.json` already has the `@21st` registry with `${TWENTY_FIRST_API_KEY}`). Every install address below
was resolved against `https://21st.dev/r/<author>/<slug>` (returns the component record, auth required for source).

| # | Region | Component | Author | Component id | Demo id | Install | Role | Visual contract (what each element encodes) |
|---|---|---|---|---|---|---|---|---|
| 1 | App shell rail | Sidebar | shadcn | 1439 | 1627 | `@21st/shadcn/sidebar` | Rail, collapsible to icons at 768 to 1023, Sheet drawer under 768 | Fill `--sidebar` = active palette's side1. Active row = `--sidebar-accent` fill plus a 2px `--sidebar-primary` leading bar. Count pill = number of items in that list (from `useShareLists`), hidden at 0. Dot on Recent opens = unread opens exist |
| 2 | Org switcher (rail header) | Workspaces | efferd | 3483 | 4511 | `@21st/efferd/workspaces` | Owned by t_dde30d1f; this card places and re-skins it | Avatar tile = org initial on `--sidebar-accent`; label = active workspace name; role badge = your role in it; check = active row. No gradient avatars (the demo's purple to pink gradient is banned) |
| 3 | Account menu (rail footer) | User Profile Dropdown Menu | shadcnspace | 12093 | 24857 | `@21st/shadcnspace/dropdown-menu-01` | Avatar trigger plus Radix menu | Avatar = image, else initials. Header = name plus email (email in mono). Items: Workspace settings, Sign out. Drop the demo's online dot, subscription and invoice rows (no such data) |
| 4 | Page header and list toolbar | Search Toolbar Page Header | olewandowski1 | 13442 | 26793 | `@21st/olewandowski1/page-header-5` | One header pattern for every page | Title 28px, one-line lede, one primary action at right (Upload on Files and Pages, New link on Links). Toolbar: search input (wires to the existing filter state), FolderChips where the page has folders, a count chip "N of M" when a filter is active |
| 5 | Sign in, sign up | Auth Form | educalvolpz | 14880 | 28499 | `@21st/educalvolpz/auth-form` | Card layout for both auth routes | Order: Logo, title, lede, Continue with Google (only when `googleSignInEnabled`), divider "or use your email", fields, submit, footer link. Drop the demo's "Email link" button and its progressive password reveal: email and password are both visible from the start so password managers autofill. Field errors under the field in `--cb-danger`; form errors in a `--cb-danger-soft` alert |
| 6 | Files, Links, Pages tables | Data Table | ephraimduncan | 14714 | 28327 | `@21st/ephraimduncan/table-05` | Shared list markup for the three surfaces (separate pages, separate columns) | Row = one item. Name cell: type icon plus name, URL or slug under it in mono, truncated with a title tooltip. Status column = Badge chip (4.2 mapping). Opens column = number, tabular. Updated = `formatRelative`. Row menu (house `dropdown-menu`) at right. Selection checkboxes on Files only. Sort by header click on Name, Opens, Updated. Under 700px rows become stacked cards with the same chips |
| 7 | Upload dropzone | File Upload | ephraimduncan | 2288 | 2417 | already installed at `components/ui/file-upload.tsx` | Drop target on Files and Pages | Dashed edge in `--cb-icon`; accent edge while dragging; accepted types and size limit as chips under the target |
| 8 | Upload progress rows | Attachment States | uiable | 14658 | 28271 | `@21st/uiable/attachment-states` | One row per uploading file | State icon plus label: Uploading with a meter bar at the real percent from `api/files.ts:135`, Processing (finalize), Uploaded (success chip), Failed (danger chip plus Retry). Bar fill `--cb-accent` on `--cb-track` |
| 9 | Empty states | Empty | shadcn | 5851 | 8624 | `@21st/shadcn/empty` | Body of the house `EmptyState` (props unchanged) | Icon in a `--cb-chip` tile, title, one line, one action. Two variants: "nothing yet" (primary action: Upload or New link) and "no match" (action: Clear filters). No tinted card background |
| 10 | Loading states | Data Table Skeleton | cnippet-dev | 9594 | 19002 | `@21st/cnippet-dev/v-skeleton-7` | Replaces `LoadingSpinner` on Files, Links, Pages and Home recents | Skeleton rows match the real row height and column count of each table, so layout does not jump. Pulse off under reduced motion |
| 11 | Skeleton primitive | Skeleton | shadcn | 25973 | 44951 | `@21st/shadcn/skeleton` | Used by 10 and by Settings panels | `--cb-chip` block |
| 12 | Settings layout | Vertical Settings Tabs | cnippet-dev | 12171 | 24937 | `@21st/cnippet-dev/v-tabs-13` | Left tab column at 1024 and up; horizontal scrolling tab strip under 1024 | Active tab = 2px `--cb-accent` bar plus ink label. Tabs are the existing `SettingsTab` values (`SettingsPage.tsx:183-253`), in the same order; Presets stays a link to `/links?tab=utm&panel=presets` |
| 13 | Domains DNS values | Copy With Confirmation | ibrandify | 20457 | 36536 | `@21st/ibrandify/copy-with-confirmation` | Owned by t_dde30d1f; this card re-skins it | Each record row: type chip (CNAME, TXT), name and value in mono, copy button whose check state lasts about 1.5s. Its demo carries 38 inline hex values: all become tokens |
| 14 | Toasts | Sonner | shadcn | 317 | 886 | `@21st/shadcn/sonner` | Themed wrapper for the `Toaster` already mounted at `main.tsx:31` | Success, error, info take the status tokens; position and duration unchanged |
| 15 | Home | reuses 4, 6 (compact), 10 | | | | | Home recents | See 4.5 |

Finalists opened and rejected, with reason:
- Dashboard Shell (isaiahbjork, 24925 / 43212): best composition reference (workspace block, grouped nav with counts, quota
  footer), but 85 hardcoded hex values in its preview. Use it as the layout reference for row 1, do not install.
- Sidebar Light (inference-sh, 9938 / 19361): nested items ChampBeam does not have.
- User Menu (kuratlielia, 19583 / 35060), Filter Toolbar (kuratlielia, 19554 / 35030), Segmented Control (kuratlielia,
  19544 / 35020): styled with CSS modules (hashed `_trigger_19yj1_4` class names), not Tailwind, so tokens cannot reach them.
- Login and Signup (ephraimduncan, 3379 / 4333): SSO button, no Google. Authentication Card (ahmedmayara, 4076 / 5657): no
  social button.
- Basic Data Table (preetsuthar17, 2621 / 2750), Data Table Toolbar (skovhm, 22876 / 39966): more machinery (column
  visibility, export) than the lists need.
- Empty State (serafimcloud, 256 / 1435): dashed box plus stacked icons reads as decoration.
- Input Group Copy Button (sean0205, 16026 / 29765), Code Block (ebnsina, 21339 / 38117): the Domains copy slot is already
  decided by t_dde30d1f.
- Sync Status Toast (shadcnspace, 9732 / 19146): Sonner wrapper covers it.

### 4.1 App shell (priority 1)

Source: `App.tsx:48-63` (`Chrome`), `components/layout/Sidebar.tsx`, `AccountFooter.tsx`, `OrgSwitcher.tsx`, `workspace.css:1-20`.

Top to bottom of the rail:
1. Logo (`ui/Logo.tsx`, `tone="dark"`), collapse toggle at right (laptop only).
2. Org switcher (row 2). Under it nothing else; the account block moves to the footer.
3. Nav, one group, in the order and visibility rules of `Sidebar.tsx:93-110`: Share, Links, Files, Pages, Vault, Library,
   Reporting, Analytics, Settings. Count pills on Links, Files, Pages.
4. Footer: Recent opens (popover keeps `Sidebar.tsx:136-185` content; location and device as chips, not "a · b" prose),
   Assistant launcher, account menu (row 3).

Widths: 1024 and up, full rail 240px. 768 to 1023, icon rail 56px with tooltips (house `@radix-ui/react-tooltip`).
Under 768, a 56px top bar (logo, page title, menu button) and the rail opens as the Sidebar's Sheet. Keep the skip link
(`Sidebar.tsx:194`) and 44px minimum targets.

Page header: every in-scope page starts with row 4. Replace the ad hoc `h1` blocks at `FilesPage.tsx:453`,
`LinksPage.tsx:363`, `PagesPage.tsx:146`, `SettingsPage.tsx:61`, `HomePage.tsx:15`.
Links sub-nav (`LinksPage.tsx:355-359`, "Tracked links" and "UTM, presets and bulk CSV") becomes the house kokonutui
`smooth-tab` under the header. Same URLs.

### 4.2 Status chips (shared)

House `ui/Badge.tsx` keeps its variant names; its classes move to tokens:
`default` chip/ink, `info` accent-soft/accent, `success` success-soft/success, `warning` warning-soft/warning,
`danger` danger-soft/danger. Every chip carries a 6px leading dot in the text colour so state is not colour alone.
Domain mapping stays `SettingsPage.tsx:28-40` (Waiting on CNAME = warning, Issuing certificate = info, Active = success,
Failed = danger) unless t_dde30d1f changed the status set, in which case map its states by the same rule: waiting on the
user = warning, waiting on us = info, done = success, broken = danger.

### 4.3 Sign in and sign up (priority 2)

Source: `pages/AuthPages.tsx`. Restyle `AuthShell` (`:30-44`), `GoogleButton` (`:46-59`), `FormAlert` (`:62-64`) onto
row 5. Keep ids, `autoComplete`, `noValidate`, `aria-busy`, the busy labels and every error string. Full-height `--cb-bg`
canvas, one 400px card on `--cb-surface`, no illustration, no gradient. Google button: outline, Google "G" mark, 44px.
Wordmark from `ui/Logo.tsx` with `tone="light"`.

### 4.4 Files, Links, Pages (priority 3, three separate surfaces)

One shared table pattern (row 6), three pages, each keeping its own columns and actions:
- **Files** (`FilesPage.tsx`): header action Upload; dropzone (row 7) above the table; progress rows (row 8) between them
  while uploading. Columns: Name (filename plus share URL in mono), Size (`formatBytes`), Opens, Updated, row menu (the
  actions the page already has: copy link, QR, analytics, move, delete with `useConfirm`). Selection plus bulk move bar
  as now (`:140-193`).
- **Links** (`LinksPage.tsx`): header action goes to the UTM tab as now. Columns: Destination (original URL in mono,
  short link under it in mono), Folder chip, Clicks, Created, row menu. Search input in the header drives `search`
  (`:68`); folder filter stays FolderChips.
- **Pages** (`PagesPage.tsx`): header action Upload; columns: Title, page URL in mono, Views, Updated, row menu.
- States, per surface: loading = row 10; empty = row 9 "nothing yet"; filtered to zero = row 9 "no match"; error =
  `--cb-danger-soft` inline alert with Retry calling the query's `refetch`. Never a full-page spinner.
- Replace `FilesPage.tsx:651`, `PagesPage.tsx:178,629,894`, `LinksPage.tsx:530` spinners.

### 4.5 Settings, Domains first (priority 4)

`SettingsPage.tsx` moves into row 12. Domains is the default tab (`initialTab` already returns `'domains'`, `:22-26`).
Domains panel: add-hostname form at top (one input in mono plus Add), then one card per domain: hostname in mono, status
chip (4.2), primary badge, DNS records with row 13 copy buttons, Recheck and Remove in a row menu. Whatever t_dde30d1f
built inside this panel keeps its behaviour; this card applies tokens, spacing and the tab layout only.
Other tabs (API keys, Appearance, Notifications, System, Assistant) inherit tokens and the panel spacing, no rework.
`OrganizationSettings` above the tabs (`:61`) moves into an Organization tab only if t_dde30d1f has not already placed it.

### 4.6 Home (priority 5)

`HomePage.tsx`: header (row 4, title "Share", lede kept), the composer unchanged, then "Recent shares" as three compact
tables (row 6, 3 rows each, Name plus Updated only) in a 3-column grid at 1024 and up, stacked below. Section title is a
link with a count chip. Loading = row 10 at 3 rows; error = inline alert with Retry (`:19` logic); empty = one line plus
the composer as the call to action. Keep the "same last-365-days view" help text as a small muted line.

## 5. Data honesty

- Every count, percent and status comes from an existing query or mutation state. No sample rows, no demo names
  (Acme, Jamie Rivera, John Doe), no invented plan badges ("Pro", "Free"), no online dots.
- Remove every demo image URL the installs bring in (e.g. the `cdn.21st.dev/assets/mirror/...` images at
  `components/ui/file-upload.tsx:241,251,261` if they render anywhere in scope).
- Copy stays truthful to `DESIGN.md` section 7: shares are not email sends; do not invent a default domain.

## 6. Stack

Fixed: Vite 7, React 18, TypeScript, Tailwind 4, Radix, lucide-react, motion, shadcn CLI with the `@21st` registry.
Install on nvm node v24 (`nvm use 24`) with `TWENTY_FIRST_API_KEY` set in the shell environment (never written to a file,
never committed). Allowed new npm deps: only what a listed component's registry entry pulls in; list each in the PR with
the component that needed it. If a component pulls `@tanstack/react-table` or `cmdk`, prefer porting its markup onto the
existing arrays instead and say which you chose.
React 18 note: some registry components target React 19 (`ref` as a prop). Wrap with `forwardRef` rather than upgrading.

## 7. QA gates (all required, report the numbers)

Baseline measured in the planner session on `20018c6` with node v24.21.0 after `npm ci`:
`npx tsc -b` exit 0; `npm run lint` exit 0 with `54 problems (0 errors, 54 warnings)`; `npx vitest run`
`14 passed` files, `98 passed` tests. These move once t_dde30d1f lands, so re-measure after merging `origin/main` and
before your first edit, and record that as the baseline.

7.1 `npx tsc -b` exits 0. `npm run lint` shows 0 errors and no more warnings than your recorded baseline.
`npx vitest run` passes with no fewer tests than the baseline plus the new ones below.

7.2 New test `frontend/src/test/contrast.test.ts`: read `src/index.css`, resolve each palette's tokens (Paper from the
`:root` block, the shared tokens from 3.1), and assert per palette: ink, text, text-mid, muted on bg at 4.5 or more;
muted on surface and chip at 4.5; surface on accent at 4.5; accent on accent-soft at 4.5; side-text on side1 and side3 at
4.5; icon on bg, input and surface at 3.0; each status colour on its soft and on surface at 4.5. It must fail on the
old Paper `--cb-accent-soft:#F8ECE5` (4.41) and pass on `#FAF1EC` (4.59).

7.3 Screenshot matrix against the staging worker, with Playwright, saved under `frontend/qa/screenshots/ui-v1/` as
`<surface>-<state>-<theme>-<width>.png`. Widths 375, 768, 1440. Themes Paper and Graphite (R2). Surfaces and states:
sign-in (blank, field errors), sign-up (blank), shell with rail open on phone, Files (populated, empty, loading, upload in
progress), Links (populated, empty, no match), Pages (populated, empty), Settings Domains (one pending and one active
domain), Home (populated). That is 14 surface states x 2 themes x 3 widths = 84 images. Loading: hold the list request
with a Playwright route for 3s. Empty: a fresh staging account. Plus Files populated at 1440 in Lagoon, Merlot, Slate (3
more). Use `responsive-viewport-qa` and close with `visual-verify`.

7.4 Behaviour checks, scripted in the same Playwright run, each printing PASS or FAIL:
- At 375, `document.documentElement.scrollWidth === 375` on every surface.
- Sign-in: type an email, dispatch `visibilitychange` plus `focus` on window, wait 2s: the typed value is still there and
  the form element is the same node (latch).
- Every in-scope page: Tab reaches the skip link first and every row menu; focus ring visible (`--cb-ring`).
- `prefers-reduced-motion: reduce` emulated: no skeleton pulse, no transition longer than 0ms on rail collapse.
- All row menu actions and copy buttons still call the same API as before (spot-check 1 per surface by network log).

7.5 Content greps (run from `frontend/`, portable on macOS):
```
# a) dashes: must print 0 for files you changed. main already has 21 hits (mostly comments, e.g. App.tsx:34,
#    SystemSettings.tsx:41); fix the ones in user-facing copy you touch and list the rest.
git diff origin/main --name-only --relative -- src | python3 -c "import sys,re;b=[f'{f}:{n}' for f in sys.stdin.read().split() for n,l in enumerate(open(f,errors='ignore'),1) if re.search('[\u2013\u2014]',l)];print(len(b),b)"
# b) colour: must print nothing. Every .tsx you changed has no hex and no raw palette utilities.
git diff origin/main --name-only --relative -- src | grep -E '\.tsx$' | xargs grep -nE '#[0-9A-Fa-f]{3,8}\b|(bg|text|border)-(slate|gray|zinc|neutral|green|red|yellow|blue|amber|emerald)-[0-9]'
```
Hex lives only in `index.css` token blocks.

## 8. Do not touch

- `frontend/src/api/**`, `worker/**` (read only; you may run `wrangler deploy --env staging` from it), `backend/**`,
  route definitions in `App.tsx:70-103`, query keys, `frontend/.env*`, `components.json` registries.
- The Google sign-in flow in `AuthPages.tsx:46-59` (markup only).
- The main checkout `/Users/deep/repos/ChampBeam` (another branch with uncommitted work is checked out there).
- The production `champbeam` worker, any domain, route or DNS record. No merge into `main`.
- t_dde30d1f's component choices and behaviour (precedence note in section 0).

## 9. Handover contract (put this in the review request)

- Branch, head commit, draft PR URL into `main`, staging deployment id.
- Baseline vs final numbers for tsc, lint warnings, vitest files and tests.
- Each component from 4.0 actually installed, its install address, local path, and every compatibility patch.
- Every new npm dependency and why.
- Screenshot directory path plus the absolute paths in `artifacts`, and the 7.4 PASS/FAIL lines.
- Output of both 7.5 greps.
- Anything skipped or left on the deferred list, by name.

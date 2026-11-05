# Domain setup verification

## Status
Local implementation is ready for review. Publication is held because the card forbids deployment, but the repository's integrations automatically build and deploy branch previews. No push, PR, deploy, DNS change or auth change was performed by this task.

Branch: `feat/domain-records-ui`, based on approved backend commit `4c03f8967792d312f1e42cc84c40c183db47c531`.
Workspace: `/Users/deep/.hermes/kanban/workspaces/t_2c713eda/repo`.
Local fixture URL: `http://127.0.0.1:3206/settings?role=admin&state=dns&theme=paper`.

## Implemented
- Extended the existing SettingsPage domain row. This base has no RowPanel component, so its existing DomainRow and useMutation patterns were retained.
- Semantic four-column DNS table in the house Card. Below 620px available component width, labelled cells stack with wrapped tokens and no horizontal scroll.
- Every DNS name and value is copyable. Required ncdai Copy Button, 21st.dev demo 28469, is installed and mounted six times for a three-record fixture.
- Copy all and Download .txt fetch the authenticated records.txt endpoint and preserve its body exactly.
- Pending rows call the refresh endpoint every 20 seconds. Merely listing domains does not recheck DNS on this backend. Polling stops once active. Loading, failure and retry messages are present.
- Organization default feedback surfaces automatic adoption results, null adoption failures and skipped collisions. An inline remaining-content prompt fetches a dry run, then the house ConfirmDialog fetches fresh counts before the explicit apply call.
- The backend already automatically moves content during set-default. The UI explains this and confirms only the remaining content. This task does not change that contract.

## Commands and real output
Run from frontend on nvm Node v24.13.1:

| Command | Result |
| --- | --- |
| `npx tsc -b` | exit 0 |
| `npm run lint` | exit 0, 0 errors, 53 warnings. Clean base had 54 warnings. |
| `npx vitest run` | 16 files passed, 105 tests passed |
| `npm run build` | exit 0, 3443 modules transformed. Existing large-chunk warning remains. |
| `CB_QA_OUT=.../verify python3 qa/domains.py` | PASS, 7 behavior cases |
| `git diff --check` | clean |

Nine new tests cover exact three-record value/name copies, exact server IT text, clipboard failure and retry, failed IT request recovery, download behavior, 20-second polling and stop, fresh adoption counts and cancel/apply, failed dry-run recovery, and a saved default with automatic-adoption failure.

## Browser evidence
Evidence directory: `/Users/deep/.hermes/kanban/workspaces/t_2c713eda/verify`.

- Paper and Graphite at 375, 768 and 1440px. Six fold captures from stock shoot.py and six DNS-element captures.
- Pending SSL, failed validation and adoption dialog captures at 375 and 1440px.
- 18 PNGs total. All have been opened successfully except the bottom band of dns-failed-375.png. Repeated vision requests for that band timed out. The top band was read successfully, and the full error text and geometry were checked in the DOM. The Graphite 375 record screenshot was read successfully before removing the skip-link screenshot overlay; its final reread timed out.
- 12 standalone audit.py runs: zero FAILs. Its PROBE is also executed in the driven copied, refreshed and confirmation states.
- Six browser clipboard/download cases preserve exact values and exact server text. No page errors in these cases. Before/after geometry checks found zero overflowing main-content elements, zero undersized domain controls and zero rendered forbidden dashes. Computed DNS font family includes JetBrains Mono.
- The 768px interactions use reduced motion. The 375px live fixture went from Waiting on CNAME to Active after the real polling interval without reload.
- The only audit WARN is default-font. It incorrectly matches Arial in the Hanken Grotesk fallback list; computed body font is Hanken Grotesk. Repeated Copy controls produce an expected INFO.

## Critique and repairs
1. Phone copy buttons initially took width away from long DNS values. Moved them below the complete wrapped token, preserving the required no-horizontal-scroll behavior.
2. Inherited house status surfaces and hover states used Tailwind OKLCH colors that the audit parsed incorrectly. Scoped DNS status, error, ready, copy and adoption surfaces to the existing --cb-* tokens. Final audits are clean.
3. Element screenshots initially composited the sticky mobile header and skip link over their top edge. Component captures now temporarily hide those overlays only for the screenshot; fold captures retain the actual chrome.
4. Declined vision suggestions to add horizontal scrolling, remove the grey-cloud badge or force short names to wrap. Those conflict with the written brief. Claimed TXT overflow was disproved by bounding-box probes and exact clipboard assertions.

## Registry provenance
Source: https://21st.dev/@ncdai/components/copy-button, demo id 28469.
Authenticated registry fetch succeeded. Installed via shadcn CLI using a temporary registry payload with dependencies removed, preserving the house Button and installed Motion/Lucide packages. No package dependencies changed.

Adaptations in the tracked source: house Button import and size, visible Copied/Retry copy labels, product-owned cb-dns-copy styling, dropped audio and haptics, timeout cleanup, reduced-motion-aware transform/opacity icon swap and wait mode to avoid React ref warnings. Reapply these changes before any future registry overwrite.

Kokonut was checked alongside 21st. Its returned uptime/radial-menu components do not fit the specified control, so none were added. The required ncdai control is the actual mounted component, not an unused lookup.

## Limits and resume point
- No real Cloudflare, real DNS, production auth or production adoption requests were exercised. Browser data is explicitly labelled local fixtures.
- No physical-device testing, screen-reader session, Lagoon/Merlot screenshot suite or public deployment. Graphite is a neutral light theme in this product, not a dark-mode toggle.
- One final screenshot region still needs a successful visual read as described above. Default/copy/adoption behavior has unit and browser coverage; no claim is made that every pre-existing Settings control was tested.
- No PR exists yet. Publication preflight on PR #60 showed a completed Vercel preview and a Workers Builds: champbeam check triggered from feat/domain-records. No provider token was present in the task environment. Do not assume pushing this child branch is a local-only action.
- Resume after the owner either confirms preview deployment is allowed for this card, or safely disables automatic deployment for this branch. Then push, create a PR into feat/domain-records with the staged PR-BODY.md via --body-file, verify the exact remote head, and request reviewer review. Do not deploy, merge or touch DNS.

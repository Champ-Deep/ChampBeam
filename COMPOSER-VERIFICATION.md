# Composer implementation verification

Task: t_5a32899a. Implementation phase only. Release QA and draft PR belong to t_6dab273c.

Worktree: /Users/deep/.hermes/kanban/workspaces/t_ecd0915f/wt
Branch: feat/one-composer-ui
Backend base: 058ba6b26a027c7e762a455680b4a38efc6c0bfc
Design authority: setup task t_bd7bbc78 PRODUCT.md and DESIGN.md at ddec72e. The older root copies still require reconciliation by integration QA. Registry compatibility edits were explicitly approved by main on this task.

## Scope

Preserved the existing root implementation and sibling work. Finished the shared HomePage/Pages composer, input validation, explicit download/host confirmation, external URL handoff to Links, active host selection, compact slug editor, server collision feedback, clipboard confirmation and manual fallback. Slug suggestions receive the original filename, including Unicode and extension, without client-side transliteration. Invalid edited slugs and conflicts are rejected by the backend and leave the draft intact. Empty, loading, invalid-domain, permission-denied and upload-error states are present.

The backend MIME map determines which files can be hosted. Other files, including ZIP, remain downloadable. HTML hosting observes the existing 2 MB page cap; upload hints remain sourced from uploadLimits.ts. Host/domain choice never rewrites an existing share URL. No Worker code, authorization, schema, R2 content or production domain configuration was changed.

Scope reach: HomePage, ShareComposer, its shared Pages/Files callers, API request/response types, registry imports, TypeScript/Vite/Vitest aliases, dependency manifest/lock, unit tests and browser selectors. Other workers own lists, session isolation, account, reporting, navigation and the initial application stylesheet.

## Actual mounted sources

Installed through shadcn on nvm default Node v24.13.1 in the prior attempt, restored from its staging directory and mounted in this attempt:

| Registry address | Mounted export | Product use |
| --- | --- | --- |
| @21st/ephraimduncan/file-upload | FileDropzone | One drop/paste surface and file picker |
| @kokonutui/ai-prompt | default AIPrompt | Controlled multiline paste input, no AI/model/command controls |
| @kokonutui/smooth-tab | default SmoothTab | Recipient experience tabs, keyboard arrows and tap |

Registry numeric IDs were unavailable during setup because catalog search failed. The exact installed addresses above are the identifiers, not invented numeric IDs. The shadcn textarea is the existing React.forwardRef implementation. No API credential value was read or printed. components.json keeps only the environment placeholder.

ComposerControls is lazy loaded. Production build emits its own JS and CSS chunks. Mounted behavior was exercised on the real application home route with explicit local QA identity and API fixtures, not a component gallery. The production bundle was built separately.

### Overwrite-sensitive patches

Keep the one-line project header when reinstalling these files:

- frontend/src/components/ui/file-upload.tsx: configurable content, accept and id; remove hardcoded image-only accept and 4 MB claim; reset native input for same-file reselection; strict-compatible InputProps type.
- frontend/src/components/kokonutui/ai-prompt.tsx: controlled value/onChange, noModelControls and visible inputLabel; command-index guards; preserve newline/IME behavior in plain input mode; prevent duplicate attachment UI; image preview object-URL lifecycle without synchronous state in effect.
- frontend/src/components/kokonutui/smooth-tab.tsx: bounded indexed reads, synchronized latest props in layout effect, React 18-compatible inert attribute, immediate reduced-motion settling.

Product layout, colors, event routing and behavior live in ComposerControls.tsx, ShareComposer.tsx and composer.css. No parallel registry fork or hidden demo was mounted. The installed dropdown-menu imports the cn package; it is required and remains installed.

## Executed checks

| Check | Result |
| --- | --- |
| npm test | 10 files, 78 tests passed on final run; includes 16 composer tests |
| npm run build | Exit 0; tsc -b and Vite production build, 3428 transformed modules |
| Touched-file ESLint | Exit 0, no warnings or errors in composer/registry files |
| Full npm run lint | Exit 0; 54 warnings in existing or sibling-owned files, zero errors at that run |
| python3 qa/composer.py | Exit 0; 11 scenario groups, 16 audited states, 11 screenshots |
| Visual-verify PROBE | Zero FAILs, 27 WARNs, 6 INFOs across those states |
| Browser runtime | Zero pageerror events; one expected console resource error from deliberate HTTP 409 collision |
| Overflow | No composer viewport escapes; inactive translated tab panels excluded as intentional clipped content |
| git diff --check | Exit 0 |
| Dash scan | Zero literal em/en dashes in composer, wrapper, stylesheet, HomePage and patched registry sources |

Commands run from frontend. Logs are composer-full-tests.log, composer-build.log and composer-lint.log at worktree root. Browser data is .verify/composer/results.json. The existing qa/verify.py selectors were updated for tabs, the address editor and file removal; its full cross-feature run is left to integration QA to avoid clearing sibling fixture state.

Build sizes: ComposerControls JS 356.28 kB, gzip 121.73 kB. Main JS 1054.87 kB, gzip 303.80 kB. The existing main-chunk size warning remains. No bundle-size or dependency-security pass is claimed. npm reported 23 dependency advisories: 1 low, 6 moderate, 14 high and 2 critical. Their applicability was not investigated in this UI card.

### Browser coverage

Actual route: http://127.0.0.1:3198/
Server command: npx vite --config vite.qa.config.mjs
Port ownership checked with lsof. The on-page banner explicitly labels all identities and assets as local QA fixtures.

Verified: empty input and single picker; 375/768/1440 layouts; keyboard intent selection; explicit address disclosure; Unicode basename and extension returned by backend fixture; tap publication; 409 conflict retaining draft; clipboard byte equality and copied confirmation; correct Pages/Files/analytics destinations; external URL tracking handoff; unsupported-host explanation; reduced-motion download; delayed upload with disabled controls and named status; HTML/image/video/PDF creation paths using synthetic UI fixtures; missing selected domain with explicit unavailable option and recovery by choosing an active host; five shipped themes via computed audit; QR popover opens and closes.

Fixtures do not prove real QR encoding, media rendering, HTTP download disposition, real Clerk authorization, R2 integrity, live LakeB2B domain activation, or legacy /f and /p serving. Those checks remain with main's release QA. This card does not publish, send, deploy, merge, change DNS or claim recovered assets.

## Visual inspection

Screenshots in .verify/composer/:

- empty-375.png
- empty-768.png
- empty-1440.png
- host-375.png
- host-1440.png
- collision-375.png
- result-375.png
- external-375.png
- download-reduced-375.png
- loading-375.png
- invalid-domain-375.png

All states were opened through vision inspection. Confirmed and fixed: domain option suffix clipped at phone and desktop widths; mobile URL preview fragmented beside its edit button; missing domain visually falling back to a valid first option despite disabled submission. Reinspection shows full hostname, separate Workspace default text, readable URL wrapping and an explicit Unavailable domain option. Screenshots and DOM state agree.

Audit warnings are explained, not dismissed blindly:

- default-font: the checker flags Arial anywhere in the fallback chain. Computed html/body/composer/textarea font is Hanken Grotesk first, with Arial only as a fallback; h1 is Space Grotesk.
- flex-truncation: the intentional SmoothTab panel track contains an offscreen inactive panel. The parent clips it, inert removes it from keyboard access, and viewport rectangle checks on actual controls pass.
- three-card-row INFO: inherited recent-share columns are quiet lists, not nested cards; list composition is outside this composer patch.

No physical-device, screen-reader or complete theme screenshot matrix is claimed. Themes were checked by computed audit; final release QA owns broader visual coverage. The inherited root title/navigation says Share, while setup P2 leaves the naming decision open. Integration QA must reconcile that decision rather than treat this card as approval to rename Generator.

## Handoff

Commit only this lane's composer, registry, API and configuration files. Preserve sibling changes and the staged LinkGenerator extraction. The shared checkout is intentionally not clean and individual lane commits depend on the root/sibling integration work. No draft PR was opened here because the pre-created QA child owns the PR and full release checks.

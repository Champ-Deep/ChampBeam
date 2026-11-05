## What's in

- Installs 21st.dev Geo Traceroute 44579 through the registry, including all helper modules, in a separate source commit.
- Adds visitor-journey selection and maps to Link, File and Page analytics, plus five forwarded-first journeys on the overview.
- Maps all five ChampBeam palettes onto semantic canvas/shadcn tokens and repaints when data-cb-theme changes.
- Uses logarithmically compressed playback with real elapsed labels. Unlocated touches stay in the table and stationary journeys have no path.
- Preserves registry playback runtime. Type-only indexed-access adaptations support the repository's strict TS options.

## Verification

- npx tsc -b: pass.
- npm run lint: 0 errors, 54 warnings. Measured baseline: 0 errors, 54 warnings.
- npx vitest run: 15 files, 108 tests passed.
- npm run build: pass. Existing-style chunk-size warning remains.
- 21 browser cases: 375 / 768 / 1440, paper and graphite, one/two-city fixtures, reduced motion, retry recovery, keyboard/touch controls and all-five-theme repaints.
- Canvas pixel buffers checked: nonblank land everywhere, path pixels in two-city journeys, zero path pixels in one-city journeys.
- Three-week playback: 2800 ms.
- Registry runtime equivalence: 39 functions unchanged after TS erasure.
- All 20 screenshots opened. Report and machine evidence: docs/journeys-evidence/VERIFICATION.md.

## Test-only stabilization

The pre-existing first ShareComposer test failed its one-second lazy-import wait on an untouched API-head archive too. Increased only that first field wait and test budget. No assertions were removed and production composer code was not changed.

## Deferred / limits

- No auth/Clerk/backend changes, deployment or merge.
- Synthetic API adapter used for local visual verification. Live authenticated data was not exercised.
- Journeys use explicitly labelled rolling 90-day detail and 30-day overview windows. The endpoint does not support legacy project/custom-date filters.
- Location changes suggest forwarding, not proof of forwarding.
- Parent API PR 54 must land before this stacked UI work can enter main.
- Publication approved by the main lane for Deep on 2026-11-06. Automatic Vercel PR previews are permitted. Production deployment and merge remain prohibited.

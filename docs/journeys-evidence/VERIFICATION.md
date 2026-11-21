# ChampBeam visitor journeys: verification and publication approval

## Local result

Implementation is on `feat/visitor-journeys-ui`, based on API head `2782706`. The shared checkout and its uncommitted changes were not modified. No push, PR publication, merge or deployment has been performed.

Local preview: `http://127.0.0.1:3189/e2e/journeys.html?region=1`. This is a clearly synthetic verification entry that mounts the actual analytics page components with a test-only Axios adapter. It does not bypass application authentication. The fixture is not an entry in the production build, and no fixture files were found in `frontend/dist`.

## Changes

- Installed 21st.dev Geo Traceroute, component 44579 by lumesec, through the configured authenticated shadcn registry. Commit `2bda4e2` contains exactly the 12 installed source files and the CLI's stylesheet edit. No hand-written helper stubs or new dependencies.
- Added optional title, metric label, metric formatter, per-hop display and Probes visibility. The journey consumer displays item titles, device/type, city/country and real elapsed time instead of network timings.
- Added semantic shadcn and lumesec token aliases to all five existing `data-cb-theme` palettes. The canvas observer now watches `data-cb-theme`, so an appearance change repaints rather than retaining its old palette. Removed the installed violet CSS theme and unused `.dark` override. No `tw-animate-css` import or package was added.
- Added a typed journey API client, pure logarithmic hop mapping and shared house Card/Badge/EmptyState/LoadingSpinner section. Link, File and Page detail pages show Journeys. Pages use their backing file asset ID, as the API does. Analytics overview shows up to five visitors, forwarded first, and collapses the empty section.
- Kept touches without geo in the ledger. Consecutive stationary coordinates are drawn once, while every touch and its place remain in the table. A single-location journey therefore has no map path. Returning to a different previous location still draws a return leg.
- Labelled the endpoint's independent rolling windows: 90 days on detail, 30 days on overview. Legacy custom-date and project filters are not silently passed to an endpoint that does not support them.
- Reused existing product identity and house components. Existing Kokonut composer components were preserved, not replaced or newly installed.

## Executed gates

From `frontend/`, using nvm Node 24:

| Command | Actual result |
| --- | --- |
| `npx tsc -b` | Exit 0 |
| `npm run lint` | Exit 0. 54 warnings, 0 errors, matching the measured 54-warning baseline |
| `npx vitest run` | 15 files passed, 108 tests passed |
| `npm run build` | Exit 0. 3453 modules transformed, built in 11.48 s |
| `node e2e/verify-registry.mjs` | 39 runtime functions unchanged after TypeScript erasure |
| `python3 e2e/verify-journeys.py` | 21 browser cases passed |
| `git diff --check` | Exit 0 |

The registry assumes unchecked array indexing. Type-only assertions adapt its bounded geometry/index loops to this repository's stricter TS settings. No global TS or lint gates were relaxed. The runtime comparison proves the playback loop, scheduling, geometry and drawing functions are unchanged; only the explicitly named presentation forks are excluded.

The existing first ShareComposer test also timed out on an untouched archive of API head `2782706`: 92 passed, 1 failed. Its one-second lazy-import wait was too short under cold concurrent transforms. The first field's wait is now 10 seconds and that test's budget is 15 seconds. Its assertions and production composer code are unchanged. The final unqualified full-suite run passed all 108 tests.

Build warning retained: the main JS chunk is 1,188.13 kB, 355.12 kB gzip, above Vite's 500 kB warning threshold. No bundle restructuring was added.

## Browser evidence

All 20 PNG files in this directory were opened through vision tooling. One timed-out image request was retried successfully.

- Twelve settled region captures: `{paper,graphite}-{375,768,1440}-{one,two}.png`.
- Reduced-motion captures: `paper-375-reduced.png`, `graphite-375-reduced.png`.
- Existing dropdown captures: `paper-dropdown.png`, `graphite-dropdown.png`.
- Loading, empty and error captures at 375 px.
- Deliberate in-flight capture: `paper-768-midflight.png`.

`results.json` records the 21 cases, canvas pixel counts, API requests, audits and theme repaint evidence. `geometry-claims.json` records measured rebuttals to screenshot hypotheses. Four standalone `audit.py` reruns at 375 and 1440 in paper and graphite returned 0 FAILs. The identical probe also runs across all three matrix widths and control states.

Canvas proof, not merely DOM presence:

| Case | Land pixels | Path pixels |
| --- | --- | --- |
| 375 px, two cities | 8,636 | 60 |
| 375 px, one city | 15,330 | 0 |
| 768 / 1440 px, two cities | 42,164 | 128 |
| 768 / 1440 px, one city | 22,480 | 0 |

Both palettes produced these counts. Paper, graphite, lagoon, merlot and slate all resolve their semantic tokens and repaint the path when changed live. Reduced motion immediately produced three finished rows and a fully drawn route; the path's pixel buffer was identical across a subsequent 300 ms interval. A three-week journey completed playback in 2,800 ms.

Driven controls: visitor selection, real mobile taps on hop buttons, arrow-key navigation, Enter, Escape, Replay, Pause, Play, empty-section expansion, request retry and dropdown keyboard selection. Error recovery removed the old error notice. File and Page consumers requested `asset_type=file`; overview requested `/analytics/journeys/top` with limit 5. No page runtime errors or new-region geometric overflow were recorded. New registry/journey source scan: zero em or en dashes across 17 source files. Rendered journey text also had zero.

## Critique and fixes

1. The Forwarded badge initially measured 3.53:1. It now uses explicit cb ink on the cb chip ground and passes.
2. The stationary-path notice's translucent background failed the checker. It now has an opaque cb background and passes at both widths and palettes.
3. The section screenshot originally framed the heading too tightly. A 4 px inset gives the heading a clear upper boundary; the final mobile captures read completely.
4. Auditing the error before retry caught the house button's 40 px height. This consumer now sets a 44 px minimum; the error-state rerun passes and the new screenshot was reopened.

Rejected critique suggestions: inventing unknown geo, replacing the required Forwarded label, or changing `+0m` to the total duration would corrupt the requested data semantics. Unknown geo stays unknown and elapsed is measured from the first touch.

The mid-flight critique claimed collisions between the first marker and its label, and between Elapsed and Replay. DOM measurements disproved both: the label clears the actual marker dot by 17.484375 px and Elapsed clears Replay by 12 px. The stationary notice paints an opaque `rgb(250, 250, 249)` background at opacity 1 in graphite, so the reported map-through-text overlap is not present.

Audit caveats: the default-font WARN matches Arial in the existing Hanken Grotesk fallback list; this product's established font stack was preserved. The fixture omits global navigation, hence the skip-link INFO. The legacy Analytics project select has pre-existing label/iOS-size findings even when its ancestor is hidden. State probes scope the form-label scan to the new journey region rather than claiming that legacy control was fixed. Graphite is an alternate light workspace palette in this product, not a newly shipped inverted dark mode.

## Publication approved

The main lane for Deep explicitly approved PR publication with automatic Vercel previews on 2026-11-06. Production deployment and merge remain prohibited. No integration settings were changed. The original local verification above predates publication.

On resume, reran `npx tsc -b`, `npm run lint`, `npx vitest run`, `npm run build` and the registry runtime comparison. All passed: 54 existing lint warnings, 108 tests, 39 unchanged runtime functions. The build retains the same chunk-size warning. Repeated all 21 browser cases into the task workspace's `resume-evidence` directory: zero audit failures, no runtime errors or geometric overflow, nonblank canvas buffers, stable reduced-motion paths and all-five-theme repaints. Three-week playback measured 2713.3 ms.

PR body: `docs/visitor-journeys-pr.md`. Target base: `feat/visitor-journeys-api`. Exact published head and CI outcomes are recorded in the card review handoff.

## Review round 1 rework

The requested change reaches only the shared elapsed cell, the browser regression and the Link/File section comments. The elapsed override now preserves the pending placeholder before showing its real value. Network RTT rendering and the playback engine are unchanged. Both Device + Browser Breakdown comments again sit immediately above their grids.

Regression proof: added the pending-cell assertion before changing the component, then ran the complete browser script. It exited 1 with `AssertionError: Pending elapsed cells must be placeholders: ['+21d', '+21d']`. After the fix the same script exited 0 with `Completed 21 cases`. Logs are `rework-red.log` and `rework-green.log`.

Fresh gates: `npx tsc -b` exit 0; `npm run lint` exit 0 with 0 errors and the same 54 warnings; `npx vitest run` 15 files and 108 tests passed; `npm run build` exit 0, 3453 modules, 8.64 s, main chunk 1,188.23 kB with the retained size warning. `node e2e/verify-registry.mjs` still proves 39 runtime functions unchanged. `git diff --check` passes.

Repeated all 21 browser cases and opened all 20 refreshed PNGs. The twelve paper/graphite, 375/768/1440 one/two-city captures retain the previous canvas counts. Reduced-motion path buffers remain stable, all five palettes repaint, and the long journey completed in 2851.3 ms. A second paused mid-flight probe at all six width/palette pairs asserts nonempty pending cells containing only `-`, real values in active and finished cells, zero audit FAILs, zero runtime errors, zero geometric overflow and no table text outside its cell. Results: `rework-midflight-probes.json`.

Critique and disposition:

1. The elapsed column exposed future values during playback. Fixed in the presentation fork; the cropped `paper-768-midflight.png` read now confirms `+0m`, `-`, `-`.
2. Full-frame auxiliary vision claimed ghosted overlapping rows, low contrast and a truncated mobile filename. Narrow table crops read the complete names and values, and the six paused-state DOM probes show text contained within every visible cell at opacity 1. No unrelated layout or palette changes were made to satisfy those disproved claims.
3. Critique proposed changing elapsed granularity or duplicate day/hour labels. Declined: the brief specifies real elapsed labels and no extra timestamp precision was requested.

The audit's existing fallback-font WARN and fixture skip-link INFO retain the reasons above. The unavailable `champbeam` skill remains a tooling limit; the existing product DESIGN.md and task contract were used. No new registry install, dependency, API, backend, auth or Clerk change was needed for this rework. The existing PR #62 is updated, not replaced. Automatic previews remain allowed by the publication ruling; no production deployment or merge command was run.

## Not checked

No live authenticated session, production data, deployment, physical device or full-application accessibility certification. Backend, auth and Clerk code were untouched. Location changes suggest forwarding but do not prove that a deck changed hands. The page and API branch remain unmerged.

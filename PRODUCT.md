# ChampBeam

ChampBeam is an operational sharing workspace for Champions Group teams. Users publish viewable HTML, images, video and PDFs, share downloadable files, and track external links. IT manages organization access and domains. Reporting viewers inspect explicitly delegated scope without write access.

## Scope

One paste/drop composer asks for intent before publishing. Downloads belong in Files, hosted content in Pages, and tracked redirects and UTM work in Links. Domains are separate from intent. Account identity stays readable while its avatar loads or fails.

## Contract

Use docs/V3-RELEASE.md sections 4.1 to 4.6 and the existing Worker API. Permissions and reporting scope come from the server, never browser role-name inference. Organization changes discard cached private data and local form state. Shares created are not emails sent.

## Boundaries

No URL import endpoint, invented domain, fixture-as-production asset, recovered-page claim, backend authorization change, production deployment or DNS change. Production inventory belongs to the cutover gate. Existing shared addresses remain unchanged.

## Audience and mode

Operate mode on phone, tablet and desktop. The explicit task brief supplies product context for this headless implementation. No additional product assumptions are introduced.

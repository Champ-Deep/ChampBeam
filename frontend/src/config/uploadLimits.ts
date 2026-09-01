// Single source of truth for the file-upload UI (Files page + Generator quick
// share), mirroring the backend caps in `backend/app/api/v1/files.py`
// (_KIND_CAP_BYTES for authed users, _GUEST_KIND_CAP_BYTES for signed-out).
// Keep these in sync with the backend so the on-screen limits never lie about
// what the API will actually accept.

export const UPLOAD_CAPS_MB = {
  pdf: 50,
  html: 20,
  image: 10,
  video: 500,
  other: 50,
} as const;

export const GUEST_UPLOAD_CAPS_MB = {
  pdf: 10,
  html: 10,
  image: 5,
  video: 50,
  other: 10,
} as const;

// The backend classifies any unrecognized MIME as "other" (allowed, capped), so
// the picker must not restrict by extension — ZIPs, docs, etc. are all valid.
export const UPLOAD_ACCEPT = '*/*';

// Shown under the icon. Primary types called out, but anything is accepted.
export const UPLOAD_LABEL = 'Drop a PDF, video, HTML, image, ZIP, or doc here';

const c = UPLOAD_CAPS_MB;
// Full hint for the signed-in Files page.
export const UPLOAD_HINT =
  `PDF up to ${c.pdf} MB · HTML up to ${c.html} MB · image up to ${c.image} MB · ` +
  `video up to ${c.video} MB · other files up to ${c.other} MB`;

// Compact hints for the Generator quick-share (authed vs guest).
export const UPLOAD_HINT_COMPACT =
  `PDF/ZIP/docs ≤ ${c.pdf} MB · HTML ≤ ${c.html} MB · image ≤ ${c.image} MB · video ≤ ${c.video} MB`;

const g = GUEST_UPLOAD_CAPS_MB;
export const UPLOAD_HINT_GUEST =
  `Files ≤ ${g.pdf} MB · HTML ≤ ${g.html} MB · video ≤ ${g.video} MB · link expires in 24h`;

// Beam Pages (hosted single-file HTML). Mirrors `settings.pages_max_bytes`.
export const PAGE_CAP_MB = 2;
export const PAGE_ACCEPT = '.html,.htm,text/html';
export const PAGE_LABEL = 'Drop an .html file here';
export const PAGE_HINT =
  `Single HTML file up to ${PAGE_CAP_MB} MB · inline CSS/JS is fine · no server-side code`;

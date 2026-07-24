# Hosted Briefing Rooms & Recipient Intelligence

Implements the functional spec v1.0 (Spain outreach driving use case). Rooms are
standalone, personalized web pages assembled from assets, with per-recipient
identified visit tracking and a self-ranking engagement score.

## Decisions (locked)

- **Asset source = ChampVault** for the MVP. Rooms reference assets by ChampVault
  id (`asset_ids`). A dedicated ChampLens adapter can slot in later behind the
  same id-based interface (Open Question #1 — ChampLens API — is the spec's
  biggest schedule risk; this sidesteps it for Phase 1).
- **Public room URL = `/rooms/{slug}`** (with `?t={token}` for identified links).
  The spec's literal `/r/{room-slug}` collides with ChampBeam's existing
  `/r/{short_code}` redirect handler, so rooms get their own path.

## What ships in Slice 1 (this change — backend)

The spine of Modules B & C, fully unit-tested (ROOM-1..7):

- **Model** (`app/models/room.py`, migration `020_briefing_rooms`): `Room`,
  `RoomRecipient`, `RoomLink` (unique token), `RoomEvent`.
- **Service** (`app/services/room_service.py`): unique slugs, tokenized links,
  `{{token}}` personalization rendering, event ingest, engagement score.
- **API** (`app/api/v1/rooms.py`), org-scoped unless noted:
  - `POST /rooms`, `GET /rooms`, `GET /rooms/{id}`, `PATCH /rooms/{id}`
  - `POST /rooms/{id}/publish`, `POST /rooms/{id}/archive`
  - `POST /rooms/{id}/recipients` → returns the recipient's tokenized URL
  - `GET /rooms/{id}/analytics` → per-recipient scores (sorted) + anonymous signal
  - `GET /rooms/public/{slug}?t=` — **public** render data (personalized)
  - `POST /rooms/track` — **public** engagement beacon (identified or anonymous)

### Engagement score (spec C3, weights configurable)

Single 0–100 per recipient. Defaults: video ≥75% watched (30), deck ≥50% (20),
return visit (20), CTA click (20), total dwell >180s (10). Computed on read from
`room_events`.

### Identity & anonymity

A valid `token` (URL → first-party cookie, set by the render layer in Slice 2)
attributes every event to a named recipient. Events with no token are recorded
anonymously and surfaced as **forwarded/unknown viewer** — a signal (the deck
went up the chain), not noise.

### GDPR posture (partial — completed in Slice 3)

- Geo is stored **city-level only**; full IP is never persisted (the track beacon
  resolves country/city via `geoip_service` and discards the IP).
- Still to do in Slice 3: consent banner, linked privacy notice, per-recipient
  export/delete endpoints, DNT honoring, 30-day geo retention sweep. **Legal
  sign-off of the privacy notice is on the critical path for the 25 July send.**

## Remaining slices

- **Slice 2 — Hosted page.** Responsive SSR/edge-cached room at `/rooms/{slug}`
  (embedded deck viewer, streamed video, CTA/booking block), token→cookie
  attribution, tracking beacon wired to real scroll/video/dwell events.
- **Slice 3 — Campaign scale + compliance.** CSV bulk link generation
  (`POST /links/bulk` → CSV out), Slack/email alerts (first view, return, CTA,
  unknown-viewer spike), leadership daily digest, GDPR consent + privacy
  export/delete, retention sweep.
- **Slice 4 — ChampLens + hardening.** Dedicated ChampLens sync adapter (webhooks
  + version pinning), marketing template builder, room A/B variants.

## Open questions (from the spec — still need answers)

1. ChampLens API auth (service accounts vs to-be-built) — gates Slice 4.
2. Domain for rooms (`beam.champlens.com` vs neutral) — gates custom-domain + TLS.
3. Where engagement events land long-term (ChampBeam store only vs mirror to
   warehouse/CRM) — gates the `POST /webhooks` fan-out in Slice 3.
4. GDPR privacy-notice sign-off owner + turnaround before 23 July.
5. Whether ChampLens stores unbranded variants as separate assets.

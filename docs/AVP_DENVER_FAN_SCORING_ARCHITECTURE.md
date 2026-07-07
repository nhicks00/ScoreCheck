# AVP Denver Fan Scoring Architecture

ScoreCheck uses one public parent-friendly scoring link, one active scorer per court, backup scorers in parallel, server-authorized score mutations, read-only overlays, and admin override controls.

## Service Roles

- Vercel/Next.js: public portal, scorer sessions, admin, route handlers, overlay pages, stream source issuing.
- Supabase: events, courts, matches, score state, overlay state, scorer claims, scorer sessions, backup shadow state, flags, worker heartbeats.
- MediaMTX (self-hosted DigitalOcean droplet): low-latency WHEP + LL-HLS scorer/commentator preview per court (see `MEDIAMTX_DIGITALOCEAN_SETUP.md`).
- StreamRun: video routing to YouTube and the MediaMTX preview ingest, with ScoreCheck HTML overlay URLs on the YouTube branch.
- Worker (`npm run worker`): VolleyballLife polling and worker health.

## Primary Flow

Fan verification was removed in 2026-07: no chat codes, no human approval. Abuse controls are rate limiting plus admin revocation.

1. A parent opens `/score` or `/score/court/[court]`.
2. They choose Score only or Watch stream + score and enter a display name.
3. The server creates the claim, immediately assigns a scorer session, and returns the private session URL; the browser redirects straight into it.
4. The first scorer on a court becomes active; later scorers become backups.
5. Active scorer taps update official `score_states` and `overlay_states`.
6. Backup scorer taps update `scorer_shadow_states` only.
7. If the active scorer releases or goes stale, the best backup is promoted.

## Security Rules

- Browsers never write directly to official score tables.
- Raw session tokens are only returned to the claim owner and are stored hashed in Supabase.
- Stream playback URLs (which can carry MediaMTX read credentials) are issued only to active/backup scorer sessions or admins.
- Stream keys, MediaMTX publish/read credentials, Supabase service role keys, Vercel tokens, and StreamRun API keys are never committed.
- Overlay pages are read-only and poll/realtime subscribe to official overlay payloads.
- YouTube Stream Key 1-8 bindings are an operations concern: only the active/current event day or an intentional private dry run should be bound to Stream Key 1-8. Inactive scheduled event days stay parked on TEMP KEY.

## Key Tables

- `scorer_claims`
- `scorer_sessions`
- `scorer_shadow_states`
- `scorer_session_events`
- `court_flags`

These are added by `apps/web/supabase/migrations/003_fan_scoring_claims_sessions_video.sql`. Migration `011_instant_scoring.sql` makes the legacy verification-code columns nullable; `youtube_chat_messages` remains in the schema for historical rows but is no longer written.

## Operations

Admin command center: `/admin/avp-denver`.

Admins can monitor active scorers/backups, promote backups, revoke sessions, open/close scoring, copy public score and overlay URLs, edit stream/VBL metadata, and use existing admin score correction routes when needed.

## Required Validation

- Public `/score` works on desktop, tablet, and phone.
- `/score/court/[1-8]` takes a display name and lands directly in a scorer session; courts without a live match show an idle state.
- New claims create active/backup sessions instantly.
- Active scorer updates official score and overlay.
- Backup scorer writes only shadow score.
- Release and failover promote a backup.
- `/overlay/stream/[1-8]` remains transparent, read-only, and safe with missing data.
- `/api/video/stream-source` rejects non-scorers and returns graceful unavailable errors when MediaMTX is not configured.
- `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` pass before deploy.

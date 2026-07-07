# AVP Denver Fan Scoring Architecture

ScoreCheck uses one public parent-friendly scoring link, one active scorer per court, backup scorers in parallel, server-authorized score mutations, read-only overlays, and admin override controls.

## Service Roles

- Vercel/Next.js: public portal, scorer sessions, admin, route handlers, overlay pages, stream source issuing.
- Supabase: events, courts, matches, score state, overlay state, scorer claims, scorer sessions, backup shadow state, flags, worker heartbeats.
- MediaMTX (self-hosted DigitalOcean droplet): low-latency WHEP + LL-HLS scorer/commentator preview per court (see `MEDIAMTX_DIGITALOCEAN_SETUP.md`).
- StreamRun: video routing to YouTube and the MediaMTX preview ingest, with ScoreCheck HTML overlay URLs on the YouTube branch.
- YouTube worker: chat-code verification and worker health.

## Primary Flow

1. A parent opens `/score` or `/score/court/[court]`.
2. They choose Score only or Watch stream + score and enter a display name.
3. The server creates a short-lived claim with a code like `C4-728`.
4. The parent types that code in YouTube chat.
5. The worker marks the claim verified.
6. The claim page polls status and receives a private session URL.
7. The first verified scorer becomes active; later verified scorers become backups.
8. Active scorer taps update official `score_states` and `overlay_states`.
9. Backup scorer taps update `scorer_shadow_states` only.
10. If the active scorer releases or goes stale, the best backup is promoted.

## Security Rules

- Browsers never write directly to official score tables.
- Raw session tokens are only returned to the claim owner and are stored hashed in Supabase.
- Stream playback URLs (which can carry MediaMTX read credentials) are issued only to active/backup scorer sessions or admins.
- Stream keys, MediaMTX publish/read credentials, Supabase service role keys, Vercel tokens, StreamRun API keys, and YouTube refresh tokens are never committed.
- Overlay pages are read-only and poll/realtime subscribe to official overlay payloads.
- YouTube Stream Key 1-8 bindings are an operations concern: only the active/current event day or an intentional private dry run should be bound to Stream Key 1-8. Inactive scheduled event days stay parked on TEMP KEY.

## Key Tables

- `scorer_claims`
- `scorer_sessions`
- `scorer_shadow_states`
- `scorer_session_events`
- `youtube_chat_messages`
- `court_flags`

These are added by `apps/web/supabase/migrations/003_fan_scoring_claims_sessions_video.sql`.

## Operations

Admin command center: `/admin/avp-denver`.

Admins can monitor active scorers/backups, promote backups, revoke sessions, open/close scoring, copy public score and overlay URLs, edit stream/YouTube metadata, and use existing admin score correction routes when needed.

`npm run setup:youtube-denver` discovers Denver YouTube video and live-chat IDs from the local Beach Volleyball Media OAuth setup and the saved Denver event summary. It writes ignored metadata for `npm run seed:avp-denver`; it does not create broadcasts or change stream-key bindings.

## Required Validation

- Public `/score` works on desktop, tablet, and phone.
- `/score/court/[1-8]` creates claims and displays verification codes.
- Verified claims create active/backup sessions.
- Active scorer updates official score and overlay.
- Backup scorer writes only shadow score.
- Release and failover promote a backup.
- `/overlay/stream/[1-8]` remains transparent, read-only, and safe with missing data.
- `/api/video/stream-source` rejects non-scorers and returns graceful unavailable errors when MediaMTX is not configured.
- `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` pass before deploy.

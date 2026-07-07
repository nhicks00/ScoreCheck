# ScoreCheck Web

This is the Vercel-hosted ScoreCheck app for AVP Denver fan scoring, admin operations, scorer sessions, StreamRun overlays, and the worker process.

## Routes

- Public scorer portal: `/score`
- Court scoring pages: `/score/court/1` through `/score/court/8` (enter a display name and go straight to a scorer session)
- Private scorer sessions: `/score/session/[sessionToken]`
- Stable overlays: `/overlay/stream/1` through `/overlay/stream/8`
- Event overlay alias: `/overlay/avp-denver/court/[courtNumber]`
- Admin command center: `/admin/avp-denver`
- Existing event admin: `/admin/events`
- Admin stream preview: `/admin/stream-preview/1` through `/admin/stream-preview/8`

## Environment

Copy `.env.example` to `.env.local` for local development. Filled env files must not be committed.

Required server/runtime values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_SECRET`
- `NEXT_PUBLIC_SITE_URL`

MediaMTX preview video requires (see `../../docs/MEDIAMTX_DIGITALOCEAN_SETUP.md`):

- `MEDIAMTX_WHEP_BASE_URL` and/or `MEDIAMTX_HLS_BASE_URL`
- `MEDIAMTX_READ_USER` / `MEDIAMTX_READ_PASS` when the server enforces read auth
- optional `MEDIAMTX_RTMP_INGEST_BASE` for setup scripts and StreamRun paste sheets
- optional per-court paths via court `stream_path` in Supabase or `COURT_[1-8]_STREAM_PATH` env; every court defaults to `court{n}`

Players connect over WHEP (sub-second WebRTC) first and fall back to LL-HLS. Because the production site is https, the MediaMTX base URLs must be https in production or browsers will block them as mixed content.

## Setup

Run from `apps/web`:

```bash
npm install
npm run setup:preflight
supabase link --project-ref zxrkvklhdvvxwqzsdkyk
supabase db push
npm run seed:avp-denver
```

The seed script is idempotent. It creates or updates the `avp-denver` active event, eight courts, placeholder matches, fan-scoring settings, overlay states, and MediaMTX stream paths.

## Worker

Run the VolleyballLife poller for production:

```bash
npm run worker
```

## Service Automation

Local setup scripts write generated artifacts under `.local/`, which is gitignored.

```bash
npm run setup:streamrun:discover
npm run setup:streamrun
npm run setup:vercel-env
npm run verify:vercel-env
npm run verify:architecture
npm run verify:all
```

`setup:streamrun` maps the eight existing StreamRun workflows, YouTube destinations, overlay element IDs, and MediaMTX preview values. It writes redacted reports plus a manual RTMP destination paste sheet under `.local/`. Set `MEDIAMTX_RTMP_INGEST_BASE` (and optionally `MEDIAMTX_PUBLISH_USER`/`MEDIAMTX_PUBLISH_PASS`) locally first so the paste sheet has complete publish values.

`setup:vercel-env` writes two ignored env artifacts:

- `.local/vercel-env.generated.env` for Vercel app variables.
- `.local/worker-env.generated.env` for a Railway/Render-style worker running the VolleyballLife poller.

`verify:vercel-env` checks Vercel project settings and env variable names without printing values.

`verify:architecture` writes `.local/architecture-readiness.redacted.json` and aggregates Supabase, MediaMTX, StreamRun, Vercel, and generated-artifact readiness without printing secret values.

MediaMTX droplet provisioning, StreamRun RTMP destination values, encoder settings, and the verification checklist are recorded in `../../docs/MEDIAMTX_DIGITALOCEAN_SETUP.md`. The remote commentary workflow is in `../../docs/COMMENTARY_WORKFLOW.md`.

Browser QA coverage and cleanup expectations are recorded in `../../docs/SCORECHECK_QA_RUNBOOK.md`.

Do not commit `.local/`, `.env.local`, `.env.setup.local`, MediaMTX publish/read credentials, Supabase service role keys, StreamRun API keys, or Vercel tokens.

Security posture and RLS notes are documented in `SECURITY.md`.

## Verification

Before deployment:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Manual smoke routes:

- `/score`
- `/score/court/1`
- `/admin/avp-denver`
- `/overlay/stream/1`
- `/api/public/current-event`
- `/api/health`

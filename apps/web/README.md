# ScoreCheck Web

This is the Vercel-hosted ScoreCheck app for AVP Denver fan scoring, admin operations, scorer sessions, StreamRun overlays, and the worker process.

## Routes

- Public scorer portal: `/score`
- Court claim pages: `/score/court/1` through `/score/court/8`
- Private scorer sessions: `/score/session/[sessionToken]`
- Stable overlays: `/overlay/stream/1` through `/overlay/stream/8`
- Event overlay alias: `/overlay/avp-denver/court/[courtNumber]`
- Admin command center: `/admin/avp-denver`
- Existing event admin: `/admin/events`

## Environment

Copy `.env.example` to `.env.local` for local development. Filled env files must not be committed.

Required server/runtime values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_SECRET`
- `NEXT_PUBLIC_SITE_URL`

IVS preview video requires:

- `IVS_PLAYBACK_PRIVATE_KEY`
- court `ivs_channel_arn` and `ivs_playback_url` in Supabase, or `COURT_[1-8]_IVS_*` env fallbacks

YouTube verification worker requires:

- `YOUTUBE_API_KEY` or OAuth `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REFRESH_TOKEN`
- `YOUTUBE_WORKER_SHARED_SECRET` if using the callback route from an external worker

## Setup

Run from `apps/web`:

```bash
npm install
npm run setup:preflight
supabase link --project-ref zxrkvklhdvvxwqzsdkyk
supabase db push
npm run setup:youtube-denver
npm run seed:avp-denver
```

The YouTube setup step reads the local Beach Volleyball Media OAuth files and Denver summary JSON, then writes ignored court video/chat metadata under `.local/`. It does not modify YouTube stream bindings. If the Denver summary has no active day because real event streams are parked while dry-run streams use Stream Key 1-8, the script selects the earliest upcoming real Denver day.

The seed script is idempotent. It creates or updates the `avp-denver` active event, eight courts, placeholder matches, fan-scoring settings, overlay states, IVS metadata, and generated YouTube video/chat metadata when available.

## Workers

Use the combined worker for production:

```bash
npm run worker:all
```

This runs the existing VolleyballLife poller and the YouTube verification worker. The YouTube-only worker is also available:

```bash
npm run worker:youtube
```

## Service Automation

Local setup scripts write generated artifacts under `.local/`, which is gitignored.

```bash
npm run setup:aws-ivs
npm run setup:youtube-denver
npm run setup:streamrun:discover
npm run setup:streamrun
npm run setup:vercel-env
npm run verify:vercel-env
npm run verify:architecture
npm run verify:all
```

`setup:streamrun` maps the eight existing StreamRun workflows, YouTube destinations, overlay element IDs, and IVS values. It writes redacted reports plus a manual IVS destination paste sheet under `.local/`.

`setup:vercel-env` writes two ignored env artifacts:

- `.local/vercel-env.generated.env` for Vercel app variables. It intentionally excludes YouTube OAuth/API secrets.
- `.local/worker-env.generated.env` for a Railway/Render-style worker. This is where YouTube OAuth/API secrets belong.

`verify:vercel-env` checks Vercel project settings and env variable names without printing values. It fails if worker-only YouTube OAuth/API keys are present in the Vercel app environment.

`cleanup:vercel-worker-env` dry-runs removal of worker-only YouTube keys from Vercel app env. Destructive mode requires both `--apply` and `CONFIRM_VERCEL_WORKER_ENV_CLEANUP=remove-worker-youtube-keys`; do not run destructive mode without explicit approval.

`verify:architecture` writes `.local/architecture-readiness.redacted.json` and aggregates Supabase, AWS IVS, StreamRun, Vercel, and generated-artifact readiness without printing secret values.

StreamRun/IVS preview setup and test-feed pitfalls are recorded in `../../docs/STREAMRUN_IVS_PREVIEW_RUNBOOK.md`. Read it before changing IVS destinations or sending local SRT test video.

Browser QA coverage and cleanup expectations are recorded in `../../docs/SCORECHECK_QA_RUNBOOK.md`.

Do not commit `.local/`, `.env.local`, `.env.setup.local`, IVS stream keys, playback private keys, Supabase service role keys, StreamRun API keys, Vercel tokens, or YouTube refresh tokens.

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

# MultiCourtScore Cloud

This is the Vercel-hosted cloud admin, scorer, worker, and overlay app for MultiCourtScore.

## Vercel Setup

1. Push the `codex/vercel-cloud-platform` branch to GitHub.
2. Create a Vercel project connected to this repository.
3. Set the Vercel Root Directory to `apps/web`.
4. Add the environment variables from `.env.example`.
5. Create a Supabase project and run both migrations in order:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_remote_manual_scoring_and_worker.sql`
6. Deploy the branch preview, then promote it once discovery, manual scoring, worker heartbeat, and overlay URLs work.

## Required Environment Variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_SECRET`
- `NEXT_PUBLIC_SITE_URL`

## MVP Workflow

1. Open `/admin/events`.
2. Create an event. Eight courts are created automatically.
3. Add one or more VolleyballLife bracket/pool URLs.
4. Run discovery.
5. Assign discovered matches to court queues.
6. Create manual sessions when a court needs remote human scoring.
7. Copy scorer URLs only when generated or rotated.
8. Use `/overlay/stream/1` through `/overlay/stream/8` as the permanent Streamrun HTML overlay URLs.

The static stream URLs always resolve to the active event, so streaming software does not need new overlay URLs for each tournament. Creating a new event makes it active automatically. Older events can be reactivated from `/admin/events`. Event-specific overlay URLs such as `/overlay/court/1?eventId=<event-id>` still work for isolated testing.

## Worker

Vercel does not provide a true always-on worker for 1-3 second polling over an entire tournament day. Production polling should run on Render as a Background Worker:

- Root Directory: `apps/web`
- Build Command: `npm install`
- Start Command: `npm run worker`
- Environment variables: same Supabase values as Vercel; `ADMIN_SECRET` is optional for the worker.

The admin dashboard still has a local/dev poller button for testing, but production live events should use the Render worker.

## Manual Scoring

Manual scorer URLs use long random tokens. Only token hashes are stored in Supabase. The raw URL is shown only after creating a session or rotating a scorer token. Rotate the token if a scorer URL is lost or shared with the wrong person.

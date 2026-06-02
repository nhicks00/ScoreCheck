# Vercel Deployment Notes

The cloud app lives in `apps/web` so the existing Swift/macOS project can remain intact.

Recommended Vercel project settings:

- Git branch: `codex/vercel-cloud-platform`
- Root Directory: `apps/web`
- Framework Preset: Next.js
- Build Command: `npm run build`
- Install Command: `npm install`

Apply the Supabase migration at `apps/web/supabase/migrations/001_initial_schema.sql` before using admin or overlay routes.

Then apply `apps/web/supabase/migrations/002_remote_manual_scoring_and_worker.sql`. The second migration enables manual scorer tokens, court queues, worker heartbeats, poller errors, and overlay realtime broadcast support.

Render Background Worker settings:

- Connect the same GitHub repo and branch.
- Root Directory: `apps/web`
- Build Command: `npm install`
- Start Command: `npm run worker`
- Environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

Keep Vercel for pages/API routes and Render for always-on 1-3 second VolleyballLife polling.

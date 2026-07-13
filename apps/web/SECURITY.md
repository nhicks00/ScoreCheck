# ScoreCheck Security Notes

This app uses a server-authorized MVP security model for AVP Denver fan scoring.

## Current Posture

- Browser clients do not receive `SUPABASE_SERVICE_ROLE_KEY`.
- Official scoring writes go through Next.js route handlers under `/api/scoring`, `/api/score`, or `/api/courts`.
- Scorer entry is name-only: fans enter a display name and receive a scorer session immediately, with no human verification step (removed 2026-07). Abuse controls are per-IP/per-court rate limiting on claim starts, per-session rate limiting on scoring actions, and admin session revocation from the command center.
- Scorer session tokens are stored hashed in Supabase and raw session URLs are only returned to the claimant.
- IVS playback URLs are signed server-side and are issued only to active or backup scorer sessions.
- Overlay routes are read-only. They read score/overlay state and do not expose mutation controls.

## RLS Status

Full Row Level Security policies for parent scorer claims/sessions are not the current enforcement layer. The enforcement layer is the Next.js server route plus Supabase service-role writes.

That means client code must not be changed to write directly to these tables:

- `score_states`
- `score_source_heartbeats`
- `overlay_states`
- `score_actions`
- `scorer_claims`
- `scorer_sessions`
- `scorer_shadow_states`
- `scorer_session_events`
- `court_flags`

If future work adds browser-side Supabase writes, add RLS policies before exposing those writes.

## Secret Routing

Do not commit or expose:

- Supabase service role keys
- StreamRun API keys
- Vercel tokens
- AWS credentials
- IVS stream keys
- IVS playback private keys

`npm run setup:vercel-env` writes two ignored files:

- `.local/vercel-env.generated.env` for Vercel app runtime values.
- `.local/worker-env.generated.env` for the VolleyballLife poller worker.

`npm run verify:vercel-env` checks actual Vercel env names without printing values.

## Known External Cleanup

The app no longer reads any `YOUTUBE_*` variables (chat verification was removed 2026-07). Any `YOUTUBE_*` values remaining in the Vercel or worker environments are unused and can be deleted manually. Removing production/preview Vercel env variables is a destructive external change, so it requires explicit human approval.

# ScoreCheck Security Notes

This app uses a server-authorized MVP security model for AVP Denver fan scoring.

## Current Posture

- Browser clients do not receive `SUPABASE_SERVICE_ROLE_KEY`.
- Official scoring writes go through Next.js route handlers under `/api/scoring`, `/api/score`, or `/api/courts`.
- Scorer session tokens are stored hashed in Supabase and raw session URLs are only returned to the verified claimant.
- YouTube claim verification stores hashed claim codes and short-lived claim status tokens.
- IVS playback URLs are signed server-side and are issued only to active or backup scorer sessions.
- Overlay routes are read-only. They read score/overlay state and do not expose mutation controls.
- Worker callbacks require `YOUTUBE_WORKER_SHARED_SECRET` when using `/api/worker/youtube/verification-message`.

## RLS Status

Full Row Level Security policies for parent scorer claims/sessions are not the current enforcement layer. The enforcement layer is the Next.js server route plus Supabase service-role writes.

That means client code must not be changed to write directly to these tables:

- `score_states`
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
- YouTube OAuth client secrets or refresh tokens

`npm run setup:vercel-env` writes two ignored files:

- `.local/vercel-env.generated.env` for Vercel app runtime values.
- `.local/worker-env.generated.env` for worker-only YouTube OAuth/API values.

`npm run verify:vercel-env` checks actual Vercel env names without printing values and fails if worker-only YouTube OAuth/API keys are present in the Vercel app environment.

## Known External Cleanup

As of the latest audit, the Vercel app environment still contains worker-only YouTube OAuth/API variables. Removing production/preview Vercel env variables is a destructive external change, so it requires explicit human approval before cleanup.

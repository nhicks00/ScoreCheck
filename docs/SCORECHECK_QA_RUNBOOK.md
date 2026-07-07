# ScoreCheck QA Runbook

This runbook records the browser and service validation standard for the ScoreCheck AVP Denver build.

## Local App Setup

Run from `apps/web`:

```bash
npm run dev -- --port 3102
```

Use `http://localhost:3102` for browser QA. If a clean production build is needed, stop the dev server first, remove `.next`, run `npm run build`, then restart the dev server. Running `next dev` and `next build` against the same `.next` directory can create misleading build failures.

Refresh health before the final check by briefly running the YouTube worker:

```bash
WORKER_ID=codex-youtube-smoke npm run worker:youtube
```

Stop it after it writes a heartbeat. `/api/health` should then report `status: ok`.

## Browser Layout Standard

For each audited route, verify at minimum:

- Phone viewport: `390 x 844`.
- Tablet viewport: `820 x 1180` where the route is public or scorer-facing.
- Desktop viewport: `1280 x 720`.
- No horizontally offscreen visible elements.
- No visible text clipping or scroll overflow outside intentionally scrollable tables/inputs.
- No interactive target below `44px` in width or height.
- Page has one meaningful primary heading when it is a full app page.
- Buttons and links expose their intended names through the accessibility tree.
- Error states are user-readable and do not expose secrets.

Long URL, ARN, and key-like values inside admin metadata inputs may have internal text scroll width; that is acceptable as long as the input itself is visible, padded, and reachable.

## Public Routes

Audit these routes:

- `/`
- `/score`
- `/score/court/1`
- `/score/court/5`
- `/score/court/5?admin=1` after admin login
- `/score/session/[sessionToken]` using a temporary admin test session
- `/overlay/court/1`
- `/overlay/stream/1`
- `/admin/stream-preview/1`

Expected public flow behavior:

- Landing page explains the scorekeeper workflow and has a single clear `Help score a court` call to action.
- `/score` shows eight court cards, court names are the primary card headings, stream key labels are small `Key N` badges, and team rows align consistently around the score and `vs` divider.
- Claim page has two scoring modes: `Score only` and `Watch stream + score`.
- Admin test mode shows `Start admin scoring test`; normal public mode does not.
- Stream preview unavailable state says the stream is offline or not configured and provides Play/Reload controls instead of presenting a blank success state.

## Scorer Session Checks

Create a temporary admin test scoring session on Center Court or another inactive court, then verify:

- `+ Point` for each team increments the live tile and synced editor fields.
- `- Point` decrements the selected team and disables at zero.
- Manual score editing applies a direct score and returns to `Live score synced`.
- Completing a set through manual edit shows `Set Complete` and exposes `Start set 2`.
- Starting set 2 locks set 1 behind a `Modify` button, resets current-set tiles to `0-0`, and leaves only set 2 editable.
- `Stop scoring` ends the session and the court returns to `Needs scorer`.
- Reset any test score back to set 1, `0-0`, before release.

## Admin Routes

Audit these routes after admin login:

- `/admin/avp-denver`
- `/admin/events`
- `/admin/events/[eventId]`
- `/admin/events/[eventId]/fan-scoring`
- `/admin/events/[eventId]/courts`
- `/admin/stream-preview/1`

Expected admin behavior:

- Dashboard has no stale test scorer sessions after QA cleanup.
- Metadata `summary` controls meet the 44px tap target floor.
- `Score URL` and `Overlay URL` copy buttons show a status message. If localhost/browser clipboard access is blocked, the status message must show the exact URL.
- `Close scoring` and `Open scoring` toggles work and are restored to the original state after testing.
- Event list and court grid pages expose proper page-level headings.

## Service Checks

Run these from `apps/web` before deployment:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run verify:all
npm run verify:architecture
npm run cleanup:vercel-worker-env
```

`verify:architecture` is allowed to fail only for documented external blockers. Since the MediaMTX migration, the MediaMTX section is expected to report blocked until the DigitalOcean droplet exists and the `MEDIAMTX_*` env vars are set (see `docs/MEDIAMTX_DIGITALOCEAN_SETUP.md`). Vercel worker-only YouTube variables were removed from the app environment in the July 2, 2026 audit, and StreamRun courts 1-8 all have separate saved YouTube and preview output branches with production overlay URLs.

`cleanup:vercel-worker-env` is dry-run by default. Destructive cleanup requires explicit human approval plus:

```bash
CONFIRM_VERCEL_WORKER_ENV_CLEANUP=remove-worker-youtube-keys npm run cleanup:vercel-worker-env -- --apply
```

Do not run destructive mode without explicit approval.

## State Cleanup After QA

After browser tests:

- Revoke or release temporary scorer sessions.
- Return test courts to set 1, `0-0`, unless preserving a score is intentional.
- Restore scoring-open state if it was toggled.
- Do not leave local SRT/video test processes running.
- Do not leave the YouTube smoke worker running unless it is intentionally being monitored.

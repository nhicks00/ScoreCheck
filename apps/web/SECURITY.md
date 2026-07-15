# ScoreCheck security boundary

ScoreCheck uses a server-authorized security model. Browser clients receive a
Supabase anonymous key only for Realtime invalidation channels; those messages
are untrusted hints, never score data. Browsers do not read or mutate
application tables through PostgREST.

## Database access

Migration `026_security_boundary_hardcut.sql` is the mandatory boundary for all
service-owned event, scoring, session, community, worker, and monitoring state:

- Row Level Security is enabled and forced.
- `PUBLIC`, `anon`, and `authenticated` receive no table privileges.
- Existing table policies are removed, so RLS access fails closed.
- `service_role` retains table access and bypasses RLS for server routes,
  workers, and transactional database functions.
- Public-schema functions are executable only by `service_role`; this closes
  the otherwise implicit `PUBLIC` access to `SECURITY DEFINER` functions.
- Default table, sequence, and function privileges are also closed for browser
  roles.

New service-owned tables must be added to the migration's protected table list
or receive equivalent RLS, revoke, and service-role grants in their own
migration. A browser-facing policy is an architecture change and requires a
specific security review; do not add one merely to bypass a server route.

## Public HTTP responses

Public event and court routes query named columns and pass results through
property-by-property DTO helpers in `src/lib/publicDtos.ts`. Never return a
Supabase row, use object spread on a row, or use `select("*")` in a public
route. A new database column must remain private until explicitly added to a
public DTO and its security contract test.

The public court DTO intentionally permits only presentation data such as event
and court identity, team names, the score projection, scoring availability, the
active scorer's volunteered display name, and a public YouTube video id. It
must never expose:

- scorer, claim, or admin tokens and token hashes;
- IP or device hashes and user-agent strings;
- stream ingestion keys, IVS ARNs, signed playback URLs, or internal media
  paths;
- provider URLs and source payloads;
- internal flags, event payloads, action payloads, or audit records.

Public handlers log detailed failures on the server and return generic errors
to callers. Do not serialize database error messages.

## Realtime

Raw Postgres row replication is disabled for every `public` table in the
`supabase_realtime` publication. Browser delivery may use explicit
`realtime.send(...)` broadcasts only as invalidation hints. The overlay erases
the entire broadcast body, coalesces bursts, and applies state only after a
successful fetch from its sanitized HTTP projection. Its bounded poll remains
the repair path; the chat monitor uses HTTP polling when raw row replication is
unavailable.

Do not add service-owned tables back to the publication. Add a named
invalidation broadcast with no authoritative state and a contract test proving
that forged payload fields are never rendered.

## Community media playback

The community session may return the court's public YouTube video id. The
client builds a privacy-enhanced YouTube embed and uses
`strict-origin-when-cross-origin` so the provider receives the required origin
identity. Score controls occupy a sibling dock or column; they never cover or
replace any part of the embedded player.

The community boundary must not return MediaMTX usernames or passwords, WHEP
or HLS paths, internal media hostnames, ingest credentials, reusable signed
preview URLs, or admin stream-source responses. Commentary and admin preview
surfaces retain their separately authorized media paths. If community playback
later moves to owned low-latency media, require per-assignment, path-scoped,
short-lived authorization and a media-plane load test before exposing it.

Public video can be delayed and does not establish courtside authority. A
remote playback tap cannot become authoritative until there is an explicit
playback-timestamp-to-canonical-event contract.

## Server mutation boundary

All score, claim, observation, resolution, promotion, undo, match-transition,
and provider mutations go through authenticated server routes and the
transactional command functions they call. Possession of the Supabase anonymous
key is never authorization to read or write application state.

The server-only `SUPABASE_SERVICE_ROLE_KEY` must never be imported by client
components, returned by a route, embedded in a log, or copied into a generated
artifact.

## Credential handling

Do not commit or expose:

- Supabase service-role keys;
- scorer/admin bearer credentials;
- StreamRun API keys;
- Vercel tokens;
- AWS credentials;
- IVS or YouTube ingestion keys;
- playback-signing private keys.

`npm run setup:vercel-env` writes ignored local environment files, and
`npm run verify:vercel-env` checks names without printing values. External
credential deletion or rotation remains an explicit operator action.

## Required security checks

Before deployment, verify against a disposable or canary project that:

1. `anon` and `authenticated` receive permission errors for select, insert,
   update, and delete on every protected table.
2. `service_role` can perform required server and worker operations.
3. public route snapshots contain only their documented DTO fields.
4. no protected table appears in `pg_publication_tables` for
   `supabase_realtime`.
5. browser score, overlay, and chat flows still operate through their server or
   sanitized broadcast paths.

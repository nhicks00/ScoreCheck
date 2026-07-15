# Event Infrastructure Lifecycle Canary

Date: 2026-07-15

Classification: **PASS for provider lifecycle mechanics; eight-court production
capacity remains unqualified.**

## Bound release

- Git ref: `codex/turnkey-event-lifecycle`
- Git SHA: `9998992c63f0e4a169d685036aad76356d5dfe47`
- Canary run: `20260715t1957`
- Evidence schema: `3`
- Evidence digest:
  `23b3173e43ace91c56b084cf269865bfdc09e5b8248123afac6831cdf855bf1d`
- Started from the protected seven-Droplet baseline with no Reserved IPv4s or
  lifecycle-canary snapshots.

The signed attestation and complete provider evidence remain in protected
operator storage. Provider account identifiers, addresses, credentials, and
SSH material are intentionally not copied into this repository.

## Passed gates

1. Live size inventory proved a reversible, disk-preserving resize contract:
   `c-4` (4 vCPU, 8 GiB, 50 GiB) to `s-1vcpu-2gb` (1 vCPU, 2 GiB,
   50 GiB).
2. One isolated `c-4` Droplet was created with a unique run tag and endpoint.
3. A temporary Reserved IPv4 was assigned and the exact Vercel DNS record
   converged on the authoritative nameservers, system resolver, Cloudflare,
   and Google without a stale answer.
4. Endpoint identity passed before resize, after resize down, and after resize
   back to `c-4`.
5. Snapshot create and read passed with the dedicated lifecycle token's
   `snapshot:read` and `snapshot:delete` scopes.
6. The original exact Droplet was destroyed and a different Droplet was
   reconstructed from the snapshot.
7. The same Reserved IPv4 and hostname identified the replacement instance.
8. The replacement, DNS record, Reserved IPv4, snapshot, and tag were deleted.
9. Independent post-run inventory proved all seven baseline Droplets remained
   and no run-owned provider artifact remained.

The full run completed at `2026-07-15T20:10:02.896Z`. DigitalOcean's
post-unassign Reserved IPv4 release returned its transient HTTP 422 state for
about five minutes. The bounded retry path waited for exact HTTP 404 absence
and completed without manual cleanup. This delay is provider behavior worth
budgeting into teardown; it was not hidden or treated as immediate deletion.

## Remaining gate

This one-Droplet canary proves provider permissions, DNS and stable-address
behavior, reversible resizing, reconstruction, and exact cleanup. It does not
qualify the media system.

The isolated full rehearsal requires 12 temporary Droplets alongside the seven
existing test/monitoring Droplets. A limit increase from 10 to 19 was submitted
after this PASS and remained pending at the final audit. The protected rehearsal
bundle binds 12 resources, eight independent camera compositors, one warm spare,
four event-scoped DNS names, eight synthetic camera publishers, eight program
outputs, a 30-minute soak, and exact teardown to the tested SHA above.

Do not call the system production-ready until that full rehearsal passes and
independent post-run inventory again proves the seven baseline Droplet IDs are
unchanged with zero rehearsal artifacts.

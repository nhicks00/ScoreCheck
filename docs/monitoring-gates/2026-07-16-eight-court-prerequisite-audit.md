# Eight-Court Prerequisite Audit

Date: 2026-07-16

Classification: **PASS for the non-destructive DigitalOcean quota, network,
local-tooling, bundle, and lifecycle-plan prerequisites. The destructive
zero-to-12-to-zero rehearsal and the eight-court production endurance gate are
not yet executed and must not be represented as passed.**

## Verified in this audit

### DigitalOcean capacity

The protected live pool preflight at `2026-07-16T17:19:14.870Z` passed:

- account status was active;
- 7 Droplets existed under an account limit of 15;
- 8 slots were free;
- 4 compatible `c-4` compositors existed;
- compositors E-H plus one warm spare were the 5 missing slots;
- creating those 5 beside the current hosts would temporarily total 12, not 19;
- no conflicting or extra tagged compositor existed; and
- `c-4` remained available in `sfo2` at 4 vCPU, 8192 MiB, and the provider's
  observed `$0.125/hour` rate.

This closes the quota prerequisite without creating a server. The recurring
event shape remains exactly 12 Droplets and the normal idle shape remains zero
event Droplets.

Protected evidence:

```text
~/.config/scorecheck/preflight/eight-court-20260716T171913Z/compositor-pool-preflight.json
```

### Hardened network contract

The prior rehearsal artifacts are retained as immutable historical evidence,
but they are not reusable because their embedded SSH rule predates the current
host-CIDR hardening. A fresh contract was rendered from the approved operator
host CIDR without printing it. It has:

- one `/32` or `/128` admin-address SSH rule on each firewall;
- the observability-bastion SSH rule on service firewalls only;
- no `0.0.0.0/0` or `::/0` SSH source;
- the pinned `sfo2` VPC and private CIDR; and
- the four exact production firewall names.

A read-only provider comparison at `2026-07-16T17:24Z` returned `healthy: true`
with no drift or problem. No firewall, VPC, Droplet, DNS, or route was changed.

Protected evidence:

```text
~/.config/scorecheck/event-stack/network-contracts/rehearsal-20260716T172422Z/
```

### Local rehearsal tooling

The previously linked macOS FFmpeg build could not run the rehearsal because it
lacked SRT and `drawtext`. The keg-only Homebrew `ffmpeg-full` build was
installed without replacing the system-linked FFmpeg. The rehearsal now pins:

```text
/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg  8.1.2
/opt/homebrew/bin/lk                      2.16.7
```

The rehearsal's own publisher preflight passed RTMP, SRT, H.264, AAC, Opus,
draw-text, generated video, and generated audio requirements. Its commentary
preflight also passed. This installation affects only the operator Mac and no
live runtime.

### Fresh immutable rehearsal bundle

The fresh protected bundle is:

```text
~/.config/scorecheck/event-stack/events/turnkey-zero-to-12-rehearsal-20260716-r3/
```

It is mode `0700`; its files are mode `0600`; and `SHA256SUMS` covers the
manifest, profiles, local tooling preflight, lifecycle state, and plan/status
results. It is bound to tested repository SHA
`220eb2aaad072fe8560730277b96acf9adbffa9c` and declares exactly:

| Role | Count | Size |
| --- | ---: | --- |
| Commentary | 1 | `s-2vcpu-2gb` |
| Observability | 1 | `s-2vcpu-4gb` |
| Ingest | 1 | `c-4` |
| Court compositors | 8 | `c-4` |
| Warm spare compositor | 1 | `c-4` |
| **Total** | **12** | |

`eventctl plan` initialized only protected local state. The subsequent
read-only `status` call reported phase `planned`, zero Droplets, zero endpoints,
zero healthy deployments, and a healthy network contract. The full dry-run
operator command was generated but not invoked.

### Software validation

The current release passed:

- 146 event-lifecycle tests;
- all 5 offline lifecycle simulations;
- 56 capacity, camera-profile, host-sampler, zombie, pool, and eight-court
  evaluator tests;
- compositor admission configuration validation; and
- compositor start-court validation.

These prove deterministic behavior. They do not replace the live destructive
rehearsal or physical eight-court endurance evidence.

## Remaining hard gates

1. **Destructive lifecycle rehearsal.** The exact recurring sequence is retire
   the 7 legacy/test Droplets, prove zero event Droplets, create the exact 12,
   run the 30-minute synthetic full-stack rehearsal, collect evidence, and
   return to zero. This requires an exact operator approval immediately before
   execution because the first phase destroys the current Droplets. The old
   Droplets are not a rollback tier; protected recovery material, Git, retained
   Reserved IPv4 anchors, and provider/DNS state are the rollback contract.
2. **Eight physical source profiles.** Capture a fresh schema-2, digest-bound,
   at-least-10-minute qualification proving each final camera source uses the
   manifest's protocol/mode and sustained H.264 Main 1280x720 at 29-31 fps plus
   AAC 48 kHz stereo. If real camera output differs, update and qualify the
   manifest rather than overriding evaluator input.
3. **Venue upload.** Capture at least three timestamped measurements spanning
   at least five minutes with bonded p05 upload of at least 75 Mbps, packet loss
   at or below 1%, the intended Speedify exit, and fail-closed route evidence.
4. **Ingest shape and normalization.** The candidate endurance JSON still says
   the ingest host has 8 vCPU while the event manifest provisions `c-4` with 4
   vCPU. It cannot be used as-is. The prior single-`c-4` eight-feed normalization
   attempt saturated near four cores and failed realtime. Either prove final
   camera-side 720p30 H.264 stream-copy on `c-4` or qualify a separate
   normalization tier before the endurance run.
5. **Eight isolated YouTube destinations.** The infrastructure rehearsal now
   uses the exact retained reusable 720p30 test ingest pool, one stream per
   camera, with no public production destination or StreamRun dependency. Fresh
   unlisted broadcasts and watch pages are created and independently verified
   once per tournament as a separate control-plane preflight; they are not
   churned by repeated infrastructure rehearsals.
6. **Commentary and score load.** Run at least two active commentary rooms with
   fresh human clap/sync attestations, while all eight score/render paths remain
   aligned and healthy.
7. **Two-hour endurance.** After 120 seconds of warmup, collect at least 7,200
   seconds of post-warmup evidence with at least 99% valid sample coverage from
   ingest, nine compositor watchers, all eight raw/preview/program paths, eight
   Egress jobs, eight Program browsers, and eight unlisted YouTube outputs.
8. **Remaining one-court real faults.** Repeat Camera 4 freeze and black timing
   in an explicit phone-visible Pushover window, then complete the unproven
   commentary, score, Egress, YouTube, agent, and venue/uplink rows. These are
   separate from infrastructure lifecycle qualification.

## Destructive boundary

Broad implementation approval is not treated as permission to delete current
servers. Immediately before the rehearsal, the operator must provide the exact
approval phrase:

```text
APPROVE ZERO-TO-12 REHEARSAL
```

The controller must then reverify no active event, publisher, output, incident,
or gate; current backups and endpoint anchors; the 15-Droplet limit; and the
exact 12-resource manifest. Any failed precondition aborts before the first
delete. Cleanup is ID- and ownership-scoped and must return both provider and
DNS inventories to the protected baseline.

## Current decision

Do not increase the planned fleet, weaken the endurance evaluator, or keep
idle replacement Droplets. The current architecture remains one compositor per
camera plus one warm spare because it constrains the blast radius and because a
single larger shared worker has not demonstrated equivalent isolation. The
next infrastructure action is the exact destructive rehearsal after explicit
approval; the next monitoring action is the phone-visible Camera 4 timing
repeat.

# July 13 Post-Soak Remediation Plan

## Decision

The extended run is not a Gate 2 pass. It produced one qualified subsystem
result and two production-blocking failures:

| Area | Result | What it proves |
| --- | --- | --- |
| Fail-closed Speedify routing | Pass for the tested five direct publishers | Camera traffic stayed on the bonded path; route-table loss and a controlled disconnect blocked immediately and recovered in 3 and 11 seconds. |
| Eight raw feeds | Partial pass | All eight raw paths stayed available, but Cameras 6-8 were temporary WireGuard pulls rather than final direct callers. |
| Program outputs | Fail | Only Courts 1, 3, and 5 ran end to end; all three accumulated material browser drops, freezes, jitter-buffer delay, and reconnects. |
| Ingest capacity | Fail | A four-vCPU MediaMTX host reached endpoint load above 12 and accumulated 121 hook descendants in zombie state. |
| Compositor capacity | Unqualified | One current Egress job was safe; the tested `c-4` rejected a second current job. |
| Venue capacity | Unqualified | The measured bonded upload floor was 31.8 Mbps, below the required 75 Mbps. |
| YouTube output | Availability pass only | Courts 1, 3, and 5 remained active, live, good, and bound, but API health did not reveal the browser presentation loss. |

The ten-hour one-court run remains a conditional Gate 1 pass because only the
initial subjective sync observation was recorded and camera recovery was not
exercised. No result permits public cutover yet.

## Evidence Boundaries

Confirmed defects:

1. Program-browser presentation can degrade severely while RTP loss is zero,
   sampled FPS briefly reads 30, upstream FFmpeg is real-time, Egress is healthy,
   and YouTube reports good health.
2. In-page WHEP reconnects reset peer-connection counters without changing the
   page-load identity, so raw cumulative browser gauges are not safe alert inputs.
3. A production Vercel rollout reloads the embedded overlay unless the embedded
   program scene is excluded from the standalone overlay version-reload policy.
4. The MediaMTX hook process tree had a concrete orphaning path: a nested shell
   and a runner cleanup handler that killed children without waiting for them.
5. The four-vCPU ingest host has inadequate production normalization headroom.
6. Multiple Speedify watch processes can overlap transiently under supervision;
   route state did not drift, but concurrent reconcilers are not acceptable.

Correlations, not yet root causes:

- MediaMTX load and zombie growth sometimes coincided with browser degradation.
  They also varied independently, so neither is established as the WHEP cause.
- The delayed program branch reported large Chrome jitter buffers. The current
  leading hypothesis is timestamp or pacing behavior across the local SRT delay
  and WHEP scheduling, but the preview/program comparator has not run yet.
- A Court 5 page reload coincided with a small zombie increase. That timing does
  not prove process churn caused the reload.

## Hard-Cutover Fixes

These changes do not require a feature flag:

1. Skip Vercel production builds when a commit has no `apps/web` change.
2. Disable version-triggered reload inside embedded program overlays while
   retaining it for standalone overlay browser sources.
3. Accumulate browser receive, decode, drop, and freeze counters across WHEP
   reconnects and alert on reset-safe two-minute rates.
4. Provide one admin-only sequential Preview A -> Program -> Preview B
   comparator that mounts exactly one WHEP reader at a time.
5. Make MediaMTX hooks directly `exec` the runner and make the runner wait for
   every FFmpeg/parser child on HUP, INT, TERM, and normal exit.
6. Hold one Speedify watchdog lifetime lock and make duplicate starts exit
   before reconciliation.

The first four were validated on the sealed monitoring branch. The last two
have focused regression tests in this hardening branch. None is accepted as a
runtime fix until the post-deployment gates below pass.

## Architecture Correction

The prior four-`c-4`, two-courts-per-compositor target is retired. The real
admission result disproved it, and the central `c-4` normalization topology also
failed twice under different load levels.

Use these boundaries:

- MediaMTX owns authenticated raw and derived path relay, not all heavy video
  normalization on its four-vCPU host.
- Prefer final cameras publishing qualified 720p30 H.264 over SRT. If a model
  cannot do that reliably, place its video normalization on an isolated event
  worker with an explicit court assignment.
- Treat one `c-4` compositor per court as the safe baseline. A larger host may
  own two courts only after the exact two-job workload passes admission and
  endurance tests.
- Keep every worker disposable and event-scoped. Configuration, secrets,
  manifests, and retained evidence survive; compute is deleted only after an
  operator confirms coverage and evidence export are complete.

Capacity acceptance for every admitted host:

- sustained CPU below 80 percent, with p95 at or below 75 percent;
- FFmpeg speed at least 0.98x and stable 30 fps with no drop growth;
- no Egress rejection, restart, OOM, or `/dev/shm` pressure;
- stable RSS after warmup and zero zombie-process growth;
- no one-court fault affecting a court not assigned to that host.

## Execution Sequence

### Phase 0: integrate and deploy diagnostics

1. Merge the sealed soak evidence and hard-cutover fixes.
2. Run monitoring, web, MediaMTX lifecycle, router, typecheck, and production
   build validation.
3. Deploy during a declared test window. Do not combine the deployment with a
   public broadcast or StreamRun change.

### Phase 1: short causal diagnostics

1. With one real camera, run the sequential Preview A -> Program -> Preview B
   comparator on the same browser and host.
2. Require both preview legs to agree. If only Program degrades, instrument and
   correct the delayed branch timestamps/pacing, then repeat. If all legs
   degrade, move the boundary upstream to normalization or WHEP delivery.
3. Start and stop preview/program readers at least 50 times. Zombie count must
   remain flat and every progress file must be removed.
4. Repeat a one-court camera disconnect/reconnect and record slate continuity,
   automatic recovery, page reloads, counter resets, and subjective sync.

Do not start another long soak until these short tests pass. More duration on a
known-bad path produces evidence volume, not confidence.

### Phase 2: qualify the final resource topology

1. Test each final camera model at its intended SRT/H.264 profile. Prefer
   camera-side 720p30 H.264; document any court that still requires HEVC decode.
2. Benchmark the isolated normalization assignment at full court count.
3. Benchmark one-court `c-4` compositor workers. Separately test a larger
   two-court candidate only if it materially lowers event cost without reducing
   the acceptance margin.
4. Select the cheapest topology that passes every capacity criterion. Do not
   encode an unmeasured court-per-host count into the permanent manifest.

### Phase 3: repeat the direct-eight gate

The user-approved direct-eight approach remains valid; separate two- and
four-court capacity ramps are not required after Phase 2 passes. The gate must
include:

- all eight final cameras publishing directly through Speedify;
- worst sustained bonded upload of at least 75 Mbps;
- eight raw, preview, program, compositor, and unlisted YouTube outputs;
- scoring on all courts and audible commentary on at least two;
- two continuous hours first, then a twelve-hour endurance run;
- subjective sync at start, midpoint, and end;
- reset-safe browser quality, process churn, CPU, RSS, `/dev/shm`, routing,
  Egress, and YouTube evidence.

Any direct-WAN camera escape, sustained browser quality warning, zombie growth,
host saturation, or cross-court impact fails the run.

### Phase 4: fault matrix

Run one bounded fault at a time and preserve detection latency, recovery time,
duplicate notifications, and unaffected-court evidence:

1. Camera removal and republish.
2. Speedify interface loss and route-table loss, remaining fail-closed.
3. MediaMTX restart and warm-standby failover.
4. One normalizer failure.
5. One Egress process failure.
6. One compositor host loss.
7. Commentary publish/mute/network loss.
8. Controller restart with desired-state reconstruction.
9. Temporary Supabase/origin failure.
10. YouTube API and destination lifecycle faults.
11. Monitoring agent, observability service, Pushover, SMS, and dead-man faults.

### Phase 5: shadow operations

Run a two-court real event day to unlisted destinations while StreamRun remains
public, followed by a full shadow event. The two-court shadow is not a capacity
ramp; it is a bounded operational rehearsal for producer workflow, desired-state
recovery, match transitions, paging, and zero-SSH active play. It should not be
skipped merely because the lab load test used eight cameras.

## Work After Media Qualification

After Phases 1-4 pass:

1. Replace the command proxy with the outbound desired-state reconciler.
2. Move YouTube and program credentials to secret references resolved only by
   the controller.
3. Add reusable YouTube stream and per-match broadcast orchestration.
4. Complete Pushover-backed Healthchecks delivery and Twilio escalation after
   A2P approval.
5. Run the two-court and full shadow events before public cutover.

## Current Operator Dependencies

- Final six AVKANS cameras for the representative direct-caller topology.
- A venue/final-router test that sustains at least 75 Mbps through Speedify.
- Healthchecks Pushover integration authorization.
- Twilio A2P approval before SMS can qualify.
- Explicit confirmation before deleting the current event-tagged droplets.

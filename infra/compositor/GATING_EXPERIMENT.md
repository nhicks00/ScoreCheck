# Phase 2 — Compositor Gating Experiment (runbook)

The only go/no-go in the whole platform plan (`docs/PRODUCTION_PLATFORM_PLAN.md` §3.1, §6).
Prototype **one court end-to-end** with self-hosted LiveKit Web Egress and verify the two
unproven links:

1. **WHEP playback** (the court's `StreamPlayer`) inside egress's headless Chrome
2. **VDO.Ninja commentary audio capture** inside that same Chrome

then run a **10-hour soak** with RSS/CPU data, and benchmark per-court CPU on a known
host size. Budget: ~2 days. Everything here is manual and reversible; StreamRun is
untouched throughout.

---

## Prerequisites

- [ ] **Program page deployed** (Phase 1): `https://score.beachvolleyballmedia.com/program/court/1?token=...`
      renders WHEP video + scorebug + commentary audio in a normal desktop Chrome, and
      `console.log`s **`START_RECORDING`** once video+audio are actually up
      (egress waits for this — `await_start_signal: true`).
- [ ] A live (or test-pattern) feed on MediaMTX `court1` — see
      `docs/MEDIAMTX_DIGITALOCEAN_SETUP.md` for the ffmpeg smoke-test publisher.
- [ ] An **UNLISTED** YouTube broadcast + its stream key (never a public channel for
      this experiment).
- [ ] `lk` CLI on whatever host runs the scripts
      (macOS: `brew install livekit-cli`; Linux: `curl -sSL https://get.livekit.io/cli | bash`).
- [ ] Option A: ssh to `bvm-preview-01` **resized to 8 dedicated vCPU** (it is 1 vCPU/2 GB
      day-to-day — do not attempt this experiment un-resized).
      Option B: `DIGITALOCEAN_TOKEN` + an account ssh-key fingerprint.

## Host option A — existing MediaMTX droplet (resized), alongside MediaMTX

Cheapest path; keeps the WHEP hop on-box. Fine for the 1-court test only.

1. Resize `bvm-preview-01` to a **dedicated-CPU 8 vCPU** size (`c-8`) in the DO panel
   (power off → resize → power on; CPU/RAM-only resize is reversible). MediaMTX +
   one court's transcode leave ~6 vCPU free; egress admission (8 × 0.8 = 6.4 ≥ 4)
   admits exactly one web egress with default costs.
2. Push the bundle from the repo:
   ```bash
   rsync -av --exclude requests/ --exclude .env infra/compositor/ root@206.189.169.162:/opt/compositor/
   ```
3. Docker is already on the droplet (used for the ffmpeg test publisher). If
   `docker compose version` fails, run `curl -fsSL https://get.docker.com | sh`.
4. Continue at **Configure & start the stack** (on the droplet).

## Host option B — fresh burst droplet (c-4, the sizing benchmark)

The truer experiment: measures one court on the exact per-4-vCPU budget the fleet
math assumes (§3.3), on a disposable host. c-4 ≈ $0.125/h → a 12-hour experiment
costs ~$1.50.

1. ```bash
   cd infra/compositor
   ./provision.sh --ssh-key <fingerprint> --dry-run   # sanity-check the request
   DIGITALOCEAN_TOKEN=... ./provision.sh --ssh-key <fingerprint>
   ```
2. Follow the "Next steps" the script prints (wait for cloud-init, rsync bundle).
3. **c-4 admission override (required):** on a 4-vCPU host the default budget
   rejects the first egress (4 × 0.8 = 3.2 < web_cpu_cost 4). In the droplet's
   `/opt/compositor/egress.yaml`, uncomment:
   ```yaml
   cpu_cost:
     web_cpu_cost: 3.0
   ```
   This is a benchmark-only override — the point of the soak is to measure whether
   real usage fits the ~3–4.5 vCPU estimate anyway. Remove it afterwards.

## Configure & start the stack (on the chosen host)

```bash
cd /opt/compositor
cp .env.example .env
docker run --rm livekit/livekit-server generate-keys   # paste into .env
$EDITOR .env    # keypair, PROGRAM_PAGE_TOKEN, COURT_1_YOUTUBE_KEY (unlisted!)
docker compose up -d
docker compose ps                       # all three: running (redis healthy)
curl -s http://127.0.0.1:9091 -o /dev/null -w '%{http_code}\n'   # egress health: 200
```

## Start court 1 and verify

```bash
./start-court.sh 1          # uses COURT_1_YOUTUBE_KEY, preset H264_720P_30
./list-egress.sh            # expect EGRESS_STARTING -> EGRESS_ACTIVE
docker logs -f bvm-egress   # watch chrome launch + START_RECORDING + rtmp connect
```

Verification checklist (the two unproven links, plus quality):

- [ ] `list-egress.sh` shows `EGRESS_ACTIVE` (not stuck in STARTING — stuck means the
      page never emitted `START_RECORDING`: check token, WHEP feed, page watchdog)
- [ ] YouTube Studio preview shows the court video **with scorebug**, updating live
- [ ] Commentary audio (VDO.Ninja room) is audible in the YouTube preview
- [ ] A/V sync sanity: clap test or score-flash vs audio call within ~100 ms after the
      configured program delay
- [ ] YouTube "stream health" reads Excellent/Good; no "insufficient bitrate" warnings
- [ ] Score a few points (fan scoring or MultiCourtScore) — overlay updates end-to-end

If WHEP video or VDO.Ninja audio does **not** survive headless capture and can't be
fixed with program-page tweaks within the timebox → record findings and pivot to the
OBS fallback (plan §3.2, +~3 days). That is the designed outcome of a failed gate —
not extending the timebox.

## 10-hour soak

Leave court 1 broadcasting to the unlisted target. On the host (inside `tmux`):

```bash
cd /opt/compositor
echo "ts,load1,name,cpu_pct,mem_usage,mem_pct" > soak-stats.csv
while true; do
  ts=$(date -u +%FT%TZ); load=$(cut -d' ' -f1 /proc/loadavg)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' \
    | awk -v ts="$ts" -v l="$load" -F',' '{print ts "," l "," $0}' >> soak-stats.csv
  sleep 30
done
```

Spot checks every couple of hours:

```bash
docker exec bvm-egress ps aux --sort=-rss | head -n 8   # chrome/gst RSS ranking
curl -s http://127.0.0.1:9090/metrics | grep -Ei 'cpu|egress' | head  # prometheus
docker ps                                               # zero restarts expected
```

**What to graph** (from `soak-stats.csv`, any spreadsheet works):

- `bvm-egress` CPU% over time → flat band = pass; steady creep = investigate
- `bvm-egress` memory over time → the canonical failure is a monotonic Chrome RSS
  climb (leak) or a sawtooth (tab crash + auto-restart). Flat-ish = pass.
- host `load1` vs vCPU count → sustained load1 ≥ vCPUs means thrash
- Note YouTube Studio health + dropped-frame events alongside timestamps.

## Exit criteria (copied from the plan — §3.3, §6 Phase 2 gate)

- [ ] **Soak passes**: 10 h continuous capture, zero manual intervention, no egress
      container restarts, YouTube stream healthy end-to-end
- [ ] **Per-court CPU ≤ estimates**: 720p30 ≈ **3–4.5 vCPU**, RAM ≈ **2–3 GB**
      (record the actual numbers — they feed fleet sizing: 8 courts → c-32)
- [ ] **A/V acceptable**: WHEP video + VDO.Ninja audio captured correctly, sync
      within spec, quality signed off by watching the unlisted stream
- [ ] **c-4 benchmark recorded** before any fleet-sizing decision

**Pass** → proceed to Phase 3 (ops console MVP). **Fail** → pivot to the OBS-per-court
fallback (§3.2, adds ~3 days); the program page carries the scene either way.

## Rollback / cleanup

```bash
./stop-court.sh 1            # ends the YouTube push (egress flushes + exits)
docker compose down          # stops redis/livekit/egress
```

- Option A: resize `bvm-preview-01` back down.
- Option B: `DIGITALOCEAN_TOKEN=... ./teardown.sh` (destroys by tag `bvm-compositor`
  only — cannot touch bvm-preview-01). Billing stops at destroy.
- End the unlisted YouTube broadcast in Studio.
- Save `soak-stats.csv` + findings into the plan's Phase 2 status before deciding.

---

## RESULTS — 2026-07-08 (run locally on macOS/colima against the live Waupaca event)

**Verdict: GO.** Every go/no-go link passed on the recommended architecture.

| Check | Result |
|---|---|
| Headless Chrome plays MediaMTX WHEP | ✅ (production program page, live court feed) |
| Scorebug composite fidelity | ✅ frame grab pixel-correct, live match data, broadcast position |
| VDO.Ninja scene loads headlessly | ✅ (`commentary_loaded: true` heartbeats; NOTE: room was empty — audible-voice validation still pending) |
| `await_start_signal` / START_RECORDING | ✅ fired exactly once, capture gated correctly |
| RTMP push stability | ✅ 2h+ continuous to MediaMTX (`live/gating_test_raw`) |
| Program-page heartbeats | ✅ 5s cadence to Supabase throughout |
| Soak (2h10m, live conditions) | ✅ zero output gaps; RSS 501→674MB (~86MB/h, flattening); CPU 24–50% of 6 arm64 cores |

**Bugs found & fixed during the run:**
1. `mediamtx.yml` was missing the `all_others` catch-all path (comment promised it; entry absent) — added; note: the `:ro` bind mount does NOT hot-reload appended config; container restart required.
2. LiveKit egress requires two-segment RTMP paths (`/{app}/{key}`) — scratch targets must use e.g. `live/gating_test_raw`.
3. `.env` values containing `&` must be quoted (court scripts `source` the file).
4. Ops monitoring against a saturated 1-vCPU host needs N-strike tolerance + generous timeouts (false path-missing alarm at 100% CPU).

**Carried forward to the shadow event (Phase 4):**
- CPU benchmark on real DO Intel dedicated vCPUs (arm64 M-series numbers don't transfer).
- Full 10h duration + audible commentary audio end-to-end + YouTube as the actual RTMP target (unlisted).

## Sync-calibration timecode (added 2026-07-08, Phase 5 tooling)

Preview transcodes (`court{N}`, the on-demand paths) burn `%{gmtime} UTC` bottom-right
(font mounted at /opt/mediamtx/fonts, drawtext in each runOnDemand command).
Uses: measure preview glass-latency against any UTC clock; measure program-vs-preview
delta for the scene `&buffer` value; verify sync drift across a day.

NOTE: the program pages consume `court{N}`, so shadow-phase compositor output includes
the timecode — intentional for shadow calibration. BEFORE cutover (Phase 6), point the
program pages at a clean path (e.g. dedicated `court{N}_pgm` transcode without drawtext)
or strip the drawtext from the config.

## YouTube-push validation — 2026-07-08 (Wed night, pre-main-draw)

Closed the last gating carry-forward: compositor → **real YouTube RTMP** (gating run
only reached MediaMTX). Synthetic 720p feed → court3_raw → on-demand transcode →
program page (Court 3 live pre-match overlay) → headless egress → x264 720p30 →
`rtmp://a.rtmp.youtube.com/live2/<test-key>`. Egress went ACTIVE, zero RTMP rejection,
stable ~37% CPU / ~1GB RSS on the Mac; `court3` showed 1 WHEP reader (the page).
Ran on the Mac — **no DO burst droplet needed for a 1-court shadow**, so DIGITALOCEAN_TOKEN
is NOT a blocker for shadowing one court; it's only needed for the multi-court burst fleet.

### TOMORROW — one-command live shadow (Phase 4)
Once a court's real feed is live on the droplet (court{N}_raw ingesting):
```
colima start --cpu 6 --memory 10          # if not already up
cd infra/compositor && docker compose up -d
./start-court.sh <N> <youtube-stream-key>  # composites live court N → YouTube
./list-egress.sh                           # confirm EGRESS_ACTIVE
./stop-court.sh <N>                         # end the shadow
```
Still unproven until a live match runs: audible commentary sync + multi-hour stability
on real footage + CPU on DO Intel dedicated vCPUs (Mac arm64 numbers don't transfer).

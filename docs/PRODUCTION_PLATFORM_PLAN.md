# BVM Production Platform — Full Integration Plan

**Goal:** replace StreamRun with a self-hosted production platform that does everything StreamRun does — composite the scorebug over live court video, mix remote commentary, push program feeds to YouTube, and give a human a friendly console to run it — plus the things StreamRun can never do: native live-scoring integration, commentator workflows, per-court sync control, and burst-priced infrastructure that costs ~$15/month when idle.

Written 2026-07-08 from two verified research passes (compositor stacks; DigitalOcean pricing/automation). Sources linked inline. Status of each phase is tracked at the bottom.

---

## 1. Vision

One platform, one domain, three doors:

| Audience | Door | What they do |
|---|---|---|
| **Fans** | `score.beachvolleyballmedia.com` | Watch courts, claim a court, keep live score with instant name-only entry |
| **Commentators** | `/commentary` (passcode) | See every court + current match, join their VDO.Ninja room, watch sub-second preview, keep score while they call |
| **Producers (you)** | `/admin` | Run the broadcast: start/stop courts, multiview program monitor, audio/sync trims, health board, event-day infra buttons |

Everything below the UI is yours: ingest (MediaMTX), preview (WHEP), compositing (program pages + egress), distribution (YouTube RTMP), scoring (Supabase + VBL), commentary transport (VDO.Ninja). No per-stream SaaS fees, no external editor to keep in sync.

## 2. What already exists (do not rebuild)

| Layer | Status |
|---|---|
| RTMP/SRT ingest, per-court paths, auth | ✅ MediaMTX droplet (`bvm-preview-01`), live-verified with StreamRun feeds |
| Sub-second preview (WHEP) + AAC→Opus / B-frame-stripping transcode | ✅ live-verified |
| Program-delay mechanism for commentary sync | ✅ SRT pull latency (validated ~3.5s buffer accuracy) + VDO.Ninja `&buffer` fine trim (docs-verified) |
| Scorebug overlays (broadcast-grade HTML) | ✅ `/overlay/stream/N`, self-healing, realtime |
| Live scoring: VBL polling, fan scoring, roles, corrections | ✅ hardened this week |
| Event automation: discovery, court mapping, coverage-day worker | ✅ live (Waupaca) |
| Commentator portal | 🟡 built in worktree `feat/commentator-portal` (paused mid-build; finish with VDO.Ninja research corrections) |
| Ops automation: GitHub/Vercel/Supabase/Render/DO-droplet control | ✅ agent-operable |

The remaining gap — StreamRun's actual footprint — is exactly three things: **the mix, the push, and the console.**

## 3. Target architecture

```
Venue cameras (RTMP over Speedify) ──► MediaMTX droplet (always-on, $14/mo)
                                          ├─ court{N}_raw ── SRT delayed pull (sync) ─┐
                                          ├─ court{N} (720p, no-B-frames, Opus)       │
                                          │     ├─► WHEP → fans/commentators/console  │
                                          │     └─► WHEP → PROGRAM PAGE ◄─────────────┘ (video source)
                                          │
     ScoreCheck (Vercel) ─ overlays/state ─► PROGRAM PAGE  /program/court/N
     VDO.Ninja room audio ─────────────────►   = the scene: video + scorebug DOM
                                          │     + commentary audio + in-page gains
                                          │     + self-watchdog + heartbeat
                                          ▼
                     Compositor fleet (burst droplet, event days only)
                     LiveKit Egress workers (headless Chrome capture → x264 → RTMP)
                                          │
                                          ▼
                              YouTube (same channels/keys as today)
```

### 3.1 The compositor: "program page as scene" (recommended)

Per court, a Next.js **program page** (`/program/court/N`, token-gated, 1280×720 or 1920×1080 fixed canvas) renders:
- the court video via the existing `StreamPlayer` (WHEP),
- the scorebug as plain DOM (same components as the OBS overlay — no browser-in-browser),
- the court's VDO.Ninja scene as a hidden audio element with **in-page gain control**,
- a **self-watchdog**: reconnect WHEP on stall, reload on frozen frames, heartbeat + stats (frame clock, audio levels) to Supabase so the console sees *semantic* health, not just "Chrome is running."

A self-hosted **[LiveKit Egress](https://docs.livekit.io/home/egress/web/)** worker captures that URL headlessly (Chrome + Xvfb + PulseAudio + GStreamer, Apache-2.0, actively maintained — v1.13.0 May 2026) and pushes RTMP to YouTube. Web egress explicitly does not require LiveKit rooms; a lightweight LiveKit server + Redis acts purely as the egress control API (StartWebEgress / StopEgress / ListEgress, health + Prometheus ports).

Why this beats classic OBS scenes: the scene is *code in this repo* (versioned, testable, previewable in any browser), overlay/scoring changes never touch the media engine, per-source control (audio ducking, sync trim, layout) is a Supabase-realtime message instead of a media-API call, and the exact page doubles as the console's program monitor. This is the pattern StreamRun-class SaaS run internally ([Mux's headless-Chrome-as-a-service](https://www.mux.com/blog/lessons-learned-building-headless-chrome-as-a-service)).

**Gating experiment (Phase 2, ~2 days):** prototype one court end-to-end and verify the two unproven links — WHEP playback + VDO.Ninja audio capture inside egress's headless Chrome — then a 10-hour soak with RSS/CPU graphs. This is the only go/no-go in the whole plan.

### 3.2 Fallback compositor: OBS-per-court in Docker

Verified viable via obs-websocket v5 (scene/source creation, browser sources, `SetInputVolume`, `SetInputAudioSyncOffset`, `StartStream`, `GetStats` — [protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)). Costs: we own the Docker image (no maintained turnkey image in 2026), CEF memory-leak watchdogs, version pinning. Choose only if the egress prototype fails; the program page still carries the overlay+audio either way (OBS would capture it as a single browser source).

### 3.3 Sizing & encoding (research-verified estimates)

| Per court (decode + Chrome render + x264 + mux) | vCPU (dedicated) | RAM |
|---|---|---|
| 720p30 x264 veryfast | ~3–4.5 | ~2–3 GB |
| 1080p30 x264 veryfast | ~4–7 | ~3–4 GB |

(Cross-validated against LiveKit's own admission control — one web egress budgets **4 cores** by default (`webCpuCost = 4`, [service.go](https://raw.githubusercontent.com/livekit/egress/main/pkg/config/service.go)) — plus Jibri sizing and x264 density benchmarks.)

- **8 courts @ 720p30** → one CPU-Optimized 32-vCPU droplet (`c-32`, **$1.00/hr**, event days only) fits with headroom (~24–36 vCPU demand). There is no 24-vCPU tier (16 → 32 → 48).
- **8 @ 1080p30** → 2 hosts (2× c-32 ≈ $2/hr) or c-48. Start at 720p30 — matches current preview quality, halves cost, and sidesteps a known egress 1080p30 stutter report ([#777](https://github.com/livekit/egress/issues/777)); per-court 1080p upgrades are a config value later.
- **Dedicated vCPUs only** (CPU-Optimized — Intel; DO has no dedicated AMD tier). Shared/Basic tiers can receive "fractions of hyper-threads" under contention — unusable for 10-hour sports encodes.
- Cap x264 threads per pipeline (6–8) so eight encoders don't thrash each other.
- Egress exposes no x264 preset knob; encoding params are width/height/fps/bitrate/keyframe (1080p30 preset = 4.5 Mbps, 4s keyframes — fine for YouTube). Use `await_start_signal` (page logs `START_RECORDING` when its WHEP + audio are actually up) so captures never start on a half-loaded page.
- Benchmark one real court on `c-4` before fleet-sizing (Phase 2 exit criterion).
- Future option if CPU economics ever pinch: DO's RTX 4000 Ada GPU droplet ($0.76/hr) has NVENC — but only 8 vCPUs, too thin for 8 Chrome renders; revisit only for an encode-offload split.

### 3.4 Distribution (YouTube push)

- Egress pushes `rtmp://a.rtmp.youtube.com/live2/<key>` — same channels/keys as today. Keys move from StreamRun's UI into Supabase (`courts.youtube_stream_key`, encrypted at rest via Supabase Vault or app-layer AES), editable in the console.
- Later (optional): YouTube Data API integration to create/schedule broadcasts, set titles per event/court automatically ("Waupaca Boatride 2026 — Court 5"), and rotate keys.

### 3.5 The ops console (`/admin/production`)

Extends the existing admin design system:
- **Court grid**: per court — program thumbnail (the program page itself, muted, in an iframe/WHEP mini-player), state machine (`idle → previewing → live → error`), start/stop button, YouTube health (bitrate, dropped frames from egress stats), audio meters (from program-page heartbeats).
- **Court detail**: full program monitor, commentary gain slider, **sync trim** (video-delay coarse via SRT pull config, audio fine via scene `&buffer` — both writable live through Supabase realtime → program page), overlay theme, stream key.
- **Event-day infra panel**: "Provision compositor fleet" / "Tear down fleet" buttons → production controller → DO API (create from snapshot → cloud-init → egress workers register). Countdown/status while booting (~10–15 min lead).
- **Health board**: folds in the existing worker/DB health plus MediaMTX path stats (already exposed at `127.0.0.1:9997`) and egress Prometheus metrics.
- **Runbook links + break-glass**: one page documenting "revert court N to StreamRun in <10 minutes" during the transition season.

### 3.6 Production controller (the one new backend service)

A small always-on service (Docker, on the existing $14 base droplet) that:
- talks DO API (create/destroy burst droplets from snapshot, reassign reserved IP),
- talks LiveKit Egress API (start/stop/list per court),
- relays health (egress + MediaMTX + program-page heartbeats → Supabase),
- exposes an authenticated REST surface consumed by `/admin/production`.
Auth: admin-JWT from the existing session; controller holds the DO + egress credentials so they never live in Vercel.

## 4. Cost model (verified 2026 prices)

DigitalOcean bills per-second with a monthly cap; **powered-off droplets still bill 100%**, so the idle pattern is snapshot → destroy → recreate ([pricing](https://docs.digitalocean.com/products/droplets/details/pricing/), [snapshots $0.06/GB/mo](https://docs.digitalocean.com/products/snapshots/details/pricing/)). Reserved IPs are free while assigned, so `preview.` DNS never changes. Bandwidth pools team-wide and accrues per-second; the base droplet's 2 TB allowance makes event egress effectively free (verified math: a 3-day 8-court event ≈ 918 GiB out vs ~2.4 TiB pooled).

| Scenario | Compute | Storage/IP | **Total** |
|---|---|---|---|
| Idle month (base droplet + snapshots) | $14.00 | ~$1.20 | **~$15/mo** |
| + one 3-day event, 8 courts @ 720p30 (c-32 × 40h $40 + MediaMTX resize ~$3) | ~$57 | ~$1.20 | **~$58 that month** |
| Same event on StreamRun (8 × $0.50/hr × 30h) | — | — | **~$120/event, every event** |

Baseline months sit at ~$15 (70% under the $50 target). Event-month totals scale with ambition (720p vs 1080p, court count) but stay a fraction of StreamRun — and to *pause entirely*, destroy everything but keep snapshots: **~$1.20/month**.

## 5. UX & quality bar (the "beautiful + reliable" mandate)

- **Design**: everything ships in the established system (ink surfaces, coral/cyan, Space Grotesk, tabular numerals). The console gets the same care as the fan pages — production tooling that looks like a broadcast product, not a settings page. Landing page grows a "Watch live" rail (court cards → YouTube embeds) during events.
- **UX principles**: every audience gets one link and zero configuration (fans: court page; commentators: portal; producer: console). Every state is explicit — nothing renders stale data silently (this week's stale-match/idle-court work is the template).
- **Reliability engineering**:
  - Program pages self-heal (WHEP reconnect, stall reload) and heartbeat; the console alarms on missing heartbeats, not just process death.
  - Egress workers are cattle: health-checked containers, auto-restart, one warm spare court-slot of capacity during events.
  - Chrome memory: per-court isolation + scheduled between-match restarts + RSS watchdogs (the canonical browser-compositor failure mode).
  - Every phase has a **shadow gate**: nothing replaces StreamRun for a court until it has run a full real event day in parallel (unlisted YouTube target) without intervention.
  - Verification bar per change: `typecheck + lint + test + build` (existing), plus soak tests for media components and a scripted event-morning smoke checklist in the console.
- **Code health**: pure decision logic stays in unit-tested libs (this week's pattern); media plumbing lives in versioned config (mediamtx.yml, egress config, cloud-init) committed to this repo; docs-as-built maintained (`MEDIAMTX_DIGITALOCEAN_SETUP.md` precedent).

## 6. Phased roadmap

| Phase | Scope | Effort | Gate to proceed |
|---|---|---|---|
| **0. Current event (now)** | StreamRun runs Waupaca; new stack observes | — | Event retro: latency numbers, pain list |
| **1. Commentator portal + program page foundation** | Finish paused portal (with VDO.Ninja corrections: `bvm2026` password, `&buffer`/`&retry`/`&noisegate`, director rooms-chain); build `/program/court/N` page (video + scorebug + commentary audio + watchdog + heartbeat) — it's ~80% shared with the portal court page | 2–3 days | Portal used by a real commentator; program page renders correctly in a normal browser |
| **2. Compositor gating experiment** | Self-host LiveKit egress on a c-4; capture court 1's program page → unlisted YouTube; verify WHEP video + VDO.Ninja audio in headless Chrome; 10-h soak; CPU benchmark | 2–3 days | Soak passes; per-court CPU ≤ estimates; A/V acceptable → else pivot to OBS fallback (adds ~3 days) |
| **3. Ops console MVP** | `/admin/production`: court grid, start/stop via controller, program monitors, egress health, YouTube keys in Supabase | 3–4 days | You can start/stop a court broadcast end-to-end without touching StreamRun or SSH |
| **4. Shadow event** | 1–2 courts run the full new pipeline in parallel with StreamRun at a real event (unlisted) | event weekend | Zero-intervention day; sync + quality signed off by you |
| **5. Burst automation + scale-out** | Snapshot/recreate fleet via controller; reserved-IP flow; 8-court capacity test with synthetic feeds; sync-calibration tooling (burned preview timecode) | 2–3 days | Full 8-court synthetic day on burst infra |
| **6. Cutover event** | New stack runs all courts live; StreamRun account kept as documented break-glass | event weekend | Clean event → cancel StreamRun |
| **7. Platform polish** | YouTube API scheduling, fan "watch" rail, multiview page, commentary auto-calibration, per-court 1080p, replays/clips backlog | ongoing | — |

Rough build total: **~2 weeks of focused build** across phases 1–3+5, gated by two real event weekends (4, 6). StreamRun remains the safety net throughout — its remaining value is exactly that insurance, and it retires the moment the insurance stops earning its premium.

## 7. Risks & mitigations (top 5)

1. **Headless WHEP/VDO.Ninja capture unproven** → Phase 2 is designed to kill this risk first; OBS fallback verified viable.
2. **Browser memory over 10-h days** → isolation, scheduled restarts, watchdogs; soak test before any real event.
3. **Droplet as program-path single point of failure** → per-event snapshot restore drill (<15 min), StreamRun break-glass through the transition season, and (later) a second-region standby snapshot.
4. **Sizing surprise on sports motion** → benchmark before fleet-sizing; 720p first; CPU-Optimized only.
5. **Operator (you) mid-event** → the console is built for the person, not the API: big states, one-click actions, runbook inline. Every failure the shadow events surface becomes a console affordance.

## 8. Decision log

- Compositor: **LiveKit Web Egress capturing our own program pages** (runner-up: OBS-headless + obs-websocket v5). CasparCG/GStreamer-WPE/DIY-ffmpeg evaluated and rejected (operator-oriented / unproven WebRTC / rebuilding-Jibri respectively). Norsk rejected on price ($16k/yr for 8 channels).
- Infra: raw droplets + snapshot burst (App Platform can't do RTMP/UDP; DOKS adds friction for zero cost benefit).
- Encoding: x264 720p30 veryfast baseline; no GPU (DO has no economical NVENC path).
- Cameras remain RTMP end-to-end (owner constraint; SRT only on server↔server legs).
- Sync: coarse video delay at MediaMTX (SRT pull latency), fine audio trim via VDO.Ninja `&buffer`, live micro-trim via director micdelay — all validated this week.

---

## 9. Execution status

| Item | Status | Ref |
|---|---|---|
| Phase 0 — current event on StreamRun | 🟢 running (Waupaca, Jul 8–10) | — |
| Phase 1a — commentator portal | 🟡 in progress (`feat/commentator-portal`) | — |
| Phase 1b — program page `/program/court/N` | ✅ built (`feat/program-page`): token-gated scene (video + scorebug + commentary audio + watchdog + START/END signals), `/api/program/heartbeat` + `012_program_heartbeats.sql`, `PROGRAM_PAGE_TOKEN` env | §3.1, `docs/COMMENTARY_WORKFLOW.md` §Program Pages |
| Phase 2 — compositor stack configs + runbook | ✅ merged | `infra/compositor/`, 436e7788 |
| Phase 2 — gating experiment execution | ⬜ blocked on droplet capacity (resize or `DIGITALOCEAN_TOKEN`) | `infra/compositor/GATING_EXPERIMENT.md` |
| Phase 3 — controller skeleton | ✅ merged (`infra/controller/`) | 612ca88a |
| Phase 3 — ops console `/admin/production` | ⬜ after gating experiment | §3.5 |
| Phases 4–7 | ⬜ event-gated | §6 |

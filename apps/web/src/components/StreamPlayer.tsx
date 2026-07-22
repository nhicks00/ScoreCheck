"use client";

import { Play, RefreshCw, VideoOff, Volume2, VolumeX } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  brokeredScoringSessionId,
  buildPlaybackEvidence,
  initialPlaybackEvidenceState,
  playbackModeAllowsHls,
  type PlaybackConnectionState,
  type PlaybackEvidenceSnapshot,
  type PlaybackEvidenceState,
  type PlaybackMode,
  type PlaybackTransport
} from "@/lib/communityPlaybackTiming";
import {
  classifyRtcNetworkPath,
  intervalJitterSample,
  monotonicEpochMs,
  STREAM_TIMING_INTERVAL_MS,
  type RtcJitterTotals,
  type StreamTimingSample
} from "@/lib/rtcTiming";

type StreamPlayerProps = {
  courtNumber: number;
  /** Admin monitor playback profile. Other player consumers keep the existing preview path. */
  adminQuality?: "data_saver" | "detail";
  enabled?: boolean;
  /** Pre-resolved playback sources. When provided the player skips its internal source fetching entirely. */
  sources?: { whepUrl: string | null; hlsUrl: string | null };
  /** Hides all player chrome (status chip, buttons, error fallback, native controls) for capture surfaces like /program. */
  chromeless?: boolean;
  /** Program capture and scoring must never change latency classes by falling back to HLS. */
  mode?: PlaybackMode;
  /** Gives the program mixer access to the camera media element. */
  onVideoElement?: (element: HTMLVideoElement | null) => void;
  /** WHEP transport timing used by the commentary/program synchronization controller. */
  onTimingSample?: (sample: StreamTimingSample | null) => void;
  /** Bounded transport diagnostics for the independent monitoring gateway. */
  onConnectionHealth?: (health: StreamConnectionHealth | null) => void;
  /** Reports each transport retry so program diagnostics survive player remounts. */
  onReconnect?: () => void;
  /** Reports only changes to the scoring safety decision; it never exposes a
   * media URL, edge credential, or source-clock claim. */
  onScoringQualification?: (qualification: PlaybackEvidenceSnapshot["qualification"]) => void;
};

export type StreamPlayerHandle = {
  /** Captures browser-local, diagnostic playback evidence at the exact action time. */
  capturePlaybackEvidence: (options?: { baseRevision?: number }) => PlaybackEvidenceSnapshot;
  retryPlayback: () => void;
};

export type StreamConnectionHealth = {
  transport: PlaybackTransport;
  connectionState: PlaybackConnectionState;
  networkPath: "private-vpc" | "public" | "unknown";
  framesPerSecond: number | null;
  width: number | null;
  height: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  keyFramesDecoded: number | null;
  framesDropped: number | null;
  bytesReceived: number | null;
  freezeCount: number | null;
  totalFreezesDurationMs: number | null;
  lastPacketAgeMs: number | null;
  nackCount: number | null;
  pliCount: number | null;
  firCount: number | null;
};

type StreamSources = {
  whepUrl: string | null;
  hlsUrl: string | null;
};

type HlsInstance = {
  loadSource: (url: string) => void;
  attachMedia: (element: HTMLVideoElement) => void;
  on: (event: string, callback: (event: string, data: { fatal?: boolean }) => void) => void;
  destroy: () => void;
};

const WHEP_FAILURES_BEFORE_HLS = 3;
const MAX_RETRY_DELAY_MS = 15_000;
const OFFLINE_MESSAGE = "Stream offline — retrying";

export const StreamPlayer = forwardRef<StreamPlayerHandle, StreamPlayerProps>(function StreamPlayer({
  courtNumber,
  adminQuality,
  enabled = true,
  sources: providedSources,
  chromeless = false,
  mode = "preview",
  onVideoElement,
  onTimingSample,
  onConnectionHealth,
  onReconnect,
  onScoringQualification
}: StreamPlayerProps, ref) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackEvidenceStateRef = useRef<PlaybackEvidenceState>(initialPlaybackEvidenceState());
  const [sources, setSources] = useState<StreamSources | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [status, setStatus] = useState("Loading stream...");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(mode !== "program");
  const qualificationKeyRef = useRef("");
  // Depend on the primitive URLs so a parent re-render with an identical
  // sources object never tears down a healthy connection.
  const hasProvidedSources = providedSources != null;
  const providedWhepUrl = providedSources?.whepUrl ?? null;
  const providedHlsUrl = providedSources?.hlsUrl ?? null;

  const reportScoringQualification = useCallback((state: PlaybackEvidenceState) => {
    if (!onScoringQualification) return;
    const video = videoRef.current;
    const qualification = buildPlaybackEvidence(state, {
      currentTimeSeconds: video?.currentTime ?? null,
      readyState: video?.readyState ?? 0,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      paused: video?.paused ?? true
    }).qualification;
    const key = `${qualification.liveActionEligible}:${qualification.blockedReason ?? "ready"}`;
    if (qualificationKeyRef.current === key) return;
    qualificationKeyRef.current = key;
    onScoringQualification(qualification);
  }, [onScoringQualification]);

  const updatePlaybackEvidenceState = useCallback((patch: Partial<PlaybackEvidenceState>) => {
    const next = { ...playbackEvidenceStateRef.current, ...patch };
    playbackEvidenceStateRef.current = next;
    reportScoringQualification(next);
  }, [reportScoringQualification]);

  useImperativeHandle(ref, () => ({
    capturePlaybackEvidence: ({ baseRevision } = {}) => {
      const video = videoRef.current;
      return buildPlaybackEvidence(playbackEvidenceStateRef.current, {
        baseRevision,
        currentTimeSeconds: video?.currentTime ?? null,
        readyState: video?.readyState ?? 0,
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        paused: video?.paused ?? true
      });
    },
    retryPlayback: () => setLoadRevision((current) => current + 1)
  }), []);

  useEffect(() => {
    reportScoringQualification(playbackEvidenceStateRef.current);
  }, [reportScoringQualification]);

  useEffect(() => {
    onVideoElement?.(videoRef.current);
    return () => onVideoElement?.(null);
  }, [onVideoElement]);

  useEffect(() => {
    const video = videoRef.current;
    if (mode !== "scoring" || !enabled || !video || typeof video.requestVideoFrameCallback !== "function") return;
    let cancelled = false;
    let callbackId = 0;
    const sample = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (cancelled) return;
      const state = playbackEvidenceStateRef.current;
      if (state.transport === "whep"
        && state.connectionState === "connected"
        && state.sessionId) {
        const mediaTimeSeconds = Number.isFinite(metadata.mediaTime)
          ? Math.max(0, metadata.mediaTime)
          : Math.max(0, video.currentTime);
        updatePlaybackEvidenceState({
          paused: video.paused,
          stalled: false,
          frame: {
            source: "video-frame-callback",
            sessionId: state.sessionId,
            presentedFrames: Math.max(0, Math.trunc(metadata.presentedFrames)),
            mediaTimeSeconds,
            observedAtMs: monotonicEpochMs()
          }
        });
      }
      callbackId = video.requestVideoFrameCallback(sample);
    };
    callbackId = video.requestVideoFrameCallback(sample);
    return () => {
      cancelled = true;
      if (typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackId);
      }
    };
  }, [enabled, mode, updatePlaybackEvidenceState]);

  const loadSources = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    setStatus("Loading stream...");
    if (hasProvidedSources) {
      setSources({ whepUrl: providedWhepUrl, hlsUrl: providedHlsUrl });
      setLoadRevision((current) => current + 1);
      return;
    }
    const res = await fetch(`/api/admin/video/stream-source?${new URLSearchParams({
      courtNumber: String(courtNumber),
      ...(adminQuality ? { quality: adminQuality } : {})
    })}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSources(null);
      setStatus("Stream video is not available yet.");
      setError(json.error ?? "Stream video is not available yet.");
      return;
    }
    setSources({ whepUrl: json.whepUrl ?? null, hlsUrl: json.hlsUrl ?? null });
    setLoadRevision((current) => current + 1);
  }, [adminQuality, courtNumber, enabled, hasProvidedSources, providedWhepUrl, providedHlsUrl]);

  useEffect(() => {
    if (!enabled) {
      setSources(null);
      playbackEvidenceStateRef.current = initialPlaybackEvidenceState();
      return;
    }
    void loadSources();
  }, [enabled, loadSources]);

  useEffect(() => {
    if (!enabled || !sources || !videoRef.current) return;
    if (!sources.whepUrl && !sources.hlsUrl) {
      setStatus("Stream video is not available yet.");
      setError("Stream video is not available yet.");
      updatePlaybackEvidenceState(initialPlaybackEvidenceState());
      onConnectionHealth?.(emptyConnectionHealth());
      return;
    }
    const video = videoRef.current;
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let hls: HlsInstance | null = null;
    let retryTimer: number | null = null;
    let timingTimer: number | null = null;
    let whepFetchController: AbortController | null = null;
    let whepSessionUrl: string | null = null;
    let whepAttempt = 0;
    let previousTimingTotals: RtcJitterTotals | null = null;
    let whepFailures = 0;
    let hlsFailures = 0;

    const onPlaying = () => {
      if (cancelled) return;
      setError(null);
      setStatus(pc ? "Live — low latency" : "Live — HLS");
      const state = playbackEvidenceStateRef.current;
      updatePlaybackEvidenceState({
        paused: false,
        stalled: false,
        reconnecting: state.transport === "whep" && state.connectionState !== "connected"
      });
      if (!pc) {
        updatePlaybackEvidenceState({ connectionState: "connected", reconnecting: false });
        onConnectionHealth?.({ ...emptyConnectionHealth(), transport: "hls", connectionState: "connected" });
      }
    };
    const onPause = () => updatePlaybackEvidenceState({ paused: true });
    const onWaiting = () => updatePlaybackEvidenceState({ stalled: true });
    const onStalled = () => updatePlaybackEvidenceState({ stalled: true });
    const onEmptied = () => updatePlaybackEvidenceState({
      paused: true,
      stalled: false,
      frame: null
    });
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("emptied", onEmptied);

    function teardownPlayback() {
      whepAttempt += 1;
      whepFetchController?.abort();
      whepFetchController = null;
      if (timingTimer != null) window.clearInterval(timingTimer);
      timingTimer = null;
      previousTimingTotals = null;
      onTimingSample?.(null);
      onConnectionHealth?.(null);
      const closingConnection = pc;
      pc = null;
      closingConnection?.close();
      if (whepSessionUrl) releaseWhepSession(whepSessionUrl);
      whepSessionUrl = null;
      hls?.destroy();
      hls = null;
      video.srcObject = null;
      video.removeAttribute("src");
      updatePlaybackEvidenceState(initialPlaybackEvidenceState());
    }

    function scheduleRetry(fn: () => void, attempt: number) {
      if (retryTimer != null) window.clearTimeout(retryTimer);
      const delay = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        fn();
      }, delay);
    }

    function failWhep(offline: boolean) {
      if (cancelled || retryTimer != null) return;
      teardownPlayback();
      whepFailures += 1;
      updatePlaybackEvidenceState({
        transport: "whep",
        connectionState: "disconnected",
        reconnecting: true
      });
      onReconnect?.();
      setStatus(offline ? OFFLINE_MESSAGE : "Reconnecting stream...");
      if (playbackModeAllowsHls(mode) && whepFailures >= WHEP_FAILURES_BEFORE_HLS && sources?.hlsUrl) {
        scheduleRetry(() => void startHls(), 0);
        return;
      }
      scheduleRetry(() => void startWhep(), whepFailures);
    }

    function failHls() {
      if (cancelled) return;
      teardownPlayback();
      hlsFailures += 1;
      whepFailures = 0;
      updatePlaybackEvidenceState({
        transport: "hls",
        connectionState: "failed",
        reconnecting: true
      });
      setStatus(OFFLINE_MESSAGE);
      scheduleRetry(() => void start(), hlsFailures);
    }

    async function startWhep() {
      const whepUrl = sources?.whepUrl;
      if (cancelled || !whepUrl) return;
      const attempt = ++whepAttempt;
      const sessionId = createPlaybackSessionId("whep");
      updatePlaybackEvidenceState({
        transport: "whep",
        sessionId,
        connectionState: "connecting",
        frame: null,
        paused: video.paused,
        stalled: false,
        reconnecting: whepFailures > 0
      });
      setStatus("Connecting stream...");
      try {
        const connection = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        pc = connection;
        onConnectionHealth?.({ ...emptyConnectionHealth(), transport: "whep", connectionState: "connecting" });
        connection.addTransceiver("video", { direction: "recvonly" });
        connection.addTransceiver("audio", { direction: "recvonly" });
        const stream = new MediaStream();
        connection.ontrack = (event) => {
          stream.addTrack(event.track);
          if (video.srcObject !== stream) video.srcObject = stream;
          void video.play().catch(() => setStatus("Tap play to start the stream."));
        };
        connection.onconnectionstatechange = () => {
          if (cancelled || pc !== connection) return;
          if (connection.connectionState === "connected") {
            whepFailures = 0;
            setError(null);
            setStatus("Live — low latency");
            updatePlaybackEvidenceState({
              connectionState: "connected",
              reconnecting: false
            });
            startTimingSampling(connection);
          }
          const connectionState = normalizeConnectionState(connection.connectionState);
          updatePlaybackEvidenceState({
            connectionState,
            reconnecting: connectionState === "connected" ? false : whepFailures > 0
          });
          onConnectionHealth?.({
            ...emptyConnectionHealth(),
            transport: "whep",
            connectionState
          });
          if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
            failWhep(false);
          }
        };
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await waitForIceGathering(connection, 2000);
        if (cancelled || pc !== connection || attempt !== whepAttempt) {
          connection.close();
          return;
        }
        const controller = new AbortController();
        whepFetchController = controller;
        const res = await fetch(whepUrl, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: connection.localDescription?.sdp ?? offer.sdp ?? "",
          signal: controller.signal
        });
        const responseSessionUrl = whepResourceUrl(res.headers.get("location"), whepUrl);
        if (cancelled || pc !== connection || attempt !== whepAttempt) {
          connection.close();
          if (responseSessionUrl) releaseWhepSession(responseSessionUrl);
          return;
        }
        whepFetchController = null;
        if (res.status === 404) {
          if (responseSessionUrl) releaseWhepSession(responseSessionUrl);
          failWhep(true);
          return;
        }
        if (res.status !== 201 && !res.ok) {
          if (responseSessionUrl) releaseWhepSession(responseSessionUrl);
          failWhep(false);
          return;
        }
        const authoritativeSessionId = mode === "scoring"
          ? brokeredScoringSessionId(responseSessionUrl, window.location.href)
          : null;
        if (mode === "scoring" && !authoritativeSessionId) {
          failWhep(false);
          return;
        }
        whepSessionUrl = responseSessionUrl;
        if (authoritativeSessionId) {
          updatePlaybackEvidenceState({ sessionId: authoritativeSessionId });
        }
        const answer = await res.text();
        if (cancelled || pc !== connection || attempt !== whepAttempt) {
          connection.close();
          if (responseSessionUrl) releaseWhepSession(responseSessionUrl);
          return;
        }
        await connection.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        if (!cancelled) failWhep(false);
      }
    }

    function startTimingSampling(connection: RTCPeerConnection) {
      if (timingTimer != null) return;
      const sample = async () => {
        if (cancelled || pc !== connection || connection.connectionState !== "connected") return;
        try {
          const stats = await connection.getStats();
          const timing = extractTimingSample(stats, previousTimingTotals);
          previousTimingTotals = timing.totals;
          onTimingSample?.(timing.sample);
          onConnectionHealth?.({
            transport: "whep",
            connectionState: normalizeConnectionState(connection.connectionState),
            ...timing.health
          });
        } catch {
          onTimingSample?.(null);
        }
      };
      void sample();
      timingTimer = window.setInterval(() => void sample(), STREAM_TIMING_INTERVAL_MS);
    }

    async function startHls() {
      const hlsUrl = sources?.hlsUrl;
      if (cancelled || !hlsUrl) {
        if (!cancelled) failHls();
        return;
      }
      updatePlaybackEvidenceState({
        transport: "hls",
        sessionId: createPlaybackSessionId("hls"),
        connectionState: "connecting",
        frame: null,
        paused: video.paused,
        stalled: false,
        reconnecting: hlsFailures > 0
      });
      setStatus("Connecting stream...");
      try {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          const onVideoError = () => {
            video.removeEventListener("error", onVideoError);
            failHls();
          };
          video.addEventListener("error", onVideoError);
          video.src = hlsUrl;
          void video.play().catch(() => setStatus("Tap play to start the stream."));
          return;
        }
        const mod = await import("hls.js");
        const Hls = mod.default;
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setStatus("Stream video is not available in this browser.");
          setError("Stream video is not available in this browser.");
          return;
        }
        const instance = new Hls({ lowLatencyMode: true }) as unknown as HlsInstance;
        hls = instance;
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || hls !== instance) return;
          if (data.fatal) failHls();
        });
        instance.loadSource(hlsUrl);
        instance.attachMedia(video);
        void video.play().catch(() => setStatus("Tap play to start the stream."));
      } catch {
        if (!cancelled) failHls();
      }
    }

    async function start() {
      if (sources?.whepUrl) {
        await startWhep();
        return;
      }
      if (playbackModeAllowsHls(mode) && sources?.hlsUrl) {
        await startHls();
        return;
      }
      updatePlaybackEvidenceState(initialPlaybackEvidenceState());
      setStatus("Live stream is not available yet.");
      setError("Live stream is not available yet.");
    }

    void start();

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("emptied", onEmptied);
      teardownPlayback();
    };
  }, [enabled, loadRevision, mode, onConnectionHealth, onReconnect, onTimingSample, sources, updatePlaybackEvidenceState]);

  if (!enabled) return null;

  const scoringStatusVisible = mode === "scoring" && !status.startsWith("Live");

  return (
    <section className={`stream-preview ${mode === "scoring" ? "scoring-stream-preview" : ""}`}>
      <video ref={videoRef} playsInline muted={muted} controls={!chromeless && mode !== "scoring"} />
      {!chromeless && mode !== "scoring" && (
        <div className="video-controls">
          <span>{error ? "Stream unavailable" : status}</span>
          <button type="button" onClick={() => setMuted((current) => !current)}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />} {muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" onClick={() => videoRef.current?.play()}>
            <Play size={16} /> Play
          </button>
          <button type="button" onClick={() => void loadSources()}>
            <RefreshCw size={16} /> Reload
          </button>
        </div>
      )}
      {!chromeless && mode === "scoring" && (
        <div className="video-controls scoring-video-controls">
          {scoringStatusVisible && <span role="status">{error ? "Video unavailable" : status}</span>}
          <button type="button" onClick={() => setMuted((current) => !current)} aria-label={muted ? "Unmute court video" : "Mute court video"}>
            {muted ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
            <span>{muted ? "Unmute" : "Mute"}</span>
          </button>
          <button type="button" onClick={() => videoRef.current?.play()} aria-label="Play court video">
            <Play size={17} aria-hidden="true" /><span>Play</span>
          </button>
          <button type="button" onClick={() => setLoadRevision((current) => current + 1)} aria-label="Reconnect court video">
            <RefreshCw size={17} aria-hidden="true" /><span>Reconnect</span>
          </button>
        </div>
      )}
      {!chromeless && mode !== "scoring" && error && (
        <div className="video-fallback">
          <VideoOff size={18} />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
});

function extractTimingSample(
  reports: RTCStatsReport,
  previous: RtcJitterTotals | null
): { sample: StreamTimingSample; totals: RtcJitterTotals | null; health: Omit<StreamConnectionHealth, "transport" | "connectionState"> } {
  let totals: RtcJitterTotals | null = null;
  let rttMs: number | null = null;
  let networkPath: StreamConnectionHealth["networkPath"] = "unknown";
  let jitterMs: number | null = null;
  let framesPerSecond: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let packetsLost: number | null = null;
  let packetsReceived: number | null = null;
  let framesReceived: number | null = null;
  let framesDecoded: number | null = null;
  let keyFramesDecoded: number | null = null;
  let framesDropped: number | null = null;
  let bytesReceived: number | null = null;
  let freezeCount: number | null = null;
  let totalFreezesDurationMs: number | null = null;
  let lastPacketAgeMs: number | null = null;
  let nackCount: number | null = null;
  let pliCount: number | null = null;
  let firCount: number | null = null;

  reports.forEach((report) => {
    const row = report as RTCStats & Record<string, unknown>;
    if (row.type === "inbound-rtp" && (row.kind === "video" || row.mediaType === "video")) {
      framesPerSecond = finiteNumber(row.framesPerSecond);
      const jitterSeconds = finiteNumber(row.jitter);
      jitterMs = jitterSeconds == null ? null : jitterSeconds * 1000;
      width = finiteInteger(row.frameWidth);
      height = finiteInteger(row.frameHeight);
      packetsLost = finiteInteger(row.packetsLost);
      packetsReceived = finiteInteger(row.packetsReceived);
      framesReceived = finiteInteger(row.framesReceived);
      framesDecoded = finiteInteger(row.framesDecoded);
      keyFramesDecoded = finiteInteger(row.keyFramesDecoded);
      framesDropped = finiteInteger(row.framesDropped);
      bytesReceived = finiteInteger(row.bytesReceived);
      freezeCount = finiteInteger(row.freezeCount);
      const totalFreezesDuration = finiteNumber(row.totalFreezesDuration);
      totalFreezesDurationMs = totalFreezesDuration == null ? null : totalFreezesDuration * 1000;
      lastPacketAgeMs = packetAgeMs(row.lastPacketReceivedTimestamp);
      nackCount = finiteInteger(row.nackCount);
      pliCount = finiteInteger(row.pliCount);
      firCount = finiteInteger(row.firCount);
      const emittedCount = finiteNumber(row.jitterBufferEmittedCount);
      const jitterBufferDelaySeconds = finiteNumber(row.jitterBufferDelay);
      if (emittedCount != null && jitterBufferDelaySeconds != null) {
        totals = {
          emittedCount,
          jitterBufferDelaySeconds,
          jitterBufferTargetDelaySeconds: finiteNumber(row.jitterBufferTargetDelay)
        };
      }
    }
    if (row.type === "candidate-pair"
      && row.state === "succeeded"
      && (row.nominated === true || row.selected === true)) {
      const candidateRtt = finiteNumber(row.currentRoundTripTime);
      if (candidateRtt != null) rttMs = Math.min(rttMs ?? Number.POSITIVE_INFINITY, candidateRtt * 1000);
      const remote = typeof row.remoteCandidateId === "string" ? reports.get(row.remoteCandidateId) as (RTCStats & Record<string, unknown>) | undefined : undefined;
      networkPath = classifyRtcNetworkPath(remote?.address ?? remote?.ip);
    }
  });

  const jitter = totals
    ? intervalJitterSample(previous, totals)
    : { jitterBufferMs: null, jitterBufferTargetMs: null };
  return {
    sample: {
      version: 1,
      sampledAtMonotonicMs: monotonicEpochMs(),
      jitterBufferMs: jitter.jitterBufferMs,
      jitterBufferTargetMs: jitter.jitterBufferTargetMs,
      rttMs
    },
    totals,
    health: {
      networkPath,
      framesPerSecond,
      width,
      height,
      rttMs,
      jitterMs,
      jitterBufferMs: jitter.jitterBufferTargetMs ?? jitter.jitterBufferMs,
      packetsLost,
      packetsReceived,
      framesReceived,
      framesDecoded,
      keyFramesDecoded,
      framesDropped,
      bytesReceived,
      freezeCount,
      totalFreezesDurationMs,
      lastPacketAgeMs,
      nackCount,
      pliCount,
      firCount
    }
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number == null ? null : Math.trunc(number);
}

function emptyConnectionHealth(): StreamConnectionHealth {
  return {
    transport: "none",
    connectionState: "unknown",
    networkPath: "unknown",
    framesPerSecond: null,
    width: null,
    height: null,
    rttMs: null,
    jitterMs: null,
    jitterBufferMs: null,
    packetsLost: null,
    packetsReceived: null,
    framesReceived: null,
    framesDecoded: null,
    keyFramesDecoded: null,
    framesDropped: null,
    bytesReceived: null,
    freezeCount: null,
    totalFreezesDurationMs: null,
    lastPacketAgeMs: null,
    nackCount: null,
    pliCount: null,
    firCount: null
  };
}

function packetAgeMs(value: unknown): number | null {
  const timestamp = finiteNumber(value);
  if (timestamp == null) return null;
  const age = timestamp > 1_000_000_000_000
    ? Date.now() - timestamp
    : globalThis.performance.now() - timestamp;
  return Number.isFinite(age) ? Math.max(0, age) : null;
}

function normalizeConnectionState(value: RTCPeerConnectionState): StreamConnectionHealth["connectionState"] {
  return ["new", "connecting", "connected", "disconnected", "failed", "closed"].includes(value)
    ? value as StreamConnectionHealth["connectionState"]
    : "unknown";
}

function whepResourceUrl(location: string | null, requestUrl: string): string | null {
  if (!location) return null;
  try {
    const pageUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
    return new URL(location, new URL(requestUrl, pageUrl)).toString();
  } catch {
    return null;
  }
}

function releaseWhepSession(url: string) {
  void fetch(url, { method: "DELETE", keepalive: true }).catch(() => {
    // Best effort. Closing the peer connection remains the primary teardown.
  });
}

let playbackSessionSequence = 0;

function createPlaybackSessionId(transport: Exclude<PlaybackTransport, "none">): string {
  playbackSessionSequence += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId
    ? `${transport}-${randomId}`
    : `${transport}-${Date.now().toString(36)}-${playbackSessionSequence.toString(36)}`;
}

function waitForIceGathering(connection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, timeoutMs);
    function finish() {
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (connection.iceGatheringState === "complete") finish();
    }
    connection.addEventListener("icegatheringstatechange", onChange);
  });
}

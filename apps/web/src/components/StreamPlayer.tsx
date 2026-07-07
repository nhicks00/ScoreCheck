"use client";

import { Play, RefreshCw, VideoOff, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type StreamPlayerProps = {
  courtNumber: number;
  /** Scorer-session auth. When omitted the player uses the admin stream-source route. */
  sessionToken?: string;
  enabled?: boolean;
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

export function StreamPlayer({ courtNumber, sessionToken, enabled = true }: StreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sources, setSources] = useState<StreamSources | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [status, setStatus] = useState("Loading stream...");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);

  const loadSources = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    setStatus("Loading stream...");
    const res = sessionToken
      ? await fetch("/api/video/stream-source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken, courtNumber })
      })
      : await fetch(`/api/admin/video/stream-source?courtNumber=${courtNumber}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSources(null);
      setStatus("Stream video is not available yet.");
      setError(json.error ?? "Stream video is not available yet.");
      return;
    }
    setSources({ whepUrl: json.whepUrl ?? null, hlsUrl: json.hlsUrl ?? null });
    setLoadRevision((current) => current + 1);
  }, [courtNumber, enabled, sessionToken]);

  useEffect(() => {
    if (!enabled) {
      setSources(null);
      return;
    }
    void loadSources();
  }, [enabled, loadSources]);

  useEffect(() => {
    if (!enabled || !sources || !videoRef.current) return;
    if (!sources.whepUrl && !sources.hlsUrl) {
      setStatus("Stream video is not available yet.");
      setError("Stream video is not available yet.");
      return;
    }
    const video = videoRef.current;
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let hls: HlsInstance | null = null;
    let retryTimer: number | null = null;
    let whepFailures = 0;
    let hlsFailures = 0;

    const onPlaying = () => {
      if (cancelled) return;
      setError(null);
      setStatus(pc ? "Live — low latency" : "Live — HLS");
    };
    video.addEventListener("playing", onPlaying);

    function teardownPlayback() {
      pc?.close();
      pc = null;
      hls?.destroy();
      hls = null;
      video.srcObject = null;
      video.removeAttribute("src");
    }

    function scheduleRetry(fn: () => void, attempt: number) {
      const delay = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
      retryTimer = window.setTimeout(fn, delay);
    }

    function failWhep(offline: boolean) {
      if (cancelled) return;
      teardownPlayback();
      whepFailures += 1;
      setStatus(offline ? OFFLINE_MESSAGE : "Reconnecting stream...");
      if (whepFailures >= WHEP_FAILURES_BEFORE_HLS && sources?.hlsUrl) {
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
      setStatus(OFFLINE_MESSAGE);
      scheduleRetry(() => void start(), hlsFailures);
    }

    async function startWhep() {
      const whepUrl = sources?.whepUrl;
      if (cancelled || !whepUrl) return;
      setStatus("Connecting stream...");
      try {
        const connection = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });
        pc = connection;
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
          }
          if (["failed", "disconnected", "closed"].includes(connection.connectionState)) {
            failWhep(false);
          }
        };
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        await waitForIceGathering(connection, 2000);
        if (cancelled || pc !== connection) return;
        const res = await fetch(whepUrl, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: connection.localDescription?.sdp ?? offer.sdp ?? ""
        });
        if (cancelled || pc !== connection) return;
        if (res.status === 404) {
          failWhep(true);
          return;
        }
        if (res.status !== 201 && !res.ok) {
          failWhep(false);
          return;
        }
        const answer = await res.text();
        if (cancelled || pc !== connection) return;
        await connection.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        if (!cancelled) failWhep(false);
      }
    }

    async function startHls() {
      const hlsUrl = sources?.hlsUrl;
      if (cancelled || !hlsUrl) {
        if (!cancelled) failHls();
        return;
      }
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
      await startHls();
    }

    void start();

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      video.removeEventListener("playing", onPlaying);
      teardownPlayback();
    };
  }, [enabled, loadRevision, sources]);

  if (!enabled) return null;

  return (
    <section className="stream-preview">
      <video ref={videoRef} playsInline muted={muted} controls />
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
      {error && (
        <div className="video-fallback">
          <VideoOff size={18} />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
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

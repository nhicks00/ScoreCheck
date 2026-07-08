"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayClient } from "@/app/overlay/court/[courtNumber]/OverlayClient";
import { StreamPlayer } from "@/components/StreamPlayer";
import {
  buildProgramHeartbeat,
  initialProgramWatchdog,
  PROGRAM_COMMENTARY_WAIT_MS,
  PROGRAM_HEARTBEAT_INTERVAL_MS,
  PROGRAM_STAGE_HEIGHT,
  PROGRAM_STAGE_WIDTH,
  PROGRAM_WATCHDOG_TICK_MS,
  programWatchdogStep
} from "@/lib/programWatchdog";

/**
 * The compositor scene (docs/PRODUCTION_PLATFORM_PLAN.md §3.1): court video,
 * the exact broadcast scorebug, and hidden commentary audio on a fixed
 * 1280x720 logical stage scaled to the viewport. A headless-Chrome LiveKit
 * egress captures this page, waiting for the START_RECORDING console signal.
 */

type ProgramClientProps = {
  courtNumber: number;
  /** The validated ?token= value, echoed into heartbeats (never the env value itself). */
  token: string;
  sources: { whepUrl: string | null; hlsUrl: string | null };
  /** Audio-only VDO.Ninja scene link; null when commentary is disabled (?scene=0). */
  commentaryUrl: string | null;
  debug: boolean;
  buildVersion: string;
};

/** Retry delays for a commentary iframe that never fires load. */
const COMMENTARY_RETRY_BASE_MS = 10_000;
const COMMENTARY_RETRY_MAX_MS = 60_000;

export function ProgramClient({ courtNumber, token, sources, commentaryUrl, debug, buildVersion }: ProgramClientProps) {
  const hasSources = Boolean(sources.whepUrl || sources.hlsUrl);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const watchdogRef = useRef(initialProgramWatchdog(0));
  const startLoggedRef = useRef(false);
  const endLoggedRef = useRef(false);
  const audioBlockedRef = useRef(false);
  const framesRef = useRef(0);
  const videoStateRef = useRef("waiting");
  const commentaryLoadedRef = useRef(false);

  const [playerEpoch, setPlayerEpoch] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);
  const [framesFlowing, setFramesFlowing] = useState(false);
  const [videoState, setVideoStateState] = useState("waiting");
  const [debugFrames, setDebugFrames] = useState(0);
  const [commentaryLoaded, setCommentaryLoadedState] = useState(false);
  const [commentaryWaitExpired, setCommentaryWaitExpired] = useState(false);
  const [commentaryEpoch, setCommentaryEpoch] = useState(0);
  const [heartbeatState, setHeartbeatState] = useState<"waiting" | "ok" | "error">("waiting");

  const setVideoState = useCallback((next: string) => {
    videoStateRef.current = next;
    setVideoStateState(next);
  }, []);

  const setCommentaryLoaded = useCallback((next: boolean) => {
    commentaryLoadedRef.current = next;
    setCommentaryLoadedState(next);
  }, []);

  const logEndOnce = useCallback(() => {
    if (endLoggedRef.current) return;
    endLoggedRef.current = true;
    console.log("END_RECORDING");
  }, []);

  /* Stage scaling: author at 1280x720, scale to whatever viewport the egress
     (or a human previewing) opens — 720p and 1080p both land pixel-exact. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const scale = Math.min(
        window.innerWidth / PROGRAM_STAGE_WIDTH,
        window.innerHeight / PROGRAM_STAGE_HEIGHT
      );
      root.style.setProperty("--program-scale", scale.toFixed(5));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  /* Fatal, unrecoverable state: the court has no playback sources at all, so
     video can never start. Signal the egress rather than pretending. */
  useEffect(() => {
    if (hasSources) return;
    setVideoState("fatal");
    logEndOnce();
  }, [hasSources, setVideoState, logEndOnce]);

  /* Reload diagnostics survive location.reload() via sessionStorage. */
  useEffect(() => {
    setReloadCount(readReloadCount(courtNumber));
  }, [courtNumber]);

  /* A human previewing the page can click to lift an autoplay-policy mute;
     egress Chrome never blocks autoplay, so this is a no-op there. */
  useEffect(() => {
    const onPointerDown = () => {
      audioBlockedRef.current = false;
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  /* Watchdog: sample decoded frames + currentTime every second. Stalls over
     5s remount the player (StreamPlayer reconnects on mount); three fruitless
     remounts escalate to a full reload. Frame progress resets the ladder. */
  useEffect(() => {
    if (!hasSources) return;
    const id = window.setInterval(() => {
      const video = videoWrapRef.current?.querySelector("video");
      if (video) ensureProgramPlayback(video, audioBlockedRef);
      const frames = video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      framesRef.current = frames;
      if (debug) setDebugFrames(frames);
      const progress = video ? frames + video.currentTime : 0;

      const step = programWatchdogStep(watchdogRef.current, {
        nowMs: Date.now(),
        hasSources,
        progress
      });
      watchdogRef.current = step.state;

      if (step.progressed) {
        setFramesFlowing(true);
        clearReloadCount(courtNumber);
        setVideoState("playing");
      } else if (step.action === "reconnect") {
        setVideoState("reconnecting");
        setReconnects((current) => current + 1);
        setPlayerEpoch((current) => current + 1);
      } else if (step.action === "reload") {
        setVideoState("reloading");
        bumpReloadCount(courtNumber);
        window.location.reload();
      } else if (videoStateRef.current === "playing") {
        setVideoState("stalled");
      }
    }, PROGRAM_WATCHDOG_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasSources, courtNumber, debug, setVideoState]);

  /* START signal: first frames flowing AND commentary settled (loaded,
     disabled, or waited out). The egress starts capturing on this line. */
  const commentaryReady = !commentaryUrl || commentaryLoaded || commentaryWaitExpired;
  useEffect(() => {
    if (!framesFlowing || !commentaryReady) return;
    if (startLoggedRef.current || endLoggedRef.current) return;
    startLoggedRef.current = true;
    console.log("START_RECORDING");
  }, [framesFlowing, commentaryReady]);

  /* Never hold START hostage to VDO.Ninja: give the iframe 10s, then proceed. */
  useEffect(() => {
    if (!commentaryUrl) return;
    const id = window.setTimeout(() => setCommentaryWaitExpired(true), PROGRAM_COMMENTARY_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [commentaryUrl]);

  /* Commentary iframe self-heal: if load never fires, remount with backoff. */
  useEffect(() => {
    if (!commentaryUrl || commentaryLoaded) return;
    const delay = Math.min(COMMENTARY_RETRY_MAX_MS, COMMENTARY_RETRY_BASE_MS * 2 ** commentaryEpoch);
    const id = window.setTimeout(() => setCommentaryEpoch((current) => current + 1), delay);
    return () => window.clearTimeout(id);
  }, [commentaryUrl, commentaryLoaded, commentaryEpoch]);

  /* Heartbeat: 5s health upsert so the console alarms on page semantics, not
     just "Chrome is running". Failures are swallowed — the heartbeat must
     never destabilize the broadcast page. */
  useEffect(() => {
    let cancelled = false;
    async function beat() {
      try {
        const res = await fetch("/api/program/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            buildProgramHeartbeat({
              token,
              courtNumber,
              videoState: videoStateRef.current,
              framesRendered: framesRef.current,
              commentaryLoaded: commentaryLoadedRef.current,
              pageVersion: buildVersion
            })
          )
        });
        if (!cancelled) setHeartbeatState(res.ok ? "ok" : "error");
      } catch {
        if (!cancelled) setHeartbeatState("error");
      }
    }
    void beat();
    const id = window.setInterval(() => void beat(), PROGRAM_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token, courtNumber, buildVersion]);

  return (
    <div ref={rootRef} className="program-root">
      <div className="program-stage">
        <div ref={videoWrapRef} className="program-video">
          <StreamPlayer key={playerEpoch} courtNumber={courtNumber} sources={sources} chromeless />
        </div>
        <div className="program-overlay">
          <OverlayClient
            courtNumber={String(courtNumber)}
            eventId=""
            theme="default"
            buildVersion={buildVersion}
          />
        </div>
        {commentaryUrl && (
          <iframe
            key={commentaryEpoch}
            className="program-commentary-frame"
            src={commentaryUrl}
            allow="autoplay"
            title={`Commentary audio for court ${courtNumber}`}
            onLoad={() => setCommentaryLoaded(true)}
          />
        )}
      </div>
      {debug && (
        <div className="program-debug">
          <span>court {courtNumber}</span>
          <span>video <strong>{videoState}</strong></span>
          <span>frames <strong>{debugFrames}</strong></span>
          <span>reconnects <strong>{reconnects}</strong></span>
          <span>reloads <strong>{reloadCount}</strong></span>
          <span>commentary <strong>{commentaryUrl ? (commentaryLoaded ? "loaded" : "loading") : "off"}</strong></span>
          <span>heartbeat <strong>{heartbeatState}</strong></span>
        </div>
      )}
    </div>
  );
}

/**
 * Keeps the captured feed unmuted and running. If the browser's autoplay
 * policy rejects unmuted playback (human preview without a gesture), fall
 * back to muted playback so the watchdog sees frames instead of a fake stall;
 * egress Chrome allows autoplay, so the fallback never engages there.
 */
function ensureProgramPlayback(video: HTMLVideoElement, audioBlockedRef: { current: boolean }) {
  if (!audioBlockedRef.current && (video.muted || video.volume !== 1)) {
    video.muted = false;
    video.volume = 1;
  }
  if (video.paused && (video.srcObject || video.currentSrc)) {
    void video.play().catch((error: unknown) => {
      // Only a NotAllowedError means the autoplay policy blocked unmuted
      // playback. Anything else (AbortError from reconnect teardown races,
      // NotSupportedError from a dead source) must NOT trip the muted
      // fallback, or a transient glitch would silence the broadcast forever.
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError") return;
      audioBlockedRef.current = true;
      video.muted = true;
      void video.play().catch(() => {
        // Still blocked; the watchdog will keep retrying next tick.
      });
    });
  }
}

function reloadCountKey(courtNumber: number): string {
  return `program-reload-count:${courtNumber}`;
}

function readReloadCount(courtNumber: number): number {
  try {
    const raw = window.sessionStorage.getItem(reloadCountKey(courtNumber));
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function bumpReloadCount(courtNumber: number) {
  try {
    window.sessionStorage.setItem(reloadCountKey(courtNumber), String(readReloadCount(courtNumber) + 1));
  } catch {
    // Storage unavailable: the reload still happens, we just lose the tally.
  }
}

function clearReloadCount(courtNumber: number) {
  try {
    window.sessionStorage.removeItem(reloadCountKey(courtNumber));
  } catch {
    // Ignore: diagnostics only.
  }
}

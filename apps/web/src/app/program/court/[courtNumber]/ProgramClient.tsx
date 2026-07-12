"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayClient } from "@/app/overlay/court/[courtNumber]/OverlayClient";
import { StreamPlayer } from "@/components/StreamPlayer";
import type { CommentaryConnection } from "@/lib/commentary";
import type { StreamTimingSample } from "@/lib/rtcTiming";
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
import {
  EMPTY_PROGRAM_AUDIO_HEALTH,
  ProgramAudioMixer,
  type ProgramAudioHealth
} from "./ProgramAudioMixer";

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
  commentary: CommentaryConnection | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
  debug: boolean;
  buildVersion: string;
};

const PROGRAM_STABLE_FRAME_TICKS = 3;

export function ProgramClient({
  courtNumber,
  token,
  sources,
  commentary,
  cameraGainDb,
  commentaryGainDb,
  commentaryDelayMs,
  debug,
  buildVersion
}: ProgramClientProps) {
  const hasSources = Boolean(sources.whepUrl);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const watchdogRef = useRef(initialProgramWatchdog(0));
  const startLoggedRef = useRef(false);
  const endLoggedRef = useRef(false);
  const audioBlockedRef = useRef(false);
  const framesRef = useRef(0);
  const presentedFramesRef = useRef(0);
  const stableFrameTicksRef = useRef(0);
  const videoStateRef = useRef("waiting");
  const audioHealthRef = useRef<ProgramAudioHealth>(EMPTY_PROGRAM_AUDIO_HEALTH);
  const programTimingRef = useRef<StreamTimingSample | null>(null);

  const [playerEpoch, setPlayerEpoch] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);
  const [framesFlowing, setFramesFlowing] = useState(false);
  const [videoState, setVideoStateState] = useState("waiting");
  const [debugFrames, setDebugFrames] = useState(0);
  const [cameraElement, setCameraElement] = useState<HTMLVideoElement | null>(null);
  const [audioHealth, setAudioHealth] = useState<ProgramAudioHealth>(EMPTY_PROGRAM_AUDIO_HEALTH);
  const [commentaryWaitExpired, setCommentaryWaitExpired] = useState(false);
  const [heartbeatState, setHeartbeatState] = useState<"waiting" | "ok" | "error">("waiting");

  const setVideoState = useCallback((next: string) => {
    videoStateRef.current = next;
    setVideoStateState(next);
  }, []);

  const updateAudioHealth = useCallback((next: ProgramAudioHealth) => {
    audioHealthRef.current = next;
    setAudioHealth(next);
  }, []);
  const updateProgramTiming = useCallback((sample: StreamTimingSample | null) => {
    programTimingRef.current = sample;
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

  /* requestVideoFrameCallback advances only when a frame is actually presented.
     currentTime and decoded-frame counters can advance through some frozen or
     repeated-frame failures, so the watchdog uses this compositor-grade clock. */
  useEffect(() => {
    if (!cameraElement) return;
    let cancelled = false;
    let callbackId = 0;
    const sample = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (cancelled) return;
      presentedFramesRef.current = metadata.presentedFrames;
      callbackId = cameraElement.requestVideoFrameCallback(sample);
    };
    callbackId = cameraElement.requestVideoFrameCallback(sample);
    return () => {
      cancelled = true;
      cameraElement.cancelVideoFrameCallback(callbackId);
      presentedFramesRef.current = 0;
    };
  }, [cameraElement]);

  /* Watchdog: sample decoded frames + currentTime every second. Stalls over
     5s remount the player (StreamPlayer reconnects on mount); three fruitless
     remounts escalate to a full reload. Frame progress resets the ladder. */
  useEffect(() => {
    if (!hasSources) return;
    const id = window.setInterval(() => {
      const video = videoWrapRef.current?.querySelector("video");
      if (video) ensureProgramPlayback(video, audioBlockedRef);
      const frames = presentedFramesRef.current;
      framesRef.current = frames;
      if (debug) setDebugFrames(frames);
      const progress = frames;

      const step = programWatchdogStep(watchdogRef.current, {
        nowMs: Date.now(),
        hasSources,
        progress
      });
      watchdogRef.current = step.state;

      if (step.progressed) {
        clearReloadCount(courtNumber);
        stableFrameTicksRef.current += 1;
        if (stableFrameTicksRef.current >= PROGRAM_STABLE_FRAME_TICKS) {
          setFramesFlowing(true);
          setVideoState("playing");
        } else {
          setVideoState("stabilizing");
        }
      } else if (step.action === "reconnect") {
        stableFrameTicksRef.current = 0;
        setFramesFlowing(false);
        setVideoState("reconnecting");
        setReconnects((current) => current + 1);
        setPlayerEpoch((current) => current + 1);
      } else if (step.action === "reload") {
        stableFrameTicksRef.current = 0;
        setFramesFlowing(false);
        setVideoState("reloading");
        bumpReloadCount(courtNumber);
        window.location.reload();
      } else if (videoStateRef.current === "playing") {
        stableFrameTicksRef.current = 0;
        setFramesFlowing(false);
        setVideoState("stalled");
      }
    }, PROGRAM_WATCHDOG_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasSources, courtNumber, debug, setVideoState]);

  /* START signal: first stable frames plus a connected audio room. An empty
     room is ready; absence of an audio track is health data, not a start gate. */
  const commentaryReady = !commentary || audioHealth.roomConnected || commentaryWaitExpired;
  useEffect(() => {
    if (!framesFlowing || !commentaryReady) return;
    if (startLoggedRef.current || endLoggedRef.current) return;
    startLoggedRef.current = true;
    console.log("START_RECORDING");
  }, [framesFlowing, commentaryReady]);

  /* Never hold START hostage to the commentary server: proceed after 10s and
     keep reconnecting while the broadcast remains alive. */
  useEffect(() => {
    if (!commentary) return;
    const id = window.setTimeout(() => setCommentaryWaitExpired(true), PROGRAM_COMMENTARY_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [commentary]);

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
              commentaryRoomConnected: audioHealthRef.current.roomConnected,
              commentaryParticipantCount: audioHealthRef.current.participantCount,
              commentaryAudioTrackCount: audioHealthRef.current.audioTrackCount,
              commentaryRmsDb: audioHealthRef.current.commentaryRmsDb,
              commentaryPeakDb: audioHealthRef.current.commentaryPeakDb,
              secondsSinceCommentaryAudio: audioHealthRef.current.secondsSinceCommentaryAudio,
              cameraAudioRmsDb: audioHealthRef.current.cameraRmsDb,
              commentarySyncStatus: audioHealthRef.current.commentarySyncStatus,
              commentaryDelayConfiguredMs: audioHealthRef.current.commentaryDelayConfiguredMs,
              commentaryDelayTargetMs: audioHealthRef.current.commentaryDelayTargetMs,
              commentaryDelayAppliedMs: audioHealthRef.current.commentaryDelayAppliedMs,
              commentarySyncRttMs: audioHealthRef.current.commentarySyncRttMs,
              commentarySyncSampleAgeMs: audioHealthRef.current.commentarySyncSampleAgeMs,
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
          <StreamPlayer
            key={playerEpoch}
            courtNumber={courtNumber}
            sources={sources}
            chromeless
            mode="program"
            onVideoElement={setCameraElement}
            onTimingSample={updateProgramTiming}
          />
        </div>
        {videoState !== "playing" && (
          <div className="program-signal-slate" role="status">
            <span>ScoreCheck</span>
            <strong>Court video signal interrupted</strong>
            <small>Stay tuned</small>
          </div>
        )}
        <div className="program-overlay">
          <OverlayClient
            courtNumber={String(courtNumber)}
            eventId=""
            theme="default"
            buildVersion={buildVersion}
          />
        </div>
        <ProgramAudioMixer
          courtNumber={courtNumber}
          cameraElement={cameraElement}
          programTimingRef={programTimingRef}
          commentary={commentary}
          cameraGainDb={cameraGainDb}
          commentaryGainDb={commentaryGainDb}
          commentaryDelayMs={commentaryDelayMs}
          onHealth={updateAudioHealth}
        />
      </div>
      {debug && (
        <div className="program-debug">
          <span>court {courtNumber}</span>
          <span>video <strong>{videoState}</strong></span>
          <span>frames <strong>{debugFrames}</strong></span>
          <span>reconnects <strong>{reconnects}</strong></span>
          <span>reloads <strong>{reloadCount}</strong></span>
          <span>commentary <strong>{commentary ? (audioHealth.roomConnected ? `${audioHealth.audioTrackCount} track(s)` : "connecting") : "off"}</strong></span>
          <span>commentary rms <strong>{formatDb(audioHealth.commentaryRmsDb)}</strong></span>
          <span>camera rms <strong>{formatDb(audioHealth.cameraRmsDb)}</strong></span>
          <span>sync <strong>{audioHealth.commentarySyncStatus}</strong></span>
          <span>delay <strong>{formatMs(audioHealth.commentaryDelayAppliedMs)}</strong></span>
          <span>heartbeat <strong>{heartbeatState}</strong></span>
        </div>
      )}
    </div>
  );
}

function formatDb(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)} dB`;
}

function formatMs(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value)} ms`;
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

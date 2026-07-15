"use client";

import {
  Maximize2,
  Radio,
  Video,
  VideoOff
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CommunityScoreOverlay, type CommunityScoreOverlayRecovery } from "./CommunityScoreOverlay";
import { CommunityWitnessScorer, type CommunityWitnessScorerProps } from "./CommunityWitnessScorer";
import {
  COMMUNITY_SCORE_CONTROLS_POSITION_KEY,
  DEFAULT_COMMUNITY_SCORE_CONTROLS_POSITION,
  oppositeCommunityScoreControlsPosition,
  parseCommunityScoreControlsPosition,
  type CommunityScoreControlsPosition
} from "./communityScoreOverlayPreference";
import {
  COMMUNITY_WATCH_PREFERENCE_KEY,
  storedVideoPreference
} from "./communityWatchMode";
import styles from "./CommunityWatchAndScore.module.css";

type CommunityWatchAndScoreProps = CommunityWitnessScorerProps & {
  media: ReactNode | null;
  videoGuidance: string;
  videoRequiredForScoring: boolean;
  focusRecovery?: CommunityScoreOverlayRecovery | null;
};

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

export function CommunityWatchAndScore(props: CommunityWatchAndScoreProps) {
  const mediaAvailable = props.media != null;
  const [preferenceReady, setPreferenceReady] = useState(false);
  const [videoVisible, setVideoVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [controlsPosition, setControlsPosition] = useState<CommunityScoreControlsPosition>(
    DEFAULT_COMMUNITY_SCORE_CONTROLS_POSITION
  );
  const [modeAnnouncement, setModeAnnouncement] = useState("");
  const [positionAnnouncement, setPositionAnnouncement] = useState("");
  const shellRef = useRef<HTMLDivElement | null>(null);
  const enterButtonRef = useRef<HTMLButtonElement | null>(null);
  const exitButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const nativeFullscreenRef = useRef(false);
  const restoreFocusAfterExitRef = useRef(false);

  useEffect(() => {
    const visible = props.videoRequiredForScoring
      ? mediaAvailable
      : storedVideoPreference(readStorage(COMMUNITY_WATCH_PREFERENCE_KEY), mediaAvailable);
    setVideoVisible(visible);
    setControlsPosition(parseCommunityScoreControlsPosition(readStorage(COMMUNITY_SCORE_CONTROLS_POSITION_KEY)));
    setPreferenceReady(true);
  }, [mediaAvailable, props.videoRequiredForScoring]);

  useEffect(() => {
    if (mediaAvailable) return;
    setFocusMode(false);
    setNativeFullscreen(false);
    nativeFullscreenRef.current = false;
  }, [mediaAvailable]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = fullscreenElement() === shellRef.current;
      setNativeFullscreen(active);
      if (active) nativeFullscreenRef.current = true;
      if (!active && nativeFullscreenRef.current) {
        nativeFullscreenRef.current = false;
        restoreFocusAfterExitRef.current = true;
        setFocusMode(false);
        setModeAnnouncement("Full screen scoring closed.");
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!focusMode) return;
    const previousOverflow = document.body.style.overflow;
    const shell = shellRef.current;
    const outsideState = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
    const observers: MutationObserver[] = [];
    const makeInert = (element: Element) => {
      if (!(element instanceof HTMLElement) || outsideState.has(element)) return;
      outsideState.set(element, { inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") });
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    };
    document.body.style.overflow = "hidden";
    let allowedElement: HTMLElement | null = shell;
    while (allowedElement?.parentElement) {
      const parent = allowedElement.parentElement;
      const allowedAtLevel = allowedElement;
      for (const child of parent.children) {
        if (child !== allowedAtLevel) makeInert(child);
      }
      const observer = new MutationObserver(() => {
        for (const child of parent.children) {
          if (child !== allowedAtLevel) makeInert(child);
        }
      });
      observer.observe(parent, { childList: true });
      observers.push(observer);
      if (parent === document.body) break;
      allowedElement = parent;
    }
    window.setTimeout(() => exitButtonRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const observer of observers) observer.disconnect();
      for (const [element, state] of outsideState) {
        element.inert = state.inert;
        if (state.ariaHidden == null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", state.ariaHidden);
      }
    };
  }, [focusMode]);

  useEffect(() => {
    if (focusMode || !restoreFocusAfterExitRef.current) return;
    restoreFocusAfterExitRef.current = false;
    window.setTimeout(() => {
      const fallback = returnFocusRef.current?.isConnected ? returnFocusRef.current : null;
      (enterButtonRef.current ?? fallback)?.focus();
    }, 0);
  }, [focusMode]);

  function setWatching(next: boolean) {
    if (!mediaAvailable) return;
    if (!next && props.videoRequiredForScoring) return;
    setVideoVisible(next);
    writeStorage(COMMUNITY_WATCH_PREFERENCE_KEY, next ? "watch" : "score-only");
    setModeAnnouncement(next ? "Broadcast video shown." : "Score-only view shown. Video playback stopped.");
    if (!next && focusMode) void exitFocusMode();
  }

  async function enterFocusMode() {
    if (!mediaAvailable || !shellRef.current) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setVideoVisible(true);
    writeStorage(COMMUNITY_WATCH_PREFERENCE_KEY, "watch");
    setFocusMode(true);
    setModeAnnouncement("Focus view active. The broadcast and score controls share the full screen.");

    const target = shellRef.current as WebkitFullscreenElement;
    try {
      nativeFullscreenRef.current = true;
      if (target.requestFullscreen) {
        await target.requestFullscreen({ navigationUI: "hide" });
      } else if (target.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      } else {
        nativeFullscreenRef.current = false;
        setNativeFullscreen(false);
        setModeAnnouncement("Focus view active in the full-window fallback because browser full screen is unavailable.");
        return;
      }
      nativeFullscreenRef.current = true;
      setNativeFullscreen(true);
    } catch {
      nativeFullscreenRef.current = false;
      setNativeFullscreen(false);
      setModeAnnouncement("Focus view active. Browser full screen is unavailable, so scoring remains in the full-window fallback.");
    }
  }

  async function exitFocusMode() {
    nativeFullscreenRef.current = false;
    restoreFocusAfterExitRef.current = true;
    const doc = document as WebkitFullscreenDocument;
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
    } catch {
      // The CSS focus fallback still exits even if the browser rejects its API.
    }
    setNativeFullscreen(false);
    setFocusMode(false);
    setModeAnnouncement("Focus view closed.");
  }

  function moveScoreControls() {
    const next = oppositeCommunityScoreControlsPosition(controlsPosition);
    setControlsPosition(next);
    writeStorage(COMMUNITY_SCORE_CONTROLS_POSITION_KEY, next);
    setPositionAnnouncement(`Both team score controls moved to the ${next} corners.`);
  }

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!focusMode) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void exitFocusMode();
      return;
    }
    if (event.key !== "Tab" || !shellRef.current) return;
    const focusable = [...shellRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"]):not([data-focus-sentinel])'
    )].filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function wrapFocus(edge: "start" | "end") {
    if (!shellRef.current) return;
    const focusable = [...shellRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"]):not([data-focus-sentinel])'
    )].filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
    const target = edge === "start" ? focusable[0] : focusable[focusable.length - 1];
    target?.focus();
  }

  return (
    <div
      ref={shellRef}
      className={`${styles.watchShell} ${videoVisible ? styles.withVideo : styles.scoreOnly} ${focusMode ? styles.focusMode : ""} ${controlsPosition === "top" ? styles.scoreControlsTop : styles.scoreControlsBottom}`}
      role={focusMode ? "dialog" : undefined}
      aria-modal={focusMode ? true : undefined}
      aria-label={focusMode ? "Full screen watch and score" : undefined}
      onKeyDown={trapFocus}
    >
      {focusMode && (
        <span
          className={styles.focusSentinel}
          data-focus-sentinel
          tabIndex={0}
          onFocus={() => wrapFocus("end")}
        />
      )}
      {!focusMode && (
        <header className={styles.watchToolbar}>
          <div>
            <span><Radio size={18} aria-hidden="true" /> Watch &amp; score</span>
            <small>{mediaAvailable
              ? props.videoGuidance
              : props.videoRequiredForScoring
                ? "Court video is unavailable. Remote authoritative scoring is paused."
                : "Court video is unavailable. You can still record what you see."}</small>
          </div>
          <div className={styles.watchActions}>
            {mediaAvailable && !props.videoRequiredForScoring && (
              <button type="button" onClick={() => setWatching(!videoVisible)} aria-pressed={videoVisible}>
                {videoVisible ? <VideoOff size={18} aria-hidden="true" /> : <Video size={18} aria-hidden="true" />}
                {videoVisible ? "Score only" : "Show video"}
              </button>
            )}
            {videoVisible && mediaAvailable && (
              <button ref={enterButtonRef} type="button" onClick={() => void enterFocusMode()}>
                <Maximize2 size={18} aria-hidden="true" /> Full screen scoring
              </button>
            )}
          </div>
        </header>
      )}

      {videoVisible && mediaAvailable && (
        <section className={styles.videoPane} aria-label="Court broadcast video">
          {props.media}
        </section>
      )}

      {!focusMode && (
        <div className={styles.scorePane}>
          <CommunityWitnessScorer {...props} density={videoVisible ? "watch" : "standard"} />
        </div>
      )}

      {focusMode && mediaAvailable && (
        <CommunityScoreOverlay
          {...props}
          controlsPosition={controlsPosition}
          positionAnnouncement={positionAnnouncement}
          nativeFullscreen={nativeFullscreen}
          exitButtonRef={exitButtonRef}
          recovery={props.focusRecovery ?? null}
          onExit={() => void exitFocusMode()}
          onMoveControls={moveScoreControls}
        />
      )}

      {!preferenceReady && mediaAvailable && <span className={styles.preferenceLoading}>Preparing your saved watch view…</span>}
      <p className={styles.visuallyHidden} aria-live="polite">{modeAnnouncement}</p>
      {focusMode && (
        <span
          className={styles.focusSentinel}
          data-focus-sentinel
          tabIndex={0}
          onFocus={() => wrapFocus("start")}
        />
      )}
    </div>
  );
}

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as WebkitFullscreenDocument).webkitFullscreenElement ?? null;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Viewing/scoring still works when browser storage is unavailable.
  }
}

"use client";

import {
  ArrowLeftRight,
  ExternalLink,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Radio,
  Video,
  VideoOff
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CommunityWitnessScorer, type CommunityWitnessScorerProps } from "./CommunityWitnessScorer";
import { contributionRallyNumber } from "./communityWitnessUi";
import {
  COMMUNITY_WATCH_PREFERENCE_KEY,
  storedVideoPreference,
  youtubeEmbedUrl,
  youtubeWatchUrl
} from "./communityWatchMode";
import styles from "./CommunityWatchAndScore.module.css";

type CommunityWatchAndScoreProps = CommunityWitnessScorerProps & {
  youtubeVideoId: string | null;
  videoGuidance: string;
};

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

export function CommunityWatchAndScore(props: CommunityWatchAndScoreProps) {
  const embedUrl = useMemo(() => youtubeEmbedUrl(props.youtubeVideoId), [props.youtubeVideoId]);
  const watchUrl = useMemo(() => youtubeWatchUrl(props.youtubeVideoId), [props.youtubeVideoId]);
  const [preferenceReady, setPreferenceReady] = useState(false);
  const [videoVisible, setVideoVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [modeAnnouncement, setModeAnnouncement] = useState("");
  const shellRef = useRef<HTMLDivElement | null>(null);
  const enterButtonRef = useRef<HTMLButtonElement | null>(null);
  const exitButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const nativeFullscreenRef = useRef(false);
  const restoreFocusAfterExitRef = useRef(false);

  useEffect(() => {
    const visible = storedVideoPreference(readStorage(COMMUNITY_WATCH_PREFERENCE_KEY), embedUrl != null);
    setVideoVisible(visible);
    setPreferenceReady(true);
  }, [embedUrl]);

  useEffect(() => {
    if (embedUrl) return;
    setFocusMode(false);
    setNativeFullscreen(false);
    nativeFullscreenRef.current = false;
  }, [embedUrl]);

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
    window.setTimeout(() => exitButtonRef.current?.focus(), 0);
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
    if (!embedUrl) return;
    setVideoVisible(next);
    writeStorage(COMMUNITY_WATCH_PREFERENCE_KEY, next ? "watch" : "score-only");
    setModeAnnouncement(next ? "Broadcast video shown." : "Score-only view shown. Video playback stopped.");
    if (!next && focusMode) void exitFocusMode();
  }

  async function enterFocusMode() {
    if (!embedUrl || !shellRef.current) return;
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

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!focusMode) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void exitFocusMode();
      return;
    }
    if (event.key !== "Tab" || !shellRef.current) return;
    const focusable = [...shellRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"]):not([data-focus-sentinel])'
    )].filter((element) => element.getAttribute("aria-hidden") !== "true");
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
      'button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"]):not([data-focus-sentinel])'
    )].filter((element) => element.getAttribute("aria-hidden") !== "true");
    const target = edge === "start" ? focusable[0] : focusable[focusable.length - 1];
    target?.focus();
  }

  return (
    <div
      ref={shellRef}
      className={`${styles.watchShell} ${videoVisible ? styles.withVideo : styles.scoreOnly} ${focusMode ? styles.focusMode : ""}`}
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
            <small>{embedUrl ? props.videoGuidance : "A public broadcast is not available for this court. Scoring remains active."}</small>
          </div>
          <div className={styles.watchActions}>
            {embedUrl && (
              <button type="button" onClick={() => setWatching(!videoVisible)} aria-pressed={videoVisible}>
                {videoVisible ? <VideoOff size={18} aria-hidden="true" /> : <Video size={18} aria-hidden="true" />}
                {videoVisible ? "Score only" : "Show video"}
              </button>
            )}
            {videoVisible && embedUrl && (
              <button ref={enterButtonRef} type="button" onClick={() => void enterFocusMode()}>
                <Maximize2 size={18} aria-hidden="true" /> Full screen scoring
              </button>
            )}
            {watchUrl && (
              <a href={watchUrl} target="_blank" rel="noopener" aria-label="Open this court broadcast on YouTube in a new tab">
                <ExternalLink size={18} aria-hidden="true" /> YouTube
              </a>
            )}
          </div>
        </header>
      )}

      {videoVisible && embedUrl && (
        <section className={styles.videoPane} aria-label="Court broadcast video">
          <iframe
            src={embedUrl}
            title={`${props.view.courtLabel} public broadcast`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            loading="eager"
            referrerPolicy="strict-origin-when-cross-origin"
            tabIndex={0}
          />
        </section>
      )}

      {!focusMode && (
        <div className={styles.scorePane}>
          <CommunityWitnessScorer {...props} density={videoVisible ? "watch" : "standard"} />
        </div>
      )}

      {focusMode && embedUrl && (
        <CommunityScorePanel
          {...props}
          nativeFullscreen={nativeFullscreen}
          exitButtonRef={exitButtonRef}
          onExit={() => void exitFocusMode()}
        />
      )}

      {!preferenceReady && embedUrl && <span className={styles.preferenceLoading}>Preparing your saved watch view…</span>}
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

function CommunityScorePanel({
  view,
  sideOrder,
  receipt,
  sideAnnouncement,
  addDisabled,
  busyTeam,
  correctionBusyTeam,
  removeDisabled,
  onAddPoint,
  onRemovePoint,
  onSwitchSides,
  nativeFullscreen,
  exitButtonRef,
  onExit
}: CommunityWitnessScorerProps & {
  nativeFullscreen: boolean;
  exitButtonRef: RefObject<HTMLButtonElement | null>;
  onExit: () => void;
}) {
  const visibleReceipt = receipt ?? view.latestReceipt ?? {
    rallyNumber: contributionRallyNumber(view.currentRallyNumber, "ADD_POINT"),
    status: "recorded" as const,
    message: `Ready for Rally ${contributionRallyNumber(view.currentRallyNumber, "ADD_POINT")}`
  };

  return (
    <section className={styles.focusPanel} aria-label="Full screen score controls">
      <header className={styles.focusHeader}>
        <button ref={exitButtonRef} type="button" onClick={onExit} aria-label={`Exit ${nativeFullscreen ? "full screen" : "focus view"}`}>
          <Minimize2 size={19} aria-hidden="true" /> <span className={styles.focusControlLabel}>Exit {nativeFullscreen ? "full screen" : "focus view"}</span>
        </button>
        <div className={styles.focusMatch}>
          <span>{view.courtLabel} · {view.matchLabel}</span>
          <strong>Set {view.currentSet}</strong>
          <small>Official score · video may be delayed</small>
        </div>
        <button type="button" onClick={onSwitchSides} aria-label="Switch team sides visually">
          <ArrowLeftRight size={19} aria-hidden="true" /> <span className={styles.focusControlLabel}>Switch sides</span>
        </button>
      </header>

      <div className={styles.focusReceipt} role="status" aria-live="polite">
        {visibleReceipt.message}
      </div>

      <div className={styles.focusTeams}>
        {sideOrder.map((side) => {
          const team = view.teams[side];
          const savingPoint = busyTeam === side;
          const savingCorrection = correctionBusyTeam === side;
          return (
            <article className={`${styles.focusTeam} ${team.tone === "blue" ? styles.focusBlue : styles.focusRed}`} key={side}>
              <div>
                <h2>{team.name}</h2>
                <output aria-label={`${team.name} official score`}>{team.score}</output>
              </div>
              {!view.isFinal && (
                <button
                  className={styles.focusAdd}
                  type="button"
                  aria-label={`Add one point for ${team.name}`}
                  onClick={() => onAddPoint(side)}
                  disabled={addDisabled}
                >
                  <Plus size={25} aria-hidden="true" /> {savingPoint ? "Recording…" : "Add point"}
                </button>
              )}
              <button
                className={styles.focusRemove}
                type="button"
                aria-label={`Remove one point from ${team.name}`}
                onClick={() => onRemovePoint(side)}
                disabled={removeDisabled[side]}
              >
                <Minus size={20} aria-hidden="true" /> {savingCorrection ? "Correcting…" : "Remove point"}
              </button>
            </article>
          );
        })}
      </div>
      <p className={styles.visuallyHidden} aria-live="polite">{sideAnnouncement}</p>
    </section>
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

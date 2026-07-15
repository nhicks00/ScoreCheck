"use client";

import { AlertTriangle, CheckCircle2, LogOut, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StreamPlayer, type StreamPlayerHandle } from "@/components/StreamPlayer";
import type { PlaybackEvidenceSnapshot } from "@/lib/communityPlaybackTiming";
import {
  createOverlayInvalidationScheduler,
  invalidationOnlyBroadcastHandler
} from "@/lib/overlayInvalidation";
import type { StreamTimingSample } from "@/lib/rtcTiming";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { CommunityWatchAndScore } from "./CommunityWatchAndScore";
import type { CommunityWitnessScorerProps } from "./CommunityWitnessScorer";
import styles from "./CommunityWitnessScorer.module.css";
import {
  CommunityApiError,
  getCommunitySession,
  isPendingCommandRecorded,
  parsePendingContribution,
  releaseCommunitySession,
  renewCommunityLease,
  setCanonicalCurrentSet,
  submitPendingContribution,
  type PendingContribution
} from "./communityWitnessApi";
import {
  DEFAULT_SIDE_ORDER,
  adaptCommunityWitnessState,
  canRemovePointFromScore,
  canSubmitContribution,
  COMMUNITY_FAST_SYNC_WINDOW_MS,
  communityRetryPlan,
  communitySyncDelayMs,
  communitySyncJitterMs,
  contributionRallyNumber,
  contributionOutboxStorageKey,
  failedReceipt,
  freshestCommunitySnapshot,
  matchSideOrderStorageKey,
  parseStoredSideOrder,
  reconciledReceiptFromSnapshot,
  retryableContributionReceipt,
  sendingReceipt,
  successfulContributionReceipt,
  swapSideOrder,
  type CommunityReceipt,
  type CommunitySessionSnapshot,
  type ContributionActionType,
  type TeamSide
} from "./communityWitnessUi";

type CommunityWitnessSessionClientProps = {
  exitHref?: string;
  /** Shares timing from the exact WHEP player used to qualify score actions. */
  onPreviewTiming?: (sample: StreamTimingSample | null) => void;
};

type CommunityRefreshOptions = {
  quiet?: boolean;
  preserveActionFeedback?: boolean;
};

export function CommunityWitnessSessionClient({
  exitHref = "/score",
  onPreviewTiming
}: CommunityWitnessSessionClientProps = {}) {
  const [snapshot, setSnapshot] = useState<CommunitySessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CommunityReceipt | null>(null);
  const [pending, setPending] = useState<PendingContribution | null>(null);
  const [sideOrder, setSideOrder] = useState<[TeamSide, TeamSide]>([...DEFAULT_SIDE_ORDER]);
  const [sideAnnouncement, setSideAnnouncement] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [setSelectionBusy, setSetSelectionBusy] = useState(false);
  const [mediaQualification, setMediaQualification] = useState<PlaybackEvidenceSnapshot["qualification"] | null>(null);
  const [mediaActionError, setMediaActionError] = useState<string | null>(null);
  const [retrySignal, setRetrySignal] = useState(0);
  const [lastObservedRevision, setLastObservedRevision] = useState<number | null>(null);
  const [syncCadenceSignal, setSyncCadenceSignal] = useState(0);
  const sendingRef = useRef(false);
  const renewingRef = useRef(false);
  const pendingRef = useRef<PendingContribution | null>(null);
  const snapshotRef = useRef<CommunitySessionSnapshot | null>(null);
  const fastSyncUntilRef = useRef(0);
  const retryFailuresRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const preserveActionFeedbackRef = useRef(false);
  const hydratedAssignmentRef = useRef<string | null>(null);
  const previousMatchRef = useRef<string | null>(null);
  const streamPlayerRef = useRef<StreamPlayerHandle | null>(null);
  const mediaGateRequiredRef = useRef(false);
  const setSelectionActionRef = useRef<{ setNumber: number; revision: number; actionId: string } | null>(null);
  const activeMatchId = snapshot?.match.id ?? null;

  const handleScoringQualification = useCallback((qualification: PlaybackEvidenceSnapshot["qualification"]) => {
    setMediaQualification(qualification);
    if (!mediaGateRequiredRef.current) return;
    setMediaActionError(qualification.liveActionEligible
      ? null
      : "Video reconnecting — authoritative scoring is paused.");
  }, []);

  const acceptSnapshot = useCallback((
    incoming: CommunitySessionSnapshot,
    preserveActionFeedback = preserveActionFeedbackRef.current
  ) => {
    const selected = freshestCommunitySnapshot(snapshotRef.current, incoming);
    if (selected !== incoming) return false;
    snapshotRef.current = incoming;
    setSnapshot(incoming);
    setReceipt((current) => reconciledReceiptFromSnapshot(
      current,
      pendingRef.current != null,
      incoming,
      preserveActionFeedback
    ));
    return true;
  }, []);

  const refresh = useCallback(async ({
    quiet = false,
    preserveActionFeedback
  }: CommunityRefreshOptions = {}) => {
    const keepActionFeedback = preserveActionFeedback ?? preserveActionFeedbackRef.current;
    if (!quiet) setRefreshing(true);
    try {
      const next = await getCommunitySession();
      acceptSnapshot(next, keepActionFeedback);
      if (!keepActionFeedback) setError(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load community scoring.";
      if (isInactiveSessionError(caught)) {
        snapshotRef.current = null;
        setSnapshot(null);
        setError(message);
      } else if (!keepActionFeedback) {
        setError(message);
      }
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    void refresh({ quiet: true });
  }, [refresh]);

  useEffect(() => {
    const eventId = snapshot?.match.eventId;
    const courtNumber = snapshot?.match.courtNumber;
    if (!eventId || !courtNumber) return;
    const supabase = createBrowserSupabase();
    if (!supabase) return;
    const invalidations = createOverlayInvalidationScheduler(() => refresh({ quiet: true }));
    const channel = supabase
      .channel(`overlay:${eventId}:court:${courtNumber}`)
      // Broadcast bodies are untrusted hints. Only the authenticated snapshot
      // response may update scorekeeping state.
      .on("broadcast", { event: "overlay_state" }, invalidationOnlyBroadcastHandler(invalidations.invalidate))
      .subscribe();
    return () => {
      invalidations.dispose();
      void supabase.removeChannel(channel);
    };
  }, [refresh, snapshot?.match.courtNumber, snapshot?.match.eventId]);

  const renew = useCallback(async () => {
    if (renewingRef.current) return;
    renewingRef.current = true;
    try {
      const next = await renewCommunityLease();
      acceptSnapshot(next);
      if (!preserveActionFeedbackRef.current && pendingRef.current == null) setError(null);
    } catch (caught) {
      if (caught instanceof CommunityApiError && caught.retryable) return;
      if (isInactiveSessionError(caught)) {
        snapshotRef.current = null;
        setSnapshot(null);
      }
      setError(caught instanceof Error ? caught.message : "Community scoring session could not be renewed.");
    } finally {
      renewingRef.current = false;
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    if (snapshot?.assignment.status !== "ACTIVE") return;
    let cancelled = false;
    let syncTimer: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      const delay = communitySyncDelayMs({
        visible: document.visibilityState === "visible",
        fastUntil: fastSyncUntilRef.current,
        now: Date.now()
      }) + communitySyncJitterMs(snapshot.assignment.id);
      syncTimer = window.setTimeout(async () => {
        if (!sendingRef.current) await renew();
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (syncTimer != null) window.clearTimeout(syncTimer);
    };
  }, [renew, snapshot?.assignment.id, snapshot?.assignment.status, syncCadenceSignal]);

  useEffect(() => {
    if (snapshot?.assignment.status !== "ACTIVE") return;
    const handleResume = () => {
      setSyncCadenceSignal((value) => value + 1);
      if (document.visibilityState === "visible" && !sendingRef.current) void renew();
    };
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    document.addEventListener("visibilitychange", handleResume);
    return () => {
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("pageshow", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
    };
  }, [renew, snapshot?.assignment.status]);

  useEffect(() => {
    const handleOnline = () => setRetrySignal((value) => value + 1);
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  useEffect(() => () => {
    if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
  }, []);

  useEffect(() => {
    if (!snapshot || hydratedAssignmentRef.current === snapshot.assignment.id) return;
    hydratedAssignmentRef.current = snapshot.assignment.id;
    const stored = parsePendingContribution(readDeviceStorage(contributionOutboxStorageKey(snapshot.assignment.id)));
    // A browser reload destroys proof that a remote point submission was still
    // in flight. Probe the durable command id; never turn that old tap into a
    // newly submitted point after reconnecting.
    const recovered = stored?.requiresLiveMedia
      ? { ...stored, deliveryUncertain: true }
      : stored;
    if (recovered) {
      writeDeviceStorage(contributionOutboxStorageKey(snapshot.assignment.id), JSON.stringify(recovered));
      pendingRef.current = recovered;
      setPending(recovered);
      setReceipt(recovered.deliveryUncertain
        ? uncertainCommandReceipt(recovered, !navigator.onLine)
        : failedReceipt(recovered.rallyNumber, recovered.type === "REMOVE_POINT", true));
    }
  }, [snapshot]);

  useEffect(() => {
    if (!activeMatchId) return;
    const nextMatchId = activeMatchId;
    const changedMatch = previousMatchRef.current != null && previousMatchRef.current !== nextMatchId;
    const storageKey = matchSideOrderStorageKey(nextMatchId);
    const nextOrder = changedMatch
      ? [...DEFAULT_SIDE_ORDER] as [TeamSide, TeamSide]
      : parseStoredSideOrder(readDeviceStorage(storageKey));

    if (changedMatch) removeDeviceStorage(storageKey);
    previousMatchRef.current = nextMatchId;
    setSideOrder(nextOrder);
    setSideAnnouncement("");
    setLastObservedRevision(null);
    setMediaQualification(null);
    setMediaActionError(null);
    setSelectionActionRef.current = null;
  }, [activeMatchId]);

  const sendPending = useCallback(async (item: PendingContribution) => {
    const activeSnapshot = snapshotRef.current;
    if (sendingRef.current || !activeSnapshot) return;
    sendingRef.current = true;
    try {
      const next = await submitPendingContribution(item);
      acceptSnapshot(next);
      const waitingForAdvance = item.kind === "observation" && next.score.revision === item.baseRevision;
      if (item.kind === "observation") setLastObservedRevision(item.baseRevision);
      setReceipt(successfulContributionReceipt(
        next,
        item.rallyNumber,
        item.type === "REMOVE_POINT",
        waitingForAdvance
      ));
      clearRetryTimer();
      retryFailuresRef.current = 0;
      preserveActionFeedbackRef.current = false;
      pendingRef.current = null;
      setPending(null);
      removeDeviceStorage(contributionOutboxStorageKey(activeSnapshot.assignment.id));
      setError(null);
    } catch (caught) {
      const retryable = caught instanceof CommunityApiError && caught.retryable;
      if (retryable && item.requiresLiveMedia) {
        clearRetryTimer();
        const uncertain = { ...item, deliveryUncertain: true };
        pendingRef.current = uncertain;
        setPending(uncertain);
        writeDeviceStorage(contributionOutboxStorageKey(activeSnapshot.assignment.id), JSON.stringify(uncertain));
        setReceipt(uncertainCommandReceipt(uncertain, !navigator.onLine));
        setError(navigator.onLine
          ? "The scoring service did not answer. Checking whether it recorded this point; it will not be submitted later."
          : "Connection lost. When you reconnect, we’ll check whether this point was recorded; it will not be submitted later.");
        return;
      }
      if (!retryable) {
        clearRetryTimer();
        retryFailuresRef.current = 0;
        pendingRef.current = null;
        setPending(null);
        removeDeviceStorage(contributionOutboxStorageKey(activeSnapshot.assignment.id));
      }
      if (retryable) {
        retryFailuresRef.current += 1;
        const plan = communityRetryPlan(retryFailuresRef.current, navigator.onLine);
        setReceipt(retryableContributionReceipt(item.rallyNumber, item.type === "REMOVE_POINT", plan.mode));
        if (plan.retryAfterMs != null) {
          clearRetryTimer();
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            setRetrySignal((value) => value + 1);
          }, plan.retryAfterMs);
        }
        setError(plan.mode === "offline"
          ? "Your contribution is saved on this screen and will submit when the connection returns."
          : plan.mode === "scheduled"
            ? "The scoring service did not answer. Your saved contribution will retry automatically."
            : "Automatic retries paused. Your contribution is still saved on this screen.");
      } else {
        preserveActionFeedbackRef.current = true;
        setReceipt(failedReceipt(item.rallyNumber, item.type === "REMOVE_POINT", false));
        setError(caught instanceof Error ? caught.message : "Your contribution could not be recorded.");
      }
      if (!retryable) void refresh({ quiet: true, preserveActionFeedback: true });
    } finally {
      sendingRef.current = false;
    }
  }, [acceptSnapshot, refresh]);

  const resolveUncertainCommand = useCallback(async (item: PendingContribution) => {
    const activeSnapshot = snapshotRef.current;
    if (sendingRef.current || !activeSnapshot) return;
    sendingRef.current = true;
    try {
      const recorded = await isPendingCommandRecorded(item.clientActionId);
      clearRetryTimer();
      retryFailuresRef.current = 0;
      pendingRef.current = null;
      setPending(null);
      removeDeviceStorage(contributionOutboxStorageKey(activeSnapshot.assignment.id));
      if (recorded) {
        const next = await getCommunitySession().catch(() => null);
        if (next) acceptSnapshot(next);
        preserveActionFeedbackRef.current = false;
        setReceipt({
          rallyNumber: item.type === "REMOVE_POINT" ? null : item.rallyNumber,
          status: "recorded",
          message: item.type === "REMOVE_POINT"
            ? "Your correction was already recorded."
            : `Your call for Rally ${item.rallyNumber} was already recorded.`
        });
        setError(null);
      } else {
        preserveActionFeedbackRef.current = true;
        setReceipt(failedReceipt(item.rallyNumber, item.type === "REMOVE_POINT", false));
        setError("The interrupted point was not recorded. Confirm the live score, then enter it again while the video is connected.");
        void refresh({ quiet: true, preserveActionFeedback: true });
      }
    } catch (caught) {
      const retryable = caught instanceof CommunityApiError && caught.retryable;
      if (retryable) {
        retryFailuresRef.current += 1;
        const plan = communityRetryPlan(retryFailuresRef.current, navigator.onLine);
        setReceipt(uncertainCommandReceipt(item, plan.mode === "offline"));
        setError(plan.mode === "offline"
          ? "Reconnect to check whether the server already recorded this point. It will not be submitted later."
          : "Could not check the score receipt yet. Only the existing receipt will be checked; the point will not be submitted later.");
        if (plan.retryAfterMs != null) {
          clearRetryTimer();
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            setRetrySignal((value) => value + 1);
          }, plan.retryAfterMs);
        }
      } else {
        clearRetryTimer();
        pendingRef.current = null;
        setPending(null);
        removeDeviceStorage(contributionOutboxStorageKey(activeSnapshot.assignment.id));
        preserveActionFeedbackRef.current = true;
        setReceipt(failedReceipt(item.rallyNumber, item.type === "REMOVE_POINT", false));
        setError(caught instanceof Error ? caught.message : "The score receipt could not be checked. Confirm the live score before entering another point.");
      }
    } finally {
      sendingRef.current = false;
    }
  }, [acceptSnapshot, refresh]);

  useEffect(() => {
    if (!pending || sendingRef.current) return;
    if (!navigator.onLine) {
      setReceipt(pending.deliveryUncertain
        ? uncertainCommandReceipt(pending, true)
        : retryableContributionReceipt(pending.rallyNumber, pending.type === "REMOVE_POINT", "offline"));
      setError((current) => current ?? (pending.deliveryUncertain
        ? "Reconnect to check whether the server already recorded this point. It will not be submitted later."
        : "Your contribution is saved on this screen. Reconnect before retrying."));
      return;
    }
    if (pending.deliveryUncertain) {
      setReceipt(uncertainCommandReceipt(pending, false));
      void resolveUncertainCommand(pending);
      return;
    }
    setReceipt(sendingReceipt(pending.rallyNumber, pending.type === "REMOVE_POINT"));
    void sendPending(pending);
  }, [pending, resolveUncertainCommand, retrySignal, sendPending]);

  const view = useMemo(() => snapshot ? adaptCommunityWitnessState(snapshot) : null, [snapshot]);
  const waitingForNextRally = snapshot != null
    && snapshot.assignment.role !== "DESIGNATED_SCORER"
    && (snapshot.community.hasContributedToCurrentRevision || lastObservedRevision === snapshot.score.revision);

  function switchSides() {
    if (!snapshot || !view) return;
    setSideOrder((current) => {
      const next = swapSideOrder(current);
      writeDeviceStorage(matchSideOrderStorageKey(snapshot.match.id), JSON.stringify(next));
      setSideAnnouncement(`Sides switched. ${view.teams[next[0]].name} is now on the left and ${view.teams[next[1]].name} is now on the right.`);
      return next;
    });
  }

  function recordContribution(type: ContributionActionType, team: TeamSide) {
    if (!snapshot || !view || pending || sendingRef.current || !canSubmitContribution(snapshot, type)) return;
    const requiresLiveMedia = requiresQualifiedMedia(snapshot);
    const playbackEvidence = requiresLiveMedia
      ? streamPlayerRef.current?.capturePlaybackEvidence({ baseRevision: snapshot.score.revision })
      : undefined;
    if (requiresLiveMedia && !playbackEvidence?.qualification.liveActionEligible) {
      setMediaActionError("Video reconnecting — authoritative scoring is paused.");
      streamPlayerRef.current?.retryPlayback();
      return;
    }
    const acceptedPlaybackEvidence = requiresLiveMedia && playbackEvidence?.qualification.liveActionEligible
      ? playbackEvidence
      : undefined;
    preserveActionFeedbackRef.current = false;
    const correction = type === "REMOVE_POINT";
    const rallyNumber = contributionRallyNumber(view.currentRallyNumber, type);
    const nextPending: PendingContribution = {
      clientActionId: crypto.randomUUID(),
      kind: snapshot.assignment.role === "DESIGNATED_SCORER" ? "command" : "observation",
      type,
      team,
      baseRevision: snapshot.score.revision,
      rallyNumber,
      deviceSequence: nextDeviceSequence(snapshot.assignment.id),
      createdAt: new Date().toISOString(),
      requiresLiveMedia,
      deliveryUncertain: false,
      ...(acceptedPlaybackEvidence ? { playbackEvidence: acceptedPlaybackEvidence } : {})
    };

    writeDeviceStorage(contributionOutboxStorageKey(snapshot.assignment.id), JSON.stringify(nextPending));
    fastSyncUntilRef.current = Date.now() + COMMUNITY_FAST_SYNC_WINDOW_MS;
    setSyncCadenceSignal((value) => value + 1);
    pendingRef.current = nextPending;
    setPending(nextPending);
    setReceipt(sendingReceipt(rallyNumber, correction));
    setError(null);
    setMediaActionError(null);
    navigator.vibrate?.(12);
  }

  async function selectCanonicalSet(setNumber: number) {
    if (!snapshot || setSelectionBusy || pending || releasing || !canSelectCanonicalSet(snapshot)) return;
    if (setNumber === snapshot.score.currentSet) return;
    const bestOf = matchBestOf(snapshot.match.format);
    if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > bestOf) return;
    const confirmed = window.confirm(
      `Change the official current set from Set ${snapshot.score.currentSet} to Set ${setNumber}? This updates every scorekeeper.`
    );
    if (!confirmed) return;

    const requiresLiveMedia = requiresQualifiedMedia(snapshot);
    const playbackEvidence = requiresLiveMedia
      ? streamPlayerRef.current?.capturePlaybackEvidence({ baseRevision: snapshot.score.revision })
      : undefined;
    if (requiresLiveMedia && !playbackEvidence?.qualification.liveActionEligible) {
      setMediaActionError("Video reconnecting — authoritative scoring is paused.");
      streamPlayerRef.current?.retryPlayback();
      return;
    }

    const revision = snapshot.score.revision;
    const previousAction = setSelectionActionRef.current;
    const action = previousAction?.setNumber === setNumber && previousAction.revision === revision
      ? previousAction
      : { setNumber, revision, actionId: crypto.randomUUID() };
    setSelectionActionRef.current = action;
    setSetSelectionBusy(true);
    setError(null);
    try {
      const next = await setCanonicalCurrentSet({
        clientActionId: action.actionId,
        expectedRevision: action.revision,
        setNumber: action.setNumber,
        ...(playbackEvidence ? { playbackEvidence } : {})
      });
      acceptSnapshot(next);
      setReceipt({
        rallyNumber: null,
        status: "corrected",
        message: `Official current set changed to Set ${setNumber}.`
      });
      setSelectionActionRef.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The official set could not be changed.");
      if (caught instanceof CommunityApiError && caught.status === 409) {
        setSelectionActionRef.current = null;
        void refresh({ quiet: true });
      }
    } finally {
      setSetSelectionBusy(false);
    }
  }

  function retrySavedContribution() {
    if (!pending || sendingRef.current) return;
    preserveActionFeedbackRef.current = false;
    clearRetryTimer();
    retryFailuresRef.current = 0;
    if (!navigator.onLine) {
      setReceipt(pending.deliveryUncertain
        ? uncertainCommandReceipt(pending, true)
        : retryableContributionReceipt(pending.rallyNumber, pending.type === "REMOVE_POINT", "offline"));
      setError(pending.deliveryUncertain
        ? "Reconnect to check whether the server already recorded this point. It will not be submitted later."
        : "Your contribution is saved on this screen. Reconnect before retrying.");
      return;
    }
    setError(null);
    setRetrySignal((value) => value + 1);
  }

  function checkAgain() {
    preserveActionFeedbackRef.current = false;
    setReceipt((current) => current?.status === "failed" ? null : current);
    setError(null);
    void refresh({ preserveActionFeedback: false });
  }

  function clearRetryTimer() {
    if (retryTimerRef.current == null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }

  async function release() {
    if (!snapshot || pending || releasing) return;
    setReleasing(true);
    setError(null);
    try {
      await releaseCommunitySession(crypto.randomUUID());
      removeDeviceStorage(contributionOutboxStorageKey(snapshot.assignment.id));
      window.location.assign(exitHref);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not leave this court.");
      setReleasing(false);
    }
  }

  if (loading && !snapshot) {
    return (
      <main className={styles.sessionShell}>
        <div className={styles.loadingState} aria-label="Loading community scorekeeper">
          <span />
          <span />
          <span />
        </div>
      </main>
    );
  }

  if (!snapshot || !view) {
    return (
      <main className={styles.sessionShell}>
        <section className={styles.terminalState}>
          <AlertTriangle size={28} aria-hidden="true" />
          <h1>This community session is not active</h1>
          <p>{error ?? "Join a court to start contributing."}</p>
          <Link className="button primary" href={exitHref}>Choose a court</Link>
        </section>
      </main>
    );
  }

  const mediaGateRequired = requiresQualifiedMedia(snapshot);
  mediaGateRequiredRef.current = mediaGateRequired;
  const mediaEligible = !mediaGateRequired || mediaQualification?.liveActionEligible === true;
  const addEnabled = canSubmitContribution(snapshot, "ADD_POINT") && mediaEligible && !waitingForNextRally && !pending && !releasing && !setSelectionBusy;
  const removeEnabled = canSubmitContribution(snapshot, "REMOVE_POINT") && mediaEligible && !waitingForNextRally && !pending && !releasing && !setSelectionBusy;
  const setSelectionAuthority = canSelectCanonicalSet(snapshot);
  const setSelectionEnabled = setSelectionAuthority && !pending && !releasing;
  const availableSets = setNumbersForMatch(snapshot.match.format, snapshot.score);
  const activeScore = snapshot.score;
  const authorityMessage = assignmentMessage(snapshot, waitingForNextRally);
  const scorerProps: CommunityWitnessScorerProps = {
    view,
    sideOrder,
    receipt,
    sideAnnouncement,
    addDisabled: !addEnabled,
    busyTeam: pending?.type === "ADD_POINT" ? pending.team : null,
    correctionBusyTeam: pending?.type === "REMOVE_POINT" ? pending.team : null,
    removeDisabled: {
      A: !removeEnabled || !canRemovePointFromScore(activeScore, "A"),
      B: !removeEnabled || !canRemovePointFromScore(activeScore, "B")
    },
    onAddPoint: (side) => recordContribution("ADD_POINT", side),
    onRemovePoint: (side) => recordContribution("REMOVE_POINT", side),
    onSwitchSides: switchSides,
    availableSets,
    setSelectionBusy: setSelectionBusy || pending != null || releasing || (setSelectionAuthority && !mediaEligible),
    onSelectSet: setSelectionEnabled ? (setNumber) => void selectCanonicalSet(setNumber) : undefined
  };
  const visibleError = mediaActionError ?? error;
  const recoveryAction = mediaActionError ? {
    label: "Reconnect video",
    disabled: false,
    run: () => {
      setMediaActionError(null);
      streamPlayerRef.current?.retryPlayback();
    }
  } : {
    label: pending
      ? receipt?.status === "sending"
        ? "Submitting…"
        : pending.deliveryUncertain ? "Check score receipt" : "Retry saved contribution"
      : refreshing ? "Checking…" : "Check again",
    disabled: pending ? receipt?.status === "sending" : refreshing,
    run: () => pending ? retrySavedContribution() : checkAgain()
  };

  return (
    <main className={styles.sessionShell}>
      {visibleError && (
        <div className={styles.sessionAlert} role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          <span>{visibleError}</span>
          <button
            type="button"
            onClick={recoveryAction.run}
            disabled={recoveryAction.disabled}
          >
            <RefreshCw size={17} aria-hidden="true" /> {recoveryAction.label}
          </button>
        </div>
      )}

      <CommunityWatchAndScore
        {...scorerProps}
        media={(
          <StreamPlayer
            ref={streamPlayerRef}
            courtNumber={snapshot.match.courtNumber}
            sources={{ whepUrl: "/api/community/session/media/whep", hlsUrl: null }}
            mode="scoring"
            onTimingSample={onPreviewTiming}
            onScoringQualification={handleScoringQualification}
          />
        )}
        videoGuidance={videoGuidance(snapshot.assignment.role)}
        videoRequiredForScoring={mediaGateRequired}
        focusRecovery={visibleError ? {
          message: visibleError,
          actionLabel: recoveryAction.label,
          actionDisabled: recoveryAction.disabled,
          onAction: recoveryAction.run
        } : null}
      />

      <section className={styles.sessionFooter} aria-label="Your community session">
        <div>
          <span className={styles.roleLabel}>{roleLabel(snapshot.assignment.role)}</span>
          <strong>{snapshot.assignment.displayName}</strong>
          <p>{authorityMessage}</p>
        </div>
        {snapshot.assignment.status === "ACTIVE" ? (
          <button type="button" className={styles.releaseButton} onClick={() => void release()} disabled={pending != null || releasing}>
            <LogOut size={18} aria-hidden="true" /> {releasing ? "Leaving…" : "I’m done contributing"}
          </button>
        ) : (
          <Link className="button primary" href={exitHref}><CheckCircle2 size={18} aria-hidden="true" /> Choose another court</Link>
        )}
      </section>
    </main>
  );
}

function uncertainCommandReceipt(item: PendingContribution, offline: boolean): CommunityReceipt {
  const subject = item.type === "REMOVE_POINT" ? "Correction" : `Rally ${item.rallyNumber}`;
  return {
    rallyNumber: item.type === "REMOVE_POINT" ? null : item.rallyNumber,
    status: offline ? "offline" : "retrying",
    message: `${subject} receipt pending · ${offline ? "reconnect to check" : "checking recorded status"}`
  };
}

function nextDeviceSequence(assignmentId: string): number {
  const key = `scorecheck:community-device-sequence:${assignmentId}`;
  const previous = Number(readDeviceStorage(key));
  const next = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  writeDeviceStorage(key, String(next));
  return next;
}

function isInactiveSessionError(error: unknown): boolean {
  return error instanceof CommunityApiError && [401, 403, 404, 410].includes(error.status);
}

function readDeviceStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDeviceStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The core score action and side switch still work when storage is blocked.
  }
}

function removeDeviceStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore unavailable device storage during cleanup.
  }
}

function roleLabel(role: CommunitySessionSnapshot["assignment"]["role"]): string {
  switch (role) {
    case "DESIGNATED_SCORER": return "Designated scorer";
    case "VERIFIED_WITNESS": return "Verified witness";
    case "OBSERVER": return "Community witness";
  }
}

function assignmentMessage(snapshot: CommunitySessionSnapshot, waitingForNextRally: boolean): string {
  if (snapshot.assignment.status !== "ACTIVE") return "This match-scoped session has ended. Your earlier contributions remain in the rally journey.";
  if (snapshot.score.status === "Final") return "The match is final. Remove point stays available for an explicit correction to the last completed set.";
  if (waitingForNextRally) return "Call recorded — waiting for the score to advance before your next contribution.";
  if (snapshot.assignment.role === "DESIGNATED_SCORER" && snapshot.score.authorityMode !== "DESIGNATED_PRIMARY") {
    return "The broadcast is currently controlled by a higher-priority source, so score actions are paused on this device.";
  }
  if (snapshot.assignment.role === "DESIGNATED_SCORER") {
    return "Your point actions update the broadcast. Community witnesses can confirm each rally alongside you.";
  }
  return "Your calls contribute evidence. The broadcast score stays visibly separate until each rally is resolved.";
}

function videoGuidance(role: CommunitySessionSnapshot["assignment"]["role"]): string {
  if (role === "OBSERVER") {
    return "Watch the court and record only what you see. Your call remains evidence until the rally is resolved.";
  }
  return "Keep the court in view while scoring. A reconnect pauses authoritative actions.";
}

function canSelectCanonicalSet(snapshot: CommunitySessionSnapshot): boolean {
  return snapshot.assignment.status === "ACTIVE"
    && snapshot.assignment.role === "DESIGNATED_SCORER"
    && snapshot.score.authorityMode === "DESIGNATED_PRIMARY"
    && snapshot.score.status !== "Final";
}

function matchBestOf(format: Record<string, unknown>): number {
  const value = Number(format.bestOf);
  return Number.isInteger(value) && value >= 1 && value <= 99 ? value : 3;
}

function setNumbersForMatch(
  format: Record<string, unknown>,
  score: CommunitySessionSnapshot["score"]
): number[] {
  const completed = new Set(score.setScores
    .filter((set) => set.isComplete)
    .map((set) => set.setNumber));
  return Array.from({ length: matchBestOf(format) }, (_, index) => index + 1)
    .filter((setNumber) => setNumber === score.currentSet || !completed.has(setNumber));
}

function requiresQualifiedMedia(snapshot: CommunitySessionSnapshot): boolean {
  return snapshot.assignment.role === "DESIGNATED_SCORER"
    && snapshot.assignment.trustTier !== "VERIFIED_COURTSIDE";
}

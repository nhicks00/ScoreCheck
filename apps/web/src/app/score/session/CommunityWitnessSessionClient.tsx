"use client";

import { AlertTriangle, CheckCircle2, LogOut, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommunityWatchAndScore } from "./CommunityWatchAndScore";
import { CommunityWitnessScorer, type CommunityWitnessScorerProps } from "./CommunityWitnessScorer";
import styles from "./CommunityWitnessScorer.module.css";
import {
  CommunityApiError,
  getCommunitySession,
  parsePendingContribution,
  releaseCommunitySession,
  renewCommunityLease,
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
  videoMode?: "embedded" | "external";
};

type CommunityRefreshOptions = {
  quiet?: boolean;
  preserveActionFeedback?: boolean;
};

export function CommunityWitnessSessionClient({
  exitHref = "/score",
  videoMode = "embedded"
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
  const activeMatchId = snapshot?.match.id ?? null;

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
    const recovered = parsePendingContribution(readDeviceStorage(contributionOutboxStorageKey(snapshot.assignment.id)));
    if (recovered) {
      pendingRef.current = recovered;
      setPending(recovered);
      setReceipt(failedReceipt(recovered.rallyNumber, recovered.type === "REMOVE_POINT", true));
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

  useEffect(() => {
    if (!pending || sendingRef.current) return;
    if (!navigator.onLine) {
      setReceipt(retryableContributionReceipt(pending.rallyNumber, pending.type === "REMOVE_POINT", "offline"));
      setError((current) => current ?? "Your contribution is saved on this screen. Reconnect before retrying.");
      return;
    }
    setReceipt(sendingReceipt(pending.rallyNumber, pending.type === "REMOVE_POINT"));
    void sendPending(pending);
  }, [pending, retrySignal, sendPending]);

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
      createdAt: new Date().toISOString()
    };

    writeDeviceStorage(contributionOutboxStorageKey(snapshot.assignment.id), JSON.stringify(nextPending));
    fastSyncUntilRef.current = Date.now() + COMMUNITY_FAST_SYNC_WINDOW_MS;
    setSyncCadenceSignal((value) => value + 1);
    pendingRef.current = nextPending;
    setPending(nextPending);
    setReceipt(sendingReceipt(rallyNumber, correction));
    setError(null);
    navigator.vibrate?.(12);
  }

  function retrySavedContribution() {
    if (!pending || sendingRef.current) return;
    preserveActionFeedbackRef.current = false;
    clearRetryTimer();
    retryFailuresRef.current = 0;
    if (!navigator.onLine) {
      setReceipt(retryableContributionReceipt(pending.rallyNumber, pending.type === "REMOVE_POINT", "offline"));
      setError("Your contribution is saved on this screen. Reconnect before retrying.");
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

  const addEnabled = canSubmitContribution(snapshot, "ADD_POINT") && !waitingForNextRally && !pending && !releasing;
  const removeEnabled = canSubmitContribution(snapshot, "REMOVE_POINT") && !waitingForNextRally && !pending && !releasing;
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
    onSwitchSides: switchSides
  };

  return (
    <main className={styles.sessionShell}>
      {error && (
        <div className={styles.sessionAlert} role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          <span>{error}</span>
          <button
            type="button"
            onClick={() => pending ? retrySavedContribution() : checkAgain()}
            disabled={pending ? receipt?.status === "sending" : refreshing}
          >
            <RefreshCw size={17} aria-hidden="true" /> {pending
              ? receipt?.status === "sending" ? "Submitting…" : "Retry saved contribution"
              : refreshing ? "Checking…" : "Check again"}
          </button>
        </div>
      )}

      {videoMode === "embedded" ? (
        <CommunityWatchAndScore
          {...scorerProps}
          youtubeVideoId={snapshot.match.youtubeVideoId}
          videoGuidance={videoGuidance(snapshot.assignment.role)}
        />
      ) : (
        <CommunityWitnessScorer {...scorerProps} />
      )}

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
    return "The public broadcast may be delayed. Your call is evidence until the rally is resolved.";
  }
  return "Use the live court for authoritative calls; the public broadcast may be delayed.";
}

"use client";

import { Moon, Play, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { youtubeWatchUrl } from "@/lib/opsConsole";
import { timestampAgeMs } from "@/lib/timeLabels";

type PortalSetScore = { setNumber: number; teamAScore: number; teamBScore: number; isComplete: boolean };

type CourtCard = {
  id: string;
  courtNumber: number;
  displayName: string;
  scoringOpen: boolean;
  lastUpdateAt?: string | null;
  youtubeVideoId?: string | null;
  scorerStatus: {
    needsScorer: boolean;
    hasActive: boolean;
    backups: number;
    activeName: string | null;
  };
  match: {
    id?: string;
    teamA: string | null;
    teamB: string | null;
    roundName: string | null;
    matchNumber: string | null;
  } | null;
  score: {
    teamAScore: number;
    teamBScore: number;
    teamASets: number;
    teamBSets: number;
    currentSet: number;
    setScores?: PortalSetScore[];
    status: string;
    lastScoreChangeAt?: string | null;
    updatedAt?: string | null;
  } | null;
};

/** A final match older than this no longer counts as "just finished". */
const STALE_FINAL_MS = 2 * 60 * 60 * 1000;

type CourtPresence =
  | "live"          // match in progress, someone is scoring
  | "needs-scorer"  // match in progress, no scorer yet
  | "final"         // match finished recently — worth showing the result
  | "idle"          // stale final (or unknown-age final): nothing happening now
  | "no-match"      // court has no match assigned
  | "closed";       // admin closed scoring on this court

export function ScorePortalClient() {
  const eventSlug = process.env.NEXT_PUBLIC_DEFAULT_EVENT_SLUG ?? "avp-denver";
  const eventName = process.env.NEXT_PUBLIC_EVENT_NAME ?? "Live Event";
  const [courts, setCourts] = useState<CourtCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const hasData = useRef(false);

  const refresh = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const res = await fetch(`/api/public/events/${eventSlug}/courts`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load courts");
      setCourts(json.courts ?? []);
      hasData.current = true;
      setUpdatedAt(new Date());
      setError(null);
      setReconnecting(false);
    } catch (err) {
      // Keep showing the last good data on transient failures; only surface a
      // full error when we have nothing to show yet.
      if (hasData.current) {
        setReconnecting(true);
      } else {
        setError(friendlyError(err instanceof Error ? err.message : null));
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, [eventSlug]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Some backend writers momentarily bump a final match's timestamps, which
  // would make a days-old final flicker back to "Match complete" between
  // polls. Once a court's final match has been judged stale, keep it idle
  // until the match or its score actually changes.
  const staleFinalKeys = useRef<Map<string, string>>(new Map());

  const presences = useMemo(() => {
    const now = Date.now();
    return new Map(courts.map((court) => {
      let presence = courtPresence(court, now);
      const key = finalMatchKey(court);
      if (presence === "final" && staleFinalKeys.current.get(court.id) === key) {
        presence = "idle";
      } else if (presence === "idle" && court.match) {
        staleFinalKeys.current.set(court.id, key);
      } else if (presence !== "final") {
        staleFinalKeys.current.delete(court.id);
      }
      return [court.id, presence];
    }));
  }, [courts]);

  const liveCount = useMemo(
    () => courts.filter((court) => isLivePresence(presences.get(court.id))).length,
    [courts, presences]
  );
  const needsScorerCount = useMemo(
    () => courts.filter((court) => presences.get(court.id) === "needs-scorer").length,
    [courts, presences]
  );
  const nothingLive = !loading && courts.length > 0 && liveCount === 0;

  return (
    <main className="shell score-shell">
      <div className="score-container">
        <header className="score-header">
          <div>
            <p className="eyebrow">ScoreCheck</p>
            <h1>{eventName}</h1>
            <p className="muted">Pick a court, enter your name, and keep the score up to date with big, simple tap controls.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={18} /> Refresh
          </button>
        </header>

        <section className="score-strip">
          <div>
            <ShieldCheck size={18} /> {coverageLabel(liveCount, needsScorerCount, loading && courts.length === 0)}
          </div>
          {updatedAt && <div>Updated {updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>}
          {reconnecting && <div className="strip-reconnect"><WifiOff size={16} /> Reconnecting&hellip;</div>}
        </section>

        {error && courts.length === 0 && !loading && (
          <div className="panel warn-surface portal-error">
            <p>{error}</p>
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw size={18} /> Try again
            </button>
          </div>
        )}

        {nothingLive && (
          <section className="portal-empty" aria-live="polite">
            <Moon size={22} aria-hidden="true" />
            <div>
              <h2>No live matches right now</h2>
              <p>Courts light up here the moment play starts. Check back when matches are on.</p>
            </div>
          </section>
        )}

        {loading && courts.length === 0 && !error && (
          <section className="fan-court-grid" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <article className="fan-court-card skeleton-card" key={index}>
                <span className="skeleton skeleton-chip" />
                <span className="skeleton skeleton-title" />
                <span className="skeleton skeleton-block" />
                <span className="skeleton skeleton-cta" />
              </article>
            ))}
          </section>
        )}

        <section className="fan-court-grid">
          {courts.map((court) => {
            const presence = presences.get(court.id) ?? "no-match";
            const status = presenceChip(presence);
            const courtName = court.displayName || `Court ${court.courtNumber}`;

            if (presence === "idle" || presence === "no-match" || (presence === "closed" && !court.match)) {
              return (
                <article className="fan-court-card idle" key={court.id}>
                  <div className="court-card-top">
                    <span className={`status ${status.tone}`}>{status.label}</span>
                    <span className="stream-key-badge" aria-label={`Stream key ${court.courtNumber}`}>Key {court.courtNumber}</span>
                  </div>
                  <h2 className="court-title">{courtName}</h2>
                  <WatchLiveLink videoId={court.youtubeVideoId} courtName={courtName} />
                  <div className="court-idle-body">
                    <Moon size={18} aria-hidden="true" />
                    <p>{presence === "no-match" ? "No match scheduled yet" : "No live match right now"}</p>
                  </div>
                  <span className="idle-cta">Check back soon</span>
                </article>
              );
            }

            const teamA = displayTeamName(court.match?.teamA, "TBD");
            const teamB = displayTeamName(court.match?.teamB, "TBD");
            const sets = setsWonFromScore(court.score);
            return (
              <article className="fan-court-card" key={court.id}>
                <div className="court-card-top">
                  <span className={`status ${status.tone}`}>{status.label}</span>
                  <span className="stream-key-badge" aria-label={`Stream key ${court.courtNumber}`}>Key {court.courtNumber}</span>
                </div>
                <h2 className="court-title">{courtName}</h2>
                <WatchLiveLink videoId={court.youtubeVideoId} courtName={courtName} />
                <div className="court-scoreboard" aria-label={`${teamA} versus ${teamB}`}>
                  <div className="court-team-row team-a">
                    <span className="team-chip" aria-hidden="true" />
                    <strong className="team-name">{teamA}</strong>
                    <SetDots sets={sets.a} label={`${teamA}: ${sets.a} sets won`} />
                    <span className="score-num">{court.score?.teamAScore ?? 0}</span>
                  </div>
                  <div className="court-team-row team-b">
                    <span className="team-chip" aria-hidden="true" />
                    <strong className="team-name">{teamB}</strong>
                    <SetDots sets={sets.b} label={`${teamB}: ${sets.b} sets won`} />
                    <span className="score-num">{court.score?.teamBScore ?? 0}</span>
                  </div>
                </div>
                <div className="court-set-row">
                  <span className="set-badge">Set {court.score?.currentSet ?? 1}</span>
                  <small>Sets {sets.a}-{sets.b}</small>
                </div>
                {presence === "live" && court.scorerStatus.activeName && (
                  <small className="court-scorer-note">Scored by {court.scorerStatus.activeName}</small>
                )}
                {presence === "needs-scorer" && (
                  <Link className="button primary fan-cta" href={`/score/court/${court.courtNumber}`}>
                    Help score {courtName}
                  </Link>
                )}
                {presence === "live" && (
                  <Link className="button fan-cta" href={`/score/court/${court.courtNumber}`}>
                    Join as backup scorer
                  </Link>
                )}
                {presence === "final" && (
                  <span className="idle-cta">Waiting for the next match</span>
                )}
                {presence === "closed" && (
                  <span className="idle-cta">Scoring is closed on this court</span>
                )}
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}

/** YouTube deep link for a court's broadcast — renders nothing without a video id. */
function WatchLiveLink({ videoId, courtName }: { videoId?: string | null; courtName: string }) {
  const url = youtubeWatchUrl(videoId);
  if (!url) return null;
  return (
    <a
      className="watch-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Watch ${courtName} live on YouTube`}
    >
      <Play size={14} aria-hidden="true" /> Watch live
    </a>
  );
}

function SetDots({ sets, label }: { sets: number; label: string }) {
  const won = Math.max(0, Math.min(sets, 3));
  const total = Math.max(2, won);
  return (
    <span className="set-dots" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, index) => (
        <span className={`set-dot ${index < won ? "won" : ""}`} key={index} />
      ))}
    </span>
  );
}

function courtPresence(court: CourtCard, now: number): CourtPresence {
  if (!court.match) return court.scoringOpen ? "no-match" : "closed";
  const isFinal = Boolean(court.score?.status?.toLowerCase().includes("final"));
  if (isFinal) {
    const bestTimestamp = court.score?.lastScoreChangeAt ?? court.score?.updatedAt ?? court.lastUpdateAt ?? null;
    const age = timestampAgeMs(bestTimestamp, now);
    // Without a usable timestamp we cannot tell how old a final match is, so
    // treat it as idle rather than resurfacing last week's result.
    if (age == null || age > STALE_FINAL_MS) return "idle";
    return "final";
  }
  if (!court.scoringOpen) return "closed";
  if (court.scorerStatus.needsScorer) return "needs-scorer";
  return "live";
}

function isLivePresence(presence: CourtPresence | undefined): boolean {
  return presence === "live" || presence === "needs-scorer";
}

/** Identity of the final result currently shown on a court. */
function finalMatchKey(court: CourtCard): string {
  return [
    court.match?.id ?? court.match?.matchNumber ?? "",
    court.match?.teamA ?? "",
    court.match?.teamB ?? "",
    court.score?.teamAScore ?? 0,
    court.score?.teamBScore ?? 0,
    court.score?.teamASets ?? 0,
    court.score?.teamBSets ?? 0,
    court.score?.status ?? ""
  ].join("|");
}

function presenceChip(presence: CourtPresence): { label: string; tone: string } {
  switch (presence) {
    case "live":
      return { label: "Live scoring", tone: "live" };
    case "needs-scorer":
      return { label: "Needs scorer", tone: "warn" };
    case "final":
      return { label: "Match complete", tone: "info" };
    case "closed":
      return { label: "Scoring closed", tone: "" };
    case "no-match":
      return { label: "No match yet", tone: "" };
    default:
      return { label: "Idle", tone: "" };
  }
}

/**
 * Derive sets won from the set-score list, deduped by set number, instead of
 * trusting the payload's aggregate counters (which have double-counted after
 * replays). Falls back to the aggregates when no per-set data exists.
 */
function setsWonFromScore(score: CourtCard["score"]): { a: number; b: number } {
  if (!score) return { a: 0, b: 0 };
  const rows = Array.isArray(score.setScores) ? score.setScores : [];
  const bySet = new Map<number, PortalSetScore>();
  for (const row of rows) {
    if (row && Number.isFinite(row.setNumber) && !bySet.has(row.setNumber)) {
      bySet.set(row.setNumber, row);
    }
  }
  if (bySet.size > 0) {
    let a = 0;
    let b = 0;
    for (const set of bySet.values()) {
      if (set.isComplete === false) continue;
      if (set.teamAScore > set.teamBScore) a += 1;
      else if (set.teamBScore > set.teamAScore) b += 1;
    }
    return { a, b };
  }
  return { a: Math.max(0, score.teamASets ?? 0), b: Math.max(0, score.teamBSets ?? 0) };
}

function coverageLabel(liveCount: number, needsScorerCount: number, initialLoading: boolean): string {
  if (initialLoading) return "Checking courts…";
  if (liveCount === 0) return "No live matches right now";
  const live = `${liveCount} ${liveCount === 1 ? "court" : "courts"} live`;
  if (needsScorerCount === 0) return live;
  return `${live} · ${needsScorerCount} ${needsScorerCount === 1 ? "needs" : "need"} a scorer`;
}

function displayTeamName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

function friendlyError(message: string | null): string {
  if (!message) return "Scoring is not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database/i.test(message)) {
    return "Scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}

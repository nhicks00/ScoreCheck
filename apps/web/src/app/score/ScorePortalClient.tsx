"use client";

import { RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type CourtCard = {
  id: string;
  courtNumber: number;
  displayName: string;
  scoringOpen: boolean;
  scorerStatus: {
    needsScorer: boolean;
    hasActive: boolean;
    backups: number;
    activeName: string | null;
  };
  match: {
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
    setScores?: Array<{ setNumber: number; teamAScore: number; teamBScore: number; isComplete: boolean }>;
    status: string;
  } | null;
};

export function ScorePortalClient() {
  const eventSlug = process.env.NEXT_PUBLIC_DEFAULT_EVENT_SLUG ?? "avp-denver";
  const eventName = process.env.NEXT_PUBLIC_EVENT_NAME ?? "AVP Denver Open";
  const [courts, setCourts] = useState<CourtCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/public/events/${eventSlug}/courts`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load courts");
      setCourts(json.courts ?? []);
      setUpdatedAt(new Date());
      setError(null);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setLoading(false);
    }
  }, [eventSlug]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const covered = useMemo(() => courts.filter((court) => court.scorerStatus.hasActive).length, [courts]);

  return (
    <main className="shell score-shell">
      <div className="score-container stack">
        <header className="score-header">
          <div>
            <p className="eyebrow">ScoreCheck</p>
            <h1>{eventName}</h1>
            <p className="muted">Pick a court, enter your name, then tap the team that wins each point.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={18} /> Refresh
          </button>
        </header>

        <section className="score-strip">
          <div><ShieldCheck size={18} /> {covered} courts covered</div>
          {updatedAt && <div>Updated {updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>}
        </section>

        {error && <div className="panel warn-surface">{error}</div>}
        {loading && courts.length === 0 && <div className="panel muted">Loading courts...</div>}

        <section className="fan-court-grid">
          {courts.map((court) => {
            const teamA = displayTeamName(court.match?.teamA, "TBD");
            const teamB = displayTeamName(court.match?.teamB, "TBD");
            return (
              <article className="fan-court-card" key={court.id}>
                <div className="court-card-top">
                  <span className="status">{courtStatus(court)}</span>
                  <span className="stream-key-badge" aria-label={`Stream key ${court.courtNumber}`}>Key {court.courtNumber}</span>
                </div>
                <h2 className="court-title">{court.displayName || `Court ${court.courtNumber}`}</h2>
                <div className="court-scoreboard" aria-label={`${teamA} versus ${teamB}`}>
                  <div className="court-team-row">
                    <strong>{teamA}</strong>
                    <span>{court.score?.teamAScore ?? 0}</span>
                  </div>
                  <div className="court-versus">vs</div>
                  <div className="court-team-row">
                    <strong>{teamB}</strong>
                    <span>{court.score?.teamBScore ?? 0}</span>
                  </div>
                </div>
                <div className="court-set-row">
                  <span>Set {court.score?.currentSet ?? 1}</span>
                  <small>Sets {court.score?.teamASets ?? 0}-{court.score?.teamBSets ?? 0}</small>
                </div>
                <Link className="button primary fan-cta" href={`/score/court/${court.courtNumber}`}>
                  Help score {court.displayName || `Court ${court.courtNumber}`}
                </Link>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function courtStatus(court: CourtCard): string {
  if (!court.scoringOpen) return "Scoring closed";
  if (!court.match) return "Match not loaded";
  if (court.score?.status?.toLowerCase().includes("final")) return "Match complete";
  if (court.scorerStatus.needsScorer) return "Needs scorer";
  return "Being scored";
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

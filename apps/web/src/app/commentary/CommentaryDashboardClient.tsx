"use client";

import { Headphones, Mic, MonitorPlay, RefreshCw, WifiOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type DashboardRoom = {
  streamNumber: number;
  roomName: string;
  guestUrl: string;
};

type CourtCard = {
  id: string;
  courtNumber: number;
  displayName: string;
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
    status: string;
  } | null;
};

const POLL_MS = 10_000;

export function CommentaryDashboardClient({
  eventSlug,
  eventName,
  rooms
}: {
  eventSlug: string;
  eventName: string;
  rooms: DashboardRoom[];
}) {
  const [courts, setCourts] = useState<CourtCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const hasData = useRef(false);

  const refresh = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const res = await fetch(`/api/public/events/${eventSlug}/courts`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load courts");
      setCourts(json.courts ?? []);
      hasData.current = true;
      setError(null);
      setReconnecting(false);
    } catch (err) {
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
    const id = window.setInterval(() => void refresh(true), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const courtByNumber = new Map(courts.map((court) => [court.courtNumber, court]));

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Commentary">
            <button type="button" className="button ghost" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={16} /> Refresh
            </button>
          </nav>
        </div>

        <header className="admin-dashboard-header">
          <div>
            <p className="eyebrow">Commentary</p>
            <h1>{eventName}</h1>
            <p className="muted">
              Pick your court, join its audio room with a headset, and keep the score up to date while you call the match.
            </p>
          </div>
          {reconnecting && <span className="muted"><WifiOff size={16} /> Reconnecting&hellip;</span>}
        </header>

        {error && courts.length === 0 && !loading && (
          <div className="panel warn-surface">
            <p>{error}</p>
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw size={16} /> Try again
            </button>
          </div>
        )}

        <section className="fan-court-grid">
          {rooms.map((room) => {
            const court = courtByNumber.get(room.streamNumber);
            const courtName = court?.displayName || `Court ${room.streamNumber}`;
            const teamA = court?.match?.teamA?.trim() || "TBD";
            const teamB = court?.match?.teamB?.trim() || "TBD";
            const hasMatch = Boolean(court?.match);
            return (
              <article className="fan-court-card commentary-card" key={room.streamNumber}>
                <div className="court-card-top">
                  <span className={`status ${hasMatch ? "live" : ""}`}>{hasMatch ? "Match on" : "No match"}</span>
                  <span className="stream-key-badge" aria-label={`Stream ${room.streamNumber}`}>Stream {room.streamNumber}</span>
                </div>
                <h2 className="court-title">{courtName}</h2>
                {hasMatch ? (
                  <div className="court-scoreboard" aria-label={`${teamA} versus ${teamB}`}>
                    <div className="court-team-row team-a">
                      <span className="team-chip" aria-hidden="true" />
                      <strong className="team-name">{teamA}</strong>
                      <span className="score-num">{court?.score?.teamAScore ?? 0}</span>
                    </div>
                    <div className="court-team-row team-b">
                      <span className="team-chip" aria-hidden="true" />
                      <strong className="team-name">{teamB}</strong>
                      <span className="score-num">{court?.score?.teamBScore ?? 0}</span>
                    </div>
                  </div>
                ) : (
                  <p className="muted">{loading ? "Checking this court…" : "Nothing scheduled right now. You can still open the court and get set up."}</p>
                )}
                {hasMatch && (
                  <div className="court-set-row">
                    <span className="set-badge">Set {court?.score?.currentSet ?? 1}</span>
                    <small>Sets {court?.score?.teamASets ?? 0}-{court?.score?.teamBSets ?? 0}</small>
                  </div>
                )}
                <small className="commentary-room-note"><Headphones size={14} aria-hidden="true" /> Room {room.roomName}</small>
                <Link className="button primary fan-cta" href={`/commentary/court/${room.streamNumber}`}>
                  <MonitorPlay size={18} /> Open court
                </Link>
                <a className="button fan-cta" href={room.guestUrl} target="_blank" rel="noreferrer">
                  <Mic size={18} /> Join audio room
                </a>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}

/** Mask backend/config internals; commentators only need "not ready yet". */
function friendlyError(message: string | null): string {
  if (!message) return "Courts are not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database|environment/i.test(message)) {
    return "Courts are not ready yet. Please try again in a moment.";
  }
  return message;
}

"use client";

import { ArrowLeft, CheckCircle2, Clock, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { requestedCommunityRole } from "./communityJoinUi";

type CourtPageData = {
  event: { id: string; slug: string; name: string };
  court: { id: string; court_number: number; display_name: string; scoring_open?: boolean | null };
  match: { team_a: string | null; team_b: string | null; round_name: string | null; match_number: string | null; status?: string | null } | null;
  score: { team_a_score: number; team_b_score: number; current_set: number; status: string } | null;
  scorerStatus: { needsScorer: boolean; backupRequested: boolean; hasActive: boolean; backupCount: number; activeName: string | null };
};

export function ClaimClient({
  courtParam,
  eventSlug,
  joinCode,
  roleIntent
}: {
  courtParam: string;
  eventSlug: string;
  joinCode?: string;
  roleIntent?: string;
}) {
  const [data, setData] = useState<CourtPageData | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const courtNumber = data?.court.court_number ?? Number(courtParam);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/courts/${courtParam}?eventSlug=${encodeURIComponent(eventSlug)}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load this court");
      setData(json);
      setError(null);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : null));
    }
  }, [courtParam, eventSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/community/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventSlug,
          courtNumber: data.court.court_number,
          displayName,
          // Location is not a trustworthy authority signal. A grant may
          // authorize a role, but physical-courtside trust still requires an
          // authenticated organizer verification.
          participationMode: "REMOTE",
          requestedRole: requestedCommunityRole(joinCode, roleIntent),
          ...(joinCode ? { joinCode } : {})
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok !== true) {
        throw new Error(json.error ?? "Could not join this court");
      }
      setRedirecting(true);
      window.location.assign("/score/session");
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : "Could not join this court"));
      setBusy(false);
    }
  }

  const courtIdle = data != null && !hasScoreableMatch(data);
  const statusInfo = useMemo(() => {
    if (!data) return { label: "Loading", tone: "" };
    if (data.court.scoring_open === false) return { label: "Scoring closed", tone: "" };
    if (!hasScoreableMatch(data)) return { label: "No live match", tone: "" };
    if (data.scorerStatus.needsScorer) return { label: "Needs scorer", tone: "warn" };
    return { label: "Live scoring", tone: "live" };
  }, [data]);
  const teamA = displayTeamName(data?.match?.team_a, "TBD");
  const teamB = displayTeamName(data?.match?.team_b, "TBD");

  return (
    <main className="shell score-shell">
      <div className="score-container narrow">
        <div className="score-back-row">
          <Link className="button ghost" href="/score">
            <ArrowLeft size={16} /> All courts
          </Link>
          <button type="button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
        </div>

        <section className="claim-hero">
          <span className={`status ${statusInfo.tone}`}>{statusInfo.label}</span>
          <h1>{data?.court.display_name ?? `Court ${courtNumber}`}</h1>
          <p className="muted">{data?.event.name ?? ""}</p>
          <div className="match-line">
            <strong>{teamA}</strong>
            <span>vs</span>
            <strong>{teamB}</strong>
          </div>
        </section>

        {error && <div className="panel warn-surface">{error}</div>}

        {redirecting ? (
          <section className="panel">
            <CheckCircle2 size={30} />
            <p>Opening your scoring page...</p>
            <p className="muted" role="status" aria-live="polite">You are all set. Leave this page open while it loads.</p>
          </section>
        ) : courtIdle ? (
          <section className="panel">
            <Clock size={30} />
            <h2>No live match right now</h2>
            <p className="muted">
              This court does not have a live or upcoming match at the moment. Check back when play resumes.
            </p>
            <button type="button" onClick={() => void load()}><RefreshCw size={16} /> Check again</button>
          </section>
        ) : (
          <form className="claim-form" onSubmit={submit}>
            <div className="panel">
              <ol className="claim-steps" aria-label="How to start scoring">
                <li className="claim-step done"><span className="claim-step-num" aria-hidden="true">1</span> Pick a court</li>
                <li className="claim-step current"><span className="claim-step-num" aria-hidden="true">2</span> Enter your name</li>
                <li className="claim-step"><span className="claim-step-num" aria-hidden="true">3</span> Join coverage</li>
              </ol>
              <h2>{requestedCommunityRole(joinCode, roleIntent) === "DESIGNATED_SCORER" ? "Take the designated scorer position." : "Join the community keeping this court covered."}</h2>
              <p className="muted">Record each point you see. Your calls add independent evidence, help catch mistakes, and keep everyone involved without claiming they changed the broadcast before resolution.</p>
              <label>
                Choose a public scorer nickname
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Courtside scorer"
                  autoComplete="nickname"
                  required
                  maxLength={80}
                />
              </label>
              <button className="primary claim-submit" type="submit" disabled={busy || !data || data.court.scoring_open === false}>
                <ShieldCheck size={20} /> Join this court
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

function hasScoreableMatch(data: CourtPageData): boolean {
  if (!data.match) return false;
  if (isFinalStatus(data.match.status)) return false;
  if (isFinalStatus(data.score?.status)) return false;
  return true;
}

function isFinalStatus(status: string | null | undefined): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.toLowerCase();
  // "Set Complete" is a live mid-match status, not a finished match.
  return normalized.includes("final") || normalized.includes("completed") || normalized.includes("cancel");
}

function friendlyError(message: string | null): string {
  if (!message) return "Scoring is not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database/i.test(message)) {
    return "Scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}

function displayTeamName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

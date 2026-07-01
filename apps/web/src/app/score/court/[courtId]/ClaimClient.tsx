"use client";

import { CheckCircle2, MonitorPlay, RefreshCw, ShieldCheck, Volleyball } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type CourtPageData = {
  event: { id: string; slug: string; name: string };
  court: { id: string; court_number: number; display_name: string; scoring_open?: boolean | null };
  match: { team_a: string | null; team_b: string | null; round_name: string | null; match_number: string | null } | null;
  score: { team_a_score: number; team_b_score: number; current_set: number; status: string } | null;
  scorerStatus: { needsScorer: boolean; backupRequested: boolean; backups: unknown[]; active: { display_name: string } | null };
};

type Claim = {
  claimId: string;
  claimStatusToken: string;
  verificationCode: string;
  expiresAt: string;
  message: string;
};

export function ClaimClient({ courtParam, eventSlug, adminMode }: { courtParam: string; eventSlug: string; adminMode: boolean }) {
  const [data, setData] = useState<CourtPageData | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [watchMode, setWatchMode] = useState<"website" | "courtside">("website");
  const [claim, setClaim] = useState<Claim | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    if (!claim) return;
    const activeClaim = claim;
    let cancelled = false;
    async function poll() {
      const res = await fetch(`/api/scoring/claims/${activeClaim.claimId}/status?claimStatusToken=${encodeURIComponent(activeClaim.claimStatusToken)}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(friendlyError(json.error ?? "Could not check verification"));
        return;
      }
      setStatus(json.message ?? json.status);
      if (json.sessionUrl) {
        window.location.assign(json.sessionUrl);
      }
      if (json.status === "expired") {
        setClaim(null);
      }
    }
    void poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [claim]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/scoring/claims/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventSlug,
        courtNumber: data.court.court_number,
        displayName,
        watchMode
      })
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(friendlyError(json.error ?? "Could not start scoring"));
      return;
    }
    setClaim(json);
    setStatus(json.message);
  }

  async function adminVerify() {
    if (!claim) return;
    setBusy(true);
    const res = await fetch(`/api/scoring/claims/${claim.claimId}/admin-verify`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(friendlyError(json.error ?? "Admin verification failed"));
      return;
    }
    setStatus("Verified. Opening scorer page...");
  }

  const statusText = useMemo(() => {
    if (!data) return "Loading";
    if (data.court.scoring_open === false) return "Scoring closed";
    if (data.scorerStatus.needsScorer) return "Needs scorer";
    if (data.scorerStatus.backups.length === 0) return "Has scorer - backup needed";
    return "Covered";
  }, [data]);

  return (
    <main className="shell score-shell">
      <div className="score-container narrow stack">
        <div className="score-back-row">
          <Link className="button" href="/score">All courts</Link>
          <button type="button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button>
        </div>

        <section className="claim-hero">
          <span className="status">{statusText}</span>
          <h1>{data?.court.display_name ?? `Court ${courtNumber}`}</h1>
          <p className="muted">{data?.event.name ?? "AVP Denver Open"}</p>
          <div className="match-line large">
            <strong>{data?.match?.team_a ?? "Team on left"}</strong>
            <span>vs</span>
            <strong>{data?.match?.team_b ?? "Team on right"}</strong>
          </div>
        </section>

        {error && <div className="panel warn-surface">{error}</div>}

        {!claim ? (
          <form className="claim-form" onSubmit={submit}>
            <div className="panel stack">
              <h2>Thanks for helping keep score.</h2>
              <p className="muted">You only need to do one thing: tap the team that wins each point.</p>
              <div className="watch-toggle" role="group" aria-label="Watching mode">
                <button type="button" className={watchMode === "website" ? "primary" : ""} onClick={() => setWatchMode("website")}>
                  <MonitorPlay size={18} /> On this website
                </button>
                <button type="button" className={watchMode === "courtside" ? "primary" : ""} onClick={() => setWatchMode("courtside")}>
                  <Volleyball size={18} /> Courtside / in person
                </button>
              </div>
              <label>
                What name should we show to the broadcast team?
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Mike - Ava's Dad"
                  autoComplete="name"
                  required
                  maxLength={80}
                />
              </label>
              <button className="primary claim-submit" type="submit" disabled={busy || !data || data.court.scoring_open === false}>
                <ShieldCheck size={20} /> Get my chat code
              </button>
            </div>
          </form>
        ) : (
          <section className="verification-card">
            <CheckCircle2 size={28} />
            <p>Type this code in the YouTube chat:</p>
            <strong>{claim.verificationCode}</strong>
            <p className="muted">Leave this page open. We will continue automatically when your code is seen.</p>
            {status && <p className="muted">{status}</p>}
            <button type="button" onClick={() => setClaim(null)} disabled={busy}>Get a new code</button>
            {adminMode && <button className="warn" type="button" onClick={() => void adminVerify()} disabled={busy}>Admin verify for testing</button>}
          </section>
        )}
      </div>
    </main>
  );
}

function friendlyError(message: string | null): string {
  if (!message) return "Scoring is not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database/i.test(message)) {
    return "Scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}

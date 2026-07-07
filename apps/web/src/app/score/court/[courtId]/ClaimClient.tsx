"use client";

import { ArrowLeft, CheckCircle2, MonitorOff, MonitorPlay, RefreshCw, ShieldCheck } from "lucide-react";
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
  verificationCode?: string;
  expiresAt: string;
  message: string;
};

export function ClaimClient({ courtParam, eventSlug, adminMode }: { courtParam: string; eventSlug: string; adminMode: boolean }) {
  const [data, setData] = useState<CourtPageData | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [watchMode, setWatchMode] = useState<"website" | "courtside">("courtside");
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

  async function createClaim(nextDisplayName: string): Promise<Claim> {
    if (!data) throw new Error("Court is still loading.");
    const res = await fetch("/api/scoring/claims/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventSlug,
        courtNumber: data.court.court_number,
        displayName: nextDisplayName,
        watchMode
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error ?? "Could not start scoring");
    }
    return json as Claim;
  }

  async function openClaimStatus(nextClaim: Claim) {
    const res = await fetch(`/api/scoring/claims/${nextClaim.claimId}/status?claimStatusToken=${encodeURIComponent(nextClaim.claimStatusToken)}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error ?? "Could not open scoring session");
    }
    setStatus(json.message ?? "Verified. Opening scorer page...");
    if (json.sessionUrl) {
      window.location.assign(json.sessionUrl);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const nextClaim = await createClaim(displayName);
      setClaim(nextClaim);
      setStatus(nextClaim.message);
      await openClaimStatus(nextClaim);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : "Could not start scoring"));
    } finally {
      setBusy(false);
    }
  }

  async function verifyClaimForAdmin(claimId: string) {
    const res = await fetch(`/api/scoring/claims/${claimId}/admin-verify`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error ?? "Admin verification failed");
    }
  }

  async function adminVerify() {
    if (!claim) return;
    setBusy(true);
    setError(null);
    try {
      await verifyClaimForAdmin(claim.claimId);
      setStatus("Verified. Opening scorer page...");
      await openClaimStatus(claim);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : "Admin verification failed"));
    } finally {
      setBusy(false);
    }
  }

  async function adminStartSession() {
    if (!data) return;
    const adminDisplayName = displayName.trim() || `Admin tester - Court ${data.court.court_number}`;
    setBusy(true);
    setError(null);
    try {
      if (!displayName.trim()) setDisplayName(adminDisplayName);
      const nextClaim = await createClaim(adminDisplayName);
      setClaim(nextClaim);
      setStatus("Admin verification in progress...");
      await verifyClaimForAdmin(nextClaim.claimId);
      setStatus("Verified. Opening scorer page...");
      await openClaimStatus(nextClaim);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : "Admin test scoring failed"));
    } finally {
      setBusy(false);
    }
  }

  const statusInfo = useMemo(() => {
    if (!data) return { label: "Loading", tone: "" };
    if (data.court.scoring_open === false) return { label: "Scoring closed", tone: "" };
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
          <p className="muted">{data?.event.name ?? "AVP Denver Open"}</p>
          <div className="match-line">
            <strong>{teamA}</strong>
            <span>vs</span>
            <strong>{teamB}</strong>
          </div>
        </section>

        {error && <div className="panel warn-surface">{error}</div>}
        {adminMode && (
          <div className="admin-test-banner" role="status">
            <ShieldCheck size={18} />
            <span>Admin test mode can start a scoring session for this court.</span>
          </div>
        )}

        {!claim ? (
          <form className="claim-form" onSubmit={submit}>
            <div className="panel">
              <ol className="claim-steps" aria-label="How to start scoring">
                <li className="claim-step done"><span className="claim-step-num" aria-hidden="true">1</span> Pick a court</li>
                <li className="claim-step current"><span className="claim-step-num" aria-hidden="true">2</span> Enter your name</li>
                <li className="claim-step"><span className="claim-step-num" aria-hidden="true">3</span> Tap to score</li>
              </ol>
              <h2>Thanks for helping keep score.</h2>
              <p className="muted">You only need to do one thing: tap the team that wins each point.</p>
              <div className="watch-toggle mode-toggle" role="group" aria-label="Scoring view">
                <button type="button" className={watchMode === "courtside" ? "primary" : ""} onClick={() => setWatchMode("courtside")}>
                  <span><MonitorOff size={18} /> Score only</span>
                  <small>Best when you are at the court</small>
                </button>
                <button type="button" className={watchMode === "website" ? "primary" : ""} onClick={() => setWatchMode("website")}>
                  <span><MonitorPlay size={18} /> Watch stream + score</span>
                  <small>Best when you are following online</small>
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
                <ShieldCheck size={20} /> Start scoring
              </button>
              {adminMode && (
                <button className="warn claim-submit" type="button" onClick={() => void adminStartSession()} disabled={busy || !data || data.court.scoring_open === false}>
                  <ShieldCheck size={20} /> Start admin scoring test
                </button>
              )}
            </div>
          </form>
        ) : (
          <section className="verification-card">
            <CheckCircle2 size={30} />
            <p>Opening your scoring page...</p>
            {claim.verificationCode && <strong className="verification-code">{claim.verificationCode}</strong>}
            <p className="muted">Leave this page open. If it does not continue automatically, tap the button below.</p>
            {status && <p className="muted" role="status" aria-live="polite">{status}</p>}
            <button type="button" onClick={() => void openClaimStatus(claim)} disabled={busy}>Open scorer page</button>
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

function displayTeamName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

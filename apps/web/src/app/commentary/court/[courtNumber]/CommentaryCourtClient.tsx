"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CommunityWitnessSessionClient } from "@/app/score/session/CommunityWitnessSessionClient";
import { StreamPlayer } from "@/components/StreamPlayer";
import type { StreamTimingSample } from "@/lib/rtcTiming";
import { CommentaryAudioClient } from "./CommentaryAudioClient";

type CommentaryCourtClientProps = {
  courtNumber: number;
  courtName: string;
  eventName: string;
  sources: { whepUrl: string | null; hlsUrl: string | null };
  commentaryConfigured: boolean;
};

export function CommentaryCourtClient({
  courtNumber,
  courtName,
  eventName,
  sources,
  commentaryConfigured
}: CommentaryCourtClientProps) {
  const [hasScoringSession, setHasScoringSession] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState("Commentator");
  const [busy, setBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const previewTimingRef = useRef<StreamTimingSample | null>(null);
  const updatePreviewTiming = useCallback((sample: StreamTimingSample | null) => {
    previewTimingRef.current = sample;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/community/session", { cache: "no-store" })
      .then(async (response) => ({ response, json: await response.json().catch(() => ({})) }))
      .then(({ response, json }) => {
        if (cancelled) return;
        setHasScoringSession(response.ok && json.ok === true && json.match?.courtNumber === courtNumber);
      })
      .catch(() => {
        if (!cancelled) setHasScoringSession(false);
      });
    return () => { cancelled = true; };
  }, [courtNumber]);

  async function startScoring(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setClaimError(null);
    try {
      const res = await fetch("/api/commentary/scoring/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtNumber, displayName })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok !== true) throw new Error(json.error ?? "Could not start a scoring session");
      setHasScoringSession(true);
    } catch (err) {
      setClaimError(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Commentary">
            <Link className="button ghost" href="/commentary">
              <ArrowLeft size={16} /> All courts
            </Link>
          </nav>
        </div>

        <header className="admin-dashboard-header">
          <div>
            <p className="eyebrow">Commentary · {eventName}</p>
            <h1>{courtName}</h1>
            <p className="muted">
              Call the match off this low-latency feed, keep the score current, and stay in the audio room the whole time.
            </p>
          </div>
          <span className="stream-key-badge">Stream {courtNumber}</span>
        </header>

        <div className="commentary-court-layout">
          <div className="commentary-main">
            <StreamPlayer courtNumber={courtNumber} sources={sources} onTimingSample={updatePreviewTiming} />

            {hasScoringSession == null ? null : hasScoringSession ? (
              <section className="commentary-scoring" aria-label="Scoring">
                <CommunityWitnessSessionClient exitHref={`/commentary/court/${courtNumber}`} videoMode="external" />
              </section>
            ) : (
              <section className="panel stack commentary-claim" aria-label="Start scoring">
                <h2>Score while you talk</h2>
                <p className="muted">
                  Grab the scorer seat for this court so your calls and the broadcast scoreboard stay in sync.
                </p>
                {claimError && <p className="form-alert" role="alert">{claimError}</p>}
                <form className="stack" onSubmit={startScoring}>
                  <label>
                    Your name
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      required
                      maxLength={80}
                      autoComplete="off"
                    />
                  </label>
                  <button className="primary" type="submit" disabled={busy || !displayName.trim()}>
                    {busy ? "Starting…" : "Start scoring"}
                  </button>
                </form>
              </section>
            )}
          </div>

          <aside className="commentary-rail" aria-label="Audio room">
            <CommentaryAudioClient
              courtNumber={courtNumber}
              displayName={displayName}
              configured={commentaryConfigured}
              previewTimingRef={previewTimingRef}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

/** Mask backend/config internals; commentators only need "not ready yet". */
function friendlyError(message: string | null): string {
  if (!message) return "Scoring is not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database|environment/i.test(message)) {
    return "Scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}

"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CommunityWitnessSessionClient } from "@/app/score/session/CommunityWitnessSessionClient";
import type { StreamTimingSample } from "@/lib/rtcTiming";
import { CommentaryAudioClient } from "./CommentaryAudioClient";

type CommentaryCourtClientProps = {
  courtNumber: number;
  courtName: string;
  eventName: string;
  commentaryConfigured: boolean;
};

type CommentarySessionRole = "OBSERVER" | "VERIFIED_WITNESS" | "DESIGNATED_SCORER";

type CommentarySessionIdentity = {
  assignmentId: string;
  role: CommentarySessionRole;
};

export function CommentaryCourtClient({
  courtNumber,
  courtName,
  eventName,
  commentaryConfigured
}: CommentaryCourtClientProps) {
  const [communitySession, setCommunitySession] = useState<CommentarySessionIdentity | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [viewerAttempt, setViewerAttempt] = useState(0);
  const [displayName, setDisplayName] = useState("Commentator");
  const [busy, setBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const scorerClaimActionRef = useRef<{ assignmentId: string; actionId: string } | null>(null);
  const previewTimingRef = useRef<StreamTimingSample | null>(null);
  const updatePreviewTiming = useCallback((sample: StreamTimingSample | null) => {
    previewTimingRef.current = sample;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSessionLoading(true);
    setSessionError(null);

    void (async () => {
      const current = await currentCommentarySession(courtNumber);
      if (cancelled) return;
      if (current) {
        setCommunitySession(current);
        setSessionLoading(false);
        return;
      }

      try {
        const joined = await joinCommentarySession({
          courtNumber,
          displayName: "Commentator",
          mode: "view"
        });
        if (!cancelled) setCommunitySession(joined);
      } catch (error) {
        if (!cancelled) {
          setCommunitySession(null);
          setSessionError(friendlyError(error instanceof Error ? error.message : null, "view"));
        }
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [courtNumber, viewerAttempt]);

  async function startScoring(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setClaimError(null);
    try {
      if (!communitySession) throw new Error("Open the live court view before taking the scorer seat.");
      const priorClaim = scorerClaimActionRef.current;
      const clientActionId = priorClaim?.assignmentId === communitySession.assignmentId
        ? priorClaim.actionId
        : crypto.randomUUID();
      scorerClaimActionRef.current = { assignmentId: communitySession.assignmentId, actionId: clientActionId };
      const joined = await joinCommentarySession({
        courtNumber,
        displayName,
        mode: "score",
        clientActionId
      });
      setCommunitySession(joined);
    } catch (err) {
      // The viewer assignment and live court feed remain mounted when a
      // scorer claim is rejected or temporarily unavailable.
      setClaimError(friendlyError(err instanceof Error ? err.message : null, "score"));
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
              Call the match from this court feed, keep the score current, and stay in the audio room the whole time.
            </p>
          </div>
          <span className="stream-key-badge">Stream {courtNumber}</span>
        </header>

        <div className="commentary-court-layout">
          <div className="commentary-main">
            {sessionLoading && !communitySession ? (
              <section className="panel stack commentary-claim" aria-live="polite">
                <h2>Opening the live court view…</h2>
                <p className="muted">Connecting you to the live court feed.</p>
              </section>
            ) : communitySession ? (
              <>
                <section className="commentary-scoring" aria-label="Live court view and scoring">
                  <CommunityWitnessSessionClient
                    key={`${communitySession.assignmentId}:${communitySession.role}`}
                    exitHref={`/commentary/court/${courtNumber}`}
                    onPreviewTiming={updatePreviewTiming}
                  />
                </section>
                {communitySession.role !== "DESIGNATED_SCORER" && (
                  <section className="panel stack commentary-claim" aria-label="Take scorer seat">
                    <h2>Take the scorer seat</h2>
                    <p className="muted">
                      Your court view stays open if the scorer seat is unavailable. Claim it only when you are ready to keep the official live score.
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
                        {busy ? "Claiming seat…" : "Take scorer seat"}
                      </button>
                    </form>
                  </section>
                )}
              </>
            ) : (
              <section className="panel stack commentary-claim" aria-label="Open court view">
                <h2>The live court view could not open</h2>
                <p className="muted">
                  {sessionError ?? "Please try the connection again in a moment."}
                </p>
                <button className="primary" type="button" onClick={() => setViewerAttempt((attempt) => attempt + 1)}>
                  Try court view again
                </button>
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
function friendlyError(message: string | null, mode: "view" | "score"): string {
  const fallback = mode === "score"
    ? "The scorer seat is not ready yet. Your live court view is still available."
    : "The live court view is not ready yet. Please try again in a moment.";
  if (!message) return fallback;
  if (/api key|supabase|service role|jwt|database|environment/i.test(message)) {
    return fallback;
  }
  return message;
}

async function currentCommentarySession(courtNumber: number): Promise<CommentarySessionIdentity | null> {
  try {
    const response = await fetch("/api/community/session", { cache: "no-store" });
    const json = await response.json().catch(() => ({}));
    return response.ok ? sessionIdentity(json, courtNumber) : null;
  } catch {
    return null;
  }
}

async function joinCommentarySession(input: {
  courtNumber: number;
  displayName: string;
  mode: "view" | "score";
  clientActionId?: string;
}): Promise<CommentarySessionIdentity> {
  const response = await fetch("/api/commentary/scoring/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok !== true) {
    throw new Error(typeof json.error === "string" ? json.error : "Could not open this court session.");
  }
  const identity = sessionIdentity(json, input.courtNumber);
  if (!identity) throw new Error("Could not verify this court session.");
  return identity;
}

function sessionIdentity(value: unknown, courtNumber: number): CommentarySessionIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    ok?: unknown;
    assignment?: { id?: unknown; role?: unknown; status?: unknown };
    match?: { courtNumber?: unknown };
  };
  if (candidate.ok !== true || candidate.match?.courtNumber !== courtNumber) return null;
  if (candidate.assignment?.status !== "ACTIVE") return null;
  if (typeof candidate.assignment?.id !== "string" || !isCommentarySessionRole(candidate.assignment.role)) return null;
  return { assignmentId: candidate.assignment.id, role: candidate.assignment.role };
}

function isCommentarySessionRole(value: unknown): value is CommentarySessionRole {
  return value === "OBSERVER" || value === "VERIFIED_WITNESS" || value === "DESIGNATED_SCORER";
}

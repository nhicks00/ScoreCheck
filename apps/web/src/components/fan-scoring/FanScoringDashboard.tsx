"use client";

import { AlertTriangle, Copy, Edit3, Eye, Radio, ShieldAlert, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useRef, useState } from "react";
import { clientIntentKey, createClientActionIntentRegistry } from "@/lib/clientActionIntents";
import { canAutoApplyCommunityDispute } from "@/lib/communityDisputePolicy";
import { recordForCurrentMatch } from "@/lib/currentMatch";
import { formatRelativeTime } from "@/lib/timeLabels";

export type FanScoringCourt = {
  id: string;
  court_number: number;
  display_name: string;
  scoring_open?: boolean | null;
  backup_requested?: boolean | null;
  preview_stream_path?: string | null;
  program_stream_path?: string | null;
  vbl_court_number?: string | null;
  vbl_court_label?: string | null;
  matches?: Match | Match[] | null;
  score_states?: Score | Score[] | null;
};
type Court = FanScoringCourt;

type Match = { id: string; team_a: string | null; team_b: string | null; round_name: string | null; match_number: string | null };
type Score = { match_id?: string | null; team_a_score: number; team_b_score: number; team_a_sets: number; team_b_sets: number; current_set: number; status: string; updated_at: string | null };
type Assignment = {
  id: string;
  court_id: string;
  role: "OBSERVER" | "VERIFIED_WITNESS" | "DESIGNATED_SCORER";
  trust_tier: "REMOTE" | "COURTSIDE" | "VERIFIED_COURTSIDE";
  status: string;
  display_name: string;
  last_seen_at: string | null;
  lease_expires_at: string | null;
};
type CourtAssignmentCounts = {
  courtId: string;
  matchId: string | null;
  activeAssignmentCount: number;
  activeObserverCount: number;
  activeVerifiedWitnessCount: number;
  activeDesignatedCount: number;
  returnedObserverCount: number;
};
type Flag = { id: string; court_id: string; severity: string; status: string; type: string; message: string; created_at: string };
type Dispute = {
  id: string;
  eventId: string;
  courtId: string;
  matchId: string;
  rallyNumber: number;
  baseRevision: number;
  status: "OPEN" | "ACKNOWLEDGED";
  expectedActionType: "ADD_POINT" | "REMOVE_POINT";
  expectedTeamSide: "A" | "B";
  canonicalEventId: string | null;
  resolutionKind: "POST_CANONICAL_DISSENT" | "UNAPPLIED_MAJORITY_PROPOSAL" | "NO_CONSENSUS_REVIEW";
  alreadyApplied: boolean;
  differingCount: number;
  eligibleVoteCount: number;
  proposalVoteCount: number;
  proposalEligible: boolean;
  voteBreakdown: Array<{
    actionType: "ADD_POINT" | "REMOVE_POINT";
    teamSide: "A" | "B";
    count: number;
  }>;
  openedAt: string;
  teamAName: string;
  teamBName: string;
};

export function FanScoringDashboard({
  event,
  courts,
  assignments,
  courtCounts,
  flags,
  disputes,
  disputeTotalOpenCount,
  disputesTruncated,
  siteUrl
}: {
  event: { id: string; name: string; slug: string };
  courts: Court[];
  assignments: Assignment[];
  courtCounts: CourtAssignmentCounts[];
  flags: Flag[];
  disputes: Dispute[];
  disputeTotalOpenCount: number;
  disputesTruncated: boolean;
  siteUrl: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const actionIntents = useRef(createClientActionIntentRegistry()).current;
  const assignmentsByCourt = useMemo(() => groupBy(assignments, (assignment) => assignment.court_id), [assignments]);
  const countsByCourt = useMemo(() => new Map(courtCounts.map((counts) => [counts.courtId, counts] as const)), [courtCounts]);
  const flagsByCourt = useMemo(() => groupBy(flags.filter((flag) => flag.status === "open"), (flag) => flag.court_id), [flags]);
  const disputesByCourt = useMemo(() => groupBy(disputes, (dispute) => dispute.courtId), [disputes]);
  const origin = scorecheckOrigin(siteUrl);
  const openCourts = courts.filter((court) => court.scoring_open !== false).length;
  const activeAssignments = courtCounts.reduce((total, counts) => total + counts.activeDesignatedCount, 0);
  const verifiedWitnesses = courtCounts.reduce((total, counts) => total + counts.activeVerifiedWitnessCount, 0);
  const openFlags = flags.filter((flag) => flag.status === "open").length;

  async function updateCourt(courtId: string, body: Record<string, unknown>) {
    setBusy(`court-${courtId}`);
    setMessage(null);
    const res = await fetch(`/api/admin/fan-scoring/courts/${courtId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setMessage(json.error ?? "Court update failed");
      return;
    }
    setMessage("Saved");
    router.refresh();
  }

  async function updateAssignment(assignmentId: string, action: "verify" | "designate" | "revoke" | "release") {
    const intentKey = clientIntentKey("community-assignment", { assignmentId, action });
    const actionId = actionIntents.actionIdFor(intentKey);
    setBusy(`assignment-${assignmentId}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/fan-scoring/assignments/${assignmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, actionId })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(json.error ?? "Assignment update failed");
        return;
      }
      actionIntents.complete(intentKey, actionId);
      setMessage("Saved");
      router.refresh();
    } catch {
      setMessage("Assignment update failed. Retry will reuse the same action ID.");
    } finally {
      setBusy(null);
    }
  }

  async function createInvite(courtId: string, role: "VERIFIED_WITNESS" | "DESIGNATED_SCORER") {
    const intentKey = clientIntentKey("community-invite", { courtId, role });
    const actionId = actionIntents.actionIdFor(intentKey);
    setBusy(`invite-${courtId}-${role}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/fan-scoring/courts/${courtId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role, actionId })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json.inviteUrl !== "string") {
        setMessage(json.error ?? "Invite creation failed");
        return;
      }
      actionIntents.complete(intentKey, actionId);
      await copyText(role === "DESIGNATED_SCORER" ? "Designated scorer invite" : "Verified witness invite", json.inviteUrl);
    } catch {
      setMessage("Invite creation failed. Retry will recover the same invitation.");
    } finally {
      setBusy(null);
    }
  }

  async function updateDispute(disputeId: string, action: "apply-proposal" | "resolve-after-edit" | "keep-current") {
    if (action === "keep-current" && !window.confirm("Keep the current canonical score and close this community review?")) return;
    const intentKey = clientIntentKey("community-dispute", { disputeId, action });
    const actionId = actionIntents.actionIdFor(intentKey);
    setBusy(`dispute-${disputeId}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/fan-scoring/disputes/${disputeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, actionId })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(json.error ?? "Score review update failed");
        if (json.correctionCommitted === true) router.refresh();
        return;
      }
      actionIntents.complete(intentKey, actionId);
      setMessage(action === "apply-proposal"
        ? "Community majority proposal applied and review resolved"
        : action === "resolve-after-edit"
          ? "Admin correction verified and review resolved"
          : "Current canonical score kept and review closed");
      router.refresh();
    } catch {
      setMessage("Score review update failed. Retry will reuse the same action ID.");
    } finally {
      setBusy(null);
    }
  }

  async function copyText(label: string, value: string) {
    setMessage(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        fallbackCopy(value);
      }
      setMessage(`${label} copied`);
    } catch {
      try {
        fallbackCopy(value);
        setMessage(`${label} copied`);
      } catch {
        setMessage(`${label}: ${value}`);
      }
    }
  }

  function saveMetadata(eventSubmit: FormEvent<HTMLFormElement>, courtId: string) {
    eventSubmit.preventDefault();
    const form = new FormData(eventSubmit.currentTarget);
    void updateCourt(courtId, {
      previewStreamPath: form.get("previewStreamPath"),
      programStreamPath: form.get("programStreamPath"),
      vblCourtNumber: form.get("vblCourtNumber"),
      vblCourtLabel: form.get("vblCourtLabel")
    });
  }

  return (
    <div className="admin-dashboard stack">
      <div className="admin-dashboard-header">
        <div>
          <h1>{event.name} Community Scoring</h1>
          <p className="muted">Court-by-court coverage, score authority, community witnesses, overlays, and private preview metadata.</p>
        </div>
        <button type="button" onClick={() => router.refresh()}>Refresh</button>
      </div>
      <section className="admin-summary-grid" aria-label="Fan scoring overview">
        <div>
          <span>Open Courts</span>
          <strong>{openCourts}/{courts.length}</strong>
        </div>
        <div>
          <span>Designated Scorers</span>
          <strong>{activeAssignments}</strong>
        </div>
        <div>
          <span>Verified Witnesses</span>
          <strong>{verifiedWitnesses}</strong>
        </div>
        <div>
          <span>Open Alerts</span>
          <strong>{openFlags}</strong>
        </div>
        <div>
          <span>Score Reviews</span>
          <strong>{disputeTotalOpenCount}</strong>
        </div>
      </section>
      {message && <div className="panel muted" role="status" aria-live="polite">{message}</div>}
      {disputesTruncated && (
        <div className="panel muted" role="status">Showing the newest {disputes.length} of {disputeTotalOpenCount} open score reviews.</div>
      )}
      <section className="admin-command-grid">
        {courts.map((court) => {
          const courtAssignments = assignmentsByCourt.get(court.id) ?? [];
          const assignmentCounts = countsByCourt.get(court.id);
          const active = courtAssignments.find((assignment) => assignment.role === "DESIGNATED_SCORER" && assignmentIsLive(assignment));
          const contributors = courtAssignments.filter((assignment) => assignment.role !== "DESIGNATED_SCORER" && assignmentIsLive(assignment));
          const courtFlags = flagsByCourt.get(court.id) ?? [];
          const courtDisputes = disputesByCourt.get(court.id) ?? [];
          const match = firstRelation(court.matches);
          const score = recordForCurrentMatch(court.score_states, match?.id);
          const scoreUrl = `${origin}/score/court/${court.court_number}`;
          const scorePath = `/score/court/${court.court_number}?eventSlug=${encodeURIComponent(event.slug)}`;
          const overlayUrl = `${origin}/overlay/stream/${court.court_number}`;
          const activeContributorCount = (assignmentCounts?.activeObserverCount ?? 0)
            + (assignmentCounts?.activeVerifiedWitnessCount ?? 0);
          const status = courtStatus(
            court,
            (assignmentCounts?.activeDesignatedCount ?? 0) > 0,
            assignmentCounts?.activeVerifiedWitnessCount ?? 0,
            activeContributorCount
          );
          const teamA = displayTeamName(match?.team_a, "TBD");
          const teamB = displayTeamName(match?.team_b, "TBD");
          return (
            <article className={`admin-court-card ${status.tone}`} key={court.id}>
              <header className="admin-court-header">
                <div>
                  <span className={`status ${status.badge}`}>{status.label}</span>
                  <h2>{court.display_name}</h2>
                </div>
                <div className="admin-court-key" aria-label={`Stream key ${court.court_number}`}>
                  <span>Key</span>
                  <strong>{court.court_number}</strong>
                </div>
              </header>
              <div className="admin-match-score" aria-label={`${teamA} versus ${teamB}`}>
                <div className="admin-team-row team-a">
                  <span className="team-chip" aria-hidden="true" />
                  <strong>{teamA}</strong>
                  <span>{score?.team_a_score ?? 0}</span>
                </div>
                <div className="admin-team-row team-b">
                  <span className="team-chip" aria-hidden="true" />
                  <strong>{teamB}</strong>
                  <span>{score?.team_b_score ?? 0}</span>
                </div>
                <div className="admin-match-meta">
                  <span>{score?.status ?? "Pre-Match"}</span>
                  <span>Set {score?.current_set ?? 1}</span>
                  <span>Sets {score?.team_a_sets ?? 0}-{score?.team_b_sets ?? 0}</span>
                </div>
              </div>
              <section className="session-stack" aria-label={`${court.display_name} community assignments`}>
                <div className="admin-section-title">
                  <span>Scorer Health</span>
                  {active?.last_seen_at && <small>{formatRelativeTime(active.last_seen_at)}</small>}
                </div>
                <div className="session-row">
                  <ShieldCheck size={16} />
                  <div>
                    <span>Designated scorer</span>
                    <strong>{active?.display_name ?? "None"}</strong>
                  </div>
                  {active && (
                    <div className="admin-link-actions">
                      <button type="button" onClick={() => void updateAssignment(active.id, "release")} disabled={busy != null}>Release</button>
                      <button type="button" onClick={() => void updateAssignment(active.id, "revoke")} disabled={busy != null}><UserMinus size={14} /> Revoke</button>
                    </div>
                  )}
                </div>
                {contributors.length > 0 ? (
                  <details className="admin-backup-list">
                    <summary>{activeContributorCount} active contributor{activeContributorCount === 1 ? "" : "s"}</summary>
                    {(assignmentCounts?.activeObserverCount ?? 0) > 0 && (
                      <p className="admin-empty-note">Observers shown {assignmentCounts?.returnedObserverCount ?? 0} of {assignmentCounts?.activeObserverCount ?? 0}</p>
                    )}
                    {contributors.map((contributor, index) => (
                      <div className="session-row compact" key={contributor.id}>
                        <UserPlus size={16} />
                        <div>
                          <span>{contributor.role === "VERIFIED_WITNESS" ? "Verified witness" : `Observer #${index + 1}`}</span>
                          <strong>{contributor.display_name}</strong>
                          {contributor.last_seen_at && <small>{formatRelativeTime(contributor.last_seen_at)}</small>}
                        </div>
                        <div className="admin-link-actions">
                          {contributor.role === "OBSERVER" && (
                            <button type="button" onClick={() => void updateAssignment(contributor.id, "verify")} disabled={busy != null}>Verify</button>
                          )}
                          {contributor.role === "VERIFIED_WITNESS" && (
                            <button type="button" onClick={() => void updateAssignment(contributor.id, "designate")} disabled={busy != null}>Designate</button>
                          )}
                          <button type="button" onClick={() => void updateAssignment(contributor.id, "revoke")} disabled={busy != null}>Revoke</button>
                        </div>
                      </div>
                    ))}
                  </details>
                ) : (
                  <p className="admin-empty-note">No active community contributors on this court.</p>
                )}
              </section>
              {courtFlags.length > 0 && (
                <details className="admin-alert-panel">
                  <summary>
                    <AlertTriangle size={16} />
                    <span>{courtFlags.length} alert{courtFlags.length === 1 ? "" : "s"}</span>
                  </summary>
                  <div className="flag-list">
                    {courtFlags.slice(0, 6).map((flag) => <span key={flag.id}><ShieldAlert size={14} /> {flag.message}</span>)}
                  </div>
                </details>
              )}
              {courtDisputes.length > 0 && (
                <section className="admin-alert-panel" aria-label={`${court.display_name} community score reviews`}>
                  <div className="admin-section-title">
                    <span><ShieldAlert size={16} /> Community score reviews</span>
                    <strong>{courtDisputes.length}</strong>
                  </div>
                  <div className="flag-list">
                    {courtDisputes.map((dispute) => {
                      const teamName = dispute.expectedTeamSide === "A" ? dispute.teamAName || teamA : dispute.teamBName || teamB;
                      const expectedAction = dispute.expectedActionType === "ADD_POINT" ? "Add point" : "Remove point";
                      const canAutoApply = canAutoApplyCommunityDispute(dispute);
                      const proposalHasNoMajority = dispute.resolutionKind === "NO_CONSENSUS_REVIEW";
                      const voteBreakdown = formatVoteBreakdown(dispute);
                      return (
                        <div className="session-row compact" key={dispute.id}>
                          <AlertTriangle size={16} aria-hidden="true" />
                          <div>
                            <strong>Rally {dispute.rallyNumber}: {canAutoApply
                              ? `${expectedAction} · ${teamName}`
                              : proposalHasNoMajority
                                ? "No strict majority"
                                : "Witness disagreement after the canonical action"}</strong>
                            <span>{voteBreakdown} · {dispute.eligibleVoteCount} eligible {dispute.eligibleVoteCount === 1 ? "vote" : "votes"} · opened {formatRelativeTime(dispute.openedAt)}</span>
                            <small>{canAutoApply
                              ? `Strict majority (${dispute.proposalVoteCount}/${dispute.eligibleVoteCount}) below the automatic consensus threshold. This proposal has not been applied.`
                              : proposalHasNoMajority
                                ? "No action has a strict majority. Use the score editor for an explicit correction, or keep the current score."
                                : "The broadcast action was already applied. Do not apply it again; keep the score or make an explicit admin correction."}</small>
                          </div>
                          <div className="admin-link-actions">
                            {canAutoApply ? (
                              <button type="button" onClick={() => void updateDispute(dispute.id, "apply-proposal")} disabled={busy != null}>Apply majority proposal &amp; resolve</button>
                            ) : (
                              <>
                                <a className="button" href={`/admin/events/${event.id}?tab=queues#court-${court.id}`}>Open score editor</a>
                                <button type="button" onClick={() => void updateDispute(dispute.id, "resolve-after-edit")} disabled={busy != null}>Resolve after correction</button>
                              </>
                            )}
                            <button type="button" onClick={() => void updateDispute(dispute.id, "keep-current")} disabled={busy != null}>Keep current score</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              <div className="admin-action-stack">
                <a className="button warn" href={scorePath}><ShieldCheck size={14} /> Open scoring page</a>
                <button type="button" onClick={() => void updateCourt(court.id, { scoringOpen: court.scoring_open === false })} disabled={busy != null}>
                  <Radio size={14} /> {court.scoring_open === false ? "Open scoring" : "Close scoring"}
                </button>
                <div className="admin-link-actions">
                  <button type="button" onClick={() => void copyText("Score URL", scoreUrl)}><Copy size={14} /> Score URL</button>
                  <button type="button" onClick={() => void copyText("Overlay URL", overlayUrl)}><Eye size={14} /> Overlay URL</button>
                </div>
                {match && (
                  <div className="admin-link-actions" aria-label={`${court.display_name} match-scoped invitations`}>
                    <button type="button" onClick={() => void createInvite(court.id, "VERIFIED_WITNESS")} disabled={busy != null}>
                      <Copy size={14} /> Verified invite
                    </button>
                    <button type="button" onClick={() => void createInvite(court.id, "DESIGNATED_SCORER")} disabled={busy != null}>
                      <Copy size={14} /> Designated invite
                    </button>
                  </div>
                )}
              </div>
              <details className="metadata-panel">
                <summary><Edit3 size={16} /> Edit stream / VBL metadata</summary>
                <form className="metadata-form" onSubmit={(eventSubmit) => saveMetadata(eventSubmit, court.id)}>
                  <label>Preview path<input name="previewStreamPath" defaultValue={court.preview_stream_path ?? ""} placeholder={`court${court.court_number}_preview`} required /></label>
                  <label>Program path<input name="programStreamPath" defaultValue={court.program_stream_path ?? ""} placeholder={`court${court.court_number}_program`} required /></label>
                  <label>VBL court number<input name="vblCourtNumber" defaultValue={court.vbl_court_number ?? ""} placeholder="7" /></label>
                  <label>VBL court label<input name="vblCourtLabel" defaultValue={court.vbl_court_label ?? ""} placeholder="Court 7" /></label>
                  <button className="primary" type="submit" disabled={busy != null}>Save metadata</button>
                </form>
              </details>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function courtStatus(court: Court, hasDesignated: boolean, verifiedCount: number, contributorCount: number) {
  if (court.scoring_open === false) return { label: "Scoring closed", badge: "", tone: "closed" };
  if (hasDesignated) return { label: "Designated live", badge: "success", tone: "covered" };
  if (verifiedCount >= 3) return { label: "Verified coverage", badge: "success", tone: "covered" };
  if (contributorCount > 0) return { label: "Community active", badge: "warn", tone: "needs-scorer" };
  return { label: "Needs contributors", badge: "error", tone: "needs-scorer" };
}

function assignmentIsLive(assignment: Assignment, now = Date.now()) {
  return assignment.status === "ACTIVE"
    && (!assignment.lease_expires_at || Date.parse(assignment.lease_expires_at) > now);
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const next = map.get(key) ?? [];
    next.push(item);
    map.set(key, next);
  }
  return map;
}

function displayTeamName(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

function formatVoteBreakdown(dispute: Dispute) {
  const labels = dispute.voteBreakdown
    .filter((vote) => vote.count > 0)
    .map((vote) => {
      const action = vote.actionType === "ADD_POINT" ? "Add" : "Remove";
      const rawTeam = vote.teamSide === "A" ? dispute.teamAName : dispute.teamBName;
      const team = rawTeam.trim() || `Team ${vote.teamSide}`;
      return `${action} ${team}: ${vote.count}`;
    });
  return labels.length > 0 ? labels.join(" · ") : "No recorded witness votes";
}

function scorecheckOrigin(configuredSiteUrl: string) {
  const configured = configuredSiteUrl.trim().replace(/\/$/, "");
  const fallback = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  const candidate = configured || fallback;
  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (["beachvolleyballmedia.com", "www.beachvolleyballmedia.com", "score.beachvolleyballmedia.com"].includes(parsed.hostname)) {
      return "https://score.beachvolleyballmedia.com";
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

function fallbackCopy(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.left = "-9999px";
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy command failed");
}

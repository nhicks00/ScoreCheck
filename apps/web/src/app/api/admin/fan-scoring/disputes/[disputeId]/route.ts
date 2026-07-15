import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { canAutoApplyCommunityDispute, classifyCommunityDispute } from "@/lib/communityDisputePolicy";
import {
  applyCommunityDisputeProposal,
  CommunityWitnessError,
  resolveCommunityDispute
} from "@/lib/communityWitness";
import { publishCanonicalScoreOutbox, type CourtRecord, type MatchRecord } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

const schema = z.object({
  action: z.enum(["apply-proposal", "resolve-after-edit", "keep-current"]),
  actionId: z.string().uuid()
}).strict();

type DisputeRow = {
  id: string;
  event_id: string;
  court_id: string;
  match_id: string;
  rally_number: number;
  base_revision: number;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "DISMISSED";
  expected_action_type: "ADD_POINT" | "REMOVE_POINT";
  expected_team_side: "A" | "B";
  canonical_event_id: string | null;
  proposal_eligible: boolean;
  opened_at: string;
};

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ disputeId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose a valid score review action." }, { status: 400 });
  const { disputeId } = await params;
  let correctionCommitted = false;

  try {
    const context = await loadDisputeContext(disputeId, parsed.data.action === "apply-proposal");
    if (!context.ok) return context.response;
    const { dispute, score } = context;
    const expectedRevision = nonNegativeInteger(score.revision);
    const expectedAuthorityEpoch = positiveInteger(score.authority_epoch);
    const disputeIsOpen = dispute.status === "OPEN" || dispute.status === "ACKNOWLEDGED";
    const linkedCommandType = disputeIsOpen ? await linkedDisputeCommandType(dispute) : null;
    const disputePolicy = disputeIsOpen
      ? classifyCommunityDispute(linkedCommandType, dispute.proposal_eligible)
      : null;

    if (parsed.data.action === "keep-current") {
      const result = await resolveCommunityDispute({
        disputeId: dispute.id,
        outcome: "DISMISSED",
        resolution: "Canonical score retained after admin review.",
        expectedRevision,
        expectedAuthorityEpoch,
        actorLabel: "Fan scoring admin"
      });
      if (!result.outboxId) {
        return NextResponse.json({ ok: true, dispute: result, projectionStatus: "NOT_REQUIRED" });
      }
      try {
        await publishCanonicalScoreOutbox({ outboxId: result.outboxId });
        return NextResponse.json({ ok: true, dispute: result, projectionStatus: "PUBLISHED" });
      } catch {
        return NextResponse.json({
          ok: true,
          dispute: result,
          reviewBoundaryCommitted: true,
          projectionStatus: "RETRYING"
        }, { status: 202 });
      }
    }

    if (parsed.data.action === "resolve-after-edit") {
      if (disputePolicy && canAutoApplyCommunityDispute(disputePolicy)) {
        return NextResponse.json({ error: "This unapplied proposal must be applied or dismissed." }, { status: 409 });
      }
      const correction = await latestAdminCorrectionEvent(dispute, expectedRevision, expectedAuthorityEpoch);
      if (!correction) {
        return NextResponse.json({
          error: "No later admin score correction is available. Open the score editor, correct the score, then resolve this review."
        }, { status: 409 });
      }
      const result = await resolveCommunityDispute({
        disputeId: dispute.id,
        outcome: "RESOLVED",
        resolution: "Resolved against a later explicit admin score correction.",
        canonicalEventId: correction.id,
        expectedRevision,
        expectedAuthorityEpoch,
        actorLabel: "Fan scoring admin"
      });
      return NextResponse.json({ ok: true, dispute: result, correctionCommitted: false });
    }

    if (disputePolicy?.alreadyApplied) {
      return NextResponse.json({
        error: "That broadcast action was already applied and cannot be applied a second time. Keep the current score or make an explicit admin correction."
      }, { status: 409 });
    }
    if (disputePolicy && !canAutoApplyCommunityDispute(disputePolicy)) {
      return NextResponse.json({
        error: "This proposal does not have a strict majority. Keep the current score or make an explicit admin correction."
      }, { status: 409 });
    }

    const result = await applyCommunityDisputeProposal({
      disputeId: dispute.id,
      expectedRevision,
      expectedAuthorityEpoch,
      actionId: parsed.data.actionId,
      actorLabel: "Fan scoring admin"
    });
    correctionCommitted = true;
    try {
      await publishCanonicalScoreOutbox({ outboxId: result.outboxId });
      return NextResponse.json({
        ok: true,
        dispute: result,
        correctionCommitted: true,
        projectionStatus: "PUBLISHED"
      });
    } catch {
      return NextResponse.json({
        ok: true,
        dispute: result,
        correctionCommitted: true,
        projectionStatus: "RETRYING"
      }, { status: 202 });
    }
  } catch (error) {
    if (error instanceof CommunityWitnessError) {
      const message = correctionCommitted
        ? "The canonical score was corrected, but another update prevented closing the review. Refresh before taking another action."
        : error.status === 409
          ? "The score changed first. Refresh before resolving this review."
          : error.status === 404
            ? "This score review is no longer open."
            : "This score review could not be updated.";
      return NextResponse.json({ error: message, correctionCommitted }, { status: error.status });
    }
    console.error("Could not resolve community score dispute", error);
    return NextResponse.json({
      error: correctionCommitted
        ? "The score was corrected, but the review could not be closed. Refresh before continuing."
        : "Could not update this score review.",
      correctionCommitted
    }, { status: 500 });
  }
}

async function loadDisputeContext(disputeId: string, allowResolvedRetry = false): Promise<
  | { ok: true; dispute: DisputeRow; court: CourtRecord; match: MatchRecord; score: Record<string, unknown> }
  | { ok: false; response: NextResponse }
> {
  const db = supabaseAdmin();
  const { data: dispute, error } = await db
    .from("score_disputes")
    .select("id,event_id,court_id,match_id,rally_number,base_revision,status,expected_action_type,expected_team_side,canonical_event_id,proposal_eligible,opened_at")
    .eq("id", disputeId)
    .maybeSingle<DisputeRow>();
  if (error) throw error;
  const allowedStatuses = allowResolvedRetry ? ["OPEN", "ACKNOWLEDGED", "RESOLVED"] : ["OPEN", "ACKNOWLEDGED"];
  if (!dispute || !allowedStatuses.includes(dispute.status)) {
    return { ok: false, response: NextResponse.json({ error: "This score review is no longer open." }, { status: 404 }) };
  }
  const [courtResult, matchResult, scoreResult] = await Promise.all([
    db.from("courts").select("*").eq("id", dispute.court_id).maybeSingle<CourtRecord>(),
    db.from("matches").select("*").eq("id", dispute.match_id).maybeSingle<MatchRecord>(),
    db.from("score_states").select("*").eq("match_id", dispute.match_id).maybeSingle<Record<string, unknown>>()
  ]);
  if (courtResult.error) throw courtResult.error;
  if (matchResult.error) throw matchResult.error;
  if (scoreResult.error) throw scoreResult.error;
  if (!courtResult.data || !matchResult.data || !scoreResult.data || courtResult.data.current_match_id !== dispute.match_id) {
    return { ok: false, response: NextResponse.json({ error: "This review is not for the court's current match." }, { status: 409 }) };
  }
  if (courtResult.data.event_id !== dispute.event_id || matchResult.data.event_id !== dispute.event_id) {
    return { ok: false, response: NextResponse.json({ error: "This review has an invalid event scope." }, { status: 409 }) };
  }
  return { ok: true, dispute, court: courtResult.data, match: matchResult.data, score: scoreResult.data };
}

async function linkedDisputeCommandType(dispute: DisputeRow): Promise<string | null> {
  if (!dispute.canonical_event_id) return null;
  const { data, error } = await supabaseAdmin()
    .from("canonical_score_events")
    .select("command_type")
    .eq("id", dispute.canonical_event_id)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.command_type === "string" ? data.command_type : null;
}

async function latestAdminCorrectionEvent(
  dispute: DisputeRow,
  expectedRevision: number,
  expectedAuthorityEpoch: number
): Promise<{ id: string } | null> {
  let query = supabaseAdmin()
    .from("canonical_score_events")
    .select("id")
    .eq("match_id", dispute.match_id)
    .eq("actor_type", "ADMIN")
    .eq("revision", expectedRevision)
    .eq("authority_epoch", expectedAuthorityEpoch)
    .in("command_type", ["ADD_POINT", "REMOVE_POINT", "CORRECT_SCORE"])
    .gte("created_at", dispute.opened_at)
    .order("created_at", { ascending: false })
    .limit(1);
  if (dispute.canonical_event_id) query = query.neq("id", dispute.canonical_event_id);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as { id: string } | null;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

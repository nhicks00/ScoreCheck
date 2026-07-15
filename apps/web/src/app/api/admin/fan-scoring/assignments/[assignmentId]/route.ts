import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  CommunityWitnessError,
  endCommunityAssignment,
  promoteCommunityAssignment,
  verifyCommunityAssignment
} from "@/lib/communityWitness";
import { supabaseAdmin } from "@/lib/supabase";

const schema = z.object({
  action: z.enum(["verify", "designate", "revoke", "release"]),
  actionId: z.string().uuid()
}).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ assignmentId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { assignmentId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid assignment action" }, { status: 400 });
  try {
    if (parsed.data.action === "verify") {
      const result = await verifyCommunityAssignment({
        assignmentId,
        actionId: parsed.data.actionId,
        actorLabel: "Fan scoring admin"
      });
      return NextResponse.json({ ok: true, assignment: result.assignment, score: result.score });
    }
    if (parsed.data.action === "designate") {
      const { data: assignment, error: assignmentError } = await supabaseAdmin()
        .from("community_assignments")
        .select("match_id,role,status")
        .eq("id", assignmentId)
        .maybeSingle();
      if (assignmentError) throw assignmentError;
      if (!assignment || assignment.status !== "ACTIVE") {
        return NextResponse.json({ error: "Active assignment not found." }, { status: 404 });
      }
      if (assignment.role !== "VERIFIED_WITNESS" && assignment.role !== "DESIGNATED_SCORER") {
        return NextResponse.json({ error: "Verify this witness before designating them." }, { status: 409 });
      }
      const { data: score, error: scoreError } = await supabaseAdmin()
        .from("score_states")
        .select("authority_epoch")
        .eq("match_id", assignment.match_id)
        .maybeSingle();
      if (scoreError) throw scoreError;
      if (!score) return NextResponse.json({ error: "Current score authority was not found." }, { status: 409 });
      const result = await promoteCommunityAssignment({
        assignmentId,
        expectedAuthorityEpoch: score.authority_epoch,
        actionId: parsed.data.actionId,
        actorLabel: "Fan scoring admin"
      });
      return NextResponse.json({ ok: true, assignment: result.assignment, score: result.score });
    }
    const result = await endCommunityAssignment({
      assignmentId,
      action: parsed.data.action === "release" ? "RELEASE" : "REVOKE",
      actionId: parsed.data.actionId,
      actorLabel: "Fan scoring admin"
    });
    return NextResponse.json({ ok: true, assignment: result.assignment, score: result.score });
  } catch (error) {
    if (error instanceof CommunityWitnessError) {
      return NextResponse.json({ error: adminError(error) }, { status: error.status });
    }
    console.error("Could not update community assignment", error);
    return NextResponse.json({ error: "Could not update this community assignment." }, { status: 500 });
  }
}

function adminError(error: CommunityWitnessError): string {
  if (error.status === 404) return "Community assignment not found.";
  if (error.status === 409) return "Score authority changed first. Refresh and try again.";
  if (error.status === 400) return "This assignment is not eligible for that action.";
  return "Could not update this community assignment.";
}

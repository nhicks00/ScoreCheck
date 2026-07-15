import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { CommunityWitnessError, createCommunityJoinGrant } from "@/lib/communityWitness";
import { supabaseAdmin } from "@/lib/supabase";

const randomActionIdSchema = z.string().uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
);

const schema = z.object({
  role: z.enum(["VERIFIED_WITNESS", "DESIGNATED_SCORER"]),
  actionId: randomActionIdSchema
}).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose a valid invitation role." }, { status: 400 });
  const { courtId } = await params;

  try {
    const db = supabaseAdmin();
    const { data: court, error } = await db
      .from("courts")
      .select("id,event_id,court_number,current_match_id,scoring_open,events:event_id(slug)")
      .eq("id", courtId)
      .maybeSingle();
    if (error) throw error;
    if (!court || !court.current_match_id) {
      return NextResponse.json({ error: "This court does not have a current match." }, { status: 409 });
    }
    if (court.scoring_open === false) {
      return NextResponse.json({ error: "Open community scoring before creating an invitation." }, { status: 409 });
    }

    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const created = await createCommunityJoinGrant({
      eventId: court.event_id,
      courtId: court.id,
      matchId: court.current_match_id,
      role: parsed.data.role,
      label: parsed.data.role === "DESIGNATED_SCORER" ? "Admin designated scorer invite" : "Admin verified witness invite",
      maxUses: 1,
      expiresAt,
      createdBy: "Fan scoring admin",
      actionId: parsed.data.actionId
    });
    const event = firstRelation(court.events);
    const invite = new URL(`/score/court/${court.court_number}`, req.nextUrl.origin);
    if (event?.slug) invite.searchParams.set("eventSlug", event.slug);
    invite.searchParams.set("joinCode", created.joinCode);
    if (parsed.data.role === "DESIGNATED_SCORER") invite.searchParams.set("role", "designated");
    return NextResponse.json({
      ok: true,
      inviteUrl: invite.toString(),
      role: created.grant.role,
      expiresAt: created.grant.expiresAt,
      maxUses: created.grant.maxUses
    });
  } catch (error) {
    if (error instanceof CommunityWitnessError) {
      const message = error.status === 400 || error.status === 409
        ? "The court or match changed before the invitation was created."
        : "Could not create this invitation.";
      return NextResponse.json({ error: message }, { status: error.status });
    }
    console.error("Could not create community invitation", error);
    return NextResponse.json({ error: "Could not create this invitation." }, { status: 500 });
  }
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

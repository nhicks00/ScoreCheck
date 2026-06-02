import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { applyManualAction, applyManualEdit, formatFromMatch, manualEditSchema, normalizeManualState } from "@/lib/manualScoring";
import { persistScoreAndOverlay } from "@/lib/scoreState";
import { requestIpHash, userAgent } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase";

type Relation<T> = T | T[] | null | undefined;

type CourtRow = {
  id: string;
  event_id: string;
  court_number: number;
  display_name: string;
  mode: "api" | "manual" | "hybrid";
  frozen: boolean;
  status: string;
  last_update_at: string | null;
  matches?: Relation<MatchRow>;
  score_states?: Relation<Record<string, unknown>>;
};

type MatchRow = {
  id: string;
  event_id: string;
  match_number: string | null;
  round_name: string | null;
  scheduled_time: string | null;
  team_a: string | null;
  team_b: string | null;
  team_a_seed: string | null;
  team_b_seed: string | null;
  team_a_players: string[] | null;
  team_b_players: string[] | null;
  format: Record<string, unknown> | null;
};

const adminActionSchema = z.object({
  action: z.enum(["point-a", "point-b", "toggle-serve", "timeout-a", "timeout-b", "side-switch", "set-complete", "match-complete", "undo"]),
  actionId: z.string().min(8).max(128).optional(),
  actorLabel: z.string().max(80).optional()
});

const adminEditSchema = manualEditSchema.extend({
  actionId: z.string().min(8).max(128).optional(),
  actorLabel: z.string().max(80).optional()
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = adminActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid admin score action" }, { status: 400 });

  const context = await loadContext(courtId);
  if (!context.ok) return context.response;
  if (parsed.data.action === "undo") {
    return undoAdminAction(req, context.court, context.match, context.currentScore, parsed.data.actionId, parsed.data.actorLabel);
  }
  return persistAdminScoreMutation(req, context.court, context.match, context.currentScore, parsed.data.action, parsed.data.actionId, parsed.data.actorLabel);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = adminEditSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid admin score edit" }, { status: 400 });
  const context = await loadContext(courtId);
  if (!context.ok) return context.response;

  const previous = normalizeManualState(context.currentScore);
  const next = applyManualEdit(previous, parsed.data, formatFromMatch(context.match));
  const saved = await saveOverrideScore(context.court, context.match, next);
  await logAdminAction(req, context.court, context.match, {
    action: "admin-score-edit",
    actionId: parsed.data.actionId,
    actorLabel: parsed.data.actorLabel,
    previousState: previous,
    nextState: next,
    payload: parsed.data
  });
  return NextResponse.json({ ok: true, score: saved.score, overlay: saved.overlay });
}

async function loadContext(courtId: string): Promise<
  | { ok: true; court: CourtRow; match: MatchRow | null; currentScore: Record<string, unknown> | null }
  | { ok: false; response: NextResponse }
> {
  const { data: court, error } = await supabaseAdmin()
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("id", courtId)
    .maybeSingle<CourtRow>();
  if (error) return { ok: false, response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!court) return { ok: false, response: NextResponse.json({ error: "Court not found" }, { status: 404 }) };
  return {
    ok: true,
    court,
    match: firstRelation(court.matches),
    currentScore: firstRelation(court.score_states)
  };
}

async function persistAdminScoreMutation(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow | null,
  currentScore: Record<string, unknown> | null,
  action: Exclude<z.infer<typeof adminActionSchema>["action"], "undo">,
  actionId?: string,
  actorLabel?: string
) {
  if (!match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  const idempotent = await findExistingAction(actionId);
  if (idempotent) return NextResponse.json({ ok: true, idempotent: true, score: idempotent.next_state });

  const previous = normalizeManualState(currentScore);
  const next = applyManualAction(previous, action, formatFromMatch(match));
  const saved = await saveOverrideScore(court, match, next);
  await logAdminAction(req, court, match, {
    action: `admin-${action}`,
    actionId,
    actorLabel,
    previousState: previous,
    nextState: next,
    payload: { action }
  });
  return NextResponse.json({ ok: true, score: saved.score, overlay: saved.overlay });
}

async function undoAdminAction(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow | null,
  currentScore: Record<string, unknown> | null,
  actionId?: string,
  actorLabel?: string
) {
  if (!match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  const idempotent = await findExistingAction(actionId);
  if (idempotent) return NextResponse.json({ ok: true, idempotent: true, score: idempotent.next_state });

  const { data: previousAction, error } = await supabaseAdmin()
    .from("score_actions")
    .select("previous_state")
    .eq("court_id", court.id)
    .neq("action", "admin-undo")
    .not("previous_state", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const restored = recordValue(previousAction?.previous_state);
  if (!restored) return NextResponse.json({ error: "Nothing to undo" }, { status: 409 });

  const previous = normalizeManualState(currentScore);
  const next = normalizeManualState(restored);
  const saved = await saveOverrideScore(court, match, next);
  await logAdminAction(req, court, match, {
    action: "admin-undo",
    actionId,
    actorLabel,
    previousState: previous,
    nextState: next,
    payload: { restoredFrom: previousAction }
  });
  return NextResponse.json({ ok: true, score: saved.score, overlay: saved.overlay });
}

async function saveOverrideScore(court: CourtRow, match: MatchRow | null, state: ReturnType<typeof normalizeManualState>) {
  const effectiveCourt = court.mode === "api" ? { ...court, mode: "hybrid" as const } : court;
  if (court.mode === "api") {
    await supabaseAdmin().from("courts").update({ mode: "hybrid", updated_at: new Date().toISOString() }).eq("id", court.id);
  }
  return persistScoreAndOverlay(effectiveCourt, match, {
    court_id: court.id,
    match_id: match?.id ?? null,
    team_a_score: state.team_a_score,
    team_b_score: state.team_b_score,
    team_a_sets: state.team_a_sets,
    team_b_sets: state.team_b_sets,
    current_set: state.current_set,
    set_scores: state.set_scores,
    serving_team: state.serving_team,
    timeouts: state.timeouts,
    status: state.status,
    source: "override",
    stale: false,
    message: "Admin override"
  });
}

async function findExistingAction(actionId: string | undefined) {
  if (!actionId) return null;
  const { data } = await supabaseAdmin()
    .from("score_actions")
    .select("next_state")
    .eq("action_id", actionId)
    .maybeSingle();
  return data;
}

async function logAdminAction(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow | null,
  input: {
    action: string;
    actionId?: string;
    actorLabel?: string;
    previousState: unknown;
    nextState: unknown;
    payload: Record<string, unknown>;
  }
) {
  const { error } = await supabaseAdmin().from("score_actions").insert({
    court_id: court.id,
    match_id: match?.id ?? null,
    action: input.action,
    action_id: input.actionId ?? crypto.randomUUID(),
    payload: input.payload,
    actor: "admin",
    actor_type: "admin",
    actor_label: input.actorLabel ?? "admin",
    previous_state: input.previousState,
    next_state: input.nextState,
    ip_hash: requestIpHash(req),
    user_agent: userAgent(req)
  });
  if (error) throw error;
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

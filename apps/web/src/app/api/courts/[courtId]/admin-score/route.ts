import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { CommunityWitnessError } from "@/lib/communityWitness";
import { applyManualAction, applyManualEdit, formatFromMatch, manualEditSchema, normalizeManualState } from "@/lib/manualScoring";
import { persistScoreAndOverlay, scoreForCurrentMatch } from "@/lib/scoreState";
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
  scoring_open: boolean;
  status: string;
  last_update_at: string | null;
  matches?: Relation<MatchRow>;
  score_states?: Relation<Record<string, unknown>>;
};

type MatchRow = {
  id: string;
  event_id: string;
  status: string;
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
  action: z.enum(["point-a", "point-b", "toggle-serve", "timeout-a", "timeout-b", "side-switch", "set-complete", "match-complete", "undo", "set-current-set"]),
  actionId: z.string().uuid(),
  actorLabel: z.string().max(80).optional(),
  setNumber: z.number().int().min(1).max(99).optional(),
  expectedRevision: z.number().int().min(0).optional()
}).strict().superRefine((input, context) => {
  const isSetCorrection = input.action === "set-current-set";
  if (isSetCorrection && (input.setNumber == null || input.expectedRevision == null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Set correction requires a set number and expected revision" });
  }
  if (!isSetCorrection && (input.setNumber != null || input.expectedRevision != null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Set correction fields are not valid for this action" });
  }
});

const adminEditSchema = manualEditSchema.extend({
  actionId: z.string().uuid(),
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
  if (parsed.data.action === "set-current-set") {
    return setAdminCurrentSet(
      req,
      context.court,
      context.match,
      context.currentScore,
      parsed.data.setNumber!,
      parsed.data.expectedRevision!,
      parsed.data.actionId,
      parsed.data.actorLabel
    );
  }
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
  if (!context.match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  const saved = await saveOverrideScore(req, context.court, context.match, next, {
    action: "score-edit",
    actionId: parsed.data.actionId,
    actorLabel: parsed.data.actorLabel,
    commandType: "CORRECT_SCORE",
    currentScore: context.currentScore
  });
  return NextResponse.json({ ok: true, duplicate: saved.duplicate, score: saved.score, overlay: saved.overlay });
}

async function setAdminCurrentSet(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow | null,
  currentScore: Record<string, unknown> | null,
  setNumber: number,
  expectedRevision: number,
  actionId: string,
  actorLabel?: string
) {
  if (!match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  if (!court.scoring_open || court.frozen) {
    return NextResponse.json({ error: "Scoring is closed or frozen on this court" }, { status: 409 });
  }
  if (isTerminalMatchStatus(match.status)) {
    return NextResponse.json({ error: "A completed or closed match cannot change its current set" }, { status: 409 });
  }
  const format = formatFromMatch(match);
  if (setNumber > format.bestOf) {
    return NextResponse.json({ error: `Set ${setNumber} is outside this best-of-${format.bestOf} match` }, { status: 400 });
  }
  const previous = normalizeManualState(currentScore);
  if (previous.status.trim().toLowerCase() === "final") {
    return NextResponse.json({ error: "A completed match cannot change its current set" }, { status: 409 });
  }
  if (previous.set_scores.some((set) => set.setNumber === setNumber && set.isComplete)) {
    return NextResponse.json({ error: `Set ${setNumber} is already complete` }, { status: 409 });
  }

  try {
    const saved = await saveOverrideScore(req, court, match, { ...previous, current_set: setNumber }, {
      action: "set-current-set",
      actionId,
      actorLabel,
      commandType: "SET_CURRENT_SET",
      expectedRevision,
      currentScore
    });
    return NextResponse.json({ ok: true, duplicate: saved.duplicate, score: saved.score, overlay: saved.overlay });
  } catch (error) {
    if (error instanceof CommunityWitnessError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 500;
      return NextResponse.json({
        error: status === 409
          ? "The score or court changed first. Refresh and try again."
          : status === 400 ? "This set selection is not valid." : "Could not update the current set."
      }, { status });
    }
    throw error;
  }
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
    currentScore: scoreForCurrentMatch(court.score_states, firstRelation(court.matches)?.id)
  };
}

async function persistAdminScoreMutation(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow | null,
  currentScore: Record<string, unknown> | null,
  action: Exclude<z.infer<typeof adminActionSchema>["action"], "undo" | "set-current-set">,
  actionId: string,
  actorLabel?: string
) {
  if (!match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  const previous = normalizeManualState(currentScore);
  const next = applyManualAction(previous, action, formatFromMatch(match));
  const semantic = adminCommandSemantics(action, next.serving_team);
  const saved = await saveOverrideScore(req, court, match, next, {
    action,
    actionId,
    actorLabel,
    currentScore,
    ...semantic
  });
  return NextResponse.json({ ok: true, duplicate: saved.duplicate, score: saved.score, overlay: saved.overlay });
}

async function undoAdminAction(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow | null,
  currentScore: Record<string, unknown> | null,
  actionId: string,
  actorLabel?: string
) {
  if (!match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  const { data: previousActions, error } = await supabaseAdmin()
    .from("canonical_score_events")
    .select("id,previous_state,metadata")
    .eq("court_id", court.id)
    .eq("match_id", match.id)
    .eq("actor_type", "ADMIN")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const undoneEventIds = new Set((previousActions ?? [])
    .filter((row) => recordValue(row.metadata)?.adminAction === "undo")
    .map((row) => recordValue(row.metadata)?.undoneCanonicalEventId)
    .filter((value): value is string => typeof value === "string"));
  const previousAction = (previousActions ?? []).find((row) => {
    const adminAction = recordValue(row.metadata)?.adminAction;
    return typeof adminAction === "string" && adminAction !== "undo" && !undoneEventIds.has(row.id);
  });
  const restored = manualStateFromCanonical(previousAction?.previous_state);
  if (!restored) return NextResponse.json({ error: "Nothing to undo" }, { status: 409 });

  const saved = await saveOverrideScore(req, court, match, restored, {
    action: "undo",
    actionId,
    actorLabel,
    commandType: "CORRECT_SCORE",
    currentScore,
    metadata: { undoneCanonicalEventId: previousAction?.id }
  });
  return NextResponse.json({ ok: true, duplicate: saved.duplicate, score: saved.score, overlay: saved.overlay });
}

async function saveOverrideScore(
  req: NextRequest,
  court: CourtRow,
  match: MatchRow,
  state: ReturnType<typeof normalizeManualState>,
  input: {
    action: string;
    actionId: string;
    actorLabel?: string;
    commandType: "ADD_POINT" | "REMOVE_POINT" | "CORRECT_SCORE" | "COMPLETE_SET" | "COMPLETE_MATCH" | "SET_SERVE" | "SET_CURRENT_SET";
    teamSide?: "A" | "B" | null;
    expectedRevision?: number;
    currentScore: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  }
) {
  const effectiveCourt = court.mode === "api" ? { ...court, mode: "hybrid" as const } : court;
  return persistScoreAndOverlay(effectiveCourt, match, {
    court_id: court.id,
    match_id: match.id,
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
    source_available: false,
    source_priority: "override",
    source_pending_scores: [],
    stale: false,
    message: "Admin override"
  }, {
    actionId: input.actionId,
    actorType: "ADMIN",
    actorLabel: input.actorLabel ?? "admin",
    authorityMode: "ADMIN_LOCKED",
    commandType: input.commandType,
    teamSide: input.teamSide,
    expectedRevision: input.expectedRevision ?? numberValue(input.currentScore?.revision) ?? undefined,
    expectedAuthorityEpoch: numberValue(input.currentScore?.authority_epoch) ?? undefined,
    metadata: {
      adminAction: input.action,
      ipHash: requestIpHash(req),
      userAgent: userAgent(req),
      ...input.metadata
    }
  });
}

function adminCommandSemantics(action: string, servingTeam: "A" | "B" | null) {
  if (action === "point-a") return { commandType: "ADD_POINT" as const, teamSide: "A" as const };
  if (action === "point-b") return { commandType: "ADD_POINT" as const, teamSide: "B" as const };
  if (action === "set-complete") return { commandType: "COMPLETE_SET" as const, teamSide: null };
  if (action === "match-complete") return { commandType: "COMPLETE_MATCH" as const, teamSide: null };
  if (action === "toggle-serve" && servingTeam) return { commandType: "SET_SERVE" as const, teamSide: servingTeam };
  return { commandType: "CORRECT_SCORE" as const, teamSide: null };
}

function manualStateFromCanonical(value: unknown): ReturnType<typeof normalizeManualState> | null {
  const state = recordValue(value);
  if (!state) return null;
  return normalizeManualState({
    team_a_score: state.teamAScore,
    team_b_score: state.teamBScore,
    team_a_sets: state.teamASets,
    team_b_sets: state.teamBSets,
    current_set: state.currentSet,
    set_scores: state.setScores,
    serving_team: state.servingTeam,
    timeouts: state.timeouts,
    status: state.status
  });
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isTerminalMatchStatus(value: string | null | undefined): boolean {
  return ["final", "finished", "completed", "complete", "closed", "ended", "cancelled", "canceled"]
    .includes((value ?? "").trim().toLowerCase());
}

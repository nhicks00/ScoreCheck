import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyManualAction, applyManualEdit, formatFromMatch, manualEditSchema, normalizeManualState } from "./manualScoring";
import { checkRateLimit } from "./rateLimit";
import { CourtRecord, MatchRecord, persistScoreAndOverlay } from "./scoreState";
import { requestIpHash, userAgent, validateToken } from "./security";
import { supabaseAdmin } from "./supabase";

type Relation<T> = T | T[] | null | undefined;

type ScorerCourtRow = CourtRecord & {
  current_match_id: string | null;
  scorer_token_hash: string | null;
  scorer_token_revoked_at: string | null;
  matches?: Relation<MatchRecord>;
  score_states?: Relation<Record<string, unknown>>;
};

type ScorerContext = {
  court: ScorerCourtRow;
  match: MatchRecord | null;
  currentScore: Record<string, unknown> | null;
  ipHash: string;
  userAgent: string;
  actorLabel: string;
};

type ScorerResult =
  | { ok: true; context: ScorerContext; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

const mutationSchema = z.object({
  token: z.string().min(12),
  actionId: z.string().min(8).max(128).optional(),
  actorLabel: z.string().max(80).optional()
});

export async function validateScorerRequest(req: NextRequest, courtId: string, bodyOverride?: Record<string, unknown>): Promise<ScorerResult> {
  const body = bodyOverride ?? await readBody(req);
  const token = stringValue(body.token) ?? req.nextUrl.searchParams.get("token");
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`score-auth:${courtId}:${ipHash}`, 240, 60_000)) {
    return { ok: false, response: NextResponse.json({ error: "Too many scorer requests" }, { status: 429 }) };
  }

  const db = supabaseAdmin();
  const { data: court, error } = await db
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("id", courtId)
    .maybeSingle<ScorerCourtRow>();

  if (error) return { ok: false, response: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!court) return { ok: false, response: NextResponse.json({ error: "Court not found" }, { status: 404 }) };
  if (court.mode !== "manual" && court.mode !== "hybrid") {
    return { ok: false, response: NextResponse.json({ error: "Court is not enabled for manual scoring" }, { status: 403 }) };
  }
  if (court.scorer_token_revoked_at || !validateToken(token, court.scorer_token_hash)) {
    return { ok: false, response: NextResponse.json({ error: "Invalid scorer token" }, { status: 401 }) };
  }

  return {
    ok: true,
    body,
    context: {
      court,
      match: firstRelation(court.matches),
      currentScore: firstRelation(court.score_states),
      ipHash,
      userAgent: userAgent(req),
      actorLabel: stringValue(body.actorLabel) ?? "remote scorer"
    }
  };
}

export async function handleScorerAction(
  req: NextRequest,
  courtId: string,
  action: "point-a" | "point-b" | "set-complete" | "match-complete" | "toggle-serve" | "timeout-a" | "timeout-b" | "side-switch"
) {
  const body = await readBody(req);
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Valid token is required" }, { status: 400 });
  const auth = await validateScorerRequest(req, courtId, body);
  if (!auth.ok) return auth.response;
  if (!checkRateLimit(`score-mutate:${courtId}:${auth.context.ipHash}`, 90, 60_000)) {
    return NextResponse.json({ error: "Too many scoring actions" }, { status: 429 });
  }
  return persistScorerMutation(auth.context, action, parsed.data.actionId, { action });
}

export async function handleManualEdit(req: NextRequest, courtId: string) {
  const body = await readBody(req);
  const auth = await validateScorerRequest(req, courtId, body);
  if (!auth.ok) return auth.response;
  if (!checkRateLimit(`score-edit:${courtId}:${auth.context.ipHash}`, 20, 60_000)) {
    return NextResponse.json({ error: "Too many manual edits" }, { status: 429 });
  }

  const edit = manualEditSchema.safeParse(body);
  if (!edit.success) return NextResponse.json({ error: "Invalid score edit payload" }, { status: 400 });
  const actionId = stringValue(body.actionId);
  return persistScorerMutation(auth.context, "manual-edit", actionId, edit.data);
}

export async function handleUndo(req: NextRequest, courtId: string) {
  const body = await readBody(req);
  const auth = await validateScorerRequest(req, courtId, body);
  if (!auth.ok) return auth.response;
  if (!checkRateLimit(`score-undo:${courtId}:${auth.context.ipHash}`, 25, 60_000)) {
    return NextResponse.json({ error: "Too many undo requests" }, { status: 429 });
  }

  const actionId = stringValue(body.actionId);
  const idempotent = await findExistingAction(actionId);
  if (idempotent) return NextResponse.json({ ok: true, idempotent: true, score: idempotent.next_state });

  const db = supabaseAdmin();
  const { data: previousAction, error } = await db
    .from("score_actions")
    .select("previous_state")
    .eq("court_id", courtId)
    .neq("action", "undo")
    .not("previous_state", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const restored = recordValue(previousAction?.previous_state);
  if (!restored) return NextResponse.json({ error: "Nothing to undo" }, { status: 409 });

  const previous = normalizeManualState(auth.context.currentScore);
  const next = normalizeManualState(restored);
  const saved = await saveManualState(auth.context, next);
  await logScoreAction(auth.context, {
    action: "undo",
    actionId,
    previousState: previous,
    nextState: next,
    payload: { restoredFrom: previousAction }
  });
  return NextResponse.json({ ok: true, score: saved.score, overlay: saved.overlay });
}

export function publicScorerState(context: ScorerContext) {
  return {
    court: {
      id: context.court.id,
      eventId: context.court.event_id,
      courtNumber: context.court.court_number,
      displayName: context.court.display_name,
      mode: context.court.mode,
      status: context.court.status,
      frozen: context.court.frozen
    },
    match: context.match,
    score: normalizeManualState(context.currentScore)
  };
}

async function persistScorerMutation(
  context: ScorerContext,
  action: "point-a" | "point-b" | "set-complete" | "match-complete" | "toggle-serve" | "timeout-a" | "timeout-b" | "side-switch" | "manual-edit",
  actionId: string | undefined,
  payload: Record<string, unknown>
) {
  if (!context.match) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });
  const idempotent = await findExistingAction(actionId);
  if (idempotent) return NextResponse.json({ ok: true, idempotent: true, score: idempotent.next_state });

  const previous = normalizeManualState(context.currentScore);
  const format = formatFromMatch(context.match);
  const next = action === "manual-edit"
    ? applyManualEdit(previous, manualEditSchema.parse(payload), format)
    : applyManualAction(previous, action, format);
  const saved = await saveManualState(context, next);

  await logScoreAction(context, {
    action,
    actionId,
    previousState: previous,
    nextState: next,
    payload
  });
  return NextResponse.json({ ok: true, score: saved.score, overlay: saved.overlay });
}

async function saveManualState(context: ScorerContext, state: ReturnType<typeof normalizeManualState>) {
  return persistScoreAndOverlay(context.court, context.match, {
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    team_a_score: state.team_a_score,
    team_b_score: state.team_b_score,
    team_a_sets: state.team_a_sets,
    team_b_sets: state.team_b_sets,
    current_set: state.current_set,
    set_scores: state.set_scores,
    serving_team: state.serving_team,
    timeouts: state.timeouts,
    status: state.status,
    source: "manual",
    stale: false,
    message: null
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

async function logScoreAction(
  context: ScorerContext,
  input: {
    action: string;
    actionId: string | undefined;
    previousState: unknown;
    nextState: unknown;
    payload: Record<string, unknown>;
  }
) {
  const { error } = await supabaseAdmin().from("score_actions").insert({
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    action: input.action,
    action_id: input.actionId ?? crypto.randomUUID(),
    payload: input.payload,
    actor: "scorer",
    actor_type: "scorer",
    actor_label: context.actorLabel,
    previous_state: input.previousState,
    next_state: input.nextState,
    ip_hash: context.ipHash,
    user_agent: context.userAgent
  });
  if (error) throw error;
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    return recordValue(body) ?? {};
  }
  const form = await req.formData().catch(() => null);
  if (!form) return {};
  return Object.fromEntries(form.entries());
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

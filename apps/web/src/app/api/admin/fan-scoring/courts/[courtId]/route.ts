import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

const schema = z.object({
  scoringOpen: z.boolean().optional(),
  backupRequested: z.boolean().optional(),
  previewStreamPath: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._/-]+$/).optional(),
  programStreamPath: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._/-]+$/).optional(),
  vblCourtNumber: z.string().max(40).nullable().optional(),
  vblCourtLabel: z.string().max(120).nullable().optional()
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid court update" }, { status: 400 });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.scoringOpen != null) patch.scoring_open = parsed.data.scoringOpen;
  if (parsed.data.backupRequested != null) patch.backup_requested = parsed.data.backupRequested;
  if (parsed.data.previewStreamPath !== undefined) patch.preview_stream_path = parsed.data.previewStreamPath;
  if (parsed.data.programStreamPath !== undefined) patch.program_stream_path = parsed.data.programStreamPath;
  if (parsed.data.vblCourtNumber !== undefined) patch.vbl_court_number = emptyToNull(parsed.data.vblCourtNumber);
  if (parsed.data.vblCourtLabel !== undefined) patch.vbl_court_label = emptyToNull(parsed.data.vblCourtLabel);
  const { data, error } = await supabaseAdmin().from("courts").update(patch).eq("id", courtId).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, court: data });
}

function emptyToNull(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

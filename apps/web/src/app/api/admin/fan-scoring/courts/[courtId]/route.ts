import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

const schema = z.object({
  scoringOpen: z.boolean().optional(),
  backupRequested: z.boolean().optional(),
  youtubeVideoId: z.string().max(120).nullable().optional(),
  youtubeLiveChatId: z.string().max(180).nullable().optional(),
  ivsChannelArn: z.string().max(300).nullable().optional(),
  ivsPlaybackUrl: z.string().max(500).nullable().optional()
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
  if (parsed.data.youtubeVideoId !== undefined) patch.youtube_video_id = emptyToNull(parsed.data.youtubeVideoId);
  if (parsed.data.youtubeLiveChatId !== undefined) patch.youtube_live_chat_id = emptyToNull(parsed.data.youtubeLiveChatId);
  if (parsed.data.ivsChannelArn !== undefined) patch.ivs_channel_arn = emptyToNull(parsed.data.ivsChannelArn);
  if (parsed.data.ivsPlaybackUrl !== undefined) patch.ivs_playback_url = emptyToNull(parsed.data.ivsPlaybackUrl);
  const { data, error } = await supabaseAdmin().from("courts").update(patch).eq("id", courtId).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, court: data });
}

function emptyToNull(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

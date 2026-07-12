import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkProgramToken } from "@/lib/program";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 5s health upsert from /program/court/{n} (see ProgramClient). One row per
 * court in program_heartbeats, so the production console can alarm on stale
 * last_seen_at + semantic video state instead of "Chrome is running".
 * Gated by the same PROGRAM_PAGE_TOKEN as the page, carried in the body.
 */

const schema = z.object({
  token: z.string().min(1),
  // Diagnostics table: accept a generous court range rather than coupling to
  // NEXT_PUBLIC_COURT_COUNT — pages beyond the count 404 anyway.
  courtNumber: z.coerce.number().int().min(1).max(99),
  videoState: z.string().max(64).optional(),
  framesRendered: z.coerce.number().int().min(0).optional(),
  commentaryRoomConnected: z.boolean().optional(),
  commentaryParticipantCount: z.coerce.number().int().min(0).optional(),
  commentaryAudioTrackCount: z.coerce.number().int().min(0).optional(),
  commentaryRmsDb: z.number().min(-120).max(12).nullable().optional(),
  commentaryPeakDb: z.number().min(-120).max(12).nullable().optional(),
  secondsSinceCommentaryAudio: z.number().min(0).nullable().optional(),
  cameraAudioRmsDb: z.number().min(-120).max(12).nullable().optional(),
  pageVersion: z.string().max(64).optional()
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;

  // Same stealth behavior as the program page: bad/missing token (or an unset
  // PROGRAM_PAGE_TOKEN) is a plain 404.
  const token = typeof body?.token === "string" ? body.token : null;
  if (!checkProgramToken(token)) return new NextResponse(null, { status: 404 });

  const ipHash = requestIpHash(req);
  // 8 courts at one beat per 5s is ~96/min from a single egress host; leave
  // ample headroom so heartbeats never rate-limit themselves.
  if (!checkRateLimit(`program-heartbeat:${ipHash}`, 600, 60_000)) {
    return NextResponse.json({ error: "Too many heartbeats" }, { status: 429 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid heartbeat payload" }, { status: 400 });
  if (!isSupabaseConfigured()) return new NextResponse(null, { status: 204 });

  const db = supabaseAdmin();
  const { error } = await db
    .from("program_heartbeats")
    .upsert(
      {
        court_number: parsed.data.courtNumber,
        last_seen_at: new Date().toISOString(),
        video_state: parsed.data.videoState ?? null,
        frames_rendered: parsed.data.framesRendered ?? null,
        commentary_room_connected: parsed.data.commentaryRoomConnected ?? null,
        commentary_participant_count: parsed.data.commentaryParticipantCount ?? null,
        commentary_audio_track_count: parsed.data.commentaryAudioTrackCount ?? null,
        commentary_rms_db: parsed.data.commentaryRmsDb ?? null,
        commentary_peak_db: parsed.data.commentaryPeakDb ?? null,
        seconds_since_commentary_audio: parsed.data.secondsSinceCommentaryAudio ?? null,
        camera_audio_rms_db: parsed.data.cameraAudioRmsDb ?? null,
        page_version: parsed.data.pageVersion ?? null
      },
      { onConflict: "court_number" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return new NextResponse(null, { status: 204 });
}
